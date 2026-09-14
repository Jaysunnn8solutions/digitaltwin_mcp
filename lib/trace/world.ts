/**
 * The synthesized world: everything the engine has no geometry for but the
 * scene needs. Door frames, dock and staging lanes, pack stations, entrance,
 * break area, equipment parks, the yard, the corridor rows the polylines are
 * drawn on, per-run level heights and the idle homes per skill. Built once per
 * layout, pure data (design C).
 */

import type { Point } from "../layout/spec";
import type { Layout } from "../twin/layout";
import type { Skill } from "../twin/types";
import { LANE_SLOTS, type DoorFrame, type Lane, type Pt, type WorkerInfo, type World } from "./types";

/** Visual level pitches: pick shelving 1.5 ft, pallet rack 5 ft. */
export const PICK_LEVEL_FT = 1.5;
export const RESERVE_LEVEL_FT = 5;
/** Yard geometry (feet outside the dock wall). */
export const ROAD_Y = -60;
/**
 * The truck model is 63 ft from its tracked rear along the nose (lib/three/
 * geometry.ts TRUCK_LENGTH; duplicated here so the yard needs no three.js).
 * Queue spot 0 is placed beyond a docked trailer (0..63 ft out) and beyond the
 * road, and the pitch is a truck length plus clearance, so a waiting truck
 * never overlaps the one at the door, the next one in line or the road the
 * undocking trucks drive along. world.test.ts pins the relation.
 */
export const YARD_TRUCK_LENGTH_FT = 63;
export const QUEUE_FIRST_FT = 75;
export const QUEUE_PITCH_FT = 70;
export const QUEUE_SPOTS = 3;
export const SPAWN_MARGIN_FT = 80;
/** Floor on how far outside a door the road point is (roadPoint): room to swing before backing in. */
export const TRAILER_CENTER_FT = 25;

function add(a: Pt, b: Pt, k = 1): Pt {
  return [a[0] + b[0] * k, a[1] + b[1] * k];
}

function centroid(ring: Point[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return ring.length ? [x / ring.length, y / ring.length] : [0, 0];
}

function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * The inward normal of the outline edge nearest a door: built-in doors face
 * (0, 1); an imported door sits on whichever wall the drawing put it, so the
 * trailer backs in along that wall's normal.
 */
function doorFrame(outline: Point[], ccw: boolean, door: { id: string; kind: "inbound" | "outbound"; x: number; y: number; widthFt: number }, index: number): DoorFrame {
  let best = Infinity;
  let inward: Pt = [0, 1];
  let tangent: Pt = [1, 0];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    const u = Math.max(0, Math.min(1, ((door.x - p[0]) * dx + (door.y - p[1]) * dy) / len2));
    const cx = p[0] + u * dx - door.x;
    const cy = p[1] + u * dy - door.y;
    const d2 = cx * cx + cy * cy;
    if (d2 < best) {
      best = d2;
      const len = Math.sqrt(len2);
      const tx = dx / len + 0;
      const ty = dy / len + 0;
      tangent = [tx, ty];
      inward = ccw ? [-ty + 0, tx + 0] : [ty + 0, -tx + 0];
    }
  }
  return { door: door.id, kind: door.kind, index, origin: [door.x, door.y], inward, tangent, widthFt: door.widthFt };
}

