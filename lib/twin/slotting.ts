/**
 * Slotting: which SKU lives in which pick face.
 *
 * The current slotting is the legacy one a building ends up with: SKUs in
 * catalog order, so products of a family sit together and velocity is
 * wherever it happens to fall. The optimized slotting ranks SKUs by pick
 * frequency (expected lines per week) and gives the most frequent ones the
 * cheapest slots, where cost is walking distance from the depot plus a bend
 * or reach penalty outside the golden levels, expressed in feet.
 *
 * Evaluation replays the same sampled weeks of orders through both, so the
 * difference is the slotting and not a different draw of demand.
 */

import { substream } from "../util/random";
import { expectedDelivery, lineProbability, ordersReleasedOn, storesDepartingOn, type DemandModel, type StoreOrder } from "./demand";
import { GOLDEN_LEVELS, depotDistance, sShapeDistance, type Layout, type Location } from "./layout";
import type { Catalog, LaborStandards, Sku } from "./types";

export type SlottingPolicy = "current" | "optimized";

/** sku id → pick location. */
export type Slotting = Map<string, Location>;

export interface SkuFrequency {
  sku: Sku;
  linesPerWeek: number;
  innersPerWeek: number;
}

/** Expected lines and inners per week for every SKU, over an average (unseasoned) week. */
export function skuFrequencies(model: DemandModel, catalog: Catalog): SkuFrequency[] {
  const lines = new Map<string, number>();
  const inners = new Map<string, number>();
  // Week 20 has a seasonal index of 1: an ordinary week.
  for (let d = 0; d < 7; d++) {
    for (const store of storesDepartingOn(model, d)) {
      for (const [sku, q] of expectedDelivery(model, store, d, 20)) {
        lines.set(sku, (lines.get(sku) ?? 0) + lineProbability(q));
        inners.set(sku, (inners.get(sku) ?? 0) + q);
      }
    }
  }
  return catalog.skus.map((sku) => ({ sku, linesPerWeek: lines.get(sku.id) ?? 0, innersPerWeek: inners.get(sku.id) ?? 0 }));
}

export function slotCostFt(layout: Layout, loc: Location, std: LaborStandards): number {
  const bend = GOLDEN_LEVELS.has(loc.level) ? 0 : (std.pickBendReachSec / 60) * std.walkFtPerMin;
  return depotDistance(layout, loc) + bend;
}

function checkFits(layout: Layout, catalog: Catalog) {
  if (catalog.skus.length > layout.pick.length) {
    throw new Error(`${catalog.skus.length} SKUs do not fit ${layout.pick.length} pick faces at ${layout.site.id}.`);
  }
}

export function currentSlotting(layout: Layout, catalog: Catalog): Slotting {
  checkFits(layout, catalog);
  const skus = [...catalog.skus].sort((a, b) => (a.id < b.id ? -1 : 1));
  return new Map(skus.map((s, i) => [s.id, layout.pick[i]]));
}

export function optimizedSlotting(layout: Layout, catalog: Catalog, freq: SkuFrequency[], std: LaborStandards): Slotting {
  checkFits(layout, catalog);
  const locs = [...layout.pick].sort((a, b) => slotCostFt(layout, a, std) - slotCostFt(layout, b, std) || (a.id < b.id ? -1 : 1));
  const ranked = [...freq].sort((a, b) => b.linesPerWeek - a.linesPerWeek || (a.sku.id < b.sku.id ? -1 : 1));
  return new Map(ranked.map((f, i) => [f.sku.id, locs[i]]));
}

/**
 * Re-slot only the `n` SKUs that gain most, each swapping with the SKU in its
 * optimal slot. A swap moves two SKUs, so this is at most 2n moves, and every
 * swap is kept only if the pair together is cheaper afterwards.
 */
export function partialSlotting(layout: Layout, current: Slotting, optimal: Slotting, freq: SkuFrequency[], std: LaborStandards, n: number): Slotting {
  const result = new Map(current);
  const bySlot = new Map<string, string>([...current].map(([sku, loc]) => [loc.id, sku]));
  const f = new Map(freq.map((x) => [x.sku.id, x.linesPerWeek]));
  const gains = freq
    .map((x) => {
      const from = current.get(x.sku.id)!;
      const to = optimal.get(x.sku.id)!;
      return { sku: x.sku.id, gain: x.linesPerWeek * (slotCostFt(layout, from, std) - slotCostFt(layout, to, std)) };
    })
    .filter((g) => g.gain > 0)
    .sort((a, b) => b.gain - a.gain);
  let swaps = 0;
  for (const g of gains) {
    if (swaps >= n) break;
    const from = result.get(g.sku)!;
    const target = optimal.get(g.sku)!;
    if (from.id === target.id) continue;
    const other = bySlot.get(target.id);
    const before = (f.get(g.sku) ?? 0) * slotCostFt(layout, from, std) + (other ? (f.get(other) ?? 0) * slotCostFt(layout, target, std) : 0);
    const after = (f.get(g.sku) ?? 0) * slotCostFt(layout, target, std) + (other ? (f.get(other) ?? 0) * slotCostFt(layout, from, std) : 0);
    if (after >= before) continue;
    result.set(g.sku, target);
    bySlot.set(target.id, g.sku);
    if (other) {
      result.set(other, from);
      bySlot.set(from.id, other);
    } else {
      bySlot.delete(from.id);
    }
    swaps++;
  }
  return result;
}

export interface SlottingEvaluation {
  weeks: number;
  orders: number;
  lines: number;
  tours: number;
  /** Walking feet per line, from S-shape tours over the sampled orders. */
  feetPerLine: number;
  /** Share of lines picked outside the golden levels. */
  bendReachShare: number;
  /** Picker minutes per week: walking plus line and inner handling. */
  pickMinutesPerWeek: number;
  walkMinutesPerWeek: number;
  /** Lines per labor hour at a productivity of 1. */
  linesPerHour: number;
  /** Tours per week, for the per-tour handling in the labor plan. */
  toursPerWeek: number;
}

