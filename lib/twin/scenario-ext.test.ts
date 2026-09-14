/**
 * The 3D twin's scenario fields. Direction and conservation, as in
 * simulation.test.ts: each field moves the engine the way its name says, a
 * scenario without them (or restating the site's own values) reproduces
 * today's numbers event for event, and what cannot work is refused with the
 * error classes the tools turn into isError results. dc-east, week 36, 7
 * days, seed 5 throughout.
 */
import { describe, expect, it } from "vitest";
import { findSite, loadCatalog, loadRoster, UnknownIdError } from "../data/store";
import { LimitError } from "../layout/limits";
import { RecordingTracer, type TraceEvent, type TraceInit } from "../trace/types";
import { weekdayOf } from "./demand";
import { runInventory } from "./inventory";
import { siteToSpec } from "./layout";
import { NO_DISRUPTIONS, runOperations, type OperationsResult } from "./operations";
import { extensionCatalog, extensionDisruptions, extensionSchema, extensionStandards, EXTENSION_KEYS, type ExtensionScenario } from "./scenario-ext";
import { DEFAULT_STANDARDS } from "./standards";
import { buildTwin, operationsOptions, scenarioSchema, type TwinContext, type TwinScenario } from "./twin";

type Ev<K extends TraceEvent["k"]> = Extract<TraceEvent, { k: K }>;
const only = <K extends TraceEvent["k"]>(events: TraceEvent[], k: K): Array<Ev<K>> => events.filter((e): e is Ev<K> => e.k === k);

const DC = "dc-east";
const WEEK = 36;
const DAYS = 7;
const SEED = 5;

const SECOND_SHIFT_CAVEAT =
  "second shift approximated: planning staffs it only with workers whose home shift it is (addWorkers), and assigns outbound work to the shift containing orderRelease + 150 min (workforce.ts shiftRoles)";
const DAY = { id: "day", start: "06:00", end: "14:30", breakMin: 30, indirectMin: 30 };
const EVENING = { id: "evening", start: "14:30", end: "23:00", breakMin: 30, indirectMin: 30 };

interface Run {
  ctx: TwinContext;
  result: OperationsResult;
  events: TraceEvent[];
}

async function run(scenario: TwinScenario = {}): Promise<Run> {
  const ctx = await buildTwin(DC, WEEK, scenario);
  const tracer = new RecordingTracer();
  const result = runOperations(ctx, operationsOptions(ctx, DAYS, SEED), tracer);
  return { ctx, result, events: tracer.events };
}

let memo: Promise<Run> | null = null;
const baseline = () => (memo ??= run({}));

/** One scenario that sets every extension field to something other than the site's values. */
const FULL: ExtensionScenario = {
  shifts: [DAY, { ...EVENING, indirectMin: 15 }],
  operatingDays: [1, 2, 3, 4, 5, 6],
  times: { orderRelease: "16:00", truckDeparture: "15:00", inboundWindow: ["06:00", "11:00"] },
  deliveryDays: { general: [1, 3, 5], specialty: [2, 6] },
  workerOverrides: [{ worker: "W-E-003", productivity: 1.2, maxWeeklyHours: 32, hourlyRate: 20 }],
  standards: { walkFtPerMin: 200, pickPerLine: 0.4 },
  supplierOverrides: [{ supplier: "SUP-CHOC", leadDays: 9, leadSdDays: 2, orderDay: 3 }],
  inboundLatenessSdMin: 10,
  rackZones: { pick: { levels: 5, slotsPerBay: 1 }, reserve: { aisles: 5 } },
};