export function buildWorld(layout: Layout, workers: WorkerInfo[]): World {
  const spec = layout.spec;
  const w = spec.widthFt;
  const d = spec.depthFt;
  const rect: Point[] = [[0, 0], [w, 0], [w, d], [0, d]];
  const outline = spec.outline.length >= 3 ? spec.outline : rect;
  const ccw = signedArea(outline) >= 0;
  const builtin = spec.source.format === "builtin";

  const frames: DoorFrame[] = spec.doors.map((door, i) =>
    builtin ? { door: door.id, kind: door.kind, index: i, origin: [door.x, door.y] as Pt, inward: [0, 1] as Pt, tangent: [1, 0] as Pt, widthFt: door.widthFt } : doorFrame(outline, ccw, door, i)
  );

  // Lanes: two columns of four spots, 8 ft inside the door at a 5 ft pitch.
  const lanes: Lane[] = frames.map((f) => {
    const slots: Pt[] = [];
    for (let k = 0; k < LANE_SLOTS; k++) {
      const col = k % 2;
      const row = Math.floor(k / 2);
      slots.push(add(add(f.origin, f.inward, 8 + 5 * row), f.tangent, col ? 3 : -3));
    }
    return { door: f.door, kind: f.kind, slots };
  });

  // Pack stations in front of the depot, one per packer within reason.
  const packers = workers.filter((x) => x.skills.includes("pack")).length;
  const K = Math.max(2, Math.min(6, packers));
  const stationY = Math.max(8, layout.depot.y - 14);
  const stations: Pt[] = Array.from({ length: K }, (_, i) => [layout.depot.x + (i - (K - 1) / 2) * 10, stationY]);

  const office = spec.zones.find((z) => z.kind === "office");
  const entranceRaw: Pt = office && office.ring.length ? centroid(office.ring) : [w - 10, 6];
  const entrance: Pt = [Math.max(1, Math.min(w - 1, entranceRaw[0])), Math.max(1, Math.min(d - 1, entranceRaw[1]))];
  const breakArea: Pt = [entrance[0], Math.min(d - 1, entrance[1] + 12)];

  const inFrames = frames.filter((f) => f.kind === "inbound");
  const outFrames = frames.filter((f) => f.kind === "outbound");
  const leftIn = inFrames.reduce((a, f) => (f.origin[0] < a.origin[0] ? f : a), inFrames[0] ?? frames[0]);
  const forkliftCount = Math.max(1, layout.site.equipment?.forklifts ?? 1);
  const jackCount = Math.max(1, layout.site.equipment?.palletJacks ?? 1);
  const apronY = 12;
  const forklifts: Pt[] = Array.from({ length: forkliftCount }, (_, i) => [Math.min(w - 4, (leftIn?.origin[0] ?? 10) + 14 + 8 * i), apronY]);
  const inMax = inFrames.length ? Math.max(...inFrames.map((f) => f.origin[0])) : 0;
  const outMin = outFrames.length ? Math.min(...outFrames.map((f) => f.origin[0])) : w;
  const jackMid = (inMax + outMin) / 2;
  const jacks: Pt[] = Array.from({ length: jackCount }, (_, i) => [Math.max(4, Math.min(w - 4, jackMid + (i - (jackCount - 1) / 2) * 6)), apronY]);

  const queue: Record<number, Pt[]> = {};
  for (const f of inFrames) queue[f.index] = Array.from({ length: QUEUE_SPOTS }, (_, k) => add(f.origin, f.inward, -(QUEUE_FIRST_FT + QUEUE_PITCH_FT * k)));

  const reserveY0 = layout.reserveAisles.length ? Math.min(...layout.reserveAisles.map((a) => a.y0)) : layout.pickFrontY;
  const front = Math.max(layout.pickFrontY - 3, layout.pickFrontY / 2);
  const back = layout.pickBackY + 3;
  const reserveFront = Math.max(2, reserveY0 - 4);
  const apron = Math.min(12, reserveFront - 2);

  const levelHeights: Record<string, number[]> = {};
  for (const r of spec.racks) {
    const hs: number[] = [];
    for (let l = 1; l <= r.levels; l++) {
      if (r.use === "pick") hs.push(PICK_LEVEL_FT * (l - 1));
      else if (r.use === "reserve") hs.push(RESERVE_LEVEL_FT * (l - 1));
      else hs.push(l === 1 ? 0 : PICK_LEVEL_FT + RESERVE_LEVEL_FT * (l - 2));
    }
    levelHeights[r.id] = hs;
  }

  const mouth = (f: DoorFrame | undefined): Pt => (f ? add(f.origin, f.inward, 5) : [w / 2, 5]);
  const homes: Record<Skill, Pt> = {
    receive: mouth(inFrames[0]),
    forklift: forklifts[0],
    pick: [layout.depot.x, layout.depot.y],
    pack: stations[Math.floor(K / 2)],
    load: mouth(outFrames[0]),
  };

  return {
    bbox: { w, d },
    frames,
    lanes,
    stations,
    entrance,
    breakArea,
    parks: { forklifts, jacks },
    yard: { roadY: ROAD_Y, queue, spawnLeft: [-SPAWN_MARGIN_FT, ROAD_Y], spawnRight: [w + SPAWN_MARGIN_FT, ROAD_Y] },
    corridors: { front, back, reserveFront, apron },
    levelHeights,
    homes,
  };
}

/** Park spot for vehicle index i; overflow units (beyond the site's count) line up past the last park. */
export function parkSpot(world: World, kind: "forklift" | "jack", i: number): Pt {
  const parks = kind === "forklift" ? world.parks.forklifts : world.parks.jacks;
  if (i < parks.length) return parks[i];
  const last = parks[parks.length - 1];
  return [Math.min(world.bbox.w - 2, last[0] + (kind === "forklift" ? 8 : 6) * (i - parks.length + 1)), last[1]];
}

/**
 * A docked truck's track pose: the trailer's rear at the door origin (the dock
 * face) and the heading the nose points, away from the door. The renderer
 * draws the truck from the tracked rear along the heading (geometry.ts
 * TRUCK_LENGTH), and collide.ts boxes a docked trailer the same way.
 */
export function trailerPose(frame: DoorFrame): { pt: Pt; heading: number } {
  return { pt: [frame.origin[0], frame.origin[1]], heading: Math.atan2(-frame.inward[1], -frame.inward[0]) };
}

/** The point on the door threshold where a pallet is handed between trailer and floor. */
export function thresholdPoint(frame: DoorFrame): Pt {
  return add(frame.origin, frame.inward, 0.5);
}

/** The road point straight out from a door. */
export function roadPoint(world: World, frame: DoorFrame): Pt {
  const k = frame.inward[1] !== 0 ? (world.yard.roadY - frame.origin[1]) / frame.inward[1] : -(TRAILER_CENTER_FT + 35);
  return add(frame.origin, frame.inward, Math.min(k, -(TRAILER_CENTER_FT + 10)));
}
