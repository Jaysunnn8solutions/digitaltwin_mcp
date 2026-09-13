/**
 * Building geometry: rack locations, aisles, dock doors, and the travel
 * distances every labor time in the twin is built from.
 *
 * Everything is built from a layout spec (lib/layout/spec.ts): the committed
 * buildings convert to one with siteToSpec, and imported drawings produce one.
 * Coordinates are feet, x across the building and y from the dock wall
 * (y = 0) toward the back; rack runs and aisles run in y.
 *
 * Aisles are found, not declared: two rack runs facing each other across a
 * gap of aisle width make an aisle between them; runs back to back make none;
 * a run with open floor on one side gets a single-sided aisle there. A mixed
 * run (common in small buildings) picks from level 1 and stores pallets above.
 */

import { LIMITS, LimitError } from "../layout/limits";
import type { DoorSpec, LayoutSpec, RackRun } from "../layout/spec";
import type { Site } from "./types";

export interface Location {
  id: string;
  zone: "pick" | "reserve";
  /** Aisle index within its zone, in x order. */
  aisle: number;
  side: "L" | "R";
  bay: number;
  level: number;
  slot: number;
  x: number;
  y: number;
  /** Cube of the slot, for sizing pick faces. */
  slotCubeFt: number;
}

export interface Door {
  id: string;
  kind: "inbound" | "outbound";
  x: number;
  y: number;
}

export interface Aisle {
  zone: "pick" | "reserve";
  x: number;
  y0: number;
  y1: number;
  /** Rack faces on each side, if any. */
  left: RackRun | null;
  right: RackRun | null;
}

export interface Layout {
  site: Site;
  spec: LayoutSpec;
  pick: Location[];
  reserve: Location[];
  doors: Door[];
  pickAisles: Aisle[];
  reserveAisles: Aisle[];
  depot: { x: number; y: number };
  /** Front and back cross aisles of the pick zone. */
  pickFrontY: number;
  pickBackY: number;
  /** Length walked through one pick aisle end to end. */
  pickAisleLength: number;
  /** Median pick-slot cube. */
  pickSlotCubeFt: number;
}

/** Levels at waist-to-shoulder height, where a pick needs no bend or reach. */
export const GOLDEN_LEVELS = new Set([2, 3]);

const MIN_AISLE_FT = 3;
const MAX_AISLE_FT = 20;
const BACK_TO_BACK_FT = 2;
const SLOT_HEIGHT_FT = 1.5;

// ---------------------------------------------------------------------------
// Committed sites as specs
// ---------------------------------------------------------------------------

/** Door positions along the dock wall: inbound on the left 40%, outbound from 45%. */
export function dockDoors(widthFt: number, inbound: number, outbound: number): DoorSpec[] {
  const doors: DoorSpec[] = [];
  const inboundSpan = widthFt * 0.4;
  for (let i = 0; i < inbound; i++) doors.push({ id: `IN-${i + 1}`, kind: "inbound", x: ((i + 0.5) / inbound) * inboundSpan, y: 0, widthFt: 9 });
  const outStart = widthFt * 0.45;
  const outSpan = widthFt - outStart;
  for (let i = 0; i < outbound; i++) doors.push({ id: `OUT-${i + 1}`, kind: "outbound", x: outStart + ((i + 0.5) / outbound) * outSpan, y: 0, widthFt: 9 });
  return doors;
}

