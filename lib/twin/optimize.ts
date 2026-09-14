/**
 * A genetic algorithm over the operation's levers: crew, cross-training,
 * flexing and overtime, slotting and face sizes, forklifts, pallet jacks and
 * doors, the buyers' service level and forecast, and the store trucks'
 * departure time. Every candidate is a scenario the twin already accepts;
 * its fitness is a weekly cost with everything on one axis: the engine's
 * labor cost, the amortized cost of what the candidate adds (hires,
 * training, equipment, doors) and priced penalties for what it fails at
 * (late or unloaded trucks, orders cut for lack of stock). The assumptions
 * behind the prices are inputs, shown with the result, and three presets
 * weight service against cost.
 *
 * It runs wherever the engine runs: the page's Web Worker (free, nothing
 * leaves the browser) and the MCP tool. Deterministic: the same spec and
 * seed give the same plan, and every candidate is evaluated with the engine
 * seeds 1..n, so the winner replays exactly on the 3D page with seed 1.
 * A week at dc-east takes the engine about 50 ms, so a population of 20
 * over 25 generations is under a minute; candidates are memoized, so the
 * converged tail is cheap.
 */

import { findSite } from "../data/store";
import { randInt, seededRandom, type Rng } from "../util/random";
import { DEFAULT_POLICY } from "./inventory";
import { runOperations } from "./operations";
import { kpis, KPI_KEYS, type Kpis } from "./replicate";
import { ROLES } from "./roles";
import { clock, DEFAULT_COSTS, hhmm } from "./standards";
import { buildTwin, operationsOptions, type TwinContext, type TwinScenario } from "./twin";
import type { Site } from "./types";

// ---------------------------------------------------------------------------
// Levers
// ---------------------------------------------------------------------------

export type LeverKey =
  | "selectors"
  | "selectorsPT"
  | "receivers"
  | "forkliftOps"
  | "loaders"
  | "trainSelectorsPack"
  | "trainReceiversForklift"
  | "trainLoadersPick"
  | "flex"
  | "overtimeMax"
  | "slotting"
  | "faceCases"
  | "forklifts"
  | "palletJacks"
  | "inboundDoors"
  | "outboundDoors"
  | "serviceLevel"
  | "forecast"
  | "truckDeparture";

export type LeverArea = "Labor" | "Space" | "Supply" | "Deliveries";
export type GeneValue = number | string | boolean;

export interface LeverDef {
  key: LeverKey;
  label: string;
  area: LeverArea;
  /** Which scenario field the lever writes. */
  field: string;
  kind: "int" | "choice" | "bool";
  min?: number;
  max?: number;
  choices?: readonly GeneValue[];
  /** A value as the plan describes it. */
  describe: (v: GeneValue) => string;
}

const DEPARTURES = [720, 750, 780, 810, 840, 870, 900, 930, 960, 990, 1020] as const;
const SERVICE_LEVELS = [0.9, 0.95, 0.97, 0.985, 0.995] as const;

