/**
 * Formatting for the /twin page: the engine's minutes-from-day-0 clock as
 * "Day 3 · Wed 07:15", durations, money, percentages, and the KPI table the
 * HUD and the compare panel share (label, formatter, and whether a higher
 * value is worse, mirroring replicate.ts's `higherIsWorse` set so deltas are
 * coloured the way the tools rank runs). Pure; no DOM.
 */

import type { Kpis } from "../twin/replicate";
import { clock, WEEKDAYS } from "../twin/standards";

/** Playback speeds: simulated minutes per real minute (60× = one simulated minute per second). */
export const SPEEDS = [1, 10, 60, 300, 1800] as const;

export function dayOf(t: number): number {
  return Math.floor(t / 1440);
}

/** Day 0 is the Monday of startWeek, so the weekday is the day index mod 7. */
export function weekdayName(t: number): string {
  return WEEKDAYS[((dayOf(t) % 7) + 7) % 7];
}

export function clockOf(t: number): string {
  return clock(t);
}

export function dayClock(t: number): string {
  return `Day ${dayOf(t) + 1} · ${weekdayName(t)} ${clock(t)}`;
}

/** Minutes as a short duration: "45 min", "1 h 20 min", "2 d 3 h". */
export function minutes(m: number): string {
  const v = Math.max(0, Math.round(m));
  if (v < 60) return `${v} min`;
  const h = Math.floor(v / 60);
  const rest = v % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

export function speedLabel(speed: number): string {
  return `${speed}×`;
}

export function num(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function money(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function pct(f: number, digits = 0): string {
  if (!Number.isFinite(f)) return "–";
  return `${(f * 100).toFixed(digits)}%`;
}

export function feet(ft: number): string {
  return `${Math.round(ft)} ft`;
}

export interface KpiMeta {
  key: keyof Kpis;
  label: string;
  fmt: (v: number) => string;
  /** replicate.ts ranks the worst run by these: a rise is bad. */
  higherIsWorse: boolean;
}

/** replicate.ts's set, restated so a delta's colour matches how the tools pick the worst run. */
export const HIGHER_IS_WORSE: ReadonlySet<keyof Kpis> = new Set<keyof Kpis>([
  "lateTrucks",
  "lateMinTotal",
  "worstLateMin",
  "notLoaded",
  "cutDollars",
  "overtimeHours",
  "laborCost",
  "costPerThousand",
  "dockToStockAvgMin",
  "dockToStockP90Min",
  "orderCycleAvgMin",
  "hotReplenishments",
  "absences",
  "palletsNotPutAway",
]);

const meta = (key: keyof Kpis, label: string, fmt: (v: number) => string): KpiMeta => ({ key, label, fmt, higherIsWorse: HIGHER_IS_WORSE.has(key) });

/** Every tools' KPI in display order. */
export const KPI_META: readonly KpiMeta[] = [
  meta("trucks", "Store trucks", (v) => num(v)),
  meta("lateTrucks", "Late trucks", (v) => num(v)),
  meta("onTimeRate", "On time", (v) => pct(v)),
  meta("lateMinTotal", "Late minutes", (v) => num(v)),
  meta("worstLateMin", "Worst late", (v) => minutes(v)),
  meta("notLoaded", "Not loaded", (v) => num(v)),
  meta("fillRate", "Fill rate", (v) => pct(v, 1)),
  meta("innersShipped", "Inners picked", (v) => num(v)),
  meta("shippedDollars", "Shipped", money),
  meta("cutDollars", "Cut", money),
  meta("lines", "Lines", (v) => num(v)),
  meta("paidHours", "Paid hours", (v) => num(v, 1)),
  meta("overtimeHours", "Overtime hours", (v) => num(v, 1)),
  meta("busyHours", "Busy hours", (v) => num(v, 1)),
  meta("utilization", "Utilization", (v) => pct(v)),
  meta("laborCost", "Labor cost", money),
  meta("costPerThousand", "Cost per $1k", (v) => `$${v.toFixed(2)}`),
  meta("innersPerPaidHour", "Inners / paid hour", (v) => num(v, 1)),
  meta("dockToStockAvgMin", "Dock to stock", (v) => minutes(v)),
  meta("dockToStockP90Min", "Dock to stock p90", (v) => minutes(v)),
  meta("orderCycleAvgMin", "Order cycle", (v) => minutes(v)),
  meta("replenishments", "Replenishments", (v) => num(v)),
  meta("hotReplenishments", "Hot replenishments", (v) => num(v)),
  meta("forkliftUtilization", "Forklift utilization", (v) => pct(v)),
  meta("absences", "Absences", (v) => num(v)),
  meta("palletsNotPutAway", "Pallets not put away", (v) => num(v)),
  meta("inboundPallets", "Inbound pallets", (v) => num(v)),
];

export const KPI_BY_KEY: ReadonlyMap<keyof Kpis, KpiMeta> = new Map(KPI_META.map((m) => [m.key, m]));

/** Signed delta text, with the metric's own formatter. */
export function deltaText(key: keyof Kpis, a: number, b: number): string {
  const m = KPI_BY_KEY.get(key);
  const d = b - a;
  if (!m || Math.abs(d) < 1e-9) return "±0";
  const sign = d > 0 ? "+" : "−";
  return `${sign}${m.fmt(Math.abs(d))}`;
}

/** "good" when the run improved, "bad" when it got worse, "" when unchanged. */
export function deltaClass(key: keyof Kpis, a: number, b: number): "good" | "bad" | "" {
  const d = b - a;
  if (Math.abs(d) < 1e-9) return "";
  const worse = HIGHER_IS_WORSE.has(key) ? d > 0 : d < 0;
  return worse ? "bad" : "good";
}

export function weekdayList(days: readonly number[]): string {
  return days.map((d) => WEEKDAYS[d - 1] ?? String(d)).join(", ");
}
