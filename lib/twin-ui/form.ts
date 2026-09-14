/**
 * The scenario form behind the /twin page's five input tabs. A ScenarioForm
 * is a TwinScenario with every scalar held as the text the user typed ("" =
 * leave the engine's default), list fields as rows of text, and weekday sets
 * as number arrays, so React inputs can be controlled without losing a
 * half-typed value. formToScenario parses it through the strict zod schema
 * every tool uses and maps each issue back to the field that caused it;
 * scenarioToForm is the inverse for a scenario read from a link.
 *
 * `candystore` never enters or leaves this module: the 3D page plays the
 * committed store network only, and the worker rejects the field anyway.
 * An imported building's `layout` travels separately (BuildingPicker), never
 * through the form. Pure; no DOM, no React.
 */

import type { z } from "zod";
import { compactSpec, type LayoutSpec } from "../layout/spec";
import { extensionShape } from "../twin/scenario-ext";
import { scenarioSchema, scenarioShape, type TwinScenario } from "../twin/twin";
import type { LaborStandards, PickZone } from "../twin/types";

// ---------------------------------------------------------------------------
// Form shape
// ---------------------------------------------------------------------------

export type StandardKey = keyof NonNullable<TwinScenario["standards"]>;
export type PickZoneKey = "aisles" | "baysPerSide" | "levels" | "bayWidthFt" | "aisleWidthFt" | "rackDepthFt" | "slotsPerBay";
export type ReserveZoneKey = Exclude<PickZoneKey, "slotsPerBay">;

export const STANDARD_KEYS: StandardKey[] = [
  "unloadPerPallet",
  "unloadPerTruck",
  "receivePerPallet",
  "receivePerCase",
  "labelPerImportCase",
  "putawayHandling",
  "replenHandling",
  "pickPerLine",
  "pickPerInner",
  "pickPerTour",
  "pickBendReachSec",
  "packPerPallet",
  "loadPerPallet",
  "loadPerTruck",
  "walkFtPerMin",
  "forkliftFtPerMin",
  "liftMinPerLevel",
  "cartCubeFt",
  "palletCubeFt",
];
export const PICK_ZONE_KEYS: PickZoneKey[] = ["aisles", "baysPerSide", "levels", "slotsPerBay", "bayWidthFt", "aisleWidthFt", "rackDepthFt"];
export const RESERVE_ZONE_KEYS: ReserveZoneKey[] = ["aisles", "baysPerSide", "levels", "bayWidthFt", "aisleWidthFt", "rackDepthFt"];

export interface DemandShockRow {
  fromDay: string;
  toDay: string;
  factor: string;
  category: string;
}
export interface SupplierDelayRow {
  fromDay: string;
  toDay: string;
  supplier: string;
  category: string;
  extraDays: string;
}
export interface SupplierOverrideRow {
  supplier: string;
  leadDays: string;
  leadSdDays: string;
  orderDay: string;
}
export interface CrossTrainRow {
  worker: string;
  role: string;
  skill: string;
}
export interface WorkerLeaveRow {
  fromDay: string;
  toDay: string;
  worker: string;
  role: string;
  count: string;
}
export interface AddWorkersRow {
  role: string;
  shift: string;
  type: string;
  count: string;
}
export interface ShiftRow {
  id: string;
  start: string;
  end: string;
  breakMin: string;
  indirectMin: string;
}
export interface WorkerOverrideRow {
  worker: string;
  productivity: string;
  maxWeeklyHours: string;
  hourlyRate: string;
}
export interface DoorOutageRow {
  fromDay: string;
  toDay: string;
  kind: string;
  count: string;
}
export interface ForkliftOutageRow {
  fromDay: string;
  toDay: string;
  count: string;
}
export interface WmsOutageRow {
  day: string;
  start: string;
  hours: string;
}

