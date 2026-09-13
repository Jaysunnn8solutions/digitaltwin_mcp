/**
 * Every importer reads the same sample warehouse, drawn the way that format's
 * users draw it, and must recover the same building: 480 pick faces in six
 * aisles, 400 reserve positions, four receiving and four shipping doors.
 */
import { describe, expect, it } from "vitest";
import { runOperations } from "../twin/operations";
import { buildTwin, operationsOptions } from "../twin/twin";
import { readDxf } from "./dxf";
import { importLayout, layoutStats, type ImportResult } from "./import";
import { LimitError, LIMITS } from "./limits";
import { sampleCsv, sampleDxf, sampleIfc, sampleImdf, sampleIndoors } from "./samples";
import { layoutSpecSchema } from "./spec";

function expectSampleBuilding(r: ImportResult) {
  expect(r.buildError).toBeNull();
  expect(r.stats).not.toBeNull();
  expect(r.stats!.pickFaces).toBe(480);
  expect(r.stats!.pickAisles).toBe(6);
  expect(r.stats!.reservePositions).toBe(400);
  expect(r.report.doors).toEqual({ inbound: 4, outbound: 4 });
  // Doors on the dock wall, building about 260 × 190 ft.
  for (const d of r.spec.doors) expect(d.y).toBeLessThan(10);
  // A CSV has no outline, so its extent is the racks plus a margin.
  expect(Math.max(r.spec.widthFt, r.spec.depthFt)).toBeGreaterThan(r.report.format === "csv" ? 200 : 250);
  expect(Math.max(r.spec.widthFt, r.spec.depthFt)).toBeLessThan(300);
  // The spec is valid tool input and compact.
  expect(() => layoutSpecSchema.parse(r.spec)).not.toThrow();
  expect(JSON.stringify(r.spec).length).toBeLessThan(20_000);
}

describe("layout import", () => {
  it("reads a rotated DXF in millimeters with block racks, loose wall lines and door layers", async () => {
    const r = await importLayout({ fileName: "sample-dc.dxf", text: sampleDxf() }, {}, "browser");
    expect(r.report.format).toBe("dxf");
    expect(r.report.units).toMatch(/millimeters/);
    expect(r.report.walls).toBeGreaterThan(0);
    expect(r.report.sources.find((s) => s.source === "A-ANNO-DIMS")?.role).toBe("ignore");
    expectSampleBuilding(r);
  });

  it("reads a WMS location CSV with coordinates and door rows", async () => {
    const r = await importLayout({ fileName: "locations.csv", text: sampleCsv() }, {}, "inline");
    expect(r.report.format).toBe("csv");
    expectSampleBuilding(r);
  });

  it("reads an IMDF archive in lon/lat, turned off the meridian", async () => {
    const r = await importLayout({ fileName: "sample-dc.zip", bytes: sampleImdf() }, {}, "browser");
    expect(r.report.format).toBe("imdf");
    expectSampleBuilding(r);
  });

  it("reads ArcGIS Indoors GeoJSON in Web Mercator", async () => {
    const r = await importLayout({ files: sampleIndoors() }, {}, "browser");
    expect(r.spec.source.format).toBe("indoors");
    expect(r.spec.source.notes.join(" ")).toMatch(/Web Mercator/);
    expectSampleBuilding(r);
  });

  it("reads IFC4 through web-ifc", async () => {
    const r = await importLayout({ fileName: "sample-dc.ifc", bytes: new TextEncoder().encode(sampleIfc()) }, {}, "local");
    expect(r.report.format).toBe("ifc");
    expectSampleBuilding(r);
  }, 30_000);

  it("simulates an imported building with a center's demand and crew", async () => {
    const r = await importLayout({ fileName: "sample-dc.dxf", text: sampleDxf() }, {}, "browser");
    const ctx = await buildTwin("dc-east", 36, { layout: r.spec, slotting: "optimized" });
    expect(ctx.layout.pick.length).toBe(480);
    expect(ctx.site.doors).toEqual({ inbound: 4, outbound: 4 });
    const res = runOperations(ctx, operationsOptions(ctx, 5, 1));
    expect(res.service.trucks).toBeGreaterThan(0);
    expect(res.volume.innersShipped).toBeGreaterThan(0);
  });

  it("follows a roleMap over the built-in guesses", async () => {
    // Call every rack pick: the pallet rows become pick faces too.
    const r = await importLayout({ fileName: "sample-dc.dxf", text: sampleDxf() }, { roleMap: { "RACK-PALLET": "pick" } }, "browser");
    expect(r.report.racks.reserve).toBe(0);
    expect(r.stats).toBeNull();
    expect(r.buildError).toMatch(/no reserve/i);
  });

  it("rejects what it should, with the reason and where to go instead", async () => {
    await expect(importLayout({ fileName: "plan.dwg", bytes: new Uint8Array([65, 67, 49, 48, 51, 50]) }, {}, "browser")).rejects.toThrow(/DXF/);
    await expect(importLayout({ fileName: "big.dxf", text: "x".repeat(LIMITS.inline.text + 1) }, {}, "inline")).rejects.toThrow(LimitError);
    await expect(importLayout({ fileName: "m.ifc", text: sampleIfc() }, {}, "inline")).rejects.toThrow(/not accepted by the hosted/);
    await expect(importLayout({ fileName: "empty.csv", text: "aisle,bay\n" }, {}, "inline")).rejects.toThrow(/at least one location/);
    expect(() => readDxf("AutoCAD Binary DXF\r\n")).toThrow(/binary DXF/);
  });

  it("lays out a CSV without coordinates at standard pitches, odd bays left", async () => {
    const rows = ["aisle,bay,level,zone"];
    for (const a of ["01", "02", "03", "04", "05", "06"]) for (let b = 1; b <= 20; b++) for (let lv = 1; lv <= 4; lv++) rows.push(`P${a},${b},${lv},pick`);
    for (const a of ["01", "02"]) for (let b = 1; b <= 20; b++) for (let lv = 1; lv <= 4; lv++) rows.push(`R${a},${b},${lv},reserve`);
    const r = await importLayout({ fileName: "noxy.csv", text: rows.join("\n") }, {}, "inline");
    expect(r.buildError).toBeNull();
    expect(r.stats!.pickFaces).toBe(6 * 20 * 4);
    expect(r.stats!.reservePositions).toBe(2 * 20 * 4);
    expect(r.spec.source.notes.join(" ")).toMatch(/No coordinates/);
  });

  it("dry-runs a spec without a site", () => {
    const { stats, error } = layoutStats({ version: 1, name: "x", source: { format: "csv", notes: [] }, widthFt: 50, depthFt: 50, outline: [], walls: [], zones: [], racks: [{ id: "a", use: "pick", x: 10, y0: 10, y1: 30, depthFt: 2, bays: 2, levels: 1, slotsPerBay: 1 }], doors: [], aisleWidthFt: 8 });
    expect(stats).toBeNull();
    expect(error).toMatch(/reserve/);
  });
});
