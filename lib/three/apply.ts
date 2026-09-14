/**
 * Turns one playback sample into scene state. applyFrame never reads engine
 * state: everything comes from the Playback (typed-array tracks and CSR
 * timelines) and the sample's dirty range, so a frame costs the keyframes it
 * crossed plus the actors on the floor, whatever the horizon. A seek sets
 * `reset` and the next frame re-reads every timeline at t by binary search.
 *
 * FrameSample is the seam with lib/trace/cursor.ts (P3): poses are laid out
 * per Playback.tracks index, POSE_STRIDE floats each in the order x, y, z,
 * heading, state, segment kind, job, carried pallet entity (the Track fields
 * in lib/trace/types.ts, interpolated), and dirtyFrom..dirtyTo is the
 * half-open range of Playback.dirty rows with lastT < t <= now. The
 * PlaybackSampler below produces exactly that from a Playback and is what
 * viewer.ts uses until the cursor lands; a cursor that returns the same shape
 * drops in.
 *
 * Time-driven effects (the hot-face pulse, the late-truck strobe) are
 * functions of simulated t, never of wall-clock time, so a paused frame
 * looks the same each time it renders and the same seed always looks the
 * same.
 */

import { Color, Vector3 } from "three";
import { ActorState, DirtyKind, PalletAt, SegKind, type Playback, type TraceInit, type WorldPayload } from "../trace/types";
import { PROCESS_SKILL, PROCESSES } from "../twin/types";
import { ActorPool, EQUIPMENT_COLORS, LoosePallets, type Actor } from "./actors";
import type { Building } from "./building";
import { PALLET_HEIGHT } from "./geometry";
import { queueChipEntity, reserveBadgeEntity, type LabelSource } from "./labels";
import { categoryColor, DOOR_COLORS, fillColor, heatColor, roleColor, STATE_COLORS } from "./palette";
import { MAX_STACK, type Racks } from "./racks";

// ---------------------------------------------------------------------------
// Sample contract
// ---------------------------------------------------------------------------

export const POSE_STRIDE = 8;
export const POSE = { x: 0, y: 1, z: 2, h: 3, s: 4, seg: 5, job: 6, carry: 7 } as const;

export interface FrameSample {
  /** Simulated minute. */
  t: number;
  /** Playback.tracks.length × POSE_STRIDE; a null track is all zero (state Off). */
  poses: Float32Array;
  /** Half-open range of Playback.dirty rows crossed since the previous sample. */
  dirtyFrom: number;
  dirtyTo: number;
  /** After a seek or on the first sample: ignore the range and re-read every timeline at t. */
  reset: boolean;
}

/** First index with arr[i] > t. */
export function upperBound(arr: ArrayLike<number>, n: number, t: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Row of a CSR item in force at t (the last row with time <= t), or -1 for an item with no rows. */
export function rowAt(tl: { offsets: Int32Array; t: Float64Array }, item: number, t: number): number {
  const lo = tl.offsets[item];
  const hi = tl.offsets[item + 1];
  if (hi <= lo) return -1;
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (tl.t[mid] <= t) a = mid + 1;
    else b = mid;
  }
  return Math.max(lo, a - 1);
}

function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * f;
}

/**
 * Samples a Playback: amortised O(1) per track when time moves forward,
 * binary search after a seek or a jump backwards.
 */
export class PlaybackSampler {
  readonly poses: Float32Array;
  private readonly idx: Int32Array;
  private dirtyPos = 0;
  private lastT = 0;
  private pending = true;

  constructor(readonly pb: Playback) {
    this.poses = new Float32Array(pb.tracks.length * POSE_STRIDE);
    this.idx = new Int32Array(pb.tracks.length).fill(-1);
  }

  /** The next sample() re-derives every cursor and reports reset. */
  seek(): void {
    this.pending = true;
  }

