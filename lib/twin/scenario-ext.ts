/**
 * Scenario fields added with the 3D twin: shift patterns, operating and
 * delivery days, the site's clock, per-worker overrides, labor standards,
 * supplier lead times, inbound lateness and the built-in buildings' rack
 * zones. Spread into scenarioShape by lib/twin/twin.ts, so every MCP tool and
 * the 3D page accept them; applied by the hooks below at the points twin.ts
 * calls them.
 *
 * Lead-written contract: the zod shape is final. The hooks never touch the
 * committed data: twin.ts hands applySiteExtensions a structuredClone of the
 * site and applyWorkerExtensions copies of the roster entries, and the
 * catalog and standards hooks return new objects (the SKU array is shared).
 * Whatever zod cannot express (unique shift ids, delivery days on operating
 * days, a rack zone that fits the building) is checked here, with the error
 * classes the tools already turn into isError results: UnknownIdError for an
 * argument that cannot work, LimitError for a building that does not fit.
 * Never import lib/data/load here (it carries node:fs); UnknownIdError comes
 * from the pure store.
 */

import { z } from "zod";
import { UnknownIdError } from "../data/store";
import { LimitError } from "../layout/limits";
import type { Disruptions } from "./operations";
// Aliased: `hhmm` below is the lead's zod pattern for "HH:MM" strings.
import { hhmm as clockMinutes, shiftPaidHours, WEEKDAYS } from "./standards";
import type { Catalog, LaborStandards, PickZone, RackZone, Site, Supplier, Worker } from "./types";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM");
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7);
const rackZonePartial = {
  aisles: z.number().int().min(1).max(40).optional(),
  baysPerSide: z.number().int().min(1).max(60).optional(),
  levels: z.number().int().min(1).max(12).optional(),
  bayWidthFt: z.number().min(4).max(16).optional(),
  aisleWidthFt: z.number().min(3).max(20).optional(),
  rackDepthFt: z.number().min(1).max(8).optional(),
};

export const extensionShape = {
  shifts: z
    .array(z.object({ id: z.string().min(1).max(20), start: hhmm, end: hhmm, breakMin: z.number().int().min(0).max(120), indirectMin: z.number().int().min(0).max(120) }).strict())
    .min(1)
    .max(3)
    .optional()
    .describe("Replace the site's shifts. Roster workers keep their home shift id; a shift with no home workers is staffed only by addWorkers on it. Planning is approximate for a second shift (README)."),
  operatingDays: weekdays.optional().describe("Weekdays the building works, 1 = Monday. Delivery days must be operating days."),
  times: z
    .object({ orderRelease: hhmm.optional(), truckDeparture: hhmm.optional(), inboundWindow: z.tuple([hhmm, hhmm]).optional() })
    .strict()
    .optional()
    .describe("The site's clock: evening order release, store truck departure, supplier appointment window."),
  deliveryDays: z
    .object({ general: weekdays.optional(), specialty: weekdays.optional() })
    .strict()
    .optional()
    .describe("Weekdays each store type receives a truck, 1 = Monday."),
  workerOverrides: z
    .array(z.object({ worker: z.string().max(20), productivity: z.number().min(0.5).max(1.5).optional(), maxWeeklyHours: z.number().int().min(8).max(60).optional(), hourlyRate: z.number().min(10).max(80).optional() }).strict())
    .max(40)
    .optional()
    .describe("Per-worker productivity (1.1 = 10% faster), weekly hours or wage; applies to roster ids and NEW-xx ids from addWorkers."),
  standards: z
    .object({
      unloadPerPallet: z.number().positive().max(30).optional(),
      unloadPerTruck: z.number().min(0).max(60).optional(),
      receivePerPallet: z.number().positive().max(30).optional(),
      receivePerCase: z.number().min(0).max(5).optional(),
      labelPerImportCase: z.number().min(0).max(5).optional(),
      putawayHandling: z.number().positive().max(30).optional(),
      replenHandling: z.number().positive().max(30).optional(),
      pickPerLine: z.number().positive().max(10).optional(),
      pickPerInner: z.number().min(0).max(5).optional(),
      pickPerTour: z.number().min(0).max(30).optional(),
      pickBendReachSec: z.number().min(0).max(60).optional(),
      packPerPallet: z.number().positive().max(60).optional(),
      loadPerPallet: z.number().positive().max(30).optional(),
      loadPerTruck: z.number().min(0).max(60).optional(),
      walkFtPerMin: z.number().min(60).max(400).optional(),
      forkliftFtPerMin: z.number().min(100).max(800).optional(),
      liftMinPerLevel: z.number().min(0).max(3).optional(),
      cartCubeFt: z.number().min(5).max(200).optional(),
      palletCubeFt: z.number().min(20).max(120).optional(),
    })
    .strict()
    .optional()
    .describe("Override engineered labor standards (minutes, feet per minute)."),
  supplierOverrides: z
    .array(z.object({ supplier: z.string().max(40), leadDays: z.number().int().min(1).max(90).optional(), leadSdDays: z.number().min(0).max(30).optional(), orderDay: z.number().int().min(1).max(7).optional() }).strict())
    .max(20)
    .optional()
    .describe("A supplier's lead time, its variability or the weekday the buyer orders from it."),
  inboundLatenessSdMin: z.number().min(0).max(180).optional().describe("Standard deviation of supplier truck arrival around the appointment, minutes. Default 30."),
  rackZones: z
    .object({ pick: z.object({ ...rackZonePartial, slotsPerBay: z.number().int().min(1).max(10).optional() }).strict().optional(), reserve: z.object(rackZonePartial).strict().optional() })
    .strict()
    .optional()
    .describe("Re-rack a built-in building: aisles, bays, levels, aisle width. Ignored (with a note) when a layout is imported."),
};

