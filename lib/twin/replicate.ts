/**
 * Replications: one operations run is one draw of orders, arrivals and
 * absences. Tools run several with consecutive seeds and report the mean,
 * with the worst run beside it where the tail is the point (late trucks).
 */

import { mean, quantile } from "../util/random";
import { runOperations, type OperationsResult } from "./operations";
import { operationsOptions, type TwinContext } from "./twin";

export interface Kpis {
  trucks: number;
  lateTrucks: number;
  onTimeRate: number;
  lateMinTotal: number;
  worstLateMin: number;
  notLoaded: number;
  fillRate: number;
  innersShipped: number;
  shippedDollars: number;
  cutDollars: number;
  lines: number;
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  utilization: number;
  laborCost: number;
  costPerThousand: number;
  innersPerPaidHour: number;
  dockToStockAvgMin: number;
  dockToStockP90Min: number;
  orderCycleAvgMin: number;
  replenishments: number;
  hotReplenishments: number;
  forkliftUtilization: number;
  absences: number;
  palletsNotPutAway: number;
  inboundPallets: number;
}

export const KPI_KEYS = [
  "trucks", "lateTrucks", "onTimeRate", "lateMinTotal", "worstLateMin", "notLoaded", "fillRate", "innersShipped", "shippedDollars", "cutDollars", "lines",
  "paidHours", "overtimeHours", "busyHours", "utilization", "laborCost", "costPerThousand", "innersPerPaidHour", "dockToStockAvgMin", "dockToStockP90Min",
  "orderCycleAvgMin", "replenishments", "hotReplenishments", "forkliftUtilization", "absences", "palletsNotPutAway", "inboundPallets",
] as const satisfies ReadonlyArray<keyof Kpis>;

export function kpis(r: OperationsResult): Kpis {
  return {
    trucks: r.service.trucks,
    lateTrucks: r.service.late,
    onTimeRate: r.service.trucks ? r.service.onTime / r.service.trucks : 1,
    lateMinTotal: r.service.lateMinTotal,
    worstLateMin: r.service.worstLateMin,
    notLoaded: r.service.notLoaded,
    fillRate: r.service.fillRate,
    innersShipped: r.volume.innersShipped,
    shippedDollars: r.volume.shippedDollars,
    cutDollars: r.volume.cutDollars,
    lines: r.volume.lines,
    paidHours: r.labor.paidHours,
    overtimeHours: r.labor.overtimeHours,
    busyHours: r.labor.busyHours,
    utilization: r.labor.utilization,
    laborCost: r.labor.regularCost + r.labor.overtimeCost,
    costPerThousand: r.labor.costPerThousandShipped,
    innersPerPaidHour: r.labor.innersPerPaidHour,
    dockToStockAvgMin: r.inbound.dockToStockAvgMin,
    dockToStockP90Min: r.inbound.dockToStockP90Min,
    orderCycleAvgMin: r.service.orderCycleAvgMin,
    replenishments: r.pickFace.replenishments,
    hotReplenishments: r.pickFace.hotReplenishments,
    forkliftUtilization: r.resources.forklifts.utilization,
    absences: r.labor.absences,
    palletsNotPutAway: r.inbound.palletsNotPutAway,
    inboundPallets: r.volume.inboundPallets,
  };
}

export interface Replications {
  runs: OperationsResult[];
  mean: Kpis;
  p90: Kpis;
  worst: Kpis;
  /** Process with the most total waiting across runs, and how its constraint was classified most often. */
  bottleneck: OperationsResult["bottleneck"];
}

function aggregate(list: Kpis[], f: (xs: number[]) => number): Kpis {
  return Object.fromEntries(KPI_KEYS.map((k) => [k, f(list.map((x) => x[k]))])) as unknown as Kpis;
}

export function replicate(ctx: TwinContext, days: number, runs: number, seed = 1): Replications {
  const results: OperationsResult[] = [];
  for (let i = 0; i < runs; i++) results.push(runOperations(ctx, operationsOptions(ctx, days, seed + i)));
  const list = results.map(kpis);
  // "Worst" is per metric in the direction that hurts.
  const higherIsWorse = new Set<keyof Kpis>(["lateTrucks", "lateMinTotal", "worstLateMin", "notLoaded", "cutDollars", "overtimeHours", "laborCost", "costPerThousand", "dockToStockAvgMin", "dockToStockP90Min", "orderCycleAvgMin", "hotReplenishments", "absences", "palletsNotPutAway"]);
  const worst = Object.fromEntries(
    KPI_KEYS.map((k) => {
      const xs = list.map((x) => x[k]);
      return [k, higherIsWorse.has(k) ? Math.max(...xs) : Math.min(...xs)];
    })
  ) as unknown as Kpis;

  const waits = new Map<string, { hours: number; constraints: Map<string, number> }>();
  for (const r of results) {
    if (!r.bottleneck.process) continue;
    const w = waits.get(r.bottleneck.process) ?? { hours: 0, constraints: new Map() };
    w.hours += r.bottleneck.waitHours;
    w.constraints.set(r.bottleneck.constraint, (w.constraints.get(r.bottleneck.constraint) ?? 0) + 1);
    waits.set(r.bottleneck.process, w);
  }
  let bottleneck: OperationsResult["bottleneck"] = results[0].bottleneck.process ? results[0].bottleneck : { process: null, constraint: results[0].bottleneck.constraint, waitHours: 0 };
  let best = -1;
  for (const [p, w] of waits) {
    if (w.hours > best) {
      best = w.hours;
      const constraint = [...w.constraints].sort((a, b) => b[1] - a[1])[0][0];
      bottleneck = { process: p as OperationsResult["bottleneck"]["process"], constraint, waitHours: w.hours / runs };
    }
  }
  return { runs: results, mean: aggregate(list, mean), p90: aggregate(list, (xs) => quantile(xs, 0.9)), worst, bottleneck };
}
