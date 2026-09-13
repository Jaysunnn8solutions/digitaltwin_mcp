/**
 * Workforce management: how many labor hours each skill needs on each shift,
 * who works when and on what, and what to do about the gap.
 *
 * Workload is volume × engineered standard. Outbound volume is the expected
 * store orders released that day; inbound is the expected supplier pallets
 * arriving, each supplier landing on its order day plus lead time. Travel
 * inside a standard comes from the building: tour feet per line from the
 * slotting, forklift feet from dock to reserve.
 *
 * Requirement hours = workload ÷ average productivity ÷ target utilization.
 * The schedule assigns each present worker a primary skill for the day,
 * filling the scarcest skill first with the least flexible people, so a
 * shift lead is saved for whatever is left. The operations simulation uses
 * those primaries and lets cross-trained people flex when their queue is
 * empty.
 */

import { dockToRack, type Layout, type Location } from "./layout";
import { expectedDelivery, lineProbability, storesDepartingOn, weekdayOf, type DemandModel } from "./demand";
import { seasonFactor, calendarWeekOfDay } from "./season";
import { shiftPaidHours, hhmm, WEEKDAYS } from "./standards";
import type { FaceSizes, SlottingEvaluation } from "./slotting";
import type { Catalog, CostRates, LaborStandards, Site, Skill, Worker } from "./types";
import { SKILLS } from "./types";

export interface Workload {
  day: number;
  /** shift id → skill → standard minutes (productivity 1). */
  minutes: Record<string, Partial<Record<Skill, number>>>;
  volume: { orders: number; lines: number; inners: number; outboundPallets: number; inboundPallets: number; inboundTrucks: number };
}

/** Which shift carries inbound work and which carries outbound, by the site's clock. */
export function shiftRoles(site: Site): { inbound: string; outbound: string } {
  const contains = (t: number) =>
    site.shifts.find((s) => {
      const a = hhmm(s.start);
      let b = hhmm(s.end);
      if (b <= a) b += 1440;
      return (t >= a && t < b) || (t + 1440 >= a && t + 1440 < b);
    })?.id ?? site.shifts[0].id;
  // Outbound work starts a couple of hours after release, once the day shift
  // has finished receiving; the shift covering that is the outbound shift.
  return { inbound: contains(hhmm(site.times.inboundWindow[0])), outbound: contains(hhmm(site.times.orderRelease) + 150) };
}

export interface WorkloadContext {
  site: Site;
  layout: Layout;
  model: DemandModel;
  catalog: Catalog;
  std: LaborStandards;
  slotting: SlottingEvaluation;
  faces: FaceSizes;
  startWeek: number;
}

function centroid(locs: Location[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const l of locs) {
    x += l.x;
    y += l.y;
  }
  return { x: x / Math.max(1, locs.length), y: y / Math.max(1, locs.length) };
}

function avgPutawayMinutes(ctx: WorkloadContext): number {
  const inDoors = ctx.layout.doors.filter((d) => d.kind === "inbound");
  const door = centroid(inDoors.map((d) => ({ x: d.x, y: d.y }) as Location));
  const locs = ctx.layout.reserve;
  let feet = 0;
  let lift = 0;
  for (const l of locs) {
    feet += dockToRack(door, l);
    lift += l.level;
  }
  return ctx.std.putawayHandling + (2 * feet) / locs.length / ctx.std.forkliftFtPerMin + (2 * lift * ctx.std.liftMinPerLevel) / locs.length;
}

export function avgReplenMinutes(ctx: WorkloadContext): number {
  // Reserve to the pick zone and back through the front cross aisle, between zone centroids.
  const r = centroid(ctx.layout.reserve);
  const p = centroid(ctx.layout.pick);
  const front = ctx.layout.pickFrontY;
  const feet = Math.abs(p.x - r.x) + Math.abs(r.y - front) + Math.abs(p.y - front);
  const avgLevel = ctx.layout.reserve.reduce((a, l) => a + l.level, 0) / Math.max(1, ctx.layout.reserve.length);
  return ctx.std.replenHandling + (2 * feet) / ctx.std.forkliftFtPerMin + avgLevel * 2 * ctx.std.liftMinPerLevel;
}

