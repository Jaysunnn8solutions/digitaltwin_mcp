/**
 * The scenario form: a scenario survives the trip through the form and back,
 * candystore never comes out of it, the Space tab's face check catches a
 * building too small for the catalog, and zod issues land on the field that
 * caused them.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_STANDARDS } from "../twin/standards";
import type { TwinScenario } from "../twin/twin";
import { applyImportEdits, builtinPickFaces, checkFaces, emptyForm, extensionHelp, fieldHelp, formFieldCount, formToScenario, importPickFaces, issuesToErrors, scenarioToForm, STANDARD_KEYS } from "./form";
import type { LayoutSpec } from "../layout/spec";

const full: TwinScenario = {
  demandScale: 1.3,
  demandShocks: [{ fromDay: 3, toDay: 9, factor: 2.5, category: "traditional" }],
  slotting: "optimized",
  forecast: "trailing",
  serviceLevel: 0.95,
  supplierDelays: [{ fromDay: 0, toDay: 20, category: "specialty:latam", extraDays: 14 }],
  absenteeism: 0.1,
  doorOutages: [
    { fromDay: 0, toDay: 2, kind: "inbound", count: 1 },
    { fromDay: 5, toDay: 6, kind: "outbound", count: 2 },
  ],
  forkliftOutages: [{ fromDay: 1, toDay: 1, count: 1 }],
  wmsOutages: [{ day: 1, start: "07:00", hours: 3 }],
  workerLeave: [{ fromDay: 0, toDay: 4, role: "Forklift operator" }],
  addWorkers: [{ role: "selector", shift: "day", type: "temp", count: 2 }],
  removeWorkers: ["W-E-004"],
  crossTrain: [{ role: "Order selector", skill: "forklift" }],
  flex: false,
  overtimeMaxHours: 3,
  forklifts: 2,
  palletJacks: 4,
  inboundDoors: 3,
  outboundDoors: 3,
  faceCases: 5,
  targetUtilization: 0.9,
  shifts: [
    { id: "day", start: "06:00", end: "14:30", breakMin: 30, indirectMin: 30 },
    { id: "evening", start: "14:30", end: "23:00", breakMin: 30, indirectMin: 15 },
  ],
  operatingDays: [1, 2, 3, 4, 5, 6],
  times: { orderRelease: "16:00", truckDeparture: "15:00", inboundWindow: ["06:00", "11:00"] },
  deliveryDays: { general: [1, 3, 5], specialty: [2, 6] },
  workerOverrides: [{ worker: "W-E-003", productivity: 1.2, maxWeeklyHours: 32, hourlyRate: 20 }],
  standards: { walkFtPerMin: 200, pickPerLine: 0.4 },
  supplierOverrides: [{ supplier: "SUP-CHOC", leadDays: 9, leadSdDays: 2, orderDay: 3 }],
  inboundLatenessSdMin: 10,
  rackZones: { pick: { levels: 5, slotsPerBay: 1 }, reserve: { aisles: 5 } },
};

describe("ScenarioForm ↔ TwinScenario", () => {
  it("round-trips a scenario that sets every field", () => {
    const form = scenarioToForm(full);
    const back = formToScenario(form);
    expect(back.errors).toEqual({});
    expect(back.scenario).toEqual(full);
    // And the form itself survives scenario → form → scenario → form.
    expect(scenarioToForm(back.scenario!)).toEqual(form);
    expect(formFieldCount(form)).toBe(Object.keys(full).length);
  });

  it("an empty form is an empty scenario; blank rows and lists are dropped", () => {
    expect(formToScenario(emptyForm())).toEqual({ scenario: {}, errors: {} });
    const f = emptyForm();
    f.doorOutages = [{ fromDay: "", toDay: "", kind: "", count: "" }];
    f.demandShocks = [{ fromDay: "", toDay: "", factor: "", category: "" }];
    f.removeWorkers = ["", "  "];
    f.deliveryGeneral = [];
    f.standards.walkFtPerMin = "   ";
    expect(formToScenario(f)).toEqual({ scenario: {}, errors: {} });
    expect(formFieldCount(f)).toBe(0);
  });

  it("sorts and de-duplicates weekday sets and splits the site clock into its inputs", () => {
    const f = emptyForm();
    f.operatingDays = [5, 1, 3, 1];
    f.deliverySpecialty = [2];
    f.orderRelease = "16:30";
    f.inboundWindowStart = "06:00";
    f.inboundWindowEnd = "10:00";
    const r = formToScenario(f);
    expect(r.scenario).toEqual({ operatingDays: [1, 3, 5], deliveryDays: { specialty: [2] }, times: { orderRelease: "16:30", inboundWindow: ["06:00", "10:00"] } });
    const g = scenarioToForm(r.scenario!);
    expect(g.inboundWindowStart).toBe("06:00");
    expect(g.inboundWindowEnd).toBe("10:00");
    expect(g.orderRelease).toBe("16:30");
    expect(g.truckDeparture).toBe("");
  });

  it("never emits candystore, even when the scenario it reads carried one", () => {
    const withStore = { ...full, candystore: { add: [{ type: "general" as const, lon: -84, lat: 33 }] } };
    const form = scenarioToForm(withStore);
    expect(JSON.stringify(form)).not.toContain("candystore");
    const back = formToScenario(form);
    expect(back.scenario).not.toBeNull();
    expect("candystore" in back.scenario!).toBe(false);
    expect("layout" in back.scenario!).toBe(false);
    expect(Object.keys(emptyForm())).not.toContain("candystore");
  });

  it("maps zod issues to the field that caused them, and pre-checks non-numeric text", () => {
    const f = emptyForm();
    f.demandScale = "99";
    f.doorOutages = [
      { fromDay: "0", toDay: "1", kind: "inbound", count: "1" },
      { fromDay: "2", toDay: "3", kind: "sideways", count: "0" },
    ];
    f.standards.walkFtPerMin = "fast";
    f.rackPick.levels = "40";
    f.inboundWindowStart = "06:00";
    f.faceCases = "2";
    const r = formToScenario(f);
    expect(r.scenario).toBeNull();
    expect(Object.keys(r.errors).sort()).toEqual(["demandScale", "doorOutages.1.count", "doorOutages.1.kind", "inboundWindowEnd", "rackPick.levels", "standards.walkFtPerMin"]);
    expect(r.errors["standards.walkFtPerMin"]).toContain("not a number");
    expect(r.errors.inboundWindowEnd).toContain("both");
    // A valid form keeps the good fields.
    f.demandScale = "1.5";
    f.doorOutages.pop();
    f.standards.walkFtPerMin = "";
    f.rackPick.levels = "5";
    f.inboundWindowEnd = "10:00";
    const ok = formToScenario(f);
    expect(ok.errors).toEqual({});
    expect(ok.scenario).toEqual({ demandScale: 1.5, doorOutages: [{ fromDay: 0, toDay: 1, kind: "inbound", count: 1 }], rackZones: { pick: { levels: 5 } }, times: { inboundWindow: ["06:00", "10:00"] }, faceCases: 2 });
    // Nested schema paths land on the flattened inputs.
    expect(issuesToErrors([{ path: ["times", "inboundWindow", 1], message: "HH:MM" }])).toEqual({ inboundWindowEnd: "HH:MM" });
    expect(issuesToErrors([{ path: ["deliveryDays", "specialty", 0], message: "x" }])).toEqual({ deliverySpecialty: "x" });
    expect(issuesToErrors([{ path: ["rackZones", "reserve", "aisles"], message: "x" }])).toEqual({ "rackReserve.aisles": "x" });
    expect(issuesToErrors([{ path: [], message: "Unrecognized key" }])).toEqual({ "": "Unrecognized key" });
  });

  it("pre-validates the pick faces against the catalog before Run", () => {
    const east = { aisles: 5, baysPerSide: 10, levels: 4, slotsPerBay: 1 };
    const f = emptyForm();
    expect(builtinPickFaces(f, east)).toBe(400);
    expect(checkFaces(400, 281)).toBeNull();
    f.rackPick.aisles = "2";
    expect(builtinPickFaces(f, east)).toBe(160);
    expect(checkFaces(160, 281)).toMatch(/281 SKUs.*160/);
    f.rackPick.levels = "5";
    f.rackPick.slotsPerBay = "2";
    expect(builtinPickFaces(f, east)).toBe(400);
    expect(checkFaces(builtinPickFaces(f, east), 281)).toBeNull();
    f.rackPick.aisles = "abc";
    expect(builtinPickFaces(f, east)).toBe(1000);
  });

  it("applies import edits through compactSpec and counts the faces they yield", () => {
    const spec: LayoutSpec = {
      version: 1,
      name: "t",
      source: { format: "csv", notes: [] },
      widthFt: 100.04,
      depthFt: 80,
      outline: [],
      walls: [],
      zones: [],
      racks: [
        { id: "a", use: "pick", x: 10.123, y0: 0, y1: 40, depthFt: 2, bays: 5, levels: 4, slotsPerBay: 1 },
        { id: "b", use: "mixed", x: 20, y0: 0, y1: 40, depthFt: 4, bays: 5, levels: 4, slotsPerBay: 1 },
        { id: "c", use: "reserve", x: 30, y0: 0, y1: 40, depthFt: 4, bays: 5, levels: 4, slotsPerBay: 1 },
      ],
      doors: [],
      aisleWidthFt: 10,
    };
    expect(importPickFaces(spec)).toBe(25);
    expect(applyImportEdits(spec, { levels: "", slotsPerBay: "", aisleWidthFt: "" })).toBe(spec);
    const edited = applyImportEdits(spec, { levels: "6", slotsPerBay: "2", aisleWidthFt: "12" });
    expect(edited.racks.map((r) => [r.levels, r.slotsPerBay])).toEqual([
      [6, 2],
      [6, 2],
      [6, 1],
    ]);
    expect(edited.aisleWidthFt).toBe(12);
    expect(edited.racks[0].x).toBe(10.1);
    expect(edited.widthFt).toBe(100);
    expect(importPickFaces(edited)).toBe(5 * 6 * 2 + 5 * 2);
    expect(checkFaces(importPickFaces(spec), 281)).toMatch(/25/);
  });

  it("reads help text from the schema descriptions", () => {
    expect(fieldHelp("demandScale")).toMatch(/demand/i);
    expect(fieldHelp("absenteeism")).toContain("0.04");
    expect(fieldHelp("doorOutages").length).toBeGreaterThan(10);
    expect(extensionHelp("shifts")).toMatch(/shift/i);
    expect(extensionHelp("inboundLatenessSdMin")).toContain("30");
    expect(STANDARD_KEYS.every((k) => k in DEFAULT_STANDARDS)).toBe(true);
    expect(STANDARD_KEYS).toHaveLength(19);
  });
});
