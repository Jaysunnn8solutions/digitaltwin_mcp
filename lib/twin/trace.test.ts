/**
 * The tracer is a pure observer of runOperations: with or without one the
 * result is identical, two recordings of a seed are identical, and the event
 * stream agrees with the result it came from (every job, order, truck, pallet
 * and face change accounted for) and with itself (monotone clock, matched
 * starts and ends, non-negative stock, doors never over-committed). A source
 * guard keeps the hooks away from the RNGs and the event heap.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Registers the committed data on Node whether or not a vitest setup file does.
import "../data/load";
import { importLayout } from "../layout/import";
import { sampleCsv } from "../layout/samples";
import { RecordingTracer, type JobInfo, type TraceEvent, type TraceInit } from "../trace/types";
import { runOperations, type OperationsResult } from "./operations";
import { hhmm } from "./standards";
import { buildTwin, operationsOptions, type TwinScenario } from "./twin";
import type { Process } from "./types";

type Ev<K extends TraceEvent["k"]> = Extract<TraceEvent, { k: K }>;

const DAYS = 7;
const START_WEEK = 36;
const HORIZON_END = DAYS * 1440;

const WMS: TwinScenario = {
  wmsOutages: [
    { day: 1, start: "08:00", hours: 2 },
    { day: 3, start: "10:00", hours: 1 },
  ],
};
const DISRUPTED: TwinScenario = {
  ...WMS,
  absenteeism: 0.2,
  forkliftOutages: [{ count: 1, fromDay: 1, toDay: 2 }],
  doorOutages: [{ kind: "inbound", count: 1, fromDay: 2, toDay: 4 }],
};
const csvLayout = async (): Promise<TwinScenario> => ({ layout: (await importLayout({ fileName: "locations.csv", text: sampleCsv() }, {}, "inline")).spec });

interface Case {
  name: string;
  dc: string;
  seed: number;
  scenario: () => Promise<TwinScenario>;
}

const CASES: Case[] = [
  { name: "dc-west seed 5", dc: "dc-west", seed: 5, scenario: async () => ({}) },
  { name: "dc-west seed 17", dc: "dc-west", seed: 17, scenario: async () => ({}) },
  { name: "dc-east seed 5", dc: "dc-east", seed: 5, scenario: async () => ({}) },
  { name: "dc-east seed 17", dc: "dc-east", seed: 17, scenario: async () => ({}) },
  { name: "csv sample seed 5", dc: "dc-east", seed: 5, scenario: csvLayout },
  { name: "csv sample seed 17", dc: "dc-east", seed: 17, scenario: csvLayout },
  { name: "dc-east disrupted", dc: "dc-east", seed: 5, scenario: async () => DISRUPTED },
];

interface Run {
  name: string;
  untraced: OperationsResult;
  traced: OperationsResult;
  second: OperationsResult;
  events: TraceEvent[];
  events2: TraceEvent[];
  init: TraceInit;
}

async function runCase(c: Case): Promise<Run> {
  const ctx = await buildTwin(c.dc, START_WEEK, await c.scenario());
  const opts = operationsOptions(ctx, DAYS, c.seed);
  const untraced = runOperations(ctx, opts);
  const t1 = new RecordingTracer();
  const traced = runOperations(ctx, opts, t1);
  const t2 = new RecordingTracer();
  const second = runOperations(ctx, opts, t2);
  return { name: c.name, untraced, traced, second, events: t1.events, events2: t2.events, init: t1.events[0] as TraceInit };
}

// Every test reads the same runs; run them once.
let memo: Promise<Run[]> | null = null;
const runs = () => (memo ??= Promise.all(CASES.map(runCase)));

const only = <K extends TraceEvent["k"]>(events: TraceEvent[], k: K): Array<Ev<K>> => events.filter((e): e is Ev<K> => e.k === k);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Which JobInfo kinds a process's jobs may carry. */
const KINDS: Record<Process, JobInfo["kind"][]> = {
  unload: ["unload"],
  receive: ["receive"],
  putaway: ["putaway"],
  replenish: ["replen"],
  pick: ["pick", "repick"],
  pack: ["pack"],
  load: ["load"],
};

