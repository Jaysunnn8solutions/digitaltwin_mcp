/**
 * Inventory: what is on hand, what is on order, and when the buyers reorder.
 *
 * Periodic review, order-up-to. Each supplier has an order day; on it, every
 * SKU from that supplier is brought up to S = mean demand over the protection
 * period (review interval + lead time) + z·σ, where σ combines Poisson demand
 * variance with lead-time variance. Quantities round up to master cases.
 *
 * The forecast behind the mean is the policy question. "seasonal" looks
 * forward through candystore's calendar, so the Halloween ramp is ordered
 * ahead of it. "trailing" averages the last four weeks actually shipped,
 * which is what a buyer without a seasonal plan does, and it arrives at
 * Halloween with September's stock.
 *
 * The book is shared by the fast daily simulation (receipts available the
 * day they arrive) and the operations simulation (available once put away).
 */

import { normal, normalQuantile, substream, type Rng } from "../util/random";
import { expectedDailyInners, ordersReleasedOn, weekdayOf, type DemandModel, type StoreOrder } from "./demand";
import { DEFAULT_STANDARDS } from "./standards";
import type { Catalog, Sku, Supplier } from "./types";

export type ForecastMethod = "seasonal" | "trailing";

export interface InventoryPolicy {
  forecast: ForecastMethod;
  /** Cycle service level behind the safety stock, 0.5–0.999. */
  serviceLevel: number;
}

export const DEFAULT_POLICY: InventoryPolicy = { forecast: "seasonal", serviceLevel: 0.97 };

/** Extra lead time for a supplier (or every supplier of a category) on orders placed in a window. */
export interface SupplierDelay {
  supplier?: string;
  category?: string;
  extraDays: number;
  fromDay: number;
  toDay: number;
}

export interface PurchaseOrder {
  id: string;
  supplier: string;
  placedDay: number;
  arriveDay: number;
  lines: Array<{ sku: string; cases: number; inners: number }>;
  pallets: number;
}

export interface InboundPallet {
  items: Array<{ sku: string; cases: number }>;
  mixed: boolean;
}

/**
 * How a supplier builds a shipment: full pallets of one SKU where the
 * quantity allows, and the remainders consolidated onto mixed pallets by cube
 * (first fit, in PO order). A mixed pallet is broken down at receipt and each
 * SKU on it is put away separately.
 */
export function buildPallets(lines: PurchaseOrder["lines"], skus: Map<string, Sku>, palletCubeFt: number): InboundPallet[] {
  const pallets: InboundPallet[] = [];
  const mixed: Array<{ items: Array<{ sku: string; cases: number }>; cube: number }> = [];
  for (const l of lines) {
    const sku = skus.get(l.sku)!;
    const full = Math.floor(l.cases / sku.casesPerPallet);
    for (let i = 0; i < full; i++) pallets.push({ items: [{ sku: l.sku, cases: sku.casesPerPallet }], mixed: false });
    const rest = l.cases - full * sku.casesPerPallet;
    if (rest <= 0) continue;
    const cube = rest * sku.innersPerCase * sku.innerCubeFt;
    const target = mixed.find((m) => m.cube + cube <= palletCubeFt);
    if (target) {
      target.items.push({ sku: l.sku, cases: rest });
      target.cube += cube;
    } else {
      mixed.push({ items: [{ sku: l.sku, cases: rest }], cube });
    }
  }
  for (const m of mixed) pallets.push({ items: m.items, mixed: m.items.length > 1 });
  return pallets;
}

/** Pallet counts on purchase orders are for reporting; the operations model rebuilds pallets with the scenario's standards. */
const PALLET_CUBE_FT = DEFAULT_STANDARDS.palletCubeFt;

export interface SkuState {
  sku: Sku;
  onHand: number;
  allocated: number;
  onOrder: number;
  /** Inners shipped per day, most recent last, capped at 28 entries. */
  history: number[];
  shippedToday: number;
}

