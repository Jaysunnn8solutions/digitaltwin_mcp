/**
 * Assemble a twin for one center and one scenario: the site with any facility
 * changes, its layout, the roster with people added, removed or cross-trained,
 * candystore's network (committed baseline or a live scenario), the demand
 * model, the slotting and its evaluation, and the inventory policy. Every
 * tool builds one of these and hands it to a model.
 */

import { z } from "zod";
import { findSite, loadCatalog, loadNetwork, loadRoster, UnknownIdError } from "../data/load";
import { fetchNetwork } from "./candystore";
import { buildDemandModel, type DemandModel } from "./demand";
import { DEFAULT_POLICY, type InventoryPolicy, type SupplierDelay } from "./inventory";
import { formatBytes, LIMITS, LimitError } from "../layout/limits";
import { layoutSpecSchema, type LayoutSpec } from "../layout/spec";
import { buildLayout, siteToSpec, withDoorCounts, type Layout } from "./layout";
import { NO_DISRUPTIONS, type Disruptions, type OperationsOptions } from "./operations";
import { ROLE_KEYS, ROLES } from "./roles";
import {
  evaluateSlotting,
  faceSizesFor,
  skuFrequencies,
  slottingFor,
  type FaceSizes,
  type SkuFrequency,
  type Slotting,
  type SlottingEvaluation,
  type SlottingPolicy,
} from "./slotting";
import { DEFAULT_COSTS, DEFAULT_STANDARDS } from "./standards";
import { DEFAULT_SCHEDULE_OPTIONS, type ScheduleOptions, type WeekSchedule, type WorkloadContext } from "./workforce";
import { SKILLS, type Catalog, type CostRates, type LaborStandards, type Network, type Site, type Worker } from "./types";

// ---------------------------------------------------------------------------
// Scenario schema, shared by every tool
// ---------------------------------------------------------------------------

const daySpan = {
  fromDay: z.number().int().min(0).max(364).describe("First horizon day affected; day 0 is the Monday of startWeek."),
  toDay: z.number().int().min(0).max(364).describe("Last horizon day affected, inclusive."),
};

