import { z, ZodError } from "zod";
import { UnknownIdError } from "../data/load";
import { ImportError } from "../layout/assemble";
import { LimitError } from "../layout/limits";
import type { Kpis } from "../twin/replicate";
import { describeDisruptions, type TwinContext, type TwinScenario } from "../twin/twin";
import { WEEKDAYS } from "../twin/standards";

export const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Tools that accept a candystore scenario may call its live API. */
export const readOnlyOpenWorld = { ...readOnly, openWorldHint: true };

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function error(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

/**
 * Run a handler and turn the failures a caller can fix (an unknown id, an
 * argument out of range, candystore rejecting a scenario) into an isError
 * result with the reason, rather than a protocol error.
 */
export async function guarded(fn: () => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnknownIdError || err instanceof LimitError || err instanceof ImportError) return error(err.message);
    if (err instanceof ZodError) return error(`Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (err instanceof Error && /candystore|fetch|abort|timeout/i.test(`${err.name} ${err.message}`)) return error(`Could not get the candystore scenario: ${err.message}`);
    throw err;
  }
}

export function money(d: number): string {
  const abs = Math.abs(d);
  if (abs >= 1e6) return `$${(d / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `$${Math.round(d / 1e3)}k`;
  if (abs >= 1e3) return `$${(d / 1e3).toFixed(1)}k`;
  return `$${Math.round(d)}`;
}

export function fmtInt(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}

export function fmt1(x: number): string {
  return (Math.round(x * 10) / 10).toLocaleString("en-US");
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(Math.abs(x) < 0.1 && x !== 0 ? 1 : 0)}%`;
}

export function hours(min: number): string {
  if (min < 90) return `${Math.round(min)} min`;
  return `${fmt1(min / 60)} h`;
}

export function signed(x: number, f: (v: number) => string): string {
  if (Math.abs(x) < 1e-9) return "±0";
  return `${x > 0 ? "+" : "−"}${f(Math.abs(x))}`;
}

export function dayLabel(day: number): string {
  return `day ${day} (${WEEKDAYS[((day % 7) + 7) % 7]})`;
}

export function scenarioLine(ctx: TwinContext): string {
  const parts = [...ctx.changes, ...describeDisruptions(ctx.scenario)];
  return parts.length ? `Scenario: ${parts.join("; ")}.` : "Scenario: baseline.";
}

export function dcName(ctx: TwinContext): string {
  return `${ctx.network.dcs.find((d) => d.id === ctx.site.id)?.name ?? ctx.site.id} (${ctx.site.id})`;
}

/** A markdown table of KPIs, one column per labelled set. */
export function kpiTable(columns: Array<[string, Kpis]>, delta = false): string {
  const rows: Array<[string, (k: Kpis) => number, (v: number) => string]> = [
    ["Store trucks", (k) => k.trucks, fmt1],
    ["Late trucks", (k) => k.lateTrucks, fmt1],
    ["On-time rate", (k) => k.onTimeRate, pct],
    ["Worst lateness", (k) => k.worstLateMin, hours],
    ["Fill rate (inners)", (k) => k.fillRate, (v) => `${(v * 100).toFixed(1)}%`],
    ["Retail $ shipped", (k) => k.shippedDollars, money],
    ["Retail $ cut (no stock)", (k) => k.cutDollars, money],
    ["Paid labor hours", (k) => k.paidHours, fmt1],
    ["Overtime hours", (k) => k.overtimeHours, fmt1],
    ["Labor utilization", (k) => k.utilization, pct],
    ["Labor cost", (k) => k.laborCost, money],
    ["Labor $ per $1k shipped", (k) => k.costPerThousand, (v) => `$${v.toFixed(2)}`],
    ["Inners per paid hour", (k) => k.innersPerPaidHour, fmt1],
    ["Order cycle (floor time)", (k) => k.orderCycleAvgMin, hours],
    ["Dock-to-stock avg", (k) => k.dockToStockAvgMin, hours],
    ["Replenishments (hot)", (k) => k.replenishments, fmt1],
    ["Forklift utilization", (k) => k.forkliftUtilization, pct],
    ["Absences", (k) => k.absences, fmt1],
  ];
  const head = `| KPI | ${columns.map((c) => c[0]).join(" | ")} |${delta && columns.length === 2 ? " change |" : ""}`;
  const sep = `|---|${columns.map(() => "---:").join("|")}|${delta && columns.length === 2 ? "---:|" : ""}`;
  const body = rows.map(([label, get, f]) => {
    const cells = columns.map((c) => (label === "Replenishments (hot)" ? `${fmt1(c[1].replenishments)} (${fmt1(c[1].hotReplenishments)})` : f(get(c[1]))));
    let d = "";
    if (delta && columns.length === 2) d = ` ${signed(get(columns[1][1]) - get(columns[0][1]), f)} |`;
    return `| ${label} | ${cells.join(" | ")} |${d}`;
  });
  return [head, sep, ...body].join("\n");
}

export const daysSchema = z.number().int().min(1).max(56).describe("Days to simulate from the Monday of startWeek.");
export const runsSchema = z.number().int().min(1).max(20).describe("Replications with different random draws; the table reports the mean.");

export type ScenarioArgs = TwinScenario;
export { z };
