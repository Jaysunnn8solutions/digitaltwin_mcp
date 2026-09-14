/**
 * The Optimize tab's helpers: the estimate follows the budget, every lever
 * lands in one area with a readable range, the assumptions round-trip as
 * text and the objective resets only the three penalties, the spec is
 * refused for what the optimizer would refuse, and the result rows carry
 * the compare panel's colouring.
 */

import { describe, expect, it } from "vitest";
import { assumptionsFor, DEFAULT_ASSUMPTIONS, LEVERS, OPTIMIZE_LIMITS, type Candidate, type OptimizeResult } from "../twin/optimize";
import { KPI_KEYS, type Kpis } from "../twin/replicate";
import {
  ASSUMPTION_KEYS,
  assumptionsLegend,
  assumptionsText,
  buildSpec,
  BUDGETS,
  costRows,
  defaultInputs,
  estimateFor,
  estimateMs,
  estimateText,
  kpiRows,
  leverRange,
  leversByArea,
  MS_PER_WEEK_EVAL,
  parseAssumptions,
  PENALTY_KEYS,
  PLAN_KPIS,
  remainingMs,
  resetPenalties,
  savingText,
  searchLegend,
  stripLayout,
} from "./optimize-ui";

const zeroKpis = (over: Partial<Kpis> = {}): Kpis => ({ ...(Object.fromEntries(KPI_KEYS.map((k) => [k, 0])) as unknown as Kpis), ...over });

function candidate(total: number, over: Partial<Kpis> = {}, changes: string[] = []): Candidate {
  const genome = {} as Candidate["genome"];
  return { genome, scenario: {}, changes, kpis: zeroKpis(over), cost: { labor: total * 0.6, people: total * 0.1, equipment: total * 0.1, service: total * 0.1, inventory: total * 0.1, total }, feasible: true };
}

describe("budget and estimate", () => {
  it("counts generation 0, scales with seeds and days, and rounds to seconds", () => {
    expect(estimateMs(12, 8, 1, 7)).toBe(12 * 9 * MS_PER_WEEK_EVAL);
    expect(estimateMs(20, 20, 2, 14)).toBe(20 * 21 * 2 * 2 * MS_PER_WEEK_EVAL);
    // Measured rate: 4 generations of 10 evaluations took 2 s, so the 6 left take about 3 s; nothing left at the end.
    const cand = { genome: {} as never, scenario: {}, changes: [], kpis: null, cost: null, feasible: false };
    expect(remainingMs({ generation: 3, generations: 9, evaluations: 40, base: cand, best: cand, ms: 2000 })).toBe(3000);
    expect(remainingMs({ generation: 9, generations: 9, evaluations: 90, base: cand, best: cand, ms: 5000 })).toBe(0);
    expect(estimateText(4860)).toBe("about 5 s");
    expect(estimateText(120)).toBe("about 1 s");
    const inputs = defaultInputs();
    expect(estimateFor(inputs)).toBe(estimateMs(BUDGETS.quick.population, BUDGETS.quick.generations, 1, 7));
    // Unreadable or out-of-range text falls back to a value inside the limits rather than NaN.
    expect(estimateFor({ ...inputs, seeds: "x", days: "99" })).toBe(estimateMs(BUDGETS.quick.population, BUDGETS.quick.generations, 1, OPTIMIZE_LIMITS.days.max));
  });

  it("keeps every preset inside the optimizer's limits", () => {
    for (const b of Object.values(BUDGETS)) {
      expect(b.population).toBeGreaterThanOrEqual(OPTIMIZE_LIMITS.population.min);
      expect(b.population).toBeLessThanOrEqual(OPTIMIZE_LIMITS.population.max);
      expect(b.generations).toBeGreaterThanOrEqual(OPTIMIZE_LIMITS.generations.min);
      expect(b.generations).toBeLessThanOrEqual(OPTIMIZE_LIMITS.generations.max);
    }
  });
});