export const scenarioShape = {
  layout: layoutSpecSchema.optional(),
  demandScale: z.number().min(0.1).max(5).optional().describe("Multiply candystore's store demand, e.g. 1.3 for 30% more."),
  demandShocks: z
    .array(z.object({ ...daySpan, factor: z.number().min(0).max(10), category: z.string().max(40).optional() }).strict())
    .max(20)
    .optional()
    .describe("Demand surges or slumps over a window of days, optionally one category (traditional, specialty:latam, …)."),
  candystore: z
    .object({
      add: z
        .array(
          z
            .object({
              type: z.enum(["general", "specialty"]),
              lon: z.number(),
              lat: z.number(),
              size: z.number().min(0.2).max(5).optional(),
              segments: z.array(z.string().max(20)).max(7).optional(),
              name: z.string().max(80).optional(),
              dc: z.string().max(40).optional(),
            })
            .strict()
        )
        .max(20)
        .optional(),
      remove: z.array(z.string().max(40)).max(20).optional(),
    })
    .strict()
    .optional()
    .describe("A candystore_mcp scenario (stores added or closed, same shape as its what_if). Fetches the live candystore API for the demand it routes to each center."),
  slotting: z.enum(["current", "optimized"]).optional().describe("Pick-face slotting: the building's current one, or velocity-optimized."),
  forecast: z.enum(["seasonal", "trailing"]).optional().describe("Buyer's forecast: seasonal looks ahead through the candy calendar; trailing averages the last four weeks."),
  serviceLevel: z.number().min(0.5).max(0.999).optional().describe("Cycle service level behind safety stock."),
  supplierDelays: z
    .array(z.object({ ...daySpan, supplier: z.string().max(40).optional(), category: z.string().max(40).optional(), extraDays: z.number().int().min(1).max(60) }).strict())
    .max(20)
    .optional()
    .describe("Extra lead time on orders placed in a window, for one supplier id or every supplier of a category."),
  absenteeism: z.number().min(0).max(0.5).optional().describe("Share of scheduled shifts where the worker does not come in. Default 0.04."),
  doorOutages: z.array(z.object({ ...daySpan, kind: z.enum(["inbound", "outbound"]), count: z.number().int().min(1).max(10) }).strict()).max(20).optional(),
  forkliftOutages: z.array(z.object({ ...daySpan, count: z.number().int().min(1).max(10) }).strict()).max(20).optional(),
  wmsOutages: z
    .array(z.object({ day: z.number().int().min(0).max(364), start: z.string().regex(/^\d{2}:\d{2}$/), hours: z.number().min(0.25).max(24) }).strict())
    .max(20)
    .optional()
    .describe("Warehouse system down: nothing releases and no task starts."),
  workerLeave: z
    .array(z.object({ ...daySpan, worker: z.string().max(20).optional(), role: z.string().max(40).optional(), count: z.number().int().min(1).max(20).optional() }).strict())
    .max(20)
    .optional()
    .describe("Named workers (W-E-004) or a count of a role (\"Forklift operator\") out for a window."),
  addWorkers: z
    .array(z.object({ role: z.enum(ROLE_KEYS as [string, ...string[]]), shift: z.string().max(20), type: z.enum(["full-time", "part-time", "temp"]), count: z.number().int().min(1).max(20) }).strict())
    .max(10)
    .optional()
    .describe("People to add. Temps work at reduced productivity and are never forklift-certified."),
  removeWorkers: z.array(z.string().max(20)).max(20).optional(),
  crossTrain: z
    .array(z.object({ worker: z.string().max(20).optional(), role: z.string().max(40).optional(), skill: z.enum(SKILLS as [string, ...string[]]) }).strict())
    .max(20)
    .optional()
    .describe("Give a worker, or everyone in a role, another skill (receive, forklift, pick, pack, load)."),
  flex: z.boolean().optional().describe("Let cross-trained people take work outside their primary skill when it is idle. Default true."),
  overtimeMaxHours: z.number().min(0).max(6).optional().describe("Overtime cap per person per day for the last shift. Default 2."),
  forklifts: z.number().int().min(0).max(20).optional(),
  palletJacks: z.number().int().min(0).max(20).optional(),
  inboundDoors: z.number().int().min(1).max(20).optional(),
  outboundDoors: z.number().int().min(1).max(20).optional(),
  faceCases: z.number().int().min(1).max(8).optional().describe("Pick-face capacity in master cases."),
  targetUtilization: z.number().min(0.5).max(1).optional().describe("Labor planning target, busy share of productive hours. Default 0.85."),
};

export const scenarioSchema = z.object(scenarioShape).strict();
export type TwinScenario = z.infer<typeof scenarioSchema>;

export const dcSchema = z.string().max(40).describe("Distribution center id: dc-west (Fulton Industrial) or dc-east (Norcross).");
export const startWeekSchema = z.number().int().min(1).max(52).describe("Calendar week the horizon starts on its Monday (44 is Halloween week).");

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface TwinContext {
  site: Site;
  layout: Layout;
  catalog: Catalog;
  network: Network;
  model: DemandModel;
  std: LaborStandards;
  costs: CostRates;
  workers: Worker[];
  slottingPolicy: SlottingPolicy;
  slotting: Slotting;
  slotEval: SlottingEvaluation;
  faces: FaceSizes;
  frequencies: SkuFrequency[];
  startWeek: number;
  policy: InventoryPolicy;
  supplierDelays: SupplierDelay[];
  workloadContext: WorkloadContext;
  scheduleOptions: ScheduleOptions;
  /** A fixed schedule to run instead of building one per week. */
  schedule?: WeekSchedule;
  scenario: TwinScenario;
  /** Human-readable scenario changes, for tool output. */
  changes: string[];
}