describe("scenario extensions", () => {
  it("validates a scenario that uses every new field through the shared schema, and still rejects unknown keys", async () => {
    expect([...Object.keys(FULL)].sort()).toEqual([...EXTENSION_KEYS].sort());
    expect(extensionSchema.parse(FULL)).toEqual(FULL);
    expect(scenarioSchema.parse({ demandScale: 1.2, ...FULL })).toEqual({ demandScale: 1.2, ...FULL });
    expect(() => scenarioSchema.parse({ standards: { walkMph: 3 } })).toThrow();
    expect(() => scenarioSchema.parse({ rackZones: { pick: { originX: 10 } } })).toThrow();
    expect(() => scenarioSchema.parse({ shifts: [{ ...DAY, lunch: 30 }] })).toThrow();
    // And the engine takes all of it at once.
    const full = await run(FULL);
    expect(full.result.service.trucks).toBeGreaterThan(0);
    expect(full.ctx.changes).toContain(SECOND_SHIFT_CAVEAT);
    expect(full.ctx.changes).toContain("operating days Mon, Tue, Wed, Thu, Fri → Mon, Tue, Wed, Thu, Fri, Sat");
    expect(full.ctx.changes).toContain("SUP-CHOC order day Mon → Wed");
    expect(full.ctx.layout.pick.length).toBe(500);
  });

  it("reproduces today's numbers with no extension fields, and with every field restating the site's own values", async () => {
    const base = await baseline();
    expect(base.ctx.changes).toEqual([]);
    expect(base.ctx.std).toBe(DEFAULT_STANDARDS);
    expect(base.ctx.catalog).toBe(loadCatalog());
    expect(operationsOptions(base.ctx, DAYS, SEED).disruptions).toEqual(NO_DISRUPTIONS);

    const site = findSite(DC);
    const catalog = loadCatalog();
    // The standards schema lists the 19 minute-and-feet standards; the two face-sizing ones stay engine-side.
    const standardKeys = Object.keys(extensionSchema.shape.standards.unwrap().shape) as Array<keyof NonNullable<ExtensionScenario["standards"]>>;
    expect(standardKeys).toHaveLength(19);
    const standards = Object.fromEntries(standardKeys.map((k) => [k, DEFAULT_STANDARDS[k]])) as NonNullable<ExtensionScenario["standards"]>;
    const restated: TwinScenario = {
      shifts: site.shifts.map((sh) => ({ ...sh })),
      operatingDays: [...site.operatingDays],
      times: { orderRelease: site.times.orderRelease, truckDeparture: site.times.truckDeparture, inboundWindow: [site.times.inboundWindow[0], site.times.inboundWindow[1]] },
      deliveryDays: { general: [...site.deliveryDays.general], specialty: [...site.deliveryDays.specialty] },
      workerOverrides: base.ctx.workers.map((w) => ({ worker: w.id, productivity: w.productivity, maxWeeklyHours: w.maxWeeklyHours, hourlyRate: w.hourlyRate })),
      standards,
      supplierOverrides: catalog.suppliers.map((sp) => ({ supplier: sp.id, leadDays: sp.leadDays, leadSdDays: sp.leadSdDays, orderDay: sp.orderDay })),
      inboundLatenessSdMin: NO_DISRUPTIONS.inboundLatenessSdMin,
      rackZones: {
        pick: { aisles: site.pick.aisles, baysPerSide: site.pick.baysPerSide, levels: site.pick.levels, bayWidthFt: site.pick.bayWidthFt, aisleWidthFt: site.pick.aisleWidthFt, rackDepthFt: site.pick.rackDepthFt, slotsPerBay: site.pick.slotsPerBay },
        reserve: { aisles: site.reserve.aisles, baysPerSide: site.reserve.baysPerSide, levels: site.reserve.levels, bayWidthFt: site.reserve.bayWidthFt, aisleWidthFt: site.reserve.aisleWidthFt, rackDepthFt: site.reserve.rackDepthFt },
      },
    };
    expect(scenarioSchema.parse(restated)).toEqual(restated);
    const same = await run(restated);
    expect(same.result).toEqual(base.result);
    expect(same.events).toEqual(base.events);
    // Only the descriptive notes (what is in force); nothing moved old → new.
    expect(same.ctx.changes).toEqual(["shifts: day 06:00–14:30", "pick zone 5 aisles × 10 bays × 4 levels", "reserve zone 6 aisles × 12 bays × 4 levels"]);
    expect(same.ctx.std).toEqual(DEFAULT_STANDARDS);
    expect(same.ctx.catalog.skus).toBe(catalog.skus);
  });

  it("ships fewer late minutes when the store trucks leave later", async () => {
    const base = await baseline();
    const later = await run({ times: { truckDeparture: "16:00" } });
    expect(later.ctx.site.times.truckDeparture).toBe("16:00");
    expect(later.ctx.changes).toEqual(["truck departure 14:00 → 16:00"]);
    expect(later.result.trucks.length).toBeGreaterThan(0);
    for (const t of later.result.trucks) expect(t.departAt % 1440).toBe(16 * 60);
    expect(later.result.service.lateMinTotal).toBeLessThanOrEqual(base.result.service.lateMinTotal);
    expect(findSite(DC).times.truckDeparture).toBe("14:00");
  });

  it("gets more out of a paid hour when a selector works faster", async () => {
    const base = await baseline();
    const fast = await run({ workerOverrides: [{ worker: "W-E-003", productivity: 1.3 }] });
    expect(fast.ctx.workers.find((w) => w.id === "W-E-003")!.productivity).toBe(1.3);
    expect(fast.ctx.changes).toEqual(["W-E-003 productivity 0.96 → 1.3"]);
    expect((fast.events[0] as TraceInit).workers.find((w) => w.id === "W-E-003")!.productivity).toBe(1.3);
    expect(fast.result.labor.innersPerPaidHour).toBeGreaterThanOrEqual(base.result.labor.innersPerPaidHour);
    const busy = (r: OperationsResult) => r.workers.find((w) => w.id === "W-E-003")!.busyHours;
    expect(busy(fast.result)).toBeLessThanOrEqual(busy(base.result));
    expect(loadRoster().workers.find((w) => w.id === "W-E-003")!.productivity).toBe(0.96);
  });

  it("spends more pick minutes when the walk standard is slower", async () => {
    const base = await baseline();
    const slow = await run({ standards: { walkFtPerMin: 90 } });
    expect(slow.ctx.std).toEqual({ ...DEFAULT_STANDARDS, walkFtPerMin: 90 });
    expect(slow.ctx.changes).toEqual(["standards: walkFtPerMin 180 → 90"]);
    expect((slow.events[0] as TraceInit).std.walkFtPerMin).toBe(90);
    expect(slow.result.processes.pick.busyMin).toBeGreaterThan(base.result.processes.pick.busyMin);
    expect(DEFAULT_STANDARDS.walkFtPerMin).toBe(180);
  });

  it("stretches a supplier's pipeline when its lead time grows, and cuts no less over six weeks", async () => {
    const base = await baseline();
    const slow = await run({ supplierOverrides: [{ supplier: "SUP-CHOC", leadDays: 20 }] });
    expect(slow.ctx.changes).toEqual(["SUP-CHOC lead days 5 → 20"]);
    expect(slow.ctx.catalog.suppliers.find((s) => s.id === "SUP-CHOC")!.leadDays).toBe(20);
    expect(slow.ctx.catalog.skus).toBe(loadCatalog().skus);
    expect(loadCatalog().suppliers.find((s) => s.id === "SUP-CHOC")!.leadDays).toBe(5);
    // The buyer orders from SUP-CHOC on Mondays: the run's PO lands about 20 days out instead of about 5.
    const gaps = (r: Run) => only(r.events, "poPlaced").filter((p) => p.supplier === "SUP-CHOC").map((p) => p.arriveDay - p.placedDay);
    expect(gaps(slow).length).toBeGreaterThan(0);
    for (const g of gaps(slow)) expect(g).toBeGreaterThanOrEqual(15);
    for (const g of gaps(base)) expect(g).toBeLessThanOrEqual(10);
    const opts = { startWeek: WEEK, days: 42, warmupWeeks: 8, seed: 3, faceCases: 3, policy: base.ctx.policy, delays: [] };
    const a = runInventory(base.ctx.model, base.ctx.catalog, opts);
    const b = runInventory(slow.ctx.model, slow.ctx.catalog, opts);
    expect(b.book.totals.cutInners).toBeGreaterThanOrEqual(a.book.totals.cutInners);
  });

  it("brings every supplier truck exactly on its appointment when the lateness spread is zero", async () => {
    const base = await baseline();
    const exact = await run({ inboundLatenessSdMin: 0 });
    expect(operationsOptions(exact.ctx, DAYS, SEED).disruptions).toEqual({ ...NO_DISRUPTIONS, inboundLatenessSdMin: 0 });
    const scheduled = only(exact.events, "truckScheduled");
    expect(scheduled.length).toBeGreaterThan(0);
    for (const s of scheduled) expect(s.eta).toBe(s.appointment);
    const arrivals = new Map(only(exact.events, "truckArrive").map((a) => [a.po, a.t]));
    for (const s of scheduled) expect(arrivals.get(s.po)).toBe(s.appointment);
    // The default spread of 30 min moves at least one truck off its appointment.
    expect(only(base.events, "truckScheduled").some((s) => s.eta !== s.appointment)).toBe(true);
    expect(NO_DISRUPTIONS.inboundLatenessSdMin).toBe(30);
  });

  it("runs a four-day week with no Friday trucks, and refuses delivery days the building is closed", async () => {
    // Specialty stores still deliver on Friday: the general override alone cannot work.
    await expect(buildTwin(DC, WEEK, { operatingDays: [1, 2, 3, 4], deliveryDays: { general: [1, 3] } })).rejects.toThrow(UnknownIdError);
    await expect(buildTwin(DC, WEEK, { operatingDays: [1, 2, 3, 4], deliveryDays: { general: [1, 3] } })).rejects.toThrow(/specialty stores receive deliveries on Fri/);
    await expect(buildTwin(DC, WEEK, { deliveryDays: { general: [6] } })).rejects.toThrow(/Sat/);
    await expect(buildTwin(DC, WEEK, { operatingDays: [2, 3, 4, 5] })).rejects.toThrow(/general stores receive deliveries on Mon/);

    const four = await run({ operatingDays: [4, 1, 3, 2, 2], deliveryDays: { general: [3, 1], specialty: [2] } });
    expect(four.ctx.site.operatingDays).toEqual([1, 2, 3, 4]);
    expect(four.ctx.site.deliveryDays).toEqual({ general: [1, 3], specialty: [2] });
    expect(four.ctx.changes).toEqual([
      "operating days Mon, Tue, Wed, Thu, Fri → Mon, Tue, Wed, Thu",
      "general delivery days Mon, Wed, Fri → Mon, Wed",
      "specialty delivery days Tue, Fri → Tue",
    ]);
    expect(four.result.trucks.length).toBeGreaterThan(0);
    for (const t of four.result.trucks) expect([1, 2, 3]).toContain(weekdayOf(t.day));
    for (const d of four.result.daily) {
      if (d.weekday >= 4) {
        expect(d.orders).toBe(0);
        expect(d.inboundTrucks).toBe(0);
      }
    }
    expect(only(four.events, "day").find((d) => d.weekday === 5)!.operating).toBe(false);
    expect(only(four.events, "worker").filter((e) => e.state === "in" && Math.floor(e.t / 1440) === 4)).toEqual([]);
    expect(findSite(DC).operatingDays).toEqual([1, 2, 3, 4, 5]);
  });

  it("staffs an evening shift with added workers, pays more hours and says the second shift is approximated", async () => {
    const base = await baseline();
    const two = await run({ shifts: [DAY, EVENING], addWorkers: [{ role: "selector", shift: "evening", type: "full-time", count: 1 }] });
    expect(two.ctx.site.shifts).toEqual([DAY, EVENING]);
    expect(two.ctx.changes).toEqual(["shifts: day 06:00–14:30, evening 14:30–23:00", SECOND_SHIFT_CAVEAT, "added 1 full-time order selector on evening"]);
    expect((two.events[0] as TraceInit).shifts.map((s) => s.id)).toEqual(["day", "evening"]);
    expect(two.result.labor.paidHours).toBeGreaterThan(base.result.labor.paidHours);
    expect(two.result.workers.find((w) => w.id === "NEW-01")!.shiftsWorked).toBeGreaterThan(0);
    const ins = only(two.events, "worker").filter((e) => e.state === "in" && e.id === "NEW-01");
    expect(ins.length).toBeGreaterThan(0);
    for (const e of ins) {
      expect(e.shift).toBe("evening");
      expect(e.t % 1440).toBe(14 * 60 + 30);
    }
    // A single replaced shift gets the note and no caveat; an overnight one runs.
    const one = await run({ shifts: [{ ...DAY, start: "22:00", end: "06:30" }] });
    expect(one.ctx.changes).toEqual(["shifts: day 22:00–06:30"]);
    expect(one.result.labor.paidHours).toBeGreaterThan(0);
    expect(findSite(DC).shifts).toEqual([DAY]);
  });

  it("rejects shifts that repeat an id, have no length, or drop a roster worker's home shift", async () => {
    await expect(buildTwin(DC, WEEK, { shifts: [DAY, { ...EVENING, id: "day" }] })).rejects.toThrow(UnknownIdError);
    await expect(buildTwin(DC, WEEK, { shifts: [DAY, { ...EVENING, id: "day" }] })).rejects.toThrow(/appears twice/);
    await expect(buildTwin(DC, WEEK, { shifts: [{ ...DAY, end: "06:00" }] })).rejects.toThrow(/starts and ends at 06:00/);
    await expect(buildTwin(DC, WEEK, { shifts: [{ ...DAY, end: "06:45", breakMin: 30, indirectMin: 30 }] })).rejects.toThrow(/shorter than/);
    await expect(buildTwin(DC, WEEK, { shifts: [{ ...DAY, start: "25:00" }] })).rejects.toThrow(/not a clock time/);
    await expect(buildTwin(DC, WEEK, { shifts: [{ ...DAY, id: "morning" }] })).rejects.toThrow(/home shift "day"/);
    await expect(buildTwin(DC, WEEK, { shifts: [EVENING], addWorkers: [{ role: "selector", shift: "evening", type: "temp", count: 1 }] })).rejects.toThrow(UnknownIdError);
  });

  it("re-racks a built-in building, refuses one the catalog no longer fits or that leaves the walls, and ignores rackZones under an imported layout", async () => {
    // 2 aisles × 2 sides × 10 bays × 4 levels = 160 faces for 281 SKUs.
    await expect(buildTwin(DC, WEEK, { rackZones: { pick: { aisles: 2 } } })).rejects.toThrow(LimitError);
    await expect(buildTwin(DC, WEEK, { rackZones: { pick: { aisles: 2 } } })).rejects.toThrow(/281 SKUs/);
    // 170 + 14 × 10 ft = 310 ft in a 300 ft building; 20 + 8 × 19 ft = 172 ft runs into the pick zone at 170.
    await expect(buildTwin(DC, WEEK, { rackZones: { pick: { aisles: 14 } } })).rejects.toThrow(LimitError);
    await expect(buildTwin(DC, WEEK, { rackZones: { pick: { aisles: 14 } } })).rejects.toThrow(/past the 300 × 230 ft building/);
    await expect(buildTwin(DC, WEEK, { rackZones: { reserve: { aisles: 8 } } })).rejects.toThrow(/overlaps the pick zone/);

    const tall = await buildTwin(DC, WEEK, { rackZones: { pick: { levels: 5 }, reserve: { aisles: 4, aisleWidthFt: 12 } } });
    expect(tall.layout.pick.length).toBe(5 * 2 * 10 * 5);
    expect(tall.layout.reserve.length).toBe(4 * 2 * 12 * 4);
    expect(tall.changes).toEqual(["pick zone 5 aisles × 10 bays × 5 levels", "reserve aisle width 11 → 12", "reserve zone 4 aisles × 12 bays × 4 levels"]);
    expect(findSite(DC).pick.levels).toBe(4);
    expect(findSite(DC).reserve.aisles).toBe(6);
    const r = runOperations(tall, operationsOptions(tall, DAYS, SEED));
    expect(r.reserve.positions).toBe(384);
    expect(r.service.trucks).toBeGreaterThan(0);
    // 13 aisles end exactly on the wall.
    const wide = await buildTwin(DC, WEEK, { rackZones: { pick: { aisles: 13 } } });
    expect(wide.layout.pick.length).toBe(13 * 2 * 10 * 4);

    const imported = await buildTwin(DC, WEEK, { layout: siteToSpec(findSite(DC)), rackZones: { pick: { aisles: 2 } } });
    expect(imported.changes).toEqual(['imported layout "dc-east" (builtin)', "rackZones ignored: layout imported"]);
    expect(imported.layout.pick.length).toBe(400);
  });

  it("rejects unknown worker and supplier ids and a reversed inbound window, and overrides added workers by their NEW-xx id", async () => {
    await expect(buildTwin(DC, WEEK, { workerOverrides: [{ worker: "W-X-1", productivity: 1.1 }] })).rejects.toThrow(UnknownIdError);
    // A dc-west id is unknown at dc-east.
    await expect(buildTwin(DC, WEEK, { workerOverrides: [{ worker: "W-W-001", productivity: 1.1 }] })).rejects.toThrow(/Unknown worker "W-W-001"/);
    await expect(buildTwin(DC, WEEK, { supplierOverrides: [{ supplier: "SUP-NOPE", leadDays: 9 }] })).rejects.toThrow(UnknownIdError);
    await expect(buildTwin(DC, WEEK, { supplierOverrides: [{ supplier: "SUP-NOPE", leadDays: 9 }] })).rejects.toThrow(/Unknown supplier "SUP-NOPE"/);
    await expect(buildTwin(DC, WEEK, { times: { inboundWindow: ["12:00", "07:00"] } })).rejects.toThrow(UnknownIdError);
    await expect(buildTwin(DC, WEEK, { times: { orderRelease: "17:60" } })).rejects.toThrow(/not a clock time/);

    const ctx = await buildTwin(DC, WEEK, { addWorkers: [{ role: "loader", shift: "day", type: "temp", count: 1 }], workerOverrides: [{ worker: "NEW-01", hourlyRate: 30, maxWeeklyHours: 20 }] });
    expect(ctx.workers.find((w) => w.id === "NEW-01")).toMatchObject({ hourlyRate: 30, maxWeeklyHours: 20, productivity: 1 });
    expect(ctx.changes).toEqual(["added 1 temp loader on day", "NEW-01 weekly hours 40 → 20", "NEW-01 hourly rate 27 → 30"]);
    const window = await buildTwin(DC, WEEK, { times: { inboundWindow: ["06:00", "10:00"], orderRelease: "17:00" } });
    expect(window.site.times.inboundWindow).toEqual(["06:00", "10:00"]);
    expect(window.changes).toEqual(["inbound window 07:00–12:00 → 06:00–10:00"]);
  });

  it("leaves the base standards, catalog and disruptions untouched", () => {
    const changes: string[] = [];
    const std = extensionStandards(DEFAULT_STANDARDS, { standards: { pickPerLine: 0.5, walkFtPerMin: 180 } }, changes);
    expect(std).toEqual({ ...DEFAULT_STANDARDS, pickPerLine: 0.5 });
    expect(DEFAULT_STANDARDS.pickPerLine).toBe(0.35);
    expect(changes).toEqual(["standards: pickPerLine 0.35 → 0.5"]);
    expect(extensionStandards(DEFAULT_STANDARDS, {}, changes)).toBe(DEFAULT_STANDARDS);

    const catalog = loadCatalog();
    const before = structuredClone(catalog.suppliers);
    const hard = catalog.suppliers.find((s) => s.id === "SUP-HARD")!;
    const c2 = extensionCatalog(catalog, { supplierOverrides: [{ supplier: "SUP-HARD", orderDay: 5 }, { supplier: "SUP-HARD", leadSdDays: 3 }] }, changes);
    expect(c2.skus).toBe(catalog.skus);
    expect(c2.suppliers.find((s) => s.id === "SUP-HARD")).toEqual({ ...hard, orderDay: 5, leadSdDays: 3 });
    for (const s of c2.suppliers) if (s.id !== "SUP-HARD") expect(catalog.suppliers).toContain(s);
    expect(catalog.suppliers).toEqual(before);
    expect(changes.slice(1)).toEqual([`SUP-HARD order day ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][hard.orderDay - 1]} → Fri`, `SUP-HARD lead time sd ${hard.leadSdDays} → 3`]);
    expect(extensionCatalog(catalog, {}, changes)).toBe(catalog);
    expect(extensionCatalog(catalog, { supplierOverrides: [] }, changes)).toBe(catalog);

    expect(extensionDisruptions(NO_DISRUPTIONS, {})).toEqual(NO_DISRUPTIONS);
    expect(extensionDisruptions(NO_DISRUPTIONS, { inboundLatenessSdMin: 0 })).toEqual({ ...NO_DISRUPTIONS, inboundLatenessSdMin: 0 });
    expect(NO_DISRUPTIONS.inboundLatenessSdMin).toBe(30);
  });
});