describe("levers", () => {
  it("groups every lever into one area, in Labor, Space, Supply, Deliveries order", () => {
    const groups = leversByArea();
    expect(groups.map((g) => g.area)).toEqual(["Labor", "Space", "Supply", "Deliveries"]);
    expect(groups.flatMap((g) => g.levers.map((l) => l.key)).sort()).toEqual(LEVERS.map((l) => l.key).sort());
  });

  it("describes ranges, switches, choices and departure times", () => {
    const by = (key: string) => LEVERS.find((l) => l.key === key)!;
    expect(leverRange(by("selectors"))).toBe("0–3");
    expect(leverRange(by("flex"))).toBe("on / off");
    expect(leverRange(by("slotting"))).toBe("current / optimized");
    expect(leverRange(by("serviceLevel"))).toBe("0.9 / 0.95 / 0.97 / 0.985 / 0.995");
    expect(leverRange(by("truckDeparture"))).toBe("12:00 … 17:00 (11 times)");
  });
});

describe("assumptions", () => {
  it("round-trips as text and lists every key", () => {
    const text = assumptionsText(DEFAULT_ASSUMPTIONS);
    expect(Object.keys(text).sort()).toEqual([...ASSUMPTION_KEYS].sort());
    expect(Object.keys(DEFAULT_ASSUMPTIONS).sort()).toEqual([...ASSUMPTION_KEYS].sort());
    expect(parseAssumptions(text, "balanced")).toEqual({ values: {}, errors: {} });
  });

  it("resets the three penalties to the objective and nothing else", () => {
    const text = { ...assumptionsText(assumptionsFor("balanced")), forkliftWeekly: "999" };
    const reset = resetPenalties(text, "service");
    expect(PENALTY_KEYS).toEqual(["lateTruckPenalty", "lateMinutePenalty", "unloadedTruckPenalty"]);
    expect(reset.lateTruckPenalty).toBe("2500");
    expect(reset.unloadedTruckPenalty).toBe("6000");
    expect(reset.forkliftWeekly).toBe("999");
  });

  it("keeps only what differs from the objective's defaults and refuses bad numbers", () => {
    const text = assumptionsText(assumptionsFor("cost"));
    const ok = parseAssumptions({ ...text, forkliftWeekly: "400", cutMargin: "0.4" }, "cost");
    expect(ok.values).toEqual({ forkliftWeekly: 400, cutMargin: 0.4 });
    expect(ok.errors).toEqual({});
    const bad = parseAssumptions({ ...text, hireWeekly: "1,5", doorWeekly: "-1", cutMargin: "2", carryingRate: "" }, "cost");
    expect(Object.keys(bad.errors).sort()).toEqual(["cutMargin", "doorWeekly", "hireWeekly"]);
    expect(bad.values).toEqual({});
    expect(assumptionsLegend(DEFAULT_ASSUMPTIONS)).toContain("carrying 25%/yr");
  });
});

describe("buildSpec", () => {
  const base = { dc: "dc-east", startWeek: 44, scenario: { demandScale: 1.2 } };

  it("builds a spec the optimizer accepts from the defaults plus levers", () => {
    const res = buildSpec({ ...defaultInputs(), levers: ["slotting", "slotting", "forklifts"] }, base);
    expect(res.errors).toEqual({});
    expect(res.spec).toMatchObject({ dc: "dc-east", startWeek: 44, days: 7, seeds: 1, base: { demandScale: 1.2 }, levers: ["slotting", "forklifts"], objective: "balanced", population: 12, generations: 8, seed: 1 });
    expect(res.spec!.assumptions).toBeUndefined();
    const custom = buildSpec({ ...defaultInputs(), levers: ["slotting"], budget: "thorough", assumptions: { ...defaultInputs().assumptions, doorWeekly: "500" } }, base);
    expect(custom.spec!.population).toBe(30);
    expect(custom.spec!.assumptions).toEqual({ doorWeekly: 500 });
  });

  it("refuses no levers, seeds and days outside the limits, and bad assumptions", () => {
    const none = buildSpec({ ...defaultInputs(), levers: [] }, base);
    expect(none.spec).toBeNull();
    expect(none.errors.levers).toMatch(/lever/);
    const out = buildSpec({ ...defaultInputs(), levers: ["flex"], seeds: "4", days: "2.5" }, base);
    expect(out.spec).toBeNull();
    expect(out.errors.seeds).toMatch(/1 to 3/);
    expect(out.errors.days).toMatch(/3 to 14/);
    const bad = buildSpec({ ...defaultInputs(), levers: ["flex"], assumptions: { ...defaultInputs().assumptions, lateTruckPenalty: "abc" } }, base);
    expect(bad.spec).toBeNull();
    expect(bad.errors.lateTruckPenalty).toMatch(/not a number/);
  });
});