export interface ScenarioForm {
  // Deliveries
  demandScale: string;
  demandShocks: DemandShockRow[];
  deliveryGeneral: number[];
  deliverySpecialty: number[];
  orderRelease: string;
  truckDeparture: string;
  // Supply
  forecast: string;
  serviceLevel: string;
  supplierDelays: SupplierDelayRow[];
  supplierOverrides: SupplierOverrideRow[];
  inboundWindowStart: string;
  inboundWindowEnd: string;
  inboundLatenessSdMin: string;
  // Labor
  removeWorkers: string[];
  crossTrain: CrossTrainRow[];
  workerLeave: WorkerLeaveRow[];
  addWorkers: AddWorkersRow[];
  absenteeism: string;
  flex: string;
  overtimeMaxHours: string;
  targetUtilization: string;
  shifts: ShiftRow[];
  operatingDays: number[];
  workerOverrides: WorkerOverrideRow[];
  standards: Record<StandardKey, string>;
  // Space
  slotting: string;
  faceCases: string;
  inboundDoors: string;
  outboundDoors: string;
  forklifts: string;
  palletJacks: string;
  rackPick: Record<PickZoneKey, string>;
  rackReserve: Record<ReserveZoneKey, string>;
  // Disruptions
  doorOutages: DoorOutageRow[];
  forkliftOutages: ForkliftOutageRow[];
  wmsOutages: WmsOutageRow[];
}

/** Field path → message, e.g. "demandScale" or "doorOutages.1.count"; "" is a scenario-level message. */
export type FormErrors = Record<string, string>;

const blankRecord = <K extends string>(keys: readonly K[]): Record<K, string> => Object.fromEntries(keys.map((k) => [k, ""])) as Record<K, string>;

export function emptyForm(): ScenarioForm {
  return {
    demandScale: "",
    demandShocks: [],
    deliveryGeneral: [],
    deliverySpecialty: [],
    orderRelease: "",
    truckDeparture: "",
    forecast: "",
    serviceLevel: "",
    supplierDelays: [],
    supplierOverrides: [],
    inboundWindowStart: "",
    inboundWindowEnd: "",
    inboundLatenessSdMin: "",
    removeWorkers: [],
    crossTrain: [],
    workerLeave: [],
    addWorkers: [],
    absenteeism: "",
    flex: "",
    overtimeMaxHours: "",
    targetUtilization: "",
    shifts: [],
    operatingDays: [],
    workerOverrides: [],
    standards: blankRecord(STANDARD_KEYS),
    slotting: "",
    faceCases: "",
    inboundDoors: "",
    outboundDoors: "",
    forklifts: "",
    palletJacks: "",
    rackPick: blankRecord(PICK_ZONE_KEYS),
    rackReserve: blankRecord(RESERVE_ZONE_KEYS),
    doorOutages: [],
    forkliftOutages: [],
    wmsOutages: [],
  };
}

// ---------------------------------------------------------------------------
// Scenario → form
// ---------------------------------------------------------------------------

const str = (v: number | string | boolean | undefined): string => (v === undefined ? "" : String(v));

