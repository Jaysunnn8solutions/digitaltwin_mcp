/**
 * Scenario report: how a run performed, day by day, where the work queued,
 * what it cost, and what to change. Pure: built from what the worker posted
 * (the engine's result and KPIs, the playback's hourly checkpoints and queue
 * bins, the world payload) and formatted as Markdown, CSV or JSON so the page
 * can hand it out as a file. The numbers are the engine's own accounting, the
 * same ones the MCP tools report; the day-by-day labor cost comes from the
 * checkpoint at each midnight, which the compiler reduces from the same
 * events (paid at clock-in, overtime at clock-out).
 *
 * The recommendations are rules over those numbers, phrased as the scenario
 * field to change and the tab it lives on. They are heuristics, not an
 * optimizer: each names the evidence it fired on so the reader can judge it.
 */

import type { Checkpoint, Playback, RunSpec, WorldPayload } from "../trace/types";
import type { OperationsResult, TruckRecord } from "../twin/operations";
import type { Kpis } from "../twin/replicate";
import { WEEKDAYS } from "../twin/standards";
import { PROCESS_SKILL, PROCESSES, type Process } from "../twin/types";
import { deltaText, HIGHER_IS_WORSE, KPI_META, minutes, money, num, pct } from "./format";

export interface ReportRun {
  label: string;
  building: string;
  spec: RunSpec;
  world: WorldPayload;
  result: OperationsResult;
  kpis: Kpis;
  playback: Playback;
}

export interface ReportDay {
  /** 0 = the Monday of the start week. */
  day: number;
  weekday: string;
  calendarWeek: number;
  orders: number;
  lines: number;
  innersShipped: number;
  cutInners: number;
  /** Shipped ÷ (shipped + cut) for that day's orders; null on a day with no orders. */
  fillRate: number | null;
  shippedDollars: number;
  inboundTrucks: number;
  inboundPallets: number;
  /** Store trucks loaded that day. */
  trucks: number;
  trucksLate: number;
  lateMin: number;
  /** Regular paid hours that day (the engine's paid-hours KPI adds overtime to this). */
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  /** Busy ÷ (paid + overtime); null when nobody was paid. */
  utilization: number | null;
  laborCost: number;
  hotReplenishments: number;
  shortAtFace: number;
  absences: number;
  /** Peak queue length per process during the day. */
  peakQueue: Record<Process, number>;
  /** The process that queued the most job-minutes that day, or null when nothing waited. */
  bottleneck: { process: Process; peak: number; queueMinutes: number } | null;
}

export interface ReportProcess {
  process: Process;
  skill: string;
  jobs: number;
  busyHours: number;
  avgWaitMin: number;
  maxWaitMin: number;
  maxQueue: number;
  /** Share of the waiting spent with a worker free but equipment or a door taken. */
  equipmentShare: number;
}

export interface ReportWorker {
  id: string;
  role: string;
  type: string;
  shiftsWorked: number;
  absences: number;
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  utilization: number | null;
  /** Where the time went, e.g. "pick 24.1h, pack 3.2h". */
  top: string;
}

export interface ReportResource {
  name: string;
  count: number;
  utilization: number;
}

export type ReportArea = "Labor" | "Supply" | "Deliveries" | "Space" | "Disruptions";

export interface Recommendation {
  severity: "high" | "medium" | "low";
  area: ReportArea;
  /** What the numbers show. */
  finding: string;
  /** What to change, naming the tab and field. */
  action: string;
}

export interface ReportSummaryRow {
  key: keyof Kpis;
  label: string;
  value: string;
}

export interface Report {
  title: string;
  run: { label: string; building: string; dc: string; startWeek: number; days: number; seed: number; changes: string[] };
  kpis: Kpis;
  summary: ReportSummaryRow[];
  days: ReportDay[];
  bottleneck: OperationsResult["bottleneck"];
  processes: ReportProcess[];
  resources: ReportResource[];
  reserve: { positions: number; needed: number };
  workers: ReportWorker[];
  lateTrucks: TruckRecord[];
  recommendations: Recommendation[];
  /** The previous run, when the page had one, with every KPI's delta from it to this run. */
  previous: { label: string; kpis: Kpis; deltas: Array<{ key: keyof Kpis; label: string; a: string; b: string; delta: string; better: boolean | null }> } | null;
}

