/**
 * Integration tests over the committed data: the inventory policy, the
 * operations simulation, the workforce plan and scenario handling.
 * Assertions are about direction and conservation, not calibrated values, so
 * editing the mock inputs does not break them.
 */
import { describe, expect, it } from "vitest";
import { runInventory } from "./inventory";
import { runOperations } from "./operations";
import { replicate } from "./replicate";
import { DEFAULT_COSTS } from "./standards";
import { buildTwin, operationsOptions } from "./twin";
import { buildWeekSchedule, planLabor } from "./workforce";

describe("inventory", () => {
  it("keeps fill high with a seasonal forecast, and a trailing one cuts more into Halloween", async () => {
    const ctx = await buildTwin("dc-east", 38, {});
    const opts = { startWeek: 38, days: 56, warmupWeeks: 8, delays: [], seed: 3, faceCases: 3 };
    const seasonal = runInventory(ctx.model, ctx.catalog, { ...opts, policy: { forecast: "seasonal", serviceLevel: 0.97 } });
    const trailing = runInventory(ctx.model, ctx.catalog, { ...opts, policy: { forecast: "trailing", serviceLevel: 0.97 } });
    const fill = (r: typeof seasonal) => r.book.totals.shippedInners / r.book.totals.orderedInners;
    expect(fill(seasonal)).toBeGreaterThan(0.97);
    expect(trailing.book.totals.cutDollars).toBeGreaterThan(seasonal.book.totals.cutDollars);
  });

  it("delays an importer's receipts when its lead time grows", async () => {
    const base = await buildTwin("dc-east", 36, {});
    const delayed = await buildTwin("dc-east", 36, { supplierDelays: [{ supplier: "SUP-IMP-LATAM", extraDays: 30, fromDay: -60, toDay: 60 }] });
    const opts = { startWeek: 36, days: 42, warmupWeeks: 8, seed: 3, faceCases: 3, policy: base.policy };
    const a = runInventory(base.model, base.catalog, { ...opts, delays: base.supplierDelays });
    const b = runInventory(delayed.model, delayed.catalog, { ...opts, delays: delayed.supplierDelays });
    const latamCut = (r: typeof a) => [...r.book.cuts].filter(([id]) => id.startsWith("S-LAT")).reduce((s, [, n]) => s + n, 0);
    expect(latamCut(b)).toBeGreaterThan(latamCut(a));
  });
});

describe("operations", () => {
  it("is reproducible for a seed", async () => {
    const ctx = await buildTwin("dc-west", 36, {});
    const a = runOperations(ctx, operationsOptions(ctx, 7, 5));
    const b = runOperations(ctx, operationsOptions(ctx, 7, 5));
    expect(b.service).toEqual(a.service);
    expect(b.labor).toEqual(a.labor);
  });

  it("conserves stock: shipped plus cut never exceeds ordered, and every loaded truck carries what it picked", async () => {
    const ctx = await buildTwin("dc-east", 36, {});
    const r = runOperations(ctx, operationsOptions(ctx, 14, 2));
    expect(r.volume.innersShipped + r.volume.cutInners).toBeLessThanOrEqual(r.volume.innersOrdered);
    const onTrucks = r.trucks.filter((t) => t.loadedAt !== null).reduce((a, t) => a + t.inners, 0);
    expect(onTrucks).toBeLessThanOrEqual(r.volume.innersShipped + 1e-9);
    expect(r.service.trucks).toBeGreaterThan(0);
    for (const w of r.workers) expect(w.busyHours).toBeLessThanOrEqual(w.paidHours + w.overtimeHours + 1);
  });

  it("ships an ordinary fortnight mostly on time and falls behind when demand grows", async () => {
    const base = replicate(await buildTwin("dc-east", 20, {}), 14, 2);
    const surge = replicate(await buildTwin("dc-east", 20, { demandScale: 1.8 }), 14, 2);
    expect(base.mean.onTimeRate).toBeGreaterThan(0.8);
    expect(surge.mean.lateTrucks).toBeGreaterThan(base.mean.lateTrucks);
    expect(surge.mean.utilization).toBeGreaterThan(base.mean.utilization);
  });

  it("slows putaway when the forklifts are down", async () => {
    const base = replicate(await buildTwin("dc-east", 36, {}), 7, 2);
    const down = replicate(await buildTwin("dc-east", 36, { forkliftOutages: [{ count: 2, fromDay: 0, toDay: 2 }] }), 7, 2);
    expect(down.mean.dockToStockAvgMin).toBeGreaterThan(base.mean.dockToStockAvgMin);
  });

  it("reduces replenishment work with optimized slotting", async () => {
    const base = replicate(await buildTwin("dc-east", 36, {}), 10, 2);
    const opt = replicate(await buildTwin("dc-east", 36, { slotting: "optimized" }), 10, 2);
    expect(opt.mean.replenishments).toBeLessThan(base.mean.replenishments);
    expect(opt.mean.busyHours).toBeLessThan(base.mean.busyHours);
  });
});

describe("workforce", () => {
  it("gives each present worker one primary a day and part-timers only their hours", async () => {
    const ctx = await buildTwin("dc-east", 36, {});
    const sched = buildWeekSchedule(ctx.workloadContext, ctx.workers, 0);
    for (const d of sched.days) {
      const ids = d.assignments.map((a) => a.worker);
      expect(new Set(ids).size).toBe(ids.length);
      for (const a of d.assignments) expect(ctx.workers.find((w) => w.id === a.worker)!.skills).toContain(a.primary);
    }
    for (const w of ctx.workers) expect(sched.hours[w.id] ?? 0).toBeLessThanOrEqual(w.maxWeeklyHours);
  });

  it("needs more hours in Halloween week than in September", async () => {
    const sept = await buildTwin("dc-east", 36, {});
    const oct = await buildTwin("dc-east", 44, {});
    const opts = { ...sept.scheduleOptions, maxOvertimePerWorker: 8 };
    const a = planLabor(sept.workloadContext, sept.workers, 1, DEFAULT_COSTS, opts).weeks[0];
    const b = planLabor(oct.workloadContext, oct.workers, 1, DEFAULT_COSTS, opts).weeks[0];
    expect(b.requiredHours).toBeGreaterThan(a.requiredHours * 1.5);
    expect(b.gapHours).toBeGreaterThanOrEqual(a.gapHours);
  });
});

describe("scenarios", () => {
  it("adds, removes and cross-trains people and rejects what cannot be", async () => {
    const ctx = await buildTwin("dc-west", 36, {
      addWorkers: [{ role: "selector", shift: "day", type: "temp", count: 2 }],
      removeWorkers: ["W-W-003"],
      crossTrain: [{ worker: "NEW-01", skill: "load" }],
    });
    expect(ctx.workers.map((w) => w.id)).toEqual(["W-W-001", "W-W-002", "NEW-01", "NEW-02"]);
    expect(ctx.workers.find((w) => w.id === "NEW-01")!.skills).toContain("load");
    expect(ctx.workers.find((w) => w.id === "NEW-02")!.skills).not.toContain("load");
    await expect(buildTwin("dc-west", 36, { addWorkers: [{ role: "selector", shift: "day", type: "temp", count: 1 }], crossTrain: [{ worker: "NEW-01", skill: "forklift" }] })).rejects.toThrow(/temp/);
    await expect(buildTwin("dc-west", 36, { removeWorkers: ["W-X-1"] })).rejects.toThrow(/Unknown worker/);
    await expect(buildTwin("dc-nowhere", 36, {})).rejects.toThrow(/Unknown distribution center/);
  });
});
