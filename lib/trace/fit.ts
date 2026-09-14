/**
 * Fit a job's animation into its engine duration (design C). Durations are the
 * truth: a job lasts dur = max(0.1, std / productivity) whatever the drawn
 * route needs. The ladder decides how the route and the walk from the previous
 * job (the transfer) share that time, and reports the fit so the inspector can
 * say "engine facts" versus "shown".
 */

import type { JobFit } from "./types";

export interface FitInput {
  /** Engine duration, minutes. */
  dur: number;
  productivity: number;
  /** Nominal speed of the actor, ft/min at productivity 1 (walk or forklift). */
  nominal: number;
  /** Handling minutes at productivity 1, rebuilt from the standards. */
  handleMin: number;
  /** Feet of the drawn route (with visual offsets if on). */
  routeFeet: number;
  /** Feet of the transfer leg from where the actor was to the route origin. */
  transferFeet: number;
}

export interface FitResult {
  fit: JobFit;
  stopMin: number;
  moveMin: number;
  /** Feet actually drawn: route plus transfer, or the route alone when the transfer was dropped. */
  visualFeet: number;
  /** The transfer leg kept, 0 when dropped (fadeIn). */
  transferFeet: number;
  /** visualFeet / moveMin ÷ (nominal · productivity). */
  speedRatio: number;
}

function ladder(i: FitInput, transferFeet: number): FitResult {
  const speed = i.nominal * i.productivity;
  const stopMin0 = i.handleMin / i.productivity;
  const moveMin0 = Math.max(0, i.dur - stopMin0);
  const feet = transferFeet + i.routeFeet;
  if (feet <= 0) return { fit: "stationary", stopMin: i.dur, moveMin: 0, visualFeet: 0, transferFeet: 0, speedRatio: 1 };
  const want = feet / speed;
  if (want <= 1.25 * moveMin0) {
    return { fit: "exact", stopMin: i.dur - moveMin0, moveMin: moveMin0, visualFeet: feet, transferFeet, speedRatio: want / moveMin0 };
  }
  if (want <= 0.5 * i.dur) {
    return { fit: "borrowed", stopMin: i.dur - want, moveMin: want, visualFeet: feet, transferFeet, speedRatio: 1 };
  }
  if (transferFeet > 0) {
    const again = ladder(i, 0);
    return again.fit === "fast" ? again : { ...again, fit: "fadeIn" };
  }
  const moveMin = Math.max(moveMin0, 0.5 * i.dur);
  return { fit: "fast", stopMin: i.dur - moveMin, moveMin, visualFeet: feet, transferFeet, speedRatio: want / moveMin };
}

/**
 *   stopMin = H/prod; moveMin = max(0, dur − stopMin); feet = transfer + route
 *   want = feet/(nominal·prod)
 *   feet == 0            → stationary
 *   want ≤ 1.25·moveMin  → exact     (ratio ≤ 1.25; 1 with offsets off and no transfer)
 *   want ≤ 0.5·dur       → borrowed  (handling compressed to pay for the walk; ratio 1)
 *   transfer > 0         → drop it, fade in at the route origin, re-run → fadeIn
 *   else                 → fast      (moveMin = max(moveMin, dur/2), flagged)
 */
export function fitJob(i: FitInput): FitResult {
  return ladder(i, i.transferFeet);
}
