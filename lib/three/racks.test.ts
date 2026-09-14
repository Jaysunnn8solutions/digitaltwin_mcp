/**
 * Instance counts follow the layout exactly (the compiler addresses faces and
 * reserve positions by index), the steel is merged into a few meshes, and a
 * building at the face limit builds fast.
 */
import { describe, expect, it } from "vitest";
import { Color, Matrix4 } from "three";
import sitesJson from "../../data/sites.json";
import { readCsv } from "../layout/csv";
import { sampleCsv } from "../layout/samples";
import type { LayoutSpec, RackRun } from "../layout/spec";
import { buildLayout, siteToSpec } from "../twin/layout";
import type { Site } from "../twin/types";
import { worldFromLayout } from "./building";
import { ResourceTracker } from "./geometry";
import { buildRacks, defaultLevelHeights, MAX_STACK } from "./racks";

const sites = sitesJson as Site[];
const siteOf = (id: string) => sites.find((s) => s.id === id)!;

function racksFor(spec: LayoutSpec, site: Site) {
  const layout = buildLayout(spec, site);
  const world = worldFromLayout(layout);
  const tracker = new ResourceTracker();
  const racks = buildRacks(layout, world, { tracker, quality: "high" });
  return { layout, racks, tracker };
}

function synthetic25k(): LayoutSpec {
  const racks: RackRun[] = [];
  // 12 facing pairs plus one single-sided run: 25 pick runs × 200 bays × 5 levels = 25,000 faces.
  for (let a = 0; a < 13; a++) {
    const cx = 10 + a * 10;
    racks.push({ id: `P${a}L`, use: "pick", x: cx - 4, y0: 10, y1: 1610, depthFt: 2, bays: 200, levels: 5, slotsPerBay: 1 });
    if (a < 12) racks.push({ id: `P${a}R`, use: "pick", x: cx + 4, y0: 10, y1: 1610, depthFt: 2, bays: 200, levels: 5, slotsPerBay: 1 });
  }
  racks.push({ id: "R1L", use: "reserve", x: 160, y0: 10, y1: 100, depthFt: 4, bays: 10, levels: 4, slotsPerBay: 1 });
  racks.push({ id: "R1R", use: "reserve", x: 175, y0: 10, y1: 100, depthFt: 4, bays: 10, levels: 4, slotsPerBay: 1 });
  return {
    version: 1,
    name: "synthetic-25k",
    source: { format: "csv", notes: [] },
    widthFt: 200,
    depthFt: 1700,
    outline: [],
    walls: [],
    zones: [],
    racks,
    doors: [
      { id: "IN-1", kind: "inbound", x: 30, y: 0, widthFt: 9 },
      { id: "OUT-1", kind: "outbound", x: 150, y: 0, widthFt: 9 },
    ],
    aisleWidthFt: 10,
  };
}

