/**
 * Trace contract for the 3D twin. Written by the lead; every package compiles
 * against it and nobody else edits it.
 *
 * Two layers:
 *  1. TraceEvent: what lib/twin/operations.ts emits through a Tracer. Small,
 *     id-based (location and door ids, never objects), structured-clone safe.
 *     Every event is emitted inside a heap callback with the engine clock, so
 *     `t` is non-decreasing from `init` (t = 0) to `end` (t = horizonEnd).
 *     Emitting never draws from an RNG, never schedules a heap event and never
 *     mutates engine state; with NOOP_TRACER every hook is one null check and
 *     the argument object is never built (`trace?.({...})`).
 *  2. Playback: what lib/trace/compile.ts derives from the events, the Layout
 *     and the World. Typed-array keyframe tracks, CSR state timelines, a
 *     merged dirty list, ticker, bins and hourly KPI checkpoints. Everything
 *     the engine does not model (which forklift, which door, staging slots,
 *     pack stations, walking between jobs, the yard) is synthesized here as a
 *     deterministic function of the ordered event stream, so the same seed
 *     always plays back the same way and nothing feeds back into the engine.
 *
 * Time: engine minutes from 00:00 of horizon day 0, the Monday of startWeek.
 * Geometry: feet in the engine frame, x across the building, y from the dock
 * wall (y = 0) into the building; the yard is y < 0; z is height above the
 * floor. The renderer maps (x, y, z) to three.js (X = x, Y = z, Z = -y).
 *
 * The worker protocol between components/twin.worker.ts and the /twin page is
 * at the bottom. Every payload is plain data: no Maps, classes or functions.
 */

import type { LayoutSpec } from "../layout/spec";
import type { Layout } from "../twin/layout";
import type { OperationsResult } from "../twin/operations";
import type { OptimizeProgress, OptimizeResult, OptimizeSpec } from "../twin/optimize";
import type { Kpis } from "../twin/replicate";
import type { TwinScenario } from "../twin/twin";
import type { LaborStandards, Process, Skill } from "../twin/types";

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface Tracer {
  /** False for the no-op tracer: the engine skips building event objects. */
  readonly enabled: boolean;
  emit(e: TraceEvent): void;
}

/** The default: runOperations(ctx, opts) traces nothing and costs one null check per hook. */
export const NOOP_TRACER: Tracer = { enabled: false, emit() {} };

/** Collects events in memory. Subclass and override emit() to post progress. */
export class RecordingTracer implements Tracer {
  readonly enabled = true;
  readonly events: TraceEvent[] = [];
  emit(e: TraceEvent): void {
    this.events.push(e);
  }
}

// ---------------------------------------------------------------------------
// Engine events
// ---------------------------------------------------------------------------

/** Static facts about a worker, as the engine sees them (effective productivity and cost rate). */
export interface WorkerInfo {
  id: string;
  role: string;
  type: "full-time" | "part-time" | "temp";
  skills: Skill[];
  /** Effective factor on standards: roster productivity × 0.75 for temps (operations.ts `productivity`). */
  productivity: number;
  /** Rate used for cost: tempHourly for temps, else the roster rate. */
  hourlyRate: number;
  /** 1 for temps, else costs.overtimeMultiplier. */
  overtimeMultiplier: number;
}

export interface ShiftInfo {
  id: string;
  start: string;
  end: string;
  breakMin: number;
  indirectMin: number;
}

/**
 * What a job is, attached at each pushJob call site (data only). Locations and
 * doors are ids resolved against the same Layout. `engineDoor` is the inbound
 * door the engine measured putaway distance from (operations.ts:650), which is
 * not a stable slot; the compiler assigns the visual door.
 */
