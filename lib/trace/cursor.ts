/**
 * Sampling a playback frame by frame: binary search on a seek, amortised O(1)
 * on an advance, poses packed per track (x, y, z, h, s, seg, job, carry) and
 * the dirty-list rows crossed since the previous sample so the renderer applies
 * exactly the timeline changes it passed over.
 */

import { lowerBound, upperBound } from "./search";
import { ActorState, SegKind, SYNTH_JOB, type Playback, type Track } from "./types";

export const POSE_STRIDE = 8;

export interface CursorSample {
  /** tracks.length × POSE_STRIDE: x, y, z, h, s, seg, job, carry. The same array is reused between calls. */
  poses: Float32Array;
  /** Dirty-list rows crossed: [dirtyFrom, dirtyTo). Empty after a seek. */
  dirtyFrom: number;
  dirtyTo: number;
  t: number;
}

const TWO_PI = Math.PI * 2;

function lerpAngle(a: number, b: number, u: number): number {
  const d = ((((b - a) % TWO_PI) + TWO_PI + Math.PI) % TWO_PI) - Math.PI;
  return a + d * u;
}

export class PlaybackCursor {
  readonly poses: Float32Array;
  private readonly idx: Int32Array;
  private t = -1;
  private dirtyPos = 0;

  constructor(readonly pb: Playback) {
    this.poses = new Float32Array(pb.tracks.length * POSE_STRIDE);
    this.idx = new Int32Array(pb.tracks.length);
  }

  get time(): number {
    return this.t;
  }

  private sample(k: number, tr: Track, t: number): void {
    const o = k * POSE_STRIDE;
    const p = this.poses;
    const n = tr.t.length;
    if (n === 0) {
      p[o + 4] = ActorState.Off;
      p[o + 5] = SegKind.Hold;
      p[o + 6] = SYNTH_JOB.none;
      p[o + 7] = -1;
      return;
    }
    const i = this.idx[k];
    if (i >= n - 1 || t <= tr.t[i]) {
      p[o] = tr.x[i];
      p[o + 1] = tr.y[i];
      p[o + 2] = tr.z[i];
      p[o + 3] = tr.h[i];
    } else {
      const u = (t - tr.t[i]) / (tr.t[i + 1] - tr.t[i]);
      p[o] = tr.x[i] + (tr.x[i + 1] - tr.x[i]) * u;
      p[o + 1] = tr.y[i] + (tr.y[i + 1] - tr.y[i]) * u;
      p[o + 2] = tr.z[i] + (tr.z[i + 1] - tr.z[i]) * u;
      p[o + 3] = lerpAngle(tr.h[i], tr.h[i + 1], u);
    }
    p[o + 4] = tr.s[i];
    p[o + 5] = tr.seg[i];
    p[o + 6] = tr.job[i];
    p[o + 7] = tr.carry[i];
  }

  /** Jump: every track index found by binary search; the dirty range is empty (the caller re-applies all timelines at t). */
  seek(t: number): CursorSample {
    const tracks = this.pb.tracks;
    for (let k = 0; k < tracks.length; k++) {
      const tr = tracks[k];
      if (!tr) continue;
      this.idx[k] = Math.max(0, upperBound(tr.t, t) - 1);
      this.sample(k, tr, t);
    }
    this.t = t;
    this.dirtyPos = upperBound(this.pb.dirty.t, t);
    return { poses: this.poses, dirtyFrom: this.dirtyPos, dirtyTo: this.dirtyPos, t };
  }

  /** Step to t: forward steps walk the keyframes; a backward step falls back to a search. Returns the dirty rows crossed. */
  advance(t: number): CursorSample {
    if (this.t < 0) return this.seek(t);
    const prev = this.t;
    const tracks = this.pb.tracks;
    for (let k = 0; k < tracks.length; k++) {
      const tr = tracks[k];
      if (!tr) continue;
      const n = tr.t.length;
      let i = this.idx[k];
      if (t >= prev) {
        let steps = 0;
        while (i + 1 < n && tr.t[i + 1] <= t) {
          i++;
          if (++steps > 8) {
            i = Math.max(0, upperBound(tr.t, t, i, n) - 1);
            break;
          }
        }
      } else {
        i = Math.max(0, upperBound(tr.t, t, 0, i + 1) - 1);
      }
      this.idx[k] = i;
      this.sample(k, tr, t);
    }
    const dt = this.pb.dirty.t;
    let from: number;
    let to: number;
    if (t >= prev) {
      from = this.dirtyPos;
      to = upperBound(dt, t, from);
      this.dirtyPos = to;
    } else {
      to = this.dirtyPos;
      from = lowerBound(dt, t, 0, to);
      // Rows with dirty.t === t stay applied: they are in effect at t.
      from = upperBound(dt, t, from, to);
      this.dirtyPos = from;
    }
    this.t = t;
    return { poses: this.poses, dirtyFrom: from, dirtyTo: to, t };
  }
}
