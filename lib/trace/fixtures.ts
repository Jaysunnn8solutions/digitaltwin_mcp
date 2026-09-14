/**
 * A hand-scripted one-day event stream for dc-west, so the compiler tests run
 * without the engine: two supplier trucks (one importer, one mixed pallet),
 * two store orders (one big enough to run into overtime and leave late), one
 * hot replenishment with its re-pick, one short ship, one cut line, one
 * absence, one WMS hour, a break and an overtime clock-out. The script is a
 * tiny calendar (time-ordered callbacks) so causality and job ids come out the
 * way the engine's would; the standards and geometry are the real ones, so
 * every job's duration is exactly what the engine would compute for it.
 */

import { depotDistance, dockToRack, rackToRack, GOLDEN_LEVELS, type Layout, type Location } from "../twin/layout";
import { buildTours, currentSlotting, tourMinutes } from "../twin/slotting";
import { DEFAULT_COSTS, hhmm, shiftPaidHours } from "../twin/standards";
import type { Catalog, CostRates, LaborStandards, Process, Worker } from "../twin/types";
import type { JobInfo, SkuInfo, TraceEvent, TraceInit, WorkerInfo } from "./types";

export interface Fixture {
  events: TraceEvent[];
  init: TraceInit;
  skus: SkuInfo[];
  slotting: Array<[sku: string, loc: string]>;
  workers: WorkerInfo[];
}

export const FIXTURE_DAYS = 1;
/** The WMS is down for this hour of day 0. */
export const FIXTURE_WMS: [number, number] = [540, 600];

export function skuInfos(catalog: Catalog): SkuInfo[] {
  return catalog.skus.map((s) => ({ id: s.id, name: s.name, category: s.category, supplier: s.supplier, innersPerCase: s.innersPerCase, casesPerPallet: s.casesPerPallet, innerCubeFt: s.innerCubeFt, innerRetail: s.innerRetail }));
}

export function workerInfos(workers: Worker[], costs: CostRates = DEFAULT_COSTS): WorkerInfo[] {
  return workers.map((w) => ({
    id: w.id,
    role: w.role,
    type: w.type,
    skills: [...w.skills],
    productivity: w.productivity * (w.type === "temp" ? costs.tempProductivity : 1),
    hourlyRate: w.type === "temp" ? costs.tempHourly : w.hourlyRate,
    overtimeMultiplier: w.type === "temp" ? 1 : costs.overtimeMultiplier,
  }));
}

interface Timed {
  t: number;
  seq: number;
  fn: () => void;
}

interface Tour {
  id: number;
  std: number;
  order: string;
  lines: Array<{ sku: string; inners: number; loc: Location }>;
}

