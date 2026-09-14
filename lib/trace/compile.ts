/**
 * The playback compiler (design C): the ordered event stream plus the Layout
 * and World become typed-array keyframe tracks, CSR state timelines, a merged
 * dirty list, job rows with their fit, bins, hourly KPI checkpoints, a ticker
 * and quiet intervals. Everything the engine does not model is synthesized
 * here as a pure function of the events, so the same seed compiles to
 * byte-identical arrays. No DOM, no three.
 */

import { shiftPaidHours } from "../twin/standards";
import type { Layout, Location } from "../twin/layout";
import { dockToRack } from "../twin/layout";
import type { LaborStandards, Skill } from "../twin/types";
import { FreeList, ReserveAllocator } from "./identities";
import { fitJob, type FitResult } from "./fit";
import { applyEvent, cloneState, createState, kpiContext, type KpiContext } from "./kpis";
import { depotPath, dockToRackPath, exitPath, pathFeet, rackToRackPath, sShapePath, transferPath, visualOffset, yardPath, type Path } from "./paths";
import { upperBound } from "./search";
import { tickerLine } from "./ticker";
import {
  ActorState,
  DirtyKind,
  KPI_SERIES,
  LANE_SLOTS,
  PalletAt,
  SegKind,
  SYNTH_JOB,
  type Bins,
  type Checkpoint,
  type CsrTimeline,
  type DirtyList,
  type EntityDef,
  type Interval,
  type JobInfo,
  type JobRow,
  type PalletTimeline,
  type Playback,
  type Pt,
  type RunningKpis,
  type SkuInfo,
  type TickerEvent,
  type TraceEvent,
  type TraceInit,
  type Track,
  type World,
} from "./types";
import { parkSpot, thresholdPoint, trailerPose } from "./world";

export const COMPILER_VERSION = "1.0.0";
/** Yard driving speed, ft/min (about 3.4 mph). */
export const YARD_FT_PER_MIN = 300;
/** Idle: a worker lingers this long before walking home; a vehicle before returning to its park. */
export const WORKER_LINGER_MIN = 2;
export const VEHICLE_LINGER_MIN = 5;
/** A fade-in teleport takes this long (invisible while Off). */
export const FADE_EPS_MIN = 0.01;
/** Backing a trailer in takes this long. */
export const BACK_IN_MIN = 1.5;
/** A supplier trailer pulls out this long after its last pallet is off. */
export const UNDOCK_LINGER_MIN = 2;
/** Quiet intervals shorter than this are not worth skipping. */
export const QUIET_MIN = 10;

export interface CompileOptions {
  /** Draw cross-aisle legs on the corridor rows (default true) or exactly on the engine's lines. */
  offsets?: boolean;
  /** KPI checkpoint spacing, minutes (default 60). */
  checkpointMin?: number;
  /** Keep the raw events in the playback (default true). */
  keepEvents?: boolean;
}

export interface CompileInput {
  events: TraceEvent[];
  layout: Layout;
  world: World;
  skus: SkuInfo[];
  /** sku id → pick location id. */
  slotting: Array<[sku: string, loc: string]>;
  opts?: CompileOptions;
}

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Keyframe track builder
// ---------------------------------------------------------------------------

interface Frame {
  t: number;
  x: number;
  y: number;
  s: ActorState;
  seg: SegKind;
  job: number;
  carry?: number;
  z?: number;
  h?: number;
}

/**
 * Growable keyframes with two rules that keep `t` strictly increasing: a push
 * at the last frame's time overwrites it (a job that starts the minute the
 * previous one ended subsumes the idle frame), and a push before it cuts the
 * synthesized future (an idle walk interrupted by a job).
 */
class TrackBuilder {
  t: number[] = [];
  x: number[] = [];
  y: number[] = [];
  z: number[] = [];
  h: number[] = [];
  s: number[] = [];
  seg: number[] = [];
  job: number[] = [];
  carry: number[] = [];

  constructor(readonly entity: number) {}

  get n(): number {
    return this.t.length;
  }

  get lastT(): number {
    return this.n ? this.t[this.n - 1] : 0;
  }

  pos(): Pt {
    const i = this.n - 1;
    return i >= 0 ? [this.x[i], this.y[i]] : [0, 0];
  }

  heading(): number {
    return this.n ? this.h[this.n - 1] : 0;
  }

  /** Position (and fork height, heading) in effect at t, dropping every frame after t. */
  cutAt(t: number): { x: number; y: number; z: number; h: number } {
    const k = upperBound(this.t, t);
    const n = this.n;
    if (k >= n) {
      const i = n - 1;
      return i >= 0 ? { x: this.x[i], y: this.y[i], z: this.z[i], h: this.h[i] } : { x: 0, y: 0, z: 0, h: 0 };
    }
    const p = Math.max(0, k - 1);
    const span = this.t[k] - this.t[p];
    const u = span > 0 && k > p ? (t - this.t[p]) / span : 0;
    const out = { x: this.x[p] + (this.x[k] - this.x[p]) * u, y: this.y[p] + (this.y[k] - this.y[p]) * u, z: this.z[p] + (this.z[k] - this.z[p]) * u, h: this.h[p] };
    for (const a of [this.t, this.x, this.y, this.z, this.h, this.s, this.seg, this.job, this.carry]) a.length = k;
    return out;
  }

  push(f: Frame): void {
    if (this.n && f.t < this.t[this.n - 1] - EPS) {
      const p = this.cutAt(f.t);
      if (this.n && Math.abs(this.t[this.n - 1] - f.t) > EPS) this.push({ t: f.t, x: p.x, y: p.y, z: p.z, h: p.h, s: this.s[this.n - 1] as ActorState, seg: this.seg[this.n - 1] as SegKind, job: this.job[this.n - 1], carry: this.carry[this.n - 1] });
    }
    const i = this.n - 1;
    let h = f.h;
    if (i >= 0) {
      const dx = f.x - this.x[i];
      const dy = f.y - this.y[i];
      if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
        // The segment that ends here pointed this way; the new frame keeps it until it moves again.
        const dir = Math.atan2(dy, dx);
        if (Math.abs(f.t - this.t[i]) > EPS) this.h[i] = dir;
        h ??= dir;
      } else h ??= this.h[i];
    }
    h ??= 0;
    if (i >= 0 && Math.abs(f.t - this.t[i]) <= EPS) {
      this.x[i] = f.x;
      this.y[i] = f.y;
      this.z[i] = f.z ?? 0;
      this.h[i] = h;
      this.s[i] = f.s;
      this.seg[i] = f.seg;
      this.job[i] = f.job;
      this.carry[i] = f.carry ?? -1;
      return;
    }
    this.t.push(f.t);
    this.x.push(f.x);
    this.y.push(f.y);
    this.z.push(f.z ?? 0);
    this.h.push(h);
    this.s.push(f.s);
    this.seg.push(f.seg);
    this.job.push(f.job);
    this.carry.push(f.carry ?? -1);
  }

  /** Freeze into typed arrays, cutting at the horizon; a job segment cut there is marked Truncated. */
  toTrack(horizonEnd: number): Track {
    const k = upperBound(this.t, horizonEnd);
    if (k < this.n) {
      const last = k - 1;
      const cutSeg = last >= 0 && this.job[last] >= 1 ? SegKind.Truncated : ((last >= 0 ? this.seg[last] : SegKind.Hold) as SegKind);
      const state = (last >= 0 ? this.s[last] : ActorState.Off) as ActorState;
      const job = last >= 0 ? this.job[last] : SYNTH_JOB.none;
      const carry = last >= 0 ? this.carry[last] : -1;
      const p = this.cutAt(horizonEnd);
      this.push({ t: horizonEnd, x: p.x, y: p.y, z: p.z, h: p.h, s: state, seg: cutSeg, job, carry });
    }
    const n = this.n;
    return {
      entity: this.entity,
      t: Float64Array.from(this.t),
      x: Float32Array.from(this.x),
      y: Float32Array.from(this.y),
      z: Float32Array.from(this.z),
      h: Float32Array.from(this.h),
      s: Uint8Array.from(this.s),
      seg: Uint8Array.from(this.seg),
      job: Int32Array.from(this.job),
      carry: Int32Array.from(this.carry.length === n ? this.carry : this.carry.slice(0, n)),
    };
  }
}

// ---------------------------------------------------------------------------
// CSR timeline builders
// ---------------------------------------------------------------------------

interface CsrRow {
  t: number;
  v: number;
  ev: number;
}

class CsrBuilder {
  readonly items: CsrRow[][];
  constructor(n: number, initial: (i: number) => number) {
    this.items = Array.from({ length: n }, (_, i) => [{ t: 0, v: initial(i), ev: -1 }]);
  }
  get(i: number): number {
    const rows = this.items[i];
    return rows[rows.length - 1].v;
  }
  set(i: number, t: number, v: number, ev: number): void {
    const rows = this.items[i];
    if (!rows) return;
    const last = rows[rows.length - 1];
    if (last.v === v) return;
    if (Math.abs(last.t - t) <= EPS && rows.length > 1) {
      last.v = v;
      last.ev = ev;
      return;
    }
    if (Math.abs(last.t - t) <= EPS && rows.length === 1) {
      last.v = v;
      last.ev = ev;
      return;
    }
    rows.push({ t, v, ev });
  }
  build<V extends Uint8Array | Uint16Array | Int32Array | Uint32Array>(make: (n: number) => V, kind: DirtyKind, dirty: DirtyEntry[]): CsrTimeline<V> {
    const total = this.items.reduce((a, r) => a + r.length, 0);
    const offsets = new Int32Array(this.items.length + 1);
    const t = new Float64Array(total);
    const v = make(total);
    const ev = new Int32Array(total);
    let k = 0;
    this.items.forEach((rows, i) => {
      offsets[i] = k;
      rows.forEach((r, j) => {
        t[k] = r.t;
        v[k] = r.v;
        ev[k] = r.ev;
        if (j > 0) dirty.push({ t: r.t, kind, idx: i, row: k });
        k++;
      });
    });
    offsets[this.items.length] = k;
    return { offsets, t, v, ev };
  }
}

