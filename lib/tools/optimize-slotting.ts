import { replicate } from "../twin/replicate";
import {
  currentSlotting,
  evaluateSlotting,
  faceSizesFor,
  optimizedSlotting,
  partialSlotting,
  replenishmentsPerWeek,
  slotCostFt,
  type Slotting,
} from "../twin/slotting";
import { buildTwin, dcSchema, scenarioShape } from "../twin/twin";
import { avgReplenMinutes } from "../twin/workforce";
import { dcName, fmt1, fmtInt, guarded, hours, pct, readOnlyOpenWorld, text, z } from "./shared";

export const optimizeSlottingConfig = {
  title: "Optimize slotting",
  description:
    "Re-slot one center's pick faces by velocity and size each face to a week of demand. Compares the current slotting, a partial re-slot limited to " +
    "maxMoves swaps, and the full optimum: walking per line, picks off the golden levels, picker-hours and forklift replenishments per week, the labor to " +
    "make the moves and the payback, the top moves to make first, and a simulation of the floor before and after.",
  inputSchema: z
    .object({
      dc: dcSchema,
      maxMoves: z.number().int().min(1).max(200).default(30).describe("Swaps allowed in the partial re-slot; each swap moves two SKUs."),
      minutesPerMove: z.number().min(1).max(60).default(15).describe("Labor to move one SKU's stock to its new face."),
      listMoves: z.number().int().min(0).max(40).default(12),
      validate: z.boolean().default(true).describe("Also simulate two weeks of the floor with the current and the optimized slotting."),
      startWeek: z.number().int().min(1).max(52).default(36),
      demandScale: scenarioShape.demandScale,
      candystore: scenarioShape.candystore,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof optimizeSlottingConfig.inputSchema>;

export async function optimizeSlottingHandler(args: Args) {
  return guarded(async () => {
    const demand = { demandScale: args.demandScale, candystore: args.candystore };
    const ctx = await buildTwin(args.dc, args.startWeek, demand);
    const { layout, catalog, model, std, frequencies: freq, workloadContext } = ctx;
    const current = currentSlotting(layout, catalog);
    const optimal = optimizedSlotting(layout, catalog, freq, std);
    const partial = partialSlotting(layout, current, optimal, freq, std, args.maxMoves);
    const facesNow = faceSizesFor("current", layout, freq, std);
    const facesOpt = faceSizesFor("optimized", layout, freq, std);
    const replenMin = avgReplenMinutes(workloadContext);

    const evalOf = (s: Slotting, faces: typeof facesNow) => {
      const e = evaluateSlotting(layout, s, model, catalog, std);
      const replens = replenishmentsPerWeek(freq, faces);
      return { e, replens, laborH: e.pickMinutesPerWeek / 60 + (replens * replenMin) / 60 };
    };
    const moved = (s: Slotting) => [...s].filter(([sku, loc]) => current.get(sku)!.id !== loc.id).length;
    const cur = evalOf(current, facesNow);
    const par = evalOf(partial, facesOpt);
    const opt = evalOf(optimal, facesOpt);
    const option = (label: string, x: typeof cur, s: Slotting) => {
      const moves = moved(s);
      const moveH = (moves * args.minutesPerMove) / 60;
      const saved = cur.laborH - x.laborH;
      return `| ${label} | ${moves} | ${fmt1(x.e.feetPerLine)} | ${pct(x.e.bendReachShare)} | ${fmt1(x.e.pickMinutesPerWeek / 60)} | ${fmtInt(x.replens)} | ${fmt1(x.laborH)} | ${fmt1(saved)} | ${fmt1(moveH)} | ${saved > 0.05 && moves > 0 ? `${fmt1(moveH / saved)} wk` : "—"} |`;
    };

    const f = new Map(freq.map((x) => [x.sku.id, x]));
    const topMoves = freq
      .map((x) => {
        const from = current.get(x.sku.id)!;
        const to = optimal.get(x.sku.id)!;
        return { x, from, to, gain: x.linesPerWeek * (slotCostFt(layout, from, std) - slotCostFt(layout, to, std)) };
      })
      .filter((m) => m.from.id !== m.to.id && m.gain > 0)
      .sort((a, b) => b.gain - a.gain)
      .slice(0, args.listMoves)
      .map((m) => `| ${m.x.sku.id} | ${m.x.sku.name} | ${fmt1(f.get(m.x.sku.id)!.linesPerWeek)} | ${m.from.id} (L${m.from.level}) | ${m.to.id} (L${m.to.level}) | ${facesNow.get(m.x.sku.id)} → ${facesOpt.get(m.x.sku.id)} | ${fmtInt(m.gain)} |`);

    const lines = [
      `# Slotting at ${dcName(ctx)}`,
      ``,
      `Ordinary-week demand${args.demandScale ? ` ×${args.demandScale}` : ""}; ${freq.filter((x) => x.linesPerWeek > 0).length} SKUs with demand in ${layout.pick.length} faces.`,
      ``,
      `| option | SKUs moved | ft walked/line | lines off golden levels | picker h/wk | replenishments/wk | pick + replen h/wk | h/wk saved | move labor h | payback |`,
      `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
      option("current", cur, current),
      option(`partial (${args.maxMoves} swaps)`, par, partial),
      option("full optimum", opt, optimal),
      ``,
      `Face sizes in both optimized options hold ${std.faceDaysOfSupply} days of demand, between the standard ${ctx.site.pick.faceCases} cases and what the slot holds; resizing a face is counted with the move.`,
      ``,
      `## First moves`,
      `| SKU | product | lines/wk | from | to | face cases | ft/wk saved |`,
      `|---|---|---:|---|---|---|---:|`,
      ...topMoves,
    ];

    if (args.validate) {
      const before = replicate(await buildTwin(args.dc, args.startWeek, { ...demand }), 14, 2);
      const after = replicate(await buildTwin(args.dc, args.startWeek, { ...demand, slotting: "optimized" }), 14, 2);
      lines.push(
        ``,
        `## On the floor (two weeks from week ${args.startWeek}, 2 runs, full optimum)`,
        `| KPI | current | optimized |`,
        `|---|---:|---:|`,
        `| Busy labor hours | ${fmt1(before.mean.busyHours)} | ${fmt1(after.mean.busyHours)} |`,
        `| Overtime hours | ${fmt1(before.mean.overtimeHours)} | ${fmt1(after.mean.overtimeHours)} |`,
        `| Replenishments (hot) | ${fmt1(before.mean.replenishments)} (${fmt1(before.mean.hotReplenishments)}) | ${fmt1(after.mean.replenishments)} (${fmt1(after.mean.hotReplenishments)}) |`,
        `| Order cycle (floor time) | ${hours(before.mean.orderCycleAvgMin)} | ${hours(after.mean.orderCycleAvgMin)} |`,
        `| Dock-to-stock | ${hours(before.mean.dockToStockAvgMin)} | ${hours(after.mean.dockToStockAvgMin)} |`,
        `| Late trucks | ${fmt1(before.mean.lateTrucks)} | ${fmt1(after.mean.lateTrucks)} |`,
        `| Forklift utilization | ${pct(before.mean.forkliftUtilization)} | ${pct(after.mean.forkliftUtilization)} |`
      );
    }
    lines.push(``, `Walking comes from S-shape tours over four sampled weeks of orders; in a building this small most pick time is handling, so the bend-and-reach and replenishment savings matter as much as the feet.`);
    return text(lines.join("\n"));
  });
}
