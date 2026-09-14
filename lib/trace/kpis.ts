/**
 * The running KPI reducer (design C). Events accrue at the engine's own
 * points: paid hours at clock-in, busy hours at job start, overtime at
 * clock-out, shipped inners and dollars at face consumption (pick and re-pick),
 * cuts at release, trucks at load; finalize adds the orders still open at the
 * horizon as late trucks, the way runOperations does. projectKpis turns the
 * state into the tools' Kpis so a HUD at horizonEnd shows kpis(result)
 * exactly (tested).
 *
 * The context is immutable after kpiContext(): a checkpoint plus a replay of
 * the events since gives the same state as a replay from init.
 */

import { weekdayOf } from "../twin/demand";
import type { Kpis } from "../twin/replicate";
import { hhmm, shiftPaidHours } from "../twin/standards";
import { PROCESSES, type Process } from "../twin/types";
import { mean, quantile } from "../util/random";
import type { RunningKpis, SkuInfo, TraceEvent, TraceInit, WorkerInfo } from "./types";

export interface KpiContext {
  init: TraceInit;
  retail: Map<string, number>;
  workers: Map<string, WorkerInfo>;
  /** Job id → process, from jobQueued. */
  jobProcess: Map<number, Process>;
  /** Replenishment job ids that were hot. */
  hotJobs: Set<number>;
  /** Orders released with inners > 0 (they count as open until loaded or cut). */
  releasedWithInners: Set<string>;
  /** Orders still open at the end of the stream, with their departure minute. */
  openAtEnd: Array<{ order: string; departAt: number }>;
}

/** One pass over the whole stream: the static facts the reducer needs at any point. */
export function kpiContext(init: TraceInit, events: readonly TraceEvent[], skus: readonly SkuInfo[]): KpiContext {
  const retail = new Map(skus.map((s) => [s.id, s.innerRetail]));
  const workers = new Map(init.workers.map((w) => [w.id, w]));
  const jobProcess = new Map<number, Process>();
  const hotJobs = new Set<number>();
  const releasedWithInners = new Set<string>();
  const open = new Map<string, number>();
  for (const e of events) {
    if (e.k === "jobQueued") {
      jobProcess.set(e.job, e.process);
      if (e.info.kind === "replen" && e.info.hot) hotJobs.add(e.job);
    } else if (e.k === "orderRelease") {
      if (e.inners > 0) {
        releasedWithInners.add(e.order);
        open.set(e.order, e.departAt);
      }
    } else if (e.k === "truckLoaded" || e.k === "orderCut") {
      open.delete(e.order);
    }
  }
  return { init, retail, workers, jobProcess, hotJobs, releasedWithInners, openAtEnd: [...open].map(([order, departAt]) => ({ order, departAt })) };
}

export function createState(init: TraceInit): RunningKpis {
  void init;
  return {
    ordersReleased: 0,
    openOrders: 0,
    lines: 0,
    innersOrdered: 0,
    innersPicked: 0,
    shippedDollars: 0,
    cutInners: 0,
    cutDollars: 0,
    trucksLoaded: 0,
    trucksLate: 0,
    lateMinTotal: 0,
    worstLateMin: 0,
    innersLoaded: 0,
    outboundPallets: 0,
    cycleMinSum: 0,
    cycleCount: 0,
    inboundTrucks: 0,
    inboundPallets: 0,
    palletsInFlight: 0,
    dockToStockN: 0,
    doorWaitN: 0,
    replenishments: 0,
    hotReplenishments: 0,
    shortAtFace: 0,
    paidHours: 0,
    overtimeHours: 0,
    busyHours: 0,
    absences: 0,
    regularCost: 0,
    overtimeCost: 0,
    presentWorkers: 0,
    busyWorkers: 0,
    forkliftsBusy: 0,
    jacksBusy: 0,
    inDoorsBusy: 0,
    outDoorsBusy: 0,
    forkliftBusyMin: 0,
    lastT: 0,
    queues: PROCESSES.map(() => 0),
  };
}