interface DirtyEntry {
  t: number;
  kind: DirtyKind;
  idx: number;
  row: number;
}

interface PalletRow {
  t: number;
  at: PalletAt;
  ref: number;
  slot: number;
  ev: number;
}

class PalletBuilder {
  readonly items: PalletRow[][] = [];
  add(): number {
    this.items.push([{ t: 0, at: PalletAt.Unborn, ref: -1, slot: -1, ev: -1 }]);
    return this.items.length - 1;
  }
  set(i: number, t: number, at: PalletAt, ref: number, slot: number, ev: number): void {
    const rows = this.items[i];
    if (!rows) return;
    const last = rows[rows.length - 1];
    if (last.at === at && last.ref === ref && last.slot === slot) return;
    if (Math.abs(last.t - t) <= EPS) {
      last.at = at;
      last.ref = ref;
      last.slot = slot;
      last.ev = ev;
      return;
    }
    rows.push({ t, at, ref, slot, ev });
  }
  current(i: number): PalletRow {
    const rows = this.items[i];
    return rows[rows.length - 1];
  }
  build(dirty: DirtyEntry[]): PalletTimeline {
    const total = this.items.reduce((a, r) => a + r.length, 0);
    const offsets = new Int32Array(this.items.length + 1);
    const t = new Float64Array(total);
    const at = new Uint8Array(total);
    const ref = new Int32Array(total);
    const slot = new Int32Array(total);
    const ev = new Int32Array(total);
    let k = 0;
    this.items.forEach((rows, i) => {
      offsets[i] = k;
      rows.forEach((r, j) => {
        t[k] = r.t;
        at[k] = r.at;
        ref[k] = r.ref;
        slot[k] = r.slot;
        ev[k] = r.ev;
        if (j > 0) dirty.push({ t: r.t, kind: DirtyKind.Pallet, idx: i, row: k });
        k++;
      });
    });
    offsets[this.items.length] = k;
    return { offsets, t, at, ref, slot, ev };
  }
}

// ---------------------------------------------------------------------------
// Route layout: a path with stops laid into a time window on one or more tracks
// ---------------------------------------------------------------------------

interface Sink {
  tb: TrackBuilder;
  moveState: ActorState;
  stopState: ActorState;
  moveSeg: SegKind;
  /** Segment kind while carrying (DriveLoaded / WalkCart); moveSeg otherwise. */
  loadedSeg: SegKind;
  stopSeg: SegKind;
  /** Raise the forks to the stop's level. */
  forks: boolean;
  /** Pallet entity carried on the leg that starts at vertex i, -1 none. */
  carry: (vertex: number) => number;
}

interface RouteTimes {
  end: number;
  /** Per path stop (same order): arrive and leave. */
  stops: Array<{ arrive: number; leave: number }>;
  /** Arrival time at each vertex. */
  vertex: number[];
}

/**
 * Lay a path onto the sinks from t0: legs at feet / (moveMin per foot), stops
 * sharing stopMin in proportion to their handling minutes (all of it at the
 * end when there are none). The last frame lands exactly at t0 + moveMin +
 * stopMin.
 */
function layoutRoute(sinks: Sink[], path: Path, t0: number, moveMin: number, stopMin: number, job: number, heights: (level: number | undefined, loc: string | undefined) => number): RouteTimes {
  const pts = path.pts;
  const end = t0 + moveMin + stopMin;
  const times: RouteTimes = { end, stops: [], vertex: [] };
  if (pts.length === 0) return times;
  const feet = path.feet;
  const perFoot = feet > 0 ? moveMin / feet : 0;
  const stopAt = new Map<number, { minutes: number; level?: number; loc?: string; k: number[] }>();
  path.stops.forEach((s, k) => {
    const cur = stopAt.get(s.i);
    if (cur) {
      cur.minutes += s.minutes;
      cur.k.push(k);
      if (s.level !== undefined) cur.level = s.level;
      if (s.loc) cur.loc = s.loc;
    } else stopAt.set(s.i, { minutes: s.minutes, level: s.level, loc: s.loc, k: [k] });
  });
  const totalW = [...stopAt.values()].reduce((a, s) => a + s.minutes, 0);
  const lastVertex = pts.length - 1;
  let t = t0;
  let remainingStop = stopMin;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    const stop = stopAt.get(i);
    const arrive = Math.min(end, t);
    times.vertex.push(arrive);
    let leave = arrive;
    if (stop) {
      const share = totalW > 0 ? (stopMin * stop.minutes) / totalW : i === lastVertex ? remainingStop : 0;
      const dur = Math.min(remainingStop, share);
      remainingStop -= dur;
      leave = Math.min(end, arrive + dur);
      for (const s of sinks) {
        const z = s.forks ? heights(stop.level, stop.loc) : 0;
        const carry = Math.max(-1, s.carry(i));
        s.tb.push({ t: arrive, x, y, s: s.stopState, seg: s.stopSeg, job, carry });
        if (z > 0 && dur > 0.02) s.tb.push({ t: arrive + dur / 2, x, y, z, s: s.stopState, seg: s.stopSeg, job, carry });
      }
      for (const k of stop.k) times.stops[k] = { arrive, leave };
    }
    if (i < lastVertex) {
      for (const s of sinks) {
        // -1 empty-handed, -2 loaded with nothing to point at (a replenishment pallet), else the pallet entity.
        const carry = s.carry(i);
        s.tb.push({ t: leave, x, y, s: s.moveState, seg: carry !== -1 ? s.loadedSeg : s.moveSeg, job, carry: Math.max(-1, carry) });
      }
      const legFeet = Math.abs(pts[i + 1][0] - x) + Math.abs(pts[i + 1][1] - y);
      t = leave + legFeet * perFoot;
    } else {
      // Whatever stop time is left (rounding, or no stops at all) is a hold at the end.
      for (const s of sinks) s.tb.push({ t: end, x, y, s: s.stopState, seg: s.stopSeg, job, carry: Math.max(-1, s.carry(i)) });
    }
  }
  times.stops = path.stops.map((_, k) => times.stops[k] ?? { arrive: end, leave: end });
  return times;
}

// ---------------------------------------------------------------------------
// Runtime records
// ---------------------------------------------------------------------------

interface Actor {
  id: string;
  entity: number;
  tb: TrackBuilder;
  prod: number;
  present: boolean;
  shiftEnd: number;
  home: Pt;
  lastForklift: number;
  lastJack: number;
  lastStation: number;
}

interface Vehicle {
  kind: "forklift" | "jack";
  index: number;
  entity: number;
  tb: TrackBuilder;
  park: Pt;
}

interface JobRun {
  row: JobRow;
  actor: Actor;
  vehicle: Vehicle | null;
  station: number;
  laneDoor: number;
  laneSlot: number;
  pallet: number;
}

interface TruckIn {
  entity: number;
  tb: TrackBuilder;
  po: string;
  arriveT: number;
  pallets: number[];
  queuePos: number;
  door: number;
  docked: boolean;
  undocked: boolean;
}

interface TruckOut {
  entity: number;
  tb: TrackBuilder;
  order: string;
  door: number;
  startT: number;
  departAt: number;
  lateMin: number;
  loaded: boolean;
  departed: boolean;
}

interface OrderRec {
  store: string;
  storeName: string;
  departAt: number;
  pallets: number[];
  /** Staging lane as a layout.doors index, -1 until the first pallet is packed. */
  lane: number;
  laneList: number;
  slots: number[];
  door: number;
}

function pointPath(p: Pt, minutes: number): Path {
  return { pts: [[p[0], p[1]]], feet: 0, stops: [{ at: 0, i: 0, minutes }] };
}

function polyPath(pts: Pt[], stops: Array<{ i: number; minutes: number }>): Path {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) continue;
    out.push([p[0], p[1]]);
  }
  return { pts: out, feet: pathFeet(out), stops: stops.map((s) => ({ at: 0, i: s.i, minutes: s.minutes })) };
}

function dist(a: Pt, b: Pt): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

// ---------------------------------------------------------------------------
// compilePlayback
// ---------------------------------------------------------------------------

