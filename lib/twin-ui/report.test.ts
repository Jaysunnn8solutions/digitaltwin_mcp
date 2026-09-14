/**
 * The scenario report over a real run: its day rows add up to the engine's
 * totals, the daily labor cost sums to the KPI, the bottleneck matches the
 * queue bins, the recommendations point at the bottleneck, and the three
 * export formats carry the same numbers.
 */

import { describe, expect, it } from "vitest";
import type { RunSpec, TwinRequest, TwinResponse } from "../trace/types";
import { runInWorker } from "../twin-worker/run";
import { PROCESSES } from "../twin/types";
import { buildReport, recommend, reportCsv, reportFileStem, reportJson, reportMarkdown, type Report, type ReportRun } from "./report";

type Done = Extract<TwinResponse, { type: "done" }>;

async function run(spec: Partial<RunSpec> = {}, label = "run"): Promise<ReportRun> {
  const req: TwinRequest = { type: "run", runId: label, keepEvents: true, spec: { dc: "dc-east", startWeek: 36, days: 5, seed: 5, scenario: {}, ...spec } };
  let done: Done | null = null;
  await runInWorker(req, (m) => {
    if (m.type === "done") done = m;
    if (m.type === "error") throw new Error(`${m.name}: ${m.message}`);
  });
  const d = done!;
  return { label, building: d.world.dc.name, spec: req.spec, world: d.world, result: d.result, kpis: d.kpis, playback: d.playback };
}

