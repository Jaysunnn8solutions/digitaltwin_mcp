/**
 * The running KPI reducer reproduces kpis(result) at the horizon, checkpoints
 * replay to the same state as a straight pass, and the queue bins match the
 * events.
 */
import "../data/load";
import { describe, expect, it } from "vitest";
import { importLayout } from "../layout/import";
import { sampleCsv } from "../layout/samples";
import { runOperations, type OperationsResult } from "../twin/operations";
import { KPI_KEYS, kpis } from "../twin/replicate";
import { DEFAULT_STANDARDS } from "../twin/standards";
import { PROCESSES } from "../twin/types";
import { buildTwin, operationsOptions, type TwinScenario } from "../twin/twin";
import { loadCatalog, loadRoster } from "../data/store";
import { seededRandom } from "../util/random";
import { compilePlayback } from "./compile";
import { buildFixture, skuInfos, workerInfos } from "./fixtures";
import { applyEvent, cloneState, createState, finalize, kpiContext, projectKpis } from "./kpis";
import { RecordingTracer, type Playback, type SkuInfo, type TraceEvent, type TraceInit } from "./types";
import { buildWorld } from "./world";

interface Case {
  name: string;
  events: TraceEvent[];
  skus: SkuInfo[];
  pb: Playback;
  result: OperationsResult | null;
}

async function record(name: string, dc: string, days: number, seed: number, scenario: TwinScenario = {}): Promise<Case> {
  const ctx = await buildTwin(dc, 36, scenario);
  const tracer = new RecordingTracer();
  const result = runOperations(ctx, operationsOptions(ctx, days, seed), tracer);
  const skus = skuInfos(ctx.catalog);
  const workers = workerInfos(ctx.workers);
  const pb = compilePlayback({ events: tracer.events, layout: ctx.layout, world: buildWorld(ctx.layout, workers), skus, slotting: [...ctx.slotting].map(([s, l]) => [s, l.id]) });
  return { name, events: tracer.events, skus, pb, result };
}

async function fixtureCase(): Promise<Case> {
  const ctx = await buildTwin("dc-west", 36, {});
  const f = buildFixture(ctx.layout, loadCatalog(), loadRoster().workers, DEFAULT_STANDARDS);
  const pb = compilePlayback({ events: f.events, layout: ctx.layout, world: buildWorld(ctx.layout, f.workers), skus: f.skus, slotting: f.slotting });
  return { name: "fixture", events: f.events, skus: f.skus, pb, result: null };
}

const probe = await record("probe", "dc-west", 1, 5);
const live = probe.events.length > 0;

function initOf(events: TraceEvent[]): TraceInit {
  return events.find((e): e is TraceInit => e.k === "init")!;
}

function replayTo(c: Case, t: number) {
  const init = initOf(c.events);
  const ctx = kpiContext(init, c.events, c.skus);
  const s = createState(init);
  for (const e of c.events) {
    if (e.t > t) break;
    applyEvent(s, e, ctx);
  }
  return { s, ctx };
}

function checkReplay(c: Case) {
  const init = initOf(c.events);
  const ctx = kpiContext(init, c.events, c.skus);
  const rng = seededRandom(3);
  for (let k = 0; k < 10; k++) {
    const t = Math.floor(rng() * init.horizonEnd);
    const straight = replayTo(c, t).s;
    // The last checkpoint at or before t, then the events since.
    const cp = [...c.pb.checkpoints].reverse().find((x) => x.t <= t)!;
    const s = cloneState(cp.kpis);
    for (const e of c.events) {
      if (e.t <= cp.t) continue;
      if (e.t > t) break;
      applyEvent(s, e, ctx);
    }
    expect(s).toEqual(straight);
    // And the projection is the same either way.
    expect(projectKpis(s, t, init, c.pb.samples, false)).toEqual(projectKpis(straight, t, init, c.pb.samples, false));
  }
}