export interface InventoryTotals {
  orderedInners: number;
  shippedInners: number;
  cutInners: number;
  cutLines: number;
  lines: number;
  /** Retail dollars not shipped for lack of stock. */
  cutDollars: number;
  shippedDollars: number;
  receipts: number;
  receivedPallets: number;
}

export class InventoryBook {
  readonly skus = new Map<string, SkuState>();
  readonly suppliers: Map<string, Supplier>;
  readonly skuMap: Map<string, Sku>;
  readonly open: PurchaseOrder[] = [];
  readonly totals: InventoryTotals = { orderedInners: 0, shippedInners: 0, cutInners: 0, cutLines: 0, lines: 0, cutDollars: 0, shippedDollars: 0, receipts: 0, receivedPallets: 0 };
  /** Per-SKU cut inners, for stockout reports. */
  readonly cuts = new Map<string, number>();
  private poSeq = 0;
  private readonly rng: Rng;

  constructor(
    readonly model: DemandModel,
    catalog: Catalog,
    readonly policy: InventoryPolicy,
    readonly startWeek: number,
    readonly delays: SupplierDelay[],
    seed: number
  ) {
    this.suppliers = new Map(catalog.suppliers.map((s) => [s.id, s]));
    this.skuMap = new Map(catalog.skus.map((s) => [s.id, s]));
    this.rng = substream(seed, `inventory-${model.dc}`);
    for (const sku of catalog.skus) this.skus.set(sku.id, { sku, onHand: 0, allocated: 0, onOrder: 0, history: [], shippedToday: 0 });
  }

  private protectionDays(supplier: Supplier): number {
    return 7 + supplier.leadDays;
  }

  /** Order-up-to level for a SKU on horizon day `day`. */
  orderUpTo(state: SkuState, day: number, seasonalDaily?: Map<string, number>): number {
    const supplier = this.suppliers.get(state.sku.supplier)!;
    const P = this.protectionDays(supplier);
    let daily: number;
    if (this.policy.forecast === "trailing" && state.history.length >= 7) {
      daily = state.history.reduce((a, b) => a + b, 0) / state.history.length;
    } else {
      daily = (seasonalDaily ?? expectedDailyInners(this.model, day, P, this.startWeek)).get(state.sku.id) ?? 0;
    }
    const mu = daily * P;
    const z = normalQuantile(this.policy.serviceLevel);
    // Deliveries are lumpy (two or three a week per store), so daily variance
    // runs above Poisson; 2x is the index of dispersion that fits the sampled
    // orders at the defaults.
    const sigma = Math.sqrt(2 * mu + Math.pow(daily * supplier.leadSdDays, 2));
    return mu + z * sigma;
  }

  /**
   * Start in steady state: on hand at safety stock plus half a review cycle,
   * and a pipeline of the weekly orders placed at earlier reviews still in
   * transit, so a 30-day importer lead time does not open with a month of
   * nothing arriving.
   */
  initialize(day: number) {
    for (const supplier of this.suppliers.values()) {
      const daily = expectedDailyInners(this.model, day, this.protectionDays(supplier), this.startWeek);
      const lines: PurchaseOrder["lines"] = [];
      const pipelineWeeks = Math.floor(supplier.leadDays / 7);
      for (const state of this.skus.values()) {
        if (state.sku.supplier !== supplier.id) continue;
        const S = this.orderUpTo(state, day, daily);
        const d = daily.get(state.sku.id) ?? 0;
        state.onHand = Math.max(0, Math.round(S - d * (supplier.leadDays + 3.5)));
        const weekly = Math.ceil((7 * d) / state.sku.innersPerCase);
        if (weekly > 0) lines.push({ sku: state.sku.id, cases: weekly, inners: weekly * state.sku.innersPerCase });
      }
      if (lines.length === 0) continue;
      for (let k = 0; k < pipelineWeeks; k++) {
        let arrive = day + supplier.leadDays - 7 * k;
        while (!this.model.site.operatingDays.includes(weekdayOf(arrive))) arrive++;
        const pallets = buildPallets(lines, this.skuMap, PALLET_CUBE_FT).length;
        this.open.push({ id: `PO-${this.model.dc}-${++this.poSeq}`, supplier: supplier.id, placedDay: arrive - supplier.leadDays, arriveDay: arrive, lines: lines.map((l) => ({ ...l })), pallets });
        for (const l of lines) this.skus.get(l.sku)!.onOrder += l.inners;
      }
    }
  }

