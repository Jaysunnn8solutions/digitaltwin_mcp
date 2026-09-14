/**
 * Camera rig: orbit with presets for the places people look at (overview,
 * dock, pick module, reserve, yard) and a spring-damped follow camera that
 * sits behind and above whatever it is chasing, at truck scale for trucks.
 * OrbitControls is created on attach(), so the rig can be built and its
 * presets computed under Node; only attach() needs a DOM element.
 *
 * Presets are fitted, not hard-coded: each names a box in engine feet (the
 * building and yard, the dock face, the pick module, the reserve block, the
 * road and queue spots) and a view direction, and fitView finds the camera
 * distance at which every corner of that box lands inside PRESET_FILL of the
 * frustum for the camera's fov and current aspect, so the subject fills the
 * viewport on a phone and on a wide monitor alike. A resize re-fits the
 * preset the camera is still on; the first drag, wheel or pinch releases it.
 *
 * Follow: critically damped spring on the camera position (stiffness 30),
 * target smoothed separately, wheel scales the distance between 0.4× and 4×.
 */

import { PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { World } from "../trace/types";
import type { Layout } from "../twin/layout";
import type { CameraMode, CameraPreset } from "./api";
import { toWorld } from "./geometry";

export interface FollowPose {
  /** Engine feet. */
  x: number;
  y: number;
  /** Heading, radians, 0 = +x. */
  h: number;
  truck: boolean;
}

/** An axis-aligned box in engine feet (x across, y from the dock wall inward, z up). */
export interface StageBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** What a preset frames: the box, the unit direction from the box towards the camera, and the fraction of the viewport the box fills. */
export interface PresetSpec {
  box: StageBox;
  /** Engine frame, unit length. */
  back: [number, number, number];
  fill?: number;
  /** Lowest camera height in feet, so a low angle stays above the trucks. */
  minHeight?: number;
}

export interface PresetView {
  pos: Vector3;
  target: Vector3;
}

/** The share of the frustum a fitted subject occupies. */
export const PRESET_FILL = 0.85;
export const WALL_TOP = 28;
export const RACK_TOP = 22;
const FOLLOW_STIFFNESS = 30;
const _desired = new Vector3();
const _look = new Vector3();
const _acc = new Vector3();
const _back = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _corner = new Vector3();
const _centre = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);

function unit(v: [number, number, number]): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * The camera distance along `back` from the box centre at which every
 * corner projects inside `fill` of a frustum with vertical `fovDeg` and
 * `aspect`. Exact: for each corner, the distance that puts it on the
 * frustum edge is its lateral offset over the tangent, less its depth.
 */