function applyWorkers(site: Site, base: Worker[], s: TwinScenario, changes: string[]): Worker[] {
  let workers = base.filter((w) => w.dc === site.id).map((w) => ({ ...w, skills: [...w.skills] }));
  const known = new Set(workers.map((w) => w.id));
  const shiftIds = site.shifts.map((x) => x.id);

  for (const id of s.removeWorkers ?? []) {
    if (!known.has(id)) throw new UnknownIdError(`Unknown worker "${id}" at ${site.id}. Call get_workforce for ids.`);
  }
  if (s.removeWorkers?.length) {
    workers = workers.filter((w) => !s.removeWorkers!.includes(w.id));
    changes.push(`removed ${s.removeWorkers.join(", ")}`);
  }

  let n = 0;
  for (const a of s.addWorkers ?? []) {
    if (!shiftIds.includes(a.shift)) throw new UnknownIdError(`Unknown shift "${a.shift}" at ${site.id}. Shifts: ${shiftIds.join(", ")}.`);
    const role = ROLES[a.role as keyof typeof ROLES];
    let skills = [...role.skills];
    if (a.type === "temp") skills = skills.filter((k) => k !== "forklift");
    if (skills.length === 0) throw new UnknownIdError(`A temp ${a.role} has no skills left once forklift is removed.`);
    for (let i = 0; i < a.count; i++) {
      n++;
      workers.push({
        id: `NEW-${String(n).padStart(2, "0")}`,
        dc: site.id,
        role: a.type === "temp" ? `Temp ${role.role.toLowerCase()}` : role.role,
        type: a.type,
        homeShift: a.shift,
        skills: [...skills],
        productivity: 1,
        hourlyRate: a.type === "temp" ? DEFAULT_COSTS.tempHourly : role.wage,
        maxWeeklyHours: a.type === "part-time" ? 24 : 40,
      });
    }
    changes.push(`added ${a.count} ${a.type} ${role.role.toLowerCase()}${a.count > 1 ? "s" : ""} on ${a.shift}`);
  }

  // After additions, so a new hire (NEW-01) can be cross-trained in the same scenario.
  for (const c of s.crossTrain ?? []) {
    const skill = c.skill as Worker["skills"][number];
    const targets = workers.filter((w) => (c.worker && w.id === c.worker) || (c.role && w.role.toLowerCase() === c.role.toLowerCase()));
    if (targets.length === 0) throw new UnknownIdError(`crossTrain matched nobody at ${site.id} (${c.worker ?? c.role}). Use a worker id or a role name such as "Order selector".`);
    for (const w of targets) {
      if (skill === "forklift" && w.type === "temp") throw new UnknownIdError(`${w.id} is a temp; agency temps cannot be forklift-certified.`);
      if (!w.skills.includes(skill)) w.skills.push(skill);
    }
    changes.push(`cross-trained ${targets.map((t) => t.id).join(", ")} on ${skill}`);
  }

  for (const l of s.workerLeave ?? []) {
    if (l.worker && !workers.some((w) => w.id === l.worker)) throw new UnknownIdError(`Unknown worker "${l.worker}" in workerLeave at ${site.id}.`);
    if (l.role && !workers.some((w) => w.role.toLowerCase() === l.role!.toLowerCase())) throw new UnknownIdError(`No "${l.role}" at ${site.id} for workerLeave.`);
  }
  return workers;
}