  sample(t: number): FrameSample {
    const { tracks, dirty } = this.pb;
    let reset = false;
    let dirtyFrom: number;
    let dirtyTo: number;
    if (this.pending || t < this.lastT) {
      reset = true;
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i];
        this.idx[i] = tr ? upperBound(tr.t, tr.t.length, t) - 1 : -1;
      }
      this.dirtyPos = upperBound(dirty.t, dirty.t.length, t);
      dirtyFrom = dirtyTo = this.dirtyPos;
    } else {
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i];
        if (!tr) continue;
        let k = this.idx[i];
        const n = tr.t.length;
        while (k + 1 < n && tr.t[k + 1] <= t) k++;
        this.idx[i] = k;
      }
      dirtyFrom = this.dirtyPos;
      while (this.dirtyPos < dirty.t.length && dirty.t[this.dirtyPos] <= t) this.dirtyPos++;
      dirtyTo = this.dirtyPos;
    }
    const p = this.poses;
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      const b = i * POSE_STRIDE;
      const k = this.idx[i];
      if (!tr || k < 0) {
        p.fill(0, b, b + POSE_STRIDE);
        p[b + POSE.carry] = -1;
        continue;
      }
      const n = tr.t.length;
      if (k + 1 < n) {
        const f = (t - tr.t[k]) / (tr.t[k + 1] - tr.t[k]);
        p[b + POSE.x] = tr.x[k] + (tr.x[k + 1] - tr.x[k]) * f;
        p[b + POSE.y] = tr.y[k] + (tr.y[k + 1] - tr.y[k]) * f;
        p[b + POSE.z] = tr.z[k] + (tr.z[k + 1] - tr.z[k]) * f;
        p[b + POSE.h] = lerpAngle(tr.h[k], tr.h[k + 1], f);
      } else {
        p[b + POSE.x] = tr.x[k];
        p[b + POSE.y] = tr.y[k];
        p[b + POSE.z] = tr.z[k];
        p[b + POSE.h] = tr.h[k];
      }
      p[b + POSE.s] = tr.s[k];
      p[b + POSE.seg] = tr.seg[k];
      p[b + POSE.job] = tr.job[k];
      p[b + POSE.carry] = tr.carry[k];
    }
    this.lastT = t;
    this.pending = false;
    return { t, poses: p, dirtyFrom, dirtyTo, reset };
  }
}

// ---------------------------------------------------------------------------
// Scene binding
// ---------------------------------------------------------------------------

export interface SceneRefs {
  racks: Racks;
  building: Building;
  actors: ActorPool;
  loose: LoosePallets;
}

export interface SceneFlags {
  /** Colour faces by lines per week instead of fill. */
  heat: boolean;
  /** Tint actors whose fitted speed is more than 1.5× the engine's. */
  debugSpeed: boolean;
}

export interface TwinScene {
  refs: SceneRefs;
  world: WorldPayload;
  playback: Playback;
  flags: SceneFlags;
  faceCap: Float32Array;
  facePerCase: Float32Array;
  faceInners: Uint16Array;
  faceHot: Uint8Array;
  hotFaces: Set<number>;
  /** 0..1 heat per face, sqrt of lines/week over the max, like the floor plan. */
  faceHeat: Float32Array;
  reserveCount: Uint8Array;
  reserveSku: Int32Array;
  /** Reserve positions with more pallets than the stack shows. */
  overflow: Set<number>;
  doorValue: Int32Array;
  laneOccupant: Int32Array;
  stationJob: Int32Array;
  /** Pallet timeline index → entity index. */
  palletEntity: Int32Array;
  /** Sku index → category palette index (traditional 0, specialty segments in first-seen order). */
  skuCategory: Int32Array;
  forkliftEntities: number[];
  forkliftOutages: TraceInit["outages"]["forklifts"];
  labels: LabelSource[];
  queue: number[];
  visibleActors: number;
  lastT: number;
}

const _c = new Color();
const _c2 = new Color();
const _hot = new Color(STATE_COLORS.hot);
const _v = new Vector3();