function checkQueueBins(c: Case) {
  const bins = c.pb.queueBins;
  const q = PROCESSES.map(() => 0);
  const jobProcess = new Map<number, number>();
  let ev = 0;
  for (let b = 0; b < bins.count; b++) {
    const end = (b + 1) * bins.binMin;
    while (ev < c.events.length && c.events[ev].t <= end) {
      const e = c.events[ev++];
      if (e.k === "jobQueued") {
        jobProcess.set(e.job, PROCESSES.indexOf(e.process));
        q[PROCESSES.indexOf(e.process)]++;
      } else if (e.k === "jobStart") q[jobProcess.get(e.job)!]--;
    }
    for (let p = 0; p < PROCESSES.length; p++) {
      if (bins.queues[b * PROCESSES.length + p] !== q[p]) throw new Error(`${c.name}: queue bin ${b} process ${PROCESSES[p]}: ${bins.queues[b * PROCESSES.length + p]} ≠ ${q[p]}`);
    }
  }
}

describe("kpis on the fixture", () => {
  it("checkpoint + replay equals a straight replay, and queue bins match the events", async () => {
    const c = await fixtureCase();
    checkReplay(c);
    checkQueueBins(c);
    const init = initOf(c.events);
    const { s, ctx } = replayTo(c, init.horizonEnd);
    finalize(s, init.horizonEnd, ctx);
    const k = projectKpis(s, init.horizonEnd, init, c.pb.samples, true);
    expect(k.trucks).toBe(2);
    expect(k.lateTrucks).toBe(1);
    expect(k.absences).toBe(1);
    expect(k.overtimeHours).toBeGreaterThan(0);
    expect(k.hotReplenishments).toBe(1);
    expect(k.replenishments).toBe(1);
    expect(k.inboundPallets).toBe(3);
    expect(k.palletsNotPutAway).toBe(0);
    expect(k.cutDollars).toBeGreaterThan(0);
    expect(k.fillRate).toBeLessThan(1);
    expect(k.forkliftUtilization).toBeGreaterThan(0);
    expect(k.dockToStockP90Min).toBeGreaterThan(0);
  });
});

describe.skipIf(!live)("kpis on real recordings", () => {
  it("projects kpis(result) exactly at horizonEnd on both built-ins and the CSV sample", async () => {
    const csv = await importLayout({ fileName: "locations.csv", text: sampleCsv() }, {}, "inline");
    const cases = [await record("dc-west", "dc-west", 7, 5), await record("dc-east", "dc-east", 7, 5), await record("csv", "dc-east", 5, 5, { layout: csv.spec })];
    for (const c of cases) {
      const init = initOf(c.events);
      const expected = kpis(c.result!);
      // From the last checkpoint (always at horizonEnd) plus finalize.
      const cp = c.pb.checkpoints[c.pb.checkpoints.length - 1];
      expect(cp.t).toBe(init.horizonEnd);
      const ctx = kpiContext(init, c.events, c.skus);
      const s = cloneState(cp.kpis);
      finalize(s, init.horizonEnd, ctx);
      const got = projectKpis(s, init.horizonEnd, init, c.pb.samples, true);
      for (const key of KPI_KEYS) {
        // Dock-to-stock samples travel as Float32 (Playback.samples), so those two keys hold to six significant digits; everything else is exact to 1e-6.
        const tol = key === "dockToStockAvgMin" || key === "dockToStockP90Min" ? 1e-6 * Math.max(1, Math.abs(expected[key])) : 5e-7;
        if (Math.abs(got[key] - expected[key]) > tol) throw new Error(`${c.name}: ${key} projected ${got[key]} vs kpis(result) ${expected[key]}`);
        if (tol === 5e-7) expect(got[key]).toBeCloseTo(expected[key], 6);
      }
      checkReplay(c);
      checkQueueBins(c);
    }
  }, 120_000);
});
