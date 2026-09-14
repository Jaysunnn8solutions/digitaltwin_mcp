/**
 * Sliding never leaves the walker inside a box, whatever the corner; walls
 * open at the doors; a docked trailer blocks the apron.
 */
import { describe, expect, it } from "vitest";
import sitesJson from "../../data/sites.json";
import { siteToSpec } from "../twin/layout";
import type { Site } from "../twin/types";
import { overlapsAny, pushOut, rackColliders, slideCircle, trailerCollider, wallColliders, type Aabb } from "./collide";
import { WALK_RADIUS } from "./walk";

const R = WALK_RADIUS;
const box = (x0: number, y0: number, x1: number, y1: number): Aabb => ({ x0, y0, x1, y1 });

/** Deterministic LCG so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("slideCircle", () => {
  it("slides along a face, keeping the tangential motion", () => {
    const b = [box(0, 0, 10, 10)];
    const p = slideCircle(-5, 5, 10, 3, R, b);
    expect(p.x).toBeCloseTo(-R, 2);
    expect(p.y).toBeCloseTo(8, 6);
    expect(overlapsAny(p.x, p.y, R - 1e-6, b)).toBe(false);
  });

  it("stops at a corner approached diagonally", () => {
    const b = [box(0, 0, 10, 10)];
    const p = slideCircle(-5, -5, 10, 10, R, b);
    expect(overlapsAny(p.x, p.y, R - 1e-6, b)).toBe(false);
    // Moved in x first, then blocked in y at the bottom face.
    expect(p.x).toBeCloseTo(5, 6);
    expect(p.y).toBeCloseTo(-R, 2);
  });

  it("cannot squeeze through a gap narrower than its body", () => {
    const b = [box(0, 0, 10, 10), box(12, 0, 22, 10)];
    let p = { x: 11, y: -5 };
    for (let i = 0; i < 20; i++) p = slideCircle(p.x, p.y, 0, 1, R, b);
    expect(p.y).toBeLessThan(0);
    expect(overlapsAny(p.x, p.y, R - 1e-6, b)).toBe(false);
  });

  it("pushes a walker that starts inside a box out through the nearest face", () => {
    const b = [box(0, 0, 10, 10)];
    const p = pushOut(9, 5, R, b);
    expect(p.x).toBeGreaterThan(10 + R - 1e-6);
    expect(p.y).toBe(5);
    const q = slideCircle(2, 9, 0, 0, R, b);
    expect(overlapsAny(q.x, q.y, R - 1e-6, b)).toBe(false);
    expect(q.y).toBeGreaterThan(10);
  });

  it("never ends inside a box on a random walk through a rack grid", () => {
    const boxes: Aabb[] = [];
    for (let a = 0; a < 6; a++) for (let k = 0; k < 3; k++) boxes.push(box(10 + a * 12, 10 + k * 25, 14 + a * 12, 30 + k * 25));
    boxes.push(box(-1, -1, 100, 0), box(-1, 0, 0, 90), box(100, 0, 101, 90), box(0, 90, 100, 91));
    const rnd = lcg(7);
    let x = 5;
    let y = 5;
    for (let step = 0; step < 4000; step++) {
      const dx = (rnd() - 0.5) * 8;
      const dy = (rnd() - 0.5) * 8;
      const p = slideCircle(x, y, dx, dy, R, boxes);
      expect(overlapsAny(p.x, p.y, R - 1e-6, boxes)).toBe(false);
      x = p.x;
      y = p.y;
    }
    // It went somewhere.
    expect(Math.hypot(x - 5, y - 5)).toBeGreaterThan(5);
  });

  it("random walks between touching boxes stay out of the seam", () => {
    const boxes = [box(0, 0, 10, 10), box(10, 0, 20, 10), box(0, 10, 10, 20)];
    const rnd = lcg(99);
    let x = -5;
    let y = -5;
    for (let step = 0; step < 2000; step++) {
      const p = slideCircle(x, y, (rnd() - 0.5) * 6, (rnd() - 0.5) * 6, R, boxes);
      expect(overlapsAny(p.x, p.y, R - 1e-6, boxes)).toBe(false);
      x = p.x;
      y = p.y;
    }
  });
});

describe("colliders from a layout", () => {
  const site = (sitesJson as Site[]).find((s) => s.id === "dc-west")!;
  const spec = siteToSpec(site);
  const frames = spec.doors.map((d, index) => ({ door: d.id, kind: d.kind, index, origin: [d.x, d.y] as [number, number], inward: [0, 1] as [number, number], tangent: [1, 0] as [number, number], widthFt: d.widthFt }));

  it("boxes every rack run", () => {
    const racks = rackColliders(spec);
    expect(racks).toHaveLength(spec.racks.length);
    expect(racks[0]).toEqual({ x0: 20, y0: 70, x1: 24, y1: 160 });
  });

  it("opens the dock wall at each door and keeps it closed between them", () => {
    const walls = wallColliders(spec, frames);
    // Door IN-1 is centred at x = 24: a walker can stand in the opening.
    expect(overlapsAny(24, 0, R, walls)).toBe(false);
    expect(overlapsAny(24, 4, R, walls)).toBe(false);
    // Between the doors the wall is solid.
    expect(overlapsAny(48, 0, R, walls)).toBe(true);
    expect(overlapsAny(10, 0, R, walls)).toBe(true);
    // The far wall too.
    expect(overlapsAny(120, 200, R, walls)).toBe(true);
    expect(overlapsAny(120, 100, R, walls)).toBe(false);
  });

  it("chops a diagonal wall into pieces and boxes each", () => {
    const walls = wallColliders({ ...spec, walls: [[[10, 10], [40, 40]]] }, frames);
    expect(walls.length).toBeGreaterThan(spec.outline.length + 4);
    expect(overlapsAny(25, 25, R, walls)).toBe(true);
    expect(overlapsAny(10, 40, R, walls)).toBe(false);
  });

  it("a docked trailer sits outside its door", () => {
    const t = trailerCollider(frames[0]);
    expect(t.y1).toBeCloseTo(0, 6);
    expect(t.y0).toBeLessThan(-50);
    expect(t.x0).toBeCloseTo(24 - 4.25, 6);
    expect(overlapsAny(24, -30, R, [t])).toBe(true);
    expect(overlapsAny(40, -30, R, [t])).toBe(false);
  });
});
