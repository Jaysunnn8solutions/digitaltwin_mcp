/**
 * From candystore dollars to store orders.
 *
 * candystore says what each store sells a year by category. A store receives
 * deliveries on its type's delivery days; each delivery carries that store's
 * category dollars for the week divided by its deliveries, scaled by the
 * season of the delivery week. Within a category, dollars split across SKUs
 * by velocity share and become inner packs at the SKU's retail price. The
 * order quantity of every SKU is a Poisson draw on that mean, which is what
 * makes slow movers appear on some orders and not others.
 */

import { poisson, type Rng } from "../util/random";
import { calendarWeekOfDay, seasonFactor } from "./season";
import type { Catalog, Category, Network, NetworkStore, Site, Sku } from "./types";

export interface OrderLine {
  sku: string;
  inners: number;
}

export interface StoreOrder {
  id: string;
  store: string;
  storeName: string;
  /** Horizon day the order releases to the floor. */
  releaseDay: number;
  /** Horizon day the truck leaves, the delivery day. */
  departDay: number;
  lines: OrderLine[];
}

/** A surge or slump in store demand over a window of horizon days. */
export interface DemandShock {
  fromDay: number;
  toDay: number;
  factor: number;
  /** Restrict to one category; all categories when omitted. */
  category?: string;
}

export interface DemandModel {
  dc: string;
  stores: NetworkStore[];
  skusByCategory: Map<Category, Sku[]>;
  site: Site;
  /** Multiplies every store's dollars; 1 is candystore's number. */
  scale: number;
  shocks: DemandShock[];
}

export function buildDemandModel(network: Network, catalog: Catalog, site: Site, scale = 1, shocks: DemandShock[] = []): DemandModel {
  const skusByCategory = new Map<Category, Sku[]>();
  for (const s of catalog.skus) {
    const list = skusByCategory.get(s.category) ?? [];
    list.push(s);
    skusByCategory.set(s.category, list);
  }
  return { dc: site.id, stores: network.stores.filter((s) => s.dc === site.id), skusByCategory, site, scale, shocks };
}

/** 1 = Monday … 7 = Sunday, for day `d` of a horizon starting on a Monday (negative days included). */
export function weekdayOf(d: number): number {
  return (((d % 7) + 7) % 7) + 1;
}

function deliveryDays(model: DemandModel, store: NetworkStore): number[] {
  return store.type === "specialty" ? model.site.deliveryDays.specialty : model.site.deliveryDays.general;
}

function shockFactor(model: DemandModel, day: number, category: string): number {
  let f = 1;
  for (const s of model.shocks) {
    if (day >= s.fromDay && day <= s.toDay && (!s.category || s.category === category)) f *= s.factor;
  }
  return f;
}

/**
 * Expected inners of each SKU on one delivery to a store on horizon day
 * `departDay`. The shared basis for sampled orders, the labor plan's expected
 * volumes and slotting's pick frequencies.
 */
export function expectedDelivery(model: DemandModel, store: NetworkStore, departDay: number, startWeek: number): Map<string, number> {
  const out = new Map<string, number>();
  const perWeek = deliveryDays(model, store).length;
  if (perWeek === 0) return out;
  const season = seasonFactor(calendarWeekOfDay(startWeek, departDay));
  for (const [cat, annual] of Object.entries(store.revenueBy)) {
    const skus = model.skusByCategory.get(cat);
    if (!skus || annual <= 0) continue;
    const dollars = (annual / 52 / perWeek) * season * model.scale * shockFactor(model, departDay, cat);
    for (const s of skus) out.set(s.id, (out.get(s.id) ?? 0) + (dollars * s.velocityShare) / s.innerRetail);
  }
  return out;
}

/** Stores whose truck leaves on horizon day `departDay`. */
export function storesDepartingOn(model: DemandModel, departDay: number): NetworkStore[] {
  const wd = weekdayOf(departDay);
  return model.stores.filter((s) => deliveryDays(model, s).includes(wd));
}

/**
 * Orders releasing on horizon day `releaseDay`, for trucks leaving the next
 * day. Stores send orders every evening, open or not; only a truck due on a
 * day the building is closed is not generated, so delivery days should be
 * operating days (they are in sites.json).
 */
export function ordersReleasedOn(model: DemandModel, releaseDay: number, startWeek: number, rng: Rng): StoreOrder[] {
  const departDay = releaseDay + 1;
  if (!model.site.operatingDays.includes(weekdayOf(departDay))) return [];
  const orders: StoreOrder[] = [];
  for (const store of storesDepartingOn(model, departDay)) {
    const lines: OrderLine[] = [];
    // Iterate in catalog order, not map order, so draws line up run to run.
    for (const [sku, mean] of [...expectedDelivery(model, store, departDay, startWeek)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const q = poisson(rng, mean);
      if (q > 0) lines.push({ sku, inners: q });
    }
    orders.push({ id: `${store.id}-d${departDay}`, store: store.id, storeName: store.name, releaseDay, departDay, lines });
  }
  return orders;
}

/** Expected inners per SKU per day at this center over a window, for inventory planning. */
export function expectedDailyInners(model: DemandModel, fromDay: number, days: number, startWeek: number): Map<string, number> {
  const total = new Map<string, number>();
  for (let d = fromDay + 1; d <= fromDay + days; d++) {
    for (const store of storesDepartingOn(model, d)) {
      for (const [sku, q] of expectedDelivery(model, store, d, startWeek)) total.set(sku, (total.get(sku) ?? 0) + q);
    }
  }
  for (const [k, v] of total) total.set(k, v / days);
  return total;
}

/** P(a Poisson draw with this mean is positive): the chance a SKU appears on an order. */
export function lineProbability(mean: number): number {
  return 1 - Math.exp(-mean);
}
