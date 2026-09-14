/**
 * Every route reproduces the engine's distance to 1e-6, is axis-aligned, and
 * stays off the racks: on the corridor rows with offsets on, on the engine's
 * own lines (rack ends, never a rack interior) with offsets off.
 */
import "../data/load";
import { describe, expect, it } from "vitest";
import { importLayout } from "../layout/import";
import { sampleCsv } from "../layout/samples";
import type { LayoutSpec } from "../layout/spec";
import { buildLayout, depotDistance, dockToRack, rackToRack, sShapeDistance, siteToSpec, type Layout, type Location } from "../twin/layout";
import { DEFAULT_STANDARDS } from "../twin/standards";
import { buildTwin } from "../twin/twin";
import { seededRandom, type Rng } from "../util/random";
import { depotPath, dockToRackPath, pathFeet, rackToRackPath, segmentHitsRack, sShapePath, transferPath, visualOffset, type Path } from "./paths";
import type { Pt, World } from "./types";
import { buildWorld } from "./world";

const std = DEFAULT_STANDARDS;

async function layouts(): Promise<Array<{ name: string; layout: Layout; world: World }>> {
  const west = (await buildTwin("dc-west", 36, {})).layout;
  const east = (await buildTwin("dc-east", 36, {})).layout;
  const csv = await importLayout({ fileName: "locations.csv", text: sampleCsv() }, {}, "inline");
  const imported = (await buildTwin("dc-east", 36, { layout: csv.spec })).layout;
  // A small building with mixed runs: level 1 picks, pallets above, in the same physical aisle.
  const site = (await buildTwin("dc-west", 36, {})).site;
  const mixedSpec: LayoutSpec = {
    ...siteToSpec(site),
    name: "mixed",
    source: { format: "csv", notes: [] },
    racks: [0, 1, 2].flatMap((a) => [
      { id: `M${a}L`, use: "mixed" as const, x: 40 + a * 14, y0: 50, y1: 130, depthFt: 4, bays: 10, levels: 4, slotsPerBay: 1 },
      { id: `M${a}R`, use: "mixed" as const, x: 50 + a * 14, y0: 50, y1: 130, depthFt: 4, bays: 10, levels: 4, slotsPerBay: 1 },
    ]),
  };
  const mixed = buildLayout(mixedSpec, site);
  return [
    { name: "dc-west", layout: west, world: buildWorld(west, []) },
    { name: "dc-east", layout: east, world: buildWorld(east, []) },
    { name: "csv", layout: imported, world: buildWorld(imported, []) },
    { name: "mixed", layout: mixed, world: buildWorld(mixed, []) },
  ];
}

function pickN<T>(rng: Rng, xs: readonly T[], n: number): T[] {
  const out: T[] = [];
  const used = new Set<number>();
  while (out.length < Math.min(n, xs.length)) {
    const i = Math.floor(rng() * xs.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(xs[i]);
  }
  return out;
}

function axisAligned(p: Path) {
  for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1];
    const b = p.pts[i];
    expect(Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[1] - b[1]) < 1e-9).toBe(true);
  }
}

function offRacks(layout: Layout, p: Path, closed: boolean, label: string) {
  for (let i = 1; i < p.pts.length; i++) {
    const hit = segmentHitsRack(layout, p.pts[i - 1], p.pts[i], closed);
    if (hit) throw new Error(`${label}: segment ${JSON.stringify(p.pts[i - 1])} → ${JSON.stringify(p.pts[i])} enters a rack (${closed ? "closed" : "open"})`);
  }
}

function monotone(pts: Pt[]) {
  // Out and back: x and y never reverse direction within each half.
  const half = Math.floor(pts.length / 2);
  for (const [from, to] of [
    [0, half],
    [half, pts.length - 1],
  ]) {
    let sx = 0;
    let sy = 0;
    for (let i = from + 1; i <= to; i++) {
      const dx = Math.sign(pts[i][0] - pts[i - 1][0]);
      const dy = Math.sign(pts[i][1] - pts[i - 1][1]);
      if (dx !== 0) {
        expect(sx === 0 || sx === dx).toBe(true);
        sx = dx;
      }
      if (dy !== 0) {
        expect(sy === 0 || sy === dy).toBe(true);
        sy = dy;
      }
    }
  }
}

