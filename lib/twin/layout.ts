/**
 * Building geometry: rack locations, dock doors, and the travel distances
 * every labor time in the twin is built from.
 *
 * Coordinates are feet, x across the building and y from the dock wall
 * (y = 0) toward the back. Aisles run in y. The pick zone's depot, where tours
 * start and end, sits in the cross aisle in front of it.
 */

import type { PickZone, RackZone, Site } from "./types";

export interface Location {
  id: string;
  zone: "pick" | "reserve";
  aisle: number;
  side: "L" | "R";
  bay: number;
  level: number;
  slot: number;
  x: number;
  y: number;
}

export interface Door {
  id: string;
  kind: "inbound" | "outbound";
  x: number;
}

export interface Layout {
  site: Site;
  pick: Location[];
  reserve: Location[];
  doors: Door[];
  depot: { x: number; y: number };
  /** Length of one pick aisle, feet. */
  pickAisleLength: number;
}

/** Levels at waist-to-shoulder height, where a pick needs no bend or reach. */
export const GOLDEN_LEVELS = new Set([2, 3]);

function aislePitch(z: RackZone): number {
  return z.aisleWidthFt + 2 * z.rackDepthFt;
}

function aisleX(z: RackZone, aisle: number): number {
  return z.originX + z.rackDepthFt + aisle * aislePitch(z) + z.aisleWidthFt / 2;
}

function zoneLocations(z: RackZone | PickZone, zone: "pick" | "reserve", prefix: string): Location[] {
  const slots = "slotsPerBay" in z ? z.slotsPerBay : 1;
  const out: Location[] = [];
  for (let a = 0; a < z.aisles; a++) {
    const x = aisleX(z, a);
    for (const side of ["L", "R"] as const) {
      for (let b = 0; b < z.baysPerSide; b++) {
        for (let lv = 1; lv <= z.levels; lv++) {
          for (let s = 0; s < slots; s++) {
            // Slots within a bay spread across its width, so two slots in the
            // same bay are a few feet apart rather than on top of each other.
            const y = z.originY + (b + (s + 0.5) / slots) * z.bayWidthFt;
            out.push({
              id: `${prefix}${String(a + 1).padStart(2, "0")}-${side}${String(b + 1).padStart(2, "0")}-${lv}${slots > 1 ? String.fromCharCode(65 + s) : ""}`,
              zone,
              aisle: a,
              side,
              bay: b,
              level: lv,
              slot: s,
              x,
              y,
            });
          }
        }
      }
    }
  }
  return out;
}

export function zoneWidth(z: RackZone): number {
  return z.aisles * aislePitch(z);
}

export function buildLayout(site: Site): Layout {
  const doors: Door[] = [];
  const inboundSpan = site.building.widthFt * 0.4;
  for (let i = 0; i < site.doors.inbound; i++) {
    doors.push({ id: `IN-${i + 1}`, kind: "inbound", x: ((i + 0.5) / site.doors.inbound) * inboundSpan });
  }
  const outStart = site.building.widthFt * 0.45;
  const outSpan = site.building.widthFt - outStart;
  for (let i = 0; i < site.doors.outbound; i++) {
    doors.push({ id: `OUT-${i + 1}`, kind: "outbound", x: outStart + ((i + 0.5) / site.doors.outbound) * outSpan });
  }
  const p = site.pick;
  return {
    site,
    pick: zoneLocations(p, "pick", "P"),
    reserve: zoneLocations(site.reserve, "reserve", "R"),
    doors,
    depot: { x: p.originX + zoneWidth(p) / 2, y: p.originY - 6 },
    pickAisleLength: p.baysPerSide * p.bayWidthFt,
  };
}

/**
 * One-way walking distance from the depot to a pick location, used to rank
 * slots for slotting: the cross-aisle run to the aisle, then down it.
 */
export function depotDistance(layout: Layout, loc: Location): number {
  return Math.abs(loc.x - layout.depot.x) + (loc.y - layout.depot.y);
}

/**
 * S-shape (traversal) route length for a picking tour: enter every aisle that
 * holds a pick and walk it end to end, alternating direction; with an odd
 * number of aisles the last one is a return trip to its deepest pick. The
 * horizontal run covers the span of visited aisles plus getting there from
 * the depot and back. The standard warehouse routing heuristic, and what a
 * picker without a routing system does on their own.
 */
export function sShapeDistance(layout: Layout, locs: Location[]): number {
  if (locs.length === 0) return 0;
  const byAisle = new Map<number, { x: number; deepest: number }>();
  for (const l of locs) {
    const a = byAisle.get(l.aisle);
    const depth = l.y - layout.site.pick.originY;
    if (!a) byAisle.set(l.aisle, { x: l.x, deepest: depth });
    else a.deepest = Math.max(a.deepest, depth);
  }
  const aisles = [...byAisle.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const L = layout.pickAisleLength;
  const frontGap = layout.site.pick.originY - layout.depot.y;
  let vertical: number;
  if (aisles.length % 2 === 0) vertical = aisles.length * L;
  else vertical = (aisles.length - 1) * L + 2 * aisles[aisles.length - 1].deepest;
  const xmin = aisles[0].x;
  const xmax = aisles[aisles.length - 1].x;
  const horizontal = Math.abs(layout.depot.x - xmin) + (xmax - xmin) + Math.abs(xmax - layout.depot.x);
  return vertical + horizontal + 2 * frontGap;
}

/** Rectilinear forklift distance between a dock-wall point and a rack location, feet. */
export function dockToRack(doorX: number, loc: Location): number {
  return Math.abs(loc.x - doorX) + loc.y;
}

/** Forklift distance from a reserve location to a pick face, via the front cross aisle. */
export function rackToRack(a: Location, b: Location): number {
  if (a.zone === b.zone && a.aisle === b.aisle) return Math.abs(a.y - b.y);
  const crossY = Math.min(a.y, b.y, 60);
  return (a.y - crossY) + Math.abs(a.x - b.x) + (b.y - crossY);
}
