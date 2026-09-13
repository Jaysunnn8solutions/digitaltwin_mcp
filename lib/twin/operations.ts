/**
 * The operations simulation: a discrete-event model of one center, minute by
 * minute, from supplier trucks at the door to store trucks leaving.
 *
 *   inbound truck ─ door ─ unload (pallet jack) ─ receive ─ putaway (forklift) ─ reserve
 *   order release ─ allocate ─ pick tours ─ pack pallets ─ load (door, pallet jack) ─ depart
 *                              │
 *                   pick face runs low ─ replenish (forklift) ─ re-pick the short line
 *
 * Every task is a job in its process's queue. A worker on shift takes the
 * most urgent job their primary skill allows; if that queue is empty and
 * flexing is on, any job their other skills allow. A job starts only when its
 * equipment or door is free too, and the time a job spends ready but unstarted
 * is its wait, which is how a bottleneck shows up. Durations are engineered
 * standards divided by the worker's productivity, with travel from the
 * building's geometry and the slotting.
 *
 * The last shift of the day stays on overtime, up to a cap, while released
 * orders are still unloaded. A truck that is not loaded by its departure time
 * leaves when it is, and the difference is lateness.
 */

import { MinHeap } from "../util/heap";
import { quantile, substream, type Rng } from "../util/random";
import { ordersReleasedOn, weekdayOf, type StoreOrder } from "./demand";
import { buildPallets, InventoryBook, type PurchaseOrder } from "./inventory";
import { depotDistance, dockToRack, rackToRack, GOLDEN_LEVELS, type Location } from "./layout";
import { buildTours, tourMinutes } from "./slotting";
import { calendarWeekOfDay } from "./season";
import { hhmm, shiftPaidHours } from "./standards";
import { buildWeekSchedule, type Assignment } from "./workforce";
import type { TwinContext } from "./twin";
import { PROCESS_SKILL, PROCESSES, type Process, type Skill, type Worker } from "./types";

// ---------------------------------------------------------------------------
// Disruptions
// ---------------------------------------------------------------------------

export interface Disruptions {
  /** Share of scheduled shifts where the worker does not come in. */
  absenteeism: number;
  doorOutages: Array<{ kind: "inbound" | "outbound"; count: number; fromDay: number; toDay: number }>;
  forkliftOutages: Array<{ count: number; fromDay: number; toDay: number }>;
  /** The warehouse system is down: nothing releases and no task starts. */
  wmsOutages: Array<{ day: number; start: string; hours: number }>;
  /** Named workers, or a count of workers in a role, out for a window of days. */
  workerLeave: Array<{ worker?: string; role?: string; count?: number; fromDay: number; toDay: number }>;
  /** Standard deviation of supplier truck arrival around the appointment, minutes. */
  inboundLatenessSdMin: number;
}

export const NO_DISRUPTIONS: Disruptions = {
  absenteeism: 0.04,
  doorOutages: [],
  forkliftOutages: [],
  wmsOutages: [],
  workerLeave: [],
  inboundLatenessSdMin: 30,
};

