/**
 * The TwinViewer (lib/three/api.ts) the page drives: builds the static scene
 * for a WorldPayload, binds a Playback, samples it at the requested minute on
 * each frame() and renders. The page owns the requestAnimationFrame loop and
 * the DOM labels; this module owns the WebGLRenderer, the controls and every
 * three.js resource, and dispose() frees all of it (idempotent, so React
 * Strict Mode's double mount is harmless).
 *
 * Light: with dayNight on, the sun and sky follow t mod 1440 and the ceiling
 * strips follow the shift (scheduleFromPlayback reads the clock-outs from
 * the playback); with it off everything is fixed at noon with the strips on.
 * The theme reaches only the environment (sky, ground, lot, fence) and the
 * stage colour; the building keeps its own colours.
 *
 * Quality: "auto" drops to low (no shadows, 8-triangle pallets) when a
 * building has more than AUTO_QUALITY_INSTANCES faces plus reserve
 * positions. Pixel ratio is capped at 2, and at 1.5 under 1000 px wide.
 */

import { Color, Mesh, MeshBasicMaterial, PCFSoftShadowMap, Scene, WebGLRenderer } from "three";
import type { Playback, WorldPayload } from "../trace/types";
import { PROCESS_SKILL } from "../twin/types";
import { ActorPool, LoosePallets, MaterialCache } from "./actors";
import { DEFAULT_VIEWER_OPTIONS, type CameraMode, type CameraPreset, type LabelPos, type PickResult, type TwinViewer, type ViewerOptions, type ViewerStats } from "./api";
import { applyFrame, bindScene, PlaybackSampler, recolorFaces, releaseScene, type TwinScene } from "./apply";
import { buildBuilding, DOOR_HEIGHT, WALL_HEIGHT, type Building } from "./building";
import { CameraRig, type FollowPose } from "./cameras";
import { rackColliders, trailerCollider, wallColliders, type Aabb } from "./collide";
import { buildEnvironment, type Environment } from "./environment";
import { ResourceTracker, ringGeometry } from "./geometry";
import { LabelProjector, MAX_LABELS, type LabelOccluder } from "./labels";
import { createLighting, scheduleFromPlayback, stripsOn, type Lighting, type LightSchedule } from "./lighting";
import { STATE_COLORS, THEMES } from "./palette";
import { Picker } from "./picking";
import { buildRacks, type Racks } from "./racks";
import { WalkController } from "./walk";

export const AUTO_QUALITY_INSTANCES = 20_000;

interface WorldObjects {
  tracker: ResourceTracker;
  materials: MaterialCache;
  building: Building;
  racks: Racks;
  pool: ActorPool;
  loose: LoosePallets;
  env: Environment;
  selectionRing: Mesh;
  staticColliders: Aabb[];
  quality: "high" | "low";
}

export class TwinViewerImpl implements TwinViewer {
  /** Walk mode's E key: the page registers a handler to open the inspector. */
  onInspect: ((r: PickResult | null) => void) | null = null;

  private options: ViewerOptions;
  private readonly scene = new Scene();
  private readonly rig = new CameraRig();
  private readonly walk: WalkController;
  private readonly lighting: Lighting;
  private readonly picker = new Picker();
  private readonly projector = new LabelProjector();
  private occluder: LabelOccluder | null = null;
  private renderer: WebGLRenderer | null = null;
  private world: WorldPayload | null = null;
  private objects: WorldObjects | null = null;
  private playback: Playback | null = null;
  private twin: TwinScene | null = null;
  private sampler: PlaybackSampler | null = null;
  private schedule: LightSchedule | null = null;
  private selection: PickResult | null = null;
  private mode: CameraMode = "orbit";
  private labelPos: LabelPos[] = [];
  private size = { width: 0, height: 0, dpr: 1 };
  private frameMs = 0;
  private colliders: Aabb[] = [];
  /** The last (minute, strips) the scene was lit for, so a paused frame recolours nothing. */
  private lightKey = "";
  private disposed = false;

  constructor(options: Partial<ViewerOptions> = {}) {
    this.options = { ...DEFAULT_VIEWER_OPTIONS, ...options };
    this.scene.background = new Color(THEMES[this.options.theme].background);
    this.lighting = createLighting(this.options.theme);
    this.scene.add(this.lighting.group);
    this.walk = new WalkController(this.rig.camera, {
      onInspect: () => this.onInspect?.(this.pick(0, 0)),
      colliders: () => this.colliders,
    });
  }