describe("buildRacks", () => {
  it.each([
    ["dc-west", 320, 320],
    ["dc-east", 400, 576],
  ])("%s: faces and reserve instances match the layout (%i / %i)", (dc, faces, reserve) => {
    const site = siteOf(dc);
    const { layout, racks } = racksFor(siteToSpec(site), site);
    expect(layout.pick).toHaveLength(faces);
    expect(layout.reserve).toHaveLength(reserve);
    expect(racks.faces.count).toBe(faces);
    expect(racks.reserve.count).toBe(reserve);
    expect(racks.reserveStack.count).toBe(2 * reserve);
    expect(racks.faceIndex.get(layout.pick[0].id)).toBe(0);
    expect(racks.reserveIndex.get(layout.reserve[reserve - 1].id)).toBe(reserve - 1);
  });

  it("the CSV sample: 480 faces and 400 positions", () => {
    const site = siteOf("dc-east");
    const { spec } = readCsv(sampleCsv(), { name: "sample", format: "csv" });
    const { racks } = racksFor(spec, site);
    expect(racks.faces.count).toBe(480);
    expect(racks.reserve.count).toBe(400);
  });

  it("merges the steel into at most three meshes per use", () => {
    const site = siteOf("dc-east");
    const { racks } = racksFor(siteToSpec(site), site);
    for (const use of ["pick", "reserve", "mixed"]) expect(racks.frames.filter((m) => m.userData.use === use).length).toBeLessThanOrEqual(3);
    expect(racks.frames.length).toBeGreaterThan(0);
    // Uprights, beams and decks: one structure mesh and one deck mesh for pick, one structure for reserve.
    expect(racks.frames.map((m) => m.name).sort()).toEqual(["deck:pick", "rack:pick", "rack:reserve"]);
  });

  it("puts a face in the run on its side of the aisle, at its level's height", () => {
    const site = siteOf("dc-west");
    const { layout, racks } = racksFor(siteToSpec(site), site);
    const m = new Matrix4();
    const first = layout.pick[0];
    expect(first.id).toBe("P01-L01-1");
    racks.faces.getMatrixAt(0, m);
    // Left run of pick aisle 0 is at x = 131 (aisle at 135, depth 2 → face at 132).
    expect(m.elements[12]).toBeCloseTo(131, 5);
    expect(m.elements[14]).toBeCloseTo(-first.y, 5);
    const level4 = layout.pick.findIndex((l) => l.level === 4);
    racks.faces.getMatrixAt(level4, m);
    expect(m.elements[13]).toBeGreaterThan(4.5);
    expect(defaultLevelHeights({ id: "m", use: "mixed", x: 0, y0: 0, y1: 9, depthFt: 4, bays: 1, levels: 4, slotsPerBay: 1 })).toEqual([0, 1.5, 6.5, 11.5]);
  });

  it("fill scales Y, a hidden face is scale 0, stacks split the pallet height", () => {
    const site = siteOf("dc-west");
    const { racks } = racksFor(siteToSpec(site), site);
    const m = new Matrix4();
    const c = new Color(0x00ff00);
    racks.setFace(0, 1, c);
    racks.faces.getMatrixAt(0, m);
    const full = m.elements[5];
    racks.setFace(0, 0.5, c);
    racks.faces.getMatrixAt(0, m);
    expect(m.elements[5]).toBeCloseTo(full / 2, 6);
    racks.setFace(0, -1, null);
    racks.faces.getMatrixAt(0, m);
    expect(m.elements[5]).toBe(0);
    racks.setReserve(0, 0, c);
    racks.reserve.getMatrixAt(0, m);
    expect(m.elements[5]).toBe(0);
    racks.setReserve(0, 3, c);
    racks.reserve.getMatrixAt(0, m);
    expect(m.elements[5]).toBeCloseTo(1 / 3, 6);
    racks.reserveStack.getMatrixAt(racks.reserve.count + 0, m);
    expect(m.elements[5]).toBeCloseTo(1 / 3, 6);
    racks.setReserve(0, MAX_STACK + 2, c);
    expect(racks.stackCount[0]).toBe(MAX_STACK + 2);
    racks.setReserve(0, 1, c);
    racks.reserveStack.getMatrixAt(0, m);
    expect(m.elements[5]).toBe(0);
  });

  it("builds a 25k-face building in under 500 ms", () => {
    const site = siteOf("dc-east");
    const spec = synthetic25k();
    const layout = buildLayout(spec, site);
    expect(layout.pick).toHaveLength(25_000);
    const world = worldFromLayout(layout);
    const tracker = new ResourceTracker();
    const t0 = performance.now();
    const racks = buildRacks(layout, world, { tracker, quality: "low" });
    const ms = performance.now() - t0;
    expect(racks.faces.count).toBe(25_000);
    expect(ms).toBeLessThan(500);
    racks.dispose();
    tracker.disposeAll();
    expect(tracker.disposed).toBe(tracker.created);
  });
});