describe("result rows", () => {
  const base = candidate(10_000, { lateTrucks: 4, fillRate: 0.97, utilization: 0.8 });
  const plan = candidate(9_000, { lateTrucks: 1, fillRate: 0.99, utilization: 0.85 }, ["optimized slotting"]);

  it("prices the five components and the total, lower being better", () => {
    const rows = costRows(base, plan);
    expect(rows.map((r) => r.key)).toEqual(["labor", "people", "equipment", "service", "inventory", "total"]);
    const total = rows[rows.length - 1];
    expect(total.base).toBe("$10.0k");
    expect(total.plan).toBe("$9,000");
    expect(total.delta).toBe("−$1,000");
    expect(total.cls).toBe("good");
    expect(costRows(plan, base)[5].cls).toBe("bad");
    // A plan that removes equipment has a negative line: the sign goes before the dollar.
    const removes = { ...plan, cost: { ...plan.cost!, equipment: -30 } };
    expect(costRows(base, removes)[2]).toMatchObject({ base: "$1,000", plan: "−$30", delta: "−$1,030", cls: "good" });
    expect(costRows({ ...base, cost: null, feasible: false }, plan)[0]).toMatchObject({ base: "—", delta: "—", cls: "" });
  });

  it("colours KPI deltas like the compare panel", () => {
    const rows = kpiRows(base, plan);
    expect(rows.map((r) => r.key)).toEqual([...PLAN_KPIS]);
    const late = rows.find((r) => r.key === "lateTrucks")!;
    expect(late).toMatchObject({ base: "4", plan: "1", delta: "−3", cls: "good" });
    const fill = rows.find((r) => r.key === "fillRate")!;
    expect(fill).toMatchObject({ base: "97.0%", plan: "99.0%", cls: "good" });
    expect(rows.find((r) => r.key === "notLoaded")).toMatchObject({ delta: "±0", cls: "" });
  });

  it("states the saving and the search", () => {
    expect(savingText(base, plan)).toEqual({ text: "saves $1,000/week (10%)", cls: "good" });
    expect(savingText(plan, base)).toEqual({ text: "costs $1,000/week more (11%)", cls: "bad" });
    expect(savingText(base, base)).toEqual({ text: "same weekly total as the base", cls: "" });
    expect(savingText({ ...base, cost: null }, plan)).toBeNull();
    const result: OptimizeResult = {
      spec: { dc: "dc-east", startWeek: 44, days: 7, seeds: 2, base: {}, levers: ["slotting"], objective: "service", population: 12, generations: 8, seed: 1 },
      assumptions: assumptionsFor("service"),
      levers: ["slotting"],
      base,
      best: plan,
      top: [plan, base],
      history: [
        { generation: 0, best: 9_000, mean: 9_500 },
        { generation: 1, best: 9_000, mean: 9_200 },
      ],
      evaluations: 14,
      cacheHits: 10,
      ms: 1234.5,
      converged: true,
    };
    expect(searchLegend(result)).toBe("Service first · 14 evaluations, 10 cache hits · 2 generations, converged · 2 seeds × 7 days · 1,235 ms");
  });

  it("strips an imported layout from a plan's scenario", () => {
    const layout = { name: "x" } as unknown as NonNullable<Candidate["scenario"]["layout"]>;
    expect(stripLayout({ slotting: "optimized", layout })).toEqual({ slotting: "optimized" });
    expect(stripLayout({ slotting: "optimized" })).toEqual({ slotting: "optimized" });
  });
});