  private effectiveQuality(instances: number): "high" | "low" {
    if (this.options.quality !== "auto") return this.options.quality;
    return instances > AUTO_QUALITY_INSTANCES ? "low" : "high";
  }

  private effectiveShadows(): boolean {
    return this.options.shadows && (this.objects?.quality ?? "high") === "high";
  }

  mount(canvas: HTMLCanvasElement): void {
    if (this.disposed || this.renderer) return;
    const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.shadowMap.enabled = this.effectiveShadows();
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer = renderer;
    this.rig.attach(canvas);
    this.walk.attach(canvas);
    const w = this.size.width || canvas.clientWidth || canvas.width || 1;
    const h = this.size.height || canvas.clientHeight || canvas.height || 1;
    const dpr = this.size.width ? this.size.dpr : typeof window !== "undefined" ? window.devicePixelRatio : 1;
    this.resize(w, h, dpr);
  }

  private disposeWorld(): void {
    if (this.twin) releaseScene(this.twin);
    this.twin = null;
    this.sampler = null;
    const o = this.objects;
    if (!o) return;
    this.objects = null;
    o.building.dispose();
    o.racks.dispose();
    o.pool.dispose();
    o.loose.dispose();
    o.env.dispose();
    this.scene.fog = null;
    o.selectionRing.removeFromParent();
    o.tracker.disposeAll();
    this.lightKey = "";
  }

  setWorld(world: WorldPayload): void {
    if (this.disposed) return;
    this.disposeWorld();
    this.world = world;
    const { layout, spec } = world;
    const w = world.world;
    // What hides a worker's pill from a camera outside: the walls, less the door openings.
    this.occluder = { w: w.bbox.w, d: w.bbox.d, wallHeight: WALL_HEIGHT, doorHeight: DOOR_HEIGHT, doors: w.frames.map((f) => ({ x: f.origin[0], y: f.origin[1], tx: f.tangent[0], ty: f.tangent[1], halfWidth: f.widthFt / 2 })) };
    const quality = this.effectiveQuality(layout.pick.length + layout.reserve.length);
    const tracker = new ResourceTracker();
    const materials = new MaterialCache(tracker);
    const building = buildBuilding(spec, layout, w, { tracker });
    const racks = buildRacks(layout, w, { tracker, quality });
    const pool = new ActorPool(tracker, materials, quality);
    const loose = new LoosePallets(tracker, quality);
    const env = buildEnvironment(spec, w, { theme: this.options.theme, tracker });
    const selectionRing = new Mesh(tracker.geometry(ringGeometry(2.4, 3.2)), tracker.material(new MeshBasicMaterial({ color: STATE_COLORS.selection, depthTest: false })));
    selectionRing.renderOrder = 10;
    selectionRing.visible = false;
    this.scene.add(env.group, building.group, racks.group, pool.root, loose.mesh, selectionRing);
    this.scene.fog = env.fog;
    this.objects = { tracker, materials, building, racks, pool, loose, env, selectionRing, staticColliders: [...rackColliders(spec), ...wallColliders(spec, w.frames)], quality };
    this.colliders = this.objects.staticColliders;
    this.lighting.fit(spec.widthFt, spec.depthFt);
    this.lighting.setShadows(this.effectiveShadows());
    if (this.renderer) this.renderer.shadowMap.enabled = this.effectiveShadows();
    this.rig.setWorld(layout, w);
    if (this.playback) this.bind(this.playback);
  }

  private bind(pb: Playback): void {
    const o = this.objects;
    const world = this.world;
    if (!o || !world) return;
    this.twin = bindScene({ racks: o.racks, building: o.building, actors: o.pool, loose: o.loose }, world, pb, { heat: this.options.heat, debugSpeed: this.options.debugSpeed });
    this.sampler = new PlaybackSampler(pb);
    this.schedule = scheduleFromPlayback(pb);
  }

  setPlayback(pb: Playback | null): void {
    if (this.disposed) return;
    if (this.twin) releaseScene(this.twin);
    this.twin = null;
    this.sampler = null;
    this.schedule = null;
    this.playback = pb;
    if (pb) this.bind(pb);
  }