export function scenarioToForm(s: TwinScenario): ScenarioForm {
  const f = emptyForm();
  f.demandScale = str(s.demandScale);
  f.demandShocks = (s.demandShocks ?? []).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), factor: str(r.factor), category: r.category ?? "" }));
  f.deliveryGeneral = [...(s.deliveryDays?.general ?? [])];
  f.deliverySpecialty = [...(s.deliveryDays?.specialty ?? [])];
  f.orderRelease = s.times?.orderRelease ?? "";
  f.truckDeparture = s.times?.truckDeparture ?? "";
  f.forecast = s.forecast ?? "";
  f.serviceLevel = str(s.serviceLevel);
  f.supplierDelays = (s.supplierDelays ?? []).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), supplier: r.supplier ?? "", category: r.category ?? "", extraDays: str(r.extraDays) }));
  f.supplierOverrides = (s.supplierOverrides ?? []).map((r) => ({ supplier: r.supplier, leadDays: str(r.leadDays), leadSdDays: str(r.leadSdDays), orderDay: str(r.orderDay) }));
  f.inboundWindowStart = s.times?.inboundWindow?.[0] ?? "";
  f.inboundWindowEnd = s.times?.inboundWindow?.[1] ?? "";
  f.inboundLatenessSdMin = str(s.inboundLatenessSdMin);
  f.removeWorkers = [...(s.removeWorkers ?? [])];
  f.crossTrain = (s.crossTrain ?? []).map((r) => ({ worker: r.worker ?? "", role: r.role ?? "", skill: r.skill }));
  f.workerLeave = (s.workerLeave ?? []).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), worker: r.worker ?? "", role: r.role ?? "", count: str(r.count) }));
  f.addWorkers = (s.addWorkers ?? []).map((r) => ({ role: r.role, shift: r.shift, type: r.type, count: str(r.count) }));
  f.absenteeism = str(s.absenteeism);
  f.flex = s.flex === undefined ? "" : s.flex ? "true" : "false";
  f.overtimeMaxHours = str(s.overtimeMaxHours);
  f.targetUtilization = str(s.targetUtilization);
  f.shifts = (s.shifts ?? []).map((r) => ({ id: r.id, start: r.start, end: r.end, breakMin: str(r.breakMin), indirectMin: str(r.indirectMin) }));
  f.operatingDays = [...(s.operatingDays ?? [])];
  f.workerOverrides = (s.workerOverrides ?? []).map((r) => ({ worker: r.worker, productivity: str(r.productivity), maxWeeklyHours: str(r.maxWeeklyHours), hourlyRate: str(r.hourlyRate) }));
  for (const k of STANDARD_KEYS) f.standards[k] = str(s.standards?.[k]);
  f.slotting = s.slotting ?? "";
  f.faceCases = str(s.faceCases);
  f.inboundDoors = str(s.inboundDoors);
  f.outboundDoors = str(s.outboundDoors);
  f.forklifts = str(s.forklifts);
  f.palletJacks = str(s.palletJacks);
  for (const k of PICK_ZONE_KEYS) f.rackPick[k] = str(s.rackZones?.pick?.[k]);
  for (const k of RESERVE_ZONE_KEYS) f.rackReserve[k] = str(s.rackZones?.reserve?.[k]);
  f.doorOutages = (s.doorOutages ?? []).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), kind: r.kind, count: str(r.count) }));
  f.forkliftOutages = (s.forkliftOutages ?? []).map((r) => ({ fromDay: str(r.fromDay), toDay: str(r.toDay), count: str(r.count) }));
  f.wmsOutages = (s.wmsOutages ?? []).map((r) => ({ day: str(r.day), start: r.start, hours: str(r.hours) }));
  return f;
}

// ---------------------------------------------------------------------------
// Form → scenario
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

/**
 * Builds the raw object the schema will parse. Text that should be a number
 * but is not one becomes an error here (zod would only say "expected number,
 * received NaN"), and blank scalars, empty rows and empty lists are left out
 * so the scenario carries only what the user set.
 */