export const LEVERS: readonly LeverDef[] = [
  { key: "selectors", label: "Order selectors added (full-time)", area: "Labor", field: "addWorkers", kind: "int", min: 0, max: 3, describe: (v) => `+${v} order selector${v === 1 ? "" : "s"} (full-time)` },
  { key: "selectorsPT", label: "Order selectors added (part-time)", area: "Labor", field: "addWorkers", kind: "int", min: 0, max: 2, describe: (v) => `+${v} order selector${v === 1 ? "" : "s"} (part-time)` },
  { key: "receivers", label: "Receivers added", area: "Labor", field: "addWorkers", kind: "int", min: 0, max: 2, describe: (v) => `+${v} receiver${v === 1 ? "" : "s"}` },
  { key: "forkliftOps", label: "Forklift operators added", area: "Labor", field: "addWorkers", kind: "int", min: 0, max: 2, describe: (v) => `+${v} forklift operator${v === 1 ? "" : "s"}` },
  { key: "loaders", label: "Loaders added", area: "Labor", field: "addWorkers", kind: "int", min: 0, max: 2, describe: (v) => `+${v} loader${v === 1 ? "" : "s"}` },
  { key: "trainSelectorsPack", label: "Cross-train order selectors on pack", area: "Labor", field: "crossTrain", kind: "bool", describe: (v) => (v ? "cross-train order selectors on pack" : "no pack training for selectors") },
  { key: "trainReceiversForklift", label: "Cross-train receivers on forklift", area: "Labor", field: "crossTrain", kind: "bool", describe: (v) => (v ? "cross-train receivers on forklift" : "no forklift training for receivers") },
  { key: "trainLoadersPick", label: "Cross-train loaders on pick", area: "Labor", field: "crossTrain", kind: "bool", describe: (v) => (v ? "cross-train loaders on pick" : "no pick training for loaders") },
  { key: "flex", label: "Flex across skills", area: "Labor", field: "flex", kind: "bool", describe: (v) => (v ? "flexing on" : "flexing off") },
  { key: "overtimeMax", label: "Overtime cap, h/day", area: "Labor", field: "overtimeMaxHours", kind: "int", min: 0, max: 4, describe: (v) => `overtime cap ${v} h/day` },
  { key: "slotting", label: "Slotting", area: "Space", field: "slotting", kind: "choice", choices: ["current", "optimized"], describe: (v) => `${v} slotting` },
  { key: "faceCases", label: "Pick-face cases", area: "Space", field: "faceCases", kind: "int", min: 1, max: 8, describe: (v) => `${v} case${v === 1 ? "" : "s"} per pick face` },
  { key: "forklifts", label: "Forklifts", area: "Space", field: "forklifts", kind: "int", min: 1, max: 6, describe: (v) => `${v} forklift${v === 1 ? "" : "s"}` },
  { key: "palletJacks", label: "Pallet jacks", area: "Space", field: "palletJacks", kind: "int", min: 1, max: 6, describe: (v) => `${v} pallet jack${v === 1 ? "" : "s"}` },
  { key: "inboundDoors", label: "Inbound doors", area: "Space", field: "inboundDoors", kind: "int", min: 1, max: 6, describe: (v) => `${v} inbound door${v === 1 ? "" : "s"}` },
  { key: "outboundDoors", label: "Outbound doors", area: "Space", field: "outboundDoors", kind: "int", min: 1, max: 6, describe: (v) => `${v} outbound door${v === 1 ? "" : "s"}` },
  { key: "serviceLevel", label: "Cycle service level", area: "Supply", field: "serviceLevel", kind: "choice", choices: SERVICE_LEVELS, describe: (v) => `service level ${v}` },
  { key: "forecast", label: "Forecast", area: "Supply", field: "forecast", kind: "choice", choices: ["seasonal", "trailing"], describe: (v) => `${v} forecast` },
  { key: "truckDeparture", label: "Store truck departure", area: "Deliveries", field: "times.truckDeparture", kind: "choice", choices: DEPARTURES, describe: (v) => `trucks leave at ${clock(Number(v))}` },
];

export const LEVER_KEYS = LEVERS.map((l) => l.key) as LeverKey[];
const LEVER_BY_KEY = new Map(LEVERS.map((l) => [l.key, l]));

/** The levers a first run usually wants: everything but the doors, which are a building change. */
export const DEFAULT_LEVERS: LeverKey[] = LEVER_KEYS.filter((k) => k !== "inboundDoors" && k !== "outboundDoors");

export type Genome = Record<LeverKey, GeneValue>;