  private followPose(): FollowPose | null {
    const o = this.objects;
    const pb = this.playback;
    if (!o || !pb || this.rig.followTarget < 0) return null;
    const actor = o.pool.active.get(this.rig.followTarget);
    if (!actor) return null;
    return { x: actor.group.position.x, y: -actor.group.position.z, h: actor.group.rotation.y, truck: actor.kind === "truck" };
  }

  private updateSelection(): void {
    const o = this.objects;
    const world = this.world;
    if (!o || !world) return;
    const ring = o.selectionRing;
    const sel = this.selection;
    if (!sel) {
      ring.visible = false;
      return;
    }
    let ok = true;
    let scale = 1;
    const w = world.world;
    switch (sel.kind) {
      case "entity": {
        const actor = o.pool.active.get(sel.entity);
        if (actor) {
          ring.position.copy(actor.group.position);
          if (actor.kind === "truck") {
            ring.position.x += Math.cos(actor.group.rotation.y) * 26;
            ring.position.z -= Math.sin(actor.group.rotation.y) * 26;
            scale = 6;
          }
        } else {
          const slot = o.loose.entityAt.indexOf(sel.entity);
          if (slot >= 0) {
            o.loose.mesh.getMatrixAt(slot, ring.matrix);
            ring.position.setFromMatrixPosition(ring.matrix);
          } else ok = false;
        }
        break;
      }
      case "face":
        o.racks.faceWorld(sel.index, ring.position);
        break;
      case "reserve":
        o.racks.reserveWorld(sel.index, ring.position);
        scale = 1.5;
        break;
      case "door": {
        const f = w.frames[sel.index];
        if (f) ring.position.set(f.origin[0] + f.inward[0] * 4, 0.1, -(f.origin[1] + f.inward[1] * 4));
        else ok = false;
        scale = 2.5;
        break;
      }
      case "station": {
        const s = w.stations[sel.index];
        if (s) ring.position.set(s[0], 0.1, -s[1]);
        else ok = false;
        scale = 2;
        break;
      }
      case "lane": {
        const s = w.lanes[sel.door]?.slots[sel.slot];
        if (s) ring.position.set(s[0], 0.1, -s[1]);
        else ok = false;
        break;
      }
      case "queue": {
        const h = w.homes[PROCESS_SKILL[sel.process]];
        if (h) ring.position.set(h[0], 0.1, -h[1]);
        else ok = false;
        scale = 2;
        break;
      }
    }
    ring.visible = ok;
    ring.scale.set(scale, 1, scale);
  }

  /** Sun, sky, strips and exterior tint for simulated minute t (skipped when nothing changed). */
  private light(t: number): void {
    const o = this.objects;
    const minute = this.options.dayNight ? ((t % 1440) + 1440) % 1440 : null;
    const strips = this.options.dayNight ? stripsOn(t, this.schedule) : true;
    const key = `${minute === null ? "noon" : Math.round(minute)}:${strips ? 1 : 0}`;
    if (key === this.lightKey) return;
    this.lightKey = key;
    const state = this.lighting.setTime(minute, strips);
    o?.building.setLight(strips, state.daylight);
    o?.env.setTime(minute);
  }

  frame(t: number, dtRealSec: number): void {
    if (this.disposed) return;
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const o = this.objects;
    if (this.twin && this.sampler && this.playback) {
      const sample = this.sampler.sample(t);
      applyFrame(this.twin, sample, this.playback, dtRealSec);
      if (o && this.mode === "walk") {
        const docked: Aabb[] = [];
        this.twin.doorValue.forEach((v, i) => {
          const f = this.world?.world.frames[i];
          if (v >= 0 && f) docked.push(trailerCollider(f));
        });
        this.colliders = docked.length ? [...o.staticColliders, ...docked] : o.staticColliders;
      }
    }
    this.light(t);
    if (this.mode === "walk") this.walk.update(dtRealSec);
    else this.rig.update(dtRealSec, this.mode === "follow" ? this.followPose() : null);
    this.updateSelection();
    o?.env.follow(this.rig.camera);
    if (this.renderer) this.renderer.render(this.scene, this.rig.camera);
    this.labelPos = this.options.labels && this.twin && this.size.width > 0 ? this.projector.project(this.twin.labels, this.rig.camera, this.size.width, this.size.height, MAX_LABELS, this.occluder) : [];
    this.frameMs = typeof performance !== "undefined" ? performance.now() - t0 : 0;
  }