export function fitDistance(box: StageBox, back: [number, number, number], fovDeg: number, aspect: number, fill = PRESET_FILL): number {
  const b = unit(back);
  toWorld(b[0], b[1], b[2], _back);
  // Camera basis: forward = -back, right = forward × up, up = right × forward.
  _fwd.copy(_back).negate();
  _right.crossVectors(_fwd, WORLD_UP);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  _up.crossVectors(_right, _fwd).normalize();
  toWorld((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2, _centre);
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * fill;
  const tanH = tanV * Math.max(0.05, aspect);
  let d = 0;
  for (const x of [box.x0, box.x1]) {
    for (const y of [box.y0, box.y1]) {
      for (const z of [box.z0, box.z1]) {
        toWorld(x, y, z, _corner).sub(_centre);
        const depth = -_corner.dot(_back);
        const lateral = Math.abs(_corner.dot(_right));
        const vertical = Math.abs(_corner.dot(_up));
        d = Math.max(d, lateral / tanH - depth, vertical / tanV - depth);
      }
    }
  }
  return d;
}

/** Camera position and orbit target for a preset at the given fov and aspect. */
export function fitView(spec: PresetSpec, fovDeg: number, aspect: number): PresetView {
  const back = unit(spec.back);
  const box = spec.box;
  let d = fitDistance(box, back, fovDeg, aspect, spec.fill ?? PRESET_FILL);
  const cz = (box.z0 + box.z1) / 2;
  if (spec.minHeight !== undefined && back[2] > 1e-6) d = Math.max(d, (spec.minHeight - cz) / back[2]);
  const target = toWorld((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, cz);
  const pos = toWorld((box.x0 + box.x1) / 2 + back[0] * d, (box.y0 + box.y1) / 2 + back[1] * d, cz + back[2] * d);
  return { pos, target };
}

/** The five preset specs for a building, from its layout and world. */
export function presetSpecs(layout: Layout, world: World): Record<CameraPreset, PresetSpec> {
  const spec = layout.spec;
  const W = spec.widthFt;
  const D = spec.depthFt;
  const roadY = world.yard.roadY;
  let queueY = roadY;
  let queueX0 = 0;
  let queueX1 = W;
  for (const spots of Object.values(world.yard.queue)) {
    for (const s of spots) {
      queueY = Math.min(queueY, s[1] - 30);
      queueX0 = Math.min(queueX0, s[0] - 10);
      queueX1 = Math.max(queueX1, s[0] + 10);
    }
  }
  const runsOf = (aisles: Layout["pickAisles"]) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const a of aisles) {
      for (const r of [a.left, a.right]) {
        if (!r) continue;
        x0 = Math.min(x0, r.x - r.depthFt / 2);
        x1 = Math.max(x1, r.x + r.depthFt / 2);
      }
      y0 = Math.min(y0, a.y0);
      y1 = Math.max(y1, a.y1);
    }
    return Number.isFinite(x0) ? { x0, x1, y0, y1 } : null;
  };
  const pick = runsOf(layout.pickAisles) ?? { x0: layout.depot.x - 30, x1: layout.depot.x + 30, y0: layout.pickFrontY, y1: layout.pickBackY };
  const reserve = runsOf(layout.reserveAisles) ?? { x0: 0, x1: W / 2, y0: layout.pickFrontY, y1: layout.pickBackY };
  const topOf = (aisles: Layout["pickAisles"], fallback: number, clearance: number, floor: number) => {
    let top = floor;
    for (const a of aisles) {
      for (const r of [a.left, a.right]) {
        if (!r) continue;
        const h = world.levelHeights[r.id];
        top = Math.max(top, (h && h.length ? h[h.length - 1] : fallback) + clearance);
      }
    }
    return top;
  };
  const pickTop = topOf(layout.pickAisles, 6, 2, 8);
  const reserveTop = topOf(layout.reserveAisles, 15, 5, 12);
  return {
    // Three-quarter aerial from the dock side: the whole building and the yard road.
    overview: { box: { x0: 0, x1: W, y0: roadY - 20, y1: D, z0: 0, z1: WALL_TOP }, back: [-0.42, -0.62, 0.66] },
    // Low along the dock wall from the yard, the inbound end nearest.
    dock: { box: { x0: 0, x1: W, y0: -70, y1: 12, z0: 0, z1: WALL_TOP }, back: [-0.62, -0.76, 0.2], fill: 0.9, minHeight: 18 },
    // In front of the pick module at head height, looking down the aisles.
    pick: { box: { x0: pick.x0, x1: pick.x1, y0: pick.y0, y1: pick.y1, z0: 0, z1: pickTop }, back: [-0.12, -0.72, 0.68], minHeight: 12 },
    // Over the reserve block from its front corner.
    reserve: { box: { x0: reserve.x0, x1: reserve.x1, y0: reserve.y0, y1: reserve.y1, z0: 0, z1: reserveTop }, back: [-0.45, -0.6, 0.66] },
    // From beyond the road, the queue spots and every door in frame.
    yard: { box: { x0: Math.min(queueX0, 0), x1: Math.max(queueX1, W), y0: queueY, y1: 6, z0: 0, z1: WALL_TOP }, back: [0.1, -0.8, 0.6] },
  };
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(55, 1, 0.5, 5000);
  controls: OrbitControls | null = null;
  mode: CameraMode = "orbit";
  followTarget = -1;
  /** The preset the orbit camera is still framing, or null once the user has moved it. */
  activePreset: CameraPreset | null = null;
  private followFactor = 1;
  private readonly followPos = new Vector3();
  private readonly followVel = new Vector3();
  private readonly followLook = new Vector3();
  private followInit = false;
  private specs: Record<CameraPreset, PresetSpec>;
  private element: HTMLElement | null = null;
  private readonly onWheel = (e: WheelEvent) => {
    if (this.mode !== "follow") return;
    e.preventDefault();
    this.followFactor = Math.min(4, Math.max(0.4, this.followFactor * Math.exp(e.deltaY * 0.0012)));
  };
  private readonly onUserStart = () => {
    this.activePreset = null;
  };

  constructor() {
    this.specs = CameraRig.defaultSpecs();
    this.preset("overview");
  }

  private static defaultSpecs(): Record<CameraPreset, PresetSpec> {
    const b: StageBox = { x0: 0, x1: 200, y0: -80, y1: 200, z0: 0, z1: WALL_TOP };
    return {
      overview: { box: b, back: [-0.42, -0.62, 0.66] },
      dock: { box: { ...b, y0: -70, y1: 12 }, back: [-0.62, -0.76, 0.2], minHeight: 18 },
      pick: { box: { x0: 70, x1: 130, y0: 70, y1: 150, z0: 0, z1: 8 }, back: [-0.12, -0.72, 0.68], minHeight: 12 },
      reserve: { box: { x0: 20, x1: 80, y0: 70, y1: 160, z0: 0, z1: 20 }, back: [-0.45, -0.6, 0.66] },
      yard: { box: { ...b, y0: -160, y1: 6 }, back: [0.1, -0.8, 0.6] },
    };
  }

  attach(element: HTMLElement): void {
    if (this.controls) return;
    this.element = element;
    const c = new OrbitControls(this.camera, element);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI / 2 - 0.03;
    c.minDistance = 4;
    c.maxDistance = 4000;
    c.screenSpacePanning = false;
    c.enabled = this.mode === "orbit";
    c.addEventListener("start", this.onUserStart);
    this.controls = c;
    element.addEventListener("wheel", this.onWheel, { passive: false });
    this.applyView(this.view(this.activePreset ?? "overview"));
  }

  detach(): void {
    if (this.element) this.element.removeEventListener("wheel", this.onWheel);
    this.element = null;
    this.controls?.removeEventListener("start", this.onUserStart);
    this.controls?.dispose();
    this.controls = null;
  }

  setWorld(layout: Layout, world: World): void {
    this.specs = presetSpecs(layout, world);
    if (this.mode === "orbit") this.preset("overview");
  }

  /** The viewport changed: keep the projection right and re-fit the preset the camera is still on. */
  setAspect(aspect: number): void {
    if (!(aspect > 0) || aspect === this.camera.aspect) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.mode === "orbit" && this.activePreset) this.applyView(this.view(this.activePreset));
  }

  /** The fitted view for a preset at the camera's fov and aspect. */
  view(p: CameraPreset): PresetView {
    return fitView(this.specs[p], this.camera.fov, this.camera.aspect);
  }

  private applyView(v: PresetView): void {
    this.camera.position.copy(v.pos);
    if (this.controls) {
      this.controls.target.copy(v.target);
      this.controls.update();
    } else this.camera.lookAt(v.target);
  }

  preset(p: CameraPreset): void {
    this.mode = "orbit";
    this.followTarget = -1;
    if (this.controls) this.controls.enabled = true;
    this.applyView(this.view(p));
    this.activePreset = p;
  }

  setMode(mode: CameraMode, target?: number): void {
    this.mode = mode;
    this.activePreset = null;
    if (mode === "follow") {
      this.followTarget = target ?? this.followTarget;
      this.followInit = false;
    } else if (mode === "orbit" && this.controls) {
      // Keep looking where the last mode left the camera.
      this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(_look).multiplyScalar(30));
      this.controls.update();
    }
    if (this.controls) this.controls.enabled = mode === "orbit";
  }

  /** Move the orbit target to an engine floor position, keeping the camera where it is. */
  lookAt(x: number, y: number): void {
    this.activePreset = null;
    if (this.controls) {
      this.controls.target.set(x, 0, -y);
      this.controls.update();
    } else this.camera.lookAt(x, 0, -y);
  }

  /** The orbit target on the floor, in engine feet, for entering walk mode. */
  floorTarget(): { x: number; y: number; yaw: number } {
    const t = this.controls?.target ?? this.camera.position;
    const dir = this.camera.getWorldDirection(_look);
    return { x: t.x, y: -t.z, yaw: Math.atan2(-dir.x, -dir.z) };
  }

  resetFollow(): void {
    this.followInit = false;
  }

  update(dt: number, pose: FollowPose | null): void {
    if (this.mode === "orbit") {
      this.controls?.update(dt);
      return;
    }
    if (this.mode !== "follow" || !pose) return;
    const step = Math.min(0.1, Math.max(0, dt));
    const dist = (pose.truck ? 40 : 18) * this.followFactor;
    const height = (pose.truck ? 16 : 9) * this.followFactor;
    const hx = Math.cos(pose.h);
    const hz = -Math.sin(pose.h);
    const ahead = pose.truck ? 26 : 0;
    _look.set(pose.x + hx * ahead, pose.truck ? 6 : 3, -pose.y + hz * ahead);
    _desired.set(_look.x - hx * dist, height, _look.z - hz * dist);
    if (!this.followInit) {
      this.followPos.copy(_desired);
      this.followVel.set(0, 0, 0);
      this.followLook.copy(_look);
      this.followInit = true;
    } else {
      const damping = 2 * Math.sqrt(FOLLOW_STIFFNESS);
      _acc.subVectors(_desired, this.followPos).multiplyScalar(FOLLOW_STIFFNESS).addScaledVector(this.followVel, -damping);
      this.followVel.addScaledVector(_acc, step);
      this.followPos.addScaledVector(this.followVel, step);
      this.followLook.lerp(_look, 1 - Math.exp(-step * 8));
    }
    this.camera.position.copy(this.followPos);
    this.camera.lookAt(this.followLook);
  }

  dispose(): void {
    this.detach();
  }
}