const DAY_MIN = 1440;

/** The last checkpoint at or before t (checkpoints are sorted by t). */
function checkpointAt(cps: readonly Checkpoint[], t: number): Checkpoint | null {
  let lo = 0;
  let hi = cps.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cps[mid].t <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? cps[best] : null;
}

function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

function buildDays(run: ReportRun): ReportDay[] {
  const { result, playback } = run;
  const cps = playback.checkpoints;
  const P = PROCESSES.length;
  const bins = playback.queueBins;
  const loadedByDay = new Map<number, number>();
  for (const t of result.trucks) if (t.loadedAt !== null) loadedByDay.set(t.day, (loadedByDay.get(t.day) ?? 0) + 1);

  return result.daily.map((d) => {
    const start = checkpointAt(cps, d.day * DAY_MIN);
    const end = checkpointAt(cps, Math.min((d.day + 1) * DAY_MIN, playback.meta.horizonEnd));
    const delta = (pick: (c: Checkpoint) => number) => (start && end ? pick(end) - pick(start) : 0);
    const paidHours = delta((c) => c.kpis.paidHours);
    const overtimeHours = delta((c) => c.kpis.overtimeHours);
    const busyHours = delta((c) => c.kpis.busyHours);
    const laborCost = delta((c) => c.kpis.regularCost + c.kpis.overtimeCost);

    const peak = Object.fromEntries(PROCESSES.map((p) => [p, 0])) as Record<Process, number>;
    const sum = Object.fromEntries(PROCESSES.map((p) => [p, 0])) as Record<Process, number>;
    if (bins.binMin > 0) {
      const from = Math.floor((d.day * DAY_MIN) / bins.binMin);
      const to = Math.min(bins.count, Math.floor(((d.day + 1) * DAY_MIN) / bins.binMin));
      for (let b = from; b < to; b++) {
        for (let p = 0; p < P; p++) {
          const q = bins.queues[b * P + p];
          const proc = PROCESSES[p];
          if (q > peak[proc]) peak[proc] = q;
          sum[proc] += q * bins.binMin;
        }
      }
    }
    let bottleneck: ReportDay["bottleneck"] = null;
    for (const p of PROCESSES) {
      if (sum[p] > 0 && (!bottleneck || sum[p] > bottleneck.queueMinutes)) bottleneck = { process: p, peak: peak[p], queueMinutes: sum[p] };
    }

    return {
      day: d.day,
      weekday: WEEKDAYS[d.weekday - 1] ?? String(d.weekday),
      calendarWeek: d.calendarWeek,
      orders: d.orders,
      lines: d.lines,
      innersShipped: d.innersShipped,
      cutInners: d.cutInners,
      fillRate: d.orders > 0 ? ratio(d.innersShipped, d.innersShipped + d.cutInners) : null,
      shippedDollars: delta((c) => c.kpis.shippedDollars),
      inboundTrucks: d.inboundTrucks,
      inboundPallets: d.inboundPallets,
      trucks: loadedByDay.get(d.day) ?? 0,
      trucksLate: d.trucksLate,
      lateMin: d.lateMin,
      paidHours,
      overtimeHours,
      busyHours,
      utilization: ratio(busyHours, paidHours + overtimeHours),
      laborCost,
      hotReplenishments: delta((c) => c.kpis.hotReplenishments),
      shortAtFace: delta((c) => c.kpis.shortAtFace),
      absences: d.absences,
      peakQueue: peak,
      bottleneck,
    };
  });
}

