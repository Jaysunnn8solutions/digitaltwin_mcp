/**
 * Route polylines that reproduce the engine's distances exactly (design C):
 * the S-shape tour, the re-pick round trip, the putaway staircase, the
 * replenishment via the front cross aisle, plus two the engine has no number
 * for: the transfer walk between jobs and the yard drive. All axis-aligned.
 *
 * A path carries its stops (where the actor pauses to handle) as vertex
 * indices, so `visualOffset` can move cross-aisle legs off the rack ends onto
 * the corridor rows and recompute the stop offsets without losing them.
 */

import type { Layout, Location } from "../twin/layout";
import type { LaborStandards } from "../twin/types";
import { GOLDEN_LEVELS, dockToRack } from "../twin/layout";
import type { DoorFrame, Pt, World } from "./types";
import { roadPoint, trailerPose } from "./world";

export interface PathStop {
  /** Feet along the polyline where the stop is. */
  at: number;
  /** Vertex index of the stop. */
  i: number;
  loc?: string;
  /** Handling minutes at productivity 1 (weights the job's stop time across its stops). */
  minutes: number;
  /** Rack level for the fork height, when the stop is at a rack. */
  level?: number;
}

export interface Path {
  pts: Pt[];
  feet: number;
  stops: PathStop[];
}

const EPS = 1e-9;

export function pathFeet(pts: readonly Pt[]): number {
  let f = 0;
  for (let i = 1; i < pts.length; i++) f += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
  return f;
}

/** Recompute stop offsets from the vertices (after an offset or a splice). */
export function refreshStops(path: Path): Path {
  const cum: number[] = [0];
  for (let i = 1; i < path.pts.length; i++) cum.push(cum[i - 1] + Math.abs(path.pts[i][0] - path.pts[i - 1][0]) + Math.abs(path.pts[i][1] - path.pts[i - 1][1]));
  path.feet = cum[cum.length - 1] ?? 0;
  for (const s of path.stops) s.at = cum[s.i] ?? 0;
  return path;
}

class PathBuilder {
  readonly pts: Pt[] = [];
  readonly stops: PathStop[] = [];
  to(x: number, y: number): this {
    const last = this.pts[this.pts.length - 1];
    if (last && Math.abs(last[0] - x) < EPS && Math.abs(last[1] - y) < EPS) return this;
    this.pts.push([x, y]);
    return this;
  }
  stop(minutes: number, loc?: string, level?: number): this {
    this.stops.push({ at: 0, i: this.pts.length - 1, loc, minutes, level });
    return this;
  }
  build(): Path {
    return refreshStops({ pts: this.pts, feet: 0, stops: this.stops });
  }
}

export function lineHandling(std: LaborStandards, loc: Location, inners: number): number {
  return std.pickPerLine + std.pickPerInner * inners + (GOLDEN_LEVELS.has(loc.level) ? 0 : std.pickBendReachSec / 60);
}

/**
 * S-shape tour: depot → front cross aisle → every visited aisle end to end,
 * alternating direction via the back cross aisle; an odd last aisle is a
 * return trip to its deepest pick; back along the front cross aisle. Stops in
 * traversal order. Length equals sShapeDistance by construction.
 */
export function sShapePath(layout: Layout, lines: Array<{ loc: Location; inners: number }>, std: LaborStandards): Path {
  const b = new PathBuilder();
  const depot = layout.depot;
  b.to(depot.x, depot.y);
  if (lines.length === 0) return b.build();
  b.stop(std.pickPerTour);
  const byAisle = new Map<number, Array<{ loc: Location; inners: number }>>();
  for (const l of lines) {
    const list = byAisle.get(l.loc.aisle) ?? [];
    list.push(l);
    byAisle.set(l.loc.aisle, list);
  }
  const aisles = [...byAisle.entries()].sort((p, q) => p[0] - q[0]).map(([, v]) => v);
  const front = layout.pickFrontY;
  const back = layout.pickBackY;
  const n = aisles.length;
  b.to(depot.x, front);
  for (let k = 0; k < n; k++) {
    const list = aisles[k];
    const x = list[0].loc.x;
    const odd = n % 2 === 1 && k === n - 1;
    const up = k % 2 === 0;
    if (up || odd) {
      b.to(x, front);
      const sorted = [...list].sort((p, q) => p.loc.y - q.loc.y);
      for (const l of sorted) b.to(x, l.loc.y).stop(lineHandling(std, l.loc, l.inners), l.loc.id, l.loc.level);
      if (odd) b.to(x, front);
      else b.to(x, back);
    } else {
      b.to(x, back);
      const sorted = [...list].sort((p, q) => q.loc.y - p.loc.y);
      for (const l of sorted) b.to(x, l.loc.y).stop(lineHandling(std, l.loc, l.inners), l.loc.id, l.loc.level);
      b.to(x, front);
    }
  }
  b.to(depot.x, front);
  b.to(depot.x, depot.y);
  return b.build();
}