export function bindScene(refs: SceneRefs, world: WorldPayload, playback: Playback, flags: SceneFlags): TwinScene {
  const nFaces = playback.faceSku.length;
  const nRes = playback.reserveSlots.offsets.length - 1;
  const init = playback.events[0]?.k === "init" ? (playback.events[0] as TraceInit) : null;
  const capBySku = new Map<string, number>(init?.faceCap ?? []);
  const faceCap = new Float32Array(nFaces);
  const facePerCase = new Float32Array(nFaces);
  for (let i = 0; i < nFaces; i++) {
    const s = playback.faceSku[i];
    const sku = s >= 0 ? world.skus[s] : undefined;
    if (!sku) continue;
    facePerCase[i] = sku.innersPerCase;
    faceCap[i] = capBySku.get(sku.id) ?? world.layout.site.pick.faceCases * sku.innersPerCase;
  }
  // Heat: pick lines per face over the horizon, like the floor plan's heat layer.
  const lines = new Float32Array(nFaces);
  for (const job of playback.jobs) {
    if (job.info.kind !== "pick") continue;
    for (const line of job.info.lines) {
      const i = refs.racks.faceIndex.get(line.loc);
      if (i !== undefined) lines[i]++;
    }
  }
  let maxLines = 0;
  for (let i = 0; i < nFaces; i++) maxLines = Math.max(maxLines, lines[i]);
  const faceHeat = new Float32Array(nFaces);
  if (maxLines > 0) for (let i = 0; i < nFaces; i++) faceHeat[i] = Math.sqrt(lines[i] / maxLines);
  // Category palette index per sku.
  const categories = new Map<string, number>([["traditional", 0]]);
  const skuCategory = new Int32Array(world.skus.length);
  world.skus.forEach((s, i) => {
    let c = categories.get(s.category);
    if (c === undefined) {
      c = categories.size;
      categories.set(s.category, c);
    }
    skuCategory[i] = c;
  });
  const palletEntity: number[] = [];
  const forkliftEntities: number[] = [];
  playback.entities.forEach((e, i) => {
    if (e.kind === "pallet") palletEntity.push(i);
    if (e.kind === "forklift") forkliftEntities.push(i);
  });
  forkliftEntities.sort((a, b) => playback.entities[a].id.localeCompare(playback.entities[b].id, "en", { numeric: true }));
  return {
    refs,
    world,
    playback,
    flags,
    faceCap,
    facePerCase,
    faceInners: new Uint16Array(nFaces),
    faceHot: new Uint8Array(nFaces),
    hotFaces: new Set(),
    faceHeat,
    reserveCount: new Uint8Array(nRes),
    reserveSku: new Int32Array(nRes).fill(-1),
    overflow: new Set(),
    doorValue: new Int32Array(playback.doors.offsets.length - 1).fill(-1),
    laneOccupant: new Int32Array(playback.laneSlots.offsets.length - 1).fill(-1),
    stationJob: new Int32Array(playback.stations.offsets.length - 1).fill(-1),
    palletEntity: Int32Array.from(palletEntity),
    skuCategory,
    forkliftEntities,
    forkliftOutages: init?.outages.forklifts ?? [],
    labels: [],
    queue: PROCESSES.map(() => 0),
    visibleActors: 0,
    lastT: -1,
  };
}

/** Hide every dynamic thing (playback removed or replaced). */
export function releaseScene(scene: TwinScene): void {
  scene.refs.actors.releaseAll();
  scene.refs.loose.clear();
  scene.refs.loose.commit();
  scene.labels = [];
  scene.visibleActors = 0;
}

// ---------------------------------------------------------------------------
// Timeline handlers
// ---------------------------------------------------------------------------

function refreshFace(scene: TwinScene, i: number): void {
  const sku = scene.playback.faceSku[i];
  if (sku < 0) {
    scene.refs.racks.setFace(i, -1, null);
    return;
  }
  const inners = scene.faceInners[i];
  const cap = scene.faceCap[i];
  let fraction: number;
  if (scene.flags.heat) {
    heatColor(_c, scene.faceHeat[i]);
    fraction = 1;
  } else {
    fillColor(_c, inners, cap, scene.facePerCase[i]);
    fraction = cap > 0 ? inners / cap : 0;
  }
  scene.refs.racks.setFace(i, fraction, _c);
}

function pulseHot(scene: TwinScene, t: number): void {
  if (scene.hotFaces.size === 0) return;
  const k = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI);
  for (const i of scene.hotFaces) {
    const sku = scene.playback.faceSku[i];
    if (sku < 0) continue;
    const inners = scene.faceInners[i];
    const cap = scene.faceCap[i];
    if (scene.flags.heat) heatColor(_c2, scene.faceHeat[i]);
    else fillColor(_c2, inners, cap, scene.facePerCase[i]);
    _c.lerpColors(_c2, _hot, k);
    scene.refs.racks.setFace(i, scene.flags.heat ? 1 : cap > 0 ? inners / cap : 0, _c);
  }
}