function buildProcesses(result: OperationsResult): ReportProcess[] {
  return PROCESSES.map((p) => {
    const s = result.processes[p];
    return {
      process: p,
      skill: PROCESS_SKILL[p],
      jobs: s.jobs,
      busyHours: s.busyMin / 60,
      avgWaitMin: s.jobs > 0 ? s.waitTotalMin / s.jobs : 0,
      maxWaitMin: s.waitMaxMin,
      maxQueue: s.maxQueue,
      equipmentShare: s.waitTotalMin > 0 ? s.equipmentWaitMin / s.waitTotalMin : 0,
    };
  });
}

function buildWorkers(result: OperationsResult): ReportWorker[] {
  return result.workers.map((w) => ({
    id: w.id,
    role: w.role,
    type: w.type,
    shiftsWorked: w.shiftsWorked,
    absences: w.absences,
    paidHours: w.paidHours,
    overtimeHours: w.overtimeHours,
    busyHours: w.busyHours,
    utilization: ratio(w.busyHours, w.paidHours + w.overtimeHours),
    top: Object.entries(w.byProcess)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, m]) => `${p} ${num(m / 60, 1)}h`)
      .join(", "),
  }));
}

const roleFor: Record<Process, string> = {
  unload: "receiver",
  receive: "receiver",
  putaway: "forklift operator",
  replenish: "forklift operator",
  pick: "order selector",
  pack: "packer",
  load: "loader",
};

/**
 * Rules over the run's numbers. Each names its evidence and the scenario
 * field to try, on the tab where it lives, so the reader can act on it in the
 * panel and compare the runs.
 */