export const extensionSchema = z.object(extensionShape).strict();
export type ExtensionScenario = z.infer<typeof extensionSchema>;

/** Field names, for tools that list scenario vocabulary. */
export const EXTENSION_KEYS = Object.keys(extensionShape) as Array<keyof ExtensionScenario>;

/**
 * Pushed with any shift pattern of more than one shift. The engine runs every
 * shift the site declares; it is the labor planning (workforce.ts) that only
 * knows one home shift per worker and one outbound shift.
 */
export const SECOND_SHIFT_CAVEAT =
  "second shift approximated: planning staffs it only with workers whose home shift it is (addWorkers), and assigns outbound work to the shift containing orderRelease + 150 min (workforce.ts shiftRoles)";

/** Pushed when rackZones is set under an imported layout, which brings its own racks. */
export const RACK_ZONES_IGNORED = "rackZones ignored: layout imported";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * twin.ts applySite's convention: apply an override and note it as
 * "label old → new" only when it differs from what the site has, so a
 * scenario that restates the defaults leaves the change list alone.
 */
function override<T>(changes: string[], label: string, cur: T, next: T | undefined, apply: (v: T) => void, fmt: (v: T) => string = String): void {
  if (next === undefined) return;
  const a = fmt(cur);
  const b = fmt(next);
  if (a === b) return;
  apply(next);
  changes.push(`${label} ${a} → ${b}`);
}

const dayName = (d: number): string => WEEKDAYS[d - 1] ?? String(d);
const dayNames = (days: number[]): string => days.map(dayName).join(", ");
const sortedDays = (days: number[]): number[] => [...new Set(days)].sort((a, b) => a - b);

/** The HH:MM regex admits "25:99"; the engine would run with it, so reject it here. */
function checkClock(label: string, value: string): void {
  const [h, m] = value.split(":").map(Number);
  if (h > 23 || m > 59) throw new UnknownIdError(`${label} "${value}" is not a clock time (HH:MM, 00:00–23:59).`);
}

// ---------------------------------------------------------------------------
// Site: shifts, days, clock, rack zones
// ---------------------------------------------------------------------------