  private extraLead(supplier: Supplier, day: number): number {
    let extra = 0;
    for (const d of this.delays) {
      if (day < d.fromDay || day > d.toDay) continue;
      if (d.supplier && d.supplier !== supplier.id) continue;
      if (d.category && ![...this.skus.values()].some((s) => s.sku.supplier === supplier.id && s.sku.category === d.category)) continue;
      extra = Math.max(extra, d.extraDays);
    }
    return extra;
  }

  /** Place purchase orders for suppliers whose order day this is. */
  review(day: number): PurchaseOrder[] {
    const wd = weekdayOf(day);
    const placed: PurchaseOrder[] = [];
    for (const supplier of this.suppliers.values()) {
      if (supplier.orderDay !== wd) continue;
      // Computed for trailing too: it is the fallback before a SKU has a week of history.
      const daily = expectedDailyInners(this.model, day, this.protectionDays(supplier), this.startWeek);
      const lines: PurchaseOrder["lines"] = [];
      for (const state of this.skus.values()) {
        if (state.sku.supplier !== supplier.id) continue;
        const S = this.orderUpTo(state, day, daily);
        const position = state.onHand - state.allocated + state.onOrder;
        if (position >= S) continue;
        const cases = Math.ceil((S - position) / state.sku.innersPerCase);
        if (cases <= 0) continue;
        const inners = cases * state.sku.innersPerCase;
        lines.push({ sku: state.sku.id, cases, inners });
        state.onOrder += inners;
      }
      if (lines.length === 0) continue;
      const pallets = buildPallets(lines, this.skuMap, PALLET_CUBE_FT).length;
      const lead = Math.max(1, Math.round(normal(this.rng, supplier.leadDays, supplier.leadSdDays))) + this.extraLead(supplier, day);
      // Receiving happens on operating days; a truck due on a closed day comes the next open one.
      let arrive = day + lead;
      while (!this.model.site.operatingDays.includes(weekdayOf(arrive))) arrive++;
      const po: PurchaseOrder = { id: `PO-${this.model.dc}-${++this.poSeq}`, supplier: supplier.id, placedDay: day, arriveDay: arrive, lines, pallets };
      this.open.push(po);
      placed.push(po);
    }
    return placed;
  }

  /** Purchase orders due to arrive on `day`, removed from the open list. */
  arrivals(day: number): PurchaseOrder[] {
    const due = this.open.filter((p) => p.arriveDay === day);
    for (const p of due) this.open.splice(this.open.indexOf(p), 1);
    return due;
  }

  /** Stock becomes available: the whole PO in the daily model, a pallet at a time in operations. */
  receive(sku: string, inners: number) {
    const s = this.skus.get(sku)!;
    s.onHand += inners;
    s.onOrder = Math.max(0, s.onOrder - inners);
  }

  /** Allocate an order against available stock; cut lines are lost sales, stores do not backorder candy. */
  allocate(order: StoreOrder): Array<{ sku: string; inners: number; cut: number }> {
    return order.lines.map((l) => {
      const s = this.skus.get(l.sku)!;
      const available = Math.max(0, s.onHand - s.allocated);
      const qty = Math.min(l.inners, available);
      const cut = l.inners - qty;
      s.allocated += qty;
      this.totals.lines++;
      this.totals.orderedInners += l.inners;
      if (cut > 0) {
        this.totals.cutInners += cut;
        this.totals.cutDollars += cut * s.sku.innerRetail;
        if (qty === 0) this.totals.cutLines++;
        this.cuts.set(l.sku, (this.cuts.get(l.sku) ?? 0) + cut);
      }
      return { sku: l.sku, inners: qty, cut };
    });
  }

