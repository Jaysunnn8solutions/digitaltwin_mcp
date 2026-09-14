/**
 * Pure helpers behind the /twin page's Optimize tab: the budget presets and
 * the time estimate, the levers grouped by area with a readable range, the
 * cost-assumption fields as text (like the scenario form, "" never happens
 * here: every field starts at its default), the spec built and validated from
 * the inputs, and the base-versus-plan rows the result table shows. No DOM,
 * no React.
 */

import { assumptionsFor, LEVERS, OBJECTIVES, OPTIMIZE_LIMITS, type Candidate, type CostAssumptions, type CostBreakdown, type LeverArea, type LeverDef, type LeverKey, type Objective, type OptimizeProgress, type OptimizeResult, type OptimizeSpec } from "../twin/optimize";
import type { Kpis } from "../twin/replicate";
import { clock } from "../twin/standards";
import type { TwinScenario } from "../twin/twin";
import { deltaClass, deltaText, KPI_BY_KEY, money, num, pct } from "./format";

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export type Budget = "quick" | "standard" | "thorough";

export const BUDGETS: Record<Budget, { label: string; population: number; generations: number }> = {
  quick: { label: "Quick", population: 12, generations: 8 },
  standard: { label: "Standard", population: 20, generations: 20 },
  thorough: { label: "Thorough", population: 30, generations: 40 },
};
export const BUDGET_KEYS: readonly Budget[] = ["quick", "standard", "thorough"];

/**
 * A rough figure for the estimate shown before a search starts: a simulated
 * week costs the engine 25–50 ms on a laptop under Node, and a browser worker
 * has run several times slower than that. Generation 0 is evaluated too,
 * hence generations + 1. Once the search runs, remainingMs() uses the
 * measured rate instead.
 */
export const MS_PER_WEEK_EVAL = 120;

export function estimateMs(population: number, generations: number, seeds: number, days: number): number {
  return population * (generations + 1) * seeds * (days / 7) * MS_PER_WEEK_EVAL;
}

export function estimateText(ms: number): string {
  return `about ${Math.max(1, Math.round(ms / 1000))} s`;
}

/**
 * Time left from what the search has measured so far: its own elapsed time
 * per evaluation, times the evaluations the remaining generations would add
 * at the rate the finished ones did (memoized plans make later generations
 * cheaper, so this errs long).
 */
export function remainingMs(p: OptimizeProgress): number {
  if (p.evaluations === 0 || p.generation >= p.generations) return 0;
  const perEval = p.ms / p.evaluations;
  const perGeneration = p.evaluations / (p.generation + 1);
  return perEval * perGeneration * (p.generations - p.generation);
}

// ---------------------------------------------------------------------------
// Levers
// ---------------------------------------------------------------------------

export const LEVER_AREAS: readonly LeverArea[] = ["Labor", "Space", "Supply", "Deliveries"];

/** The levers in area order, each area in LEVERS order; areas without a lever are left out. */
export function leversByArea(levers: readonly LeverDef[] = LEVERS): Array<{ area: LeverArea; levers: LeverDef[] }> {
  return LEVER_AREAS.map((area) => ({ area, levers: levers.filter((l) => l.area === area) })).filter((g) => g.levers.length > 0);
}

/** The lever's range or choices, short: "0–3", "on / off", "current / optimized", "12:00 … 17:00 (every 30 min)". */
export function leverRange(l: LeverDef): string {
  if (l.kind === "bool") return "on / off";
  if (l.kind === "int") return `${l.min}–${l.max}`;
  const choices = l.choices ?? [];
  if (l.field.startsWith("times.")) {
    const mins = choices.map(Number);
    return `${clock(mins[0])} … ${clock(mins[mins.length - 1])} (${choices.length} times)`;
  }
  return choices.map(String).join(" / ");
}

// ---------------------------------------------------------------------------
// Cost assumptions as text fields
// ---------------------------------------------------------------------------

export type AssumptionKey = keyof CostAssumptions;
export type AssumptionText = Record<AssumptionKey, string>;

