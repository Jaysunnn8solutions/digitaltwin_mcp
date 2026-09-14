/**
 * The playback clock: advances at the chosen speed, never leaves the horizon,
 * and skips each quiet interval exactly once, reporting it.
 */
import { describe, expect, it } from "vitest";
import type { Interval } from "../trace/types";
import { DEFAULT_SPEED, PlaybackClock, quietGapAt } from "./clock";
import { SPEEDS } from "./format";

const quiet: Interval = { t0: Float64Array.from([0, 10, 50]), t1: Float64Array.from([5, 20, 80]) };

describe("PlaybackClock", () => {
  it("starts at 300× with quiet hours skipped, and that speed is on the speed row", () => {
    const c = new PlaybackClock(1000);
    expect(DEFAULT_SPEED).toBe(300);
    expect(c.speed).toBe(DEFAULT_SPEED);
    expect(c.skipQuiet).toBe(true);
    expect(c.playing).toBe(false);
    expect(SPEEDS).toContain(DEFAULT_SPEED);
    // An 8.5 h shift at the default speed is under two real minutes; at 60× it was 8.5 real minutes.
    expect((8.5 * 60) / DEFAULT_SPEED).toBeLessThan(2);
  });

  it("advances by speed × real time while playing and stands still when paused", () => {
    const c = new PlaybackClock(1000);
    c.speed = 60;
    expect(c.tick(1, null)).toEqual({ t: 0 });
    c.playing = true;
    expect(c.tick(1, null).t).toBe(1);
    expect(c.tick(0.5, null).t).toBe(1.5);
    c.speed = 1800;
    expect(c.tick(1, null).t).toBe(31.5);
    c.speed = 1;
    expect(c.tick(60, null).t).toBe(32.5);
  });

  it("clamps into [0, horizonEnd] and stops at the horizon", () => {
    const c = new PlaybackClock(100);
    c.speed = 60;
    c.playing = true;
    c.seek(99);
    expect(c.tick(10, null).t).toBe(100);
    expect(c.playing).toBe(false);
    expect(c.seek(-5)).toBe(0);
    expect(c.seek(1e9)).toBe(100);
    expect(c.seek(Number.NaN)).toBe(0);
    c.seek(50);
    expect(c.step(-70)).toBe(0);
    expect(c.step(300)).toBe(100);
  });

  it("skips a quiet interval exactly once and reports it", () => {
    const c = new PlaybackClock(1000);
    c.speed = 60;
    c.playing = true;
    // t = 0 is inside the first gap [0, 5): the first tick jumps to 5.
    expect(c.tick(1, quiet)).toEqual({ t: 5, skipped: [0, 5] });
    // Ordinary ticks up to the second gap.
    expect(c.tick(1, quiet)).toEqual({ t: 6 });
    c.seek(9);
    expect(c.tick(2, quiet)).toEqual({ t: 20, skipped: [10, 20] });
    // The next tick starts past the gap: no second report.
    expect(c.tick(1, quiet)).toEqual({ t: 21 });
    // Landing exactly on t1 is not inside the gap.
    c.seek(49);
    expect(c.tick(2, quiet)).toEqual({ t: 80, skipped: [50, 80] });
    expect(c.tick(1, quiet)).toEqual({ t: 81 });
    // Seeking back into a gap and playing on skips it again (a fresh entry), still once.
    c.seek(60);
    expect(c.tick(0.1, quiet)).toEqual({ t: 80, skipped: [50, 80] });
    expect(c.tick(1, quiet)).toEqual({ t: 81 });
  });

  it("does not skip with skipQuiet off, and a skip that reaches the horizon stops playback", () => {
    const c = new PlaybackClock(1000);
    c.speed = 60;
    c.playing = true;
    c.skipQuiet = false;
    c.seek(9);
    expect(c.tick(2, quiet)).toEqual({ t: 11 });
    const end = new PlaybackClock(80);
    end.speed = 60;
    end.playing = true;
    end.seek(49);
    expect(end.tick(2, quiet)).toEqual({ t: 80, skipped: [50, 80] });
    expect(end.playing).toBe(false);
  });

  it("finds the gap containing a time", () => {
    expect(quietGapAt(quiet, 0)).toEqual([0, 5]);
    expect(quietGapAt(quiet, 4.99)).toEqual([0, 5]);
    expect(quietGapAt(quiet, 5)).toBeNull();
    expect(quietGapAt(quiet, 15)).toEqual([10, 20]);
    expect(quietGapAt(quiet, 79.9)).toEqual([50, 80]);
    expect(quietGapAt(quiet, 80)).toBeNull();
    expect(quietGapAt({ t0: new Float64Array(0), t1: new Float64Array(0) }, 3)).toBeNull();
  });
});