export function recommend(run: ReportRun, days: ReportDay[], processes: ReportProcess[]): Recommendation[] {
  const { result, kpis: k } = run;
  const out: Recommendation[] = [];
  const b = result.bottleneck;
  const late = k.lateTrucks + k.notLoaded;
  const forklifts = result.resources.forklifts;
  const inDoors = result.resources.inboundDoors;
  const outDoors = result.resources.outboundDoors;
  const worstDay = [...days].sort((x, y) => y.lateMin - x.lateMin)[0];

  if (late > 0) {
    const where = b.process ? `the ${b.process} queue was the bottleneck (${num(b.waitHours, 1)} job-hours of floor-time waiting; ${b.constraint})` : b.constraint;
    const finding = `${late} of ${k.trucks + k.notLoaded} store trucks missed their departure (${minutes(k.lateMinTotal)} late in total, worst ${minutes(k.worstLateMin)}${worstDay && worstDay.lateMin > 0 ? `, mostly ${worstDay.weekday} of week ${worstDay.calendarWeek}` : ""}); ${where}.`;
    let action: string;
    const constraint = b.constraint.toLowerCase();
    if (constraint.includes("door")) {
      action = b.process === "load" || b.process === "pack" ? "Space › Outbound doors: add one. Or Deliveries › truck departure: leave later so loading has more of the shift." : "Space › Inbound doors: add one, or Supply › inbound window: spread the appointments.";
    } else if (constraint.includes("forklift") || constraint.includes("equipment")) {
      action = "Space › Forklifts: add one, or Labor › Cross-train: give a receiver the forklift skill so putaway and replenishment run in parallel.";
    } else if (b.process === "pick") {
      action = "Labor › Add workers: one order selector (full-time, or part-time on the heavy delivery days). Also try Space › Slotting: optimized, which cuts walking per line. If the lateness is small, Deliveries › truck departure a little later is the cheapest fix.";
    } else if (b.process === "pack" || b.process === "load") {
      action = `Labor › Add workers or Cross-train: one more ${roleFor[b.process]} for the afternoon, or let flexing cover it (Labor › Flex across skills: yes).`;
    } else if (b.process === "putaway" || b.process === "replenish") {
      action = "Space › Forklifts: add one, or Labor › Cross-train a worker on forklift. Space › Face cases higher means fewer replenishments competing with putaway.";
    } else if (b.process === "unload" || b.process === "receive") {
      action = "Labor › Add workers: a receiver, or Supply › inbound window earlier so trucks are cleared before picking peaks.";
    } else {
      action = "Labor › Add workers on the busy days, or Deliveries › truck departure later.";
    }
    out.push({ severity: "high", area: "Labor", finding, action });
  }

  if (k.cutDollars > 0 || k.fillRate < 0.995) {
    out.push({
      severity: k.cutDollars > 0.01 * k.shippedDollars ? "high" : "medium",
      area: "Supply",
      finding: `Fill rate ${pct(k.fillRate, 1)}: ${money(k.cutDollars)} of store orders were cut for lack of stock${result.pickFace.shortAtFace > 0 ? `, and picks found the face short ${result.pickFace.shortAtFace} times` : ""}.`,
      action: "Supply › Service level: raise it (0.99 holds more safety stock), or Supply › Supplier overrides: shorter lead time for the suppliers behind the cuts. Check Supply › Supplier delays and Deliveries › demand shocks if the cut is concentrated in one week.",
    });
  }

  const hotShare = ratio(k.hotReplenishments, k.replenishments);
  if ((hotShare !== null && hotShare > 0.2 && k.hotReplenishments >= 5) || result.pickFace.shortAtFace >= 5) {
    out.push({
      severity: "medium",
      area: "Space",
      finding: `${k.hotReplenishments} of ${k.replenishments} replenishments were hot (a pick found the face empty) and ${result.pickFace.shortAtFace} picks came up short; each one costs a re-pick.`,
      action: "Space › Face cases: one more master case per face, or Space › Slotting: optimized, which sizes each face to five days of demand.",
    });
  }

  if (forklifts.count > 0 && forklifts.utilization > 0.75) {
    out.push({
      severity: b.process === "putaway" || b.process === "replenish" ? "high" : "medium",
      area: "Space",
      finding: `Forklift utilization ${pct(forklifts.utilization)} across ${forklifts.count} forklift(s); ${result.inbound.palletsNotPutAway} pallet(s) were still not put away at the end, dock-to-stock p90 ${minutes(result.inbound.dockToStockP90Min)}.`,
      action: "Space › Forklifts: add one. Cheaper: Labor › Cross-train a picker or receiver on forklift so the second seat is filled when putaway peaks.",
    });
  } else if (forklifts.count > 1 && forklifts.utilization < 0.2 && late === 0) {
    out.push({ severity: "low", area: "Space", finding: `Forklift utilization is only ${pct(forklifts.utilization)} across ${forklifts.count} forklifts.`, action: "Space › Forklifts: one fewer costs nothing in service here; re-run to confirm." });
  }

  if (result.inbound.doorWaitAvgMin > 10 || inDoors.utilization > 0.6) {
    out.push({
      severity: "medium",
      area: "Supply",
      finding: `Supplier trucks waited ${minutes(result.inbound.doorWaitAvgMin)} on average for an inbound door (${inDoors.count} door(s) at ${pct(inDoors.utilization)} utilization).`,
      action: "Supply › Inbound window: widen it so appointments spread out, or Space › Inbound doors: add one.",
    });
  }
  if (outDoors.utilization > 0.6) {
    out.push({ severity: "medium", area: "Space", finding: `Outbound doors ran at ${pct(outDoors.utilization)} utilization with ${outDoors.count} door(s).`, action: "Space › Outbound doors: add one, or stagger Deliveries › delivery days so fewer trucks leave the same afternoon." });
  }

  const otShare = ratio(k.overtimeHours, k.paidHours);
  if (otShare !== null && otShare > 0.05) {
    const otCost = result.labor.overtimeCost;
    out.push({
      severity: otShare > 0.15 ? "high" : "medium",
      area: "Labor",
      finding: `${num(k.overtimeHours, 1)} overtime hours (${pct(otShare)} of paid hours, ${money(otCost)}), ${days.filter((d) => d.overtimeHours > 0).length} day(s) ran past the shift.`,
      action: late > 0 ? "Labor › Add workers: a part-timer on the days that ran late costs less than the overtime and lands the trucks. Labor › Overtime cap: raising it only helps if trucks are still late at the cap." : "Labor › Add workers: a part-timer on the heavy days replaces the overtime at straight time.",
    });
  }

  if (k.utilization < 0.55 && late === 0 && k.paidHours > 0) {
    const idle = k.paidHours - k.busyHours;
    out.push({
      severity: "low",
      area: "Labor",
      finding: `Utilization ${pct(k.utilization)}: ${num(idle, 0)} of ${num(k.paidHours, 0)} paid hours were idle with every truck on time.`,
      action: "Labor › Remove workers or Worker overrides › weekly hours: trim the slack, or Deliveries › demand ×1.2 to see how much more this crew ships before the first truck is late.",
    });
  }

  if (result.inbound.palletsNotPutAway > 0 && !(forklifts.utilization > 0.75)) {
    out.push({ severity: "medium", area: "Labor", finding: `${result.inbound.palletsNotPutAway} inbound pallet(s) were never put away, so their stock was not pickable.`, action: "Supply › Inbound window: earlier appointments, or Labor › Add workers: forklift hours late in the day." });
  }

  if (result.reserve.palletsNeededEnd > result.reserve.positions) {
    out.push({
      severity: "medium",
      area: "Space",
      finding: `Stock needs ${result.reserve.palletsNeededEnd} reserve pallet positions and the racks have ${result.reserve.positions}; the rest sits on the floor.`,
      action: "Space › Rack zones: more reserve aisles or levels (built-in buildings), or Supply › Service level lower so less safety stock is held.",
    });
  }

  const shifts = result.workers.reduce((a, w) => a + w.shiftsWorked + w.absences, 0);
  if (shifts > 0 && result.labor.absences / shifts > 0.1) {
    out.push({ severity: "low", area: "Disruptions", finding: `${result.labor.absences} absences over ${shifts} scheduled shifts (${pct(result.labor.absences / shifts)}).`, action: "Labor › Absenteeism: the rate is a scenario input; Labor › Cross-train so a missing forklift operator or packer is covered." });
  }

  const idleProc = processes.filter((p) => p.jobs > 0 && p.avgWaitMin > 60 && p.process !== b.process);
  for (const p of idleProc.slice(0, 2)) {
    out.push({ severity: "low", area: "Labor", finding: `${p.process} jobs waited ${minutes(p.avgWaitMin)} on average (max ${minutes(p.maxWaitMin)}, queue up to ${p.maxQueue}), ${pct(p.equipmentShare)} of it held by equipment or a door.`, action: `Labor › Cross-train on ${p.skill}, or Labor › Flex across skills: yes, so idle people pick this work up.` });
  }

  if (out.length === 0) {
    out.push({ severity: "low", area: "Labor", finding: `Every store truck left on time, fill rate ${pct(k.fillRate, 1)}, utilization ${pct(k.utilization)}, ${num(k.overtimeHours, 1)} overtime hours.`, action: "Nothing to fix here. Try Deliveries › demand ×1.3 or week 44 (Halloween) to find where this building breaks." });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b2) => order[a.severity] - order[b2.severity]);
}