export interface OperationsOptions {
  days: number;
  seed: number;
  /** Let cross-trained workers take jobs outside their primary skill when it is idle. */
  flex: boolean;
  /** Overtime cap per worker per day for the last shift, hours. */
  overtimeMaxHours: number;
  disruptions: Disruptions;
  /** Warm-up weeks of the daily inventory model before day 0. */
  warmupWeeks: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ProcessStats {
  jobs: number;
  busyMin: number;
  waitTotalMin: number;
  waitMaxMin: number;
  maxQueue: number;
  /** The part of the wait spent with a qualified worker free but equipment or a door taken. */
  equipmentWaitMin: number;
}

export interface TruckRecord {
  order: string;
  store: string;
  day: number;
  departAt: number;
  loadedAt: number | null;
  lateMin: number;
  pallets: number;
  inners: number;
}

export interface WorkerRecord {
  id: string;
  role: string;
  type: Worker["type"];
  shiftsWorked: number;
  absences: number;
  paidHours: number;
  overtimeHours: number;
  busyHours: number;
  primaries: Partial<Record<Skill, number>>;
  /** Busy minutes by process, to see where flexing sent them. */
  byProcess: Partial<Record<Process, number>>;
}

export interface DayRecord {
  day: number;
  weekday: number;
  calendarWeek: number;
  orders: number;
  lines: number;
  innersShipped: number;
  cutInners: number;
  inboundTrucks: number;
  inboundPallets: number;
  trucksLate: number;
  lateMin: number;
  overtimeHours: number;
  absences: number;
}

export interface OperationsResult {
  dc: string;
  startWeek: number;
  days: number;
  seed: number;
  volume: {
    orders: number;
    lines: number;
    innersOrdered: number;
    innersShipped: number;
    shippedDollars: number;
    cutInners: number;
    cutDollars: number;
    inboundTrucks: number;
    inboundPallets: number;
    outboundPallets: number;
  };
  service: {
    trucks: number;
    onTime: number;
    late: number;
    lateMinTotal: number;
    worstLateMin: number;
    /** Released orders still not loaded when the simulation ended. */
    notLoaded: number;
    orderCycleAvgMin: number;
    /** Inners shipped ÷ inners ordered. */
    fillRate: number;
  };
  inbound: {
    dockToStockAvgMin: number;
    dockToStockP90Min: number;
    doorWaitAvgMin: number;
    palletsNotPutAway: number;
  };
  pickFace: { replenishments: number; hotReplenishments: number; shortAtFace: number };
  processes: Record<Process, ProcessStats>;
  labor: {
    paidHours: number;
    overtimeHours: number;
    busyHours: number;
    absences: number;
    regularCost: number;
    overtimeCost: number;
    /** Busy ÷ paid. */
    utilization: number;
    innersPerPaidHour: number;
    costPerThousandShipped: number;
  };
  resources: {
    forklifts: { count: number; utilization: number };
    palletJacks: { count: number; utilization: number };
    inboundDoors: { count: number; utilization: number };
    outboundDoors: { count: number; utilization: number };
  };
  reserve: { positions: number; palletsNeededEnd: number };
  inventoryRetail: { start: number; end: number };
  bottleneck: { process: Process | null; constraint: string; waitHours: number };
  trucks: TruckRecord[];
  workers: WorkerRecord[];
  daily: DayRecord[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Job {
  id: number;
  process: Process;
  ready: number;
  priority: number;
  /** Standard minutes at productivity 1. */
  std: number;
  forklift?: boolean;
  palletJack?: boolean;
  outboundDoor?: OrderState;
  /** First time a free, qualified worker found this job blocked by equipment or a door. */
  heldSince?: number;
  onDone: (t: number) => void;
}

interface WorkerState {
  w: Worker;
  productivity: number;
  skills: Skill[];
  present: boolean;
  primary: Skill | null;
  shiftId: string | null;
  shiftStart: number;
  shiftEnd: number;
  breakAt: number;
  breakMin: number;
  onBreak: boolean;
  breakTaken: boolean;
  busy: boolean;
  lastShift: boolean;
  rec: WorkerRecord;
}

interface OrderState {
  order: StoreOrder;
  releasedAt: number;
  departAt: number;
  pending: number;
  cube: number;
  inners: number;
  lines: number;
  doorHeld: boolean;
  loadedAt: number | null;
  truck: TruckRecord | null;
  day: number;
}

interface PendingRepick {
  order: OrderState;
  sku: string;
  inners: number;
}

/**
 * Lower runs first. Among forklift work a short pick face comes first, then
 * clearing the dock (stock is not pickable until it is put away), then routine
 * top-ups.
 */
const PRIORITY = { load: 0, pack: 1, hotReplen: 1, repick: 1, pick: 2, putaway: 3, replen: 4, unload: 4, receive: 5 };

/** When a flexing worker looks beyond their primary skill, this is the order they look in. */
const FLEX_ORDER: Process[] = ["load", "pack", "replenish", "pick", "unload", "receive", "putaway"];

export function runOperations(ctx: TwinContext, opts: OperationsOptions): OperationsResult {
  const { site, layout, catalog, model, std, costs, slotting } = ctx;
  const startWeek = ctx.startWeek;
  const rngFor = (label: string): Rng => substream(opts.seed, `${label}-${site.id}`);
  const attendRng = rngFor("attendance");
  const arrivalRng = rngFor("arrivals");
  const orderRng = rngFor("orders");
  const dis = opts.disruptions;
  const horizonEnd = opts.days * 1440;
  const skuMap = new Map(catalog.skus.map((s) => [s.id, s]));
  const skuIndex = new Map(catalog.skus.map((s, i) => [s.id, i]));
  const lastShiftId = [...site.shifts].sort((a, b) => hhmm(a.start) + shiftPaidHours(a.start, a.end) * 60 - (hhmm(b.start) + shiftPaidHours(b.start, b.end) * 60)).at(-1)!.id;
  /**
   * Minutes between `a` and `b` when a shift is on the floor (after its
   * indirect time). Overnight and weekends are not a queue, so waits and
   * cycle times are measured in these; work carried to the next morning
   * still shows, as the floor minutes it sat.
   */
  const floorMinutesBetween = (a: number, b: number): number => {
    if (b <= a) return 0;
    let total = 0;
    for (let d = Math.floor(a / 1440) - 1; d <= Math.floor(b / 1440); d++) {
      if (!site.operatingDays.includes(weekdayOf(d))) continue;
      // Overlapping shifts count once: merge their windows for the day.
      const windows = site.shifts
        .map((s) => [d * 1440 + hhmm(s.start) + s.indirectMin, d * 1440 + hhmm(s.start) + shiftPaidHours(s.start, s.end) * 60] as const)
        .sort((x, y) => x[0] - y[0]);
      let curA = -Infinity;
      let curB = -Infinity;
      const flush = () => {
        if (curB > curA) total += Math.max(0, Math.min(b, curB) - Math.max(a, curA));
      };
      for (const [wa, wb] of windows) {
        if (wa > curB) {
          flush();
          curA = wa;
          curB = wb;
        } else curB = Math.max(curB, wb);
      }
      flush();
    }
    return total;
  };
  /** The next time any shift starts on an operating day, after `t`. */
  const nextShiftStart = (t: number): number => {
    for (let d = Math.floor(t / 1440); d < Math.floor(t / 1440) + 8; d++) {
      if (!site.operatingDays.includes(weekdayOf(d))) continue;
      const starts = site.shifts.map((s) => d * 1440 + hhmm(s.start)).filter((s) => s > t);
      if (starts.length) return Math.min(...starts);
    }
    return t + 7 * 1440;
  };

  // --- Inventory: warm up in the daily model, then split face and reserve. ---
  const book = new InventoryBook(model, catalog, ctx.policy, startWeek, ctx.supplierDelays, opts.seed);
  const warm = -opts.warmupWeeks * 7;
  book.initialize(warm);
  const warmRng = rngFor("warmup-orders");
  for (let d = warm; d < 0; d++) {
    book.review(d);
    for (const po of book.arrivals(d)) for (const l of po.lines) book.receive(l.sku, l.inners);
    // The evening before day 0 releases day 0's trucks; those belong to the simulation.
    if (d < -1) for (const o of ordersReleasedOn(model, d, startWeek, warmRng)) for (const a of book.allocate(o)) if (a.inners > 0) book.consume(a.sku, a.inners);
    book.endDay();
  }
  for (const k of Object.keys(book.totals) as Array<keyof typeof book.totals>) book.totals[k] = 0;
  book.cuts.clear();
  const face = new Map<string, number>();
  const reserve = new Map<string, number>();
  for (const s of book.skus.values()) {
    const cap = (ctx.faces.get(s.sku.id) ?? site.pick.faceCases) * s.sku.innersPerCase;
    face.set(s.sku.id, Math.min(s.onHand, cap));
    reserve.set(s.sku.id, s.onHand - Math.min(s.onHand, cap));
  }
  const retailStart = book.retailValue();
  const reserveLoc = (sku: string): Location => layout.reserve[(skuIndex.get(sku) ?? 0) % layout.reserve.length];

  // --- State ---
  const events = new MinHeap<() => void>();
  let now = 0;
  const at = (t: number, fn: () => void) => events.push(t, fn);
  const queues: Record<Process, Job[]> = Object.fromEntries(PROCESSES.map((p) => [p, []])) as unknown as Record<Process, Job[]>;
  let jobSeq = 0;
  const stats: Record<Process, ProcessStats> = Object.fromEntries(
    PROCESSES.map((p) => [p, { jobs: 0, busyMin: 0, waitTotalMin: 0, waitMaxMin: 0, maxQueue: 0, equipmentWaitMin: 0 }])
  ) as unknown as Record<Process, ProcessStats>;
  const daily: DayRecord[] = Array.from({ length: opts.days }, (_, d) => ({
    day: d,
    weekday: weekdayOf(d),
    calendarWeek: calendarWeekOfDay(startWeek, d),
    orders: 0,
    lines: 0,
    innersShipped: 0,
    cutInners: 0,
    inboundTrucks: 0,
    inboundPallets: 0,
    trucksLate: 0,
    lateMin: 0,
    overtimeHours: 0,
    absences: 0,
  }));
  const dayOf = (t: number) => Math.min(opts.days - 1, Math.max(0, Math.floor(t / 1440)));

  const busy = { forklift: 0, palletJack: 0, inDoor: 0, outDoor: 0 };
  const busyMin = { forklift: 0, palletJack: 0, inDoor: 0, outDoor: 0 };
  let lastResourceT = 0;
  const accrueResources = (t: number) => {
    const dt = t - lastResourceT;
    if (dt > 0) {
      busyMin.forklift += busy.forklift * dt;
      busyMin.palletJack += busy.palletJack * dt;
      busyMin.inDoor += busy.inDoor * dt;
      busyMin.outDoor += busy.outDoor * dt;
      lastResourceT = t;
    }
  };
  const outageCount = (list: Array<{ count: number; fromDay: number; toDay: number }>, t: number) =>
    list.filter((o) => dayOf(t) >= o.fromDay && dayOf(t) <= o.toDay).reduce((a, o) => a + o.count, 0);
  const forkliftsAvail = (t: number) => Math.max(0, site.equipment.forklifts - outageCount(dis.forkliftOutages, t));
  const inDoorsAvail = (t: number) => Math.max(0, site.doors.inbound - outageCount(dis.doorOutages.filter((o) => o.kind === "inbound"), t));
  const outDoorsAvail = (t: number) => Math.max(0, site.doors.outbound - outageCount(dis.doorOutages.filter((o) => o.kind === "outbound"), t));
  const wmsWindows = dis.wmsOutages.map((o) => {
    const s = o.day * 1440 + hhmm(o.start);
    return [s, s + o.hours * 60] as const;
  });
  const wmsDownUntil = (t: number) => {
    for (const [s, e] of wmsWindows) if (t >= s && t < e) return e;
    return null;
  };

  const pushJob = (job: Omit<Job, "id">) => {
    const j = { ...job, id: ++jobSeq };
    queues[j.process].push(j);
    stats[j.process].maxQueue = Math.max(stats[j.process].maxQueue, queues[j.process].length);
  };

  // --- Workers ---
  const workers: WorkerState[] = ctx.workers.map((w) => ({
    w,
    productivity: w.productivity * (w.type === "temp" ? costs.tempProductivity : 1),
    skills: w.skills,
    present: false,
    primary: null,
    shiftId: null,
    shiftStart: 0,
    shiftEnd: 0,
    breakAt: 0,
    breakMin: 0,
    onBreak: false,
    breakTaken: false,
    busy: false,
    lastShift: false,
    rec: { id: w.id, role: w.role, type: w.type, shiftsWorked: 0, absences: 0, paidHours: 0, overtimeHours: 0, busyHours: 0, primaries: {}, byProcess: {} },
  }));

  const onLeave = (ws: WorkerState, day: number): boolean => {
    for (const l of dis.workerLeave) {
      if (day < l.fromDay || day > l.toDay) continue;
      if (l.worker && l.worker === ws.w.id) return true;
    }
    return false;
  };
  // Role-based leave picks the first `count` workers of that role, fixed for the window.
  const roleLeave = new Map<string, Set<string>>();
  dis.workerLeave.forEach((l, i) => {
    if (!l.role) return;
    const ids = workers.filter((x) => x.w.role.toLowerCase() === l.role!.toLowerCase()).slice(0, l.count ?? 1).map((x) => x.w.id);
    roleLeave.set(String(i), new Set(ids));
  });
  const onRoleLeave = (ws: WorkerState, day: number) =>
    dis.workerLeave.some((l, i) => l.role && day >= l.fromDay && day <= l.toDay && roleLeave.get(String(i))!.has(ws.w.id));

  // --- Orders and trucks ---
  const orders: OrderState[] = [];
  const trucks: TruckRecord[] = [];
  const pendingRepicks = new Map<string, PendingRepick[]>();
  const replenPending = new Set<string>();
  const pickFace = { replenishments: 0, hotReplenishments: 0, shortAtFace: 0 };
  const dockToStock: number[] = [];
  const doorWaits: number[] = [];
  let palletsInFlight = 0;
  let inboundPalletsTotal = 0;
  let inboundTrucksTotal = 0;
  let outboundPalletsTotal = 0;

  /** Released orders whose truck leaves before anyone is back on the floor. */
  const dueOutbound = () => {
    const back = nextShiftStart(now);
    return orders.some((o) => o.loadedAt === null && o.inners > 0 && o.departAt < back);
  };

  const requestReplen = (sku: string, hot: boolean) => {
    if (replenPending.has(sku) || (reserve.get(sku) ?? 0) <= 0) return;
    replenPending.add(sku);
    const s = skuMap.get(sku)!;
    const from = reserveLoc(sku);
    const to = slotting.get(sku)!;
    pushJob({
      process: "replenish",
      ready: now,
      priority: hot ? PRIORITY.hotReplen : PRIORITY.replen,
      std: std.replenHandling + (2 * rackToRack(layout, from, to)) / std.forkliftFtPerMin + 2 * from.level * std.liftMinPerLevel,
      forklift: true,
      onDone: () => {
        replenPending.delete(sku);
        pickFace.replenishments++;
        if (hot) pickFace.hotReplenishments++;
        const waiting = pendingRepicks.get(sku) ?? [];
        const short = waiting.reduce((a, r) => a + r.inners, 0);
        const cap = (ctx.faces.get(sku) ?? site.pick.faceCases) * s.innersPerCase;
        const room = Math.max(cap - (face.get(sku) ?? 0), short);
        const cases = Math.min(Math.ceil((reserve.get(sku) ?? 0) / s.innersPerCase), Math.ceil(room / s.innersPerCase));
        const moved = Math.min(reserve.get(sku) ?? 0, cases * s.innersPerCase);
        reserve.set(sku, (reserve.get(sku) ?? 0) - moved);
        face.set(sku, (face.get(sku) ?? 0) + moved);
        pendingRepicks.delete(sku);
        for (const r of waiting) queueRepick(r);
      },
    });
  };

  const takeFromFace = (os: OrderState, sku: string, inners: number) => {
    const have = face.get(sku) ?? 0;
    const took = Math.min(have, inners);
    face.set(sku, have - took);
    if (took > 0) book.consume(sku, took);
    const short = inners - took;
    if (short > 0) {
      pickFace.shortAtFace++;
      const list = pendingRepicks.get(sku) ?? [];
      list.push({ order: os, sku, inners: short });
      pendingRepicks.set(sku, list);
      os.pending++;
      if ((reserve.get(sku) ?? 0) > 0) requestReplen(sku, true);
      // Nothing in reserve and nothing on its way to the face: re-pick now,
      // take what the face has, and ship the rest short rather than wait forever.
      if (!replenPending.has(sku)) {
        pendingRepicks.delete(sku);
        for (const r of list) queueRepick(r);
      }
    } else if ((face.get(sku) ?? 0) <= skuMap.get(sku)!.innersPerCase) {
      requestReplen(sku, false);
    }
  };

  const queueRepick = (r: PendingRepick) => {
    const loc = slotting.get(r.sku)!;
    pushJob({
      process: "pick",
      ready: now,
      priority: PRIORITY.repick,
      std: (2 * depotDistance(layout, loc)) / std.walkFtPerMin + std.pickPerLine + std.pickPerInner * r.inners + (GOLDEN_LEVELS.has(loc.level) ? 0 : std.pickBendReachSec / 60),
      onDone: () => {
        const have = face.get(r.sku) ?? 0;
        const took = Math.min(have, r.inners);
        face.set(r.sku, have - took);
        if (took > 0) book.consume(r.sku, took);
        const short = r.inners - took;
        // Another tour got to the face first. If the reserve still holds
        // stock, wait for another replenishment rather than ship short.
        if (short > 0 && ((reserve.get(r.sku) ?? 0) > 0 || replenPending.has(r.sku))) {
          r.inners = short;
          const list = pendingRepicks.get(r.sku) ?? [];
          list.push(r);
          pendingRepicks.set(r.sku, list);
          requestReplen(r.sku, true);
          return;
        }
        r.order.pending--;
        // Nothing left anywhere: release the allocation and ship short.
        if (short > 0) {
          const s = book.skus.get(r.sku)!;
          s.allocated = Math.max(0, s.allocated - short);
          r.order.inners -= short;
        }
        maybePack(r.order);
      },
    });
  };

  const maybePack = (os: OrderState) => {
    if (os.pending > 0) return;
    const pallets = os.inners > 0 ? Math.max(1, Math.ceil(os.cube / std.palletCubeFt)) : 0;
    if (pallets === 0) {
      os.loadedAt = now;
      return;
    }
    let left = pallets;
    for (let i = 0; i < pallets; i++) {
      pushJob({
        process: "pack",
        ready: now,
        priority: PRIORITY.pack,
        std: std.packPerPallet,
        onDone: () => {
          left--;
          if (left > 0) return;
          pushJob({
            process: "load",
            ready: now,
            priority: PRIORITY.load,
            std: std.loadPerTruck + pallets * std.loadPerPallet,
            palletJack: true,
            outboundDoor: os,
            onDone: (t) => {
              os.loadedAt = t;
              const truck: TruckRecord = { order: os.order.id, store: os.order.storeName, day: os.day, departAt: os.departAt, loadedAt: t, lateMin: Math.max(0, t - os.departAt), pallets, inners: os.inners };
              os.truck = truck;
              trucks.push(truck);
              outboundPalletsTotal += pallets;
              if (truck.lateMin > 0) {
                daily[os.day].trucksLate++;
                daily[os.day].lateMin += truck.lateMin;
              }
              // The trailer holds its door until it pulls out.
              at(Math.max(t, os.departAt), () => {
                accrueResources(now);
                busy.outDoor--;
              });
            },
          });
        },
      });
    }
  };

  const release = (d: number) => {
    const down = wmsDownUntil(now);
    if (down !== null) {
      at(down, () => release(d));
      return;
    }
    for (const order of ordersReleasedOn(model, d, startWeek, orderRng)) {
      const alloc = book.allocate(order);
      // Recorded against the day the truck leaves, which is the day the work happens.
      const rec = daily[order.departDay];
      rec.orders++;
      rec.lines += order.lines.length;
      rec.cutInners += alloc.reduce((a, x) => a + x.cut, 0);
      const picked = alloc.filter((a) => a.inners > 0);
      const os: OrderState = {
        order: { ...order, lines: picked.map((a) => ({ sku: a.sku, inners: a.inners })) },
        releasedAt: now,
        departAt: order.departDay * 1440 + hhmm(site.times.truckDeparture),
        pending: 0,
        cube: picked.reduce((c, a) => c + a.inners * skuMap.get(a.sku)!.innerCubeFt, 0),
        inners: picked.reduce((c, a) => c + a.inners, 0),
        lines: picked.length,
        doorHeld: false,
        loadedAt: null,
        truck: null,
        day: order.departDay,
      };
      orders.push(os);
      const tours = buildTours(os.order, slotting, skuMap, std);
      if (tours.length === 0) {
        maybePack(os);
        continue;
      }
      os.pending = tours.length;
      for (const tour of tours) {
        const m = tourMinutes(layout, tour, std);
        pushJob({
          process: "pick",
          ready: now,
          priority: PRIORITY.pick,
          std: m.walk + m.handle,
          onDone: () => {
            os.pending--;
            for (const l of tour) takeFromFace(os, l.sku, l.inners);
            maybePack(os);
          },
        });
      }
    }
  };

  const truckArrives = (po: PurchaseOrder, d: number) => {
    const arrivedAt = now;
    daily[d].inboundTrucks++;
    inboundTrucksTotal++;
    const pallets = buildPallets(po.lines, skuMap, std.palletCubeFt);
    daily[d].inboundPallets += pallets.length;
    inboundPalletsTotal += pallets.length;
    palletsInFlight += pallets.length;
    const importer = book.suppliers.get(po.supplier)?.kind === "importer";
    const inDoors = layout.doors.filter((x) => x.kind === "inbound");
    waitingTrucks.push({
      arrivedAt,
      start: () => {
        doorWaits.push(now - arrivedAt);
        let left = pallets.length;
        const door = inDoors[busy.inDoor % Math.max(1, inDoors.length)] ?? { x: 0, y: 0 };
        pallets.forEach((p, i) => {
          pushJob({
            process: "unload",
            ready: now,
            priority: PRIORITY.unload,
            std: std.unloadPerPallet + (i === 0 ? std.unloadPerTruck : 0),
            palletJack: true,
            onDone: () => {
              left--;
              if (left === 0) {
                accrueResources(now);
                busy.inDoor--;
                startTrucks();
              }
              const cases = p.items.reduce((a, it) => a + it.cases, 0);
              pushJob({
                process: "receive",
                ready: now,
                priority: PRIORITY.receive,
                std: std.receivePerPallet + cases * std.receivePerCase + (importer ? cases * std.labelPerImportCase : 0),
                onDone: () => {
                  // A mixed pallet is driven down the reserve aisles once and
                  // dropped SKU by SKU: travel to the farthest location, a
                  // handling stop and a lift at each.
                  const locs = p.items.map((it) => reserveLoc(it.sku));
                  const far = Math.max(...locs.map((l) => dockToRack(door, l)));
                  const lifts = locs.reduce((a, l) => a + 2 * l.level * std.liftMinPerLevel, 0);
                  pushJob({
                    process: "putaway",
                    ready: now,
                    priority: PRIORITY.putaway,
                    std: std.putawayHandling * p.items.length + (2 * far) / std.forkliftFtPerMin + lifts,
                    forklift: true,
                    onDone: () => {
                      for (const it of p.items) {
                        const s = skuMap.get(it.sku)!;
                        const inners = it.cases * s.innersPerCase;
                        book.receive(it.sku, inners);
                        reserve.set(it.sku, (reserve.get(it.sku) ?? 0) + inners);
                        if ((face.get(it.sku) ?? 0) <= s.innersPerCase) requestReplen(it.sku, false);
                      }
                      palletsInFlight--;
                      dockToStock.push(now - arrivedAt);
                    },
                  });
                },
              });
            },
          });
        });
      },
    });
    startTrucks();
  };
  const waitingTrucks: Array<{ arrivedAt: number; start: () => void }> = [];
  const startTrucks = () => {
    while (waitingTrucks.length && busy.inDoor < inDoorsAvail(now)) {
      accrueResources(now);
      busy.inDoor++;
      waitingTrucks.shift()!.start();
    }
  };

  // --- Dispatch ---
  const skillsFor = (ws: WorkerState): Process[] => {
    const primary = PROCESSES.filter((p) => PROCESS_SKILL[p] === ws.primary).sort((a, b) => FLEX_ORDER.indexOf(a) - FLEX_ORDER.indexOf(b));
    if (!opts.flex) return primary;
    const others = FLEX_ORDER.filter((p) => !primary.includes(p) && ws.skills.includes(PROCESS_SKILL[p]));
    return [...primary, ...others];
  };

  const canStart = (job: Job): boolean => {
    if (job.forklift && busy.forklift >= forkliftsAvail(now)) return false;
    if (job.palletJack && busy.palletJack >= site.equipment.palletJacks) return false;
    if (job.outboundDoor && !job.outboundDoor.doorHeld && busy.outDoor >= outDoorsAvail(now)) return false;
    return true;
  };

  const chooseJob = (ws: WorkerState, overtime: boolean): Job | null => {
    const allowed = skillsFor(ws);
    const tiers: Process[][] = [allowed.filter((p) => PROCESS_SKILL[p] === ws.primary), allowed.filter((p) => PROCESS_SKILL[p] !== ws.primary)];
    for (const tier of tiers) {
      let best: Job | null = null;
      for (const p of tier) {
        // On overtime only the work that gets trucks out the door.
        if (overtime && !["pick", "pack", "load", "replenish"].includes(p)) continue;
        for (const j of queues[p]) {
          if (j.ready > now) continue;
          if (best && (j.priority > best.priority || (j.priority === best.priority && j.ready >= best.ready))) continue;
          if (!canStart(j)) {
            // A qualified worker is free and the job still cannot start: from
            // here on its wait belongs to the equipment, not to labor.
            j.heldSince ??= now;
            continue;
          }
          best = j;
        }
      }
      if (best) return best;
    }
    return null;
  };

  const startJob = (ws: WorkerState, job: Job) => {
    const q = queues[job.process];
    q.splice(q.indexOf(job), 1);
    accrueResources(now);
    if (job.forklift) busy.forklift++;
    if (job.palletJack) busy.palletJack++;
    if (job.outboundDoor && !job.outboundDoor.doorHeld) {
      job.outboundDoor.doorHeld = true;
      busy.outDoor++;
    }
    // Hours with nobody on the floor are not a queue; wait counts from when work could have started.
    const wait = floorMinutesBetween(job.ready, now);
    const st = stats[job.process];
    st.jobs++;
    st.waitTotalMin += wait;
    if (job.heldSince !== undefined) st.equipmentWaitMin += floorMinutesBetween(job.heldSince, now);
    st.waitMaxMin = Math.max(st.waitMaxMin, wait);
    const dur = Math.max(0.1, job.std / ws.productivity);
    st.busyMin += dur;
    ws.rec.busyHours += dur / 60;
    ws.rec.byProcess[job.process] = (ws.rec.byProcess[job.process] ?? 0) + dur;
    ws.busy = true;
    at(now + dur, () => {
      accrueResources(now);
      if (job.forklift) busy.forklift--;
      if (job.palletJack) busy.palletJack--;
      ws.busy = false;
      job.onDone(now);
    });
  };

  const clockOut = (ws: WorkerState) => {
    if (!ws.present) return;
    const ot = Math.max(0, now - ws.shiftEnd) / 60;
    ws.rec.overtimeHours += ot;
    daily[dayOf(ws.shiftStart)].overtimeHours += ot;
    ws.present = false;
  };

  const dispatch = () => {
    if (wmsDownUntil(now) !== null) return;
    for (const ws of workers) {
      if (!ws.present || ws.busy || ws.onBreak) continue;
      if (!ws.breakTaken && now >= ws.breakAt && now < ws.shiftEnd) {
        ws.onBreak = true;
        ws.breakTaken = true;
        at(now + ws.breakMin, () => {
          ws.onBreak = false;
        });
        continue;
      }
      const overtime = now >= ws.shiftEnd;
      if (overtime) {
        const capped = now >= ws.shiftEnd + opts.overtimeMaxHours * 60;
        if (!ws.lastShift || capped || !dueOutbound()) {
          clockOut(ws);
          continue;
        }
      }
      const job = chooseJob(ws, overtime);
      if (job) startJob(ws, job);
    }
  };

  // --- Calendar ---
  const builtWeeks = new Set<number>();
  const daySchedules = new Map<number, Map<string, Assignment>>();
  const scheduleFor = (d: number) => {
    const wk = Math.floor(d / 7);
    if (!builtWeeks.has(wk)) {
      builtWeeks.add(wk);
      const sched = ctx.schedule ?? buildWeekSchedule(ctx.workloadContext, ctx.workers, wk * 7, ctx.scheduleOptions);
      for (const day of sched.days) daySchedules.set(wk * 7 + (day.day - sched.days[0].day), new Map(day.assignments.map((a) => [a.worker, a])));
    }
    return daySchedules.get(d) ?? new Map<string, Assignment>();
  };

  for (let d = 0; d < opts.days; d++) {
    const dayStart = d * 1440;
    at(dayStart, () => {
      book.review(d);
      if (!site.operatingDays.includes(weekdayOf(d))) return;
      const [a, b] = site.times.inboundWindow.map(hhmm);
      for (const po of book.arrivals(d)) {
        const appointment = a + arrivalRng() * (b - a);
        const late = dis.inboundLatenessSdMin > 0 ? (arrivalRng() + arrivalRng() + arrivalRng() - 1.5) * 2 * dis.inboundLatenessSdMin : 0;
        at(dayStart + Math.max(a - 30, appointment + late), () => truckArrives(po, d));
      }
    });
    // Evening release for the next day's trucks; the last day's release is
    // for trucks after the horizon, so it is not simulated.
    if (d < opts.days - 1) at(dayStart + hhmm(site.times.orderRelease), () => release(d));
    if (site.operatingDays.includes(weekdayOf(d))) {
      const sched = scheduleFor(d);
      for (const shift of site.shifts) {
        const start = dayStart + hhmm(shift.start);
        const end = start + shiftPaidHours(shift.start, shift.end) * 60;
        at(start, () => {
          for (const ws of workers) {
            const as = sched.get(ws.w.id);
            if (!as || as.shift !== shift.id) continue;
            if (onLeave(ws, d) || onRoleLeave(ws, d) || attendRng() < dis.absenteeism) {
              ws.rec.absences++;
              daily[d].absences++;
              continue;
            }
            ws.present = true;
            ws.primary = as.primary;
            ws.shiftId = shift.id;
            ws.shiftStart = start;
            ws.shiftEnd = end;
            ws.breakMin = shift.breakMin;
            ws.breakAt = start + (end - start) / 2 - shift.breakMin / 2;
            ws.breakTaken = shift.breakMin <= 0;
            ws.lastShift = shift.id === lastShiftId;
            // Start-up meeting, equipment checks and cycle counts come first.
            ws.onBreak = shift.indirectMin > 0;
            if (ws.onBreak) {
              at(start + shift.indirectMin, () => {
                ws.onBreak = false;
              });
            }
            ws.rec.shiftsWorked++;
            ws.rec.primaries[as.primary] = (ws.rec.primaries[as.primary] ?? 0) + 1;
            ws.rec.paidHours += (end - start - shift.breakMin) / 60;
          }
        });
        // Wake-ups only: dispatch runs after every event and handles clocking
        // out at shift end and at the overtime cap.
        at(end, () => {});
        at(end + opts.overtimeMaxHours * 60, () => {});
      }
    }
    at(dayStart + 1439, () => book.endDay());
  }
  // Day 0's trucks were ordered the evening before the horizon: they are in the system at the start.
  at(0, () => release(-1));
  // Wake-ups for WMS recovery and door or forklift outages ending, so idle
  // workers look again when capacity comes back.
  for (const [, e] of wmsWindows) at(e, () => {});
  for (const o of [...dis.doorOutages, ...dis.forkliftOutages]) at((o.toDay + 1) * 1440, () => startTrucks());

  // --- Run ---
  while (events.size > 0) {
    const next = events.peekKey()!;
    if (next > horizonEnd) break;
    const e = events.pop()!;
    now = e.key;
    e.value();
    // Workers who finish a job on overtime and find no reason to stay clock out here.
    dispatch();
  }
  now = horizonEnd;
  accrueResources(now);
  for (const ws of workers) if (ws.present) clockOut(ws);

  // --- Late or missing trucks ---
  for (const os of orders) {
    if (os.loadedAt === null && os.inners > 0) {
      const truck: TruckRecord = { order: os.order.id, store: os.order.storeName, day: os.day, departAt: os.departAt, loadedAt: null, lateMin: Math.max(0, horizonEnd - os.departAt), pallets: 0, inners: os.inners };
      trucks.push(truck);
      daily[os.day].trucksLate++;
      daily[os.day].lateMin += truck.lateMin;
    }
  }
  // Shipped inners per day, attributed to the release day of the order.
  for (const os of orders) if (os.loadedAt !== null) daily[os.day].innersShipped += os.inners;

  // --- Summaries ---
  const realTrucks = trucks.filter((t) => t.inners > 0);
  const late = realTrucks.filter((t) => t.lateMin > 0);
  const loaded = orders.filter((o) => o.loadedAt !== null && o.inners > 0);
  let paidHours = 0;
  let overtimeHours = 0;
  let busyHours = 0;
  let absences = 0;
  let regularCost = 0;
  let overtimeCost = 0;
  for (const ws of workers) {
    paidHours += ws.rec.paidHours + ws.rec.overtimeHours;
    overtimeHours += ws.rec.overtimeHours;
    busyHours += ws.rec.busyHours;
    absences += ws.rec.absences;
    const rate = ws.w.type === "temp" ? costs.tempHourly : ws.w.hourlyRate;
    regularCost += ws.rec.paidHours * rate;
    overtimeCost += ws.rec.overtimeHours * rate * (ws.w.type === "temp" ? 1 : costs.overtimeMultiplier);
  }
  // Operating minutes: the span of the working day across shifts, on operating days.
  const firstStart = Math.min(...site.shifts.map((s) => hhmm(s.start)));
  const lastEnd = Math.max(...site.shifts.map((s) => hhmm(s.start) + shiftPaidHours(s.start, s.end) * 60));
  const opDays = daily.filter((d) => site.operatingDays.includes(d.weekday)).length;
  const opMin = Math.max(1, opDays * (lastEnd - firstStart));

  let bottleneck: OperationsResult["bottleneck"] = { process: null, constraint: "none: no process kept work waiting more than an hour in total", waitHours: 0 };
  for (const p of PROCESSES) {
    const wh = stats[p].waitTotalMin / 60;
    if (wh > 1 && wh > bottleneck.waitHours) {
      const s = stats[p];
      const equipment = s.equipmentWaitMin > s.waitTotalMin * 0.5;
      const what = p === "putaway" || p === "replenish" ? "forklifts" : p === "load" ? "outbound doors or pallet jacks" : p === "unload" ? "inbound doors or pallet jacks" : "equipment";
      bottleneck = { process: p, constraint: equipment ? `equipment: ${what}` : `labor: ${PROCESS_SKILL[p]} hours`, waitHours: wh };
    }
  }

  const shippedDollars = book.totals.shippedDollars;
  return {
    dc: site.id,
    startWeek,
    days: opts.days,
    seed: opts.seed,
    volume: {
      orders: orders.length,
      lines: book.totals.lines,
      innersOrdered: book.totals.orderedInners,
      innersShipped: book.totals.shippedInners,
      shippedDollars,
      cutInners: book.totals.cutInners,
      cutDollars: book.totals.cutDollars,
      inboundTrucks: inboundTrucksTotal,
      inboundPallets: inboundPalletsTotal,
      outboundPallets: outboundPalletsTotal,
    },
    service: {
      trucks: realTrucks.length,
      onTime: realTrucks.length - late.length,
      late: late.length,
      lateMinTotal: late.reduce((a, t) => a + t.lateMin, 0),
      worstLateMin: late.reduce((a, t) => Math.max(a, t.lateMin), 0),
      notLoaded: orders.filter((o) => o.loadedAt === null && o.inners > 0).length,
      orderCycleAvgMin: loaded.length ? loaded.reduce((a, o) => a + floorMinutesBetween(o.releasedAt, o.loadedAt!), 0) / loaded.length : 0,
      fillRate: book.totals.orderedInners ? book.totals.shippedInners / book.totals.orderedInners : 1,
    },
    inbound: {
      dockToStockAvgMin: dockToStock.length ? dockToStock.reduce((a, b) => a + b, 0) / dockToStock.length : 0,
      dockToStockP90Min: quantile(dockToStock, 0.9),
      doorWaitAvgMin: doorWaits.length ? doorWaits.reduce((a, b) => a + b, 0) / doorWaits.length : 0,
      palletsNotPutAway: palletsInFlight,
    },
    pickFace,
    processes: stats,
    labor: {
      paidHours,
      overtimeHours,
      busyHours,
      absences,
      regularCost,
      overtimeCost,
      utilization: paidHours ? busyHours / paidHours : 0,
      innersPerPaidHour: paidHours ? book.totals.shippedInners / paidHours : 0,
      costPerThousandShipped: shippedDollars ? ((regularCost + overtimeCost) / shippedDollars) * 1000 : 0,
    },
    resources: {
      forklifts: { count: site.equipment.forklifts, utilization: busyMin.forklift / (opMin * Math.max(1, site.equipment.forklifts)) },
      palletJacks: { count: site.equipment.palletJacks, utilization: busyMin.palletJack / (opMin * Math.max(1, site.equipment.palletJacks)) },
      // Doors are measured around the clock: a trailer waiting overnight still blocks one.
      inboundDoors: { count: site.doors.inbound, utilization: busyMin.inDoor / (opDays * 1440 * Math.max(1, site.doors.inbound)) },
      outboundDoors: { count: site.doors.outbound, utilization: busyMin.outDoor / (opDays * 1440 * Math.max(1, site.doors.outbound)) },
    },
    reserve: { positions: layout.reserve.length, palletsNeededEnd: book.palletsNeeded(site.pick.faceCases) },
    inventoryRetail: { start: retailStart, end: book.retailValue() },
    bottleneck,
    trucks: realTrucks,
    workers: workers.map((w) => w.rec),
    daily,
  };
}
