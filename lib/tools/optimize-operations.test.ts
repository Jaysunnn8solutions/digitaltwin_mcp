/**
 * The optimize_operations tool: a tiny search returns every section of the
 * report with a scenario the twin accepts and a 3D link (or says the base
 * wins), and a budget over the hosted cap is refused with settings that fit.
 */

import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../twin/twin";
import { capMessage, evaluationWeeks, MAX_EVALUATION_WEEKS, optimizeOperationsConfig, optimizeOperationsHandler } from "./optimize-operations";

const parse = (args: Record<string, unknown>) => optimizeOperationsConfig.inputSchema.parse(args);
type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const body = (r: Result) => r.content.find((c) => c.type === "text")?.text ?? "";
// guarded() returns a union in which only the failure branch carries isError.
const isError = (r: Result) => r.isError === true;

describe("optimize_operations", () => {
  it("reports the plan, the costs, the alternatives, the search and the plan's scenario", async () => {
    const args = parse({ dc: "dc-east", startWeek: 44, days: 3, population: 6, generations: 1, levers: ["slotting", "selectors"] });
    expect(args.objective).toBe("balanced");
    expect(args.seeds).toBe(1);
    const r = await optimizeOperationsHandler(args);
    expect(isError(r)).toBe(false);
    const md = body(r);
    expect(md).toMatch(/^# Optimize Norcross DC \(dc-east\): 3 days from week 44, balanced objective, 6 plans × 1 generation × 1 seed\(s\)/);
    expect(md).toContain("Base operation, applied to every plan: baseline. Levers: slotting, selectors.");
    expect(md).toContain("Assumptions (balanced): a late truck costs $800 plus $3 a minute late");
    expect(md).toContain("| KPI | as it is | best plan | change |");
    expect(md).toContain("| Late trucks |");
    expect(md).toContain("| Weekly cost | as it is | best plan | change |");
    for (const row of ["| Labor (engine) |", "| People (hires, training, amortized) |", "| Equipment and doors beyond the building's |", "| Service penalties (late, unloaded, cut) |", "| Inventory carrying (average stock held) |", "| **Total** |"]) {
      expect(md).toContain(row);
    }
    expect(md).toContain("**The plan:**");
    expect(md).toContain("**Alternatives:**");
    expect(md).toMatch(/Search: \d+ plans evaluated, \d+ cache hits, \d+ generation\(s\) run/);
    expect(md).toContain("not a proof of optimality");
    expect(md).toContain("to pass to simulate_operations or what_if:");
    const json = /```json\n([\s\S]*?)\n```/.exec(md);
    expect(json).not.toBeNull();
    const scenario = scenarioSchema.parse(JSON.parse(json![1]));
    // Only the two levers may appear in the plan, and only when they changed.
    for (const k of Object.keys(scenario)) expect(["slotting", "addWorkers"]).toContain(k);
    const keep = md.includes("- keep the operation as it is");
    if (keep) {
      expect(scenario).toEqual({});
    } else {
      expect(Object.keys(scenario).length).toBeGreaterThan(0);
      expect(md).toContain("/twin#");
    }
  }, 60_000);

  it("is deterministic and honours a changed objective and assumptions", async () => {
    const args = parse({ dc: "dc-east", startWeek: 44, days: 3, population: 6, generations: 1, levers: ["slotting"], objective: "cost", assumptions: { forkliftWeekly: 999 } });
    const a = body(await optimizeOperationsHandler(args));
    const b = body(await optimizeOperationsHandler(args));
    // The search timing differs between calls; everything else is the engine's.
    const strip = (s: string) => s.replace(/, [\d,]+ ms;/, ";");
    expect(strip(a)).toBe(strip(b));
    expect(a).toContain("cost first objective");
    expect(a).toContain("Assumptions (cost first): a late truck costs $200 plus $1 a minute late");
    expect(a).toContain("a forklift beyond the building's is $999/week");
  }, 60_000);

  it("refuses a budget over the hosted cap without running, and names budgets that fit", async () => {
    const args = parse({ dc: "dc-east", population: 40, generations: 60, seeds: 3, days: 14 });
    expect(evaluationWeeks(40, 60, 3, 14)).toBeGreaterThan(MAX_EVALUATION_WEEKS);
    const started = performance.now();
    const md = body(await optimizeOperationsHandler(args));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(md).toContain(`the tool caps a call at ${MAX_EVALUATION_WEEKS}`);
    expect(md).toContain("It was not run.");
    expect(md).toContain("Largest budgets that fit:");
    expect(md).toContain("- the defaults: population 16, 12 generations, 1 seed, 7 days");
    expect(md).not.toContain("The plan");
    // The defaults fit.
    expect(evaluationWeeks(16, 12, 1, 7)).toBeLessThanOrEqual(MAX_EVALUATION_WEEKS);
    // A suggested budget really fits.
    const m = /- generations (\d+) with population 40, 3 seed\(s\) and 14 days/.exec(capMessage({ dc: "dc-east", startWeek: 36, days: 14, seeds: 3, objective: "balanced", levers: ["slotting"], population: 40, generations: 60, seed: 1 }));
    expect(m).not.toBeNull();
    expect(evaluationWeeks(40, Number(m![1]), 3, 14)).toBeLessThanOrEqual(MAX_EVALUATION_WEEKS);
  });

  it("rejects an unknown center or an empty lever list through the guard and the schema", async () => {
    const r = await optimizeOperationsHandler(parse({ dc: "dc-north", days: 3, population: 6, generations: 1, levers: ["slotting"] }));
    expect(isError(r)).toBe(true);
    expect(() => parse({ dc: "dc-east", levers: [] })).toThrow();
    expect(() => parse({ dc: "dc-east", levers: ["nope"] })).toThrow();
    expect(() => parse({ dc: "dc-east", assumptions: { carryingRate: -1 } })).toThrow();
  });
});