describe("paths", () => {
  it("sShapePath equals sShapeDistance for 200 seeded random tours per layout", async () => {
    for (const { name, layout, world } of await layouts()) {
      const rng = seededRandom(7);
      for (let k = 0; k < 200; k++) {
        const locs = pickN(rng, layout.pick, 1 + Math.floor(rng() * 8));
        const lines = locs.map((loc) => ({ loc, inners: 1 + Math.floor(rng() * 20) }));
        const p = sShapePath(layout, lines, std);
        expect(pathFeet(p.pts)).toBeCloseTo(sShapeDistance(layout, locs), 6);
        expect(p.feet).toBeCloseTo(sShapeDistance(layout, locs), 6);
        expect(p.stops.length).toBe(lines.length + 1);
        const handled = p.stops.reduce((a, s) => a + s.minutes, 0);
        const expected = std.pickPerTour + lines.reduce((a, l) => a + std.pickPerLine + std.pickPerInner * l.inners + ([2, 3].includes(l.loc.level) ? 0 : std.pickBendReachSec / 60), 0);
        expect(handled).toBeCloseTo(expected, 9);
        axisAligned(p);
        offRacks(layout, p, false, `${name} tour ${k} (offsets off)`);
        const v = visualOffset(p, world, layout);
        axisAligned(v);
        offRacks(layout, v, true, `${name} tour ${k} (offsets on)`);
        expect(v.stops.length).toBe(p.stops.length);
        for (const s of v.stops) expect(s.at).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("depotPath is 2·depotDistance and dockToRackPath is 2·dockToRack and monotone", async () => {
    for (const { name, layout, world } of await layouts()) {
      const rng = seededRandom(11);
      const doors = layout.doors.filter((d) => d.kind === "inbound");
      for (let k = 0; k < 100; k++) {
        const loc = layout.pick[Math.floor(rng() * layout.pick.length)];
        const p = depotPath(layout, loc, std, 5);
        expect(p.feet).toBeCloseTo(2 * depotDistance(layout, loc), 6);
        axisAligned(p);
        offRacks(layout, p, false, `${name} depot`);
        offRacks(layout, visualOffset(p, world, layout), true, `${name} depot (offsets)`);
        const door = doors[Math.floor(rng() * doors.length)];
        const r = layout.reserve[Math.floor(rng() * layout.reserve.length)];
        const d = dockToRackPath(layout, world, [door.x, door.y], [{ loc: r, minutes: 2 }]);
        expect(d.feet).toBeCloseTo(2 * dockToRack(door, r), 6);
        axisAligned(d);
        monotone(d.pts);
        offRacks(layout, d, false, `${name} dock`);
        offRacks(layout, visualOffset(d, world, layout), true, `${name} dock (offsets)`);
        // A mixed pallet visits every position; the farthest sets the engine's number, the route is at least that.
        const locs = pickN(rng, layout.reserve, 3);
        const m = dockToRackPath(layout, world, [door.x, door.y], locs.map((l) => ({ loc: l, minutes: 2 })));
        expect(m.feet).toBeGreaterThanOrEqual(2 * Math.max(...locs.map((l) => dockToRack(door, l))) - 1e-6);
        expect(m.stops.map((s) => s.loc)).toEqual([...locs].sort((a, b) => dockToRack(door, a) - dockToRack(door, b)).map((l) => l.id));
        axisAligned(m);
      }
    }
  });

  it("rackToRackPath is 2·rackToRack, including same-aisle and mixed-run pairs", async () => {
    for (const { name, layout, world } of await layouts()) {
      const rng = seededRandom(13);
      const pairs: Array<[Location, Location]> = [];
      for (let k = 0; k < 100; k++) {
        pairs.push([layout.reserve[Math.floor(rng() * layout.reserve.length)], layout.pick[Math.floor(rng() * layout.pick.length)]]);
        pairs.push([layout.reserve[Math.floor(rng() * layout.reserve.length)], layout.reserve[Math.floor(rng() * layout.reserve.length)]]);
      }
      // Same aisle, and (for mixed runs) same physical aisle across zones.
      const a0 = layout.reserve.filter((l) => l.aisle === 0);
      pairs.push([a0[0], a0[a0.length - 1]]);
      const sameX = layout.pick.find((p) => Math.abs(p.x - layout.reserve[0].x) < 1e-9);
      if (sameX) pairs.push([layout.reserve[0], sameX]);
      for (const [a, b] of pairs) {
        const p = rackToRackPath(layout, a, b, 1, 1);
        expect(p.feet).toBeCloseTo(2 * rackToRack(layout, a, b), 6);
        axisAligned(p);
        offRacks(layout, p, false, `${name} rack ${a.id}→${b.id}`);
        const v = visualOffset(p, world, layout);
        axisAligned(v);
        offRacks(layout, v, true, `${name} rack ${a.id}→${b.id} (offsets)`);
        expect(v.stops.length).toBe(2);
      }
      if (name === "mixed") {
        // Reserve level 2 above a pick face in the same aisle still routes via the front, like the engine.
        const r = layout.reserve[0];
        const p = layout.pick.find((l) => Math.abs(l.x - r.x) < 1e-9 && l.bay === r.bay)!;
        expect(rackToRack(layout, r, p)).toBeGreaterThan(Math.abs(r.y - p.y) + 1);
        expect(rackToRackPath(layout, r, p, 1, 1).feet).toBeCloseTo(2 * rackToRack(layout, r, p), 6);
      }
    }
  });

  it("transferPath is Manhattan via a corridor row that stays off the racks", async () => {
    for (const { name, layout, world } of await layouts()) {
      const rng = seededRandom(17);
      const spots: Pt[] = [...world.lanes.flatMap((l) => l.slots), ...world.stations, world.entrance, world.breakArea, [layout.depot.x, layout.depot.y], ...layout.reserve.map((l) => [l.x, l.y] as Pt), ...layout.pick.map((l) => [l.x, l.y] as Pt)];
      for (let k = 0; k < 300; k++) {
        const a = spots[Math.floor(rng() * spots.length)];
        const b = spots[Math.floor(rng() * spots.length)];
        const p = transferPath(layout, world, a, b);
        axisAligned(p);
        expect(p.pts[0]).toEqual(a);
        expect(p.pts[p.pts.length - 1]).toEqual(b);
        expect(p.feet).toBeGreaterThanOrEqual(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) - 1e-9);
        offRacks(layout, p, true, `${name} transfer ${JSON.stringify(a)}→${JSON.stringify(b)}`);
      }
    }
  });
});