export function siteToSpec(site: Site): LayoutSpec {
  const racks: RackRun[] = [];
  const zone = (z: Site["reserve"] | Site["pick"], use: "pick" | "reserve", prefix: string) => {
    const pitch = z.aisleWidthFt + 2 * z.rackDepthFt;
    const slots = "slotsPerBay" in z ? z.slotsPerBay : 1;
    const y1 = z.originY + z.baysPerSide * z.bayWidthFt;
    for (let a = 0; a < z.aisles; a++) {
      const left = z.originX + a * pitch + z.rackDepthFt / 2;
      const right = z.originX + a * pitch + z.rackDepthFt + z.aisleWidthFt + z.rackDepthFt / 2;
      for (const [x, side] of [[left, "L"], [right, "R"]] as const) {
        racks.push({ id: `${prefix}${a + 1}${side}`, use, x, y0: z.originY, y1, depthFt: z.rackDepthFt, bays: z.baysPerSide, levels: z.levels, slotsPerBay: slots });
      }
    }
  };
  zone(site.reserve, "reserve", "R");
  zone(site.pick, "pick", "P");
  const W = site.building.widthFt;
  const D = site.building.depthFt;
  return {
    version: 1,
    name: site.id,
    source: { format: "builtin", notes: [] },
    widthFt: W,
    depthFt: D,
    outline: [[0, 0], [W, 0], [W, D], [0, D]],
    walls: [],
    zones: [{ kind: "staging", name: "Dock staging", ring: [[0, 0], [W, 0], [W, 40], [0, 40]] }],
    racks,
    doors: dockDoors(W, site.doors.inbound, site.doors.outbound),
    aisleWidthFt: site.pick.aisleWidthFt,
  };
}

/**
 * Change a spec's door counts. Doors are added along the dock wall past the
 * last door of that kind, or removed from the end, so an imported drawing
 * keeps its real door positions for the doors it has.
 */
export function withDoorCounts(spec: LayoutSpec, inbound: number, outbound: number): LayoutSpec {
  if (spec.source.format === "builtin") return { ...spec, doors: dockDoors(spec.widthFt, inbound, outbound) };
  const doors: DoorSpec[] = [];
  for (const kind of ["inbound", "outbound"] as const) {
    const have = spec.doors.filter((d) => d.kind === kind);
    const want = kind === "inbound" ? inbound : outbound;
    const kept = have.slice(0, want);
    const last = kept[kept.length - 1] ?? { x: kind === "inbound" ? spec.widthFt * 0.1 : spec.widthFt * 0.6, y: 0, widthFt: 9 };
    for (let i = kept.length; i < want; i++) {
      const x = Math.min(spec.widthFt - 6, last.x + 14 * (i - kept.length + 1));
      kept.push({ id: `${kind === "inbound" ? "IN" : "OUT"}-X${i + 1}`, kind, x, y: last.y, widthFt: 9 });
    }
    doors.push(...kept);
  }
  return { ...spec, doors };
}

// ---------------------------------------------------------------------------
// Aisles and locations
// ---------------------------------------------------------------------------

function overlap(a: RackRun, b: RackRun): number {
  const o = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return o / Math.max(1e-9, Math.min(a.y1 - a.y0, b.y1 - b.y0));
}