function applySite(base: Site, s: TwinScenario, changes: string[]): Site {
  const site: Site = structuredClone(base);
  if (s.layout) {
    // An imported building brings its own size and doors; overrides apply on top.
    site.building = { widthFt: s.layout.widthFt, depthFt: s.layout.depthFt };
    site.doors = { inbound: s.layout.doors.filter((d) => d.kind === "inbound").length, outbound: s.layout.doors.filter((d) => d.kind === "outbound").length };
    changes.push(`imported layout "${s.layout.name}" (${s.layout.source.format}${s.layout.source.file ? `, ${s.layout.source.file}` : ""})`);
  }
  const set = <T extends number>(label: string, cur: T, next: T | undefined, apply: (v: T) => void) => {
    if (next === undefined || next === cur) return;
    apply(next);
    changes.push(`${label} ${cur} → ${next}`);
  };
  set("forklifts", site.equipment.forklifts, s.forklifts, (v) => (site.equipment.forklifts = v));
  set("pallet jacks", site.equipment.palletJacks, s.palletJacks, (v) => (site.equipment.palletJacks = v));
  set("inbound doors", site.doors.inbound, s.inboundDoors, (v) => (site.doors.inbound = v));
  set("outbound doors", site.doors.outbound, s.outboundDoors, (v) => (site.doors.outbound = v));
  set("pick-face cases", site.pick.faceCases, s.faceCases, (v) => (site.pick.faceCases = v));
  return site;
}

function validateCategories(network: Network, catalog: Catalog, s: TwinScenario) {
  const cats = new Set(catalog.skus.map((k) => k.category));
  const suppliers = new Set(catalog.suppliers.map((k) => k.id));
  for (const shock of s.demandShocks ?? []) {
    if (shock.category && !cats.has(shock.category)) throw new UnknownIdError(`Unknown category "${shock.category}". Categories: ${[...cats].join(", ")}.`);
  }
  for (const d of s.supplierDelays ?? []) {
    if (d.supplier && !suppliers.has(d.supplier)) throw new UnknownIdError(`Unknown supplier "${d.supplier}". Suppliers: ${[...suppliers].join(", ")}.`);
    if (d.category && !cats.has(d.category)) throw new UnknownIdError(`Unknown category "${d.category}".`);
    if (!d.supplier && !d.category) throw new UnknownIdError("A supplier delay needs a supplier id or a category.");
  }
  void network;
}

const contextCache = new Map<string, TwinContext>();

/** Build the context. Async only because a candystore scenario is fetched live. */
export async function buildTwin(dc: string, startWeek: number, scenario: TwinScenario = {}): Promise<TwinContext> {
  const key = JSON.stringify([dc, startWeek, scenario]);
  const hit = contextCache.get(key);
  if (hit) return hit;

  const changes: string[] = [];
  const baseSite = findSite(dc);
  const site = applySite(baseSite, scenario, changes);
  const catalog = loadCatalog();
  let network = loadNetwork();
  if (scenario.candystore && ((scenario.candystore.add?.length ?? 0) > 0 || (scenario.candystore.remove?.length ?? 0) > 0)) {
    network = await fetchNetwork(scenario.candystore);
    const c = scenario.candystore;
    changes.push(`candystore scenario: ${[c.add?.length ? `${c.add.length} store(s) added` : "", c.remove?.length ? `closed ${c.remove.join(", ")}` : ""].filter(Boolean).join("; ")}`);
  }
  if (!network.dcs.some((d) => d.id === dc)) throw new UnknownIdError(`candystore has no center "${dc}".`);
  validateCategories(network, catalog, scenario);

  if (scenario.layout && JSON.stringify(scenario.layout).length > LIMITS.specJson) {
    throw new LimitError(`The layout spec is over the ${formatBytes(LIMITS.specJson)} limit. Re-import with fewer walls and zones (they are drawing-only), or split the building.`);
  }
  const spec = scenario.layout ? withDoorCounts(scenario.layout as LayoutSpec, site.doors.inbound, site.doors.outbound) : siteToSpec(site);
  const layout = buildLayout(spec, site);
  const workers = applyWorkers(site, loadRoster().workers, scenario, changes);
  const std = DEFAULT_STANDARDS;
  const costs = DEFAULT_COSTS;
  if (scenario.demandScale !== undefined && scenario.demandScale !== 1) changes.push(`demand ×${scenario.demandScale}`);
  for (const sh of scenario.demandShocks ?? []) changes.push(`demand ×${sh.factor} days ${sh.fromDay}–${sh.toDay}${sh.category ? ` (${sh.category})` : ""}`);
  const model = buildDemandModel(network, catalog, site, scenario.demandScale ?? 1, scenario.demandShocks ?? []);
  const slottingPolicy: SlottingPolicy = scenario.slotting ?? "current";
  if (slottingPolicy !== "current") changes.push(`${slottingPolicy} slotting`);
  const slotting = slottingFor(slottingPolicy, layout, catalog, model, std);
  const slotEval = evaluateSlotting(layout, slotting, model, catalog, std);
  const frequencies = skuFrequencies(model, catalog);
  const faces = faceSizesFor(slottingPolicy, layout, frequencies, std);
  const policy: InventoryPolicy = { forecast: scenario.forecast ?? DEFAULT_POLICY.forecast, serviceLevel: scenario.serviceLevel ?? DEFAULT_POLICY.serviceLevel };
  if (scenario.forecast && scenario.forecast !== DEFAULT_POLICY.forecast) changes.push(`${scenario.forecast} forecast`);
  if (scenario.serviceLevel !== undefined) changes.push(`service level ${scenario.serviceLevel}`);
  const supplierDelays: SupplierDelay[] = (scenario.supplierDelays ?? []).map((d) => ({ ...d }));
  for (const d of supplierDelays) changes.push(`+${d.extraDays} days lead time for ${d.supplier ?? d.category} on orders placed days ${d.fromDay}–${d.toDay}`);
  const scheduleOptions: ScheduleOptions = {
    targetUtilization: scenario.targetUtilization ?? DEFAULT_SCHEDULE_OPTIONS.targetUtilization,
    absenteeism: scenario.absenteeism ?? DEFAULT_SCHEDULE_OPTIONS.absenteeism,
  };
  const workloadContext: WorkloadContext = { site, layout, model, catalog, std, slotting: slotEval, faces, startWeek };

  const ctx: TwinContext = { site, layout, catalog, network, model, std, costs, workers, slottingPolicy, slotting, slotEval, faces, frequencies, startWeek, policy, supplierDelays, workloadContext, scheduleOptions, scenario, changes };
  if (contextCache.size > 40) contextCache.delete(contextCache.keys().next().value!);
  contextCache.set(key, ctx);
  return ctx;
}