function build(form: ScenarioForm, errors: FormErrors): Raw {
  const out: Raw = {};
  const numAt = (path: string, text: string): number | undefined => {
    const s = text.trim();
    if (s === "") return undefined;
    const n = Number(s);
    if (!Number.isFinite(n)) {
      errors[path] = `"${s}" is not a number.`;
      return undefined;
    }
    return n;
  };
  const textAt = (text: string): string | undefined => (text.trim() === "" ? undefined : text.trim());
  const set = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };
  const rows = <R extends object>(key: string, list: R[], map: (row: R, path: string) => Raw | null) => {
    const built: Raw[] = [];
    list.forEach((row, i) => {
      const values = Object.values(row as Record<string, string>);
      if (values.every((v) => v.trim() === "")) return;
      const r = map(row, `${key}.${i}`);
      if (r) built.push(r);
    });
    if (built.length) out[key] = built;
  };
  const prune = (o: Raw): Raw | null => {
    const r: Raw = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
    return Object.keys(r).length ? r : null;
  };
  const days = (list: number[]): number[] | undefined => (list.length ? [...new Set(list)].sort((a, b) => a - b) : undefined);

  // Deliveries
  set("demandScale", numAt("demandScale", form.demandScale));
  rows("demandShocks", form.demandShocks, (r, p) => ({ fromDay: numAt(`${p}.fromDay`, r.fromDay), toDay: numAt(`${p}.toDay`, r.toDay), factor: numAt(`${p}.factor`, r.factor), category: textAt(r.category) }));
  const deliveryDays = prune({ general: days(form.deliveryGeneral), specialty: days(form.deliverySpecialty) });
  if (deliveryDays) out.deliveryDays = deliveryDays;
  const times: Raw = { orderRelease: textAt(form.orderRelease), truckDeparture: textAt(form.truckDeparture) };
  const w0 = textAt(form.inboundWindowStart);
  const w1 = textAt(form.inboundWindowEnd);
  if (w0 || w1) {
    if (w0 && w1) times.inboundWindow = [w0, w1];
    else errors[w0 ? "inboundWindowEnd" : "inboundWindowStart"] = "Give both ends of the inbound window.";
  }
  const timesPruned = prune(times);
  if (timesPruned) out.times = timesPruned;

  // Supply
  set("forecast", textAt(form.forecast));
  set("serviceLevel", numAt("serviceLevel", form.serviceLevel));
  rows("supplierDelays", form.supplierDelays, (r, p) => ({ fromDay: numAt(`${p}.fromDay`, r.fromDay), toDay: numAt(`${p}.toDay`, r.toDay), supplier: textAt(r.supplier), category: textAt(r.category), extraDays: numAt(`${p}.extraDays`, r.extraDays) }));
  rows("supplierOverrides", form.supplierOverrides, (r, p) => ({ supplier: textAt(r.supplier) ?? "", leadDays: numAt(`${p}.leadDays`, r.leadDays), leadSdDays: numAt(`${p}.leadSdDays`, r.leadSdDays), orderDay: numAt(`${p}.orderDay`, r.orderDay) }));
  set("inboundLatenessSdMin", numAt("inboundLatenessSdMin", form.inboundLatenessSdMin));

  // Labor
  const remove = form.removeWorkers.map((w) => w.trim()).filter(Boolean);
  if (remove.length) out.removeWorkers = remove;
  rows("crossTrain", form.crossTrain, (r) => ({ worker: textAt(r.worker), role: textAt(r.role), skill: textAt(r.skill) ?? "" }));
  rows("workerLeave", form.workerLeave, (r, p) => ({ fromDay: numAt(`${p}.fromDay`, r.fromDay), toDay: numAt(`${p}.toDay`, r.toDay), worker: textAt(r.worker), role: textAt(r.role), count: numAt(`${p}.count`, r.count) }));
  rows("addWorkers", form.addWorkers, (r, p) => ({ role: textAt(r.role) ?? "", shift: textAt(r.shift) ?? "", type: textAt(r.type) ?? "", count: numAt(`${p}.count`, r.count) }));
  set("absenteeism", numAt("absenteeism", form.absenteeism));
  if (form.flex === "true") out.flex = true;
  else if (form.flex === "false") out.flex = false;
  set("overtimeMaxHours", numAt("overtimeMaxHours", form.overtimeMaxHours));
  set("targetUtilization", numAt("targetUtilization", form.targetUtilization));
  rows("shifts", form.shifts, (r, p) => ({ id: textAt(r.id) ?? "", start: textAt(r.start) ?? "", end: textAt(r.end) ?? "", breakMin: numAt(`${p}.breakMin`, r.breakMin), indirectMin: numAt(`${p}.indirectMin`, r.indirectMin) }));
  set("operatingDays", days(form.operatingDays));
  rows("workerOverrides", form.workerOverrides, (r, p) => ({ worker: textAt(r.worker) ?? "", productivity: numAt(`${p}.productivity`, r.productivity), maxWeeklyHours: numAt(`${p}.maxWeeklyHours`, r.maxWeeklyHours), hourlyRate: numAt(`${p}.hourlyRate`, r.hourlyRate) }));
  const standards: Raw = {};
  for (const k of STANDARD_KEYS) {
    const v = numAt(`standards.${k}`, form.standards[k]);
    if (v !== undefined) standards[k] = v;
  }
  if (Object.keys(standards).length) out.standards = standards;

  // Space
  set("slotting", textAt(form.slotting));
  set("faceCases", numAt("faceCases", form.faceCases));
  set("inboundDoors", numAt("inboundDoors", form.inboundDoors));
  set("outboundDoors", numAt("outboundDoors", form.outboundDoors));
  set("forklifts", numAt("forklifts", form.forklifts));
  set("palletJacks", numAt("palletJacks", form.palletJacks));
  const pick: Raw = {};
  for (const k of PICK_ZONE_KEYS) {
    const v = numAt(`rackPick.${k}`, form.rackPick[k]);
    if (v !== undefined) pick[k] = v;
  }
  const reserve: Raw = {};
  for (const k of RESERVE_ZONE_KEYS) {
    const v = numAt(`rackReserve.${k}`, form.rackReserve[k]);
    if (v !== undefined) reserve[k] = v;
  }
  const rackZones = prune({ pick: Object.keys(pick).length ? pick : undefined, reserve: Object.keys(reserve).length ? reserve : undefined });
  if (rackZones) out.rackZones = rackZones;

  // Disruptions
  rows("doorOutages", form.doorOutages, (r, p) => ({ fromDay: numAt(`${p}.fromDay`, r.fromDay), toDay: numAt(`${p}.toDay`, r.toDay), kind: textAt(r.kind) ?? "", count: numAt(`${p}.count`, r.count) }));
  rows("forkliftOutages", form.forkliftOutages, (r, p) => ({ fromDay: numAt(`${p}.fromDay`, r.fromDay), toDay: numAt(`${p}.toDay`, r.toDay), count: numAt(`${p}.count`, r.count) }));
  rows("wmsOutages", form.wmsOutages, (r, p) => ({ day: numAt(`${p}.day`, r.day), start: textAt(r.start) ?? "", hours: numAt(`${p}.hours`, r.hours) }));
  return out;
}