function findAisles(spec: LayoutSpec): Array<{ x: number; y0: number; y1: number; left: RackRun | null; right: RackRun | null }> {
  const runs = [...spec.racks].sort((a, b) => a.x - b.x || a.y0 - b.y0);
  const leftUsed = new Set<string>();
  const rightUsed = new Set<string>();
  const pairs: Array<{ gap: number; a: RackRun; b: RackRun }> = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i];
      const b = runs[j];
      const gap = b.x - b.depthFt / 2 - (a.x + a.depthFt / 2);
      if (gap > MAX_AISLE_FT) break;
      if (gap < -0.5 || overlap(a, b) < 0.3) continue;
      pairs.push({ gap, a, b });
    }
  }
  pairs.sort((p, q) => p.gap - q.gap);
  const aisles: Array<{ x: number; y0: number; y1: number; left: RackRun | null; right: RackRun | null }> = [];
  for (const { gap, a, b } of pairs) {
    if (rightUsed.has(a.id) || leftUsed.has(b.id)) continue;
    rightUsed.add(a.id);
    leftUsed.add(b.id);
    // Back to back: the faces touch, so neither is reachable from this side.
    if (gap < BACK_TO_BACK_FT) continue;
    if (gap < MIN_AISLE_FT) continue;
    aisles.push({ x: (a.x + a.depthFt / 2 + b.x - b.depthFt / 2) / 2, y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), left: a, right: b });
  }
  // Runs with no aisle on either face: open a single-sided aisle toward the
  // building's middle, where there is floor.
  for (const r of runs) {
    const hasLeft = aisles.some((a) => a.right === r);
    const hasRight = aisles.some((a) => a.left === r);
    if (hasLeft || hasRight) continue;
    const leftBlocked = leftUsed.has(r.id);
    const rightBlocked = rightUsed.has(r.id);
    const towardRight = r.x < spec.widthFt / 2;
    const side = rightBlocked ? "left" : leftBlocked ? "right" : towardRight ? "right" : "left";
    const w = spec.aisleWidthFt;
    if (side === "right") aisles.push({ x: r.x + r.depthFt / 2 + w / 2, y0: r.y0, y1: r.y1, left: r, right: null });
    else aisles.push({ x: r.x - r.depthFt / 2 - w / 2, y0: r.y0, y1: r.y1, left: null, right: r });
  }
  return aisles.sort((a, b) => a.x - b.x || a.y0 - b.y0);
}

function levelZone(run: RackRun, level: number): "pick" | "reserve" {
  if (run.use === "mixed") return level === 1 ? "pick" : "reserve";
  return run.use;
}

export function buildLayout(spec: LayoutSpec, site: Site): Layout {
  const found = findAisles(spec);
  const pickAisles: Aisle[] = [];
  const reserveAisles: Aisle[] = [];
  const pick: Location[] = [];
  const reserve: Location[] = [];
  const hasZone = (a: (typeof found)[number], z: "pick" | "reserve") =>
    [a.left, a.right].some((r) => r && Array.from({ length: r.levels }, (_, i) => levelZone(r, i + 1)).includes(z));

  for (const zone of ["pick", "reserve"] as const) {
    const list = zone === "pick" ? pickAisles : reserveAisles;
    const out = zone === "pick" ? pick : reserve;
    const prefix = zone === "pick" ? "P" : "R";
    for (const a of found.filter((f) => hasZone(f, zone))) {
      const idx = list.length;
      list.push({ zone, ...a });
      for (const [run, side] of [[a.left, "L"], [a.right, "R"]] as const) {
        if (!run) continue;
        const bayLen = (run.y1 - run.y0) / run.bays;
        for (let b = 0; b < run.bays; b++) {
          for (let lv = 1; lv <= run.levels; lv++) {
            if (levelZone(run, lv) !== zone) continue;
            const slots = zone === "pick" ? run.slotsPerBay : 1;
            for (let s = 0; s < slots; s++) {
              out.push({
                id: `${prefix}${String(idx + 1).padStart(2, "0")}-${side}${String(b + 1).padStart(2, "0")}-${lv}${slots > 1 ? String.fromCharCode(65 + s) : ""}`,
                zone,
                aisle: idx,
                side,
                bay: b,
                level: lv,
                slot: s,
                x: a.x,
                y: run.y0 + (b + (s + 0.5) / slots) * bayLen,
                slotCubeFt: (bayLen / slots) * run.depthFt * SLOT_HEIGHT_FT,
              });
            }
          }
        }
      }
    }
  }

  if (pick.length === 0) throw new LimitError("The layout has no pick faces. Mark some racks as pick (or mixed, which picks from level 1) in the import mapping.");
  if (reserve.length === 0) throw new LimitError("The layout has no reserve pallet positions. Mark some racks as reserve (or mixed) in the import mapping.");
  if (pick.length > LIMITS.maxPickFaces) throw new LimitError(`The layout has ${pick.length.toLocaleString("en-US")} pick faces; the limit is ${LIMITS.maxPickFaces.toLocaleString("en-US")}.`);
  if (reserve.length > LIMITS.maxReservePositions) throw new LimitError(`The layout has ${reserve.length.toLocaleString("en-US")} reserve positions; the limit is ${LIMITS.maxReservePositions.toLocaleString("en-US")}.`);
  if (!spec.doors.some((d) => d.kind === "inbound") || !spec.doors.some((d) => d.kind === "outbound")) {
    throw new LimitError("The layout needs at least one inbound and one outbound dock door.");
  }

  const pickFrontY = Math.min(...pickAisles.map((a) => a.y0));
  const pickBackY = Math.max(...pickAisles.map((a) => a.y1));
  const xs = pickAisles.map((a) => a.x);
  const cubes = pick.map((l) => l.slotCubeFt).sort((a, b) => a - b);
  return {
    site,
    spec,
    pick,
    reserve,
    doors: spec.doors.map((d) => ({ id: d.id, kind: d.kind, x: d.x, y: d.y })),
    pickAisles,
    reserveAisles,
    depot: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.max(0, pickFrontY - 6) },
    pickFrontY,
    pickBackY,
    pickAisleLength: pickBackY - pickFrontY,
    pickSlotCubeFt: cubes[Math.floor(cubes.length / 2)],
  };
}

