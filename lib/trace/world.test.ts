/**
 * The synthesized world: one frame and lane per door, a sensible number of
 * pack stations, corridor rows inside the building and level heights per run.
 */
import "../data/load";
import { describe, expect, it } from "vitest";
import { importLayout } from "../layout/import";
import { sampleCsv } from "../layout/samples";
import { buildLayout, siteToSpec, type Layout } from "../twin/layout";
import { buildTwin } from "../twin/twin";
import { TRUCK_LENGTH } from "../three/geometry";
import { LANE_SLOTS, type WorkerInfo } from "./types";
import { PICK_LEVEL_FT, QUEUE_FIRST_FT, QUEUE_PITCH_FT, RESERVE_LEVEL_FT, ROAD_Y, YARD_TRUCK_LENGTH_FT, buildWorld, parkSpot } from "./world";
import { workerInfos } from "./fixtures";

async function layouts(): Promise<Array<{ name: string; layout: Layout; workers: WorkerInfo[] }>> {
  const west = await buildTwin("dc-west", 36, {});
  const east = await buildTwin("dc-east", 36, {});
  const csv = await importLayout({ fileName: "locations.csv", text: sampleCsv() }, {}, "inline");
  const imported = await buildTwin("dc-east", 36, { layout: csv.spec });
  return [
    { name: "dc-west", layout: west.layout, workers: workerInfos(west.workers) },
    { name: "dc-east", layout: east.layout, workers: workerInfos(east.workers) },
    { name: "csv", layout: imported.layout, workers: workerInfos(imported.workers) },
  ];
}