export function buildFixture(layout: Layout, catalog: Catalog, roster: Worker[], std: LaborStandards, costs: CostRates = DEFAULT_COSTS): Fixture {
  const site = layout.site;
  const workersAll = roster.filter((w) => w.dc === site.id);
  const workers = workerInfos(workersAll, costs);
  const skus = skuInfos(catalog);
  const skuMap = new Map(catalog.skus.map((s) => [s.id, s]));
  const slotting = currentSlotting(layout, catalog);
  const reserveLoc = (sku: string): Location => layout.reserve[catalog.skus.findIndex((s) => s.id === sku) % layout.reserve.length];
  const shift = site.shifts[0];
  const shiftStart = hhmm(shift.start);
  const shiftEnd = shiftStart + shiftPaidHours(shift.start, shift.end) * 60;
  const floorStart = shiftStart + shift.indirectMin;
  const breakAt = shiftStart + (shiftEnd - shiftStart) / 2 - shift.breakMin / 2;
  const overtimeCap = shiftEnd + 120;
  const departAt = hhmm(site.times.truckDeparture);
  const horizonEnd = FIXTURE_DAYS * 1440;
  const [wmsFrom, wmsTo] = FIXTURE_WMS;

  // Cast: a picker, a forklift operator, and whoever is left is absent.
  const picker = workersAll.find((w) => w.skills.includes("pick")) ?? workersAll[0];
  const lift = workersAll.find((w) => w.id !== picker.id && w.skills.includes("forklift")) ?? workersAll.find((w) => w.id !== picker.id) ?? picker;
  const absent = workersAll.filter((w) => w.id !== picker.id && w.id !== lift.id);
  const prodOf = (w: Worker) => w.productivity * (w.type === "temp" ? costs.tempProductivity : 1);

  // Stock: three cases on every face, two pallets in reserve; the short-ship SKU has four inners and nothing behind them.
  const [A, B, C, D, E] = catalog.skus;
  const shortSku = catalog.skus[11];
  const face = new Map<string, number>();
  const reserve = new Map<string, number>();
  for (const s of catalog.skus) {
    face.set(s.id, site.pick.faceCases * s.innersPerCase);
    reserve.set(s.id, 2 * s.casesPerPallet * s.innersPerCase);
  }
  face.set(shortSku.id, 4);
  reserve.set(shortSku.id, 0);

  const init: TraceInit = {
    k: "init",
    t: 0,
    dc: site.id,
    startWeek: 36,
    days: FIXTURE_DAYS,
    seed: 0,
    horizonEnd,
    layoutName: layout.spec.name,
    forklifts: site.equipment.forklifts,
    palletJacks: site.equipment.palletJacks,
    inDoors: layout.doors.filter((d) => d.kind === "inbound").map((d) => d.id),
    outDoors: layout.doors.filter((d) => d.kind === "outbound").map((d) => d.id),
    shifts: site.shifts.map((s) => ({ ...s })),
    operatingDays: [...site.operatingDays],
    times: { orderRelease: site.times.orderRelease, truckDeparture: site.times.truckDeparture, inboundWindow: [site.times.inboundWindow[0], site.times.inboundWindow[1]] },
    std: { ...std },
    workers,
    outages: { forklifts: [], inDoors: [], outDoors: [] },
    faceCap: catalog.skus.map((s) => [s.id, site.pick.faceCases * s.innersPerCase]),
    face: [...face],
    reserve: [...reserve],
    reserveLoc: catalog.skus.map((s) => [s.id, reserveLoc(s.id).id]),
  };

  // --- The calendar ---
  const events: TraceEvent[] = [init];
  const heap: Timed[] = [];
  let seq = 0;
  let now = 0;
  const at = (t: number, fn: () => void) => heap.push({ t, seq: seq++, fn });
  const emit = (e: TraceEvent) => {
    if (e.t < now - 1e-9) throw new Error(`fixture: event ${e.k} at ${e.t} before now ${now}`);
    events.push(e);
  };
  const wmsDown = () => now >= wmsFrom && now < wmsTo;
  let jobSeq = 0;
  const queues: Record<Process, number> = { unload: 0, receive: 0, putaway: 0, replenish: 0, pick: 0, pack: 0, load: 0 };
  const queue = (process: Process, priority: number, info: JobInfo): number => {
    const id = ++jobSeq;
    queues[process]++;
    emit({ k: "jobQueued", t: now, job: id, process, priority, queueLen: queues[process], info });
    return id;
  };
  const start = (w: Worker, job: number, process: Process, stdMin: number, waitMin: number, onDone: (t: number) => void, outDoorAcquired = false): number => {
    queues[process]--;
    const dur = Math.max(0.1, stdMin / prodOf(w));
    emit({ k: "jobStart", t: now, job, worker: w.id, dur, waitMin, equipWaitMin: 0, productivity: prodOf(w), outDoorAcquired });
    at(now + dur, () => {
      emit({ k: "jobEnd", t: now, job, worker: w.id });
      onDone(now);
    });
    return now + dur;
  };
  const lineStd = (loc: Location, inners: number) => std.pickPerLine + std.pickPerInner * inners + (GOLDEN_LEVELS.has(loc.level) ? 0 : std.pickBendReachSec / 60);
  const takeFace = (sku: string, want: number) => {
    const have = face.get(sku) ?? 0;
    const took = Math.min(have, want);
    face.set(sku, have - took);
    return took;
  };
  const clockedOut = new Set<string>();
  const clockOut = (w: Worker) => {
    if (clockedOut.has(w.id)) return;
    clockedOut.add(w.id);
    emit({ k: "worker", t: now, id: w.id, state: "out", overtimeMin: Math.max(0, now - shiftEnd), shift: shift.id });
  };

  // --- Orders (released the evening before, so at t = 0) ---
  const bigLines = catalog.skus.slice(20, 120).map((s) => ({ sku: s.id, inners: Math.min(20, site.pick.faceCases * s.innersPerCase), cut: 0 }));
  const order1 = { id: "s1-d0", store: "s1", storeName: "Midtown Sweets", lines: [{ sku: A.id, inners: 20, cut: 0 }, { sku: B.id, inners: 10, cut: 0 }, { sku: C.id, inners: 8, cut: 0 }, { sku: D.id, inners: 30, cut: 0 }, { sku: E.id, inners: 3, cut: 2 }] };
  const order2 = { id: "s3-d0", store: "s3", storeName: "Marietta Square Confections", lines: [{ sku: catalog.skus[10].id, inners: 12, cut: 0 }, { sku: shortSku.id, inners: 6, cut: 0 }, ...bigLines] };
  const storeName = (id: string) => (id === order1.id ? order1.storeName : order2.storeName);
  const orderState = new Map<string, { pending: number; inners: number; cube: number }>();
  const release = (o: typeof order1): Tour[] => {
    const picked = o.lines.filter((l) => l.inners > 0);
    const cube = picked.reduce((c, l) => c + l.inners * skuMap.get(l.sku)!.innerCubeFt, 0);
    const inners = picked.reduce((c, l) => c + l.inners, 0);
    const tours = buildTours({ id: o.id, store: o.store, storeName: o.storeName, releaseDay: -1, departDay: 0, lines: picked.map((l) => ({ sku: l.sku, inners: l.inners })) }, slotting, skuMap, std);
    emit({ k: "orderRelease", t: now, order: o.id, store: o.store, storeName: o.storeName, day: 0, departAt, lines: o.lines, cube, inners, tours: tours.length });
    orderState.set(o.id, { pending: tours.length, inners, cube });
    return tours.map((tour, i) => {
      const m = tourMinutes(layout, tour, std);
      const info: JobInfo = { kind: "pick", order: o.id, tour: i, tours: tours.length, lines: tour.map((l) => ({ sku: l.sku, inners: l.inners, loc: l.loc.id })), feet: m.feet, walkMin: m.walk, handleMin: m.handle, bends: m.bends };
      return { id: queue("pick", 2, info), std: m.walk + m.handle, order: o.id, lines: tour };
    });
  };

  // Work the picker still has to do, in the order the engine would take it: re-picks and packs (priority 1) before tours, loads first of all.
  const repicks: Array<{ id: number; std: number; order: string; sku: string; inners: number }> = [];
  const packs: Array<{ order: string; pallets: number; left: number; next: number; jobs: number[] }> = [];
  const loads: Array<{ order: string; pallets: number; job: number }> = [];
  const tours: Tour[] = [];
  const pendingRepicks: Array<{ order: string; sku: string; inners: number }> = [];
  const replenPending = new Set<string>();
  const hotReplens: Array<{ id: number; sku: string; std: number }> = [];
  const loaded = new Set<string>();

  const maybePack = (orderId: string) => {
    const os = orderState.get(orderId)!;
    if (os.pending > 0) return;
    const pallets = os.inners > 0 ? Math.max(1, Math.ceil(os.cube / std.palletCubeFt)) : 0;
    if (pallets === 0) {
      emit({ k: "orderCut", t: now, order: orderId });
      return;
    }
    emit({ k: "orderPicked", t: now, order: orderId, pallets, inners: os.inners });
    packs.push({ order: orderId, pallets, left: pallets, next: 0, jobs: Array.from({ length: pallets }, (_, i) => queue("pack", 1, { kind: "pack", order: orderId, pallet: i, pallets })) });
  };
  const queueRepick = (orderId: string, sku: string, inners: number) => {
    const loc = slotting.get(sku)!;
    const feet = 2 * depotDistance(layout, loc);
    const id = queue("pick", 1, { kind: "repick", order: orderId, sku, inners, loc: loc.id, feet });
    repicks.push({ id, std: feet / std.walkFtPerMin + lineStd(loc, inners), order: orderId, sku, inners });
  };
  const finishTour = (tour: Tour) => {
    const os = orderState.get(tour.order)!;
    os.pending--;
    for (const l of tour.lines) {
      const took = takeFace(l.sku, l.inners);
      emit({ k: "face", t: now, sku: l.sku, face: face.get(l.sku) ?? 0, reserve: reserve.get(l.sku) ?? 0, delta: -took, reason: "pick", order: tour.order, job: tour.id });
      const short = l.inners - took;
      if (short <= 0) continue;
      const hot = (reserve.get(l.sku) ?? 0) > 0;
      emit({ k: "short", t: now, order: tour.order, sku: l.sku, inners: short, hot, job: tour.id });
      os.pending++;
      if (hot && !replenPending.has(l.sku)) {
        replenPending.add(l.sku);
        const from = reserveLoc(l.sku);
        const to = slotting.get(l.sku)!;
        const feet = rackToRack(layout, from, to);
        const id = queue("replenish", 1, { kind: "replen", sku: l.sku, hot: true, from: from.id, to: to.id, feet });
        hotReplens.push({ id, sku: l.sku, std: std.replenHandling + (2 * feet) / std.forkliftFtPerMin + 2 * from.level * std.liftMinPerLevel });
      }
      if (replenPending.has(l.sku)) pendingRepicks.push({ order: tour.order, sku: l.sku, inners: short });
      else queueRepick(tour.order, l.sku, short);
    }
    maybePack(tour.order);
  };
  const finishRepick = (r: (typeof repicks)[number]) => {
    const took = takeFace(r.sku, r.inners);
    emit({ k: "face", t: now, sku: r.sku, face: face.get(r.sku) ?? 0, reserve: reserve.get(r.sku) ?? 0, delta: -took, reason: "repick", order: r.order, job: r.id });
    const short = r.inners - took;
    const os = orderState.get(r.order)!;
    os.pending--;
    if (short > 0) {
      emit({ k: "shortShip", t: now, order: r.order, sku: r.sku, inners: short, job: r.id });
      os.inners -= short;
    }
    maybePack(r.order);
  };
  const finishReplen = (hr: (typeof hotReplens)[number]) => {
    replenPending.delete(hr.sku);
    const s = skuMap.get(hr.sku)!;
    const waiting = pendingRepicks.filter((r) => r.sku === hr.sku);
    const short = waiting.reduce((a, r) => a + r.inners, 0);
    const cap = site.pick.faceCases * s.innersPerCase;
    const room = Math.max(cap - (face.get(hr.sku) ?? 0), short);
    const cases = Math.min(Math.ceil((reserve.get(hr.sku) ?? 0) / s.innersPerCase), Math.ceil(room / s.innersPerCase));
    const moved = Math.min(reserve.get(hr.sku) ?? 0, cases * s.innersPerCase);
    reserve.set(hr.sku, (reserve.get(hr.sku) ?? 0) - moved);
    face.set(hr.sku, (face.get(hr.sku) ?? 0) + moved);
    emit({ k: "face", t: now, sku: hr.sku, face: face.get(hr.sku) ?? 0, reserve: reserve.get(hr.sku) ?? 0, delta: moved, reason: "replen", job: hr.id });
    for (const r of waiting) {
      pendingRepicks.splice(pendingRepicks.indexOf(r), 1);
      queueRepick(r.order, r.sku, r.inners);
    }
  };
  const finishLoad = (ld: (typeof loads)[number], t: number) => {
    const os = orderState.get(ld.order)!;
    loaded.add(ld.order);
    const lateMin = Math.max(0, t - departAt);
    emit({ k: "truckLoaded", t: now, order: ld.order, store: storeName(ld.order), day: 0, departAt, lateMin, pallets: ld.pallets, inners: os.inners, cycleFloorMin: Math.max(0, t - floorStart), job: ld.job });
    at(Math.max(t, departAt), () => emit({ k: "truckDepart", t: now, order: ld.order }));
  };
  const allLoaded = () => loaded.size >= 2;

  // --- The picker ---
  let pickerFree = floorStart;
  let pickerBreakTaken = false;
  let pickerBusy = false;
  const pickerJob = (job: number, process: Process, stdMin: number, onDone: (t: number) => void, outDoor = false) => {
    pickerBusy = true;
    pickerFree = start(picker, job, process, stdMin, 0, (t) => {
      pickerBusy = false;
      onDone(t);
      pickerRun();
    }, outDoor);
  };
  const pickerRun = () => {
    if (pickerBusy || clockedOut.has(picker.id) || now < pickerFree - 1e-9) return;
    if (wmsDown()) {
      at(wmsTo, pickerRun);
      return;
    }
    if (!pickerBreakTaken && now >= breakAt && now < shiftEnd) {
      pickerBreakTaken = true;
      emit({ k: "worker", t: now, id: picker.id, state: "break", breakMin: shift.breakMin });
      pickerFree = now + shift.breakMin;
      at(pickerFree, () => {
        emit({ k: "worker", t: now, id: picker.id, state: "breakEnd" });
        pickerRun();
      });
      return;
    }
    if (now >= shiftEnd && (allLoaded() || now >= overtimeCap)) {
      clockOut(picker);
      return;
    }
    const ld = loads.shift();
    if (ld) return pickerJob(ld.job, "load", std.loadPerTruck + ld.pallets * std.loadPerPallet, (t) => finishLoad(ld, t), true);
    const rp = repicks.shift();
    if (rp) return pickerJob(rp.id, "pick", rp.std, () => finishRepick(rp));
    const pk = packs.find((p) => p.next < p.pallets);
    if (pk) {
      const i = pk.next++;
      const job = pk.jobs[i];
      return pickerJob(job, "pack", std.packPerPallet, () => {
        pk.left--;
        emit({ k: "palletPacked", t: now, order: pk.order, index: i, left: pk.left, job });
        if (pk.left === 0) loads.push({ order: pk.order, pallets: pk.pallets, job: queue("load", 0, { kind: "load", order: pk.order, store: storeName(pk.order), pallets: pk.pallets, departAt }) });
      });
    }
    const tr = tours.shift();
    if (tr) return pickerJob(tr.id, "pick", tr.std, () => finishTour(tr));
  };

  // --- The forklift operator ---
  let liftFree = floorStart;
  let liftBreakTaken = false;
  let liftBusy = false;
  const liftNext: Array<() => void> = [];
  const liftJob = (job: number, process: Process, stdMin: number, onDone: (t: number) => void) => {
    liftBusy = true;
    liftFree = start(lift, job, process, stdMin, 0, (t) => {
      liftBusy = false;
      onDone(t);
      liftRun();
      pickerRun();
    });
  };
  const liftRun = () => {
    if (liftBusy || clockedOut.has(lift.id) || now < liftFree - 1e-9) return;
    if (wmsDown()) {
      at(wmsTo, liftRun);
      return;
    }
    if (!liftBreakTaken && now >= breakAt && now < shiftEnd) {
      liftBreakTaken = true;
      emit({ k: "worker", t: now, id: lift.id, state: "break", breakMin: shift.breakMin });
      liftFree = now + shift.breakMin;
      at(liftFree, () => {
        emit({ k: "worker", t: now, id: lift.id, state: "breakEnd" });
        liftRun();
      });
      return;
    }
    const hr = hotReplens.shift();
    if (hr) return liftJob(hr.id, "replenish", hr.std, () => finishReplen(hr));
    const next = liftNext.shift();
    if (next) return next();
    if (now >= shiftEnd) clockOut(lift);
  };

  // --- Supplier trucks ---
  const trucks = [
    { po: "PO-dc-west-1", supplier: A.supplier, importer: false, appointment: 420, eta: 425, pallets: [{ items: [{ sku: A.id, cases: A.casesPerPallet }], mixed: false }, { items: [{ sku: B.id, cases: 5 }, { sku: C.id, cases: 4 }], mixed: true }] },
    { po: "PO-dc-west-2", supplier: catalog.suppliers.find((s) => s.kind === "importer")?.id ?? "SUP-IMP-LATAM", importer: true, appointment: 540, eta: 700, pallets: [{ items: [{ sku: D.id, cases: 6 }], mixed: false }] },
  ];
  let inDoorBusy = 0;
  const inDoors = layout.doors.filter((d) => d.kind === "inbound");
  for (const tr of trucks) {
    at(tr.eta, () => {
      const arrivedAt = now;
      emit({ k: "truckArrive", t: now, po: tr.po, supplier: tr.supplier, importer: tr.importer, day: 0, pallets: tr.pallets });
      inDoorBusy++;
      const door = inDoors[inDoorBusy % Math.max(1, inDoors.length)] ?? inDoors[0];
      emit({ k: "truckDock", t: now, po: tr.po, engineDoor: door.id, waitMin: 0 });
      let left = tr.pallets.length;
      tr.pallets.forEach((p, i) => {
        const unloadId = queue("unload", 4, { kind: "unload", po: tr.po, pallet: i, pallets: tr.pallets.length, engineDoor: door.id, items: p.items });
        liftNext.push(() =>
          liftJob(unloadId, "unload", std.unloadPerPallet + (i === 0 ? std.unloadPerTruck : 0), () => {
            left--;
            if (left === 0) {
              inDoorBusy--;
              emit({ k: "truckUndock", t: now, po: tr.po });
            }
            const cases = p.items.reduce((a, it) => a + it.cases, 0);
            const receiveId = queue("receive", 5, { kind: "receive", po: tr.po, pallet: i, engineDoor: door.id, cases, importer: tr.importer });
            liftNext.push(() =>
              liftJob(receiveId, "receive", std.receivePerPallet + cases * std.receivePerCase + (tr.importer ? cases * std.labelPerImportCase : 0), () => {
                const locs = p.items.map((it) => reserveLoc(it.sku));
                const far = Math.max(...locs.map((l) => dockToRack(door, l)));
                const lifts = locs.reduce((a, l) => a + 2 * l.level * std.liftMinPerLevel, 0);
                const putawayId = queue("putaway", 3, { kind: "putaway", po: tr.po, pallet: i, engineDoor: door.id, items: p.items.map((it, k) => ({ sku: it.sku, cases: it.cases, loc: locs[k].id })), farFt: far, liftMin: lifts });
                liftNext.unshift(() =>
                  liftJob(putawayId, "putaway", std.putawayHandling * p.items.length + (2 * far) / std.forkliftFtPerMin + lifts, () => {
                    for (const it of p.items) {
                      const s = skuMap.get(it.sku)!;
                      reserve.set(it.sku, (reserve.get(it.sku) ?? 0) + it.cases * s.innersPerCase);
                      emit({ k: "face", t: now, sku: it.sku, face: face.get(it.sku) ?? 0, reserve: reserve.get(it.sku) ?? 0, delta: 0, reason: "putaway", job: putawayId });
                    }
                    emit({ k: "putaway", t: now, job: putawayId, po: tr.po, pallet: i, items: p.items.map((it, k) => ({ sku: it.sku, inners: it.cases * skuMap.get(it.sku)!.innersPerCase, loc: locs[k].id })), dockToStockMin: now - arrivedAt });
                  })
                );
              })
            );
          })
        );
      });
      liftRun();
    });
  }

  // --- Day 0 ---
  at(0, () => {
    emit({ k: "day", t: 0, day: 0, weekday: 1, calendarWeek: 36, operating: true });
    for (const tr of trucks) emit({ k: "poPlaced", t: 0, po: tr.po, supplier: tr.supplier, placedDay: -5, arriveDay: 0, pallets: tr.pallets.length, cases: tr.pallets.reduce((a, p) => a + p.items.reduce((b, it) => b + it.cases, 0), 0) });
    for (const tr of trucks) emit({ k: "truckScheduled", t: 0, po: tr.po, supplier: tr.supplier, importer: tr.importer, appointment: tr.appointment, eta: tr.eta, pallets: tr.pallets.length });
    tours.push(...release(order1), ...release(order2));
  });
  at(shiftStart, () => {
    for (const w of [picker, lift]) {
      emit({ k: "worker", t: now, id: w.id, state: "in", shift: shift.id, primary: w.id === picker.id ? "pick" : "forklift", shiftStart, shiftEnd, breakAt, breakMin: shift.breakMin, indirectMin: shift.indirectMin, lastShift: true });
    }
    for (const w of absent) emit({ k: "worker", t: now, id: w.id, state: "absent", shift: shift.id });
  });
  at(floorStart, () => {
    emit({ k: "worker", t: now, id: picker.id, state: "indirectEnd" });
    emit({ k: "worker", t: now, id: lift.id, state: "indirectEnd" });
    pickerRun();
    liftRun();
  });
  at(wmsFrom, () => emit({ k: "wms", t: now, down: true, until: wmsTo }));
  at(wmsTo, () => {
    emit({ k: "wms", t: now, down: false });
    pickerRun();
    liftRun();
  });
  for (const t of [shiftEnd, overtimeCap]) {
    at(t, () => {
      pickerRun();
      liftRun();
    });
  }
  at(horizonEnd - 1, () => {
    for (const w of [picker, lift]) if (!clockedOut.has(w.id)) clockOut(w);
  });

  // Run the calendar.
  while (heap.length) {
    heap.sort((p, q) => p.t - q.t || p.seq - q.seq);
    const e = heap.shift()!;
    if (e.t > horizonEnd) break;
    now = e.t;
    e.fn();
  }
  now = horizonEnd;
  emit({ k: "end", t: horizonEnd });
  return { events, init, skus, slotting: [...slotting].map(([sku, loc]) => [sku, loc.id]), workers };
}