function applyShifts(site: Site, shifts: NonNullable<ExtensionScenario["shifts"]>, changes: string[]): void {
  const ids = new Set<string>();
  for (const sh of shifts) {
    if (ids.has(sh.id)) throw new UnknownIdError(`Shift id "${sh.id}" appears twice in shifts; ids must be unique.`);
    ids.add(sh.id);
    checkClock(`Shift "${sh.id}" start`, sh.start);
    checkClock(`Shift "${sh.id}" end`, sh.end);
    if (clockMinutes(sh.start) === clockMinutes(sh.end)) throw new UnknownIdError(`Shift "${sh.id}" starts and ends at ${sh.start}; give it an end time (an end before the start is an overnight shift).`);
    const paidMin = shiftPaidHours(sh.start, sh.end) * 60;
    if (sh.breakMin + sh.indirectMin >= paidMin) {
      throw new UnknownIdError(`Shift "${sh.id}" is ${paidMin} min long, shorter than its ${sh.breakMin} min break plus ${sh.indirectMin} min of indirect time.`);
    }
  }
  site.shifts = shifts.map((sh) => ({ id: sh.id, start: sh.start, end: sh.end, breakMin: sh.breakMin, indirectMin: sh.indirectMin }));
  changes.push(`shifts: ${shifts.map((sh) => `${sh.id} ${sh.start}–${sh.end}`).join(", ")}`);
  if (shifts.length > 1) changes.push(SECOND_SHIFT_CAVEAT);
}

function applyTimes(site: Site, times: NonNullable<ExtensionScenario["times"]>, changes: string[]): void {
  if (times.orderRelease !== undefined) checkClock("orderRelease", times.orderRelease);
  if (times.truckDeparture !== undefined) checkClock("truckDeparture", times.truckDeparture);
  if (times.inboundWindow !== undefined) {
    const [a, b] = times.inboundWindow;
    checkClock("inboundWindow start", a);
    checkClock("inboundWindow end", b);
    if (clockMinutes(a) >= clockMinutes(b)) throw new UnknownIdError(`inboundWindow ${a}–${b} ends before it starts; appointments are drawn between the two times on the same day.`);
  }
  override(changes, "order release", site.times.orderRelease, times.orderRelease, (v) => (site.times.orderRelease = v));
  override(changes, "truck departure", site.times.truckDeparture, times.truckDeparture, (v) => (site.times.truckDeparture = v));
  override(changes, "inbound window", site.times.inboundWindow, times.inboundWindow, (v) => (site.times.inboundWindow = [v[0], v[1]]), (v) => `${v[0]}–${v[1]}`);
}

/** Every field a zone override may carry; the summary line covers the first three, the rest get their own old → new note. */
type ZoneOverride = Partial<Pick<PickZone, "aisles" | "baysPerSide" | "levels" | "bayWidthFt" | "aisleWidthFt" | "rackDepthFt" | "slotsPerBay">>;
const ZONE_LABELS: Record<keyof ZoneOverride, string | null> = {
  aisles: null,
  baysPerSide: null,
  levels: null,
  bayWidthFt: "bay width",
  aisleWidthFt: "aisle width",
  rackDepthFt: "rack depth",
  slotsPerBay: "slots per bay",
};

function applyZone(zone: RackZone | PickZone, name: "pick" | "reserve", o: ZoneOverride, changes: string[]): void {
  // The reserve schema never carries slotsPerBay, so the wider type is safe for both zones.
  const target = zone as PickZone;
  for (const key of Object.keys(ZONE_LABELS) as Array<keyof ZoneOverride>) {
    const v = o[key];
    if (v === undefined || v === target[key]) continue;
    const label = ZONE_LABELS[key];
    if (label) changes.push(`${name} ${label} ${target[key]} → ${v}`);
    target[key] = v;
  }
  changes.push(`${name} zone ${zone.aisles} aisles × ${zone.baysPerSide} bays × ${zone.levels} levels`);
}

