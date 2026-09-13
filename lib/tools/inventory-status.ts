import { expectedDailyInners } from "../twin/demand";
import { runInventory } from "../twin/inventory";
import { buildTwin, dcSchema, scenarioShape } from "../twin/twin";
import { dcName, fmt1, fmtInt, guarded, money, pct, readOnlyOpenWorld, scenarioLine, text, z } from "./shared";

export const inventoryStatusConfig = {
  title: "Inventory status and projection",
  description:
    "Stock at one center at the start of a week (after an eight-week warm-up of the buyers' policy) and projected forward: value on hand by category, " +
    "days of supply, open purchase orders, weekly shipments, cuts and receipts, reserve pallet space against rack positions, the SKUs that will run out " +
    "and why, and the same horizon under the other forecast method. Takes forecast, serviceLevel, supplierDelays, demand changes and a candystore scenario.",
  inputSchema: z
    .object({
      dc: dcSchema,
      startWeek: z.number().int().min(1).max(52).default(36),
      weeks: z.number().int().min(1).max(26).default(10),
      category: z.string().max(40).optional().describe("Limit the SKU lists to one category, e.g. traditional or specialty:latam."),
      top: z.number().int().min(3).max(40).default(10),
      forecast: scenarioShape.forecast,
      serviceLevel: scenarioShape.serviceLevel,
      supplierDelays: scenarioShape.supplierDelays,
      demandScale: scenarioShape.demandScale,
      demandShocks: scenarioShape.demandShocks,
      candystore: scenarioShape.candystore,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof inventoryStatusConfig.inputSchema>;

export async function inventoryStatusHandler(args: Args) {
  return guarded(async () => {
    const { dc, startWeek, weeks, category, top, ...scenario } = args;
    const ctx = await buildTwin(dc, startWeek, scenario);
    const { model, catalog, site, policy, costs } = ctx;
    if (category && !catalog.skus.some((s) => s.category === category)) {
      return text(`Unknown category "${category}". Categories: ${[...new Set(catalog.skus.map((s) => s.category))].join(", ")}.`);
    }
    const days = weeks * 7;
    const opts = { startWeek, warmupWeeks: 8, policy, delays: ctx.supplierDelays, seed: 3, faceCases: site.pick.faceCases };
    const snap = runInventory(model, catalog, { ...opts, days: 0 }).book;
    const run = runInventory(model, catalog, { ...opts, days });
    const other = runInventory(model, catalog, { ...opts, days, policy: { ...policy, forecast: policy.forecast === "seasonal" ? "trailing" : "seasonal" } });
    const suppliers = new Map(catalog.suppliers.map((s) => [s.id, s]));

    // Snapshot by category.
    const next7 = expectedDailyInners(model, 0, 7, startWeek);
    const cats = new Map<string, { retail: number; daily: number; skus: number; zero: number }>();
    for (const s of snap.skus.values()) {
      const d = next7.get(s.sku.id) ?? 0;
      if (d === 0 && s.onHand === 0) continue;
      const c = cats.get(s.sku.category) ?? { retail: 0, daily: 0, skus: 0, zero: 0 };
      c.retail += s.onHand * s.sku.innerRetail;
      c.daily += d * s.sku.innerRetail;
      c.skus++;
      if (s.onHand === 0 && d > 0) c.zero++;
      cats.set(s.sku.category, c);
    }
    const catRows = [...cats].sort((a, b) => b[1].retail - a[1].retail).map(([c, v]) => `| ${c} | ${v.skus} | ${money(v.retail)} | ${money(v.retail * costs.costOfGoods)} | ${v.daily > 0 ? fmt1(v.retail / v.daily) : "—"} | ${v.zero} |`);

    const openBySupplier = new Map<string, { pos: number; pallets: number; first: number }>();
    for (const po of snap.open) {
      const o = openBySupplier.get(po.supplier) ?? { pos: 0, pallets: 0, first: Infinity };
      o.pos++;
      o.pallets += po.pallets;
      o.first = Math.min(o.first, po.arriveDay);
      openBySupplier.set(po.supplier, o);
    }
    const poRows = [...openBySupplier].map(([id, o]) => `| ${suppliers.get(id)?.name ?? id} | ${suppliers.get(id)?.leadDays} d | ${o.pos} | ${o.pallets} | day ${o.first} |`);

    const weekRows: string[] = [];
    for (let w = 0; w < weeks; w++) {
      const rows = run.daily.filter((d) => Math.floor(d.day / 7) === w);
      if (!rows.length) continue;
      const shipped = rows.reduce((a, d) => a + d.shipped, 0);
      const cut = rows.reduce((a, d) => a + d.cut, 0);
      const rec = rows.reduce((a, d) => a + d.receivedPallets, 0);
      const pallets = Math.max(...rows.map((d) => d.palletsNeeded));
      weekRows.push(`| ${rows[0].calendarWeek} | ${fmtInt(shipped)} | ${fmtInt(cut)} | ${shipped + cut ? `${((shipped / (shipped + cut)) * 100).toFixed(1)}%` : "—"} | ${rec} | ${money(rows[rows.length - 1].onHandRetail)} | ${pallets}${pallets > ctx.layout.reserve.length ? " (over)" : ""} |`);
    }

    const cutRows = [...run.book.cuts]
      .map(([id, n]) => ({ s: run.book.skus.get(id)!.sku, n }))
      .filter((x) => !category || x.s.category === category)
      .sort((a, b) => b.n * b.s.innerRetail - a.n * a.s.innerRetail)
      .slice(0, top)
      .map((x) => {
        const sup = suppliers.get(x.s.supplier)!;
        return `| ${x.s.id} | ${x.s.name} | ${x.s.category} | ${fmtInt(x.n)} | ${money(x.n * x.s.innerRetail)} | ${sup.name}, ${sup.leadDays} d lead |`;
      });

    const t = run.book.totals;
    const o = other.book.totals;
    const fill = (x: typeof t) => (x.orderedInners ? x.shippedInners / x.orderedInners : 1);
    return text(
      [
        `# Inventory at ${dcName(ctx)} from week ${startWeek}, ${weeks} weeks`,
        scenarioLine(ctx),
        `Policy: periodic review on each supplier's order day, order-up-to with a ${policy.forecast} forecast and ${pct(policy.serviceLevel)} cycle service.`,
        ``,
        `## On hand at the start of week ${startWeek}`,
        `Total ${money(snap.retailValue())} retail (${money(snap.retailValue() * costs.costOfGoods)} at cost); stock needs ${snap.palletsNeeded(site.pick.faceCases)} of ${ctx.layout.reserve.length} reserve pallet positions.`,
        ``,
        `| category | SKUs | retail on hand | at cost | days of supply | SKUs at zero |`,
        `|---|---:|---:|---:|---:|---:|`,
        ...catRows,
        ``,
        `| open POs from | lead time | POs | pallets | first arrival |`,
        `|---|---|---:|---:|---|`,
        ...(poRows.length ? poRows : ["| none | | | | |"]),
        ``,
        `## Projection`,
        `Fill ${(fill(t) * 100).toFixed(2)}%: ${money(t.shippedDollars)} shipped, ${money(t.cutDollars)} cut on ${fmtInt(t.cutLines)} fully cut lines; ${t.receipts} receipts, ${t.receivedPallets} pallets.`,
        `With a ${policy.forecast === "seasonal" ? "trailing" : "seasonal"} forecast instead: fill ${(fill(o) * 100).toFixed(2)}%, ${money(o.cutDollars)} cut, ${o.receivedPallets} pallets received.`,
        ``,
        `| week | inners shipped | inners cut | fill | pallets received | retail on hand (end) | reserve pallets needed (peak) |`,
        `|---|---:|---:|---:|---:|---:|---:|`,
        ...weekRows,
        ``,
        cutRows.length ? `## Stockouts${category ? ` in ${category}` : ""}, largest first` : `No SKU${category ? ` in ${category}` : ""} runs out over the horizon.`,
        ...(cutRows.length ? [`| SKU | product | category | inners cut | retail cut | supplier |`, `|---|---|---|---:|---:|---|`, ...cutRows] : []),
        ``,
        `This is the daily model: receipts are available the day they land and orders ship the day they release. Dock-to-stock delays and pick-face shortages come from simulate_operations.`,
      ].join("\n")
    );
  });
}