  /** Allocated stock physically leaves. */
  consume(sku: string, inners: number) {
    const s = this.skus.get(sku)!;
    s.onHand -= inners;
    s.allocated -= inners;
    s.shippedToday += inners;
    this.totals.shippedInners += inners;
    this.totals.shippedDollars += inners * s.sku.innerRetail;
  }

  /** Roll daily shipment history for the trailing forecast. */
  endDay() {
    for (const s of this.skus.values()) {
      s.history.push(s.shippedToday);
      if (s.history.length > 28) s.history.shift();
      s.shippedToday = 0;
    }
  }

  retailValue(): number {
    let v = 0;
    for (const s of this.skus.values()) v += s.onHand * s.sku.innerRetail;
    return v;
  }

  /** Reserve pallet positions the stock needs: each SKU's master cases on full pallets, less what fits in its pick face. */
  palletsNeeded(faceCases: number): number {
    let p = 0;
    for (const s of this.skus.values()) {
      const cases = s.onHand / s.sku.innersPerCase - faceCases;
      if (cases > 0) p += Math.ceil(cases / s.sku.casesPerPallet);
    }
    return p;
  }
}

// ---------------------------------------------------------------------------
// Fast daily simulation
// ---------------------------------------------------------------------------

export interface DailyInventoryRow {
  day: number;
  weekday: number;
  calendarWeek: number;
  shipped: number;
  cut: number;
  receivedPallets: number;
  onHandRetail: number;
  palletsNeeded: number;
}

export interface InventoryRun {
  book: InventoryBook;
  daily: DailyInventoryRow[];
}

/**
 * Warm up from steady state for `warmupWeeks` before day 0, then run `days`.
 * Receipts are available the day they arrive and orders ship the day they
 * release, which is the right resolution for a 26-week stock question and
 * the wrong one for a truck cutoff; operations.ts covers the latter.
 */
export function runInventory(model: DemandModel, catalog: Catalog, opts: { startWeek: number; days: number; warmupWeeks: number; policy: InventoryPolicy; delays: SupplierDelay[]; seed: number; faceCases: number }): InventoryRun {
  const book = new InventoryBook(model, catalog, opts.policy, opts.startWeek, opts.delays, opts.seed);
  const warm = -opts.warmupWeeks * 7;
  book.initialize(warm);
  const orderRng = substream(opts.seed, `orders-${model.dc}`);
  const daily: DailyInventoryRow[] = [];
  const snapshotTotals = () => ({ ...book.totals });
  let base = snapshotTotals();
  for (let d = warm; d < opts.days; d++) {
    if (d === 0) {
      // The warm-up only sets the stock position; its sales are not the horizon's.
      base = snapshotTotals();
      book.cuts.clear();
    }
    book.review(d);
    let pallets = 0;
    for (const po of book.arrivals(d)) {
      for (const l of po.lines) book.receive(l.sku, l.inners);
      pallets += po.pallets;
      book.totals.receipts++;
      book.totals.receivedPallets += po.pallets;
    }
    const before = { shipped: book.totals.shippedInners, cut: book.totals.cutInners };
    for (const order of ordersReleasedOn(model, d, opts.startWeek, orderRng)) {
      for (const a of book.allocate(order)) if (a.inners > 0) book.consume(a.sku, a.inners);
    }
    book.endDay();
    if (d >= 0) {
      daily.push({
        day: d,
        weekday: weekdayOf(d),
        calendarWeek: ((((opts.startWeek - 1 + Math.floor(d / 7)) % 52) + 52) % 52) + 1,
        shipped: book.totals.shippedInners - before.shipped,
        cut: book.totals.cutInners - before.cut,
        receivedPallets: pallets,
        onHandRetail: book.retailValue(),
        palletsNeeded: book.palletsNeeded(opts.faceCases),
      });
    }
  }
  // Report horizon totals only.
  for (const k of Object.keys(book.totals) as Array<keyof InventoryTotals>) book.totals[k] -= base[k];
  return { book, daily };
}