/** The form's field for a schema path: the nested fields the form flattens are mapped back to their inputs. */
function fieldPath(path: ReadonlyArray<PropertyKey>): string {
  const p = path.map(String);
  if (p[0] === "times") {
    if (p[1] === "inboundWindow") return p[2] === "1" ? "inboundWindowEnd" : "inboundWindowStart";
    return p[1] ?? "times";
  }
  if (p[0] === "deliveryDays") return p[1] === "specialty" ? "deliverySpecialty" : "deliveryGeneral";
  if (p[0] === "rackZones") return `${p[1] === "reserve" ? "rackReserve" : "rackPick"}${p[2] !== undefined ? `.${p[2]}` : ""}`;
  return p.join(".");
}

/** Every issue as "field path → message"; the first message per field wins. */
export function issuesToErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): FormErrors {
  const errors: FormErrors = {};
  for (const i of issues) {
    const key = fieldPath(i.path);
    if (!(key in errors)) errors[key] = i.message;
  }
  return errors;
}

export interface FormResult {
  /** The validated scenario, or null when any field has an error. */
  scenario: TwinScenario | null;
  errors: FormErrors;
}

export function formToScenario(form: ScenarioForm): FormResult {
  const errors: FormErrors = {};
  const raw = build(form, errors);
  const res = scenarioSchema.safeParse(raw);
  if (!res.success) {
    const zodErrors = issuesToErrors(res.error.issues);
    for (const [k, v] of Object.entries(zodErrors)) if (!(k in errors)) errors[k] = v;
  }
  if (Object.keys(errors).length) return { scenario: null, errors };
  return { scenario: res.success ? res.data : {}, errors };
}

/** How many fields the form sets (for the "n changes" badge). */
export function formFieldCount(form: ScenarioForm): number {
  const { errors, scenario } = formToScenario(form);
  if (!scenario) return Object.keys(errors).length;
  return Object.keys(scenario).length;
}

// ---------------------------------------------------------------------------
// Help text from the schema
// ---------------------------------------------------------------------------

type ShapeKey = keyof typeof scenarioShape;