describe("buildWorld", () => {
  it("has one frame and one lane per door, in layout.doors order", async () => {
    for (const { layout, workers } of await layouts()) {
      const w = buildWorld(layout, workers);
      expect(w.frames.length).toBe(layout.doors.length);
      expect(w.lanes.length).toBe(layout.doors.length);
      w.frames.forEach((f, i) => {
        expect(f.door).toBe(layout.doors[i].id);
        expect(f.index).toBe(i);
        expect(f.kind).toBe(layout.doors[i].kind);
        expect(Math.hypot(f.inward[0], f.inward[1])).toBeCloseTo(1, 9);
        expect(f.inward[0] * f.tangent[0] + f.inward[1] * f.tangent[1]).toBeCloseTo(0, 9);
        // Dock-wall doors face into the building.
        if (layout.doors[i].y < 1) expect(f.inward[1]).toBeGreaterThan(0.99);
        expect(w.lanes[i].slots.length).toBe(LANE_SLOTS);
        for (const s of w.lanes[i].slots) {
          expect(s[0]).toBeGreaterThanOrEqual(-1);
          expect(s[0]).toBeLessThanOrEqual(w.bbox.w + 1);
          expect(s[1]).toBeGreaterThan(0);
        }
      });
      expect(Object.keys(w.yard.queue).length).toBe(w.frames.filter((f) => f.kind === "inbound").length);
    }
  });

  it("places K = clamp(packers, 2, 6) stations in front of the depot", async () => {
    for (const { layout, workers } of await layouts()) {
      const w = buildWorld(layout, workers);
      const packers = workers.filter((x) => x.skills.includes("pack")).length;
      expect(w.stations.length).toBe(Math.max(2, Math.min(6, packers)));
      for (const s of w.stations) {
        expect(s[1]).toBeLessThan(layout.depot.y);
        expect(s[1]).toBeGreaterThanOrEqual(8);
      }
      const many = buildWorld(layout, Array.from({ length: 12 }, (_, i) => ({ id: `P${i}`, role: "Receiver", type: "full-time" as const, skills: ["pack" as const], productivity: 1, hourlyRate: 19, overtimeMultiplier: 1.5 })));
      expect(many.stations.length).toBe(6);
      const none = buildWorld(layout, []);
      expect(none.stations.length).toBe(2);
    }
  });

  it("keeps corridors, entrance, break area and parks inside the building", async () => {
    for (const { layout, workers } of await layouts()) {
      const w = buildWorld(layout, workers);
      const { front, back, reserveFront, apron } = w.corridors;
      for (const y of [front, back, reserveFront, apron]) {
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(w.bbox.d);
      }
      expect(front).toBeLessThan(layout.pickFrontY);
      expect(back).toBeGreaterThan(layout.pickBackY);
      expect(apron).toBeLessThan(reserveFront);
      for (const p of [w.entrance, w.breakArea, ...w.parks.forklifts, ...w.parks.jacks, ...Object.values(w.homes)]) {
        expect(p[0]).toBeGreaterThanOrEqual(0);
        expect(p[0]).toBeLessThanOrEqual(w.bbox.w);
        expect(p[1]).toBeGreaterThanOrEqual(0);
        expect(p[1]).toBeLessThanOrEqual(w.bbox.d);
      }
      expect(w.parks.forklifts.length).toBe(Math.max(1, layout.site.equipment.forklifts));
      expect(w.parks.jacks.length).toBe(Math.max(1, layout.site.equipment.palletJacks));
      expect(parkSpot(w, "forklift", 7)[0]).toBeGreaterThan(w.parks.forklifts[0][0]);
      expect(w.yard.roadY).toBeLessThan(0);
      expect(w.yard.spawnLeft[0]).toBeLessThan(0);
      expect(w.yard.spawnRight[0]).toBeGreaterThan(w.bbox.w);
    }
  });

  it("gives every rack run its level heights at the pick or reserve pitch", async () => {
    for (const { layout, workers } of await layouts()) {
      const w = buildWorld(layout, workers);
      for (const r of layout.spec.racks) {
        const hs = w.levelHeights[r.id];
        expect(hs.length).toBe(r.levels);
        expect(hs[0]).toBe(0);
        const pitch = r.use === "pick" ? PICK_LEVEL_FT : RESERVE_LEVEL_FT;
        for (let l = 1; l < hs.length; l++) expect(hs[l] - hs[l - 1]).toBeCloseTo(l === 1 && r.use === "mixed" ? PICK_LEVEL_FT : pitch, 9);
      }
    }
  });

  it("keeps the queue spots clear of the docked trailer, the road and each other", async () => {
    // The yard's copy of the truck length is the renderer's.
    expect(YARD_TRUCK_LENGTH_FT).toBe(TRUCK_LENGTH);
    const clearance = 5;
    // Spot 0's rear is beyond a docked trailer (0..TRUCK_LENGTH out) and beyond the road the undocking trucks drive along.
    expect(QUEUE_FIRST_FT).toBeGreaterThanOrEqual(TRUCK_LENGTH + clearance);
    expect(QUEUE_FIRST_FT).toBeGreaterThan(-ROAD_Y);
    // Consecutive spots are a truck length plus clearance apart.
    expect(QUEUE_PITCH_FT).toBeGreaterThanOrEqual(TRUCK_LENGTH + clearance);
    for (const { layout, workers } of await layouts()) {
      const w = buildWorld(layout, workers);
      for (const f of w.frames) {
        const spots = w.yard.queue[f.index];
        if (!spots) continue;
        spots.forEach((s, k) => {
          const out = -((s[0] - f.origin[0]) * f.inward[0] + (s[1] - f.origin[1]) * f.inward[1]);
          expect(out).toBeCloseTo(QUEUE_FIRST_FT + QUEUE_PITCH_FT * k, 6);
        });
      }
    }
  });

  it("orients an imported side-wall door along the wall's inward normal", async () => {
    const site = (await buildTwin("dc-west", 36, {})).site;
    const spec = siteToSpec(site);
    const side = { ...spec, source: { format: "csv" as const, notes: [] }, doors: [...spec.doors, { id: "SIDE", kind: "outbound" as const, x: 0, y: 100, widthFt: 9 }] };
    const layout = buildLayout(side, site);
    const w = buildWorld(layout, []);
    const f = w.frames[w.frames.length - 1];
    expect(f.inward[0]).toBeCloseTo(1, 9);
    expect(Math.abs(f.inward[1])).toBeLessThan(1e-9);
    expect(w.frames[0].inward[1]).toBeCloseTo(1, 9);
  });
});
