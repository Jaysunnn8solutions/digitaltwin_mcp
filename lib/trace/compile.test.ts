/**
 * The compiler on the hand-written fixture and on real recordings: tracks are
 * well-formed and inside the building, nobody moves faster than the engine
 * assumes, identities never double-book, pallets are conserved, and the same
 * events compile to byte-identical arrays.
 */
import "../data/load";
import { describe, expect, it } from "vitest";
import { importLayout } from "../layout/import";
import { sampleCsv } from "../layout/samples";
import type { Layout } from "../twin/layout";
import { runOperations, type OperationsResult } from "../twin/operations";
import { DEFAULT_STANDARDS } from "../twin/standards";
import { buildTwin, operationsOptions, type TwinScenario } from "../twin/twin";
import { loadCatalog, loadRoster } from "../data/store";
import { collectBuffers, compilePlayback, YARD_FT_PER_MIN } from "./compile";
import { buildFixture, skuInfos, workerInfos } from "./fixtures";
import { ActorState, DirtyKind, LANE_SLOTS, RecordingTracer, SegKind, type DoorFrame, type Playback, type SkuInfo, type TraceEvent, type TraceInit, type Track, type WorkerInfo } from "./types";
import { buildWorld } from "./world";

interface Case {
  name: string;
  layout: Layout;
  events: TraceEvent[];
  skus: SkuInfo[];
  slotting: Array<[string, string]>;
  workers: WorkerInfo[];
  result: OperationsResult | null;
}

async function record(name: string, dc: string, days: number, seed: number, scenario: TwinScenario = {}): Promise<Case> {
  const ctx = await buildTwin(dc, 36, scenario);
  const tracer = new RecordingTracer();
  const result = runOperations(ctx, operationsOptions(ctx, days, seed), tracer);
  return { name, layout: ctx.layout, events: tracer.events, skus: skuInfos(ctx.catalog), slotting: [...ctx.slotting].map(([s, l]) => [s, l.id]), workers: workerInfos(ctx.workers), result };
}

async function fixtureCase(): Promise<Case> {
  const ctx = await buildTwin("dc-west", 36, {});
  const f = buildFixture(ctx.layout, loadCatalog(), loadRoster().workers, DEFAULT_STANDARDS);
  return { name: "fixture", layout: ctx.layout, events: f.events, skus: f.skus, slotting: f.slotting, workers: f.workers, result: null };
}

const probe = await record("probe", "dc-west", 1, 5);
const live = probe.events.length > 0;

async function liveCases(): Promise<Case[]> {
  const csv = await importLayout({ fileName: "locations.csv", text: sampleCsv() }, {}, "inline");
  return [await record("dc-west", "dc-west", 7, 5), await record("dc-east", "dc-east", 7, 5), await record("csv", "dc-east", 5, 5, { layout: csv.spec })];
}

function compile(c: Case, offsets = true, keepEvents = true): Playback {
  const world = buildWorld(c.layout, c.workers);
  return compilePlayback({ events: c.events, layout: c.layout, world, skus: c.skus, slotting: c.slotting, opts: { offsets, keepEvents } });
}

const MOVING = new Set<number>([SegKind.Walk, SegKind.WalkCart, SegKind.Drive, SegKind.DriveLoaded, SegKind.Transfer, SegKind.IdleReturn, SegKind.Yard]);