/** Operations options from a scenario, with the simulation-only knobs. */
export function operationsOptions(ctx: TwinContext, days: number, seed: number): OperationsOptions {
  const s = ctx.scenario;
  const disruptions: Disruptions = {
    absenteeism: s.absenteeism ?? NO_DISRUPTIONS.absenteeism,
    doorOutages: s.doorOutages ?? [],
    forkliftOutages: s.forkliftOutages ?? [],
    wmsOutages: s.wmsOutages ?? [],
    workerLeave: s.workerLeave ?? [],
    inboundLatenessSdMin: NO_DISRUPTIONS.inboundLatenessSdMin,
  };
  return { days, seed, flex: s.flex ?? true, overtimeMaxHours: s.overtimeMaxHours ?? 2, disruptions, warmupWeeks: 8 };
}

/** Describe the disruptions in a scenario for tool output. */
export function describeDisruptions(s: TwinScenario): string[] {
  const out: string[] = [];
  if (s.absenteeism !== undefined) out.push(`absenteeism ${Math.round(s.absenteeism * 100)}%`);
  for (const d of s.doorOutages ?? []) out.push(`${d.count} ${d.kind} door(s) down days ${d.fromDay}–${d.toDay}`);
  for (const f of s.forkliftOutages ?? []) out.push(`${f.count} forklift(s) down days ${f.fromDay}–${f.toDay}`);
  for (const w of s.wmsOutages ?? []) out.push(`WMS down day ${w.day} from ${w.start} for ${w.hours} h`);
  for (const l of s.workerLeave ?? []) out.push(`${l.worker ?? `${l.count ?? 1} × ${l.role}`} out days ${l.fromDay}–${l.toDay}`);
  if (s.flex === false) out.push("no flexing outside primary skill");
  if (s.overtimeMaxHours !== undefined) out.push(`overtime cap ${s.overtimeMaxHours} h/day`);
  return out;
}