describe("buildReport", () => {
  let base: ReportRun;
  let report: Report;
  const ready = (async () => {
    base = await run();
    report = buildReport(base);
  })();

  it("has one row per day whose totals equal the engine's", async () => {
    await ready;
    expect(report.days).toHaveLength(base.result.days);
    const sum = (f: (d: Report["days"][number]) => number) => report.days.reduce((a, d) => a + f(d), 0);
    expect(sum((d) => d.orders)).toBe(base.result.volume.orders);
    expect(sum((d) => d.innersShipped)).toBe(base.result.volume.innersShipped);
    expect(sum((d) => d.cutInners)).toBe(base.result.volume.cutInners);
    expect(sum((d) => d.inboundPallets)).toBe(base.result.volume.inboundPallets);
    expect(sum((d) => d.trucksLate)).toBe(base.result.service.late);
    expect(sum((d) => d.lateMin)).toBeCloseTo(base.result.service.lateMinTotal, 6);
    expect(sum((d) => d.trucks)).toBe(base.result.trucks.filter((t) => t.loadedAt !== null).length);
  });

  it("splits labor hours, cost and shipped dollars by day from the checkpoints so they sum to the KPIs", async () => {
    await ready;
    const sum = (f: (d: Report["days"][number]) => number) => report.days.reduce((a, d) => a + f(d), 0);
    // The engine's paid hours include overtime; the day rows keep regular and overtime apart.
    expect(sum((d) => d.paidHours + d.overtimeHours)).toBeCloseTo(base.result.labor.paidHours, 6);
    expect(sum((d) => d.overtimeHours)).toBeCloseTo(base.result.labor.overtimeHours, 6);
    expect(sum((d) => d.busyHours)).toBeCloseTo(base.result.labor.busyHours, 6);
    expect(sum((d) => d.laborCost)).toBeCloseTo(base.kpis.laborCost, 6);
    expect(sum((d) => d.shippedDollars)).toBeCloseTo(base.result.volume.shippedDollars, 4);
    expect(sum((d) => d.hotReplenishments)).toBe(base.result.pickFace.hotReplenishments);
    for (const d of report.days) {
      if (d.orders > 0) expect(d.fillRate).toBeCloseTo(d.innersShipped / (d.innersShipped + d.cutInners), 9);
      else expect(d.fillRate).toBeNull();
      if (d.paidHours + d.overtimeHours > 0) expect(d.utilization).toBeCloseTo(d.busyHours / (d.paidHours + d.overtimeHours), 9);
    }
  });

  it("finds each day's bottleneck in the queue bins and never exceeds the engine's max queue", async () => {
    await ready;
    for (const d of report.days) {
      for (const p of PROCESSES) expect(d.peakQueue[p]).toBeLessThanOrEqual(base.result.processes[p].maxQueue);
      if (d.bottleneck) {
        expect(d.bottleneck.queueMinutes).toBeGreaterThan(0);
        expect(d.bottleneck.peak).toBe(d.peakQueue[d.bottleneck.process]);
        expect(d.bottleneck.peak).toBeGreaterThan(0);
      }
    }
    const withQueue = report.days.filter((d) => d.bottleneck);
    expect(withQueue.length).toBeGreaterThan(0);
    expect(report.bottleneck).toEqual(base.result.bottleneck);
  });

  it("carries the processes, crew, resources and headline KPIs unchanged", async () => {
    await ready;
    expect(report.processes.map((p) => p.jobs)).toEqual(PROCESSES.map((p) => base.result.processes[p].jobs));
    expect(report.workers.map((w) => w.id)).toEqual(base.result.workers.map((w) => w.id));
    expect(report.resources.find((r) => r.name === "forklifts")?.utilization).toBe(base.result.resources.forklifts.utilization);
    expect(report.summary.find((s) => s.key === "fillRate")?.value).toMatch(/%$/);
    expect(report.kpis).toEqual(base.kpis);
    expect(report.title).toContain("week 36");
    expect(reportFileStem(report)).toBe("twin-report-dc-east-wk36-5d-seed5");
  });

  it("recommends against the bottleneck and the tab that fixes it", async () => {
    await ready;
    expect(report.recommendations.length).toBeGreaterThan(0);
    for (const rec of report.recommendations) {
      expect(["high", "medium", "low"]).toContain(rec.severity);
      expect(rec.action).toMatch(/›/);
      expect(rec.finding.length).toBeGreaterThan(10);
    }
    // A run with the crew stretched (Halloween week, one forklift) must flag service or labor as high.
    const stressed = await run({ startWeek: 44, days: 7, scenario: { forklifts: 1 } }, "stressed");
    const r2 = buildReport(stressed);
    const late = stressed.kpis.lateTrucks + stressed.kpis.notLoaded;
    if (late > 0) {
      const top = r2.recommendations[0];
      expect(top.severity).toBe("high");
      expect(top.finding).toContain("missed their departure");
    }
    const recs = recommend(stressed, r2.days, r2.processes);
    expect(recs).toEqual(r2.recommendations);
  });

  it("formats Markdown, CSV and JSON with the same numbers, and the previous run's deltas", async () => {
    await ready;
    const other = await run({ seed: 5, scenario: { demandScale: 1.3 } }, "heavier");
    const r2 = buildReport(other, { label: base.label, kpis: base.kpis });
    const md = reportMarkdown(r2);
    expect(md).toContain("# Scenario report");
    expect(md).toContain("## Day by day");
    expect(md).toContain("## Against the previous run (run)");
    expect(md).toContain("## What to change");
    expect(md.split("\n").filter((l) => l.startsWith("| Day ")).length).toBe(r2.days.length);
    expect(r2.previous?.deltas.find((d) => d.key === "innersShipped")?.better).not.toBeNull();

    const csv = reportCsv(r2);
    const rows = csv.trim().split("\n");
    expect(rows).toHaveLength(r2.days.length + 1);
    expect(rows[0].split(",")[0]).toBe("day");
    const cols = rows[0].split(",");
    for (const row of rows.slice(1)) expect(row.split(",").length).toBe(cols.length);
    const shippedCol = cols.indexOf("inners_shipped");
    const shippedSum = rows.slice(1).reduce((a, row) => a + Number(row.split(",")[shippedCol]), 0);
    expect(shippedSum).toBe(other.result.volume.innersShipped);

    const json = JSON.parse(reportJson(r2)) as Report;
    expect(json.days.length).toBe(r2.days.length);
    expect(json.kpis.innersShipped).toBe(other.kpis.innersShipped);
    expect(json.recommendations).toEqual(r2.recommendations);
  });
});
