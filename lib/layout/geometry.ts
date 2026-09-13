/** Small 2D geometry helpers for turning drawings into rack runs and doors. */

import type { Point } from "./spec";

export function bbox(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function rotate([x, y]: Point, angle: number, cx = 0, cy = 0): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** Andrew's monotone chain. */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface OrientedBox {
  cx: number;
  cy: number;
  /** Long side, and the angle of the long axis in radians within [0, π). */
  length: number;
  width: number;
  angle: number;
}

/** Minimum-area oriented bounding box, testing each hull edge direction. */
export function orientedBox(points: Point[]): OrientedBox | null {
  const hull = convexHull(points);
  if (hull.length < 2) return null;
  let best: OrientedBox | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (!Number.isFinite(theta)) continue;
    const rot = hull.map((p) => rotate(p, -theta));
    const bb = bbox(rot);
    const w = bb.maxX - bb.minX;
    const h = bb.maxY - bb.minY;
    const area = w * h;
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const [cx, cy] = rotate([(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2], theta);
      const longAlongX = w >= h;
      let angle = longAlongX ? theta : theta + Math.PI / 2;
      angle = ((angle % Math.PI) + Math.PI) % Math.PI;
      best = { cx, cy, length: Math.max(w, h), width: Math.min(w, h), angle };
    }
  }
  return best;
}

/**
 * Dominant direction of a set of axes weighted by length, modulo π. Uses the
 * doubled-angle average so 1° and 179° count as the same direction.
 */
export function dominantAngle(items: Array<{ angle: number; weight: number }>): number {
  let sx = 0;
  let sy = 0;
  for (const it of items) {
    sx += Math.cos(2 * it.angle) * it.weight;
    sy += Math.sin(2 * it.angle) * it.weight;
  }
  if (sx === 0 && sy === 0) return 0;
  return ((Math.atan2(sy, sx) / 2) % Math.PI + Math.PI) % Math.PI;
}

/**
 * Join loose segments into polylines by matching endpoints within a
 * tolerance, so a rectangle drawn as four LINE entities becomes one ring.
 */
export function chainSegments(segments: Array<[Point, Point]>, tol: number): Point[][] {
  const key = (p: Point) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
  const byEnd = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      const list = byEnd.get(k) ?? [];
      list.push(i);
      byEnd.set(k, list);
    }
  });
  const used = new Array(segments.length).fill(false);
  const out: Point[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain: Point[] = [segments[i][0], segments[i][1]];
    for (const end of [1, 0] as const) {
      for (;;) {
        const tip = end === 1 ? chain[chain.length - 1] : chain[0];
        const next = (byEnd.get(key(tip)) ?? []).find((j) => !used[j]);
        if (next === undefined) break;
        used[next] = true;
        const [a, b] = segments[next];
        const other = key(a) === key(tip) ? b : a;
        if (end === 1) chain.push(other);
        else chain.unshift(other);
        if (chain.length > 10_000) break;
      }
    }
    out.push(chain);
  }
  return out;
}

export function isClosed(points: Point[], tol: number): boolean {
  if (points.length < 3) return false;
  const a = points[0];
  const b = points[points.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
}

/** Douglas–Peucker simplification, for drawing walls compactly. */
export function simplify(points: Point[], tol: number): Point[] {
  if (points.length <= 2) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  let maxD = -1;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i][0] - dx * points[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tol) return [a, b];
  return simplify(points.slice(0, idx + 1), tol).slice(0, -1).concat(simplify(points.slice(idx), tol));
}

/** Local equirectangular projection from lon/lat degrees to feet around an origin. */
export function lonLatToFeet(origin: Point): (p: Point) => Point {
  const ftPerDegLat = 364_000;
  const ftPerDegLon = ftPerDegLat * Math.cos((origin[1] * Math.PI) / 180);
  return ([lon, lat]) => [(lon - origin[0]) * ftPerDegLon, (lat - origin[1]) * ftPerDegLat];
}