function checkPlayback(c: Case, pb: Playback) {
  const init = c.events.find((e): e is TraceInit => e.k === "init")!;
  const world = pb.world;
  const prodOf = new Map(init.workers.map((w) => [w.id, w.productivity]));
  const fastJobs = new Set(pb.jobs.filter((j) => j.fit === "fast").map((j) => j.id));
  for (const tr of pb.tracks) {
    if (!tr) continue;
    const ent = pb.entities[tr.entity];
    const n = tr.t.length;
    expect(n).toBeGreaterThan(0);
    expect(tr.t[0]).toBe(0);
    for (let i = 1; i < n; i++) {
      if (!(tr.t[i] > tr.t[i - 1])) throw new Error(`${c.name} ${ent.id}: t not increasing at ${i} (${tr.t[i - 1]} → ${tr.t[i]})`);
    }
    expect(tr.t[n - 1]).toBeLessThanOrEqual(init.horizonEnd + 1e-9);
    for (let i = 0; i < n; i++) {
      if (tr.s[i] === ActorState.Off) continue;
      const x = tr.x[i];
      const y = tr.y[i];
      if (ent.kind === "truckIn" || ent.kind === "truckOut") {
        if (!(y <= 1 && x >= world.yard.spawnLeft[0] - 1 && x <= world.yard.spawnRight[0] + 1)) throw new Error(`${c.name} ${ent.id}: truck at (${x}, ${y}) outside the yard`);
      } else if (!(x >= -1 && x <= world.bbox.w + 1 && y >= -1 && y <= world.bbox.d + 1)) {
        throw new Error(`${c.name} ${ent.id}: (${x}, ${y}) outside the building at frame ${i} (t ${tr.t[i]})`);
      }
    }
    // Speed: every moving segment at or under 1.25 × nominal × productivity, unless the job was flagged fast.
    for (let i = 0; i + 1 < n; i++) {
      if (!MOVING.has(tr.seg[i]) || tr.s[i] === ActorState.Off) continue;
      const job = tr.job[i];
      if (job >= 1 && fastJobs.has(job)) continue;
      const dt = tr.t[i + 1] - tr.t[i];
      const feet = Math.abs(tr.x[i + 1] - tr.x[i]) + Math.abs(tr.y[i + 1] - tr.y[i]);
      if (feet < 1e-6) continue;
      const seg = tr.seg[i];
      const nominal = seg === SegKind.Yard ? YARD_FT_PER_MIN : seg === SegKind.Drive || seg === SegKind.DriveLoaded || (seg === SegKind.Transfer && ent.kind === "forklift") || (seg === SegKind.IdleReturn && ent.kind === "forklift") ? init.std.forkliftFtPerMin : init.std.walkFtPerMin;
      const prod = job >= 1 ? pb.jobs[job - 1].productivity : ent.kind === "worker" ? (prodOf.get(ent.id) ?? 1) : 1;
      const speed = feet / dt;
      if (speed > 1.25 * nominal * prod + 1e-6) throw new Error(`${c.name} ${ent.id}: ${speed.toFixed(1)} ft/min on seg ${seg} (job ${job}) > 1.25 × ${nominal} × ${prod} at t ${tr.t[i]}`);
    }
  }
  // Identities: at most one occupant per door, station, lane spot and reserve position at any time (intervals never overlap).
  const noOverlap = (name: string, intervals: Map<string, Array<[number, number, string]>>) => {
    for (const [key, list] of intervals) {
      const sorted = [...list].sort((p, q) => p[0] - q[0]);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i][0] < sorted[i - 1][1] - 1e-9) throw new Error(`${c.name}: ${name} ${key} double-booked: ${sorted[i - 1][2]} [${sorted[i - 1][0]}, ${sorted[i - 1][1]}) and ${sorted[i][2]} from ${sorted[i][0]}`);
      }
    }
  };
  const add = (m: Map<string, Array<[number, number, string]>>, key: string, a: number, b: number, who: string) => {
    const list = m.get(key) ?? [];
    list.push([a, b, who]);
    m.set(key, list);
  };
  const stationUse = new Map<string, Array<[number, number, string]>>();
  const outDoorUse = new Map<string, Array<[number, number, string]>>();
  const departAt = new Map<string, number>();
  for (const e of c.events) if (e.k === "truckDepart") departAt.set(e.order, e.t);
  for (const j of pb.jobs) {
    if (j.startAt < 0) continue;
    if (j.station >= 0) add(stationUse, String(j.station), j.startAt, Math.min(j.endAt, init.horizonEnd), `job ${j.id}`);
    if (j.outDoor >= 0 && j.info.kind === "load") add(outDoorUse, String(j.outDoor), j.startAt, departAt.get(j.info.order) ?? init.horizonEnd, `job ${j.id}`);
  }
  noOverlap("station", stationUse);
  noOverlap("outbound door", outDoorUse);
  const inDoorUse = new Map<string, Array<[number, number, string]>>();
  const dockT = new Map<string, number>();
  for (const e of c.events) {
    if (e.k === "truckDock") dockT.set(e.po, e.t);
    if (e.k === "truckUndock") {
      const t0 = dockT.get(e.po)!;
      const truck = pb.entities.findIndex((x) => x.kind === "truckIn" && x.id === e.po);
      let door = -1;
      for (let d = 0; d < pb.world.frames.length; d++) for (let r = pb.doors.offsets[d]; r < pb.doors.offsets[d + 1]; r++) if (pb.doors.t[r] === t0 && pb.doors.v[r] === truck) door = d;
      expect(door).toBeGreaterThanOrEqual(0);
      add(inDoorUse, String(door), t0, e.t, e.po);
    }
  }
  noOverlap("inbound door", inDoorUse);
  const laneUse = new Map<string, Array<[number, number, string]>>();
  const reserveUse = new Map<string, Array<[number, number, string]>>();
  for (let i = 0; i + 1 < pb.pallets.offsets.length; i++) {
    for (let r = pb.pallets.offsets[i]; r < pb.pallets.offsets[i + 1]; r++) {
      const at = pb.pallets.at[r];
      if (at !== 2 && at !== 6) continue;
      const until = r + 1 < pb.pallets.offsets[i + 1] ? pb.pallets.t[r + 1] : init.horizonEnd;
      add(laneUse, `${pb.pallets.ref[r]}/${pb.pallets.slot[r]}`, pb.pallets.t[r], until, pb.entities.filter((x) => x.kind === "pallet")[i].id);
    }
  }
  // A lane spot is exclusive until the lane is full; past LANE_SLOTS pallets the overflow stacks on spot mod 8 by design.
  for (const [key, list] of laneUse) {
    const door = key.split("/")[0];
    const laneAll = [...laneUse].filter(([k]) => k.split("/")[0] === door).flatMap(([, l]) => l);
    const sorted = [...list].sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][0] >= sorted[i - 1][1] - 1e-9) continue;
      const t = sorted[i][0];
      const occupied = laneAll.filter(([a, b]) => a <= t && t < b).length;
      if (occupied <= LANE_SLOTS) throw new Error(`${c.name}: lane spot ${key} double-booked with only ${occupied} pallets in the lane: ${sorted[i - 1][2]} [${sorted[i - 1][0]}, ${sorted[i - 1][1]}) and ${sorted[i][2]} from ${t}`);
    }
  }
  for (let i = 0; i + 1 < pb.reserveSku.offsets.length; i++) {
    for (let r = pb.reserveSku.offsets[i]; r < pb.reserveSku.offsets[i + 1]; r++) {
      const v = pb.reserveSku.v[r];
      if (v < 0) continue;
      const until = r + 1 < pb.reserveSku.offsets[i + 1] ? pb.reserveSku.t[r + 1] : init.horizonEnd;
      add(reserveUse, String(i), pb.reserveSku.t[r], until, `sku ${v}`);
    }
  }
  noOverlap("reserve position", reserveUse);
  // Free lists: never more units than the site has.
  for (const j of pb.jobs) {
    if (j.forklift >= 0) expect(j.forklift).toBeLessThan(Math.max(1, init.forklifts));
    if (j.palletJack >= 0) expect(j.palletJack).toBeLessThan(Math.max(1, init.palletJacks));
    if (j.inDoor >= 0) expect(pb.world.frames[j.inDoor].kind).toBe("inbound");
    if (j.outDoor >= 0) expect(pb.world.frames[j.outDoor].kind).toBe("outbound");
    if (j.startAt >= 0) {
      expect(j.endAt).toBeCloseTo(j.startAt + j.dur, 9);
      expect(j.stopMin + j.moveMin).toBeCloseTo(j.dur, 6);
      expect(j.truncated).toBe(j.endAt > init.horizonEnd);
    }
  }
  // Inbound door: the engine's door whenever it was free at docking time.
  const truckEntity = new Map(pb.entities.map((e, i) => [`${e.kind}:${e.id}`, i]));
  c.events.forEach((e) => {
    if (e.k !== "truckDock" || !e.engineDoor) return;
    const truck = truckEntity.get(`truckIn:${e.po}`)!;
    const engineIdx = pb.world.frames.findIndex((f) => f.door === e.engineDoor);
    let assigned = -1;
    let engineFree = true;
    for (let d = 0; d < pb.world.frames.length; d++) {
      for (let r = pb.doors.offsets[d]; r < pb.doors.offsets[d + 1]; r++) {
        if (pb.doors.t[r] === e.t && pb.doors.v[r] === truck) assigned = d;
        if (d === engineIdx && pb.doors.t[r] < e.t) engineFree = pb.doors.v[r] === -1;
      }
    }
    expect(assigned).toBeGreaterThanOrEqual(0);
    if (engineFree) expect(assigned).toBe(engineIdx);
  });
  // Docked pose: the track position is the trailer's rear at the door origin and the heading points the nose away from the door
  // (the renderer draws the truck from the rear along the heading, collide.ts boxes it the same way).
  const dockedAt = (tr: Track, t: number, frame: DoorFrame, states: number[], who: string) => {
    let k = -1;
    for (let i = 0; i < tr.t.length && k < 0; i++) if (tr.t[i] >= t - 1e-9 && states.includes(tr.s[i])) k = i;
    if (k < 0) throw new Error(`${c.name} ${who}: no keyframe in state ${states.join("/")} at or after ${t}`);
    expect(tr.x[k], who).toBeCloseTo(frame.origin[0], 3);
    expect(tr.y[k], who).toBeCloseTo(frame.origin[1], 3);
    expect(tr.h[k], who).toBeCloseTo(Math.atan2(-frame.inward[1], -frame.inward[0]), 5);
  };
  for (const [door, list] of inDoorUse) for (const [t0, , po] of list) dockedAt(pb.tracks[truckEntity.get(`truckIn:${po}`)!]!, t0, pb.world.frames[Number(door)], [ActorState.Docked], po);
  for (const e of c.events) {
    if (e.k !== "jobStart") continue;
    const j = pb.jobs[e.job - 1];
    if (j.info.kind !== "load") continue;
    // A trailer whose departAt has already passed goes Late in the same minute it starts loading (the Late frame replaces the Loading one).
    dockedAt(pb.tracks[truckEntity.get(`truckOut:${j.info.order}`)!]!, e.t, pb.world.frames[j.outDoor], [ActorState.Loading, ActorState.Late], j.info.order);
  }
  // Whoever left before the horizon ends its track Off: the sampler holds the last keyframe's state, so a track ending in Depart would leave the truck on screen.
  const left = new Set<string>();
  for (const e of c.events) {
    if (e.k === "truckUndock") left.add(`truckIn:${e.po}`);
    if (e.k === "truckDepart") left.add(`truckOut:${e.order}`);
    if (e.k === "worker" && e.state === "out") left.add(`worker:${e.id}`);
  }
  expect(left.size).toBeGreaterThan(0);
  for (const tr of pb.tracks) {
    if (!tr) continue;
    const ent = pb.entities[tr.entity];
    const last = tr.t.length - 1;
    if (!left.has(`${ent.kind}:${ent.id}`) || tr.t[last] >= init.horizonEnd - 1e-9) continue;
    if (tr.s[last] !== ActorState.Off) throw new Error(`${c.name} ${ent.id}: track ends at ${tr.t[last]} in state ${tr.s[last]}, not Off`);
  }
  // Conservation.
  const arrived = c.events.filter((e): e is Extract<TraceEvent, { k: "truckArrive" }> => e.k === "truckArrive").reduce((a, e) => a + e.pallets.length, 0);
  const putaways = c.events.filter((e) => e.k === "putaway").length;
  const loadedPallets = c.events.filter((e): e is Extract<TraceEvent, { k: "truckLoaded" }> => e.k === "truckLoaded").reduce((a, e) => a + e.pallets, 0);
  const palletEntities = pb.entities.filter((e) => e.kind === "pallet");
  const inboundPallets = palletEntities.filter((e) => e.meta.po !== undefined).length;
  expect(inboundPallets).toBe(arrived);
  expect(pb.pallets.offsets.length).toBe(palletEntities.length + 1);
  let gone = 0;
  for (let i = 0; i < palletEntities.length; i++) {
    if (palletEntities[i].meta.po === undefined) continue;
    let sawGone = false;
    for (let r = pb.pallets.offsets[i]; r < pb.pallets.offsets[i + 1]; r++) if (pb.pallets.at[r] === 9) sawGone = true;
    if (sawGone) gone++;
  }
  expect(gone).toBe(putaways);
  // Inbound pallets are coloured by category: traditional 0, then the specialty categories in the order they first appear in skus (apply.ts numbers reserve pallets the same way).
  const catOrder = ["traditional"];
  for (const s of c.skus) if (!catOrder.includes(s.category)) catOrder.push(s.category);
  const catOf = new Map(c.skus.map((s) => [s.id, s.category]));
  const arrivals = new Map(c.events.filter((e): e is Extract<TraceEvent, { k: "truckArrive" }> => e.k === "truckArrive").map((e) => [e.po, e]));
  for (const e of palletEntities) {
    if (e.meta.po === undefined) continue;
    const sku = arrivals.get(String(e.meta.po))?.pallets[Number(e.meta.index)]?.items[0]?.sku;
    const cat = sku === undefined ? undefined : catOf.get(sku);
    expect(e.colorIdx, e.id).toBe(cat === undefined ? 0 : catOrder.indexOf(cat));
  }
  if (c.result) {
    expect(arrived).toBe(c.result.volume.inboundPallets);
    expect(loadedPallets).toBe(c.result.volume.outboundPallets);
    expect(putaways).toBe(c.result.volume.inboundPallets - c.result.inbound.palletsNotPutAway);
  }
  // Dirty list sorted; every row is the GLOBAL row index into its timeline (apply.ts reads pb.<timeline>.v[row] directly), never an item's initial row.
  for (let i = 1; i < pb.dirty.t.length; i++) expect(pb.dirty.t[i]).toBeGreaterThanOrEqual(pb.dirty.t[i - 1]);
  const timelines: Record<DirtyKind, { offsets: Int32Array; t: Float64Array }> = {
    [DirtyKind.Face]: pb.faces,
    [DirtyKind.FaceHot]: pb.faceHot,
    [DirtyKind.ReserveSlots]: pb.reserveSlots,
    [DirtyKind.ReserveSku]: pb.reserveSku,
    [DirtyKind.ReserveInners]: pb.reserveInners,
    [DirtyKind.Door]: pb.doors,
    [DirtyKind.LaneSlot]: pb.laneSlots,
    [DirtyKind.Station]: pb.stations,
    [DirtyKind.Pallet]: pb.pallets,
  };
  expect(pb.dirty.t.length).toBeGreaterThan(0);
  for (let r = 0; r < pb.dirty.t.length; r++) {
    const tl = timelines[pb.dirty.kind[r] as DirtyKind];
    const idx = pb.dirty.idx[r];
    const row = pb.dirty.row[r];
    if (!(row > tl.offsets[idx] && row < tl.offsets[idx + 1])) throw new Error(`${c.name}: dirty entry ${r} (kind ${pb.dirty.kind[r]}, item ${idx}) has row ${row}, not a change row in [${tl.offsets[idx]}, ${tl.offsets[idx + 1]})`);
    expect(tl.t[row]).toBe(pb.dirty.t[r]);
  }
  expect(pb.jobs.length).toBe(c.events.filter((e) => e.k === "jobQueued").length);
  pb.jobs.forEach((j, i) => expect(j.id).toBe(i + 1));
}