  /** The next frame() re-samples everything at its own t; the argument is the contract's, not needed here. */
  seek(t: number): void {
    void t;
    this.sampler?.seek();
    this.rig.resetFollow();
  }

  setCamera(mode: CameraMode, target?: number): void {
    if (this.disposed) return;
    this.mode = mode;
    this.rig.setMode(mode, target);
    if (mode === "walk") {
      const p = this.rig.floorTarget();
      this.walk.enter(p.x, p.y, p.yaw);
    } else this.walk.exit();
  }

  preset(p: CameraPreset): void {
    if (this.disposed) return;
    this.walk.exit();
    this.mode = "orbit";
    this.rig.preset(p);
  }

  lookAt(x: number, y: number): void {
    if (this.disposed) return;
    if (this.mode !== "orbit") this.setCamera("orbit");
    this.rig.lookAt(x, y);
  }

  setSelection(sel: PickResult | null): void {
    this.selection = sel;
  }

  pick(ndcX: number, ndcY: number): PickResult | null {
    const o = this.objects;
    const world = this.world;
    if (!o || !world) return null;
    return this.picker.pick(ndcX, ndcY, this.rig.camera, {
      actors: o.pool.root,
      faces: o.racks.faces,
      reserve: o.racks.reserve,
      reserveStack: o.racks.reserveStack,
      loose: o.loose.mesh,
      looseEntity: o.loose.entityAt,
      doorPads: o.building.doorPads,
      doorLamps: o.building.doorLamps,
      stations: o.building.stations,
      floor: o.building.floor,
      world: world.world,
    });
  }

  setOptions(patch: Partial<ViewerOptions>): void {
    if (this.disposed) return;
    const prev = this.options;
    const next = { ...prev, ...patch };
    this.options = next;
    const o = this.objects;
    if (next.theme !== prev.theme) {
      o?.env.setTheme(next.theme);
      this.lighting.setTheme(next.theme);
      this.scene.background = new Color(THEMES[next.theme].background);
      this.lightKey = "";
    }
    if (next.dayNight !== prev.dayNight) this.lightKey = "";
    if (next.quality !== prev.quality && this.world) {
      const q = this.effectiveQuality(this.world.layout.pick.length + this.world.layout.reserve.length);
      if (q !== o?.quality) {
        this.setWorld(this.world);
        return;
      }
    }
    if (this.twin && (next.heat !== prev.heat || next.debugSpeed !== prev.debugSpeed)) {
      this.twin.flags.heat = next.heat;
      this.twin.flags.debugSpeed = next.debugSpeed;
      recolorFaces(this.twin);
    }
    if (next.shadows !== prev.shadows) {
      const on = this.effectiveShadows();
      this.lighting.setShadows(on);
      if (this.renderer) {
        this.renderer.shadowMap.enabled = on;
        this.scene.traverse((obj) => {
          const m = (obj as Mesh).material;
          if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
          else if (m) m.needsUpdate = true;
        });
      }
    }
  }

  labels(): LabelPos[] {
    return this.labelPos;
  }

  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const cap = w < 1000 ? 1.5 : 2;
    const ratio = Math.min(cap, Math.max(0.5, dpr || 1));
    this.size = { width: w, height: h, dpr: ratio };
    this.rig.setAspect(w / h);
    if (this.renderer) {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
  }

  stats(): ViewerStats {
    const info = this.renderer?.info.render;
    return { drawCalls: info?.calls ?? 0, triangles: info?.triangles ?? 0, frameMs: this.frameMs, actors: this.objects?.pool.activeCount ?? 0 };
  }

  /** Stage colour behind the scene before the first frame, per theme; the page's CSS mirrors it. */
  backgroundHex(): number {
    return THEMES[this.options.theme].background;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.walk.dispose();
    this.rig.dispose();
    this.disposeWorld();
    this.playback = null;
    this.world = null;
    this.occluder = null;
    this.schedule = null;
    this.lighting.dispose();
    this.scene.clear();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.labelPos = [];
  }
}

export function createTwinViewer(options: Partial<ViewerOptions> = {}): TwinViewerImpl {
  return new TwinViewerImpl(options);
}