/** Re-pick: depot → the face → depot; length 2·depotDistance. */
export function depotPath(layout: Layout, loc: Location, std: LaborStandards, inners: number): Path {
  const b = new PathBuilder();
  const depot = layout.depot;
  b.to(depot.x, depot.y).to(loc.x, depot.y).to(loc.x, loc.y).stop(lineHandling(std, loc, inners), loc.id, loc.level).to(loc.x, depot.y).to(depot.x, depot.y);
  return b.build();
}

function clampRow(row: number, a: number, b: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), row));
}

/**
 * Putaway: a monotone staircase from the dock via the reserve front corridor
 * to the pallet's position(s) and back. A mixed pallet visits its locations
 * in increasing dock distance; only the farthest counts for the engine, so the
 * polyline is longer than 2·farFt and the fit absorbs the difference.
 */
export function dockToRackPath(layout: Layout, world: World, door: Pt, locs: Array<{ loc: Location; minutes: number }>, level = true): Path {
  const b = new PathBuilder();
  b.to(door[0], door[1]);
  if (locs.length === 0) return b.build();
  const sorted = [...locs].sort((p, q) => dockToRack({ x: door[0], y: door[1] }, p.loc) - dockToRack({ x: door[0], y: door[1] }, q.loc));
  const corridor = world.corridors.reserveFront;
  const first = sorted[0].loc;
  const cY = clampRow(corridor, door[1], first.y);
  b.to(door[0], cY).to(first.x, cY).to(first.x, first.y).stop(sorted[0].minutes, first.id, level ? first.level : undefined);
  for (let k = 1; k < sorted.length; k++) {
    const a = sorted[k - 1].loc;
    const c = sorted[k].loc;
    if (Math.abs(a.x - c.x) > EPS) {
      // The reserve front corridor lies below every reserve position; a
      // position that sits below it (an import) crosses at its own row.
      const y = Math.min(a.y, c.y, corridor);
      b.to(a.x, y).to(c.x, y);
    }
    b.to(c.x, c.y).stop(sorted[k].minutes, c.id, level ? c.level : undefined);
  }
  const last = sorted[sorted.length - 1].loc;
  const rY = clampRow(corridor, door[1], last.y);
  b.to(last.x, rY).to(door[0], rY).to(door[0], door[1]);
  return b.build();
}

/** Replenishment: reserve position → pick face → back, via crossY = min(a.y, b.y, pickFrontY) unless they share an aisle; length 2·rackToRack. */
export function rackToRackPath(layout: Layout, a: Location, b: Location, minutesA: number, minutesB: number): Path {
  const p = new PathBuilder();
  p.to(a.x, a.y).stop(minutesA, a.id, a.level);
  if (a.zone === b.zone && a.aisle === b.aisle) {
    p.to(b.x, b.y).stop(minutesB, b.id, b.level).to(a.x, a.y);
    return p.build();
  }
  const crossY = Math.min(a.y, b.y, layout.pickFrontY);
  p.to(a.x, crossY).to(b.x, crossY).to(b.x, b.y).stop(minutesB, b.id, b.level).to(b.x, crossY).to(a.x, crossY).to(a.x, a.y);
  return p.build();
}