describe("trace", () => {
  it("returns the same result with and without a tracer, and the same events twice", async () => {
    for (const r of await runs()) {
      expect(r.traced, r.name).toEqual(r.untraced);
      expect(r.second, r.name).toEqual(r.untraced);
      expect(r.events2, r.name).toEqual(r.events);
      expect(r.events.length, r.name).toBeGreaterThan(500);
    }
  });

  it("keeps the clock monotone from init at 0 to end at horizonEnd", async () => {
    for (const r of await runs()) {
      const { events, init } = r;
      expect(init.k, r.name).toBe("init");
      expect(init.t, r.name).toBe(0);
      expect(init.horizonEnd, r.name).toBe(HORIZON_END);
      expect(init.days, r.name).toBe(DAYS);
      expect(only(events, "init").length, r.name).toBe(1);
      const last = events[events.length - 1];
      expect(last, r.name).toEqual({ k: "end", t: HORIZON_END });
      expect(only(events, "end").length, r.name).toBe(1);
      let firstBackwards = -1;
      for (let i = 1; i < events.length && firstBackwards < 0; i++) if (events[i].t < events[i - 1].t) firstBackwards = i;
      expect(firstBackwards, r.name).toBe(-1);
      expect(events.some((e) => e.t < 0 || e.t > HORIZON_END), r.name).toBe(false);
    }
  });

  it("queues every job once before it starts and ends it at start + dur unless the horizon cuts it", async () => {
    for (const r of await runs()) {
      const { events, init } = r;
      const problems: string[] = [];
      const queuedAt = new Map<number, number>();
      const queuedTimes = new Map<number, number>();
      const infoOf = new Map<number, JobInfo>();
      const processOf = new Map<number, Process>();
      const started = new Map<number, Ev<"jobStart">>();
      const ended = new Set<number>();
      const productivity = new Map(init.workers.map((w) => [w.id, w.productivity]));
      events.forEach((e, i) => {
        if (e.k === "jobQueued") {
          queuedTimes.set(e.job, (queuedTimes.get(e.job) ?? 0) + 1);
          queuedAt.set(e.job, i);
          infoOf.set(e.job, e.info);
          processOf.set(e.job, e.process);
          if (!e.info || !KINDS[e.process].includes(e.info.kind)) problems.push(`job ${e.job}: ${e.process} job carries info ${JSON.stringify(e.info)}`);
          if (e.queueLen < 1) problems.push(`job ${e.job}: queued with queueLen ${e.queueLen}`);
        } else if (e.k === "jobStart") {
          if (queuedTimes.get(e.job) !== 1 || queuedAt.get(e.job)! >= i) problems.push(`job ${e.job}: started without exactly one earlier jobQueued`);
          if (started.has(e.job)) problems.push(`job ${e.job}: started twice`);
          if (e.dur < 0.1) problems.push(`job ${e.job}: dur ${e.dur}`);
          if (e.productivity !== productivity.get(e.worker)) problems.push(`job ${e.job}: productivity ${e.productivity} vs init ${productivity.get(e.worker)}`);
          if (e.waitMin < 0 || e.equipWaitMin < 0) problems.push(`job ${e.job}: negative wait`);
          if (e.outDoorAcquired && infoOf.get(e.job)?.kind !== "load") problems.push(`job ${e.job}: a non-load job took an outbound door`);
          started.set(e.job, e);
        } else if (e.k === "jobEnd") {
          const s = started.get(e.job);
          if (!s) problems.push(`job ${e.job}: ended without a start`);
          else {
            if (Math.abs(e.t - (s.t + s.dur)) > 1e-9) problems.push(`job ${e.job}: ended at ${e.t}, started ${s.t} for ${s.dur}`);
            if (e.worker !== s.worker) problems.push(`job ${e.job}: ended by ${e.worker}, started by ${s.worker}`);
          }
          if (ended.has(e.job)) problems.push(`job ${e.job}: ended twice`);
          ended.add(e.job);
        }
      });
      for (const [job, s] of started) {
        const fits = s.t + s.dur <= HORIZON_END + 1e-9;
        if (fits !== ended.has(job)) problems.push(`job ${job}: start ${s.t} + ${s.dur} ${fits ? "should have" : "should not have"} an end`);
      }
      expect(problems, r.name).toEqual([]);
      // Job ids are dense from 1 and every queued job is one the engine counted.
      const ids = [...queuedTimes.keys()].sort((a, b) => a - b);
      expect(ids, r.name).toEqual(ids.map((_, i) => i + 1));
      // Starts per process are the result's job counts (stats accrue at start).
      const startsBy = new Map<Process, number>();
      for (const job of started.keys()) startsBy.set(processOf.get(job)!, (startsBy.get(processOf.get(job)!) ?? 0) + 1);
      for (const [p, st] of Object.entries(r.untraced.processes) as Array<[Process, { jobs: number }]>) expect(startsBy.get(p) ?? 0, `${r.name} ${p}`).toBe(st.jobs);
      // Replenishments count at completion, hot ones by the request that queued them.
      const replenEnds = [...ended].map((job) => infoOf.get(job)!).filter((info) => info.kind === "replen");
      expect(replenEnds.length, r.name).toBe(r.untraced.pickFace.replenishments);
      expect(replenEnds.filter((info) => info.kind === "replen" && info.hot).length, r.name).toBe(r.untraced.pickFace.hotReplenishments);
    }
  });

  it("accounts for every order, inner, pallet and truck in the result", async () => {
    for (const r of await runs()) {
      const { events, untraced: res } = r;
      const picked = only(events, "face").filter((e) => e.reason === "pick" || e.reason === "repick");
      expect(sum(picked.map((e) => e.delta)), r.name).toBe(-res.volume.innersShipped);

      const releases = only(events, "orderRelease");
      expect(releases.length, r.name).toBe(res.volume.orders);
      expect(sum(releases.map((e) => e.lines.length)), r.name).toBe(res.volume.lines);
      expect(sum(releases.map((e) => sum(e.lines.map((l) => l.inners + l.cut)))), r.name).toBe(res.volume.innersOrdered);
      expect(sum(releases.map((e) => sum(e.lines.map((l) => l.cut)))), r.name).toBe(res.volume.cutInners);
      for (const e of releases) expect(e.inners, `${r.name} ${e.order}`).toBe(sum(e.lines.map((l) => l.inners)));

      const arrivals = only(events, "truckArrive");
      expect(arrivals.length, r.name).toBe(res.volume.inboundTrucks);
      expect(sum(arrivals.map((e) => e.pallets.length)), r.name).toBe(res.volume.inboundPallets);
      expect(only(events, "putaway").length, r.name).toBe(res.volume.inboundPallets - res.inbound.palletsNotPutAway);
      // Scheduled in the day's PO order, arriving in ETA order: the same trucks, not the same sequence.
      const scheduled = only(events, "truckScheduled");
      expect(scheduled.map((e) => e.po).sort(), r.name).toEqual(arrivals.map((e) => e.po).sort());
      const arrivedAt = new Map(arrivals.map((e) => [e.po, e.t]));
      for (const e of scheduled) {
        expect(e.eta, `${r.name} ${e.po}`).toBeGreaterThanOrEqual(e.t);
        expect(arrivedAt.get(e.po), `${r.name} ${e.po}`).toBe(e.eta);
      }

      const loaded = only(events, "truckLoaded");
      const loadedTrucks = res.trucks.filter((t) => t.loadedAt !== null);
      expect(loaded.length, r.name).toBe(loadedTrucks.length);
      expect(sum(loaded.map((e) => e.pallets)), r.name).toBe(res.volume.outboundPallets);
      const row = (t: { order: string; store: string; day: number; departAt: number; loadedAt: number | null; lateMin: number; pallets: number; inners: number }) => ({
        order: t.order,
        store: t.store,
        day: t.day,
        departAt: t.departAt,
        loadedAt: t.loadedAt,
        lateMin: t.lateMin,
        pallets: t.pallets,
        inners: t.inners,
      });
      expect(loaded.map((e) => row({ ...e, loadedAt: e.t })), r.name).toEqual(loadedTrucks.map(row));
      expect(only(events, "truckDepart").length, r.name).toBeLessThanOrEqual(loaded.length);
      expect(only(events, "orderPicked").length + only(events, "orderCut").length, r.name).toBeLessThanOrEqual(res.volume.orders);
    }
  });

  it("reports absolute face and reserve levels that follow init plus every delta, never negative", async () => {
    for (const r of await runs()) {
      const { events, init } = r;
      const problems: string[] = [];
      const faceLvl = new Map(init.face);
      const reserveLvl = new Map(init.reserve);
      // Putaway emits one face event per item before the putaway event names the inners: check them together.
      const pendingPutaway = new Map<number, number[]>();
      for (const e of events) {
        if (e.k === "face") {
          if (e.face < 0 || e.reserve < 0) problems.push(`${e.sku} at ${e.t}: negative level ${e.face}/${e.reserve}`);
          const f = faceLvl.get(e.sku) ?? 0;
          const rv = reserveLvl.get(e.sku) ?? 0;
          if (e.reason === "putaway") {
            if (e.delta !== 0 || e.face !== f) problems.push(`${e.sku} at ${e.t}: putaway face ${e.face} delta ${e.delta}, expected ${f}/0`);
            const list = pendingPutaway.get(e.job) ?? [];
            list.push(e.reserve);
            pendingPutaway.set(e.job, list);
            continue;
          }
          if (e.face !== f + e.delta) problems.push(`${e.sku} at ${e.t}: ${e.reason} face ${e.face}, expected ${f} + ${e.delta}`);
          const expectReserve = e.reason === "replen" ? rv - e.delta : rv;
          if (e.reserve !== expectReserve) problems.push(`${e.sku} at ${e.t}: ${e.reason} reserve ${e.reserve}, expected ${expectReserve}`);
          if (e.reason === "replen" && e.delta <= 0) problems.push(`${e.sku} at ${e.t}: replen moved ${e.delta}`);
          if ((e.reason === "pick" || e.reason === "repick") && (e.delta > 0 || !e.order)) problems.push(`${e.sku} at ${e.t}: ${e.reason} delta ${e.delta} order ${e.order}`);
          faceLvl.set(e.sku, e.face);
          reserveLvl.set(e.sku, e.reserve);
        } else if (e.k === "putaway") {
          const seen = pendingPutaway.get(e.job) ?? [];
          if (seen.length !== e.items.length) problems.push(`putaway job ${e.job}: ${seen.length} face events for ${e.items.length} items`);
          e.items.forEach((it, k) => {
            const rv = (reserveLvl.get(it.sku) ?? 0) + it.inners;
            if (seen[k] !== rv) problems.push(`putaway job ${e.job} item ${k}: reserve ${seen[k]}, expected ${rv}`);
            reserveLvl.set(it.sku, rv);
          });
          pendingPutaway.delete(e.job);
        }
      }
      expect(problems, r.name).toEqual([]);
      const capOf = new Map(init.faceCap);
      for (const [sku, level] of init.face) expect(level, `${r.name} ${sku}`).toBeLessThanOrEqual(capOf.get(sku)!);
    }
  });

  it("never has more trucks at the doors than the building has", async () => {
    for (const r of await runs()) {
      const { events, init } = r;
      const problems: string[] = [];
      const arrived = new Set<string>();
      const docked = new Set<string>();
      let maxDocked = 0;
      let outDoors = 0;
      let maxOut = 0;
      for (const e of events) {
        if (e.k === "truckArrive") arrived.add(e.po);
        else if (e.k === "truckDock") {
          if (!arrived.has(e.po) || docked.has(e.po)) problems.push(`${e.po} docked at ${e.t} without arriving, or twice`);
          if (e.waitMin < 0) problems.push(`${e.po}: waited ${e.waitMin}`);
          if (e.engineDoor !== null && !init.inDoors.includes(e.engineDoor)) problems.push(`${e.po}: unknown door ${e.engineDoor}`);
          docked.add(e.po);
          maxDocked = Math.max(maxDocked, docked.size);
        } else if (e.k === "truckUndock") {
          if (!docked.delete(e.po)) problems.push(`${e.po} undocked at ${e.t} without docking`);
        } else if (e.k === "jobStart" && e.outDoorAcquired) {
          outDoors++;
          maxOut = Math.max(maxOut, outDoors);
        } else if (e.k === "truckDepart") {
          outDoors--;
          if (outDoors < 0) problems.push(`outbound doors freed below zero at ${e.t}`);
        }
      }
      expect(problems, r.name).toEqual([]);
      expect(maxDocked, r.name).toBeLessThanOrEqual(init.inDoors.length);
      expect(maxDocked, r.name).toBeGreaterThan(0);
      expect(maxOut, r.name).toBeLessThanOrEqual(init.outDoors.length);
      expect(maxOut, r.name).toBeGreaterThan(0);
      expect(only(events, "truckDock").map((e) => e.po), r.name).toEqual(only(events, "truckUndock").map((e) => e.po).concat([...docked]));
    }
  });

  it("follows each worker through the shift and matches the labor records", async () => {
    for (const r of await runs()) {
      const { events, untraced: res } = r;
      const problems: string[] = [];
      const present = new Set<string>();
      const onBreak = new Set<string>();
      const ins = new Map<string, number>();
      const absents = new Map<string, number>();
      let overtimeMin = 0;
      for (const e of events) {
        if (e.k !== "worker") continue;
        const bad = (why: string) => problems.push(`${e.id} ${e.state} at ${e.t}: ${why}`);
        switch (e.state) {
          case "in":
            if (present.has(e.id)) bad("already in");
            if (e.shift === undefined || e.primary === undefined || e.shiftStart !== e.t || e.shiftEnd === undefined || e.shiftEnd <= e.t) bad("incomplete shift facts");
            if (e.breakAt === undefined || e.breakMin === undefined || e.indirectMin === undefined || e.lastShift === undefined) bad("incomplete break facts");
            present.add(e.id);
            ins.set(e.id, (ins.get(e.id) ?? 0) + 1);
            break;
          case "absent":
            if (present.has(e.id)) bad("absent while in");
            absents.set(e.id, (absents.get(e.id) ?? 0) + 1);
            break;
          case "indirectEnd":
          case "breakEnd":
            if (!present.has(e.id)) bad("not in");
            onBreak.delete(e.id);
            break;
          case "break":
            if (!present.has(e.id) || onBreak.has(e.id)) bad("not in, or already on break");
            onBreak.add(e.id);
            break;
          case "out":
            if (!present.has(e.id)) bad("not in");
            if (e.overtimeMin === undefined || e.overtimeMin < 0) bad(`overtime ${e.overtimeMin}`);
            overtimeMin += e.overtimeMin ?? 0;
            present.delete(e.id);
            onBreak.delete(e.id);
            break;
        }
      }
      expect(problems, r.name).toEqual([]);
      expect(present.size, r.name).toBe(0);
      for (const w of res.workers) {
        expect(ins.get(w.id) ?? 0, `${r.name} ${w.id} shifts`).toBe(w.shiftsWorked);
        expect(absents.get(w.id) ?? 0, `${r.name} ${w.id} absences`).toBe(w.absences);
      }
      expect(overtimeMin / 60, r.name).toBeCloseTo(res.labor.overtimeHours, 6);
      const jobStarts = only(events, "jobStart");
      for (const e of jobStarts) expect(res.workers.some((w) => w.id === e.worker), `${r.name} ${e.worker}`).toBe(true);
    }
  });

  it("notes a WMS outage once per window, brings it up at the end, and starts nothing in between", async () => {
    const r = (await runs()).find((x) => x.name === "dc-east disrupted")!;
    const windows = WMS.wmsOutages!.map((o) => [o.day * 1440 + hhmm(o.start), o.day * 1440 + hhmm(o.start) + o.hours * 60] as const);
    const wms = only(r.events, "wms");
    const downs = wms.filter((e) => e.down);
    const ups = wms.filter((e) => !e.down);
    expect(downs.length).toBe(windows.length);
    expect(ups.length).toBe(windows.length);
    for (const [s, e] of windows) {
      const down = downs.filter((d) => d.until === e);
      expect(down.length, `window ${s}-${e}`).toBe(1);
      expect(down[0].t).toBeGreaterThanOrEqual(s);
      expect(down[0].t).toBeLessThan(e);
      expect(ups.filter((u) => u.t === e).length, `window ${s}-${e}`).toBe(1);
      expect(only(r.events, "jobStart").some((j) => j.t >= s && j.t < e), `window ${s}-${e}`).toBe(false);
    }
    // No outage: no wms events at all.
    const plain = (await runs()).find((x) => x.name === "dc-east seed 5")!;
    expect(only(plain.events, "wms")).toEqual([]);
  });

  it("hooks never touch an RNG, the heap or Math.random (source guard)", () => {
    const lines = readFileSync(path.resolve(import.meta.dirname, "operations.ts"), "utf8").split(/\r?\n/);
    const hooks = lines.filter((l) => l.includes("trace?.("));
    expect(hooks.length).toBeGreaterThanOrEqual(30);
    const forbidden = /Rng\(|rng\(|Math\.random| at\(|events\.push/;
    expect(hooks.filter((l) => forbidden.test(l))).toEqual([]);
  });
});
