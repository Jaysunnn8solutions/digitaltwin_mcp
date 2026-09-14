/**
 * The optimizer as a tool: a genetic search over the operation's levers
 * (lib/twin/optimize.ts) that returns the best plan found, priced by stated
 * assumptions, with the plan's scenario ready for simulate_operations, what_if
 * or the 3D page. The hosted function has 60 s, so the budget is capped in
 * evaluation-weeks before the search starts rather than timing out midway.
 */

import { DEFAULT_LEVERS, LEVER_KEYS, LEVERS, OBJECTIVES, OPTIMIZE_LIMITS, optimize, type Candidate, type CostAssumptions, type LeverKey, type Objective, type OptimizeSpec } from "../twin/optimize";
import { buildTwin } from "../twin/twin";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { dcName, fmt1, fmtInt, guarded, kpiTable, money, pct, readOnlyOpenWorld, scenarioLine, signed, text, twinLink, z } from "./shared";

/**
 * The most engine-weeks (one seven-day run of one candidate) a hosted call may
 * spend: a week at dc-east takes about 50 ms, so 600 is about 30 s before
 * memoization, half of Vercel's limit. The browser's Optimize tab has no cap.
 */
export const MAX_EVALUATION_WEEKS = 600;

/** The search budget in engine-weeks: every generation (the first included) evaluates the whole population, each candidate once per seed. */
export function evaluationWeeks(population: number, generations: number, seeds: number, days: number): number {
  return (population * (generations + 1) * seeds * days) / 7;
}

const dollars = (what: string) => z.number().min(0).max(1e7).optional().describe(what);

const assumptionsShape = {
  lateTruckPenalty: dollars("Dollars charged per store truck that leaves late. The objective preset sets it unless given."),
  lateMinutePenalty: dollars("Dollars charged per minute late, on top of the flat penalty. The objective preset sets it unless given."),
  unloadedTruckPenalty: dollars("Dollars charged per released order never loaded by the end of the run. The objective preset sets it unless given."),
  cutMargin: z.number().min(0).max(1).optional().describe("Share of a cut order's retail value counted as lost margin. Default 1 − cost of goods."),
  forkliftWeekly: dollars("Weekly cost of a forklift beyond (or saved below) the building's count: lease, charging, maintenance. Default $350."),
  palletJackWeekly: dollars("Weekly cost of a pallet jack beyond the building's count. Default $30."),
  doorWeekly: dollars("Weekly cost of a dock door beyond the building's count, amortized. Default $300."),
  hireWeekly: dollars("A full-time hire's one-off cost spread over a year, per week; part-time counts half. Default from the cost rates."),
  crossTrainWeekly: dollars("One person's cross-training spread over six months, per week. Default from the cost rates."),
  carryingRate: z.number().min(0).max(2).optional().describe("Annual carrying cost of inventory as a share of its cost value (capital, space, shrink), charged weekly on the average stock held. Default 0.25."),
};

const leverList = LEVERS.map((l) => `${l.key} (${l.label.toLowerCase()}${l.kind === "int" ? `, ${l.min}–${l.max}` : l.kind === "choice" ? `: ${l.choices!.map(String).join("/")}` : ""})`).join("; ");