export function cloneState(s: RunningKpis): RunningKpis {
  return { ...s, queues: [...s.queues] };
}

function accrue(s: RunningKpis, t: number): void {
  if (t > s.lastT) {
    s.forkliftBusyMin += s.forkliftsBusy * (t - s.lastT);
    s.lastT = t;
  }
}

const FORKLIFT: ReadonlySet<Process> = new Set<Process>(["putaway", "replenish"]);
const JACK: ReadonlySet<Process> = new Set<Process>(["unload", "load"]);

export function applyEvent(s: RunningKpis, e: TraceEvent, ctx: KpiContext): void {
  accrue(s, e.t);
  switch (e.k) {
    case "truckArrive":
      s.inboundTrucks++;
      s.inboundPallets += e.pallets.length;
      s.palletsInFlight += e.pallets.length;
      break;
    case "truckDock":
      s.doorWaitN++;
      s.inDoorsBusy++;
      break;
    case "truckUndock":
      s.inDoorsBusy--;
      break;
    case "jobQueued":
      s.queues[PROCESSES.indexOf(e.process)]++;
      break;
    case "jobStart": {
      const p = ctx.jobProcess.get(e.job);
      if (p) s.queues[PROCESSES.indexOf(p)]--;
      s.busyHours += e.dur / 60;
      s.busyWorkers++;
      if (p && FORKLIFT.has(p)) s.forkliftsBusy++;
      if (p && JACK.has(p)) s.jacksBusy++;
      if (e.outDoorAcquired) s.outDoorsBusy++;
      break;
    }
    case "jobEnd": {
      const p = ctx.jobProcess.get(e.job);
      s.busyWorkers--;
      if (p && FORKLIFT.has(p)) s.forkliftsBusy--;
      if (p && JACK.has(p)) s.jacksBusy--;
      break;
    }
    case "putaway":
      s.dockToStockN++;
      s.palletsInFlight--;
      break;
    case "face":
      if (e.reason === "pick" || e.reason === "repick") {
        const took = -e.delta;
        s.innersPicked += took;
        s.shippedDollars += took * (ctx.retail.get(e.sku) ?? 0);
      } else if (e.reason === "replen") {
        s.replenishments++;
        if (ctx.hotJobs.has(e.job)) s.hotReplenishments++;
      }
      break;
    case "short":
      s.shortAtFace++;
      break;
    case "orderRelease": {
      s.ordersReleased++;
      s.lines += e.lines.length;
      for (const l of e.lines) {
        s.innersOrdered += l.inners + l.cut;
        if (l.cut > 0) {
          s.cutInners += l.cut;
          s.cutDollars += l.cut * (ctx.retail.get(l.sku) ?? 0);
        }
      }
      if (e.inners > 0) s.openOrders++;
      break;
    }
    case "orderCut":
      if (ctx.releasedWithInners.has(e.order)) s.openOrders--;
      break;
    case "truckLoaded":
      s.trucksLoaded++;
      s.innersLoaded += e.inners;
      s.outboundPallets += e.pallets;
      s.cycleMinSum += e.cycleFloorMin;
      s.cycleCount++;
      s.openOrders--;
      if (e.lateMin > 0) {
        s.trucksLate++;
        s.lateMinTotal += e.lateMin;
        s.worstLateMin = Math.max(s.worstLateMin, e.lateMin);
      }
      break;
    case "truckDepart":
      s.outDoorsBusy--;
      break;
    case "worker": {
      const w = ctx.workers.get(e.id);
      const rate = w?.hourlyRate ?? 0;
      if (e.state === "in") {
        const paid = ((e.shiftEnd ?? 0) - (e.shiftStart ?? 0) - (e.breakMin ?? 0)) / 60;
        s.paidHours += paid;
        s.regularCost += paid * rate;
        s.presentWorkers++;
      } else if (e.state === "absent") {
        s.absences++;
      } else if (e.state === "out") {
        const ot = (e.overtimeMin ?? 0) / 60;
        s.overtimeHours += ot;
        s.overtimeCost += ot * rate * (w?.overtimeMultiplier ?? 1);
        s.presentWorkers--;
      }
      break;
    }
    default:
      break;
  }
}