export interface AssumptionMeta {
  key: AssumptionKey;
  label: string;
  help: string;
  /** The three fields the objective preset sets. */
  penalty: boolean;
  max?: number;
}

export const ASSUMPTION_META: readonly AssumptionMeta[] = [
  { key: "lateTruckPenalty", label: "Late truck, $", help: "Charged per store truck that leaves late.", penalty: true },
  { key: "lateMinutePenalty", label: "Late minute, $", help: "Per minute late, on top of the flat penalty.", penalty: true },
  { key: "unloadedTruckPenalty", label: "Unloaded truck, $", help: "Per released order never loaded by the end of the run.", penalty: true },
  { key: "cutMargin", label: "Cut margin, share", help: "Share of a cut order's retail value counted as lost; 1 − cost of goods by default.", penalty: false, max: 1 },
  { key: "carryingRate", label: "Carrying rate, per year", help: "Annual carrying cost of stock as a share of its cost value, charged weekly on the average held.", penalty: false, max: 5 },
  { key: "forkliftWeekly", label: "Forklift, $/week", help: "A forklift beyond (or saved below) the building's count: lease, charging, maintenance.", penalty: false },
  { key: "palletJackWeekly", label: "Pallet jack, $/week", help: "A pallet jack beyond the building's count.", penalty: false },
  { key: "doorWeekly", label: "Dock door, $/week", help: "A door beyond the building's count: leveler, seal and bumpers amortized.", penalty: false },
  { key: "hireWeekly", label: "Hire, $/week", help: "A full-time hire's one-off cost spread over a year; part-time counts half.", penalty: false },
  { key: "crossTrainWeekly", label: "Cross-training, $/week", help: "One person's training spread over six months.", penalty: false },
];

export const ASSUMPTION_KEYS: readonly AssumptionKey[] = ASSUMPTION_META.map((m) => m.key);
export const PENALTY_KEYS: readonly AssumptionKey[] = ASSUMPTION_META.filter((m) => m.penalty).map((m) => m.key);

export function assumptionsText(a: CostAssumptions): AssumptionText {
  return Object.fromEntries(ASSUMPTION_KEYS.map((k) => [k, String(a[k])])) as AssumptionText;
}