function typedArrays(pb: Playback): ArrayBufferView[] {
  const out: ArrayBufferView[] = [];
  for (const tr of pb.tracks) if (tr) out.push(tr.t, tr.x, tr.y, tr.z, tr.h, tr.s, tr.seg, tr.job, tr.carry);
  for (const c of [pb.faces, pb.faceHot, pb.reserveSlots, pb.reserveSku, pb.reserveInners, pb.doors, pb.laneSlots, pb.stations]) out.push(c.offsets, c.t, c.v, c.ev);
  out.push(pb.faceSku, pb.pallets.offsets, pb.pallets.t, pb.pallets.at, pb.pallets.ref, pb.pallets.slot, pb.pallets.ev, pb.dirty.t, pb.dirty.kind, pb.dirty.idx, pb.dirty.row);
  out.push(pb.queueBins.queues, pb.queueBins.series, pb.kpiBins.queues, pb.kpiBins.series, pb.samples.dockToStock, pb.samples.doorWaits, pb.samples.cycleMin, pb.quiet.t0, pb.quiet.t1);
  return out;
}

describe("compilePlayback on the fixture", () => {
  it("exercises every job kind and every worker state", async () => {
    const c = await fixtureCase();
    const kinds = new Set(c.events.filter((e): e is Extract<TraceEvent, { k: "jobQueued" }> => e.k === "jobQueued").map((e) => e.info.kind));
    for (const k of ["unload", "receive", "putaway", "replen", "pick", "repick", "pack", "load"]) expect(kinds.has(k as never)).toBe(true);
    const ks = new Set(c.events.map((e) => e.k));
    for (const k of ["truckArrive", "truckDock", "truckUndock", "short", "shortShip", "orderRelease", "orderPicked", "palletPacked", "truckLoaded", "truckDepart", "wms", "putaway", "face", "end"]) expect(ks.has(k as never)).toBe(true);
    const states = new Set(c.events.filter((e): e is Extract<TraceEvent, { k: "worker" }> => e.k === "worker").map((e) => e.state));
    for (const s of ["in", "absent", "indirectEnd", "break", "breakEnd", "out"]) expect(states.has(s as never)).toBe(true);
    const late = c.events.find((e): e is Extract<TraceEvent, { k: "truckLoaded" }> => e.k === "truckLoaded" && e.lateMin > 0);
    expect(late).toBeDefined();
    const ot = c.events.find((e): e is Extract<TraceEvent, { k: "worker" }> => e.k === "worker" && e.state === "out" && (e.overtimeMin ?? 0) > 0);
    expect(ot).toBeDefined();
    for (let i = 1; i < c.events.length; i++) expect(c.events[i].t).toBeGreaterThanOrEqual(c.events[i - 1].t);
    const pb = compile(c);
    checkPlayback(c, pb);
    expect(pb.jobs.some((j) => j.fit === "fadeIn" || j.fit === "borrowed" || j.fit === "exact")).toBe(true);
    expect(pb.ticker.length).toBeGreaterThan(10);
    expect(pb.quiet.t0.length).toBeGreaterThan(0);
    expect(pb.entities.filter((e) => e.kind === "truckIn").length).toBe(2);
    expect(pb.entities.filter((e) => e.kind === "truckOut").length).toBe(2);
    expect(pb.checkpoints.length).toBe(25);
    expect(pb.queueBins.count).toBe(1440);
    expect(pb.kpiBins.count).toBe(288);
    // Hot face flag rises at the hot replenishment and falls when it lands.
    let hot = 0;
    for (let i = 0; i < pb.faceHot.offsets.length - 1; i++) hot += pb.faceHot.offsets[i + 1] - pb.faceHot.offsets[i] - 1;
    expect(hot).toBeGreaterThanOrEqual(2);
  });

  it("with offsets off, tours and re-picks from the depot move exactly at the engine's speed", async () => {
    const c = await fixtureCase();
    const pb = compile(c, false);
    const exact = pb.jobs.filter((j) => j.startAt >= 0 && (j.info.kind === "pick" || j.info.kind === "repick" || j.info.kind === "replen") && j.transferFeet === 0 && j.dur > 0.1);
    expect(exact.length).toBeGreaterThan(0);
    for (const j of exact) expect(j.speedRatio).toBeCloseTo(1, 6);
    expect(pb.meta.offsets).toBe(false);
  });

  it("compiles twice to byte-equal arrays and drops events on request", async () => {
    const c = await fixtureCase();
    const a = compile(c);
    const b = compile(c);
    const aa = typedArrays(a);
    const bb = typedArrays(b);
    expect(aa.length).toBe(bb.length);
    for (let i = 0; i < aa.length; i++) {
      expect(aa[i].byteLength).toBe(bb[i].byteLength);
      expect(Buffer.compare(Buffer.from(aa[i].buffer), Buffer.from(bb[i].buffer))).toBe(0);
    }
    expect(JSON.stringify(a.jobs)).toBe(JSON.stringify(b.jobs));
    expect(JSON.stringify(a.checkpoints)).toBe(JSON.stringify(b.checkpoints));
    const c2 = compile(c, true, false);
    expect(c2.events).toEqual([]);
    expect(a.events.length).toBe(c.events.length);
  });

  it("collectBuffers lists every buffer once and the playback survives a transfer", async () => {
    const c = await fixtureCase();
    const pb = compile(c);
    const buffers = collectBuffers(pb);
    expect(new Set(buffers).size).toBe(buffers.length);
    const arrays = typedArrays(pb);
    expect(buffers.length).toBe(arrays.length);
    const lengths = arrays.map((a) => a.byteLength);
    const clone = structuredClone(pb, { transfer: buffers });
    const after = typedArrays(clone).map((a) => a.byteLength);
    expect(after).toEqual(lengths);
    expect(arrays.every((a) => a.byteLength === 0)).toBe(true);
    expect(clone.tracks.length).toBe(pb.tracks.length);
    expect(clone.entities.length).toBe(pb.entities.length);
  });
});