export type JobInfo =
  | { kind: "unload"; po: string; pallet: number; pallets: number; engineDoor: string | null; items: Array<{ sku: string; cases: number }> }
  | { kind: "receive"; po: string; pallet: number; engineDoor: string | null; cases: number; importer: boolean }
  | { kind: "putaway"; po: string; pallet: number; engineDoor: string | null; items: Array<{ sku: string; cases: number; loc: string }>; farFt: number; liftMin: number }
  | { kind: "replen"; sku: string; hot: boolean; from: string; to: string; feet: number }
  | { kind: "pick"; order: string; tour: number; tours: number; lines: Array<{ sku: string; inners: number; loc: string }>; feet: number; walkMin: number; handleMin: number; bends: number }
  | { kind: "repick"; order: string; sku: string; inners: number; loc: string; feet: number }
  | { kind: "pack"; order: string; pallet: number; pallets: number }
  | { kind: "load"; order: string; store: string; pallets: number; departAt: number };

export interface TraceInit {
  k: "init";
  t: 0;
  dc: string;
  startWeek: number;
  days: number;
  seed: number;
  horizonEnd: number;
  layoutName: string;
  forklifts: number;
  palletJacks: number;
  /** Door ids in layout.doors order, filtered by kind. */
  inDoors: string[];
  outDoors: string[];
  shifts: ShiftInfo[];
  operatingDays: number[];
  times: { orderRelease: string; truckDeparture: string; inboundWindow: [string, string] };
  /** The standards this run used (a scenario may override them); the compiler rebuilds each job's handling minutes from these. */
  std: LaborStandards;
  workers: WorkerInfo[];
  /** Scenario outages, so the playback can grey out idle units. */
  outages: {
    forklifts: Array<{ fromDay: number; toDay: number; count: number }>;
    inDoors: Array<{ fromDay: number; toDay: number; count: number }>;
    outDoors: Array<{ fromDay: number; toDay: number; count: number }>;
  };
  /** Face capacity in inners per SKU: (ctx.faces ?? site.pick.faceCases) × innersPerCase. */
  faceCap: Array<[sku: string, inners: number]>;
  /** Stock after the warm-up split (operations.ts:325-331). */
  face: Array<[sku: string, inners: number]>;
  reserve: Array<[sku: string, inners: number]>;
  /** The fixed reserve position per SKU, layout.reserve[catalogIndex % n] (operations.ts:333). */
  reserveLoc: Array<[sku: string, loc: string]>;
}

