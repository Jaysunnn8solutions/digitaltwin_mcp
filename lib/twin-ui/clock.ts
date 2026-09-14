/**
 * The playback clock the /twin page's animation loop drives: simulated
 * minutes advance at `speed` simulated minutes per real minute while playing,
 * never leave [0, horizonEnd], and, with skipQuiet on, jump over the
 * compiler's quiet intervals (nobody on the floor: nights, weekends) exactly
 * once each, reporting the gap so the page can show a toast. Pure; the RAF
 * loop in TwinScene owns one and the tests drive it by hand.
 */

import type { Interval } from "../trace/types";

export interface ClockTick {
  t: number;
  /** The quiet interval this tick jumped over, when it did. */
  skipped?: [t0: number, t1: number];
}

/**
 * Simulated minutes per real minute when a run first plays: 300× shows an
 * 8.5 h shift in about 100 s. 60× (one simulated minute per second) made the
 * same shift take 8.5 real minutes, too slow to see a day's shape; it stays
 * available on the speed row.
 */
export const DEFAULT_SPEED = 300;

export class PlaybackClock {
  t = 0;
  /** Simulated minutes per real minute: 60 plays one simulated minute per second. */
  speed = DEFAULT_SPEED;
  playing = false;
  skipQuiet = true;

  constructor(public horizonEnd: number) {}

  /** Clamp into [0, horizonEnd]. */
  seek(t: number): number {
    this.t = Math.min(this.horizonEnd, Math.max(0, Number.isFinite(t) ? t : 0));
    return this.t;
  }

  /** Move by a signed number of simulated minutes, clamped. */
  step(dMin: number): number {
    return this.seek(this.t + dMin);
  }

  /**
   * Advance by a real-time slice. The jump rule: when the advanced time lands
   * inside a quiet interval [t0, t1) the clock goes to t1 and reports it, so
   * the next tick starts past the gap and cannot report it again. Reaching
   * the horizon stops playback.
   */
  tick(dtSec: number, quiet: Interval | null): ClockTick {
    if (!this.playing) return { t: this.t };
    const dtMin = (Math.max(0, dtSec) * this.speed) / 60;
    let next = this.t + dtMin;
    let skipped: [number, number] | undefined;
    if (this.skipQuiet && quiet) {
      const gap = quietGapAt(quiet, next);
      if (gap) {
        next = gap[1];
        skipped = gap;
      }
    }
    if (next >= this.horizonEnd) {
      next = this.horizonEnd;
      this.playing = false;
    }
    this.t = next;
    return skipped ? { t: next, skipped } : { t: next };
  }
}

/** The quiet interval containing t (t0 <= t < t1), or null. Intervals are sorted and disjoint. */
export function quietGapAt(quiet: Interval, t: number): [number, number] | null {
  const n = Math.min(quiet.t0.length, quiet.t1.length);
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (quiet.t0[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  if (i < 0) return null;
  const t0 = quiet.t0[i];
  const t1 = quiet.t1[i];
  return t >= t0 && t < t1 ? [t0, t1] : null;
}