// ---------------------------------------------------------------------------
// Travel
// ---------------------------------------------------------------------------

/**
 * One-way walking distance from the depot to a pick location, used to rank
 * slots for slotting: the cross-aisle run to the aisle, then down it.
 */
export function depotDistance(layout: Layout, loc: Location): number {
  return Math.abs(loc.x - layout.depot.x) + Math.abs(loc.y - layout.depot.y);
}

/**
 * S-shape (traversal) route length for a picking tour: enter every aisle that
 * holds a pick and walk it end to end between the front and back cross
 * aisles, alternating direction; with an odd number of aisles the last one is
 * a return trip to its deepest pick. The horizontal run covers the span of
 * visited aisles plus getting there from the depot and back. The standard
 * warehouse routing heuristic, and what a picker without a routing system
 * does on their own.
 */
export function sShapeDistance(layout: Layout, locs: Location[]): number {
  if (locs.length === 0) return 0;
  const byAisle = new Map<number, { x: number; deepest: number }>();
  for (const l of locs) {
    const a = byAisle.get(l.aisle);
    const depth = l.y - layout.pickFrontY;
    if (!a) byAisle.set(l.aisle, { x: l.x, deepest: depth });
    else a.deepest = Math.max(a.deepest, depth);
  }
  const aisles = [...byAisle.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const L = layout.pickAisleLength;
  const frontGap = Math.abs(layout.pickFrontY - layout.depot.y);
  let vertical: number;
  if (aisles.length % 2 === 0) vertical = aisles.length * L;
  else vertical = (aisles.length - 1) * L + 2 * aisles[aisles.length - 1].deepest;
  const xmin = aisles[0].x;
  const xmax = aisles[aisles.length - 1].x;
  const horizontal = Math.abs(layout.depot.x - xmin) + (xmax - xmin) + Math.abs(xmax - layout.depot.x);
  return vertical + horizontal + 2 * frontGap;
}

/** Rectilinear forklift distance between a dock door and a rack location, feet. */
export function dockToRack(door: { x: number; y: number }, loc: Location): number {
  return Math.abs(loc.x - door.x) + Math.abs(loc.y - door.y);
}

/** Forklift distance between two rack locations, via the front cross aisle unless they share an aisle. */
export function rackToRack(layout: Layout, a: Location, b: Location): number {
  if (a.zone === b.zone && a.aisle === b.aisle) return Math.abs(a.y - b.y);
  const crossY = Math.min(a.y, b.y, layout.pickFrontY);
  return a.y - crossY + Math.abs(a.x - b.x) + (b.y - crossY);
}