export type TraceEvent =
  | TraceInit
  | { k: "day"; t: number; day: number; weekday: number; calendarWeek: number; operating: boolean }
  /** A purchase order placed at the day's review (book.review, currently discarded by the engine). */
  | { k: "poPlaced"; t: number; po: string; supplier: string; placedDay: number; arriveDay: number; pallets: number; cases: number }
  /** The arrival time drawn for a PO due today; `eta` is the minute truckArrive will fire. */
  | { k: "truckScheduled"; t: number; po: string; supplier: string; importer: boolean; appointment: number; eta: number; pallets: number }
  | { k: "truckArrive"; t: number; po: string; supplier: string; importer: boolean; day: number; pallets: Array<{ items: Array<{ sku: string; cases: number }>; mixed: boolean }> }
  | { k: "truckDock"; t: number; po: string; engineDoor: string | null; waitMin: number }
  | { k: "truckUndock"; t: number; po: string }
  | { k: "jobQueued"; t: number; job: number; process: Process; priority: number; queueLen: number; info: JobInfo }
  | {
      k: "jobStart";
      t: number;
      job: number;
      worker: string;
      /** Engine duration: max(0.1, std / productivity). The job ends at t + dur unless the horizon ends first. */
      dur: number;
      waitMin: number;
      equipWaitMin: number;
      productivity: number;
      /** True when this start took an outbound door (operations.ts:760-763); a load job never re-acquires. */
      outDoorAcquired: boolean;
    }
  | { k: "jobEnd"; t: number; job: number; worker: string }
  /** A pallet put away: stock is now pickable. dockToStockMin is raw minutes since truckArrive. */
  | { k: "putaway"; t: number; job: number; po: string; pallet: number; items: Array<{ sku: string; inners: number; loc: string }>; dockToStockMin: number }
  /** Absolute face and reserve levels after a change; `delta` is the face change (0 for putaway, which changes reserve only). */
  | { k: "face"; t: number; sku: string; face: number; reserve: number; delta: number; reason: "pick" | "repick" | "replen" | "putaway"; order?: string; job: number }
  /** A tour or re-pick found the face short; hot = a replenishment can be requested (reserve > 0). */
  | { k: "short"; t: number; order: string; sku: string; inners: number; hot: boolean; job: number }
  /** Nothing left anywhere: the line ships short and the allocation is released. */
  | { k: "shortShip"; t: number; order: string; sku: string; inners: number; job: number }
  | {
      k: "orderRelease";
      t: number;
      order: string;
      store: string;
      storeName: string;
      day: number;
      departAt: number;
      lines: Array<{ sku: string; inners: number; cut: number }>;
      cube: number;
      inners: number;
      tours: number;
    }
  /** Every tour and re-pick done; pack jobs follow. */
  | { k: "orderPicked"; t: number; order: string; pallets: number; inners: number }
  /** Everything was cut: no pack, no load, no truck (operations.ts:541-544). */
  | { k: "orderCut"; t: number; order: string }
  | { k: "palletPacked"; t: number; order: string; index: number; left: number; job: number }
  | { k: "truckLoaded"; t: number; order: string; store: string; day: number; departAt: number; lateMin: number; pallets: number; inners: number; cycleFloorMin: number; job: number }
  /** The trailer pulls out and frees its door: max(loadedAt, departAt). */
  | { k: "truckDepart"; t: number; order: string }
  | {
      k: "worker";
      t: number;
      id: string;
      /** "overtime" is not an event: the compiler derives it from shiftEnd and "out". */
      state: "in" | "absent" | "indirectEnd" | "break" | "breakEnd" | "out";
      shift?: string;
      primary?: Skill;
      shiftStart?: number;
      shiftEnd?: number;
      breakAt?: number;
      breakMin?: number;
      indirectMin?: number;
      lastShift?: boolean;
      /** On "out": overtime minutes worked past shiftEnd (0 on a normal clock-out). */
      overtimeMin?: number;
    }
  /** One "down" per outage window (deduplicated in the engine), one "up" at its end. */
  | { k: "wms"; t: number; down: boolean; until?: number }
  | { k: "end"; t: number };

export type TraceEventKind = TraceEvent["k"];

// ---------------------------------------------------------------------------
// Synthesized world (data only; built once per layout by lib/trace/world.ts)
// ---------------------------------------------------------------------------

export type Pt = [x: number, y: number];

/** A dock door with its local frame: `inward` points into the building, `tangent` along the wall. */
export interface DoorFrame {
  door: string;
  kind: "inbound" | "outbound";
  /** Index in layout.doors. */
  index: number;
  origin: Pt;
  inward: Pt;
  tangent: Pt;
  widthFt: number;
}

/** Pallet spots behind a door: a dock lane (inbound) or a staging lane (outbound). */
export interface Lane {
  door: string;
  kind: "inbound" | "outbound";
  slots: Pt[];
}

