/**
 * The cursor samples the same poses whether it seeks or advances, and reports
 * exactly the dirty rows crossed between two samples.
 */
import "../data/load";
import { describe, expect, it } from "vitest";
import { loadCatalog, loadRoster } from "../data/store";
import { DEFAULT_STANDARDS } from "../twin/standards";
import { buildTwin } from "../twin/twin";
import { seededRandom } from "../util/random";
import { compilePlayback } from "./compile";
import { PlaybackCursor, POSE_STRIDE } from "./cursor";
import { buildFixture } from "./fixtures";
import { lowerBound, upperBound } from "./search";
import type { Playback } from "./types";
import { buildWorld } from "./world";

async function playback(): Promise<Playback> {
  const ctx = await buildTwin("dc-west", 36, {});
  const f = buildFixture(ctx.layout, loadCatalog(), loadRoster().workers, DEFAULT_STANDARDS);
  return compilePlayback({ events: f.events, layout: ctx.layout, world: buildWorld(ctx.layout, f.workers), skus: f.skus, slotting: f.slotting });
}

describe("search", () => {
  it("lowerBound and upperBound bracket equal keys", () => {
    const a = Float64Array.from([0, 1, 1, 2, 5, 5, 9]);
    expect(lowerBound(a, 1)).toBe(1);
    expect(upperBound(a, 1)).toBe(3);
    expect(lowerBound(a, 5)).toBe(4);
    expect(upperBound(a, 5)).toBe(6);
    expect(lowerBound(a, -1)).toBe(0);
    expect(upperBound(a, 10)).toBe(7);
    expect(upperBound(a, 3, 2, 5)).toBe(4);
  });
});

describe("PlaybackCursor", () => {
  it("seek then advance equals a fresh seek at 50 random times", async () => {
    const pb = await playback();
    const a = new PlaybackCursor(pb);
    const b = new PlaybackCursor(pb);
    const rng = seededRandom(21);
    let t0 = 0;
    for (let k = 0; k < 50; k++) {
      const t1 = Math.min(pb.meta.horizonEnd, t0 + rng() * 120);
      a.seek(t0);
      const adv = a.advance(t1);
      const fresh = b.seek(t1);
      expect(adv.poses).toEqual(fresh.poses);
      expect(adv.poses.length).toBe(pb.tracks.length * POSE_STRIDE);
      // Small steps too: many advances land where one seek does.
      a.seek(t0);
      const steps = 1 + Math.floor(rng() * 6);
      let last = adv;
      for (let s = 1; s <= steps; s++) last = a.advance(t0 + ((t1 - t0) * s) / steps);
      expect(last.poses).toEqual(fresh.poses);
      t0 = rng() < 0.3 ? rng() * pb.meta.horizonEnd : t1;
    }
  });

  it("reports exactly the dirty rows crossed", async () => {
    const pb = await playback();
    const c = new PlaybackCursor(pb);
    const rng = seededRandom(23);
    const dt = pb.dirty.t;
    expect(dt.length).toBeGreaterThan(0);
    for (let k = 0; k < 50; k++) {
      const t0 = rng() * pb.meta.horizonEnd;
      const t1 = Math.min(pb.meta.horizonEnd, t0 + rng() * 300);
      const s = c.seek(t0);
      expect(s.dirtyFrom).toBe(s.dirtyTo);
      const r = c.advance(t1);
      expect(r.dirtyFrom).toBe(upperBound(dt, t0));
      expect(r.dirtyTo).toBe(upperBound(dt, t1));
      for (let i = r.dirtyFrom; i < r.dirtyTo; i++) {
        expect(dt[i]).toBeGreaterThan(t0);
        expect(dt[i]).toBeLessThanOrEqual(t1);
      }
      // Chained advances partition the range.
      const mid = (t0 + t1) / 2;
      c.seek(t0);
      const r1 = c.advance(mid);
      const r2 = c.advance(t1);
      expect(r1.dirtyFrom).toBe(r.dirtyFrom);
      expect(r1.dirtyTo).toBe(r2.dirtyFrom);
      expect(r2.dirtyTo).toBe(r.dirtyTo);
      // Backwards: the rows between are reported and the position rewinds.
      const back = c.advance(t0);
      expect(back.dirtyFrom).toBe(upperBound(dt, t0));
      expect(back.dirtyTo).toBe(upperBound(dt, t1));
      expect(back.poses).toEqual(new PlaybackCursor(pb).seek(t0).poses);
      expect(lowerBound(dt, t0)).toBeLessThanOrEqual(back.dirtyFrom);
    }
  });

  it("holds the last frame past the end of a track and Off before the first", async () => {
    const pb = await playback();
    const c = new PlaybackCursor(pb);
    const end = c.seek(pb.meta.horizonEnd);
    const truck = pb.entities.findIndex((e) => e.kind === "truckIn");
    const tr = pb.tracks[truck]!;
    expect(end.poses[truck * POSE_STRIDE]).toBeCloseTo(tr.x[tr.t.length - 1], 5);
    const early = c.seek(0);
    expect(early.poses[truck * POSE_STRIDE + 4]).toBe(0);
  });
});