/** The operation as it is: every lever at the value the site and the base scenario give it. */
export function baseGenome(site: Site, base: TwinScenario): Genome {
  const departure = base.times?.truckDeparture ?? site.times.truckDeparture;
  const nearest = DEPARTURES.reduce((a, b) => (Math.abs(b - hhmm(departure)) < Math.abs(a - hhmm(departure)) ? b : a));
  const sl = base.serviceLevel ?? DEFAULT_POLICY.serviceLevel;
  const nearestSl = SERVICE_LEVELS.reduce((a, b) => (Math.abs(b - sl) < Math.abs(a - sl) ? b : a));
  return {
    selectors: 0,
    selectorsPT: 0,
    receivers: 0,
    forkliftOps: 0,
    loaders: 0,
    trainSelectorsPack: false,
    trainReceiversForklift: false,
    trainLoadersPick: false,
    flex: base.flex ?? true,
    overtimeMax: Math.round(base.overtimeMaxHours ?? 2),
    slotting: base.slotting ?? "current",
    faceCases: base.faceCases ?? site.pick.faceCases,
    forklifts: base.forklifts ?? site.equipment.forklifts,
    palletJacks: base.palletJacks ?? site.equipment.palletJacks,
    inboundDoors: base.inboundDoors ?? site.doors.inbound,
    outboundDoors: base.outboundDoors ?? site.doors.outbound,
    serviceLevel: nearestSl,
    forecast: base.forecast ?? DEFAULT_POLICY.forecast,
    truckDeparture: nearest,
  };
}

/**
 * The candidate as a scenario: the base scenario with the genes that differ
 * from the base genome written on top. Genes at their base value are left
 * alone, so the twin's change list names only what the plan changes.
 */
export function genomeToScenario(genome: Genome, base: TwinScenario, baseG: Genome, site: Site): TwinScenario {
  const s: TwinScenario = structuredClone(base);
  const shift = site.shifts[0].id;
  const adds: NonNullable<TwinScenario["addWorkers"]> = [...(s.addWorkers ?? [])];
  const addRole = (role: keyof typeof ROLES, type: "full-time" | "part-time", count: GeneValue) => {
    if (Number(count) > 0) adds.push({ role, shift, type, count: Number(count) });
  };
  addRole("selector", "full-time", genome.selectors);
  addRole("selector", "part-time", genome.selectorsPT);
  addRole("receiver", "full-time", genome.receivers);
  addRole("forklift", "full-time", genome.forkliftOps);
  addRole("loader", "full-time", genome.loaders);
  if (adds.length) s.addWorkers = adds;

  const trains: NonNullable<TwinScenario["crossTrain"]> = [...(s.crossTrain ?? [])];
  const train = (on: GeneValue, role: string, skill: "pack" | "forklift" | "pick") => {
    if (on && !trains.some((t) => t.role?.toLowerCase() === role.toLowerCase() && t.skill === skill)) trains.push({ role, skill });
  };
  train(genome.trainSelectorsPack, ROLES.selector.role, "pack");
  train(genome.trainReceiversForklift, ROLES.receiver.role, "forklift");
  train(genome.trainLoadersPick, ROLES.loader.role, "pick");
  if (trains.length) s.crossTrain = trains;

  if (genome.flex !== baseG.flex) s.flex = Boolean(genome.flex);
  if (genome.overtimeMax !== baseG.overtimeMax) s.overtimeMaxHours = Number(genome.overtimeMax);
  if (genome.slotting !== baseG.slotting) s.slotting = genome.slotting as "current" | "optimized";
  if (genome.faceCases !== baseG.faceCases) s.faceCases = Number(genome.faceCases);
  if (genome.forklifts !== baseG.forklifts) s.forklifts = Number(genome.forklifts);
  if (genome.palletJacks !== baseG.palletJacks) s.palletJacks = Number(genome.palletJacks);
  if (genome.inboundDoors !== baseG.inboundDoors) s.inboundDoors = Number(genome.inboundDoors);
  if (genome.outboundDoors !== baseG.outboundDoors) s.outboundDoors = Number(genome.outboundDoors);
  if (genome.serviceLevel !== baseG.serviceLevel) s.serviceLevel = Number(genome.serviceLevel);
  if (genome.forecast !== baseG.forecast) s.forecast = genome.forecast as "seasonal" | "trailing";
  if (genome.truckDeparture !== baseG.truckDeparture) s.times = { ...(s.times ?? {}), truckDeparture: clock(Number(genome.truckDeparture)) };
  return s;
}

