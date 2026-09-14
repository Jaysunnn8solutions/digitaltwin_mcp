/**
 * Walk-mode collision in the engine frame (feet, x across, y inward): a
 * circle slides against axis-aligned boxes. Each move is resolved one axis at
 * a time against every box grown by the radius, then a final push-out
 * guarantees the centre is never left inside a grown box, whatever corner or
 * seam the two axis moves ran into (collide.test.ts random-walks this).
 *
 * Boxes come from rack runs, wall segments split at the door openings so a
 * walker can step out onto the dock, and the trailers docked right now. A
 * diagonal wall from an imported drawing is chopped into short pieces and
 * each piece boxed, which is slightly conservative and always safe.
 */

import type { LayoutSpec } from "../layout/spec";
import type { DoorFrame } from "../trace/types";
import { TRAILER_WIDTH, TRUCK_LENGTH } from "./geometry";

export interface Aabb {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EPS = 1e-3;

function inside(x: number, y: number, r: number, b: Aabb): boolean {
  return x > b.x0 - r && x < b.x1 + r && y > b.y0 - r && y < b.y1 + r;
}

/** True when a circle of radius r at (x, y) overlaps any box. */
export function overlapsAny(x: number, y: number, r: number, boxes: readonly Aabb[]): boolean {
  for (const b of boxes) if (inside(x, y, r, b)) return true;
  return false;
}

/** Moves the centre out of every box it overlaps, through the nearest face each time. */
export function pushOut(x: number, y: number, r: number, boxes: readonly Aabb[]): { x: number; y: number } {
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (const b of boxes) {
      if (!inside(x, y, r, b)) continue;
      const left = x - (b.x0 - r);
      const right = b.x1 + r - x;
      const down = y - (b.y0 - r);
      const up = b.y1 + r - y;
      const m = Math.min(left, right, down, up);
      if (m === left) x = b.x0 - r - EPS;
      else if (m === right) x = b.x1 + r + EPS;
      else if (m === down) y = b.y0 - r - EPS;
      else y = b.y1 + r + EPS;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y };
}

function moveAxis(px: number, py: number, d: number, r: number, boxes: readonly Aabb[], axis: 0 | 1): number {
  let p = (axis === 0 ? px : py) + d;
  for (let iter = 0; iter < 6; iter++) {
    let hit = false;
    for (const b of boxes) {
      const ox = axis === 0 ? p : px;
      const oy = axis === 0 ? py : p;
      if (!inside(ox, oy, r, b)) continue;
      const lo = (axis === 0 ? b.x0 : b.y0) - r - EPS;
      const hi = (axis === 0 ? b.x1 : b.y1) + r + EPS;
      if (d > 0) p = lo;
      else if (d < 0) p = hi;
      else p = p - lo < hi - p ? lo : hi;
      hit = true;
    }
    if (!hit) break;
  }
  return p;
}

/**
 * Slide a circle from (x, y) by (dx, dy) against the boxes. Returns the
 * resolved centre, never inside a box grown by r.
 */
export function slideCircle(x: number, y: number, dx: number, dy: number, r: number, boxes: readonly Aabb[]): { x: number; y: number } {
  const start = overlapsAny(x, y, r, boxes) ? pushOut(x, y, r, boxes) : { x, y };
  const nx = moveAxis(start.x, start.y, dx, r, boxes, 0);
  const ny = moveAxis(nx, start.y, dy, r, boxes, 1);
  return overlapsAny(nx, ny, r, boxes) ? pushOut(nx, ny, r, boxes) : { x: nx, y: ny };
}

export function rackColliders(spec: LayoutSpec): Aabb[] {
  return spec.racks.map((r) => ({ x0: r.x - r.depthFt / 2, y0: Math.min(r.y0, r.y1), x1: r.x + r.depthFt / 2, y1: Math.max(r.y0, r.y1) }));
}

function segmentBoxes(a: [number, number], b: [number, number], thickness: number, out: Aabb[]): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-6) return;
  const axisAligned = Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6;
  const pieces = axisAligned ? 1 : Math.max(1, Math.ceil(len / 4));
  for (let i = 0; i < pieces; i++) {
    const p = [a[0] + ((b[0] - a[0]) * i) / pieces, a[1] + ((b[1] - a[1]) * i) / pieces];
    const q = [a[0] + ((b[0] - a[0]) * (i + 1)) / pieces, a[1] + ((b[1] - a[1]) * (i + 1)) / pieces];
    out.push({ x0: Math.min(p[0], q[0]) - thickness / 2, y0: Math.min(p[1], q[1]) - thickness / 2, x1: Math.max(p[0], q[0]) + thickness / 2, y1: Math.max(p[1], q[1]) + thickness / 2 });
  }
}

/** Outline and imported walls as thin boxes, with a gap at every door so the dock is reachable. */
export function wallColliders(spec: LayoutSpec, frames: readonly DoorFrame[]): Aabb[] {
  const out: Aabb[] = [];
  const ring: Array<[number, number]> = spec.outline.length >= 3 ? spec.outline : [[0, 0], [spec.widthFt, 0], [spec.widthFt, spec.depthFt], [0, spec.depthFt]];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const spans: Array<[number, number]> = [];
    for (const f of frames) {
      const s = (f.origin[0] - a[0]) * ux + (f.origin[1] - a[1]) * uy;
      const dist = Math.abs((f.origin[0] - a[0]) * uy - (f.origin[1] - a[1]) * ux);
      if (s < -0.5 || s > len + 0.5 || dist > 1.5) continue;
      spans.push([Math.max(0, s - f.widthFt / 2), Math.min(len, s + f.widthFt / 2)]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    let cursor = 0;
    const piece = (s0: number, s1: number) => {
      if (s1 - s0 < 0.1) return;
      segmentBoxes([a[0] + ux * s0, a[1] + uy * s0], [a[0] + ux * s1, a[1] + uy * s1], 1, out);
    };
    for (const [s0, s1] of spans) {
      if (s0 < cursor) continue;
      piece(cursor, s0);
      cursor = s1;
    }
    piece(cursor, len);
  }
  for (const line of spec.walls) for (let i = 0; i + 1 < line.length; i++) segmentBoxes(line[i], line[i + 1], 0.6, out);
  return out;
}

/** The box a docked trailer occupies outside a door (rear at the door, nose along -inward). */
export function trailerCollider(frame: DoorFrame): Aabb {
  const [ox, oy] = frame.origin;
  const nx = ox - frame.inward[0] * TRUCK_LENGTH;
  const ny = oy - frame.inward[1] * TRUCK_LENGTH;
  const hw = TRAILER_WIDTH / 2;
  const tx = Math.abs(frame.tangent[0]) * hw;
  const ty = Math.abs(frame.tangent[1]) * hw;
  return { x0: Math.min(ox, nx) - tx, y0: Math.min(oy, ny) - ty, x1: Math.max(ox, nx) + tx, y1: Math.max(oy, ny) + ty };
}