export const optimizeOperationsConfig = {
  title: "Optimize the operation",
  description:
    "Search the operation's levers for the cheapest plan: hires and part-timers by role, cross-training, flexing and the overtime cap, slotting and face sizes, forklifts, pallet jacks and doors, " +
    "the buyers' service level and forecast, and the store trucks' departure time. A genetic algorithm evaluates every candidate plan on the floor simulation and scores it as one weekly cost: " +
    "the engine's labor cost, amortized hires, training and equipment, the carrying cost of the stock held, and priced penalties for late or unloaded trucks and orders cut for lack of stock. Three objective presets weight service against cost; " +
    "every price is an input and is reported with the plan. Returns the operation as it is against the best plan, the cost breakdown, the changes, three alternatives, and the plan's scenario " +
    "for simulate_operations, what_if or the 3D page. Deterministic for a given seed. The other scenario fields describe the base operation the levers do not touch.",
  inputSchema: z
    .object({
      ...baseShape,
      days: z.number().int().min(OPTIMIZE_LIMITS.days.min).max(OPTIMIZE_LIMITS.days.max).default(7).describe("Days per evaluation from the Monday of startWeek; 7 sees a whole delivery week."),
      seeds: z.number().int().min(OPTIMIZE_LIMITS.seeds.min).max(OPTIMIZE_LIMITS.seeds.max).default(1).describe("Engine seeds 1..seeds averaged per candidate; 1 is fast, 2–3 smooth the dice."),
      objective: z
        .enum(["service", "balanced", "cost"])
        .default("balanced")
        .describe(
          `How dearly a late truck is priced: service (${OBJECTIVES.service.label}: $${OBJECTIVES.service.lateTruckPenalty} a late truck plus $${OBJECTIVES.service.lateMinutePenalty}/min, $${OBJECTIVES.service.unloadedTruckPenalty} a truck never loaded), ` +
            `balanced ($${OBJECTIVES.balanced.lateTruckPenalty} + $${OBJECTIVES.balanced.lateMinutePenalty}/min, $${OBJECTIVES.balanced.unloadedTruckPenalty}), cost (${OBJECTIVES.cost.label}: $${OBJECTIVES.cost.lateTruckPenalty} + $${OBJECTIVES.cost.lateMinutePenalty}/min, $${OBJECTIVES.cost.unloadedTruckPenalty}). ` +
            `Everything else is priced the same under every preset; assumptions override any of it.`
        ),
      levers: z
        .array(z.enum(LEVER_KEYS))
        .min(1)
        .max(LEVER_KEYS.length)
        .default(DEFAULT_LEVERS)
        .describe(`The levers the search may move; everything else stays as the base operation has it. Default: all but the doors, which are a building change. Levers: ${leverList}.`),
      population: z.number().int().min(OPTIMIZE_LIMITS.population.min).max(OPTIMIZE_LIMITS.population.max).default(16).describe("Plans per generation."),
      generations: z.number().int().min(OPTIMIZE_LIMITS.generations.min).max(OPTIMIZE_LIMITS.generations.max).default(12).describe("Generations after the first; the search stops early once the best has not improved for 8."),
      seed: z.number().int().min(1).max(1e9).default(1).describe("The search's own seed (selection, crossover, mutation). The same spec and seed give the same plan."),
      assumptions: z.object(assumptionsShape).strict().optional().describe("Prices behind the score, per week or per event; any subset overrides the preset and the defaults."),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof optimizeOperationsConfig.inputSchema>;

interface SearchArgs {
  dc: string;
  startWeek: number;
  days: number;
  seeds: number;
  objective: Objective;
  levers: LeverKey[];
  population: number;
  generations: number;
  seed: number;
  assumptions?: Partial<CostAssumptions>;
}

/** The refusal for a budget over the cap, with the largest settings that fit so the caller can retry without arithmetic. */
export function capMessage(a: SearchArgs): string {
  const weeks = evaluationWeeks(a.population, a.generations, a.seeds, a.days);
  const perGeneration = (a.population * a.seeds * a.days) / 7;
  const fits: string[] = [];
  const maxGenerations = Math.floor(MAX_EVALUATION_WEEKS / perGeneration) - 1;
  if (maxGenerations >= OPTIMIZE_LIMITS.generations.min) fits.push(`generations ${Math.min(maxGenerations, OPTIMIZE_LIMITS.generations.max)} with population ${a.population}, ${a.seeds} seed(s) and ${a.days} days`);
  const maxPopulation = Math.floor((MAX_EVALUATION_WEEKS * 7) / ((a.generations + 1) * a.seeds * a.days));
  if (maxPopulation >= OPTIMIZE_LIMITS.population.min) fits.push(`population ${Math.min(maxPopulation, OPTIMIZE_LIMITS.population.max)} with ${a.generations} generations, ${a.seeds} seed(s) and ${a.days} days`);
  if (a.seeds > 1 || a.days > 7) {
    const maxGen1 = Math.floor((MAX_EVALUATION_WEEKS * 7) / (a.population * 7)) - 1;
    if (maxGen1 >= OPTIMIZE_LIMITS.generations.min) fits.push(`generations ${Math.min(maxGen1, OPTIMIZE_LIMITS.generations.max)} with population ${a.population}, 1 seed and 7 days`);
  }
  return [
    `This search is ${fmt1(weeks)} evaluation-weeks (population ${a.population} × ${a.generations + 1} generations × ${a.seeds} seed(s) × ${a.days}/7 days) and the tool caps a call at ${MAX_EVALUATION_WEEKS}, so it finishes inside the hosted 60 s limit. It was not run.`,
    ``,
    `Largest budgets that fit:`,
    ...fits.map((f) => `- ${f}`),
    `- the defaults: population 16, 12 generations, 1 seed, 7 days (${fmt1(evaluationWeeks(16, 12, 1, 7))} evaluation-weeks)`,
    ``,
    `Memoized candidates make a converged search cheaper than the budget says, but the cap counts the worst case. The 3D page's Optimize tab runs the same search in your browser without a cap.`,
  ].join("\n");
}

function costRows(base: Candidate, best: Candidate): string[] {
  const b = base.cost!;
  const p = best.cost!;
  const rows: Array<[string, number, number]> = [
    ["Labor (engine)", b.labor, p.labor],
    ["People (hires, training, amortized)", b.people, p.people],
    ["Equipment and doors beyond the building's", b.equipment, p.equipment],
    ["Service penalties (late, unloaded, cut)", b.service, p.service],
    ["Inventory carrying (average stock held)", b.inventory, p.inventory],
    ["**Total**", b.total, p.total],
  ];
  return [`| Weekly cost | as it is | best plan | change |`, `|---|---:|---:|---:|`, ...rows.map(([label, x, y]) => `| ${label} | ${money(x)} | ${money(y)} | ${signed(y - x, money)} |`)];
}

function assumptionsSentence(a: CostAssumptions, objective: Objective): string {
  return (
    `Assumptions (${OBJECTIVES[objective].label.toLowerCase()}): a late truck costs ${money(a.lateTruckPenalty)} plus ${money(a.lateMinutePenalty)} a minute late, a truck never loaded ${money(a.unloadedTruckPenalty)}, ` +
    `an order cut for lack of stock ${pct(a.cutMargin)} of its retail value; a forklift beyond the building's is ${money(a.forkliftWeekly)}/week, a pallet jack ${money(a.palletJackWeekly)}/week, a door ${money(a.doorWeekly)}/week; ` +
    `a full-time hire ${money(a.hireWeekly)}/week (part-time half), cross-training ${money(a.crossTrainWeekly)}/week a person; stock held carries ${pct(a.carryingRate)} a year of its cost value. Costs are per week; a run shorter or longer than seven days is scaled.`
  );
}

export async function optimizeOperationsHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const a = rest as SearchArgs;
    if (evaluationWeeks(a.population, a.generations, a.seeds, a.days) > MAX_EVALUATION_WEEKS) return text(capMessage(a));

    // Built first: a base scenario the twin refuses (an unknown worker, a
    // missing category) fails here with its reason instead of after a search
    // in which every candidate was infeasible. The context is cached, so the
    // search's own base evaluation reuses it.
    const ctx = await buildTwin(a.dc, a.startWeek, scenario);
    const spec: OptimizeSpec = { dc: a.dc, startWeek: a.startWeek, days: a.days, seeds: a.seeds, base: scenario, levers: a.levers, objective: a.objective, assumptions: a.assumptions, population: a.population, generations: a.generations, seed: a.seed };
    const result = await optimize(spec);
    const { base, best } = result;
    if (!base.feasible || !base.kpis || !best.feasible || !best.kpis || !best.cost) {
      return text(`The twin could not run the base operation: ${base.error ?? best.error ?? "unknown reason"}.`);
    }
    const keepAsIs = best === base || best.changes.length === 0;
    const alternatives = result.top.filter((c) => c !== best && c.cost).slice(0, 3);
    const objectiveLabel = OBJECTIVES[a.objective].label.toLowerCase();
    const run = result.spec;

    return text(
      [
        `# Optimize ${dcName(ctx)}: ${run.days} days from week ${a.startWeek}, ${objectiveLabel} objective, ${run.population} plans × ${run.generations} generation${run.generations === 1 ? "" : "s"} × ${run.seeds} seed(s)`,
        `Base operation, applied to every plan: ${scenarioLine(ctx).replace(/^Scenario: /, "")} Levers: ${result.levers.join(", ")}.`,
        assumptionsSentence(result.assumptions, a.objective),
        ``,
        kpiTable([["as it is", base.kpis], ["best plan", best.kpis]], true),
        ``,
        ...costRows(base, best),
        ``,
        `**The plan:**`,
        ...(keepAsIs ? [`- keep the operation as it is: no plan the search tried costs less by these assumptions`] : best.changes.map((c) => `- ${c}`)),
        ``,
        `**Alternatives:**`,
        ...(alternatives.length ? alternatives.map((c) => `- ${money(c.cost!.total)}/week: ${c.changes.length ? c.changes.join("; ") : "the operation as it is"}`) : [`- none: every other plan the search tried was infeasible or identical`]),
        ``,
        `Search: ${fmtInt(result.evaluations)} plans evaluated, ${fmtInt(result.cacheHits)} cache hits, ${result.history.length} generation(s) run${result.converged ? " (converged early)" : ""}, ${fmtInt(result.ms)} ms; search seed ${a.seed}, engine seeds 1..${run.seeds} for every plan.`,
        ``,
        `The numbers are the engine's, means over the engine seeds. The recommendations price service and cost by the stated assumptions and are the best plan the search found, not a proof of optimality; raise population, generations or seeds, or change the assumptions, and compare.`,
        ``,
        `The best plan's scenario, to pass to simulate_operations or what_if:`,
        "```json",
        JSON.stringify(best.scenario, null, 2),
        "```",
        ``,
        // Seed 1 is one of the seeds every candidate was scored on, so the page replays a run the plan's mean includes.
        twinLink(a.dc, a.startWeek, run.days, best.scenario),
      ].join("\n")
    );
  });
}
