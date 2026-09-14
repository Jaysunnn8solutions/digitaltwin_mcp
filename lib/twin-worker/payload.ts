/**
 * The plain-data half of the worker's `done` message: everything the /twin
 * page needs besides the playback, lifted out of the TwinContext. The context
 * itself never crosses postMessage (it holds Maps, the demand model and the
 * schedule, and buildTwin caches and shares it), so this module picks the
 * fields the page reads and rebuilds them as arrays and records. Every value
 * is structured-clone safe: no Maps, classes or functions.
 */

import type { SkuInfo, StoreInfo, SupplierInfo, WorkerInfo, World, WorldPayload } from "../trace/types";
import type { TwinContext } from "../twin/twin";
import type { Catalog, CostRates, Worker } from "../twin/types";

/** Static SKU facts, the fields the compiler and the inspector read. */
export function skuInfos(catalog: Catalog): SkuInfo[] {
  return catalog.skus.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    supplier: s.supplier,
    innersPerCase: s.innersPerCase,
    casesPerPallet: s.casesPerPallet,
    innerCubeFt: s.innerCubeFt,
    innerRetail: s.innerRetail,
  }));
}

/**
 * Workers as the engine sees them: the effective productivity, cost rate and
 * overtime multiplier operations.ts writes into the init event (temps work at
 * costs.tempProductivity, earn tempHourly and get no overtime premium). The
 * World is built from these, so it agrees with the trace by construction;
 * run.test.ts asserts they equal init.workers.
 */
export function workerInfos(workers: Worker[], costs: CostRates): WorkerInfo[] {
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

export function supplierInfos(catalog: Catalog): SupplierInfo[] {
  return catalog.suppliers.map((s) => ({ id: s.id, name: s.name, kind: s.kind, leadDays: s.leadDays, leadSdDays: s.leadSdDays, orderDay: s.orderDay }));
}

/**
 * The stores this center serves (the demand model's list, so the network
 * inset shows exactly the stores whose orders the run releases), each with
 * the weekdays its truck leaves: the site's delivery days for its type, which
 * is what demand.ts uses to release orders.
 */
export function storeInfos(ctx: TwinContext): StoreInfo[] {
  const days = ctx.site.deliveryDays;
  return ctx.model.stores.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    lon: s.lon,
    lat: s.lat,
    deliveryDays: [...(s.type === "specialty" ? days.specialty : days.general)],
  }));
}

/** Everything the page needs besides the playback, from a built context and its synthesized world. */
export function buildWorldPayload(ctx: TwinContext, world: World): WorldPayload {
  const site = ctx.site;
  // buildTwin already refused a center the network does not know; this only narrows the type.
  const dc = ctx.network.dcs.find((d) => d.id === site.id);
  if (!dc) throw new Error(`The network has no center "${site.id}".`);
  return {
    layout: ctx.layout,
    spec: ctx.layout.spec,
    world,
    slotting: [...ctx.slotting].map(([sku, loc]) => [sku, loc.id]),
    skus: skuInfos(ctx.catalog),
    suppliers: supplierInfos(ctx.catalog),
    stores: storeInfos(ctx),
    dc: { id: dc.id, name: dc.name, lon: dc.lon, lat: dc.lat },
    workers: workerInfos(ctx.workers, ctx.costs),
    changes: [...ctx.changes],
  };
}