/** Split an order into cart tours in S-shape sequence. */
export function buildTours(order: StoreOrder, slotting: Slotting, catalog: Map<string, Sku>, std: LaborStandards): Array<Array<{ sku: string; inners: number; loc: Location }>> {
  const lines = order.lines
    .map((l) => ({ ...l, loc: slotting.get(l.sku)! }))
    .filter((l) => l.loc)
    .sort((a, b) => a.loc.aisle - b.loc.aisle || (a.loc.aisle % 2 === 0 ? a.loc.y - b.loc.y : b.loc.y - a.loc.y));
  const tours: Array<Array<{ sku: string; inners: number; loc: Location }>> = [];
  let cur: typeof lines = [];
  let cube = 0;
  for (const l of lines) {
    const c = l.inners * (catalog.get(l.sku)?.innerCubeFt ?? 0.3);
    if (cur.length > 0 && cube + c > std.cartCubeFt) {
      tours.push(cur);
      cur = [];
      cube = 0;
    }
    cur.push(l);
    cube += c;
  }
  if (cur.length) tours.push(cur);
  return tours;
}

/** Minutes for one tour at productivity 1. */
export function tourMinutes(layout: Layout, tour: Array<{ inners: number; loc: Location }>, std: LaborStandards): { walk: number; handle: number; feet: number; bends: number } {
  const feet = sShapeDistance(layout, tour.map((t) => t.loc));
  let handle = tour.length ? std.pickPerTour : 0;
  let bends = 0;
  for (const t of tour) {
    handle += std.pickPerLine + std.pickPerInner * t.inners;
    if (!GOLDEN_LEVELS.has(t.loc.level)) {
      handle += std.pickBendReachSec / 60;
      bends++;
    }
  }
  return { walk: feet / std.walkFtPerMin, handle, feet, bends };
}

export function evaluateSlotting(layout: Layout, slotting: Slotting, model: DemandModel, catalog: Catalog, std: LaborStandards, weeks = 4, seed = 11): SlottingEvaluation {
  const rng = substream(seed, `slotting-${layout.site.id}`);
  const skuMap = new Map(catalog.skus.map((s) => [s.id, s]));
  let orders = 0;
  let lines = 0;
  let tours = 0;
  let feet = 0;
  let walk = 0;
  let handle = 0;
  let bends = 0;
  for (let d = 0; d < weeks * 7; d++) {
    // Week 20: seasonally ordinary, so the comparison is an ordinary week.
    for (const o of ordersReleasedOn(model, d, 20, rng)) {
      orders++;
      lines += o.lines.length;
      for (const t of buildTours(o, slotting, skuMap, std)) {
        tours++;
        const m = tourMinutes(layout, t, std);
        feet += m.feet;
        walk += m.walk;
        handle += m.handle;
        bends += m.bends;
      }
    }
  }
  const minutes = walk + handle;
  return {
    weeks,
    orders,
    lines,
    tours,
    feetPerLine: lines ? feet / lines : 0,
    bendReachShare: lines ? bends / lines : 0,
    pickMinutesPerWeek: minutes / weeks,
    walkMinutesPerWeek: walk / weeks,
    linesPerHour: minutes ? (lines / minutes) * 60 : 0,
    toursPerWeek: tours / weeks,
  };
}

export function slottingFor(policy: SlottingPolicy, layout: Layout, catalog: Catalog, model: DemandModel, std: LaborStandards): Slotting {
  return policy === "optimized" ? optimizedSlotting(layout, catalog, skuFrequencies(model, catalog), std) : currentSlotting(layout, catalog);
}

/** sku id → pick-face capacity in master cases. */
export type FaceSizes = Map<string, number>;

/** The most master cases of a SKU one pick slot holds, by cube. */
export function slotMaxCases(layout: Layout, sku: Sku, std: LaborStandards): number {
  const p = layout.site.pick;
  const slotCube = (p.bayWidthFt / p.slotsPerBay) * p.rackDepthFt * std.slotHeightFt;
  return Math.max(1, Math.floor(slotCube / (sku.innersPerCase * sku.innerCubeFt)));
}

/**
 * Face sizes. The current building gives every SKU the same face (the site's
 * faceCases). Optimized sizing gives each SKU enough cases for
 * `faceDaysOfSupply` operating days of demand, never less than the standard
 * face and never more than the slot holds, so fast movers stop needing a
 * forklift several times a day.
 */
export function faceSizesFor(policy: SlottingPolicy, layout: Layout, freq: SkuFrequency[], std: LaborStandards): FaceSizes {
  const uniform = layout.site.pick.faceCases;
  const days = layout.site.operatingDays.length || 5;
  return new Map(
    freq.map((f) => {
      const max = slotMaxCases(layout, f.sku, std);
      if (policy === "current") return [f.sku.id, Math.min(uniform, max)];
      // Never below the building's standard face: a face is topped up at its
      // last case, so a smaller one only means more forklift trips.
      const need = Math.ceil(((f.innersPerWeek / days) * std.faceDaysOfSupply) / f.sku.innersPerCase);
      return [f.sku.id, Math.min(max, Math.max(uniform, need))];
    })
  );
}

/** Expected forklift replenishments per week: each SKU's weekly inners over its face capacity. */
export function replenishmentsPerWeek(freq: SkuFrequency[], faces: FaceSizes): number {
  let n = 0;
  for (const f of freq) n += f.innersPerWeek / ((faces.get(f.sku.id) ?? 1) * f.sku.innersPerCase);
  return n;
}