function setHot(scene: TwinScene, i: number, hot: number): void {
  scene.faceHot[i] = hot;
  if (hot) scene.hotFaces.add(i);
  else {
    scene.hotFaces.delete(i);
    refreshFace(scene, i);
  }
}

function refreshReserve(scene: TwinScene, i: number): void {
  const count = scene.reserveCount[i];
  const sku = scene.reserveSku[i];
  _c.setHex(sku >= 0 && sku < scene.skuCategory.length ? categoryColor(scene.skuCategory[sku]) : 0x8b5e3c);
  scene.refs.racks.setReserve(i, count, _c);
  if (count > MAX_STACK) scene.overflow.add(i);
  else scene.overflow.delete(i);
}

function setDoor(scene: TwinScene, i: number, v: number): void {
  scene.doorValue[i] = v;
  scene.refs.building.setDoor(i, v === -2 ? "outage" : v >= 0 ? "busy" : "free");
}

function setStation(scene: TwinScene, i: number, v: number): void {
  scene.stationJob[i] = v;
  scene.refs.building.setStation(i, v >= 0);
}

function palletColor(scene: TwinScene, entity: number): Color {
  const def = scene.playback.entities[entity];
  return _c.setHex(categoryColor(def?.colorIdx ?? 0));
}

function placePallet(scene: TwinScene, p: number, row: number): void {
  const tl = scene.playback.pallets;
  const entity = scene.palletEntity[p];
  if (entity === undefined || row < 0) return;
  const at = tl.at[row];
  const ref = tl.ref[row];
  const slot = tl.slot[row];
  const w = scene.world.world;
  const loose = scene.refs.loose;
  if (at === PalletAt.DockLane || at === PalletAt.StagingLane) {
    const lane = w.lanes[ref];
    const frame = w.frames[ref];
    if (!lane || lane.slots.length === 0) {
      loose.remove(entity);
      return;
    }
    const spot = lane.slots[((slot % lane.slots.length) + lane.slots.length) % lane.slots.length];
    const tier = Math.max(0, Math.floor(slot / lane.slots.length));
    loose.place(entity, spot[0], tier * PALLET_HEIGHT, -spot[1], palletColor(scene, entity), frame ? Math.atan2(frame.tangent[1], frame.tangent[0]) : 0);
  } else if (at === PalletAt.PackStation) {
    const st = w.stations[ref];
    if (!st) {
      loose.remove(entity);
      return;
    }
    const k = slot >= 0 ? slot % 3 : 0;
    loose.place(entity, st[0] + (k - 1) * 3.6, 0, -(st[1] + 4.5), palletColor(scene, entity));
  } else {
    loose.remove(entity);
  }
}

function applyDirty(scene: TwinScene, from: number, to: number): void {
  const pb = scene.playback;
  const d = pb.dirty;
  for (let r = from; r < to; r++) {
    const idx = d.idx[r];
    const row = d.row[r];
    switch (d.kind[r]) {
      case DirtyKind.Face:
        scene.faceInners[idx] = pb.faces.v[row];
        refreshFace(scene, idx);
        break;
      case DirtyKind.FaceHot:
        setHot(scene, idx, pb.faceHot.v[row]);
        break;
      case DirtyKind.ReserveSlots:
        scene.reserveCount[idx] = pb.reserveSlots.v[row];
        refreshReserve(scene, idx);
        break;
      case DirtyKind.ReserveSku:
        scene.reserveSku[idx] = pb.reserveSku.v[row];
        refreshReserve(scene, idx);
        break;
      case DirtyKind.ReserveInners:
        break;
      case DirtyKind.Door:
        setDoor(scene, idx, pb.doors.v[row]);
        break;
      case DirtyKind.LaneSlot:
        scene.laneOccupant[idx] = pb.laneSlots.v[row];
        break;
      case DirtyKind.Station:
        setStation(scene, idx, pb.stations.v[row]);
        break;
      case DirtyKind.Pallet:
        placePallet(scene, idx, row);
        break;
    }
  }
}

