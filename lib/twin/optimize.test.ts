/**
 * The genetic optimizer: the base genome mirrors the site, genomes become
 * scenarios the twin accepts, the cost model prices what a plan adds and what
 * it fails at, and a short search is deterministic, never worse than the
 * operation as it is, and finds the obvious single-lever fix.
 */

import { describe, expect, it } from "vitest";
import { findSite } from "../data/store";
import { assumptionsFor, baseGenome, DEFAULT_LEVERS, describeChanges, genomeToScenario, LEVERS, optimize, type Genome, type OptimizeSpec } from "./optimize";
import { buildTwin } from "./twin";

const site = findSite("dc-east");

describe("levers", () => {
  it("base genome mirrors the site and the base scenario, and writes nothing when unchanged", () => {
    const g = baseGenome(site, {});
    expect(g.forklifts).toBe(site.equipment.forklifts);
    expect(g.inboundDoors).toBe(site.doors.inbound);
    expect(g.faceCases).toBe(site.pick.faceCases);
    expect(g.truckDeparture).toBe(14 * 60);
    expect(g.serviceLevel).toBe(0.97);
    expect(genomeToScenario(g, {}, g, site)).toEqual({});
    expect(describeChanges(g, g)).toEqual([]);
    const withBase = baseGenome(site, { forklifts: 3, slotting: "optimized", times: { truckDeparture: "15:10" } });
    expect(withBase.forklifts).toBe(3);
    expect(withBase.slotting).toBe("optimized");
    expect(withBase.truckDeparture).toBe(15 * 60);
  });

  it("turns a genome into a scenario the twin accepts, on top of the base scenario", async () => {
    const baseScenario = { demandScale: 1.2, addWorkers: [{ role: "receiver", shift: "day", type: "temp" as const, count: 1 }] };
    const g0 = baseGenome(site, baseScenario);
    const g: Genome = { ...g0, selectors: 2, selectorsPT: 1, trainSelectorsPack: true, forklifts: 3, slotting: "optimized", truckDeparture: 15 * 60, overtimeMax: 3, serviceLevel: 0.995 };
    const s = genomeToScenario(g, baseScenario, g0, site);
    expect(s.demandScale).toBe(1.2);
    expect(s.addWorkers).toHaveLength(3);
    expect(s.addWorkers![1]).toEqual({ role: "selector", shift: "day", type: "full-time", count: 2 });
    expect(s.crossTrain).toEqual([{ role: "Order selector", skill: "pack" }]);
    expect(s.forklifts).toBe(3);
    expect(s.slotting).toBe("optimized");
    expect(s.times).toEqual({ truckDeparture: "15:00" });
    expect(s.overtimeMaxHours).toBe(3);
    expect(s.serviceLevel).toBe(0.995);
    const ctx = await buildTwin("dc-east", 36, s);
    expect(ctx.workers.filter((w) => w.id.startsWith("NEW-")).length).toBe(4);
    expect(ctx.site.equipment.forklifts).toBe(3);
    const lines = describeChanges(g, g0);
    expect(lines).toContain("+2 order selectors (full-time)");
    expect(lines).toContain("cross-train order selectors on pack");
    expect(lines).toContain("trucks leave at 15:00");
    expect(lines.some((l) => l.startsWith("overtime cap 3 h/day (was"))).toBe(true);
  });

  it("every lever has a range or choices and a description", () => {
    for (const l of LEVERS) {
      if (l.kind === "int") expect(l.max!).toBeGreaterThan(l.min!);
      if (l.kind === "choice") expect(l.choices!.length).toBeGreaterThan(1);
      expect(l.describe(l.kind === "bool" ? true : l.kind === "choice" ? l.choices![0] : l.min!)).toBeTruthy();
    }
    expect(DEFAULT_LEVERS).not.toContain("inboundDoors");
  });

  it("prices service dearer under the service objective", () => {
    expect(assumptionsFor("service").lateTruckPenalty).toBeGreaterThan(assumptionsFor("balanced").lateTruckPenalty);
    expect(assumptionsFor("balanced").lateTruckPenalty).toBeGreaterThan(assumptionsFor("cost").lateTruckPenalty);
    expect(assumptionsFor("cost", { forkliftWeekly: 999 }).forkliftWeekly).toBe(999);
  });
});

describe("optimize", () => {
  const spec: OptimizeSpec = { dc: "dc-east", startWeek: 44, days: 3, seeds: 1, base: {}, levers: ["selectors", "slotting", "forklifts", "truckDeparture"], objective: "balanced", population: 8, generations: 3, seed: 1 };

  it("is deterministic, never worse than the base, reports every generation and prices the plan", async () => {
    const progress: number[] = [];
    const r1 = await optimize(spec, (p) => {
      progress.push(p.generation);
    });
    const r2 = await optimize(spec);
    expect(r2.best.genome).toEqual(r1.best.genome);
    expect(r2.history).toEqual(r1.history);
    expect(progress).toEqual(r1.history.map((h) => h.generation));
    expect(r1.base.feasible).toBe(true);
    expect(r1.best.cost!.total).toBeLessThanOrEqual(r1.base.cost!.total + 1e-9);
    expect(r1.evaluations).toBeGreaterThan(8);
    expect(r1.evaluations + r1.cacheHits).toBeGreaterThanOrEqual(r1.evaluations);
    expect(r1.top[0]).toBe(r1.best);
    expect(r1.top.every((c, i) => i === 0 || c.cost!.total >= r1.top[i - 1].cost!.total)).toBe(true);
    for (const h of r1.history) expect(Number.isFinite(h.best)).toBe(true);
    // Halloween week at Norcross runs late as it is: a plan that costs less overall must have bought service.
    const b = r1.base.kpis!;
    expect(b.lateTrucks + b.notLoaded).toBeGreaterThan(0);
    const c = r1.best.cost!;
    expect(c.total).toBeCloseTo(c.labor + c.people + c.equipment + c.service + c.inventory, 6);
    expect(c.inventory).toBeGreaterThan(0);
    if (r1.best !== r1.base) expect(r1.best.changes.length).toBeGreaterThan(0);
    expect(r1.assumptions.lateTruckPenalty).toBe(800);
  });

  it("finds a one-lever fix in the first generation and honours the lever list", async () => {
    // One lever, two values: generation 0 already holds both, so the answer is exact.
    const r = await optimize({ ...spec, levers: ["slotting"], population: 6, generations: 1 });
    expect(r.evaluations).toBe(2);
    for (const c of r.top) {
      for (const k of Object.keys(c.genome) as Array<keyof Genome>) if (k !== "slotting") expect(c.genome[k]).toBe(r.base.genome[k]);
    }
    expect(r.top.map((c) => c.genome.slotting).sort()).toEqual(["current", "optimized"]);
  });

  it("stops early when asked and refuses an empty lever list", async () => {
    const r = await optimize({ ...spec, generations: 10 }, undefined, () => true);
    expect(r.history).toHaveLength(1);
    await expect(optimize({ ...spec, levers: [] })).rejects.toThrow(/lever/);
  });
});
