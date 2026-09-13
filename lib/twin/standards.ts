import type { CostRates, LaborStandards } from "./types";

/**
 * Engineered labor standards in minutes, before a worker's productivity
 * factor. Placeholders in the range published for small grocery and
 * convenience distributors; edit them here, or override per call.
 */
export const DEFAULT_STANDARDS: LaborStandards = {
  unloadPerPallet: 2.5,
  unloadPerTruck: 12,
  receivePerPallet: 1.5,
  receivePerCase: 0.08,
  labelPerImportCase: 0.6,
  putawayHandling: 2,
  replenHandling: 2.5,
  pickPerLine: 0.35,
  pickPerInner: 0.12,
  pickPerTour: 1.5,
  pickBendReachSec: 5,
  packPerPallet: 7,
  loadPerPallet: 2,
  loadPerTruck: 10,
  walkFtPerMin: 180,
  forkliftFtPerMin: 350,
  liftMinPerLevel: 0.35,
  cartCubeFt: 30,
  palletCubeFt: 55,
  slotHeightFt: 1.5,
  faceDaysOfSupply: 5,
};

export const DEFAULT_COSTS: CostRates = {
  overtimeMultiplier: 1.5,
  tempHourly: 27,
  tempProductivity: 0.75,
  crossTrainCost: 900,
  crossTrainWeeks: 3,
  hireCost: 4500,
  hireWeeks: 4,
  costOfGoods: 0.55,
};

/** "HH:MM" to minutes after midnight. */
export function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes after midnight to "HH:MM", wrapping past midnight. */
export function clock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Paid length of a shift in hours, which is also what it costs. */
export function shiftPaidHours(start: string, end: string): number {
  let len = hhmm(end) - hhmm(start);
  if (len <= 0) len += 1440;
  return len / 60;
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
