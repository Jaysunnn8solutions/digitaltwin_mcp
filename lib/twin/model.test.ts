/**
 * Unit tests on synthetic inputs and small pieces of the committed data:
 * seasonality, geometry, demand arithmetic, pallet building, slotting.
 */
import { describe, expect, it } from "vitest";
import { findSite, loadCatalog, loadNetwork } from "../data/load";
import { seededRandom } from "../util/random";
import { buildDemandModel, expectedDelivery, ordersReleasedOn, storesDepartingOn, weekdayOf } from "./demand";
import { buildPallets } from "./inventory";
import { buildLayout, sShapeDistance } from "./layout";
import { calendarWeekOfDay, seasonFactor } from "./season";
import { currentSlotting, evaluateSlotting, faceSizesFor, optimizedSlotting, partialSlotting, skuFrequencies } from "./slotting";
import { DEFAULT_STANDARDS, hhmm, shiftPaidHours } from "./standards";

describe("season", () => {
  it("averages to one over a year, so it redistributes candystore's average week", () => {
    const total = Array.from({ length: 52 }, (_, i) => seasonFactor(i + 1)).reduce((a, b) => a + b, 0);
    expect(total / 52).toBeCloseTo(1, 10);
    expect(seasonFactor(44)).toBeGreaterThan(2);
  });

  it("maps horizon days to calendar weeks, wrapping the year and counting back", () => {
    expect(calendarWeekOfDay(52, 7)).toBe(1);
    expect(calendarWeekOfDay(1, -1)).toBe(52);
    expect(weekdayOf(0)).toBe(1);
    expect(weekdayOf(-1)).toBe(7);
  });

  it("parses the clock", () => {
    expect(hhmm("06:30")).toBe(390);
    expect(shiftPaidHours("22:00", "06:30")).toBe(8.5);
  });
});

describe("layout", () => {
  const site = findSite("dc-east");
  const layout = buildLayout(site);

  it("builds every location and door", () => {
    const p = site.pick;
    expect(layout.pick).toHaveLength(p.aisles * 2 * p.baysPerSide * p.levels * p.slotsPerBay);
    expect(new Set(layout.pick.map((l) => l.id)).size).toBe(layout.pick.length);
    expect(layout.doors.filter((d) => d.kind === "inbound")).toHaveLength(site.doors.inbound);
  });

  it("routes S-shape: an even number of aisles is walked end to end, an odd last aisle is a return trip", () => {
    const front = (aisle: number) => layout.pick.find((l) => l.aisle === aisle && l.bay === 0 && l.level === 1 && l.side === "L")!;
    const L = layout.pickAisleLength;
    const two = sShapeDistance(layout, [front(0), front(1)]);
    const one = sShapeDistance(layout, [front(0)]);
    expect(two).toBeGreaterThan(2 * L);
    expect(one).toBeLessThan(L);
    expect(sShapeDistance(layout, [])).toBe(0);
  });
});

describe("demand", () => {
  const network = loadNetwork();
  const catalog = loadCatalog();
  const site = findSite("dc-east");
  const model = buildDemandModel(network, catalog, site);

  it("spreads each store's candystore dollars over its deliveries in an ordinary week", () => {
    const skuRetail = new Map(catalog.skus.map((s) => [s.id, s.innerRetail]));
    // Week 20 is seasonally ordinary but seasonFactor is relative to the annual mean.
    let dollars = 0;
    for (let d = 0; d < 7; d++) {
      for (const store of storesDepartingOn(model, d)) {
        for (const [sku, q] of expectedDelivery(model, store, d, 20)) dollars += q * skuRetail.get(sku)!;
      }
    }
    const weekly = network.stores.filter((s) => s.dc === site.id).reduce((a, s) => a + Object.values(s.revenueBy).reduce((x, y) => x + y, 0) / 52, 0);
    expect(Math.abs(dollars / (weekly * seasonFactor(20)) - 1)).toBeLessThan(0.001);
  });

  it("releases orders the evening before a delivery and none for a closed day", () => {
    const rng = seededRandom(3);
    const monday = ordersReleasedOn(model, -1, 36, rng);
    expect(monday.length).toBeGreaterThan(0);
    expect(monday.every((o) => o.departDay === 0)).toBe(true);
    expect(ordersReleasedOn(model, 4, 36, rng)).toHaveLength(0); // Friday evening → Saturday, closed
  });
});

describe("pallets", () => {
  it("ships full single-SKU pallets and consolidates remainders within the cube", () => {
    const catalog = loadCatalog();
    const skus = new Map(catalog.skus.map((s) => [s.id, s]));
    const lines = catalog.skus.slice(0, 12).map((s, i) => ({ sku: s.id, cases: i === 0 ? s.casesPerPallet * 2 + 3 : 2 + i, inners: 0 }));
    const pallets = buildPallets(lines, skus, 55);
    const shipped = new Map<string, number>();
    for (const p of pallets) for (const it of p.items) shipped.set(it.sku, (shipped.get(it.sku) ?? 0) + it.cases);
    for (const l of lines) expect(shipped.get(l.sku)).toBe(l.cases);
    for (const p of pallets.filter((x) => x.mixed)) {
      const cube = p.items.reduce((a, it) => a + it.cases * skus.get(it.sku)!.innersPerCase * skus.get(it.sku)!.innerCubeFt, 0);
      expect(cube).toBeLessThanOrEqual(55 + 1e-9);
    }
    expect(pallets.filter((p) => !p.mixed && p.items[0].sku === lines[0].sku && p.items[0].cases === skus.get(lines[0].sku)!.casesPerPallet)).toHaveLength(2);
  });
});

describe("slotting", () => {
  const network = loadNetwork();
  const catalog = loadCatalog();
  const site = findSite("dc-east");
  const layout = buildLayout(site);
  const model = buildDemandModel(network, catalog, site);
  const freq = skuFrequencies(model, catalog);
  const std = DEFAULT_STANDARDS;

  it("puts every SKU in its own face", () => {
    for (const s of [currentSlotting(layout, catalog), optimizedSlotting(layout, catalog, freq, std)]) {
      expect(s.size).toBe(catalog.skus.length);
      expect(new Set([...s.values()].map((l) => l.id)).size).toBe(catalog.skus.length);
    }
  });

  it("walks less and bends less when optimized, and a partial re-slot lands in between", () => {
    const current = currentSlotting(layout, catalog);
    const optimal = optimizedSlotting(layout, catalog, freq, std);
    const partial = partialSlotting(layout, current, optimal, freq, std, 15);
    const c = evaluateSlotting(layout, current, model, catalog, std);
    const o = evaluateSlotting(layout, optimal, model, catalog, std);
    const p = evaluateSlotting(layout, partial, model, catalog, std);
    expect(o.feetPerLine).toBeLessThan(c.feetPerLine);
    expect(o.bendReachShare).toBeLessThan(c.bendReachShare);
    expect(p.feetPerLine).toBeLessThanOrEqual(c.feetPerLine);
    expect(p.feetPerLine).toBeGreaterThanOrEqual(o.feetPerLine);
    // Same sampled orders in all three.
    expect(o.lines).toBe(c.lines);
  });

  it("never shrinks a face below the standard when sizing by velocity", () => {
    const now = faceSizesFor("current", layout, freq, std);
    const opt = faceSizesFor("optimized", layout, freq, std);
    for (const f of freq) expect(opt.get(f.sku.id)!).toBeGreaterThanOrEqual(Math.min(site.pick.faceCases, now.get(f.sku.id)!));
    expect([...opt.values()].some((v) => v > site.pick.faceCases)).toBe(true);
  });
});