// ---------------------------------------------------------------------------
// Rack clearance: which rows a cross leg can be drawn on without entering a rack
// ---------------------------------------------------------------------------

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface RackIndex {
  rects: Rect[];
  /** Candidate corridor rows, sorted. */
  rows: number[];
  cover: Map<number, Array<[number, number]>>;
}

const indexCache = new WeakMap<Layout, RackIndex>();

function rackIndex(layout: Layout, world: World): RackIndex {
  let idx = indexCache.get(layout);
  if (idx) return idx;
  const rects: Rect[] = layout.spec.racks.map((r) => ({ x0: r.x - r.depthFt / 2, x1: r.x + r.depthFt / 2, y0: Math.min(r.y0, r.y1), y1: Math.max(r.y0, r.y1) }));
  const d = layout.spec.depthFt;
  const rows = new Set<number>();
  const addRow = (y: number) => rows.add(Math.round(Math.max(1, Math.min(d - 1, y)) * 100) / 100);
  for (const c of [world.corridors.front, world.corridors.back, world.corridors.reserveFront, world.corridors.apron]) addRow(c);
  for (const r of rects) {
    addRow(r.y0 - 3);
    addRow(r.y1 + 3);
  }
  idx = { rects, rows: [...rows].sort((p, q) => p - q), cover: new Map() };
  indexCache.set(layout, idx);
  return idx;
}

/** Merged x-intervals of racks covering row y (closed). */
function coverAt(idx: RackIndex, y: number): Array<[number, number]> {
  const hit = idx.cover.get(y);
  if (hit) return hit;
  const spans = idx.rects.filter((r) => y >= r.y0 - EPS && y <= r.y1 + EPS).map((r) => [r.x0, r.x1] as [number, number]).sort((p, q) => p[0] - q[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + EPS) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  idx.cover.set(y, merged);
  return merged;
}

function rowClear(idx: RackIndex, y: number, x0: number, x1: number): boolean {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  for (const [a, b] of coverAt(idx, y)) {
    if (b < lo - EPS) continue;
    if (a > hi + EPS) break;
    return false;
  }
  return true;
}

/** The clear candidate row nearest y over the span; y itself when it is clear; the nearest candidate regardless when none is. */
function clearRowNear(idx: RackIndex, y: number, x0: number, x1: number, keepIfClear: boolean): number {
  if (keepIfClear && rowClear(idx, y, x0, x1)) return y;
  let best = idx.rows[0] ?? y;
  let bestD = Infinity;
  let fallback = best;
  let fallbackD = Infinity;
  for (const r of idx.rows) {
    const dist = Math.abs(r - y);
    if (dist < fallbackD) {
      fallbackD = dist;
      fallback = r;
    }
    if (dist < bestD && rowClear(idx, r, x0, x1)) {
      bestD = dist;
      best = r;
    }
  }
  return bestD < Infinity ? best : fallback;
}

/**
 * Move every horizontal leg that touches or enters a rack onto the nearest
 * clear corridor row. The S-shape's cross-aisle legs sit exactly on the rack
 * ends, so with offsets on a walker is always a few feet off the racks; the
 * cost is a slightly longer polyline, which the fit reports as speedRatio.
 */
export function visualOffset(path: Path, world: World, layout: Layout): Path {
  const idx = rackIndex(layout, world);
  const pts = path.pts.map((p) => [p[0], p[1]] as Pt);
  let i = 0;
  while (i < pts.length - 1) {
    if (Math.abs(pts[i][1] - pts[i + 1][1]) > EPS || Math.abs(pts[i][0] - pts[i + 1][0]) < EPS) {
      i++;
      continue;
    }
    // Maximal horizontal run starting at i.
    let j = i + 1;
    while (j + 1 < pts.length && Math.abs(pts[j + 1][1] - pts[i][1]) < EPS) j++;
    const y = pts[i][1];
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let k = i; k <= j; k++) {
      x0 = Math.min(x0, pts[k][0]);
      x1 = Math.max(x1, pts[k][0]);
    }
    const ny = clearRowNear(idx, y, x0, x1, true);
    if (ny !== y) for (let k = i; k <= j; k++) pts[k][1] = ny;
    i = j;
  }
  return refreshStops({ pts, feet: 0, stops: path.stops.map((s) => ({ ...s })) });
}