/** Expected standard minutes by shift and skill on horizon day `day`. */
export function expectedWorkload(ctx: WorkloadContext, day: number): Workload {
  const { site, std, model, catalog } = ctx;
  const roles = shiftRoles(site);
  const skuMap = new Map(catalog.skus.map((s) => [s.id, s]));
  const minutes: Workload["minutes"] = Object.fromEntries(site.shifts.map((s) => [s.id, {}]));
  const add = (shift: string, skill: Skill, m: number) => {
    minutes[shift][skill] = (minutes[shift][skill] ?? 0) + m;
  };
  const vol = { orders: 0, lines: 0, inners: 0, outboundPallets: 0, inboundPallets: 0, inboundTrucks: 0 };
  const open = site.operatingDays.includes(weekdayOf(day));

  if (open) {
    // Outbound: the trucks leaving today, released last evening and picked this shift.
    const walkPerLine = ctx.slotting.lines ? ctx.slotting.walkMinutesPerWeek / (ctx.slotting.lines / ctx.slotting.weeks) : 0;
    let replenMoves = 0;
    for (const store of storesDepartingOn(model, day)) {
      vol.orders++;
      let cube = 0;
      for (const [skuId, q] of expectedDelivery(model, store, day, ctx.startWeek)) {
        const sku = skuMap.get(skuId)!;
        const p = lineProbability(q);
        vol.lines += p;
        vol.inners += q;
        cube += q * sku.innerCubeFt;
        // A face is topped up when it falls to its last case, so each trip
        // moves one case less than the face holds.
        replenMoves += q / (Math.max(1, (ctx.faces.get(skuId) ?? site.pick.faceCases) - 1) * sku.innersPerCase);
        add(roles.outbound, "pick", p * (std.pickPerLine + walkPerLine + ctx.slotting.bendReachShare * (std.pickBendReachSec / 60)) + q * std.pickPerInner);
      }
      add(roles.outbound, "pick", Math.ceil(cube / std.cartCubeFt) * std.pickPerTour);
      const pallets = Math.ceil(cube / std.palletCubeFt);
      vol.outboundPallets += pallets;
      add(roles.outbound, "pack", pallets * std.packPerPallet);
      add(roles.outbound, "load", pallets * std.loadPerPallet + std.loadPerTruck);
    }
    add(roles.outbound, "forklift", replenMoves * avgReplenMinutes(ctx));

    // Inbound: suppliers whose order day plus lead time lands today, carrying
    // a week of their SKUs' demand from the week they cover.
    const coverWeek = calendarWeekOfDay(ctx.startWeek, day + 7);
    for (const supplier of catalog.suppliers) {
      let arrive = supplier.orderDay - 1 + supplier.leadDays;
      // Map onto the week and roll forward to an operating day, as the inventory book does.
      while (!site.operatingDays.includes(weekdayOf(arrive))) arrive++;
      if (weekdayOf(arrive) !== weekdayOf(day)) continue;
      const skuCases = new Map<string, number>();
      for (const store of model.stores) {
        for (const [cat, annual] of Object.entries(store.revenueBy)) {
          for (const sku of model.skusByCategory.get(cat) ?? []) {
            if (sku.supplier !== supplier.id) continue;
            const weeklyInners = ((annual / 52) * seasonFactor(coverWeek) * model.scale * sku.velocityShare) / sku.innerRetail;
            skuCases.set(sku.id, (skuCases.get(sku.id) ?? 0) + weeklyInners / sku.innersPerCase);
          }
        }
      }
      // Full single-SKU pallets plus remainders consolidated by cube, as buildPallets ships them.
      let fullPallets = 0;
      let mixedCube = 0;
      let cases = 0;
      for (const [id, c] of skuCases) {
        if (c <= 0) continue;
        const sku = skuMap.get(id)!;
        const full = Math.floor(c / sku.casesPerPallet);
        fullPallets += full;
        mixedCube += (c - full * sku.casesPerPallet) * sku.innersPerCase * sku.innerCubeFt;
        cases += c;
      }
      if (cases <= 0) continue;
      const pallets = fullPallets + Math.ceil(mixedCube / std.palletCubeFt);
      const importCases = supplier.kind === "importer" ? cases : 0;
      vol.inboundPallets += pallets;
      vol.inboundTrucks += 1;
      add(roles.inbound, "receive", std.unloadPerTruck + pallets * (std.unloadPerPallet + std.receivePerPallet) + cases * std.receivePerCase + importCases * std.labelPerImportCase);
      add(roles.inbound, "forklift", pallets * avgPutawayMinutes(ctx));
    }
  }
  return { day, minutes, volume: vol };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface Assignment {
  worker: string;
  shift: string;
  primary: Skill;
}

export interface DaySchedule {
  day: number;
  weekday: number;
  assignments: Assignment[];
  /** shift → skill → required hours, and hours covered by primaries. */
  required: Record<string, Partial<Record<Skill, number>>>;
  covered: Record<string, Partial<Record<Skill, number>>>;
}

export interface WeekSchedule {
  week: number;
  days: DaySchedule[];
  /** worker → scheduled paid hours this week. */
  hours: Record<string, number>;
  /** Hours required but not covered by any primary assignment, by skill. */
  gaps: Partial<Record<Skill, number>>;
  regularCost: number;
}

export interface ScheduleOptions {
  targetUtilization: number;
  /** Expected share of scheduled people absent on a day; inflates requirement. */
  absenteeism: number;
}

export const DEFAULT_SCHEDULE_OPTIONS: ScheduleOptions = { targetUtilization: 0.85, absenteeism: 0.04 };

/** Hours on the floor: the shift less its unpaid break and paid indirect time. */
function productiveHours(site: Site, shiftId: string): number {
  const s = site.shifts.find((x) => x.id === shiftId)!;
  return shiftPaidHours(s.start, s.end) - s.breakMin / 60 - s.indirectMin / 60;
}

/** Paid hours: the shift less its unpaid break. */
function paidHours(site: Site, shiftId: string): number {
  const s = site.shifts.find((x) => x.id === shiftId)!;
  return shiftPaidHours(s.start, s.end) - s.breakMin / 60;
}

/**
 * Schedule one week (horizon days weekStart..weekStart+6). Full-timers work
 * every operating day up to their weekly hours; part-timers take the days
 * whose shift needs the most hours.
 */
export function buildWeekSchedule(ctx: WorkloadContext, workers: Worker[], weekStart: number, opts: ScheduleOptions = DEFAULT_SCHEDULE_OPTIONS): WeekSchedule {
  const { site } = ctx;
  const avgProd = workers.length ? workers.reduce((a, w) => a + w.productivity, 0) / workers.length : 1;
  const workloads = Array.from({ length: 7 }, (_, i) => expectedWorkload(ctx, weekStart + i));
  const required = workloads.map((wl) =>
    Object.fromEntries(
      Object.entries(wl.minutes).map(([shift, bySkill]) => [
        shift,
        Object.fromEntries(Object.entries(bySkill).map(([k, m]) => [k, (m ?? 0) / 60 / avgProd / opts.targetUtilization / (1 - opts.absenteeism)])),
      ])
    ) as Record<string, Partial<Record<Skill, number>>>
  );
  const shiftTotal = (i: number, shift: string) => Object.values(required[i][shift] ?? {}).reduce((a, b) => a + (b ?? 0), 0);

  const openDays = Array.from({ length: 7 }, (_, i) => i).filter((i) => site.operatingDays.includes(weekdayOf(weekStart + i)));
  const workDays = new Map<string, number[]>();
  for (const w of workers) {
    const n = Math.min(openDays.length, Math.floor(w.maxWeeklyHours / paidHours(site, w.homeShift) + 1e-9));
    const days = [...openDays].sort((a, b) => shiftTotal(b, w.homeShift) - shiftTotal(a, w.homeShift) || a - b).slice(0, n).sort((a, b) => a - b);
    workDays.set(w.id, days);
  }

  const days: DaySchedule[] = [];
  const hours: Record<string, number> = {};
  const gaps: Partial<Record<Skill, number>> = {};
  let regularCost = 0;
  for (let i = 0; i < 7; i++) {
    const assignments: Assignment[] = [];
    const covered: Record<string, Partial<Record<Skill, number>>> = {};
    for (const shift of site.shifts) {
      const present = workers.filter((w) => w.homeShift === shift.id && workDays.get(w.id)!.includes(i));
      const need: Partial<Record<Skill, number>> = { ...(required[i][shift.id] ?? {}) };
      covered[shift.id] = {};
      const prod = productiveHours(site, shift.id);
      const unassigned = new Set(present.map((w) => w.id));
      const byId = new Map(present.map((w) => [w.id, w]));
      // Scarcest skill first: the one the fewest present people hold, per hour needed.
      const order = SKILLS.filter((k) => (need[k] ?? 0) > 0).sort((a, b) => {
        const ha = present.filter((w) => w.skills.includes(a)).length;
        const hb = present.filter((w) => w.skills.includes(b)).length;
        return ha / (need[a] ?? 1) - hb / (need[b] ?? 1);
      });
      for (const skill of order) {
        while ((need[skill] ?? 0) > 0.25) {
          const candidates = [...unassigned].map((id) => byId.get(id)!).filter((w) => w.skills.includes(skill));
          if (candidates.length === 0) break;
          candidates.sort((a, b) => a.skills.length - b.skills.length || b.productivity - a.productivity || (a.id < b.id ? -1 : 1));
          const w = candidates[0];
          unassigned.delete(w.id);
          assignments.push({ worker: w.id, shift: shift.id, primary: skill });
          const h = prod * w.productivity / avgProd;
          need[skill] = (need[skill] ?? 0) - h;
          covered[shift.id][skill] = (covered[shift.id][skill] ?? 0) + h;
        }
      }
      // Everyone left goes where the most need remains among their skills,
      // or their first skill on a quiet day.
      for (const id of [...unassigned].sort()) {
        const w = byId.get(id)!;
        const skill = [...w.skills].sort((a, b) => (need[b] ?? 0) - (need[a] ?? 0))[0];
        assignments.push({ worker: w.id, shift: shift.id, primary: skill });
        const h = prod * w.productivity / avgProd;
        need[skill] = (need[skill] ?? 0) - h;
        covered[shift.id][skill] = (covered[shift.id][skill] ?? 0) + h;
      }
      // A primary is a whole person-day, so most skills end up over-covered
      // and a few short by less than a person. Cross-trained people spend
      // their spare hours on the short skills they hold, as they do on the
      // floor; only what nobody present can cover is a gap.
      const spare = new Map<string, number>();
      for (const k of SKILLS) {
        let over = -(need[k] ?? 0);
        if (over <= 0) continue;
        for (const a of [...assignments].reverse()) {
          if (over <= 0) break;
          if (a.shift !== shift.id || a.primary !== k) continue;
          const h = (prod * byId.get(a.worker)!.productivity) / avgProd;
          const s = Math.min(over, h);
          spare.set(a.worker, (spare.get(a.worker) ?? 0) + s);
          over -= s;
        }
        need[k] = 0;
      }
      for (const k of SKILLS) {
        let gap = need[k] ?? 0;
        if (gap <= 0.25) continue;
        for (const [id, s] of spare) {
          if (gap <= 0) break;
          if (s <= 0 || !byId.get(id)!.skills.includes(k)) continue;
          const take = Math.min(s, gap);
          spare.set(id, s - take);
          gap -= take;
          covered[shift.id][k] = (covered[shift.id][k] ?? 0) + take;
        }
        if (gap > 0.25) gaps[k] = (gaps[k] ?? 0) + gap;
      }
      for (const w of present) {
        const paid = paidHours(site, shift.id);
        hours[w.id] = (hours[w.id] ?? 0) + paid;
        regularCost += paid * w.hourlyRate;
      }
    }
    days.push({ day: weekStart + i, weekday: weekdayOf(weekStart + i), assignments, required: required[i], covered });
  }
  return { week: calendarWeekOfDay(ctx.startWeek, weekStart), days, hours, gaps, regularCost };
}

// ---------------------------------------------------------------------------
// Multi-week labor plan
// ---------------------------------------------------------------------------

export interface WeekPlan {
  week: number;
  season: number;
  requiredHours: number;
  scheduledHours: number;
  gaps: Partial<Record<Skill, number>>;
  gapHours: number;
  /** How the gap is closed, cheapest first. */
  overtimeHours: number;
  tempHeadcount: number;
  tempHours: number;
  /** Forklift hours that neither overtime nor temps can cover: temps are not certified. */
  uncoveredForkliftHours: number;
  cost: { regular: number; overtime: number; temps: number; total: number };
  volume: { lines: number; inners: number; inboundPallets: number };
}

export interface LaborPlan {
  weeks: WeekPlan[];
  recommendations: string[];
}

/**
 * Plan labor week by week. Overtime first (up to `maxOvertimePerWorker` hours
 * each for people who hold the short skill), then agency temps for anything
 * but forklift work, then flag the forklift hours left for cross-training or
 * hiring, which have lead times the plan states.
 */
export function planLabor(ctx: WorkloadContext, workers: Worker[], weeks: number, costs: CostRates, opts: ScheduleOptions & { maxOvertimePerWorker: number }): LaborPlan {
  const out: WeekPlan[] = [];
  const avgRate = workers.reduce((a, w) => a + w.hourlyRate, 0) / Math.max(1, workers.length);
  for (let k = 0; k < weeks; k++) {
    const sched = buildWeekSchedule(ctx, workers, k * 7, opts);
    let required = 0;
    for (const d of sched.days) for (const s of Object.values(d.required)) for (const h of Object.values(s)) required += h ?? 0;
    const scheduled = Object.values(sched.hours).reduce((a, b) => a + b, 0);
    let volume = { lines: 0, inners: 0, inboundPallets: 0 };
    for (let i = 0; i < 7; i++) {
      const wl = expectedWorkload(ctx, k * 7 + i);
      volume = { lines: volume.lines + wl.volume.lines, inners: volume.inners + wl.volume.inners, inboundPallets: volume.inboundPallets + wl.volume.inboundPallets };
    }

    // Close gaps skill by skill.
    const otBudget = new Map(workers.filter((w) => w.type !== "temp").map((w) => [w.id, opts.maxOvertimePerWorker]));
    let overtimeHours = 0;
    let overtimeCost = 0;
    let tempHours = 0;
    let uncoveredForklift = 0;
    for (const skill of SKILLS) {
      let gap = sched.gaps[skill] ?? 0;
      if (gap <= 0) continue;
      for (const w of workers.filter((x) => x.skills.includes(skill)).sort((a, b) => a.hourlyRate - b.hourlyRate)) {
        if (gap <= 0) break;
        const avail = otBudget.get(w.id) ?? 0;
        const h = Math.min(avail, gap / w.productivity);
        if (h <= 0) continue;
        otBudget.set(w.id, avail - h);
        overtimeHours += h;
        overtimeCost += h * w.hourlyRate * costs.overtimeMultiplier;
        gap -= h * w.productivity;
      }
      if (gap <= 0) continue;
      if (skill === "forklift") uncoveredForklift += gap;
      else tempHours += gap / costs.tempProductivity;
    }
    const tempHeadcount = Math.ceil(tempHours / 40 - 1e-9);
    const gapHours = Object.values(sched.gaps).reduce((a, b) => a + (b ?? 0), 0);
    const tempsCost = tempHours * costs.tempHourly;
    out.push({
      week: sched.week,
      season: Math.round(seasonFactor(sched.week) * 100) / 100,
      requiredHours: required,
      scheduledHours: scheduled,
      gaps: sched.gaps,
      gapHours,
      overtimeHours,
      tempHeadcount,
      tempHours,
      uncoveredForkliftHours: uncoveredForklift,
      cost: { regular: sched.regularCost, overtime: overtimeCost, temps: tempsCost, total: sched.regularCost + overtimeCost + tempsCost + uncoveredForklift * avgRate * costs.overtimeMultiplier },
      volume,
    });
  }

  const recommendations: string[] = [];
  const forkliftWeeks = out.filter((w) => w.uncoveredForkliftHours > 1);
  if (forkliftWeeks.length) {
    const first = forkliftWeeks[0];
    const idx = out.indexOf(first);
    const peak = Math.max(...forkliftWeeks.map((w) => w.uncoveredForkliftHours));
    const leadWeeks = costs.crossTrainWeeks;
    // A certified person adds roughly a shift's worth of forklift time a week
    // beyond their own job; only non-temps without the skill can be certified.
    const needed = Math.ceil(peak / 32);
    const trainable = workers.filter((w) => w.type !== "temp" && !w.skills.includes("forklift"));
    const certify = Math.min(needed, trainable.length);
    const hire = needed - certify;
    let fix: string;
    if (idx < leadWeeks) {
      fix = `there are fewer than ${leadWeeks} weeks to certify anyone, so the realistic options are overtime past the cap, deferring putaway, or a second shift for forklift work.`;
    } else {
      const parts: string[] = [];
      if (certify > 0) parts.push(`certify ${certify} of ${trainable.map((w) => w.id).join(", ")} by week ${out[idx - leadWeeks].week} ($${costs.crossTrainCost} each, ${leadWeeks} weeks)`);
      if (hire > 0) parts.push(`${certify > 0 ? "and " : ""}hire ${hire} certified operator(s)${idx >= costs.hireWeeks ? ` by week ${out[idx - costs.hireWeeks].week}` : ", though that is inside the hiring lead time"} ($${costs.hireCost} each, ${costs.hireWeeks} weeks)`);
      fix = `${parts.join(" ")}.`;
    }
    recommendations.push(
      `Forklift hours run short in ${forkliftWeeks.length} week(s), first in calendar week ${first.week} (up to ${Math.round(peak)} h/week beyond overtime). Temps cannot drive; ${fix} Forklifts themselves may bind too: check with find_capacity or what_if.`
    );
  }
  const tempWeeks = out.filter((w) => w.tempHeadcount > 0);
  if (tempWeeks.length) {
    recommendations.push(`Book agency temps for weeks ${tempWeeks.map((w) => `${w.week} (${w.tempHeadcount})`).join(", ")}; they run at ${Math.round(costs.tempProductivity * 100)}% of standard.`);
  }
  const heavyOt = out.filter((w) => w.overtimeHours > workers.length * 4);
  if (heavyOt.length >= 4) {
    recommendations.push(`Overtime exceeds 4 h per person in ${heavyOt.length} weeks; at ${costs.overtimeMultiplier}× pay a hire ($${costs.hireCost}, ${costs.hireWeeks} weeks to start) pays back if the volume holds.`);
  }
  if (recommendations.length === 0) recommendations.push("The roster covers every week of the horizon at the target utilization without overtime or temps.");
  return { weeks: out, recommendations };
}

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday - 1] ?? String(weekday);
}