export function buildReport(run: ReportRun, previous: { label: string; kpis: Kpis } | null = null): Report {
  const { result, kpis: k, world, spec } = run;
  const days = buildDays(run);
  const processes = buildProcesses(result);
  const resources: ReportResource[] = [
    { name: "forklifts", count: result.resources.forklifts.count, utilization: result.resources.forklifts.utilization },
    { name: "pallet jacks", count: result.resources.palletJacks.count, utilization: result.resources.palletJacks.utilization },
    { name: "inbound doors", count: result.resources.inboundDoors.count, utilization: result.resources.inboundDoors.utilization },
    { name: "outbound doors", count: result.resources.outboundDoors.count, utilization: result.resources.outboundDoors.utilization },
  ];
  const summary = KPI_META.map((m) => ({ key: m.key, label: m.label, value: m.fmt(k[m.key]) }));
  const lateTrucks = result.trucks.filter((t) => t.lateMin > 0 || t.loadedAt === null).sort((a, b) => b.lateMin - a.lateMin).slice(0, 8);
  const prev = previous
    ? {
        label: previous.label,
        kpis: previous.kpis,
        deltas: KPI_META.map((m) => {
          const a = previous.kpis[m.key];
          const b = k[m.key];
          const d = b - a;
          const better = Math.abs(d) < 1e-9 ? null : HIGHER_IS_WORSE.has(m.key) ? d < 0 : d > 0;
          return { key: m.key, label: m.label, a: m.fmt(a), b: m.fmt(b), delta: deltaText(m.key, a, b), better };
        }),
      }
    : null;
  return {
    title: `${world.dc.name}: ${spec.days} day${spec.days === 1 ? "" : "s"} from week ${spec.startWeek}, seed ${spec.seed}`,
    run: { label: run.label, building: run.building, dc: world.dc.id, startWeek: spec.startWeek, days: spec.days, seed: spec.seed, changes: [...world.changes] },
    kpis: k,
    summary,
    days,
    bottleneck: result.bottleneck,
    processes,
    resources,
    reserve: { positions: result.reserve.positions, needed: result.reserve.palletsNeededEnd },
    workers: buildWorkers(result),
    lateTrucks,
    recommendations: recommend(run, days, processes),
    previous: prev,
  };
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

const dayName = (d: ReportDay) => `Day ${d.day + 1} · ${d.weekday}`;
const fmtFill = (f: number | null) => (f === null ? "—" : pct(f, 1));
const fmtUtil = (f: number | null) => (f === null ? "—" : pct(f));

export function reportMarkdown(r: Report): string {
  const lines: string[] = [
    `# Scenario report: ${r.title}`,
    ``,
    `Building: ${r.run.building}. ${r.run.changes.length ? `Scenario: ${r.run.changes.join("; ")}.` : "Baseline scenario."} Same seed replays the same draws; the numbers are the engine's own accounting.`,
    ``,
    `## Headline`,
    ``,
    `| KPI | value |`,
    `|---|---:|`,
    ...r.summary.map((s) => `| ${s.label} | ${s.value} |`),
    ``,
    `**Bottleneck:** ${r.bottleneck.process ? `${r.bottleneck.process}, about ${num(r.bottleneck.waitHours, 1)} job-hours of floor-time waiting; ${r.bottleneck.constraint}.` : r.bottleneck.constraint}`,
    r.reserve.needed > r.reserve.positions ? `**Reserve overflow:** ${r.reserve.needed} pallet positions needed, ${r.reserve.positions} in the racks.` : `Reserve: ${r.reserve.needed} of ${r.reserve.positions} pallet positions needed at the end.`,
    ``,
    `## What to change`,
    ``,
    ...r.recommendations.map((x) => `- **${x.severity}** (${x.area}) ${x.finding} → ${x.action}`),
    ``,
    `## Day by day`,
    ``,
    `| day | week | orders | inners shipped | cut | fill | shipped $ | inbound trucks/pallets | trucks | late | late min | paid h | OT h | busy | labor cost | hot replens | shorts | absent | bottleneck |`,
    `|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`,
    ...r.days.map(
      (d) =>
        `| ${dayName(d)} | ${d.calendarWeek} | ${d.orders} | ${num(d.innersShipped)} | ${num(d.cutInners)} | ${fmtFill(d.fillRate)} | ${money(d.shippedDollars)} | ${d.inboundTrucks}/${d.inboundPallets} | ${d.trucks} | ${d.trucksLate} | ${num(d.lateMin)} | ${num(d.paidHours, 1)} | ${num(d.overtimeHours, 1)} | ${fmtUtil(d.utilization)} | ${money(d.laborCost)} | ${d.hotReplenishments} | ${d.shortAtFace} | ${d.absences} | ${d.bottleneck ? `${d.bottleneck.process} (queue up to ${d.bottleneck.peak})` : "—"} |`
    ),
    ``,
    `## Processes`,
    ``,
    `| process | skill | jobs | busy h | avg wait | max wait | max queue | wait held by equipment |`,
    `|---|---|---:|---:|---:|---:|---:|---:|`,
    ...r.processes.map((p) => `| ${p.process} | ${p.skill} | ${p.jobs} | ${num(p.busyHours, 1)} | ${minutes(p.avgWaitMin)} | ${minutes(p.maxWaitMin)} | ${p.maxQueue} | ${pct(p.equipmentShare)} |`),
    ``,
    `Equipment: ${r.resources.map((x) => `${x.count} ${x.name} at ${pct(x.utilization)}`).join(", ")}.`,
    ``,
    `## Crew`,
    ``,
    `| worker | role | shifts | absent | paid h | OT h | busy | where the time went |`,
    `|---|---|---:|---:|---:|---:|---:|---|`,
    ...r.workers.map((w) => `| ${w.id} | ${w.role}${w.type === "full-time" ? "" : ` (${w.type})`} | ${w.shiftsWorked} | ${w.absences} | ${num(w.paidHours + w.overtimeHours, 1)} | ${num(w.overtimeHours, 1)} | ${fmtUtil(w.utilization)} | ${w.top || "—"} |`),
  ];
  if (r.lateTrucks.length) {
    lines.push(``, `## Late trucks`, ``, ...r.lateTrucks.map((t) => `- ${t.store}, day ${t.day + 1}: ${t.loadedAt === null ? "never loaded" : `${minutes(t.lateMin)} late`} (${t.pallets} pallets, ${num(t.inners)} inners)`));
  }
  if (r.previous) {
    lines.push(``, `## Against the previous run (${r.previous.label})`, ``, `| KPI | previous | this run | Δ |`, `|---|---:|---:|---:|`, ...r.previous.deltas.map((d) => `| ${d.label} | ${d.a} | ${d.b} | ${d.delta}${d.better === null ? "" : d.better ? " ✓" : " ✗"} |`));
  }
  lines.push(``, `Dollars are candystore retail value. Waits are floor time (hours with nobody on shift are not counted). Recommendations are rules over these numbers, not an optimizer: change one input, run again, and compare.`, ``);
  return lines.join("\n");
}

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The day-by-day table, one row per day, numbers unformatted. */
export function reportCsv(r: Report): string {
  const head = ["day", "weekday", "calendar_week", "orders", "lines", "inners_shipped", "inners_cut", "fill_rate", "shipped_dollars", "inbound_trucks", "inbound_pallets", "trucks_loaded", "trucks_late", "late_minutes", "paid_hours", "overtime_hours", "busy_hours", "utilization", "labor_cost", "hot_replenishments", "short_at_face", "absences", "bottleneck_process", "bottleneck_peak_queue", "bottleneck_queue_minutes", ...PROCESSES.map((p) => `peak_queue_${p}`)];
  const rows = r.days.map((d) => [
    d.day + 1,
    d.weekday,
    d.calendarWeek,
    d.orders,
    d.lines,
    d.innersShipped,
    d.cutInners,
    d.fillRate,
    d.shippedDollars,
    d.inboundTrucks,
    d.inboundPallets,
    d.trucks,
    d.trucksLate,
    d.lateMin,
    d.paidHours,
    d.overtimeHours,
    d.busyHours,
    d.utilization,
    d.laborCost,
    d.hotReplenishments,
    d.shortAtFace,
    d.absences,
    d.bottleneck?.process ?? null,
    d.bottleneck?.peak ?? null,
    d.bottleneck?.queueMinutes ?? null,
    ...PROCESSES.map((p) => d.peakQueue[p]),
  ]);
  return [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function reportJson(r: Report): string {
  return JSON.stringify(r, null, 2);
}

/** A file-name stem such as "twin-report-dc-east-wk44-7d-seed1". */
export function reportFileStem(r: Report): string {
  return `twin-report-${r.run.dc}-wk${r.run.startWeek}-${r.run.days}d-seed${r.run.seed}`;
}
