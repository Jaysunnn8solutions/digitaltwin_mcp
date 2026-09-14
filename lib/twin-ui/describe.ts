/**
 * Inspector text for the /twin page: a selection (an actor, a pallet, a
 * truck, a pick face, a reserve position, a door, a lane, a pack station or
 * a queue chip), the playback and the world at simulated minute t become
 * sections of label/value rows. Every row is either an engine fact (from the
 * trace: times, durations, distances, stock, doors the engine measured from)
 * or, flagged `shown`, something the playback synthesized (which forklift,
 * which door, the drawn route, the fit). A job card always carries both so
 * the reader can tell what the model says from what the picture adds.
 *
 * Pure: playback + world + t in, strings out. indexEvents() builds the
 * per-PO/order/worker lookups once per playback; the page memoizes it.
 */

import { upperBound } from "../trace/search";
import { ActorState, LANE_SLOTS, PalletAt, type CsrTimeline, type EntityDef, type JobInfo, type JobRow, type Playback, type TraceEvent, type TraceInit, type Track, type WorldPayload } from "../trace/types";
import type { PickResult } from "../three/api";
import { PROCESS_SKILL, PROCESSES, type Process } from "../twin/types";
import { clockOf, dayClock, dayOf, feet, minutes } from "./format";

export interface DescribeRow {
  label: string;
  value: string;
  /** Synthesized by the playback, not an engine fact. */
  shown?: true;
}

export interface DescribeSection {
  title: string;
  rows: DescribeRow[];
}

const fact = (label: string, value: string): DescribeRow => ({ label, value });
const synth = (label: string, value: string): DescribeRow => ({ label, value, shown: true });

// ---------------------------------------------------------------------------
// Sampling helpers (shared with the minimap)
// ---------------------------------------------------------------------------

export interface TrackPose {
  x: number;
  y: number;
  z: number;
  h: number;
  s: number;
  seg: number;
  job: number;
  carry: number;
}

/** The interpolated pose of a track at t, or null before its first keyframe. */
export function trackPoseAt(track: Track, t: number): TrackPose | null {
  const n = track.t.length;
  const k = upperBound(track.t, t) - 1;
  if (k < 0) return null;
  if (k + 1 < n) {
    const span = track.t[k + 1] - track.t[k];
    const f = span > 0 ? (t - track.t[k]) / span : 0;
    let dh = track.h[k + 1] - track.h[k];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return { x: track.x[k] + (track.x[k + 1] - track.x[k]) * f, y: track.y[k] + (track.y[k + 1] - track.y[k]) * f, z: track.z[k] + (track.z[k + 1] - track.z[k]) * f, h: track.h[k] + dh * f, s: track.s[k], seg: track.seg[k], job: track.job[k], carry: track.carry[k] };
  }
  return { x: track.x[k], y: track.y[k], z: track.z[k], h: track.h[k], s: track.s[k], seg: track.seg[k], job: track.job[k], carry: track.carry[k] };
}

/** The CSR row of item i in force at t, or -1 for an item with no rows. */
export function csrRowAt(tl: { offsets: Int32Array; t: Float64Array }, item: number, t: number): number {
  const lo = tl.offsets[item];
  const hi = tl.offsets[item + 1];
  if (hi === undefined || hi <= lo) return -1;
  const k = upperBound(tl.t, t, lo, hi);
  return Math.max(lo, k - 1);
}

export function csrValueAt<V extends Uint8Array | Uint16Array | Int32Array | Uint32Array>(tl: CsrTimeline<V>, item: number, t: number, fallback: number): number {
  const r = csrRowAt(tl, item, t);
  return r < 0 ? fallback : tl.v[r];
}

/** Every actor on the floor at t (state not Off), with its engine position, for the minimap. */
export interface ActorDot {
  entity: number;
  kind: EntityDef["kind"];
  x: number;
  y: number;
  state: number;
}