/** Close the books at the horizon: forklift minutes to the end, open orders as late trucks (runOperations L911-918). */
export function finalize(s: RunningKpis, horizonEnd: number, ctx: KpiContext): void {
  accrue(s, horizonEnd);
  for (const o of ctx.openAtEnd) {
    const lateMin = Math.max(0, horizonEnd - o.departAt);
    if (lateMin > 0) {
      s.trucksLate++;
      s.lateMinTotal += lateMin;
      s.worstLateMin = Math.max(s.worstLateMin, lateMin);
    }
  }
}

/** Operating minutes the engine divides forklift busy minutes by: open days × the span from the first shift start to the last shift end. */
export function operatingMinutes(init: TraceInit, t: number, full: boolean): number {
  const firstStart = Math.min(...init.shifts.map((s) => hhmm(s.start)));
  const lastEnd = Math.max(...init.shifts.map((s) => hhmm(s.start) + shiftPaidHours(s.start, s.end) * 60));
  const span = lastEnd - firstStart;
  let total = 0;
  for (let d = 0; d < init.days; d++) {
    if (!init.operatingDays.includes(weekdayOf(d))) continue;
    total += full ? span : Math.max(0, Math.min(span, t - (d * 1440 + firstStart)));
  }
  return Math.max(1, total);
}

export interface KpiSamples {
  dockToStock: ArrayLike<number>;
  doorWaits: ArrayLike<number>;
  cycleMin: ArrayLike<number>;
}

function head(a: ArrayLike<number>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(n, a.length); i++) out.push(a[i]);
  return out;
}

/** The tools' Kpis at minute t. `final` means the state was finalized at horizonEnd (open orders counted as trucks, full operating minutes). */
export function projectKpis(s: RunningKpis, t: number, init: TraceInit, samples: KpiSamples, final: boolean): Kpis {
  const trucks = s.trucksLoaded + (final ? s.openOrders : 0);
  const paid = s.paidHours + s.overtimeHours;
  const laborCost = s.regularCost + s.overtimeCost;
  const dts = head(samples.dockToStock, s.dockToStockN);
  const forkliftMin = s.forkliftBusyMin + s.forkliftsBusy * Math.max(0, t - s.lastT);
  return {
    trucks,
    lateTrucks: s.trucksLate,
    onTimeRate: trucks ? (trucks - s.trucksLate) / trucks : 1,
    lateMinTotal: s.lateMinTotal,
    worstLateMin: s.worstLateMin,
    notLoaded: s.openOrders,
    fillRate: s.innersOrdered ? s.innersPicked / s.innersOrdered : 1,
    innersShipped: s.innersPicked,
    shippedDollars: s.shippedDollars,
    cutDollars: s.cutDollars,
    lines: s.lines,
    paidHours: paid,
    overtimeHours: s.overtimeHours,
    busyHours: s.busyHours,
    utilization: paid ? s.busyHours / paid : 0,
    laborCost,
    costPerThousand: s.shippedDollars ? (laborCost / s.shippedDollars) * 1000 : 0,
    innersPerPaidHour: paid ? s.innersPicked / paid : 0,
    dockToStockAvgMin: mean(dts),
    dockToStockP90Min: quantile(dts, 0.9),
    orderCycleAvgMin: s.cycleCount ? s.cycleMinSum / s.cycleCount : 0,
    replenishments: s.replenishments,
    hotReplenishments: s.hotReplenishments,
    forkliftUtilization: forkliftMin / (operatingMinutes(init, t, final) * Math.max(1, init.forklifts)),
    absences: s.absences,
    palletsNotPutAway: s.palletsInFlight,
    inboundPallets: s.inboundPallets,
  };
}
