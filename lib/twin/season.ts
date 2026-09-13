/**
 * Candy seasonality, identical to candystore_mcp's lib/model/simulate.ts so a
 * week here is the same week there: Halloween peaks in week 44, Christmas in
 * 51–52, Valentine's in 6–7, Easter around 13–15, and week 1 is the trough.
 * The index is a ratio against an ordinary week, divided by its own 52-week
 * mean so candystore's average-week dollars are redistributed across the year
 * rather than marked up.
 */

export function seasonIndex(week: number): number {
  const w = ((((week - 1) % 52) + 52) % 52) + 1;
  if (w >= 42 && w <= 44) return w === 44 ? 2.4 : 1.6;
  if (w >= 49 && w <= 52) return w >= 51 ? 1.9 : 1.4;
  if (w === 6 || w === 7) return 1.7;
  if (w >= 13 && w <= 15) return 1.4;
  if (w === 1) return 0.7;
  return 1;
}

export const SEASON_MEAN = Array.from({ length: 52 }, (_, i) => seasonIndex(i + 1)).reduce((a, b) => a + b, 0) / 52;

/** Multiplier on candystore's average week for a calendar week. */
export function seasonFactor(week: number): number {
  return seasonIndex(week) / SEASON_MEAN;
}

/**
 * Calendar week (1–52) of day `d` of a horizon that starts on the Monday of
 * `startWeek`. Negative days count back into earlier weeks, for warm-up.
 */
export function calendarWeekOfDay(startWeek: number, d: number): number {
  return ((((startWeek - 1 + Math.floor(d / 7)) % 52) + 52) % 52) + 1;
}