/** What the plan changes against the operation as it is, one line per lever. */
export function describeChanges(genome: Genome, baseG: Genome): string[] {
  const out: string[] = [];
  for (const l of LEVERS) {
    if (genome[l.key] === baseG[l.key]) continue;
    if ((l.kind === "int" && l.key !== "overtimeMax" && l.field !== "addWorkers" && Number(genome[l.key]) < Number(baseG[l.key])) || l.key === "overtimeMax") {
      out.push(`${l.describe(genome[l.key])} (was ${l.describe(baseG[l.key])})`);
    } else out.push(l.describe(genome[l.key]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

export interface CostAssumptions {
  /** Charged per store truck that leaves late. */
  lateTruckPenalty: number;
  /** Charged per minute late, on top of the flat penalty. */
  lateMinutePenalty: number;
  /** Charged per released order never loaded by the end of the run. */
  unloadedTruckPenalty: number;
  /** Share of a cut order's retail value counted as lost (margin); the default is 1 − cost of goods. */
  cutMargin: number;
  /** Weekly cost of a forklift beyond (or saved below) the building's count: lease, charging, maintenance. */
  forkliftWeekly: number;
  palletJackWeekly: number;
  /** Weekly cost of a dock door beyond the building's count: the leveler, seal and bumpers amortized. */
  doorWeekly: number;
  /** A new full-time hire's one-off cost spread over a year; part-time counts half. */
  hireWeekly: number;
  /** One person's cross-training spread over six months. */
  crossTrainWeekly: number;
  /** Annual carrying cost of inventory as a share of its cost value (capital, space, shrink); charged weekly on the average stock held. */
  carryingRate: number;
}

export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  lateTruckPenalty: 800,
  lateMinutePenalty: 3,
  unloadedTruckPenalty: 2500,
  cutMargin: Math.round((1 - DEFAULT_COSTS.costOfGoods) * 100) / 100,
  forkliftWeekly: 350,
  palletJackWeekly: 30,
  doorWeekly: 300,
  hireWeekly: Math.round(DEFAULT_COSTS.hireCost / 52),
  crossTrainWeekly: Math.round(DEFAULT_COSTS.crossTrainCost / 26),
  carryingRate: 0.25,
};

export type Objective = "service" | "balanced" | "cost";

/** The three presets differ only in how dearly a late truck is priced. */
export const OBJECTIVES: Record<Objective, { label: string; lateTruckPenalty: number; lateMinutePenalty: number; unloadedTruckPenalty: number }> = {
  service: { label: "Service first", lateTruckPenalty: 2500, lateMinutePenalty: 10, unloadedTruckPenalty: 6000 },
  balanced: { label: "Balanced", lateTruckPenalty: 800, lateMinutePenalty: 3, unloadedTruckPenalty: 2500 },
  cost: { label: "Cost first", lateTruckPenalty: 200, lateMinutePenalty: 1, unloadedTruckPenalty: 1000 },
};

export function assumptionsFor(objective: Objective, overrides: Partial<CostAssumptions> = {}): CostAssumptions {
  const o = OBJECTIVES[objective];
  return { ...DEFAULT_ASSUMPTIONS, lateTruckPenalty: o.lateTruckPenalty, lateMinutePenalty: o.lateMinutePenalty, unloadedTruckPenalty: o.unloadedTruckPenalty, ...overrides };
}

export interface CostBreakdown {
  /** The engine's labor cost, per week. */
  labor: number;
  /** Amortized hires and training, per week. */
  people: number;
  /** Equipment and doors beyond the building's own, per week (negative when the plan removes some). */
  equipment: number;
  /** Late, unloaded and cut penalties, per week. */
  service: number;
  /** Carrying cost of the average stock held, per week: what a higher service level or a slower forecast costs. */
  inventory: number;
  total: number;
}

export interface Candidate {
  genome: Genome;
  /** The scenario to run: the base with this plan on top. */
  scenario: TwinScenario;
  /** What the plan changes, one line per lever. */
  changes: string[];
  /** Means over the evaluation seeds; the same seeds for every candidate. */
  kpis: Kpis | null;
  cost: CostBreakdown | null;
  /** False when the twin refused the scenario (its message in `error`). */
  feasible: boolean;
  error?: string;
}

function meanKpis(list: Kpis[]): Kpis {
  const out = {} as Record<keyof Kpis, number>;
  for (const k of KPI_KEYS) out[k] = list.reduce((a, x) => a + x[k], 0) / list.length;
  return out as Kpis;
}

/** `inventoryRetail` is the average retail value of stock over the run; its cost value is that × cost of goods. */
export function costOf(k: Kpis, genome: Genome, baseG: Genome, ctx: TwinContext, days: number, a: CostAssumptions, inventoryRetail: number): CostBreakdown {
  const perWeek = 7 / days;
  const labor = k.laborCost * perWeek;
  const fullTime = Number(genome.selectors) + Number(genome.receivers) + Number(genome.forkliftOps) + Number(genome.loaders);
  const partTime = Number(genome.selectorsPT);
  const trained = (on: GeneValue, role: string) => (on ? ctx.workers.filter((w) => w.role.toLowerCase() === role.toLowerCase()).length : 0);
  const training = trained(genome.trainSelectorsPack, ROLES.selector.role) + trained(genome.trainReceiversForklift, ROLES.receiver.role) + trained(genome.trainLoadersPick, ROLES.loader.role);
  const people = (fullTime + 0.5 * partTime) * a.hireWeekly + training * a.crossTrainWeekly;
  const equipment =
    (Number(genome.forklifts) - Number(baseG.forklifts)) * a.forkliftWeekly +
    (Number(genome.palletJacks) - Number(baseG.palletJacks)) * a.palletJackWeekly +
    (Number(genome.inboundDoors) - Number(baseG.inboundDoors) + Number(genome.outboundDoors) - Number(baseG.outboundDoors)) * a.doorWeekly;
  const service = (k.lateTrucks * a.lateTruckPenalty + k.lateMinTotal * a.lateMinutePenalty + k.notLoaded * a.unloadedTruckPenalty + k.cutDollars * a.cutMargin) * perWeek;
  const inventory = (inventoryRetail * ctx.costs.costOfGoods * a.carryingRate) / 52;
  return { labor, people, equipment, service, inventory, total: labor + people + equipment + service + inventory };
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

export interface OptimizeSpec {
  dc: string;
  startWeek: number;
  /** Horizon per evaluation; 7 sees a whole delivery week. */
  days: number;
  /** Engine seeds 1..seeds averaged per candidate; 1 is fast, 2–3 smooth the dice. */
  seeds: number;
  /** The operation as it is. Fields the levers do not touch (demand, outages, an imported layout) apply to every candidate. */
  base: TwinScenario;
  levers: LeverKey[];
  objective: Objective;
  assumptions?: Partial<CostAssumptions>;
  population: number;
  generations: number;
  /** Stop when the best has not improved for this many generations. */
  patience?: number;
  /** The algorithm's own seed: selection, crossover and mutation draws. */
  seed: number;
}

export interface OptimizeProgress {
  generation: number;
  generations: number;
  evaluations: number;
  /** The operation as it is, so a progress line can show what the best so far saves. */
  base: Candidate;
  best: Candidate;
  /** Milliseconds since the search started: the caller's estimate of the rest comes from this, not a constant. */
  ms: number;
}

export interface OptimizeResult {
  spec: OptimizeSpec;
  assumptions: CostAssumptions;
  levers: LeverKey[];
  /** The operation as it is, evaluated the same way. */
  base: Candidate;
  best: Candidate;
  /** The best distinct plans, best first (the winner included). */
  top: Candidate[];
  history: Array<{ generation: number; best: number; mean: number }>;
  evaluations: number;
  cacheHits: number;
  ms: number;
  /** True when the search stopped early on patience. */
  converged: boolean;
}

export const OPTIMIZE_LIMITS = { population: { min: 6, max: 40 }, generations: { min: 1, max: 60 }, seeds: { min: 1, max: 3 }, days: { min: 3, max: 14 } } as const;

function geneKey(genome: Genome, levers: LeverKey[]): string {
  return levers.map((k) => `${k}=${String(genome[k])}`).join("|");
}

function randomGene(l: LeverDef, rng: Rng): GeneValue {
  if (l.kind === "bool") return rng() < 0.5;
  if (l.kind === "choice") return l.choices![randInt(rng, 0, l.choices!.length - 1)];
  return randInt(rng, l.min!, l.max!);
}

function mutateGene(l: LeverDef, v: GeneValue, rng: Rng): GeneValue {
  if (l.kind === "bool") return !v;
  if (l.kind === "choice") {
    const i = l.choices!.indexOf(v);
    // Ordered choices (departure times, service levels) mostly step to a neighbour; anything can still jump.
    if (i >= 0 && rng() < 0.7) return l.choices![Math.min(l.choices!.length - 1, Math.max(0, i + (rng() < 0.5 ? -1 : 1)))];
    return l.choices![randInt(rng, 0, l.choices!.length - 1)];
  }
  const n = Number(v);
  if (rng() < 0.7) return Math.min(l.max!, Math.max(l.min!, n + (rng() < 0.5 ? -1 : 1)));
  return randInt(rng, l.min!, l.max!);
}

/** Every one-lever step away from the base: the seeds of the first generation, so a single obvious fix is found in generation 0. */
function neighbours(baseG: Genome, levers: LeverKey[]): Genome[] {
  const out: Genome[] = [];
  for (const k of levers) {
    const l = LEVER_BY_KEY.get(k)!;
    const v = baseG[k];
    const candidates: GeneValue[] = l.kind === "bool" ? [!v] : l.kind === "choice" ? l.choices!.filter((c) => c !== v) : [Number(v) + 1, Number(v) - 1].filter((n) => n >= l.min! && n <= l.max!);
    for (const c of candidates) out.push({ ...baseG, [k]: c });
  }
  return out;
}

/**
 * Run the search. `onProgress` is awaited after every generation (the worker
 * posts it); `shouldStop` lets a caller end the search early and keep the
 * best so far.
 */
export async function optimize(spec: OptimizeSpec, onProgress?: (p: OptimizeProgress) => void | Promise<void>, shouldStop?: () => boolean): Promise<OptimizeResult> {
  const t0 = performance.now();
  const levers = [...new Set(spec.levers)].filter((k) => LEVER_BY_KEY.has(k));
  if (levers.length === 0) throw new RangeError("Pick at least one lever to optimize.");
  const population = Math.min(OPTIMIZE_LIMITS.population.max, Math.max(OPTIMIZE_LIMITS.population.min, Math.round(spec.population)));
  const generations = Math.min(OPTIMIZE_LIMITS.generations.max, Math.max(OPTIMIZE_LIMITS.generations.min, Math.round(spec.generations)));
  const seeds = Math.min(OPTIMIZE_LIMITS.seeds.max, Math.max(OPTIMIZE_LIMITS.seeds.min, Math.round(spec.seeds)));
  const days = Math.min(OPTIMIZE_LIMITS.days.max, Math.max(OPTIMIZE_LIMITS.days.min, Math.round(spec.days)));
  const patience = spec.patience ?? 8;
  const assumptions = assumptionsFor(spec.objective, spec.assumptions);
  const site = findSite(spec.dc);
  const baseG = baseGenome(site, spec.base);
  const rng = seededRandom((spec.seed * 2654435761) >>> 0);

  const memo = new Map<string, Candidate>();
  let evaluations = 0;
  let cacheHits = 0;

  const evaluate = async (genome: Genome): Promise<Candidate> => {
    const key = geneKey(genome, levers);
    const hit = memo.get(key);
    if (hit) {
      cacheHits++;
      return hit;
    }
    // Genes outside the levers stay at base, so equal keys mean equal scenarios.
    const full: Genome = { ...baseG };
    for (const k of levers) full[k] = genome[k];
    const scenario = genomeToScenario(full, spec.base, baseG, site);
    const changes = describeChanges(full, baseG);
    let cand: Candidate;
    try {
      const ctx = await buildTwin(spec.dc, spec.startWeek, scenario);
      const list: Kpis[] = [];
      let inventoryRetail = 0;
      for (let s = 1; s <= seeds; s++) {
        const r = runOperations(ctx, operationsOptions(ctx, days, s));
        list.push(kpis(r));
        inventoryRetail += (r.inventoryRetail.start + r.inventoryRetail.end) / 2 / seeds;
      }
      const k = meanKpis(list);
      cand = { genome: full, scenario, changes, kpis: k, cost: costOf(k, full, baseG, ctx, days, assumptions, inventoryRetail), feasible: true };
    } catch (err) {
      cand = { genome: full, scenario, changes, kpis: null, cost: null, feasible: false, error: err instanceof Error ? err.message : String(err) };
    }
    evaluations++;
    memo.set(key, cand);
    return cand;
  };
  const fitness = (c: Candidate) => (c.feasible && c.cost ? c.cost.total : Number.POSITIVE_INFINITY);

  // Generation 0: the operation as it is, every one-lever step, then random plans.
  const base = await evaluate(baseG);
  let pop: Genome[] = [baseG, ...neighbours(baseG, levers)];
  const seen = new Set(pop.map((g) => geneKey(g, levers)));
  // Bounded: a small lever space (one lever, two values) has fewer distinct plans than the population asks for.
  let tries = 0;
  while (pop.length < population && tries++ < population * 50) {
    const g: Genome = { ...baseG };
    for (const k of levers) g[k] = randomGene(LEVER_BY_KEY.get(k)!, rng);
    const key = geneKey(g, levers);
    if (!seen.has(key)) {
      seen.add(key);
      pop.push(g);
    }
  }
  if (pop.length > population) {
    // More one-lever steps than the population holds: keep the base and a random subset.
    const rest = pop.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = randInt(rng, 0, i);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    pop = [baseG, ...rest.slice(0, population - 1)];
  }

  const history: OptimizeResult["history"] = [];
  let best = base;
  let sinceImprovement = 0;
  let converged = false;
  const elite = Math.max(1, Math.round(population * 0.1));

  for (let gen = 0; gen <= generations; gen++) {
    const scored: Array<{ g: Genome; c: Candidate }> = [];
    for (const g of pop) scored.push({ g, c: await evaluate(g) });
    scored.sort((a, b) => fitness(a.c) - fitness(b.c));
    const feasible = scored.filter((s) => s.c.feasible);
    const genBest = scored[0].c;
    const improved = fitness(genBest) < fitness(best) - 1e-6;
    if (improved) {
      best = genBest;
      sinceImprovement = 0;
    } else sinceImprovement++;
    history.push({ generation: gen, best: fitness(best), mean: feasible.length ? feasible.reduce((a, s) => a + fitness(s.c), 0) / feasible.length : Number.POSITIVE_INFINITY });
    if (onProgress) await onProgress({ generation: gen, generations, evaluations, base, best, ms: performance.now() - t0 });
    if (gen === generations || (shouldStop && shouldStop())) break;
    if (sinceImprovement >= patience) {
      converged = true;
      break;
    }

    // Next generation: elites, then children of tournament winners, one random immigrant, no duplicates.
    const next: Genome[] = scored.slice(0, elite).map((s) => s.g);
    const keys = new Set(next.map((g) => geneKey(g, levers)));
    const tournament = () => {
      let pick = scored[randInt(rng, 0, scored.length - 1)];
      for (let i = 1; i < 3; i++) {
        const other = scored[randInt(rng, 0, scored.length - 1)];
        if (fitness(other.c) < fitness(pick.c)) pick = other;
      }
      return pick.g;
    };
    let guard = 0;
    while (next.length < population && guard++ < population * 20) {
      let child: Genome;
      if (next.length === population - 1 && rng() < 0.8) {
        child = { ...baseG };
        for (const k of levers) child[k] = randomGene(LEVER_BY_KEY.get(k)!, rng);
      } else {
        const a = tournament();
        const b = tournament();
        child = { ...baseG };
        for (const k of levers) child[k] = rng() < 0.5 ? a[k] : b[k];
        for (const k of levers) if (rng() < 0.2) child[k] = mutateGene(LEVER_BY_KEY.get(k)!, child[k], rng);
      }
      const key = geneKey(child, levers);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(child);
    }
    pop = next;
  }

  const top = [...memo.values()]
    .filter((c) => c.feasible)
    .sort((a, b) => fitness(a) - fitness(b))
    .slice(0, 6);
  return { spec: { ...spec, population, generations, seeds, days }, assumptions, levers, base, best, top, history, evaluations, cacheHits, ms: performance.now() - t0, converged };
}