function rereadAll(scene: TwinScene, t: number): void {
  const pb = scene.playback;
  const nFaces = scene.faceInners.length;
  scene.hotFaces.clear();
  for (let i = 0; i < nFaces; i++) {
    const r = rowAt(pb.faces, i, t);
    scene.faceInners[i] = r >= 0 ? pb.faces.v[r] : 0;
    const h = rowAt(pb.faceHot, i, t);
    scene.faceHot[i] = h >= 0 ? pb.faceHot.v[h] : 0;
    if (scene.faceHot[i]) scene.hotFaces.add(i);
    refreshFace(scene, i);
  }
  for (let i = 0; i < scene.reserveCount.length; i++) {
    const r = rowAt(pb.reserveSlots, i, t);
    scene.reserveCount[i] = r >= 0 ? pb.reserveSlots.v[r] : 0;
    const s = rowAt(pb.reserveSku, i, t);
    scene.reserveSku[i] = s >= 0 ? pb.reserveSku.v[s] : -1;
    refreshReserve(scene, i);
  }
  for (let i = 0; i < scene.doorValue.length; i++) {
    const r = rowAt(pb.doors, i, t);
    setDoor(scene, i, r >= 0 ? pb.doors.v[r] : -1);
  }
  for (let i = 0; i < scene.laneOccupant.length; i++) {
    const r = rowAt(pb.laneSlots, i, t);
    scene.laneOccupant[i] = r >= 0 ? pb.laneSlots.v[r] : -1;
  }
  for (let i = 0; i < scene.stationJob.length; i++) {
    const r = rowAt(pb.stations, i, t);
    setStation(scene, i, r >= 0 ? pb.stations.v[r] : -1);
  }
  scene.refs.loose.clear();
  for (let p = 0; p < scene.palletEntity.length; p++) placePallet(scene, p, rowAt(pb.pallets, p, t));
}