export function actorsAt(pb: Playback, t: number): ActorDot[] {
  const out: ActorDot[] = [];
  for (const tr of pb.tracks) {
    if (!tr) continue;
    const p = trackPoseAt(tr, t);
    if (!p || p.s === ActorState.Off) continue;
    out.push({ entity: tr.entity, kind: pb.entities[tr.entity].kind, x: p.x, y: p.y, state: p.s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event index
// ---------------------------------------------------------------------------

type Ev<K extends TraceEvent["k"]> = Extract<TraceEvent, { k: K }>;

export interface PoRecord {
  placed?: Ev<"poPlaced">;
  scheduled?: Ev<"truckScheduled">;
  arrive?: Ev<"truckArrive">;
  dock?: Ev<"truckDock">;
  undock?: Ev<"truckUndock">;
  putaways: Ev<"putaway">[];
}

export interface OrderRecord {
  release?: Ev<"orderRelease">;
  picked?: Ev<"orderPicked">;
  cut?: Ev<"orderCut">;
  packed: Ev<"palletPacked">[];
  loaded?: Ev<"truckLoaded">;
  depart?: Ev<"truckDepart">;
  shorts: Ev<"short">[];
  shortShips: Ev<"shortShip">[];
}

export interface EventIndex {
  init: TraceInit | null;
  /** Event times, for binary search into Playback.events. */
  times: Float64Array;
  po: Map<string, PoRecord>;
  order: Map<string, OrderRecord>;
  worker: Map<string, Ev<"worker">[]>;
  wms: Ev<"wms">[];
  /** Pick, re-pick, pack and load jobs per order id, in job order. */
  orderJobs: Map<string, JobRow[]>;
}

export function indexEvents(pb: Playback): EventIndex {
  const events = pb.events;
  const init = events[0]?.k === "init" ? (events[0] as TraceInit) : null;
  const times = Float64Array.from(events, (e) => e.t);
  const po = new Map<string, PoRecord>();
  const order = new Map<string, OrderRecord>();
  const worker = new Map<string, Ev<"worker">[]>();
  const wms: Ev<"wms">[] = [];
  const orderJobs = new Map<string, JobRow[]>();
  for (const j of pb.jobs) {
    if (!("order" in j.info)) continue;
    const list = orderJobs.get(j.info.order) ?? [];
    list.push(j);
    orderJobs.set(j.info.order, list);
  }
  const poRec = (id: string): PoRecord => {
    let r = po.get(id);
    if (!r) {
      r = { putaways: [] };
      po.set(id, r);
    }
    return r;
  };
  const orderRec = (id: string): OrderRecord => {
    let r = order.get(id);
    if (!r) {
      r = { packed: [], shorts: [], shortShips: [] };
      order.set(id, r);
    }
    return r;
  };
  for (const e of events) {
    switch (e.k) {
      case "poPlaced":
        poRec(e.po).placed = e;
        break;
      case "truckScheduled":
        poRec(e.po).scheduled = e;
        break;
      case "truckArrive":
        poRec(e.po).arrive = e;
        break;
      case "truckDock":
        poRec(e.po).dock = e;
        break;
      case "truckUndock":
        poRec(e.po).undock = e;
        break;
      case "putaway":
        poRec(e.po).putaways.push(e);
        break;
      case "orderRelease":
        orderRec(e.order).release = e;
        break;
      case "orderPicked":
        orderRec(e.order).picked = e;
        break;
      case "orderCut":
        orderRec(e.order).cut = e;
        break;
      case "palletPacked":
        orderRec(e.order).packed.push(e);
        break;
      case "truckLoaded":
        orderRec(e.order).loaded = e;
        break;
      case "truckDepart":
        orderRec(e.order).depart = e;
        break;
      case "short":
        orderRec(e.order).shorts.push(e);
        break;
      case "shortShip":
        orderRec(e.order).shortShips.push(e);
        break;
      case "worker": {
        const list = worker.get(e.id) ?? [];
        list.push(e);
        worker.set(e.id, list);
        break;
      }
      case "wms":
        wms.push(e);
        break;
      default:
        break;
    }
  }
  return { init, times, po, order, worker, wms, orderJobs };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const STATE_NAMES: Record<number, string> = {
  [ActorState.Off]: "off the floor",
  [ActorState.Idle]: "idle",
  [ActorState.Walk]: "walking",
  [ActorState.Drive]: "driving",
  [ActorState.Work]: "working",
  [ActorState.Lift]: "lifting",
  [ActorState.Break]: "on break",
  [ActorState.Indirect]: "indirect time (start-up, checks)",
  [ActorState.Overtime]: "on overtime",
  [ActorState.Wait]: "waiting",
  [ActorState.Docked]: "docked",
  [ActorState.Loading]: "loading",
  [ActorState.Late]: "late, still at the door",
  [ActorState.Depart]: "departing",
  [ActorState.Absent]: "absent",
};

/** States the events establish directly; the rest is the playback's animation between them. */
const ENGINE_STATES = new Set<number>([ActorState.Off, ActorState.Break, ActorState.Indirect, ActorState.Overtime, ActorState.Absent, ActorState.Late, ActorState.Docked]);

export function stateName(s: number): string {
  return STATE_NAMES[s] ?? `state ${s}`;
}

const FIT_WORDS: Record<JobRow["fit"], string> = {
  stationary: "stationary: no travel in this job",
  exact: "exact: travel and handling take the engine's minutes",
  borrowed: "borrowed: the walk to the start was paid for out of handling time",
  fadeIn: "fade-in: the walk to the start would have cost more than half the job, so the actor appears at the route origin",
  fast: "fast: even the route needs more than half the job at engine speed, so the actor moves faster than the engine assumes",
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function jobSummary(info: JobInfo): string {
  switch (info.kind) {
    case "unload":
      return `Unload ${info.po} pallet ${info.pallet + 1} of ${info.pallets}: ${info.items.map((i) => `${i.cases} × ${i.sku}`).join(", ")}`;
    case "receive":
      return `Receive ${info.po} pallet ${info.pallet + 1}: ${plural(info.cases, "case")}${info.importer ? ", import labels" : ""}`;
    case "putaway":
      return `Put away ${info.po} pallet ${info.pallet + 1} → ${info.items.map((i) => `${i.loc} (${i.cases} × ${i.sku})`).join(", ")}`;
    case "replen":
      return `${info.hot ? "Hot replenishment" : "Replenishment"} of ${info.sku}: ${info.from} → ${info.to}`;
    case "pick":
      return `Pick tour ${info.tour + 1} of ${info.tours} for ${info.order}: ${plural(info.lines.length, "line")}, ${info.lines.reduce((a, l) => a + l.inners, 0)} inners`;
    case "repick":
      return `Re-pick ${info.inners} × ${info.sku} at ${info.loc} for ${info.order}`;
    case "pack":
      return `Pack ${info.order} pallet ${info.pallet + 1} of ${info.pallets}`;
    case "load":
      return `Load ${info.order} for ${info.store}: ${plural(info.pallets, "pallet")}, truck leaves ${clockOf(info.departAt)}`;
  }
}

function doorId(world: WorldPayload, index: number): string | null {
  return index >= 0 ? (world.layout.doors[index]?.id ?? null) : null;
}

// ---------------------------------------------------------------------------
// Job card
// ---------------------------------------------------------------------------

export function describeJob(job: JobRow, world: WorldPayload, t: number): DescribeSection {
  const rows: DescribeRow[] = [];
  rows.push(fact("What", jobSummary(job.info)));
  rows.push(fact("Queued", `${dayClock(job.queuedAt)}, priority ${job.priority}`));
  if (job.startAt < 0) rows.push(fact("Started", "not before the horizon ended"));
  else {
    rows.push(fact("Started", `${clockOf(job.startAt)} by ${job.worker} after waiting ${minutes(job.waitMin)}${job.equipWaitMin > 0 ? ` (${minutes(job.equipWaitMin)} of it for equipment or a door)` : ""}`));
    rows.push(fact("Duration", `${job.dur.toFixed(1)} min = standard ÷ productivity ${job.productivity.toFixed(2)}`));
    rows.push(fact("Ends", job.truncated ? `${clockOf(job.endAt)}, past the horizon` : job.endAt > t ? `${clockOf(job.endAt)} (${minutes(job.endAt - t)} to go)` : clockOf(job.endAt)));
  }
  const engineDoor = "engineDoor" in job.info ? job.info.engineDoor : null;
  if (engineDoor !== null) {
    const visual = doorId(world, job.inDoor);
    if (visual && visual !== engineDoor) rows.push(synth("Door", `measured from ${engineDoor}, shown at ${visual}: the engine picks doors round-robin and the playback keeps a truck at one door`));
    else rows.push(fact("Door", engineDoor));
  }
  if (job.engineFeet > 0) rows.push(fact("Engine distance", `${feet(job.engineFeet)} at ${job.info.kind === "replen" || job.info.kind === "putaway" ? "forklift" : "walking"} speed`));
  if (job.startAt >= 0) {
    if (job.visualFeet > 0 || job.transferFeet > 0) rows.push(synth("Drawn route", `${feet(job.routeFeet)} on the floor${job.transferFeet > 0 ? ` + ${feet(job.transferFeet)} to get there` : ""} = ${feet(job.visualFeet)} drawn`));
    rows.push(synth("Fit", FIT_WORDS[job.fit]));
    rows.push(synth("Speed ratio", `${job.speedRatio.toFixed(2)}× the engine's ${job.info.kind === "replen" || job.info.kind === "putaway" ? "forklift" : "walking"} speed (moving ${job.moveMin.toFixed(1)} min, handling ${job.stopMin.toFixed(1)} min)`));
    const assigned: string[] = [];
    if (job.forklift >= 0) assigned.push(`forklift ${job.forklift + 1}`);
    if (job.palletJack >= 0) assigned.push(`pallet jack ${job.palletJack + 1}`);
    if (job.station >= 0) assigned.push(`pack station ${job.station + 1}`);
    const outDoor = doorId(world, job.outDoor);
    if (outDoor) assigned.push(`door ${outDoor}`);
    if (assigned.length) rows.push(synth("Assigned", `${assigned.join(", ")} (the engine counts equipment and doors; the playback picks which)`));
  }
  return { title: `Job ${job.id} · ${job.process}`, rows };
}

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------

function jobAt(pb: Playback, jobId: number): JobRow | null {
  return jobId >= 1 ? (pb.jobs[jobId - 1] ?? null) : null;
}

function nowSection(t: number): DescribeSection {
  return { title: "Now", rows: [fact("Time", dayClock(t))] };
}

function shiftToday(index: EventIndex, id: string, t: number): DescribeRow[] {
  const day = dayOf(t);
  const rows: DescribeRow[] = [];
  const evs = (index.worker.get(id) ?? []).filter((e) => dayOf(e.t) === day && e.t <= t);
  const inEv = evs.find((e) => e.state === "in");
  const absent = evs.find((e) => e.state === "absent");
  const out = evs.find((e) => e.state === "out");
  if (absent) rows.push(fact("Today", `absent from ${absent.shift ?? "shift"}`));
  else if (inEv) {
    rows.push(fact("Today", `${inEv.shift ?? "shift"} ${clockOf(inEv.shiftStart ?? 0)}–${clockOf(inEv.shiftEnd ?? 0)} as ${inEv.primary ?? "crew"}, break ${inEv.breakMin ?? 0} min at ${clockOf(inEv.breakAt ?? 0)}, ${inEv.indirectMin ?? 0} min indirect`));
    if (out) rows.push(fact("Clocked out", `${clockOf(out.t)}${(out.overtimeMin ?? 0) > 0.5 ? ` after ${minutes(out.overtimeMin ?? 0)} of overtime` : ""}`));
  } else rows.push(fact("Today", "not clocked in yet"));
  return rows;
}

function describeWorker(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const w = world.workers.find((x) => x.id === def.id);
  const facts: DescribeRow[] = [];
  if (w) {
    facts.push(fact("Role", `${w.role}, ${w.type}`));
    facts.push(fact("Skills", w.skills.join(", ")));
    facts.push(fact("Productivity", `${w.productivity.toFixed(2)} × standard`));
    facts.push(fact("Hourly rate", `$${w.hourlyRate.toFixed(2)}${w.overtimeMultiplier !== 1 ? `, overtime × ${w.overtimeMultiplier}` : ""}`));
  } else {
    facts.push(fact("Role", String(def.meta.role ?? "")));
  }
  facts.push(...shiftToday(index, def.id, t));
  const done = pb.jobs.filter((j) => j.worker === def.id && j.startAt >= 0 && j.endAt <= t && dayOf(j.startAt) === dayOf(t)).length;
  facts.push(fact("Jobs done today", String(done)));
  const sections: DescribeSection[] = [{ title: `${def.id}`, rows: facts }];

  const track = pb.tracks[entity];
  const pose = track ? trackPoseAt(track, t) : null;
  const now: DescribeRow[] = [];
  if (pose) {
    const row = ENGINE_STATES.has(pose.s) ? fact("State", stateName(pose.s)) : synth("State", stateName(pose.s));
    now.push(row);
    if (pose.s !== ActorState.Off && pose.s !== ActorState.Absent) now.push(synth("Position", `${Math.round(pose.x)}, ${Math.round(pose.y)} ft`));
    if (pose.carry >= 0) now.push(synth("Carrying", pb.entities[pose.carry]?.label ?? `pallet ${pose.carry}`));
  }
  sections.push({ title: "Now", rows: now.length ? now : [fact("State", "not on the floor")] });
  const job = pose ? jobAt(pb, pose.job) : null;
  if (job) sections.push(describeJob(job, world, t));
  return sections;
}

function describeVehicle(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number): DescribeSection[] {
  const index = Number(def.meta.index ?? 0);
  const isForklift = def.kind === "forklift";
  const track = pb.tracks[entity];
  const pose = track ? trackPoseAt(track, t) : null;
  const rows: DescribeRow[] = [];
  const jobsSoFar = pb.jobs.filter((j) => (isForklift ? j.forklift : j.palletJack) === index && j.startAt >= 0 && j.startAt <= t).length;
  const total = isForklift ? (pb.events[0]?.k === "init" ? (pb.events[0] as TraceInit).forklifts : 0) : pb.events[0]?.k === "init" ? (pb.events[0] as TraceInit).palletJacks : 0;
  rows.push(fact("Fleet", `${isForklift ? "forklift" : "pallet jack"} ${index + 1} of ${total} the engine counts`));
  rows.push(synth("Identity", "the engine tracks a count in use; the playback keeps each job on one unit"));
  rows.push(synth("Jobs on this unit so far", String(jobsSoFar)));
  if (pose) {
    rows.push(synth("State", stateName(pose.s)));
    rows.push(synth("Position", `${Math.round(pose.x)}, ${Math.round(pose.y)} ft`));
    if (isForklift && pose.z > 0.01) rows.push(synth("Forks", `${pose.z.toFixed(1)} ft up`));
    if (pose.carry >= 0) rows.push(synth("Carrying", pb.entities[pose.carry]?.label ?? `pallet ${pose.carry}`));
  }
  const sections: DescribeSection[] = [{ title: def.label, rows }];
  const job = pose ? jobAt(pb, pose.job) : null;
  if (job) sections.push(describeJob(job, world, t));
  else sections.push({ title: "Now", rows: [synth("Parked", "idle at its park spot until the next forklift job")] });
  return sections;
}

function palletPlace(pb: Playback, world: WorldPayload, ordinal: number, t: number): string {
  const tl = pb.pallets;
  const r = csrRowAt(tl, ordinal, t);
  if (r < 0) return "not yet";
  const at = tl.at[r];
  const ref = tl.ref[r];
  const slot = tl.slot[r];
  switch (at) {
    case PalletAt.Unborn:
      return "not yet";
    case PalletAt.TrailerIn:
      return `on the supplier trailer (${pb.entities[ref]?.label ?? ref})`;
    case PalletAt.DockLane:
      return `dock lane ${doorId(world, ref) ?? ref}, spot ${slot + 1}`;
    case PalletAt.Forklift:
      return `on ${pb.entities[ref]?.label ?? `forklift ${ref}`}`;
    case PalletAt.Rack:
      return `in reserve at ${world.layout.reserve[ref]?.id ?? ref}${slot > 0 ? `, stack ${slot + 1}` : ""}`;
    case PalletAt.PackStation:
      return `at pack station ${ref + 1}`;
    case PalletAt.StagingLane:
      return `staging lane ${doorId(world, ref) ?? ref}, spot ${slot + 1}`;
    case PalletAt.Jack:
      return `on ${pb.entities[ref]?.label ?? `pallet jack ${ref}`}`;
    case PalletAt.TrailerOut:
      return `on the store trailer (${pb.entities[ref]?.label ?? ref})`;
    case PalletAt.Gone:
      return "gone: put away into reserve stock, or departed on the truck";
    default:
      return `state ${at}`;
  }
}

function palletOrdinal(pb: Playback, entity: number): number {
  let o = 0;
  for (let i = 0; i < entity; i++) if (pb.entities[i].kind === "pallet") o++;
  return o;
}

function describePallet(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const rows: DescribeRow[] = [];
  const meta = def.meta;
  if (typeof meta.po === "string") {
    rows.push(fact("Purchase order", `${meta.po} from ${String(meta.supplier ?? "")}${meta.importer ? " (import)" : ""}`));
    if (typeof meta.items === "string") rows.push(fact("Contents", `${meta.items}${meta.mixed ? " (mixed pallet)" : ""}`));
    const po = index.po.get(meta.po);
    if (po?.arrive && po.arrive.t <= t) rows.push(fact("Arrived", dayClock(po.arrive.t)));
    const put = po?.putaways.find((p) => p.pallet === Number(meta.index));
    if (put && put.t <= t) rows.push(fact("Put away", `${dayClock(put.t)}, ${minutes(put.dockToStockMin)} dock to stock, into ${put.items.map((i) => i.loc).join(", ")}`));
    else if (po?.arrive && po.arrive.t <= t) rows.push(fact("Put away", "not yet"));
  } else if (typeof meta.order === "string") {
    rows.push(fact("Order", `${meta.order} for ${String(meta.store ?? "")}`));
    const o = index.order.get(meta.order);
    const packed = o?.packed.find((p) => p.index === Number(meta.index));
    if (packed && packed.t <= t) rows.push(fact("Packed", `${dayClock(packed.t)}, ${packed.left} left to pack`));
    else rows.push(fact("Packed", "not yet"));
    if (o?.loaded && o.loaded.t <= t) rows.push(fact("Loaded", `${dayClock(o.loaded.t)}${o.loaded.lateMin > 0 ? `, ${minutes(o.loaded.lateMin)} late` : ", on time"}`));
    if (o?.depart && o.depart.t <= t) rows.push(fact("Departed", dayClock(o.depart.t)));
  }
  rows.push(synth("Where now", palletPlace(pb, world, palletOrdinal(pb, entity), t)));
  rows.push(synth("Placement", "lane spots, pack stations and rack stacks are the playback's; the engine tracks stock per SKU and pallets per truck"));
  return [{ title: def.label, rows }];
}

function visualDoorOf(pb: Playback, world: WorldPayload, entity: number, t: number): string | null {
  const n = pb.doors.offsets.length - 1;
  for (let d = 0; d < n; d++) if (csrValueAt(pb.doors, d, t, -1) === entity) return doorId(world, d);
  return null;
}

function describeTruckIn(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const po = index.po.get(String(def.meta.po));
  const rows: DescribeRow[] = [];
  rows.push(fact("Purchase order", `${String(def.meta.po)} from ${String(def.meta.supplier)}${def.meta.importer ? " (importer: cases get compliance labels at receipt)" : ""}`));
  rows.push(fact("Pallets", String(def.meta.pallets)));
  if (po?.placed) rows.push(fact("Placed", `day ${po.placed.placedDay + 1}, ${plural(po.placed.cases, "case")}, due day ${po.placed.arriveDay + 1}`));
  if (po?.scheduled) rows.push(fact("Appointment", `${clockOf(po.scheduled.appointment)}, expected ${clockOf(po.scheduled.eta)}`));
  if (po?.arrive && po.arrive.t <= t) rows.push(fact("Arrived", dayClock(po.arrive.t)));
  if (po?.dock && po.dock.t <= t) rows.push(fact("Docked", `${clockOf(po.dock.t)}${po.dock.waitMin > 0.5 ? ` after ${minutes(po.dock.waitMin)} waiting for a door` : ""}`));
  else if (po?.arrive && po.arrive.t <= t) rows.push(fact("Docked", "waiting for a door"));
  if (po?.undock && po.undock.t <= t) rows.push(fact("Unloaded", clockOf(po.undock.t)));
  const put = po?.putaways.filter((p) => p.t <= t).length ?? 0;
  rows.push(fact("Pallets put away", `${put} of ${String(def.meta.pallets)}`));
  const engineDoor = po?.dock?.engineDoor ?? null;
  const visual = visualDoorOf(pb, world, entity, t);
  if (engineDoor && visual && visual !== engineDoor) rows.push(synth("Door", `measured from ${engineDoor}, shown at ${visual}`));
  else if (engineDoor) rows.push(fact("Door", engineDoor));
  else if (visual) rows.push(synth("Door", visual));
  const track = pb.tracks[entity];
  const pose = track ? trackPoseAt(track, t) : null;
  if (pose) rows.push(synth("Now", `${stateName(pose.s)} (yard driving, queue spots and backing in are drawn by the playback)`));
  return [{ title: def.label, rows }];
}

function describeTruckOut(entity: number, def: EntityDef, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const orderId = String(def.meta.order);
  const o = index.order.get(orderId);
  const rows: DescribeRow[] = [];
  rows.push(fact("Order", `${orderId} for ${String(def.meta.store)}`));
  rows.push(fact("Leaves at", `${clockOf(Number(def.meta.departAt))}, ${plural(Number(def.meta.pallets), "pallet")}`));
  if (o?.release) {
    const cut = o.release.lines.reduce((a, l) => a + l.cut, 0);
    rows.push(fact("Released", `${dayClock(o.release.t)}: ${plural(o.release.lines.length, "line")}, ${o.release.inners} inners, ${plural(o.release.tours, "tour")}${cut ? `, ${cut} inners cut at release` : ""}`));
  }
  if (o?.picked && o.picked.t <= t) rows.push(fact("Picked", `${dayClock(o.picked.t)}, ${o.picked.inners} inners`));
  const shorts = o?.shorts.filter((s) => s.t <= t).length ?? 0;
  const shortShips = o?.shortShips.filter((s) => s.t <= t) ?? [];
  if (shorts) rows.push(fact("Short at the face", `${shorts} time${shorts === 1 ? "" : "s"}${shortShips.length ? `, ${shortShips.reduce((a, s) => a + s.inners, 0)} inners shipped short` : ""}`));
  const packed = o?.packed.filter((p) => p.t <= t).length ?? 0;
  if (packed) rows.push(fact("Packed", `${packed} of ${String(def.meta.pallets)} pallets`));
  if (o?.loaded && o.loaded.t <= t) rows.push(fact("Loaded", `${dayClock(o.loaded.t)}${o.loaded.lateMin > 0 ? `, ${minutes(o.loaded.lateMin)} late` : ", on time"}; ${minutes(o.loaded.cycleFloorMin)} of floor time since release`));
  else rows.push(fact("Loaded", t > Number(def.meta.departAt) ? `not yet: ${minutes(t - Number(def.meta.departAt))} past departure` : "not yet"));
  if (o?.depart && o.depart.t <= t) rows.push(fact("Departed", dayClock(o.depart.t)));
  const visual = visualDoorOf(pb, world, entity, t);
  if (visual) rows.push(synth("Door", `${visual} (the engine counts outbound doors; the playback picks one)`));
  const track = pb.tracks[entity];
  const pose = track ? trackPoseAt(track, t) : null;
  if (pose) rows.push(pose.s === ActorState.Late ? fact("Now", "late: past its departure time and still at the door") : synth("Now", stateName(pose.s)));
  return [{ title: def.label, rows }];
}

function describeEntity(entity: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const def = pb.entities[entity];
  if (!def) return [{ title: "Unknown", rows: [fact("Entity", String(entity))] }];
  switch (def.kind) {
    case "worker":
      return describeWorker(entity, def, pb, world, t, index);
    case "forklift":
    case "jack":
      return describeVehicle(entity, def, pb, world, t);
    case "pallet":
      return describePallet(entity, def, pb, world, t, index);
    case "truckIn":
      return describeTruckIn(entity, def, pb, world, t, index);
    case "truckOut":
      return describeTruckOut(entity, def, pb, world, t, index);
  }
}

function runOf(world: WorldPayload, loc: { zone: "pick" | "reserve"; aisle: number; side: "L" | "R" }): string {
  const aisles = loc.zone === "pick" ? world.layout.pickAisles : world.layout.reserveAisles;
  const a = aisles[loc.aisle];
  const run = loc.side === "L" ? a?.left : a?.right;
  return run?.id ?? "?";
}

function describeFace(i: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const loc = world.layout.pick[i];
  if (!loc) return [{ title: "Pick face", rows: [fact("Index", String(i))] }];
  const skuIdx = pb.faceSku[i];
  const sku = skuIdx >= 0 ? world.skus[skuIdx] : null;
  const rows: DescribeRow[] = [];
  rows.push(fact("Rack", `${runOf(world, loc)}, bay ${loc.bay + 1}, level ${loc.level}${loc.slot > 0 || loc.id.match(/[A-Z]$/) ? `, slot ${loc.slot + 1}` : ""}`));
  rows.push(fact("Position", `${loc.x}, ${loc.y} ft; ${feet(Math.abs(loc.x - world.layout.depot.x) + Math.abs(loc.y - world.layout.depot.y))} from the pick depot`));
  if (!sku) rows.push(fact("SKU", "empty face"));
  else {
    rows.push(fact("SKU", `${sku.id} · ${sku.name}`));
    const inners = csrValueAt(pb.faces, i, t, 0);
    const cap = index.init?.faceCap.find(([id]) => id === sku.id)?.[1] ?? 0;
    rows.push(fact("On the face", `${inners} of ${cap} inners (${sku.innersPerCase} per case)`));
    if (csrValueAt(pb.faceHot, i, t, 0)) rows.push(fact("Hot", "a hot replenishment is on its way: a tour found this face short"));
    const reserve = csrValueAt(pb.reserveInners, skuIdx, t, 0);
    const home = index.init?.reserveLoc.find(([id]) => id === sku.id)?.[1];
    rows.push(fact("In reserve", `${reserve} inners${home ? ` at ${home}` : ""}`));
    let lines = 0;
    let linesSoFar = 0;
    for (const j of pb.jobs) {
      if (j.info.kind !== "pick") continue;
      for (const l of j.info.lines) {
        if (l.loc !== loc.id) continue;
        lines++;
        if (j.startAt >= 0 && j.startAt <= t) linesSoFar++;
      }
    }
    rows.push(fact("Pick lines", `${linesSoFar} so far, ${lines} over the run`));
    rows.push(synth("Colour", "green stocked, amber at one case, red empty; heat view shades by lines over the run"));
  }
  return [{ title: `Pick face ${loc.id}`, rows }];
}

function describeReserve(i: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const loc = world.layout.reserve[i];
  if (!loc) return [{ title: "Reserve position", rows: [fact("Index", String(i))] }];
  const rows: DescribeRow[] = [];
  rows.push(fact("Rack", `${runOf(world, loc)}, bay ${loc.bay + 1}, level ${loc.level}`));
  const homeSku = index.init?.reserveLoc.find(([, l]) => l === loc.id)?.[0] ?? null;
  const occupantIdx = csrValueAt(pb.reserveSku, i, t, -1);
  const occupant = occupantIdx >= 0 ? world.skus[occupantIdx] : null;
  const homes = index.init?.reserveLoc.filter(([, l]) => l === loc.id).map(([s]) => s) ?? [];
  if (homes.length) rows.push(fact("Home of", homes.length === 1 ? `${homes[0]} · ${world.skus.find((s) => s.id === homes[0])?.name ?? ""}` : homes.join(", ")));
  else rows.push(fact("Home of", "no SKU (spare position)"));
  if (occupant) {
    const inners = csrValueAt(pb.reserveInners, occupantIdx, t, 0);
    rows.push(fact("Reserve stock", `${inners} inners of ${occupant.id} (${occupant.casesPerPallet} cases of ${occupant.innersPerCase} per pallet)`));
    const stack = csrValueAt(pb.reserveSlots, i, t, 0);
    if (homeSku && occupant.id !== homeSku) rows.push(synth("Occupant", `overflow of ${occupant.id}, whose home position was full`));
    rows.push(synth("Pallets drawn", `${stack}: the engine keeps reserve stock per SKU, the playback stacks it at the home position and spills to the nearest free ones`));
  } else rows.push(synth("Pallets drawn", "none: nothing in reserve for this position now"));
  return [{ title: `Reserve ${loc.id}`, rows }];
}

function describeDoor(i: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const door = world.layout.doors[i];
  if (!door) return [{ title: "Door", rows: [fact("Index", String(i))] }];
  const rows: DescribeRow[] = [];
  rows.push(fact("Kind", `${door.kind} door at x ${door.x} ft`));
  const v = csrValueAt(pb.doors, i, t, -1);
  if (v === -2) rows.push(fact("Now", "out of service (door outage)"));
  else if (v >= 0) {
    const truck = pb.entities[v];
    rows.push(synth("Now", `${truck?.label ?? `truck ${v}`} at the door`));
    if (truck?.kind === "truckIn") {
      const eng = index.po.get(String(truck.meta.po))?.dock?.engineDoor;
      if (eng && eng !== door.id) rows.push(synth("Engine door", `the engine measured this truck's putaway distance from ${eng}`));
      else if (eng) rows.push(fact("Engine door", eng));
    }
  } else rows.push(synth("Now", "free"));
  let occupied = 0;
  for (let s = 0; s < LANE_SLOTS; s++) if (csrValueAt(pb.laneSlots, i * LANE_SLOTS + s, t, -1) >= 0) occupied++;
  rows.push(synth("Lane", `${occupied} of ${LANE_SLOTS} pallet spots in use`));
  let engineDockings = 0;
  for (const rec of index.po.values()) if (rec.dock && rec.dock.t <= t && rec.dock.engineDoor === door.id) engineDockings++;
  let shownDockings = 0;
  const lo = pb.doors.offsets[i];
  const hi = pb.doors.offsets[i + 1];
  for (let r = lo; r < hi; r++) if (pb.doors.t[r] <= t && pb.doors.v[r] >= 0) shownDockings++;
  if (door.kind === "inbound") rows.push(fact("Trucks the engine measured from here", `${engineDockings} so far`));
  rows.push(synth("Trucks drawn at this door", `${shownDockings} so far`));
  return [{ title: `Door ${door.id}`, rows }];
}

function describeStation(i: number, pb: Playback, world: WorldPayload, t: number): DescribeSection[] {
  const st = world.world.stations[i];
  const rows: DescribeRow[] = [];
  rows.push(synth("Position", st ? `${Math.round(st[0])}, ${Math.round(st[1])} ft, in front of the pick depot (the engine has no pack location)` : "unknown"));
  const packsSoFar = pb.jobs.filter((j) => j.process === "pack" && j.startAt >= 0 && j.startAt <= t).length;
  rows.push(fact("Pack jobs started so far", `${packsSoFar} in the building`));
  const here = pb.jobs.filter((j) => j.station === i && j.startAt >= 0 && j.startAt <= t).length;
  rows.push(synth("Drawn at this station", `${here} so far`));
  const sections: DescribeSection[] = [{ title: `Pack station ${i + 1}`, rows }];
  const jobId = csrValueAt(pb.stations, i, t, -1);
  const job = jobAt(pb, jobId);
  if (job) sections.push(describeJob(job, world, t));
  else sections.push({ title: "Now", rows: [synth("Idle", "no pallet being packed here")] });
  return sections;
}

function describeLane(door: number, slot: number, pb: Playback, world: WorldPayload, t: number, index: EventIndex): DescribeSection[] {
  const d = world.layout.doors[door];
  const rows: DescribeRow[] = [];
  rows.push(fact("Door", d ? `${d.id} (${d.kind})` : String(door)));
  rows.push(synth("Spot", `${slot + 1} of ${LANE_SLOTS} (${d?.kind === "outbound" ? "staging" : "dock"} lane spots are the playback's)`));
  const occupant = csrValueAt(pb.laneSlots, door * LANE_SLOTS + slot, t, -1);
  const sections: DescribeSection[] = [{ title: `${d?.kind === "outbound" ? "Staging" : "Dock"} lane ${d?.id ?? door} · spot ${slot + 1}`, rows }];
  if (occupant >= 0) {
    const def = pb.entities[occupant];
    if (def) sections.push(...describePallet(occupant, def, pb, world, t, index));
  } else rows.push(synth("Now", "empty"));
  return sections;
}

function describeQueue(process: Process, pb: Playback, world: WorldPayload, t: number): DescribeSection[] {
  const p = PROCESSES.indexOf(process);
  const bins = pb.queueBins;
  const n = PROCESSES.length;
  const k = Math.max(0, Math.min(bins.count - 1, Math.floor(t / Math.max(1, bins.binMin))));
  const len = bins.count > 0 && p >= 0 ? bins.queues[k * n + p] : 0;
  const rows: DescribeRow[] = [];
  rows.push(fact("Queue", `${len} ${process} job${len === 1 ? "" : "s"} waiting (skill: ${PROCESS_SKILL[process]})`));
  const waiting = pb.jobs.filter((j) => j.process === process && j.queuedAt <= t && (j.startAt < 0 || j.startAt > t)).sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
  rows.push(fact("Waiting now", String(waiting.length)));
  const sections: DescribeSection[] = [{ title: `${process} queue`, rows }];
  for (const j of waiting.slice(0, 8)) {
    const held = j.startAt > t && j.equipWaitMin > 0 && t >= j.startAt - j.equipWaitMin;
    sections.push({
      title: `Job ${j.id}`,
      rows: [fact("What", jobSummary(j.info)), fact("Waiting", `${minutes(t - j.queuedAt)} since ${clockOf(j.queuedAt)}, priority ${j.priority}`), held ? fact("Held", `a qualified worker is free but the equipment or door is taken (${minutes(j.equipWaitMin)} of the wait)`) : fact("Starts", j.startAt < 0 ? "never before the horizon" : `${clockOf(j.startAt)} with ${j.worker}`)],
    });
  }
  if (waiting.length > 8) sections.push({ title: `${waiting.length - 8} more`, rows: [fact("Also waiting", waiting.slice(8).map((j) => `#${j.id}`).join(", "))] });
  void world;
  return sections;
}

/** The inspector's sections for a selection at t. */
export function describeSelection(sel: PickResult | null, pb: Playback, world: WorldPayload, t: number, index: EventIndex = indexEvents(pb)): DescribeSection[] {
  if (!sel) return [nowSection(t)];
  switch (sel.kind) {
    case "entity":
      return describeEntity(sel.entity, pb, world, t, index);
    case "face":
      return describeFace(sel.index, pb, world, t, index);
    case "reserve":
      return describeReserve(sel.index, pb, world, t, index);
    case "door":
      return describeDoor(sel.index, pb, world, t, index);
    case "station":
      return describeStation(sel.index, pb, world, t);
    case "lane":
      return describeLane(sel.door, sel.slot, pb, world, t, index);
    case "queue":
      return describeQueue(sel.process, pb, world, t);
  }
}

/** A one-line name for a selection, for the inspector header and the camera pill. */
export function selectionTitle(sel: PickResult | null, pb: Playback | null, world: WorldPayload | null): string {
  if (!sel) return "Nothing selected";
  switch (sel.kind) {
    case "entity":
      return pb?.entities[sel.entity]?.label ?? `entity ${sel.entity}`;
    case "face":
      return `Pick face ${world?.layout.pick[sel.index]?.id ?? sel.index}`;
    case "reserve":
      return `Reserve ${world?.layout.reserve[sel.index]?.id ?? sel.index}`;
    case "door":
      return `Door ${world?.layout.doors[sel.index]?.id ?? sel.index}`;
    case "station":
      return `Pack station ${sel.index + 1}`;
    case "lane":
      return `Lane ${world?.layout.doors[sel.door]?.id ?? sel.door} spot ${sel.slot + 1}`;
    case "queue":
      return `${sel.process} queue`;
  }
}