/**
 * siteToSpec lays a zone's aisles out from originX at a pitch of one aisle
 * plus two rack depths; nothing downstream checks the outline, so a zone past
 * the wall or across the other zone would build a layout with racks through
 * walls or aisles discovered between a pick run and a reserve run.
 */
function checkZones(site: Site): void {
  const rect = (z: RackZone) => ({ x0: z.originX, x1: z.originX + z.aisles * (z.aisleWidthFt + 2 * z.rackDepthFt), y0: z.originY, y1: z.originY + z.baysPerSide * z.bayWidthFt });
  const ft = (v: number) => String(Math.round(v * 10) / 10);
  const { widthFt, depthFt } = site.building;
  const zones = { pick: rect(site.pick), reserve: rect(site.reserve) };
  for (const [name, r] of Object.entries(zones)) {
    if (r.x1 > widthFt + 1e-9 || r.y1 > depthFt + 1e-9) {
      throw new LimitError(`The ${name} zone runs to x ${ft(r.x1)} ft, y ${ft(r.y1)} ft, past the ${widthFt} × ${depthFt} ft building. Use fewer aisles or bays, or narrower aisles and bays.`);
    }
  }
  const { pick, reserve } = zones;
  if (pick.x0 < reserve.x1 && reserve.x0 < pick.x1 && pick.y0 < reserve.y1 && reserve.y0 < pick.y1) {
    throw new LimitError(`The reserve zone (x ${ft(reserve.x0)}–${ft(reserve.x1)} ft) overlaps the pick zone (x ${ft(pick.x0)}–${ft(pick.x1)} ft). Use fewer reserve aisles, or narrower reserve aisles and racks.`);
  }
}

/**
 * Mutate the cloned site (twin.ts applySite) with shifts, operatingDays,
 * times, deliveryDays and rackZones. Runs before siteToSpec and before
 * applyWorkers, so addWorkers can name a new shift id. `hasLayout` means an
 * imported building: rackZones is ignored with a change note.
 */
export function applySiteExtensions(site: Site, s: ExtensionScenario, changes: string[], hasLayout: boolean): void {
  if (s.shifts) applyShifts(site, s.shifts, changes);
  override(changes, "operating days", site.operatingDays, s.operatingDays && sortedDays(s.operatingDays), (v) => (site.operatingDays = v), dayNames);
  if (s.times) applyTimes(site, s.times, changes);
  if (s.deliveryDays) {
    override(changes, "general delivery days", site.deliveryDays.general, s.deliveryDays.general && sortedDays(s.deliveryDays.general), (v) => (site.deliveryDays.general = v), dayNames);
    override(changes, "specialty delivery days", site.deliveryDays.specialty, s.deliveryDays.specialty && sortedDays(s.deliveryDays.specialty), (v) => (site.deliveryDays.specialty = v), dayNames);
  }
  if (s.operatingDays || s.deliveryDays) {
    // demand.ts drops a truck due on a closed day, so a delivery day the
    // building does not work would silently ship nothing to those stores.
    for (const [type, days] of Object.entries(site.deliveryDays)) {
      const closed = days.filter((d) => !site.operatingDays.includes(d));
      if (closed.length) {
        throw new UnknownIdError(`${type} stores receive deliveries on ${dayNames(closed)}, when the building is closed (operating days ${dayNames(site.operatingDays)}). Delivery days must be operating days.`);
      }
    }
  }
  if (s.rackZones) {
    if (hasLayout) changes.push(RACK_ZONES_IGNORED);
    else {
      if (s.rackZones.pick) applyZone(site.pick, "pick", s.rackZones.pick, changes);
      if (s.rackZones.reserve) applyZone(site.reserve, "reserve", s.rackZones.reserve, changes);
      checkZones(site);
    }
  }
}

// ---------------------------------------------------------------------------
// Workers, standards, catalog, disruptions
// ---------------------------------------------------------------------------