export interface World {
  /** Outline bounding box: spec.widthFt × spec.depthFt. */
  bbox: { w: number; d: number };
  /** One per layout.doors, same order. */
  frames: DoorFrame[];
  /** One per layout.doors, same order. */
  lanes: Lane[];
  /** Pack stations, in front of the depot. */
  stations: Pt[];
  entrance: Pt;
  breakArea: Pt;
  parks: { forklifts: Pt[]; jacks: Pt[] };
  yard: {
    /** Trucks travel along y = roadY (negative: outside the dock wall). */
    roadY: number;
    /** Waiting spots per inbound door (outer array = layout.doors index of the inbound door). */
    queue: Record<number, Pt[]>;
    spawnLeft: Pt;
    spawnRight: Pt;
  };
  /** Rows the polylines are drawn on: just outside the rack ends, so a walker is never inside a rack. */
  corridors: { front: number; back: number; reserveFront: number; apron: number };
  /** Rack run id → base height (feet) of each level, index level − 1. Pick pitch 1.5 ft, reserve pitch 5 ft. */
  levelHeights: Record<string, number[]>;
  /** Where an idle worker walks to, by primary skill. */
  homes: Record<Skill, Pt>;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type EntityKind = "worker" | "forklift" | "jack" | "pallet" | "truckIn" | "truckOut";

export interface EntityDef {
  kind: EntityKind;
  /** Worker id, "F0", "J1", "PO-dc-east-12#3" (inbound pallet), "s2-d3#1" (outbound pallet), PO id or order id. */
  id: string;
  label: string;
  /** Palette index: role for workers, category for pallets, kind for trucks. */
  colorIdx: number;
  /** Static facts for the inspector: role, type, skills, supplier, importer, store, departAt, items, ... */
  meta: Record<string, string | number | boolean>;
}

export const ActorState = {
  Off: 0,
  Idle: 1,
  Walk: 2,
  Drive: 3,
  Work: 4,
  Lift: 5,
  Break: 6,
  Indirect: 7,
  Overtime: 8,
  Wait: 9,
  Docked: 10,
  Loading: 11,
  Late: 12,
  Depart: 13,
  Absent: 14,
} as const;
export type ActorState = (typeof ActorState)[keyof typeof ActorState];

/** What the segment starting at a keyframe is. Synth kinds are never charged to a job. */
export const SegKind = {
  Hold: 0,
  Walk: 1,
  WalkCart: 2,
  Drive: 3,
  DriveLoaded: 4,
  Handle: 5,
  Lift: 6,
  /** Walking from where the last job ended to where this one starts; fitted into the job (see JobRow.fit). */
  Transfer: 7,
  /** Synth: idle walk to the skill's home spot, or to and from the break area / entrance. */
  IdleReturn: 8,
  /** Synth: truck driving in the yard. */
  Yard: 9,
  /** The job was still running at horizonEnd: the segment is cut at the horizon. */
  Truncated: 10,
} as const;
export type SegKind = (typeof SegKind)[keyof typeof SegKind];

/** Job id tags for synth segments (Track.job). */
export const SYNTH_JOB = { none: -1, shift: -2, yard: -3 } as const;

/**
 * Keyframes of one moving entity (worker, forklift, jack, truck). Arrays are
 * parallel, `t` strictly increasing. Between keyframes position and heading
 * interpolate linearly; state, segment kind, job and carry hold from frame i
 * until frame i + 1. Pallets have no track: see PalletTimeline.
 */
export interface Track {
  entity: number;
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
  /** Fork or mast height for forklifts, 0 otherwise. */
  z: Float32Array;
  /** Heading, radians in the x/y plane (0 = +x). */
  h: Float32Array;
  /** ActorState. */
  s: Uint8Array;
  /** SegKind of the segment starting here. */
  seg: Uint8Array;
  /** Job id owning the segment, or a SYNTH_JOB tag. */
  job: Int32Array;
  /** Pallet entity carried during the segment, -1 none. Trailer contents are in PalletTimeline instead. */
  carry: Int32Array;
}

/**
 * Compressed-sparse-row step timeline for N items: item i's changes are rows
 * offsets[i] .. offsets[i + 1] − 1, sorted by t; the value holds until the
 * next row. Row 0 of every item is at t = 0 (the initial value).
 */
export interface CsrTimeline<V extends Uint8Array | Uint16Array | Int32Array | Uint32Array> {
  offsets: Int32Array;
  t: Float64Array;
  v: V;
  /** Index into Playback.events that caused the change, -1 for the initial row. */
  ev: Int32Array;
}

export const PalletAt = {
  Unborn: 0,
  TrailerIn: 1,
  DockLane: 2,
  Forklift: 3,
  Rack: 4,
  PackStation: 5,
  StagingLane: 6,
  Jack: 7,
  TrailerOut: 8,
  Gone: 9,
} as const;
export type PalletAt = (typeof PalletAt)[keyof typeof PalletAt];

/**
 * Where every pallet entity is over time (CSR by pallet entity order). `ref`
 * depends on `at`: TrailerIn/TrailerOut → truck entity; DockLane/StagingLane →
 * layout.doors index, slot = spot in that lane; Forklift/Jack → entity; Rack →
 * layout.reserve index, slot = stack index at that position; PackStation →
 * station index. Unborn/Gone: ref = -1.
 */
export interface PalletTimeline {
  offsets: Int32Array;
  t: Float64Array;
  at: Uint8Array;
  ref: Int32Array;
  slot: Int32Array;
  ev: Int32Array;
}

/** Which CSR timeline a dirty-list entry refers to. */
export const DirtyKind = {
  Face: 0,
  FaceHot: 1,
  ReserveSlots: 2,
  ReserveSku: 3,
  ReserveInners: 4,
  Door: 5,
  LaneSlot: 6,
  Station: 7,
  Pallet: 8,
} as const;
export type DirtyKind = (typeof DirtyKind)[keyof typeof DirtyKind];

/** Every state change of every CSR timeline, merged and sorted by t, so a frame applies exactly the changes it crossed. */
export interface DirtyList {
  t: Float64Array;
  kind: Uint8Array;
  /** Item index in that timeline. */
  idx: Int32Array;
  /** Row index in that timeline (read the new value there). */
  row: Int32Array;
}

/** How a job's animation was fitted into its engine duration. */
export type JobFit =
  /** No travel (receive, pack): the actor stands at the station for the whole duration. */
  | "stationary"
  /** Travel time = engine travel time, handling time = engine handling time: speedRatio 1 (offsets aside). */
  | "exact"
  /** A transfer leg was paid for by compressing handling; the actor still moves at engine speed. */
  | "borrowed"
  /** The transfer leg would have needed more than half the job: the actor fades in at the route origin instead. */
  | "fadeIn"
  /** Even the route alone needs more than half the job at engine speed (imports only): moves faster than the engine's speed, flagged in the inspector. */
  | "fast";

export interface JobRow {
  id: number;
  process: Process;
  info: JobInfo;
  priority: number;
  queuedAt: number;
  /** -1 when the job never started before the horizon. */
  startAt: number;
  /** startAt + dur, or -1; `truncated` when that is past the horizon. */
  endAt: number;
  truncated: boolean;
  /** Worker id or "" when never started. */
  worker: string;
  productivity: number;
  dur: number;
  waitMin: number;
  equipWaitMin: number;
  /** Assigned identities, -1 when not applicable. Doors and stations are indices into layout.doors / world.stations. */
  forklift: number;
  palletJack: number;
  inDoor: number;
  outDoor: number;
  station: number;
  /** Feet the engine charged (0 for receive/pack/unload/load). */
  engineFeet: number;
  /** Feet of the exact route polyline (equals engineFeet for tours, re-picks and replenishments). */
  routeFeet: number;
  transferFeet: number;
  /** Feet actually drawn: route with visual offsets plus the transfer leg (0 when fadeIn). */
  visualFeet: number;
  stopMin: number;
  moveMin: number;
  /** visualFeet / moveMin ÷ (nominal speed × productivity); 1 means the actor moves exactly as fast as the engine assumes. */
  speedRatio: number;
  fit: JobFit;
  /** Index of the jobQueued event in Playback.events. */
  ev: number;
}

/**
 * Every accumulator the tools' KPIs are built from, at the engine's own
 * accrual points: paid at clock-in, busy at job start, overtime at clock-out,
 * shipped (picked) at face consumption, loaded at load, cut at release.
 * lib/trace/kpis.ts reduces events into this and projects it to Kpis; at
 * horizonEnd the projection equals kpis(result) (tested).
 */
export interface RunningKpis {
  ordersReleased: number;
  /** Released with inners > 0 and not yet loaded. */
  openOrders: number;
  lines: number;
  innersOrdered: number;
  /** book.totals.shippedInners: consumed at pick time. */
  innersPicked: number;
  shippedDollars: number;
  cutInners: number;
  cutDollars: number;
  trucksLoaded: number;
  trucksLate: number;
  lateMinTotal: number;
  worstLateMin: number;
  /** Inners on loaded trucks (DayRecord.innersShipped semantics). */
  innersLoaded: number;
  outboundPallets: number;
  cycleMinSum: number;
  cycleCount: number;
  inboundTrucks: number;
  inboundPallets: number;
  palletsInFlight: number;
  /** Counts into Playback.samples.* (samples are appended in event order). */
  dockToStockN: number;
  doorWaitN: number;
  replenishments: number;
  hotReplenishments: number;
  shortAtFace: number;
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  absences: number;
  regularCost: number;
  overtimeCost: number;
  presentWorkers: number;
  busyWorkers: number;
  forkliftsBusy: number;
  jacksBusy: number;
  inDoorsBusy: number;
  outDoorsBusy: number;
  /** Busy forklift-minutes accrued up to lastT; add forkliftsBusy × (t − lastT) for a value at t. */
  forkliftBusyMin: number;
  lastT: number;
  /** Queue length per process, PROCESSES order. */
  queues: number[];
}

export interface Checkpoint {
  t: number;
  kpis: RunningKpis;
}

export interface TickerEvent {
  t: number;
  kind: TraceEventKind;
  text: string;
  /** 0 info, 1 notable, 2 problem (late truck, short face, WMS down, absence). */
  severity: 0 | 1 | 2;
  /** Entity to select on click, -1 none. */
  entity: number;
  /** Index into Playback.events. */
  ev: number;
  x?: number;
  y?: number;
}

export const KPI_SERIES = [
  "innersPicked",
  "innersLoaded",
  "trucksLoaded",
  "trucksLate",
  "lateMinTotal",
  "paidHours",
  "busyHours",
  "overtimeHours",
  "laborCost",
  "presentWorkers",
  "busyWorkers",
  "forkliftsBusy",
  "palletsInFlight",
  "replenishments",
  "hotReplenishments",
  "shortAtFace",
  "cutInners",
  "queueTotal",
] as const;
export type KpiSeries = (typeof KPI_SERIES)[number];

/** Fixed-width bins for plots; value = the running figure at the bin's end. */
export interface Bins {
  binMin: number;
  count: number;
  /** count × PROCESSES.length queue lengths (queue bins are 1-minute). */
  queues: Uint16Array;
  /** count × KPI_SERIES.length (KPI bins are 5-minute). */
  series: Float32Array;
}

export interface Interval {
  t0: Float64Array;
  t1: Float64Array;
}

export interface PlaybackMeta {
  dc: string;
  startWeek: number;
  days: number;
  seed: number;
  horizonEnd: number;
  layoutName: string;
  /** Version string of the compiler that produced this playback. */
  compiler: string;
  /** Whether cross-aisle legs were drawn on the corridor rows (visual offsets) or exactly on the engine's lines. */
  offsets: boolean;
  /** Checkpoint spacing in minutes. */
  checkpointMin: number;
}

export interface Playback {
  meta: PlaybackMeta;
  entities: EntityDef[];
  /** One per entity of kind worker, forklift, jack, truckIn, truckOut, in entity order; pallets have none. */
  tracks: Array<Track | null>;
  /** Per layout.pick index: inners on the face. */
  faces: CsrTimeline<Uint16Array>;
  /** Per layout.pick index: 1 while a hot replenishment for that face's SKU is pending. */
  faceHot: CsrTimeline<Uint8Array>;
  /** layout.pick index → sku index in WorldPayload.skus, -1 for an empty face (static). */
  faceSku: Int32Array;
  /** Per layout.reserve index: visual pallets stacked there (0 empty). */
  reserveSlots: CsrTimeline<Uint8Array>;
  /** Per layout.reserve index: sku index occupying it (home SKU, or the overflowing SKU), -1 empty. */
  reserveSku: CsrTimeline<Int32Array>;
  /** Per sku index: inners in reserve. */
  reserveInners: CsrTimeline<Uint32Array>;
  /** Per layout.doors index: truck entity at the door, -1 free, -2 outage. */
  doors: CsrTimeline<Int32Array>;
  /** Per (door index × LANE_SLOTS + slot): pallet entity in that spot, -1 free. */
  laneSlots: CsrTimeline<Int32Array>;
  /** Per station index: pack job id in progress, -1 idle. */
  stations: CsrTimeline<Int32Array>;
  pallets: PalletTimeline;
  dirty: DirtyList;
  /** Index = job id − 1. */
  jobs: JobRow[];
  queueBins: Bins;
  kpiBins: Bins;
  checkpoints: Checkpoint[];
  /** Raw samples in event order, for p90 and averages at any t (see RunningKpis.dockToStockN / doorWaitN, cycleCount). */
  samples: { dockToStock: Float32Array; doorWaits: Float32Array; cycleMin: Float32Array };
  ticker: TickerEvent[];
  /** Nobody on the floor (not present, or every present worker on break or indirect): skip-idle jumps over these. */
  quiet: Interval;
  /** The raw event stream; `ev` fields index into it. May be [] when the run was requested with keepEvents = false. */
  events: TraceEvent[];
  world: World;
}

/** Pallet spots per lane; laneSlots is indexed door × LANE_SLOTS + slot. */
export const LANE_SLOTS = 8;

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

export interface SkuInfo {
  id: string;
  name: string;
  category: string;
  supplier: string;
  innersPerCase: number;
  casesPerPallet: number;
  innerCubeFt: number;
  innerRetail: number;
}

export interface SupplierInfo {
  id: string;
  name: string;
  kind: "domestic" | "importer";
  leadDays: number;
  leadSdDays: number;
  orderDay: number;
}

export interface StoreInfo {
  id: string;
  name: string;
  type: "general" | "specialty";
  lon: number;
  lat: number;
  /** Weekday numbers (1 = Monday) the store's truck leaves. */
  deliveryDays: number[];
}

/** Everything the page needs besides the playback, built in the worker from the TwinContext (plain data only). */
export interface WorldPayload {
  /** The built layout: site, spec, locations, doors, aisles, depot. Plain data. */
  layout: Layout;
  spec: LayoutSpec;
  world: World;
  /** sku id → pick location id. */
  slotting: Array<[sku: string, loc: string]>;
  skus: SkuInfo[];
  suppliers: SupplierInfo[];
  stores: StoreInfo[];
  dc: { id: string; name: string; lon: number; lat: number };
  workers: WorkerInfo[];
  /** ctx.changes: the scenario as applied, for the HUD. */
  changes: string[];
}

export interface RunSpec {
  dc: string;
  startWeek: number;
  /** 1..28 on the page (the tools allow 56). */
  days: number;
  /** Integer ≥ 1. replicate() runs seeds 1..runs, so seed 1 replays a tool's first run exactly. */
  seed: number;
  /** May carry `layout` for an imported building; `candystore` is rejected in the browser. */
  scenario: TwinScenario;
}

export type TwinRequest =
  | { type: "run"; runId: string; spec: RunSpec; keepEvents: boolean }
  /** The genetic optimizer (lib/twin/optimize.ts): one `optProgress` per generation, then `optDone` or `error`. */
  | { type: "optimize"; runId: string; spec: OptimizeSpec }
  | { type: "ping" };

export type ProgressPhase = "context" | "simulate" | "compile";

export type TwinResponse =
  | { type: "ready"; dcs: string[] }
  | { type: "pong" }
  | { type: "progress"; runId: string; phase: ProgressPhase; day: number; days: number }
  | { type: "optProgress"; runId: string; progress: OptimizeProgress }
  | { type: "optDone"; runId: string; result: OptimizeResult }
  | {
      type: "done";
      runId: string;
      result: OperationsResult;
      kpis: Kpis;
      playback: Playback;
      world: WorldPayload;
      ms: { context: number; simulate: number; compile: number };
    }
  | { type: "error"; runId: string; name: string; message: string; issues?: Array<{ path: string; message: string }> };