/** Re-colour every face (heat toggled, theme changed). */
export function recolorFaces(scene: TwinScene): void {
  for (let i = 0; i < scene.faceInners.length; i++) refreshFace(scene, i);
  scene.refs.racks.commit();
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

function forkliftOut(scene: TwinScene, entity: number, t: number): boolean {
  if (scene.forkliftOutages.length === 0) return false;
  const day = Math.floor(t / 1440);
  let out = 0;
  for (const o of scene.forkliftOutages) if (day >= o.fromDay && day <= o.toDay) out = Math.max(out, o.count);
  if (out === 0) return false;
  const rank = scene.forkliftEntities.indexOf(entity);
  return rank >= 0 && rank >= scene.forkliftEntities.length - out;
}

function ringFor(state: number): number | null {
  switch (state) {
    case ActorState.Overtime:
      return STATE_COLORS.overtime;
    case ActorState.Break:
      return STATE_COLORS.break;
    case ActorState.Indirect:
      return STATE_COLORS.indirect;
    case ActorState.Wait:
      return STATE_COLORS.wait;
    case ActorState.Lift:
      return STATE_COLORS.lift;
    case ActorState.Late:
      return STATE_COLORS.late;
    default:
      return null;
  }
}

function applyActor(scene: TwinScene, actor: Actor, i: number, sample: FrameSample, dt: number): void {
  const pool = scene.refs.actors;
  const pb = scene.playback;
  const p = sample.poses;
  const b = i * POSE_STRIDE;
  const def = pb.entities[actor.entity];
  const state = p[b + POSE.s];
  const seg = p[b + POSE.seg];
  const job = p[b + POSE.job];
  const carry = p[b + POSE.carry];
  const t = sample.t;
  const absent = state === ActorState.Absent;
  const w = scene.world.world;

  if (absent) actor.group.position.set(w.entrance[0], 0, -w.entrance[1]);
  else actor.group.position.set(p[b + POSE.x], 0, -p[b + POSE.y]);
  actor.group.rotation.y = p[b + POSE.h];

  let tint: number;
  if (actor.kind === "worker") tint = roleColor(def.colorIdx);
  else if (actor.kind === "forklift") tint = forkliftOut(scene, actor.entity, t) ? STATE_COLORS.outage : EQUIPMENT_COLORS.forklift;
  else if (actor.kind === "jack") tint = EQUIPMENT_COLORS.jack;
  else tint = def.kind === "truckIn" ? DOOR_COLORS.inbound : DOOR_COLORS.outbound;
  if (scene.flags.debugSpeed && job >= 1) {
    const row = pb.jobs[job - 1];
    if (row && row.speedRatio > 1.5) tint = STATE_COLORS.fast;
  }
  if (actor.baseTint !== tint) pool.setTint(actor, tint);
  pool.setGhost(actor, absent);

  if (actor.carriage) actor.carriage.position.y = p[b + POSE.z];
  if (actor.cart) actor.cart.visible = seg === SegKind.WalkCart;
  if (actor.carried) {
    if (carry >= 0) {
      actor.carried.visible = true;
      const cdef = pb.entities[carry];
      actor.carried.material = pool.materials.lambert(categoryColor(cdef?.colorIdx ?? 0));
    } else actor.carried.visible = false;
  }
  if (actor.sticker) actor.sticker.visible = def.meta.importer === true;

  let ring = ringFor(state);
  if (actor.kind === "forklift" && tint === STATE_COLORS.outage) ring = STATE_COLORS.outage;
  const strobeOn = Math.floor(t / 0.25) % 2 === 0;
  if (state === ActorState.Late) {
    pool.setLights(actor, strobeOn);
    pool.setRing(actor, strobeOn ? STATE_COLORS.late : null);
  } else {
    pool.setLights(actor, false);
    pool.setRing(actor, ring);
  }

  if (actor.bob) {
    const walking = seg === SegKind.Walk || seg === SegKind.WalkCart || seg === SegKind.Transfer || seg === SegKind.IdleReturn;
    if (walking && dt > 0) {
      actor.phase += dt * 9;
      actor.bob.position.y = 0.08 * Math.abs(Math.sin(actor.phase));
    } else actor.bob.position.y = 0;
  }

  if (actor.kind === "worker" || actor.kind === "truck") {
    const z = actor.kind === "truck" ? 14 : 6.5;
    scene.labels.push({ entity: actor.entity, text: def.label, x: actor.group.position.x, y: -actor.group.position.z, z, priority: actor.kind === "truck" ? 2 : 1 });
  }
}

function queueAt(scene: TwinScene, t: number): void {
  const bins = scene.playback.queueBins;
  const n = PROCESSES.length;
  if (bins.count === 0 || bins.binMin <= 0) {
    scene.queue.fill(0);
    return;
  }
  const k = Math.max(0, Math.min(bins.count - 1, Math.floor(t / bins.binMin)));
  for (let p = 0; p < n; p++) scene.queue[p] = bins.queues[k * n + p] ?? 0;
}

/**
 * Apply one sample. dtRealSec only drives the walk-cycle bob; everything
 * visible depends on the sample and the playback.
 */
export function applyFrame(scene: TwinScene, sample: FrameSample, playback: Playback, dtRealSec = 0): void {
  if (playback !== scene.playback) throw new Error("applyFrame: the sample's playback is not the one the scene was bound to.");
  const t = sample.t;
  if (sample.reset) rereadAll(scene, t);
  else applyDirty(scene, sample.dirtyFrom, sample.dirtyTo);

  scene.labels = [];
  const pool = scene.refs.actors;
  let visible = 0;
  for (let i = 0; i < playback.tracks.length; i++) {
    const tr = playback.tracks[i];
    if (!tr) continue;
    const state = sample.poses[i * POSE_STRIDE + POSE.s];
    if (state === ActorState.Off) {
      pool.release(tr.entity);
      continue;
    }
    const actor = pool.acquire(tr.entity, playback.entities[tr.entity].kind);
    if (!actor) continue;
    applyActor(scene, actor, i, sample, dtRealSec);
    visible++;
  }
  scene.visibleActors = visible;

  pulseHot(scene, t);

  queueAt(scene, t);
  const homes = scene.world.world.homes;
  PROCESSES.forEach((proc, p) => {
    const n = scene.queue[p];
    if (n <= 0) return;
    const home = homes[PROCESS_SKILL[proc]];
    if (!home) return;
    // Chips float well above the workers' name pills, so a queue at the depot never covers the people in it.
    scene.labels.push({ entity: queueChipEntity(p), text: `${proc} ${n}`, x: home[0], y: home[1], z: 13, priority: 3 });
  });
  for (const i of scene.overflow) {
    scene.refs.racks.reserveWorld(i, _v);
    scene.labels.push({ entity: reserveBadgeEntity(i), text: `×${scene.reserveCount[i]}`, x: _v.x, y: -_v.z, z: _v.y + PALLET_HEIGHT / 2 + 0.6, priority: 0 });
  }

  scene.refs.racks.commit();
  scene.refs.loose.commit();
  scene.lastT = t;
}