describe.skipIf(!live)("compilePlayback on real recordings", () => {
  it("passes the invariants on both built-ins and the CSV sample, with no fast job", async () => {
    for (const c of await liveCases()) {
      const pb = compile(c);
      checkPlayback(c, pb);
      expect(pb.jobs.filter((j) => j.fit === "fast").length).toBe(0);
      expect(pb.entities.filter((e) => e.kind === "truckIn").length).toBe(c.result!.volume.inboundTrucks);
      expect(pb.entities.filter((e) => e.kind === "truckOut").length).toBe(c.events.filter((e) => e.k === "jobStart" && pb.jobs[e.job - 1].info.kind === "load").length);
      const offs = compile(c, false);
      const exact = offs.jobs.filter((j) => j.startAt >= 0 && (j.info.kind === "pick" || j.info.kind === "repick" || j.info.kind === "replen") && j.transferFeet === 0 && j.dur > 0.1);
      expect(exact.length).toBeGreaterThan(0);
      for (const j of exact) expect(j.speedRatio).toBeCloseTo(1, 6);
      expect(offs.jobs.filter((j) => j.fit === "fast").length).toBe(0);
    }
  }, 120_000);

  it("is deterministic on a real recording", async () => {
    const c = await record("dc-west", "dc-west", 3, 5);
    const a = typedArrays(compile(c));
    const b = typedArrays(compile(c));
    for (let i = 0; i < a.length; i++) expect(Buffer.compare(Buffer.from(a[i].buffer), Buffer.from(b[i].buffer))).toBe(0);
  }, 60_000);
});