/** Per-worker overrides, after applyWorkers built the roster (NEW-xx ids included). Returns the same array, mutated. */
export function applyWorkerExtensions(workers: Worker[], s: ExtensionScenario, changes: string[]): Worker[] {
  if (s.shifts) {
    // applyWorkers already checked addWorkers against the new shifts; the
    // roster's home shifts were set by the data file, and workforce.ts looks
    // each one up without a guard.
    const ids = s.shifts.map((sh) => sh.id);
    for (const w of workers) {
      if (!ids.includes(w.homeShift)) {
        throw new UnknownIdError(`${w.id}'s home shift "${w.homeShift}" is not among the scenario's shifts (${ids.join(", ")}). Keep the roster's shift id in shifts, or take the worker out with removeWorkers.`);
      }
    }
  }
  for (const o of s.workerOverrides ?? []) {
    const w = workers.find((x) => x.id === o.worker);
    if (!w) throw new UnknownIdError(`Unknown worker "${o.worker}" in workerOverrides. Known: ${workers.map((x) => x.id).join(", ")}.`);
    override(changes, `${w.id} productivity`, w.productivity, o.productivity, (v) => (w.productivity = v));
    override(changes, `${w.id} weekly hours`, w.maxWeeklyHours, o.maxWeeklyHours, (v) => (w.maxWeeklyHours = v));
    override(changes, `${w.id} hourly rate`, w.hourlyRate, o.hourlyRate, (v) => (w.hourlyRate = v));
  }
  return workers;
}

/** Standards with overrides applied; the base is DEFAULT_STANDARDS and is returned as is when nothing overrides it. */
export function extensionStandards(base: LaborStandards, s: ExtensionScenario, changes: string[]): LaborStandards {
  if (!s.standards) return base;
  const std: LaborStandards = { ...base };
  const notes: string[] = [];
  for (const key of Object.keys(s.standards) as Array<keyof NonNullable<ExtensionScenario["standards"]>>) {
    const v = s.standards[key];
    if (v === undefined || v === base[key]) continue;
    std[key] = v;
    notes.push(`${key} ${base[key]} → ${v}`);
  }
  if (notes.length) changes.push(`standards: ${notes.join(", ")}`);
  return std;
}

/** A catalog whose suppliers carry the overrides; the base catalog is never mutated and the SKU array is shared. */
export function extensionCatalog(catalog: Catalog, s: ExtensionScenario, changes: string[]): Catalog {
  if (!s.supplierOverrides?.length) return catalog;
  const known = new Map(catalog.suppliers.map((sp) => [sp.id, sp]));
  const merged = new Map<string, Supplier>();
  for (const o of s.supplierOverrides) {
    const base = known.get(o.supplier);
    if (!base) throw new UnknownIdError(`Unknown supplier "${o.supplier}" in supplierOverrides. Suppliers: ${[...known.keys()].join(", ")}.`);
    // A copy per overridden supplier, so two entries for one id stack and the committed object stays as loaded.
    const sp = merged.get(o.supplier) ?? { ...base };
    override(changes, `${sp.id} lead days`, sp.leadDays, o.leadDays, (v) => (sp.leadDays = v));
    override(changes, `${sp.id} lead time sd`, sp.leadSdDays, o.leadSdDays, (v) => (sp.leadSdDays = v));
    override(changes, `${sp.id} order day`, sp.orderDay, o.orderDay, (v) => (sp.orderDay = v), dayName);
    merged.set(sp.id, sp);
  }
  return { ...catalog, suppliers: catalog.suppliers.map((sp) => merged.get(sp.id) ?? sp) };
}

/** Disruptions with inboundLatenessSdMin applied (twin.ts operationsOptions). */
export function extensionDisruptions(base: Disruptions, s: ExtensionScenario): Disruptions {
  return { ...base, inboundLatenessSdMin: s.inboundLatenessSdMin ?? base.inboundLatenessSdMin };
}

export type { PickZone, RackZone };