/** The three penalty fields at the objective's values, the rest kept as typed. */
export function resetPenalties(text: AssumptionText, objective: Objective): AssumptionText {
  const o = OBJECTIVES[objective];
  return { ...text, lateTruckPenalty: String(o.lateTruckPenalty), lateMinutePenalty: String(o.lateMinutePenalty), unloadedTruckPenalty: String(o.unloadedTruckPenalty) };
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function numberAt(text: string): number | null {
  const s = text.trim();
  return DECIMAL.test(s) ? Number(s) : null;
}

/** Every field parsed; a blank field means the objective's default. Errors are keyed by assumption. */
export function parseAssumptions(text: AssumptionText, objective: Objective): { values: Partial<CostAssumptions>; errors: Partial<Record<AssumptionKey, string>> } {
  const defaults = assumptionsFor(objective);
  const values: Partial<CostAssumptions> = {};
  const errors: Partial<Record<AssumptionKey, string>> = {};
  for (const m of ASSUMPTION_META) {
    const t = text[m.key].trim();
    if (t === "") continue;
    const n = numberAt(t);
    if (n === null || !Number.isFinite(n)) errors[m.key] = `"${t}" is not a number.`;
    else if (n < 0) errors[m.key] = "Cannot be negative.";
    else if (m.max !== undefined && n > m.max) errors[m.key] = `At most ${m.max}.`;
    else if (n !== defaults[m.key]) values[m.key] = n;
  }
  return { values, errors };
}

// ---------------------------------------------------------------------------
// The spec from the inputs
// ---------------------------------------------------------------------------

export interface OptimizeInputs {
  objective: Objective;
  levers: LeverKey[];
  budget: Budget;
  /** As typed. */
  seeds: string;
  days: string;
  assumptions: AssumptionText;
}

export interface OptimizeBase {
  dc: string;
  startWeek: number;
  /** The scenario the Scenario tab describes, with an imported building's layout. */
  scenario: TwinScenario;
}

export type InputErrors = Partial<Record<"levers" | "seeds" | "days" | AssumptionKey, string>>;

export function defaultInputs(): OptimizeInputs {
  return { objective: "balanced", levers: [], budget: "quick", seeds: "1", days: "7", assumptions: assumptionsText(assumptionsFor("balanced")) };
}

function intIn(text: string, name: string, lim: { min: number; max: number }, errors: InputErrors, key: "seeds" | "days"): number | null {
  const n = numberAt(text);
  if (n === null || !Number.isInteger(n)) {
    errors[key] = `${name} must be a whole number from ${lim.min} to ${lim.max}.`;
    return null;
  }
  if (n < lim.min || n > lim.max) {
    errors[key] = `${name} must be from ${lim.min} to ${lim.max}.`;
    return null;
  }
  return n;
}

/** The request's spec, or the errors that stop it. The algorithm's own seed is fixed, so the same inputs give the same plan. */
export function buildSpec(inputs: OptimizeInputs, base: OptimizeBase): { spec: OptimizeSpec; errors: InputErrors } | { spec: null; errors: InputErrors } {
  const errors: InputErrors = {};
  const levers = [...new Set(inputs.levers)];
  if (levers.length === 0) errors.levers = "Pick at least one lever.";
  const seeds = intIn(inputs.seeds, "Seeds", OPTIMIZE_LIMITS.seeds, errors, "seeds");
  const days = intIn(inputs.days, "Days", OPTIMIZE_LIMITS.days, errors, "days");
  const parsed = parseAssumptions(inputs.assumptions, inputs.objective);
  Object.assign(errors, parsed.errors);
  if (Object.keys(errors).length || seeds === null || days === null) return { spec: null, errors };
  const b = BUDGETS[inputs.budget];
  const spec: OptimizeSpec = {
    dc: base.dc,
    startWeek: base.startWeek,
    days,
    seeds,
    base: base.scenario,
    levers,
    objective: inputs.objective,
    population: b.population,
    generations: b.generations,
    seed: 1,
  };
  if (Object.keys(parsed.values).length) spec.assumptions = parsed.values;
  return { spec, errors };
}

/** The estimate for the inputs as they stand; unreadable seeds or days count as their defaults. */
export function estimateFor(inputs: OptimizeInputs): number {
  const b = BUDGETS[inputs.budget];
  const seeds = numberAt(inputs.seeds) ?? 1;
  const days = numberAt(inputs.days) ?? 7;
  const lim = OPTIMIZE_LIMITS;
  return estimateMs(b.population, b.generations, Math.min(lim.seeds.max, Math.max(lim.seeds.min, seeds)), Math.min(lim.days.max, Math.max(lim.days.min, days)));
}

// ---------------------------------------------------------------------------
// Result rows
// ---------------------------------------------------------------------------

export interface PlanRow {
  key: string;
  label: string;
  base: string;
  plan: string;
  delta: string;
  cls: "good" | "bad" | "";
}

const COST_ROWS: ReadonlyArray<[keyof CostBreakdown, string]> = [
  ["labor", "Labor, per week"],
  ["people", "Hires and training"],
  ["equipment", "Equipment and doors"],
  ["service", "Late, unloaded, cut"],
  ["inventory", "Stock carrying"],
  ["total", "Total, per week"],
];

const NONE = "—";

/** money() with the sign in front of the dollar: a plan that removes a pallet jack has a negative equipment line. */
function signedMoney(n: number): string {
  return n < 0 ? `−${money(-n)}` : money(n);
}

/** Signed money delta; lower is better on every cost row. */
function moneyDelta(a: number, b: number): { delta: string; cls: PlanRow["cls"] } {
  const d = b - a;
  if (Math.abs(d) < 0.5) return { delta: "±0", cls: "" };
  return { delta: `${d > 0 ? "+" : "−"}${money(Math.abs(d))}`, cls: d > 0 ? "bad" : "good" };
}

/** The five cost components and the total, base against the plan, formatted with money. */
export function costRows(base: Candidate, plan: Candidate): PlanRow[] {
  return COST_ROWS.map(([key, label]) => {
    const a = base.cost?.[key];
    const b = plan.cost?.[key];
    const d = a !== undefined && b !== undefined ? moneyDelta(a, b) : { delta: NONE, cls: "" as const };
    return { key, label, base: a === undefined ? NONE : signedMoney(a), plan: b === undefined ? NONE : signedMoney(b), ...d };
  });
}

/** The KPIs the plan is judged on, in the order the table shows them. */
export const PLAN_KPIS: readonly (keyof Kpis)[] = ["lateTrucks", "notLoaded", "fillRate", "cutDollars", "laborCost", "overtimeHours", "utilization", "dockToStockP90Min"];

/** Mean KPIs over the evaluation seeds, base against the plan, with the delta coloured the way the compare panel colours it. */
export function kpiRows(base: Candidate, plan: Candidate): PlanRow[] {
  return PLAN_KPIS.map((key) => {
    const m = KPI_BY_KEY.get(key)!;
    const a = base.kpis?.[key];
    const b = plan.kpis?.[key];
    const has = a !== undefined && b !== undefined;
    return { key, label: m.label, base: a === undefined ? NONE : m.fmt(a), plan: b === undefined ? NONE : m.fmt(b), delta: has ? deltaText(key, a, b) : NONE, cls: has ? deltaClass(key, a, b) : "" };
  });
}

/** "saves $1.2k/week (8%)" or "costs $300/week more (2%)"; null when either side is infeasible. */
export function savingText(base: Candidate, plan: Candidate): { text: string; cls: PlanRow["cls"] } | null {
  if (!base.cost || !plan.cost) return null;
  const d = base.cost.total - plan.cost.total;
  const share = base.cost.total > 0 ? Math.abs(d) / base.cost.total : 0;
  if (Math.abs(d) < 0.5) return { text: "same weekly total as the base", cls: "" };
  return d > 0 ? { text: `saves ${money(d)}/week (${pct(share)})`, cls: "good" } : { text: `costs ${money(-d)}/week more (${pct(share)})`, cls: "bad" };
}

/** The search in one line: objective, evaluations, cache hits, generations, convergence, time. */
export function searchLegend(r: OptimizeResult): string {
  const gens = r.history.length;
  return `${OBJECTIVES[r.spec.objective].label} · ${num(r.evaluations)} evaluations, ${num(r.cacheHits)} cache hits · ${gens} generation${gens === 1 ? "" : "s"}${r.converged ? ", converged" : ""} · ${r.spec.seeds} seed${r.spec.seeds === 1 ? "" : "s"} × ${r.spec.days} days · ${num(r.ms)} ms`;
}

/** The assumptions the result was priced with, in one line. */
export function assumptionsLegend(a: CostAssumptions): string {
  return [
    `late truck ${money(a.lateTruckPenalty)} + ${money(a.lateMinutePenalty)}/min`,
    `unloaded ${money(a.unloadedTruckPenalty)}`,
    `cut margin ${pct(a.cutMargin)}`,
    `carrying ${pct(a.carryingRate)}/yr`,
    `forklift ${money(a.forkliftWeekly)}/wk`,
    `jack ${money(a.palletJackWeekly)}/wk`,
    `door ${money(a.doorWeekly)}/wk`,
    `hire ${money(a.hireWeekly)}/wk`,
    `cross-training ${money(a.crossTrainWeekly)}/wk`,
  ].join(" · ");
}

/** The plan's scenario as the form takes it: an imported building's layout stays with the building, not the form. */
export function stripLayout(s: TwinScenario): TwinScenario {
  const { layout, ...rest } = s;
  void layout;
  return rest;
}