/** Whether a segment intersects any rack rectangle; `closed` counts touching the boundary. Exported for tests. */
export function segmentHitsRack(layout: Layout, a: Pt, b: Pt, closed: boolean): boolean {
  const e = closed ? EPS : -EPS;
  const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
  const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  for (const r of layout.spec.racks) {
    const x0 = r.x - r.depthFt / 2;
    const x1 = r.x + r.depthFt / 2;
    const y0 = Math.min(r.y0, r.y1);
    const y1 = Math.max(r.y0, r.y1);
    if (hi[0] < x0 - e || lo[0] > x1 + e || hi[1] < y0 - e || lo[1] > y1 + e) continue;
    return true;
  }
  return false;
}

/**
 * Walk between two floor points: Manhattan via the corridor row that adds the
 * least detour and is clear of racks across the span. Straight when the points
 * already share a row or a column.
 */
export function transferPath(layout: Layout, world: World, from: Pt, to: Pt): Path {
  const b = new PathBuilder();
  b.to(from[0], from[1]);
  const idx = rackIndex(layout, world);
  if (Math.abs(from[0] - to[0]) < EPS || (Math.abs(from[1] - to[1]) < EPS && rowClear(idx, from[1], from[0], to[0]))) {
    b.to(to[0], to[1]);
    return b.build();
  }
  let bestClear = NaN;
  let bestClearCost = Infinity;
  let bestAny = from[1];
  let bestAnyCost = Infinity;
  const consider = (y: number) => {
    const cost = Math.abs(from[1] - y) + Math.abs(to[1] - y);
    if (cost < bestAnyCost) {
      bestAnyCost = cost;
      bestAny = y;
    }
    if (cost < bestClearCost && rowClear(idx, y, from[0], to[0])) {
      bestClearCost = cost;
      bestClear = y;
    }
  };
  consider(from[1]);
  consider(to[1]);
  for (const r of idx.rows) consider(r);
  const row = Number.isNaN(bestClear) ? bestAny : bestClear;
  b.to(from[0], row).to(to[0], row).to(to[0], to[1]);
  return b.build();
}

export interface YardPath extends Path {
  /** Vertex index where the truck is at the road point in front of the door (start of backing in). */
  roadVertex: number;
  /** Vertex index of the queue spot, -1 when the truck does not queue. */
  queueVertex: number;
}

/**
 * Truck route: spawn → along the road → the road point in front of the door
 * (→ a queue spot and back when it waits) → backed in at the door. The reverse
 * (door → road → the far spawn) is the departure.
 */
export function yardPath(world: World, frame: DoorFrame, fromLeft: boolean, queueSpot: number): YardPath {
  const b = new PathBuilder();
  const spawn = fromLeft ? world.yard.spawnLeft : world.yard.spawnRight;
  const road = roadPoint(world, frame);
  b.to(spawn[0], spawn[1]).to(road[0], spawn[1]).to(road[0], road[1]);
  let queueVertex = -1;
  const roadVertex = b.pts.length - 1;
  if (queueSpot >= 0) {
    const q = world.yard.queue[frame.index]?.[queueSpot % (world.yard.queue[frame.index]?.length || 1)];
    if (q) {
      b.to(q[0], q[1]);
      queueVertex = b.pts.length - 1;
      b.to(road[0], road[1]);
    }
  }
  const dock = trailerPose(frame).pt;
  b.to(dock[0], dock[1]);
  const p = b.build();
  return { ...p, roadVertex, queueVertex };
}

/** Departure: docked → road point → the exit spawn on the far side. */
export function exitPath(world: World, frame: DoorFrame, toRight: boolean): Path {
  const b = new PathBuilder();
  const dock = trailerPose(frame).pt;
  const road = roadPoint(world, frame);
  const spawn = toRight ? world.yard.spawnRight : world.yard.spawnLeft;
  b.to(dock[0], dock[1]).to(road[0], road[1]).to(road[0], spawn[1]).to(spawn[0], spawn[1]);
  return b.build();
}