export function compilePlayback(input: CompileInput): Playback {
  const { events, layout, world, skus } = input;
  const useOffsets = input.opts?.offsets ?? true;
  const checkpointMin = input.opts?.checkpointMin ?? 60;
  const keepEvents = input.opts?.keepEvents ?? true;
  const init = events.find((e): e is TraceInit => e.k === "init");
  if (!init) throw new Error("compilePlayback: the event stream has no init event.");
  const horizonEnd = init.horizonEnd;
  const std: LaborStandards = init.std;
  const walkFpm = std.walkFtPerMin;
  const forkFpm = std.forkliftFtPerMin;

  // --- Static lookups ---
  const skuIdx = new Map(skus.map((s, i) => [s.id, i]));
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const locById = new Map<string, Location>();
  const pickIndex = new Map<string, number>();
  const reserveIndex = new Map<string, number>();
  layout.pick.forEach((l, i) => {
    locById.set(l.id, l);
    pickIndex.set(l.id, i);
  });
  layout.reserve.forEach((l, i) => {
    locById.set(l.id, l);
    reserveIndex.set(l.id, i);
  });
  const faceOfSku = new Map<string, number>();
  const faceSku = new Int32Array(layout.pick.length).fill(-1);
  for (const [sku, loc] of input.slotting) {
    const i = pickIndex.get(loc);
    const s = skuIdx.get(sku);
    if (i === undefined || s === undefined) continue;
    faceOfSku.set(sku, i);
    faceSku[i] = s;
  }
  const runOf = (loc: Location) => {
    const aisle = (loc.zone === "pick" ? layout.pickAisles : layout.reserveAisles)[loc.aisle];
    return loc.side === "L" ? aisle?.left : aisle?.right;
  };
  const heightOf = (level: number | undefined, locId: string | undefined): number => {
    if (level === undefined || !locId) return 0;
    const loc = locById.get(locId);
    const run = loc ? runOf(loc) : null;
    const hs = run ? world.levelHeights[run.id] : undefined;
    return hs?.[level - 1] ?? 0;
  };
  const palletsOf = (sku: string, inners: number): number => {
    const s = skuById.get(sku);
    const per = s ? Math.max(1, s.casesPerPallet * s.innersPerCase) : 1;
    return Math.max(0, Math.ceil(inners / per));
  };
  // Pallet colour index: traditional 0, then the specialty categories in the order they first appear in skus (apply.ts numbers reserve pallets the same way).
  const categories = ["traditional"];
  for (const s of skus) if (!categories.includes(s.category)) categories.push(s.category);
  const roles = [...new Set(init.workers.map((w) => w.role))];
  const inFrames = world.frames.filter((f) => f.kind === "inbound");
  const outFrames = world.frames.filter((f) => f.kind === "outbound");
  const doorListIndex = (kind: "inbound" | "outbound", doorIdx: number) => (kind === "inbound" ? inFrames : outFrames).findIndex((f) => f.index === doorIdx);

  // --- Entities and tracks ---
  const entities: EntityDef[] = [];
  const builders: Array<TrackBuilder | null> = [];
  const addEntity = (def: EntityDef, track: boolean): number => {
    entities.push(def);
    builders.push(track ? new TrackBuilder(entities.length - 1) : null);
    return entities.length - 1;
  };
  const pallets = new PalletBuilder();
  const palletOrdinal = new Map<number, number>();
  const addPallet = (def: EntityDef): number => {
    const e = addEntity(def, false);
    palletOrdinal.set(e, pallets.add());
    return e;
  };
  const setPallet = (entity: number, t: number, at: PalletAt, ref: number, slot: number, ev: number) => {
    const o = palletOrdinal.get(entity);
    if (o !== undefined) pallets.set(o, t, at, ref, slot, ev);
  };

  const actors = new Map<string, Actor>();
  for (const w of init.workers) {
    const entity = addEntity(
      { kind: "worker", id: w.id, label: w.id, colorIdx: roles.indexOf(w.role), meta: { role: w.role, type: w.type, skills: w.skills.join(", "), productivity: w.productivity, hourlyRate: w.hourlyRate } },
      true
    );
    const tb = builders[entity]!;
    tb.push({ t: 0, x: world.entrance[0], y: world.entrance[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.none });
    actors.set(w.id, { id: w.id, entity, tb, prod: w.productivity, present: false, shiftEnd: 0, home: world.homes.pick, lastForklift: -1, lastJack: -1, lastStation: -1 });
  }
  const vehicles = { forklift: new Map<number, Vehicle>(), jack: new Map<number, Vehicle>() };
  const getVehicle = (kind: "forklift" | "jack", index: number): Vehicle => {
    const map = vehicles[kind];
    const hit = map.get(index);
    if (hit) return hit;
    const park = parkSpot(world, kind, index);
    const id = `${kind === "forklift" ? "F" : "J"}${index}`;
    const entity = addEntity({ kind, id, label: kind === "forklift" ? `Forklift ${index + 1}` : `Pallet jack ${index + 1}`, colorIdx: 0, meta: { index } }, true);
    const tb = builders[entity]!;
    tb.push({ t: 0, x: park[0], y: park[1], s: ActorState.Idle, seg: SegKind.Hold, job: SYNTH_JOB.none });
    const v: Vehicle = { kind, index, entity, tb, park };
    map.set(index, v);
    return v;
  };
  for (let i = 0; i < init.forklifts; i++) getVehicle("forklift", i);
  for (let i = 0; i < init.palletJacks; i++) getVehicle("jack", i);

  // --- Free lists ---
  const forklifts = new FreeList(init.forklifts);
  const jacks = new FreeList(init.palletJacks);
  const inDoors = new FreeList(inFrames.length);
  const outDoors = new FreeList(outFrames.length);
  const stationsFree = new FreeList(world.stations.length);
  const laneSpots = world.frames.map(() => new FreeList(LANE_SLOTS));
  const stagingLanes = new FreeList(outFrames.length);

  // --- Timelines ---
  const initFace = new Map(init.face);
  const initReserve = new Map(init.reserve);
  const faces = new CsrBuilder(layout.pick.length, (i) => (faceSku[i] >= 0 ? (initFace.get(skus[faceSku[i]].id) ?? 0) : 0));
  const faceHot = new CsrBuilder(layout.pick.length, () => 0);
  const reserveSlots = new CsrBuilder(layout.reserve.length, () => 0);
  const reserveSku = new CsrBuilder(layout.reserve.length, () => -1);
  const reserveInners = new CsrBuilder(skus.length, (i) => initReserve.get(skus[i].id) ?? 0);
  const doors = new CsrBuilder(layout.doors.length, () => -1);
  const laneSlots = new CsrBuilder(layout.doors.length * LANE_SLOTS, () => -1);
  const stations = new CsrBuilder(world.stations.length, () => -1);
  const homes: Array<[number, number]> = [];
  for (const [sku, loc] of init.reserveLoc) {
    const s = skuIdx.get(sku);
    const r = reserveIndex.get(loc);
    if (s !== undefined && r !== undefined) homes.push([s, r]);
  }
  const allocator = new ReserveAllocator(layout.reserve, homes);
  const applyReserve = (sku: string, inners: number, t: number, ev: number) => {
    const s = skuIdx.get(sku);
    if (s === undefined) return;
    reserveInners.set(s, t, inners, ev);
    for (const c of allocator.set(s, palletsOf(sku, inners))) {
      reserveSlots.set(c.pos, t, c.slots, ev);
      reserveSku.set(c.pos, t, c.sku, ev);
    }
  };
  for (const [sku, inners] of init.reserve) applyReserve(sku, inners, 0, -1);

  // --- Jobs, trucks, orders ---
  const jobs: JobRow[] = [];
  const running = new Map<number, JobRun>();
  const trucksIn = new Map<string, TruckIn>();
  const waiting: TruckIn[] = [];
  const etas = new Map<string, number>();
  const trucksOut = new Map<string, TruckOut>();
  const orders = new Map<string, OrderRec>();
  const palletSpot = new Map<number, { door: number; slot: number }>();
  const orderRec = (id: string): OrderRec => {
    let o = orders.get(id);
    if (!o) {
      o = { store: "", storeName: "", departAt: 0, pallets: [], lane: -1, laneList: -1, slots: [], door: -1 };
      orders.set(id, o);
    }
    return o;
  };
  const orderPallet = (o: OrderRec, id: string, k: number): number => {
    while (o.pallets.length <= k) {
      const idx = o.pallets.length;
      o.pallets.push(addPallet({ kind: "pallet", id: `${id}#${idx}`, label: `${o.storeName || id} pallet ${idx + 1}`, colorIdx: 0, meta: { order: id, index: idx, store: o.storeName } }));
    }
    return o.pallets[k];
  };

  // --- KPIs, bins, checkpoints, samples ---
  const kctx: KpiContext = kpiContext(init, events, skus);
  const state: RunningKpis = createState(init);
  const checkpoints: Checkpoint[] = [];
  let cpT = 0;
  const qCount = Math.max(1, Math.ceil(horizonEnd));
  const kCount = Math.max(1, Math.ceil(horizonEnd / 5));
  const queueBins: Bins = { binMin: 1, count: qCount, queues: new Uint16Array(qCount * state.queues.length), series: new Float32Array(0) };
  const kpiBins: Bins = { binMin: 5, count: kCount, queues: new Uint16Array(0), series: new Float32Array(kCount * KPI_SERIES.length) };
  let qBin = 0;
  let kBin = 0;
  const seriesValue = (k: (typeof KPI_SERIES)[number]): number => {
    switch (k) {
      case "innersPicked":
        return state.innersPicked;
      case "innersLoaded":
        return state.innersLoaded;
      case "trucksLoaded":
        return state.trucksLoaded;
      case "trucksLate":
        return state.trucksLate;
      case "lateMinTotal":
        return state.lateMinTotal;
      case "paidHours":
        return state.paidHours + state.overtimeHours;
      case "busyHours":
        return state.busyHours;
      case "overtimeHours":
        return state.overtimeHours;
      case "laborCost":
        return state.regularCost + state.overtimeCost;
      case "presentWorkers":
        return state.presentWorkers;
      case "busyWorkers":
        return state.busyWorkers;
      case "forkliftsBusy":
        return state.forkliftsBusy;
      case "palletsInFlight":
        return state.palletsInFlight;
      case "replenishments":
        return state.replenishments;
      case "hotReplenishments":
        return state.hotReplenishments;
      case "shortAtFace":
        return state.shortAtFace;
      case "cutInners":
        return state.cutInners;
      case "queueTotal":
        return state.queues.reduce((a, b) => a + b, 0);
    }
  };
  const fillBins = (upTo: number) => {
    while (qBin < qCount && (qBin + 1) * 1 < upTo) {
      state.queues.forEach((q, p) => (queueBins.queues[qBin * state.queues.length + p] = Math.min(65535, q)));
      qBin++;
    }
    while (kBin < kCount && (kBin + 1) * 5 < upTo) {
      KPI_SERIES.forEach((k, j) => (kpiBins.series[kBin * KPI_SERIES.length + j] = seriesValue(k)));
      kBin++;
    }
    while (cpT < upTo && cpT <= horizonEnd) {
      checkpoints.push({ t: cpT, kpis: cloneState(state) });
      cpT += checkpointMin;
    }
  };
  const samples = { dockToStock: [] as number[], doorWaits: [] as number[], cycleMin: [] as number[] };
  const ticker: TickerEvent[] = [];
  const tickerNames = { sku: (id: string) => skuById.get(id)?.name ?? id };
  const quiet: Array<[number, number]> = [];
  let onFloor = 0;
  let quietStart = 0;
  const floorChange = (t: number, delta: number) => {
    const before = onFloor;
    onFloor = Math.max(0, onFloor + delta);
    if (before === 0 && onFloor > 0) {
      if (t - quietStart >= QUIET_MIN) quiet.push([quietStart, t]);
    } else if (before > 0 && onFloor === 0) quietStart = t;
  };
  const onFloorIds = new Set<string>();

  // --- Synth movements ---
  const walkSink = (a: Actor, moveState: ActorState, seg: SegKind, restState: ActorState): Sink => ({ tb: a.tb, moveState, stopState: restState, moveSeg: seg, loadedSeg: seg, stopSeg: SegKind.Hold, forks: false, carry: () => -1 });
  const settle = (a: Actor, t: number): Pt => {
    const p = a.tb.cutAt(t);
    const s = a.present ? (t >= a.shiftEnd ? ActorState.Overtime : ActorState.Idle) : ActorState.Off;
    a.tb.push({ t, x: p.x, y: p.y, z: 0, h: p.h, s, seg: SegKind.Hold, job: SYNTH_JOB.none });
    return [p.x, p.y];
  };
  /** After a job: linger, then walk home at nominal speed; cut short by whatever comes next. */
  const idleAfter = (a: Actor, t: number) => {
    const pos = settle(a, t);
    if (!a.present) return;
    const rest = t >= a.shiftEnd ? ActorState.Overtime : ActorState.Idle;
    if (dist(pos, a.home) < 0.5) return;
    const path = transferPath(layout, world, pos, a.home);
    const start = t + WORKER_LINGER_MIN;
    a.tb.push({ t: start, x: pos[0], y: pos[1], s: rest, seg: SegKind.IdleReturn, job: SYNTH_JOB.none });
    layoutRoute([walkSink(a, ActorState.Walk, SegKind.IdleReturn, rest)], path, start, path.feet / (walkFpm * a.prod), 0, SYNTH_JOB.none, heightOf);
  };
  const vehicleIdle = (v: Vehicle, t: number) => {
    const p = v.tb.cutAt(t);
    v.tb.push({ t, x: p.x, y: p.y, z: 0, h: p.h, s: ActorState.Idle, seg: SegKind.Hold, job: SYNTH_JOB.none });
    if (dist([p.x, p.y], v.park) < 0.5) return;
    const path = transferPath(layout, world, [p.x, p.y], v.park);
    const start = t + VEHICLE_LINGER_MIN;
    v.tb.push({ t: start, x: p.x, y: p.y, s: ActorState.Idle, seg: SegKind.IdleReturn, job: SYNTH_JOB.none });
    const sink: Sink = { tb: v.tb, moveState: ActorState.Drive, stopState: ActorState.Idle, moveSeg: SegKind.IdleReturn, loadedSeg: SegKind.IdleReturn, stopSeg: SegKind.Hold, forks: false, carry: () => -1 };
    layoutRoute([sink], path, start, path.feet / (v.kind === "forklift" ? forkFpm : walkFpm), 0, SYNTH_JOB.none, heightOf);
  };

  // --- Trucks ---
  const spawnOf = (fromLeft: boolean): Pt => (fromLeft ? world.yard.spawnLeft : world.yard.spawnRight);
  /**
   * Spawn → road → (queue spot) → backed in at dockT. Spawn early enough to
   * be at the waiting spot by arriveT (and at eta − 3 when the ETA is known);
   * the wait absorbs the rest. dockT null: never docked, wait to the horizon.
   */
  const layoutApproach = (tb: TrackBuilder, frameIdx: number, fromLeft: boolean, earliest: number, arriveT: number, dockT: number | null, queueSpot: number) => {
    const frame = world.frames[frameIdx];
    const path = yardPath(world, frame, fromLeft, queueSpot);
    const holdV = path.queueVertex >= 0 ? path.queueVertex : path.roadVertex;
    // The road point the truck backs in from: after the queue spot when it waited.
    const backV = path.queueVertex >= 0 ? path.queueVertex + 1 : path.roadVertex;
    const cum: number[] = [0];
    for (let i = 1; i < path.pts.length; i++) cum.push(cum[i - 1] + dist(path.pts[i], path.pts[i - 1]));
    const toHold = cum[holdV] / YARD_FT_PER_MIN;
    const rest = (cum[backV] - cum[holdV]) / YARD_FT_PER_MIN;
    const backStart = dockT === null ? Infinity : dockT - BACK_IN_MIN;
    const leaveHold = Math.min(backStart - rest, Infinity);
    const dayStart = Math.floor(arriveT / 1440) * 1440;
    let spawnT = Math.min(earliest, arriveT - toHold, Number.isFinite(leaveHold) ? leaveHold - toHold : Infinity);
    spawnT = Math.max(0, dayStart, spawnT);
    const spawn = spawnOf(fromLeft);
    const dock = trailerPose(frame);
    tb.push({ t: 0, x: spawn[0], y: spawn[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.yard });
    let t = spawnT;
    let roadFrame = -1;
    let roadH = 0;
    for (let i = 0; i <= holdV; i++) {
      const p = path.pts[i];
      t = spawnT + cum[i] / YARD_FT_PER_MIN;
      tb.push({ t, x: p[0], y: p[1], s: ActorState.Drive, seg: SegKind.Yard, job: SYNTH_JOB.yard });
      if (i === path.roadVertex) {
        roadFrame = tb.n - 1;
        roadH = tb.heading();
      }
    }
    /**
     * From the road point on the truck reverses: it keeps the heading it
     * arrived with there, and every later frame (queue spot, back-in, docked)
     * points the nose away from the door. The track position is the trailer's
     * rear and the renderer draws the truck from it along the heading, so a
     * motion-derived heading would spin the truck and push its nose through
     * the dock wall.
     */
    const noseOut = () => {
      if (roadFrame < 0) return;
      tb.h[roadFrame] = roadH;
      for (let k = roadFrame + 1; k < tb.n; k++) tb.h[k] = dock.heading;
    };
    const holdP = path.pts[holdV];
    tb.push({ t, x: holdP[0], y: holdP[1], s: ActorState.Wait, seg: SegKind.Hold, job: SYNTH_JOB.yard });
    if (dockT === null) {
      noseOut();
      return;
    }
    let leave = Math.max(t, leaveHold);
    tb.push({ t: leave, x: holdP[0], y: holdP[1], s: ActorState.Drive, seg: SegKind.Yard, job: SYNTH_JOB.yard });
    for (let i = holdV + 1; i <= backV; i++) {
      const p = path.pts[i];
      leave = leave + dist(p, path.pts[i - 1]) / YARD_FT_PER_MIN;
      tb.push({ t: leave, x: p[0], y: p[1], s: ActorState.Drive, seg: SegKind.Yard, job: SYNTH_JOB.yard });
    }
    const road = path.pts[backV];
    const bs = Math.max(leave, backStart);
    tb.push({ t: bs, x: road[0], y: road[1], s: ActorState.Drive, seg: SegKind.Yard, job: SYNTH_JOB.yard });
    tb.push({ t: Math.max(dockT, bs + FADE_EPS_MIN), x: dock.pt[0], y: dock.pt[1], h: dock.heading, s: ActorState.Docked, seg: SegKind.Hold, job: SYNTH_JOB.yard });
    noseOut();
  };
  const layoutExit = (tb: TrackBuilder, frameIdx: number, leaveT: number, toRight: boolean) => {
    const frame = world.frames[frameIdx];
    const path = exitPath(world, frame, toRight);
    const p = tb.cutAt(leaveT);
    tb.push({ t: leaveT, x: p.x, y: p.y, h: p.h, s: ActorState.Depart, seg: SegKind.Yard, job: SYNTH_JOB.yard });
    let t = leaveT + BACK_IN_MIN;
    const road = path.pts[1];
    tb.push({ t, x: road[0], y: road[1], h: p.h, s: ActorState.Depart, seg: SegKind.Yard, job: SYNTH_JOB.yard });
    for (let i = 2; i < path.pts.length; i++) {
      t += dist(path.pts[i], path.pts[i - 1]) / YARD_FT_PER_MIN;
      tb.push({ t, x: path.pts[i][0], y: path.pts[i][1], s: ActorState.Depart, seg: SegKind.Yard, job: SYNTH_JOB.yard });
    }
    const last = path.pts[path.pts.length - 1];
    tb.push({ t: t + FADE_EPS_MIN, x: last[0], y: last[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.yard });
  };

  // --- Job start ---
  const laneCenter = (frameIdx: number, slot: number): { spot: Pt; center: Pt } => {
    const f = world.frames[frameIdx];
    const k = slot % LANE_SLOTS;
    const row = Math.floor(k / 2);
    const spot = world.lanes[frameIdx].slots[k];
    return { spot, center: [f.origin[0] + f.inward[0] * (8 + 5 * row), f.origin[1] + f.inward[1] * (8 + 5 * row)] };
  };
  const truckDoorFrame = (po: string): number => trucksIn.get(po)?.door ?? inFrames[0]?.index ?? 0;

  const startJob = (e: Extract<TraceEvent, { k: "jobStart" }>, ev: number) => {
    const row = jobs[e.job - 1];
    const a = actors.get(e.worker);
    if (!row || !a || row.startAt >= 0) return;
    const info = row.info;
    const t = e.t;
    const dur = e.dur;
    const prod = e.productivity;
    row.startAt = t;
    row.endAt = t + dur;
    row.truncated = row.endAt > horizonEnd;
    row.worker = e.worker;
    row.productivity = prod;
    row.dur = dur;
    row.waitMin = e.waitMin;
    row.equipWaitMin = e.equipWaitMin;
    const from = settle(a, t);
    a.present = true;

    let nominal = walkFpm;
    let H = 0;
    let route: Path;
    let vehicle: Vehicle | null = null;
    let carryOf: (v: number) => number = () => -1;
    let loadedOf: (v: number) => boolean = () => false;
    let station = -1;
    let laneDoor = -1;
    let laneSlot = -1;
    let pallet = -1;
    let loadedLegs: Array<{ pickupVertex: number; dropStop: number; pallet: number; door: number; slot: number }> = [];
    let dropStop = -1;
    let dropRef = -1;
    const workerRides = (): boolean => vehicle?.kind === "forklift";

    switch (info.kind) {
      case "unload": {
        const truck = trucksIn.get(info.po);
        const door = truckDoorFrame(info.po);
        vehicle = getVehicle("jack", jacks.acquire(a.lastJack >= 0 ? a.lastJack : undefined).index);
        a.lastJack = vehicle.index;
        laneDoor = door;
        laneSlot = laneSpots[door].acquire().index;
        pallet = truck?.pallets[info.pallet] ?? -1;
        const { spot, center } = laneCenter(door, laneSlot);
        const thr = thresholdPoint(world.frames[door]);
        H = std.unloadPerPallet + (info.pallet === 0 ? std.unloadPerTruck : 0);
        route = polyPath([thr, center, spot], [{ i: 0, minutes: H }]);
        const p = pallet;
        carryOf = () => p;
        row.palletJack = vehicle.index;
        row.inDoor = door;
        break;
      }
      case "receive": {
        const truck = trucksIn.get(info.po);
        pallet = truck?.pallets[info.pallet] ?? -1;
        const rec = palletSpot.get(pallet);
        const door = rec?.door ?? truckDoorFrame(info.po);
        const at = rec ? laneCenter(rec.door, rec.slot).spot : world.homes.receive;
        H = std.receivePerPallet + info.cases * std.receivePerCase + (info.importer ? info.cases * std.labelPerImportCase : 0);
        route = pointPath(at, H);
        row.inDoor = door;
        break;
      }
      case "putaway": {
        const truck = trucksIn.get(info.po);
        pallet = truck?.pallets[info.pallet] ?? -1;
        const rec = palletSpot.get(pallet);
        const door = rec?.door ?? truckDoorFrame(info.po);
        const origin = rec ? laneCenter(rec.door, rec.slot).spot : world.homes.receive;
        vehicle = getVehicle("forklift", forklifts.acquire(a.lastForklift >= 0 ? a.lastForklift : undefined).index);
        a.lastForklift = vehicle.index;
        nominal = forkFpm;
        const locs = info.items.map((it) => locById.get(it.loc)).filter((l): l is Location => !!l);
        H = std.putawayHandling * info.items.length + info.liftMin;
        route = dockToRackPath(
          layout,
          world,
          origin,
          locs.map((l) => ({ loc: l, minutes: std.putawayHandling + 2 * l.level * std.liftMinPerLevel }))
        );
        if (useOffsets) route = visualOffset(route, world, layout);
        const lastStop = route.stops.length - 1;
        const lastV = lastStop >= 0 ? route.stops[lastStop].i : 0;
        const p = pallet;
        carryOf = (v) => (v < lastV ? p : -1);
        dropStop = lastStop;
        const far = locs.reduce<Location | null>((best, l) => (!best || dockToRack({ x: origin[0], y: origin[1] }, l) > dockToRack({ x: origin[0], y: origin[1] }, best) ? l : best), null);
        dropRef = far ? (reserveIndex.get(far.id) ?? -1) : -1;
        if (rec) {
          laneSpots[rec.door].release(rec.slot);
          laneSlots.set(rec.door * LANE_SLOTS + (rec.slot % LANE_SLOTS), t, -1, ev);
          palletSpot.delete(pallet);
        }
        setPallet(pallet, t, PalletAt.Forklift, vehicle.entity, -1, ev);
        row.forklift = vehicle.index;
        row.inDoor = door;
        break;
      }
      case "replen": {
        const fromLoc = locById.get(info.from);
        const toLoc = locById.get(info.to);
        vehicle = getVehicle("forklift", forklifts.acquire(a.lastForklift >= 0 ? a.lastForklift : undefined).index);
        a.lastForklift = vehicle.index;
        nominal = forkFpm;
        const lift = fromLoc ? 2 * fromLoc.level * std.liftMinPerLevel : 0;
        H = std.replenHandling + lift;
        if (fromLoc && toLoc) {
          route = rackToRackPath(layout, fromLoc, toLoc, std.replenHandling / 2 + lift, std.replenHandling / 2);
          if (useOffsets) route = visualOffset(route, world, layout);
          const dropV = route.stops[1]?.i ?? route.pts.length;
          loadedOf = (v) => v >= route.stops[0].i && v < dropV;
        } else route = pointPath(a.home, H);
        row.forklift = vehicle.index;
        break;
      }
      case "pick": {
        const lines = info.lines.map((l) => ({ loc: locById.get(l.loc)!, inners: l.inners })).filter((l) => !!l.loc);
        H = info.handleMin;
        route = sShapePath(layout, lines, std);
        if (useOffsets) route = visualOffset(route, world, layout);
        loadedOf = () => true;
        break;
      }
      case "repick": {
        const loc = locById.get(info.loc);
        H = std.pickPerLine + std.pickPerInner * info.inners + (loc && !GOLDEN.has(loc.level) ? std.pickBendReachSec / 60 : 0);
        route = loc ? depotPath(layout, loc, std, info.inners) : pointPath([layout.depot.x, layout.depot.y], H);
        if (useOffsets) route = visualOffset(route, world, layout);
        break;
      }
      case "pack": {
        station = stationsFree.acquire(a.lastStation >= 0 ? a.lastStation : undefined).index;
        a.lastStation = station;
        const at = world.stations[station % world.stations.length];
        H = std.packPerPallet;
        route = pointPath(at, H);
        const o = orderRec(info.order);
        pallet = orderPallet(o, info.order, info.pallet);
        setPallet(pallet, t, PalletAt.PackStation, station % world.stations.length, -1, ev);
        if (station < world.stations.length) stations.set(station, t, e.job, ev);
        row.station = station;
        break;
      }
      case "load": {
        const o = orderRec(info.order);
        vehicle = getVehicle("jack", jacks.acquire(a.lastJack >= 0 ? a.lastJack : undefined).index);
        a.lastJack = vehicle.index;
        let doorIdx = o.door;
        if (e.outDoorAcquired || doorIdx < 0) {
          const preferList = o.lane >= 0 ? doorListIndex("outbound", o.lane) : undefined;
          const got = outDoors.acquire(preferList !== undefined && preferList >= 0 ? preferList : undefined);
          doorIdx = outFrames[got.index % Math.max(1, outFrames.length)]?.index ?? outFrames[0]?.index ?? 0;
          o.door = doorIdx;
        }
        const truckEntity = addEntity(
          { kind: "truckOut", id: info.order, label: `${info.store} truck`, colorIdx: 1, meta: { order: info.order, store: info.store, departAt: info.departAt, pallets: info.pallets } },
          true
        );
        const ttb = builders[truckEntity]!;
        layoutApproach(ttb, doorIdx, false, t - 2, t - 2, t, -1);
        ttb.push({ t, x: trailerPose(world.frames[doorIdx]).pt[0], y: trailerPose(world.frames[doorIdx]).pt[1], h: trailerPose(world.frames[doorIdx]).heading, s: ActorState.Loading, seg: SegKind.Hold, job: SYNTH_JOB.yard });
        trucksOut.set(info.order, { entity: truckEntity, tb: ttb, order: info.order, door: doorIdx, startT: t, departAt: info.departAt, lateMin: 0, loaded: false, departed: false });
        doors.set(doorIdx, t, truckEntity, ev);
        const thr = thresholdPoint(world.frames[doorIdx]);
        const pts: Pt[] = [];
        const stops: Array<{ i: number; minutes: number }> = [];
        const legs: typeof loadedLegs = [];
        const n = Math.max(1, info.pallets);
        const staged = o.lane >= 0 ? o.lane : doorIdx;
        for (let k = 0; k < n; k++) {
          const slot = o.slots[k] ?? k;
          const { spot, center } = laneCenter(staged, slot);
          const pickupVertex = pts.length;
          pts.push(spot, center);
          if (staged !== doorIdx) pts.push([thr[0], center[1]]);
          pts.push(thr);
          const dropVertex = pts.length - 1;
          stops.push({ i: dropVertex, minutes: std.loadPerPallet + (k === 0 ? std.loadPerTruck : 0) });
          const pal = orderPallet(o, info.order, k);
          legs.push({ pickupVertex, dropStop: stops.length - 1, pallet: pal, door: staged, slot });
          if (o.lane >= 0) laneSpots[staged].release(slot);
        }
        loadedLegs = legs;
        route = polyPath(pts, stops);
        carryOf = (v) => {
          for (const l of legs) if (v >= l.pickupVertex && v < route.stops[l.dropStop].i) return l.pallet;
          return -1;
        };
        H = std.loadPerTruck + info.pallets * std.loadPerPallet;
        row.palletJack = vehicle.index;
        row.outDoor = doorIdx;
        break;
      }
    }

    // The vehicle's planned idle return is cut here: its position at t is where the worker walks to.
    if (vehicle) {
      const p = vehicle.tb.cutAt(t);
      vehicle.tb.push({ t, x: p.x, y: p.y, z: 0, h: p.h, s: ActorState.Drive, seg: SegKind.Hold, job: e.job });
    }
    // Transfer legs: the worker walks to the vehicle (a) and the vehicle moves to the route origin (b), or the worker walks straight there.
    const origin = route.pts[0] ?? from;
    const pathA = transferPath(layout, world, from, vehicle ? vehicle.tb.pos() : origin);
    const pathB = vehicle ? transferPath(layout, world, vehicle.tb.pos(), origin) : null;
    const feetA = pathA.feet;
    const feetB = pathB?.feet ?? 0;
    const bNominal = workerRides() ? forkFpm : walkFpm;
    const transferEquiv = feetB * (nominal / bNominal) + feetA * (nominal / walkFpm);
    const fit: FitResult = fitJob({ dur, productivity: prod, nominal, handleMin: H, routeFeet: route.feet, transferFeet: transferEquiv });
    row.routeFeet = route.feet;
    row.transferFeet = feetA + feetB;
    row.visualFeet = fit.visualFeet;
    row.stopMin = fit.stopMin;
    row.moveMin = fit.moveMin;
    row.speedRatio = fit.speedRatio;
    row.fit = fit.fit;

    const ratio = fit.speedRatio;
    const workerSink: Sink = workerRides()
      ? { tb: a.tb, moveState: ActorState.Drive, stopState: ActorState.Lift, moveSeg: SegKind.Drive, loadedSeg: SegKind.DriveLoaded, stopSeg: SegKind.Lift, forks: false, carry: () => -1 }
      : { tb: a.tb, moveState: ActorState.Walk, stopState: ActorState.Work, moveSeg: SegKind.Walk, loadedSeg: SegKind.WalkCart, stopSeg: SegKind.Handle, forks: false, carry: () => -1 };
    const vehicleSink: Sink | null = vehicle
      ? vehicle.kind === "forklift"
        ? { tb: vehicle.tb, moveState: ActorState.Drive, stopState: ActorState.Lift, moveSeg: SegKind.Drive, loadedSeg: SegKind.DriveLoaded, stopSeg: SegKind.Lift, forks: true, carry: carryOf }
        : { tb: vehicle.tb, moveState: ActorState.Drive, stopState: ActorState.Work, moveSeg: SegKind.Walk, loadedSeg: SegKind.WalkCart, stopSeg: SegKind.Handle, forks: false, carry: carryOf }
      : null;
    const routeSinks: Sink[] = vehicleSink ? [{ ...workerSink, carry: vehicle?.kind === "jack" ? carryOf : () => -1 }, vehicleSink] : [workerSink];
    if (vehicle?.kind === "jack") routeSinks[0] = { ...routeSinks[0], loadedSeg: SegKind.WalkCart };
    const loadedSinks = routeSinks.map((s) => ({ ...s, carry: (v: number) => (loadedOf(v) ? -2 : s.carry(v)) }));

    let tRoute = t;
    let stopLeft = fit.stopMin;
    if (fit.fit === "fadeIn" || (fit.transferFeet === 0 && feetA + feetB > 0.5)) {
      // Teleport: Off at the old place, appear at the route origin a moment later.
      a.tb.push({ t, x: from[0], y: from[1], s: ActorState.Off, seg: SegKind.Hold, job: e.job });
      a.tb.push({ t: t + FADE_EPS_MIN, x: origin[0], y: origin[1], s: workerSink.moveState, seg: SegKind.Hold, job: e.job });
      if (vehicle) {
        vehicle.tb.push({ t, x: vehicle.tb.pos()[0], y: vehicle.tb.pos()[1], s: ActorState.Off, seg: SegKind.Hold, job: e.job });
        vehicle.tb.push({ t: t + FADE_EPS_MIN, x: origin[0], y: origin[1], s: ActorState.Drive, seg: SegKind.Hold, job: e.job });
      }
      tRoute = t + FADE_EPS_MIN;
      stopLeft -= Math.min(FADE_EPS_MIN, stopLeft);
    } else {
      if (feetA > 0) {
        const minA = feetA / (walkFpm * prod * ratio);
        layoutRoute([walkSink(a, ActorState.Walk, SegKind.Transfer, ActorState.Walk)], pathA, tRoute, minA, 0, e.job, heightOf);
        tRoute += minA;
      }
      if (vehicle && pathB && feetB > 0) {
        const minB = feetB / (bNominal * prod * ratio);
        const ride: Sink = workerRides()
          ? { tb: a.tb, moveState: ActorState.Drive, stopState: ActorState.Drive, moveSeg: SegKind.Drive, loadedSeg: SegKind.Drive, stopSeg: SegKind.Hold, forks: false, carry: () => -1 }
          : { tb: a.tb, moveState: ActorState.Walk, stopState: ActorState.Walk, moveSeg: SegKind.WalkCart, loadedSeg: SegKind.WalkCart, stopSeg: SegKind.Hold, forks: false, carry: () => -1 };
        const vs: Sink = { tb: vehicle.tb, moveState: ActorState.Drive, stopState: ActorState.Drive, moveSeg: SegKind.Transfer, loadedSeg: SegKind.Transfer, stopSeg: SegKind.Hold, forks: false, carry: () => -1 };
        layoutRoute([ride, vs], pathB, tRoute, minB, 0, e.job, heightOf);
        tRoute += minB;
      }
    }
    // The route itself, ending exactly at t + dur.
    const total = Math.max(0, t + dur - tRoute);
    const stopMin = Math.min(stopLeft, total);
    const moveMin = Math.max(0, total - stopMin);
    const times = layoutRoute(loadedSinks, route, tRoute, moveMin, stopMin, e.job, heightOf);

    // Pallet consequences of the stops.
    if (info.kind === "unload" && pallet >= 0 && vehicle) {
      setPallet(pallet, times.stops[0]?.leave ?? t, PalletAt.Jack, vehicle.entity, -1, ev);
    }
    if (info.kind === "putaway" && pallet >= 0 && dropStop >= 0) {
      const at = times.stops[dropStop]?.arrive ?? times.end;
      setPallet(pallet, at, PalletAt.Rack, dropRef, dropRef >= 0 ? allocator.slotsAt(dropRef) : -1, ev);
    }
    if (info.kind === "load" && vehicle) {
      const truck = trucksOut.get(info.order);
      for (const l of loadedLegs) {
        const pickupT = times.vertex[l.pickupVertex] ?? t;
        setPallet(l.pallet, pickupT, PalletAt.Jack, vehicle.entity, -1, ev);
        laneSlots.set(l.door * LANE_SLOTS + (l.slot % LANE_SLOTS), pickupT, -1, ev);
        const dropT = times.stops[l.dropStop]?.arrive ?? times.end;
        setPallet(l.pallet, dropT, PalletAt.TrailerOut, truck?.entity ?? -1, -1, ev);
      }
    }
    running.set(e.job, { row, actor: a, vehicle, station, laneDoor, laneSlot, pallet });
  };

  const endJob = (e: Extract<TraceEvent, { k: "jobEnd" }>, ev: number) => {
    const run = running.get(e.job);
    const a = actors.get(e.worker);
    if (!run) {
      if (a) idleAfter(a, e.t);
      return;
    }
    running.delete(e.job);
    const info = run.row.info;
    if (info.kind === "unload" && run.pallet >= 0) {
      palletSpot.set(run.pallet, { door: run.laneDoor, slot: run.laneSlot });
      setPallet(run.pallet, e.t, PalletAt.DockLane, run.laneDoor, run.laneSlot % LANE_SLOTS, ev);
      laneSlots.set(run.laneDoor * LANE_SLOTS + (run.laneSlot % LANE_SLOTS), e.t, run.pallet, ev);
    }
    if (run.station >= 0) {
      stationsFree.release(run.station);
      if (run.station < world.stations.length) stations.set(run.station, e.t, -1, ev);
    }
    if (run.vehicle) {
      (run.vehicle.kind === "forklift" ? forklifts : jacks).release(run.vehicle.index);
      vehicleIdle(run.vehicle, e.t);
    }
    idleAfter(run.actor, e.t);
  };

  // --- Main pass ---
  for (let ev = 0; ev < events.length; ev++) {
    const e = events[ev];
    fillBins(e.t);
    applyEvent(state, e, kctx);
    let tickerEntity = -1;
    let tickerPos: Pt | undefined;
    switch (e.k) {
      case "init":
        break;
      case "truckScheduled":
        etas.set(e.po, e.eta);
        break;
      case "truckArrive": {
        const entity = addEntity({ kind: "truckIn", id: e.po, label: `${e.supplier} truck`, colorIdx: 0, meta: { po: e.po, supplier: e.supplier, importer: e.importer, pallets: e.pallets.length, day: e.day } }, true);
        const cat = (sku: string) => categories.indexOf(skuById.get(sku)?.category ?? "");
        const palletEntities = e.pallets.map((p, i) =>
          addPallet({
            kind: "pallet",
            id: `${e.po}#${i}`,
            label: `${e.po} pallet ${i + 1}`,
            colorIdx: Math.max(0, cat(p.items[0]?.sku ?? "")),
            meta: { po: e.po, index: i, mixed: p.mixed, items: p.items.map((it) => `${it.sku}×${it.cases}`).join(", "), supplier: e.supplier, importer: e.importer },
          })
        );
        for (const p of palletEntities) setPallet(p, e.t, PalletAt.TrailerIn, entity, -1, ev);
        const truck: TruckIn = { entity, tb: builders[entity]!, po: e.po, arriveT: e.t, pallets: palletEntities, queuePos: waiting.length, door: -1, docked: false, undocked: false };
        trucksIn.set(e.po, truck);
        waiting.push(truck);
        tickerEntity = entity;
        break;
      }
      case "truckDock": {
        const truck = trucksIn.get(e.po);
        if (!truck) break;
        const preferList = e.engineDoor ? inFrames.findIndex((f) => f.door === e.engineDoor) : -1;
        const got = inDoors.acquire(preferList >= 0 ? preferList : undefined);
        const door = inFrames[got.index % Math.max(1, inFrames.length)]?.index ?? 0;
        truck.door = door;
        truck.docked = true;
        const wi = waiting.indexOf(truck);
        if (wi >= 0) waiting.splice(wi, 1);
        const waited = e.t - truck.arriveT > 0.01;
        const eta = etas.get(e.po);
        layoutApproach(truck.tb, door, true, eta !== undefined ? eta - 3 : truck.arriveT - 3, truck.arriveT, e.t, waited ? truck.queuePos : -1);
        doors.set(door, e.t, truck.entity, ev);
        samples.doorWaits.push(e.waitMin);
        tickerEntity = truck.entity;
        tickerPos = world.frames[door].origin;
        break;
      }
      case "truckUndock": {
        const truck = trucksIn.get(e.po);
        if (!truck || !truck.docked) break;
        truck.undocked = true;
        const li = doorListIndex("inbound", truck.door);
        if (li >= 0) inDoors.release(li);
        doors.set(truck.door, e.t, -1, ev);
        layoutExit(truck.tb, truck.door, e.t + UNDOCK_LINGER_MIN, true);
        tickerEntity = truck.entity;
        break;
      }
      case "jobQueued": {
        const engineFeet = e.info.kind === "pick" || e.info.kind === "repick" ? e.info.feet : e.info.kind === "replen" ? 2 * e.info.feet : e.info.kind === "putaway" ? 2 * e.info.farFt : 0;
        while (jobs.length < e.job - 1) jobs.push(placeholderJob(jobs.length + 1));
        jobs[e.job - 1] = {
          id: e.job,
          process: e.process,
          info: e.info,
          priority: e.priority,
          queuedAt: e.t,
          startAt: -1,
          endAt: -1,
          truncated: false,
          worker: "",
          productivity: 0,
          dur: 0,
          waitMin: 0,
          equipWaitMin: 0,
          forklift: -1,
          palletJack: -1,
          inDoor: -1,
          outDoor: -1,
          station: -1,
          engineFeet,
          routeFeet: 0,
          transferFeet: 0,
          visualFeet: 0,
          stopMin: 0,
          moveMin: 0,
          speedRatio: 1,
          fit: "stationary",
          ev,
        };
        if (e.info.kind === "replen" && e.info.hot) {
          const f = faceOfSku.get(e.info.sku);
          if (f !== undefined) faceHot.set(f, e.t, 1, ev);
        }
        break;
      }
      case "jobStart":
        startJob(e, ev);
        break;
      case "jobEnd":
        endJob(e, ev);
        break;
      case "putaway": {
        const truck = trucksIn.get(e.po);
        const p = truck?.pallets[e.pallet];
        if (p !== undefined) setPallet(p, e.t, PalletAt.Gone, -1, -1, ev);
        samples.dockToStock.push(e.dockToStockMin);
        break;
      }
      case "face": {
        const f = faceOfSku.get(e.sku);
        if (f !== undefined) {
          faces.set(f, e.t, Math.max(0, Math.min(65535, e.face)), ev);
          if (e.reason === "replen") faceHot.set(f, e.t, 0, ev);
        }
        applyReserve(e.sku, e.reserve, e.t, ev);
        break;
      }
      case "short":
      case "shortShip": {
        const loc = faceOfSku.get(e.sku);
        if (loc !== undefined) tickerPos = [layout.pick[loc].x, layout.pick[loc].y];
        break;
      }
      case "orderRelease": {
        const o = orderRec(e.order);
        o.store = e.store;
        o.storeName = e.storeName;
        o.departAt = e.departAt;
        break;
      }
      case "palletPacked": {
        const o = orderRec(e.order);
        const pal = orderPallet(o, e.order, e.index);
        if (o.lane < 0) {
          const got = stagingLanes.acquire();
          o.laneList = got.index;
          o.lane = outFrames[got.index % Math.max(1, outFrames.length)]?.index ?? outFrames[0]?.index ?? 0;
        }
        while (o.slots.length <= e.index) o.slots.push(laneSpots[o.lane].acquire().index);
        const slot = o.slots[e.index];
        setPallet(pal, e.t, PalletAt.StagingLane, o.lane, slot % LANE_SLOTS, ev);
        laneSlots.set(o.lane * LANE_SLOTS + (slot % LANE_SLOTS), e.t, pal, ev);
        break;
      }
      case "truckLoaded": {
        const truck = trucksOut.get(e.order);
        samples.cycleMin.push(e.cycleFloorMin);
        if (truck) {
          truck.loaded = true;
          truck.lateMin = e.lateMin;
          tickerEntity = truck.entity;
          tickerPos = world.frames[truck.door].origin;
        }
        break;
      }
      case "truckDepart": {
        const truck = trucksOut.get(e.order);
        const o = orders.get(e.order);
        if (!truck) break;
        truck.departed = true;
        const dock = trailerPose(world.frames[truck.door]);
        if (e.t > truck.departAt + EPS) {
          const lateFrom = Math.max(truck.startT, truck.departAt);
          truck.tb.push({ t: lateFrom, x: dock.pt[0], y: dock.pt[1], h: dock.heading, s: ActorState.Late, seg: SegKind.Hold, job: SYNTH_JOB.yard });
        }
        layoutExit(truck.tb, truck.door, e.t, true);
        const li = doorListIndex("outbound", truck.door);
        if (li >= 0) outDoors.release(li);
        doors.set(truck.door, e.t, -1, ev);
        if (o && o.laneList >= 0) stagingLanes.release(o.laneList);
        for (const p of o?.pallets ?? []) setPallet(p, e.t, PalletAt.Gone, -1, -1, ev);
        tickerEntity = truck.entity;
        break;
      }
      case "worker": {
        const a = actors.get(e.id);
        if (!a) break;
        tickerEntity = a.entity;
        switch (e.state) {
          case "in": {
            a.present = true;
            a.shiftEnd = e.shiftEnd ?? e.t + 510;
            a.home = world.homes[(e.primary ?? "pick") as Skill] ?? world.homes.pick;
            a.tb.cutAt(e.t);
            const ent = world.entrance;
            a.tb.push({ t: e.t, x: ent[0], y: ent[1], s: ActorState.Indirect, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            const path = transferPath(layout, world, ent, a.home);
            const walkMin = path.feet / (walkFpm * a.prod);
            const indirect = e.indirectMin ?? 0;
            const start = Math.max(e.t, e.t + indirect - walkMin);
            a.tb.push({ t: start, x: ent[0], y: ent[1], s: ActorState.Indirect, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
            layoutRoute([walkSink(a, ActorState.Indirect, SegKind.IdleReturn, ActorState.Idle)], path, start, walkMin, 0, SYNTH_JOB.shift, heightOf);
            if (indirect <= 0) {
              onFloorIds.add(e.id);
              floorChange(e.t, 1);
            }
            break;
          }
          case "absent": {
            const shift = init.shifts.find((s) => s.id === e.shift);
            const end = shift ? e.t + shiftPaidHours(shift.start, shift.end) * 60 : e.t + 510;
            const ent = world.entrance;
            a.tb.cutAt(e.t);
            a.tb.push({ t: e.t, x: ent[0], y: ent[1], s: ActorState.Absent, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            a.tb.push({ t: end, x: ent[0], y: ent[1], s: ActorState.Off, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            break;
          }
          case "indirectEnd":
            if (!onFloorIds.has(e.id)) {
              onFloorIds.add(e.id);
              floorChange(e.t, 1);
            }
            break;
          case "break": {
            const breakMin = e.breakMin ?? 0;
            const pos = settle(a, e.t);
            const there = transferPath(layout, world, pos, world.breakArea);
            const back = transferPath(layout, world, world.breakArea, a.home);
            const goMin = there.feet / (walkFpm * a.prod);
            const backMin = back.feet / (walkFpm * a.prod);
            if (goMin + backMin + 0.5 <= breakMin) {
              a.tb.push({ t: e.t, x: pos[0], y: pos[1], s: ActorState.Break, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
              layoutRoute([walkSink(a, ActorState.Break, SegKind.IdleReturn, ActorState.Break)], there, e.t, goMin, 0, SYNTH_JOB.shift, heightOf);
              const leave = e.t + breakMin - backMin;
              a.tb.push({ t: leave, x: world.breakArea[0], y: world.breakArea[1], s: ActorState.Break, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
              layoutRoute([walkSink(a, ActorState.Break, SegKind.IdleReturn, ActorState.Idle)], back, leave, backMin, 0, SYNTH_JOB.shift, heightOf);
            } else {
              a.tb.push({ t: e.t, x: pos[0], y: pos[1], s: ActorState.Break, seg: SegKind.Hold, job: SYNTH_JOB.shift });
              a.tb.push({ t: e.t + breakMin, x: pos[0], y: pos[1], s: ActorState.Idle, seg: SegKind.Hold, job: SYNTH_JOB.shift });
            }
            if (onFloorIds.delete(e.id)) floorChange(e.t, -1);
            break;
          }
          case "breakEnd":
            if (a.present && !onFloorIds.has(e.id)) {
              onFloorIds.add(e.id);
              floorChange(e.t, 1);
            }
            break;
          case "out": {
            const pos = settle(a, e.t);
            a.present = false;
            const path = transferPath(layout, world, pos, world.entrance);
            const walkMin = path.feet / (walkFpm * a.prod);
            a.tb.push({ t: e.t, x: pos[0], y: pos[1], s: ActorState.Walk, seg: SegKind.IdleReturn, job: SYNTH_JOB.shift });
            layoutRoute([walkSink(a, ActorState.Walk, SegKind.IdleReturn, ActorState.Off)], path, e.t, walkMin, 0, SYNTH_JOB.shift, heightOf);
            if (onFloorIds.delete(e.id)) floorChange(e.t, -1);
            break;
          }
        }
        break;
      }
      case "end":
        break;
      default:
        break;
    }
    const line = tickerLine(e, tickerNames);
    if (line) ticker.push({ t: e.t, kind: e.k, text: line.text, severity: line.severity, entity: tickerEntity, ev, x: tickerPos?.[0], y: tickerPos?.[1] });
  }
  fillBins(Infinity);
  if (onFloor === 0 && horizonEnd - quietStart >= QUIET_MIN) quiet.push([quietStart, horizonEnd]);

  // Trucks that never got a door wait in the yard to the horizon; loaded trailers still at the door go late at departAt.
  for (const truck of waiting) {
    const door = inFrames[truck.queuePos % Math.max(1, inFrames.length)]?.index ?? 0;
    const eta = etas.get(truck.po);
    layoutApproach(truck.tb, door, true, eta !== undefined ? eta - 3 : truck.arriveT - 3, truck.arriveT, null, truck.queuePos);
  }
  for (const truck of trucksOut.values()) {
    if (truck.departed) continue;
    if (truck.departAt < horizonEnd && truck.departAt > truck.startT) {
      const dock = trailerPose(world.frames[truck.door]);
      truck.tb.push({ t: truck.departAt, x: dock.pt[0], y: dock.pt[1], h: dock.heading, s: ActorState.Late, seg: SegKind.Hold, job: SYNTH_JOB.yard });
    }
  }

  // --- Freeze ---
  const dirtyEntries: DirtyEntry[] = [];
  const facesT = faces.build((n) => new Uint16Array(n), DirtyKind.Face, dirtyEntries);
  const faceHotT = faceHot.build((n) => new Uint8Array(n), DirtyKind.FaceHot, dirtyEntries);
  const reserveSlotsT = reserveSlots.build((n) => new Uint8Array(n), DirtyKind.ReserveSlots, dirtyEntries);
  const reserveSkuT = reserveSku.build((n) => new Int32Array(n), DirtyKind.ReserveSku, dirtyEntries);
  const reserveInnersT = reserveInners.build((n) => new Uint32Array(n), DirtyKind.ReserveInners, dirtyEntries);
  const doorsT = doors.build((n) => new Int32Array(n), DirtyKind.Door, dirtyEntries);
  const laneSlotsT = laneSlots.build((n) => new Int32Array(n), DirtyKind.LaneSlot, dirtyEntries);
  const stationsT = stations.build((n) => new Int32Array(n), DirtyKind.Station, dirtyEntries);
  const palletsT = pallets.build(dirtyEntries);
  dirtyEntries.sort((p, q) => p.t - q.t || p.kind - q.kind || p.idx - q.idx || p.row - q.row);
  const dirty: DirtyList = {
    t: Float64Array.from(dirtyEntries.map((d) => d.t)),
    kind: Uint8Array.from(dirtyEntries.map((d) => d.kind)),
    idx: Int32Array.from(dirtyEntries.map((d) => d.idx)),
    row: Int32Array.from(dirtyEntries.map((d) => d.row)),
  };
  const quietT: Interval = { t0: Float64Array.from(quiet.map((q) => q[0])), t1: Float64Array.from(quiet.map((q) => q[1])) };
  const tracks = builders.map((b) => (b ? b.toTrack(horizonEnd) : null));

  return {
    meta: { dc: init.dc, startWeek: init.startWeek, days: init.days, seed: init.seed, horizonEnd, layoutName: init.layoutName, compiler: COMPILER_VERSION, offsets: useOffsets, checkpointMin },
    entities,
    tracks,
    faces: facesT,
    faceHot: faceHotT,
    faceSku,
    reserveSlots: reserveSlotsT,
    reserveSku: reserveSkuT,
    reserveInners: reserveInnersT,
    doors: doorsT,
    laneSlots: laneSlotsT,
    stations: stationsT,
    pallets: palletsT,
    dirty,
    jobs,
    queueBins,
    kpiBins,
    checkpoints,
    samples: { dockToStock: Float32Array.from(samples.dockToStock), doorWaits: Float32Array.from(samples.doorWaits), cycleMin: Float32Array.from(samples.cycleMin) },
    ticker,
    quiet: quietT,
    events: keepEvents ? events : [],
    world,
  };
}

const GOLDEN = new Set([2, 3]);

function placeholderJob(id: number): JobRow {
  const info: JobInfo = { kind: "pack", order: "", pallet: 0, pallets: 0 };
  return { id, process: "pack", info, priority: 0, queuedAt: 0, startAt: -1, endAt: -1, truncated: false, worker: "", productivity: 0, dur: 0, waitMin: 0, equipWaitMin: 0, forklift: -1, palletJack: -1, inDoor: -1, outDoor: -1, station: -1, engineFeet: 0, routeFeet: 0, transferFeet: 0, visualFeet: 0, stopMin: 0, moveMin: 0, speedRatio: 1, fit: "stationary", ev: -1 };
}

/** Every typed array's buffer, listed once, for postMessage transfer. */
export function collectBuffers(pb: Playback): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const out: ArrayBuffer[] = [];
  const add = (a: ArrayBufferView | undefined) => {
    if (!a) return;
    const b = a.buffer as ArrayBuffer;
    if (seen.has(b)) return;
    seen.add(b);
    out.push(b);
  };
  for (const tr of pb.tracks) {
    if (!tr) continue;
    for (const a of [tr.t, tr.x, tr.y, tr.z, tr.h, tr.s, tr.seg, tr.job, tr.carry]) add(a);
  }
  for (const c of [pb.faces, pb.faceHot, pb.reserveSlots, pb.reserveSku, pb.reserveInners, pb.doors, pb.laneSlots, pb.stations]) for (const a of [c.offsets, c.t, c.v, c.ev]) add(a);
  add(pb.faceSku);
  for (const a of [pb.pallets.offsets, pb.pallets.t, pb.pallets.at, pb.pallets.ref, pb.pallets.slot, pb.pallets.ev]) add(a);
  for (const a of [pb.dirty.t, pb.dirty.kind, pb.dirty.idx, pb.dirty.row]) add(a);
  for (const a of [pb.queueBins.queues, pb.queueBins.series, pb.kpiBins.queues, pb.kpiBins.series]) add(a);
  for (const a of [pb.samples.dockToStock, pb.samples.doorWaits, pb.samples.cycleMin]) add(a);
  for (const a of [pb.quiet.t0, pb.quiet.t1]) add(a);
  return out;
}