/** Fields the schema leaves undescribed. */
const FALLBACK_HELP: Partial<Record<ShapeKey, string>> = {
  layout: "An imported building replaces the center's built-in one.",
  doorOutages: "Dock doors out of service over a window of days: inbound or outbound, and how many.",
  forkliftOutages: "Forklifts out of service over a window of days.",
  removeWorkers: "Roster ids to take off the crew (W-E-004).",
  forklifts: "Forklifts in the building. Putaway and replenishment need one.",
  palletJacks: "Pallet jacks for unloading and loading.",
  inboundDoors: "Dock doors for supplier trucks.",
  outboundDoors: "Dock doors for store trucks.",
};

/** The zod .describe() text of a scenario field, or a fallback for the few without one. */
export function fieldHelp(key: ShapeKey): string {
  const schema = scenarioShape[key] as z.ZodType;
  return schema.description ?? FALLBACK_HELP[key] ?? "";
}

/** The nine 3D-twin extension fields, described the same way. */
export function extensionHelp(key: keyof typeof extensionShape): string {
  return (extensionShape[key] as z.ZodType).description ?? "";
}

/** Shown beside the shifts editor: what the labor planning can and cannot do with a second shift. */
export const SHIFTS_CAVEAT = "Planning assigns outbound work to the shift containing order release + 150 min (19:30 with the default 17:00 release); a second shift is approximated, staffed only by workers whose home shift it is (addWorkers on that shift id).";

// ---------------------------------------------------------------------------
// Space pre-validation: pick faces must hold every SKU
// ---------------------------------------------------------------------------

export type PickZoneBase = Pick<PickZone, "aisles" | "baysPerSide" | "levels" | "slotsPerBay">;

/** Pick faces a built-in building will have with the form's rackZones.pick overrides: aisles × 2 sides × bays × levels × slots. */
export function builtinPickFaces(form: ScenarioForm, base: PickZoneBase): number {
  const v = (key: "aisles" | "baysPerSide" | "levels" | "slotsPerBay"): number => {
    const n = Number(form.rackPick[key].trim());
    return form.rackPick[key].trim() !== "" && Number.isFinite(n) && n > 0 ? n : base[key];
  };
  return v("aisles") * 2 * v("baysPerSide") * v("levels") * v("slotsPerBay");
}

/** Edits the Space tab offers on an imported spec; "" leaves the drawing's value. */
export interface ImportRackEdits {
  levels: string;
  slotsPerBay: string;
  aisleWidthFt: string;
}

export const EMPTY_IMPORT_EDITS: ImportRackEdits = { levels: "", slotsPerBay: "", aisleWidthFt: "" };

function edited(text: string, integer: boolean): number | undefined {
  const s = text.trim();
  if (s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return integer ? Math.round(n) : n;
}

/** The spec with the edits applied to every rack run (levels, slots per bay) and the single-sided aisle width, compacted. */
export function applyImportEdits(spec: LayoutSpec, edits: ImportRackEdits): LayoutSpec {
  const levels = edited(edits.levels, true);
  const slots = edited(edits.slotsPerBay, true);
  const aisle = edited(edits.aisleWidthFt, false);
  if (levels === undefined && slots === undefined && aisle === undefined) return spec;
  return compactSpec({
    ...spec,
    aisleWidthFt: aisle ?? spec.aisleWidthFt,
    racks: spec.racks.map((r) => ({ ...r, levels: levels ?? r.levels, slotsPerBay: r.use === "reserve" ? r.slotsPerBay : (slots ?? r.slotsPerBay) })),
  });
}

/** Pick faces an imported spec yields: every level of a pick run, level 1 of a mixed run, times bays and slots. */
export function importPickFaces(spec: LayoutSpec): number {
  let faces = 0;
  for (const r of spec.racks) {
    if (r.use === "pick") faces += r.bays * r.levels * r.slotsPerBay;
    else if (r.use === "mixed") faces += r.bays * r.slotsPerBay;
  }
  return faces;
}

/** The message the Space tab shows before Run when the SKUs would not fit; null when they do. */
export function checkFaces(faces: number, skuCount: number): string | null {
  if (faces >= skuCount) return null;
  return `${skuCount} SKUs need ${skuCount} pick faces; this building has ${faces}. Add pick aisles, bays, levels or slots per bay.`;
}

/** The engine's default standard, for placeholders. */
export function standardDefault(std: LaborStandards, key: StandardKey): number {
  return std[key];
}
