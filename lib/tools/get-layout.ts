import { layoutSpecSchema, type LayoutSpec } from "../layout/spec";
import { GOLDEN_LEVELS } from "../twin/layout";
import { replenishmentsPerWeek, slotCostFt } from "../twin/slotting";
import { buildTwin, dcSchema } from "../twin/twin";
import { fmt1, fmtInt, guarded, pct, readOnly, text, z } from "./shared";

export const getLayoutConfig = {
  title: "Building layout and slotting",
  description:
    "One center's floor: zones, pick faces and reserve positions with how full they are, doors, equipment, the fastest-moving SKUs and where they sit, " +
    "how much picking happens outside the golden levels, and the pick-face sizes. Use slotting \"optimized\" to see the velocity layout instead of the current one.",
  inputSchema: z
    .object({
      dc: dcSchema,
      layout: layoutSpecSchema.optional(),
      slotting: z.enum(["current", "optimized"]).default("current"),
      top: z.number().int().min(5).max(50).default(15).describe("How many of the fastest SKUs to list."),
    })
    .strict(),
  annotations: readOnly,
};

export async function getLayoutHandler(args: { dc: string; layout?: LayoutSpec; slotting: "current" | "optimized"; top: number }) {
  return guarded(async () => {
    const ctx = await buildTwin(args.dc, 36, { slotting: args.slotting, layout: args.layout });
    const { site, layout, slotting, faces, frequencies: freq, std, slotEval } = ctx;
    const withDemand = freq.filter((f) => f.linesPerWeek > 0);
    const dead = freq.length - withDemand.length;
    const ranked = [...freq].sort((a, b) => b.linesPerWeek - a.linesPerWeek);
    const totalLines = freq.reduce((a, f) => a + f.linesPerWeek, 0);
    const goldenLines = freq.reduce((a, f) => a + (GOLDEN_LEVELS.has(slotting.get(f.sku.id)!.level) ? f.linesPerWeek : 0), 0);
    const topShare = ranked.slice(0, Math.ceil(ranked.length * 0.2)).reduce((a, f) => a + f.linesPerWeek, 0) / Math.max(1, totalLines);

    const rows = ranked.slice(0, args.top).map((f, i) => {
      const loc = slotting.get(f.sku.id)!;
      return `| ${i + 1} | ${f.sku.id} | ${f.sku.name} | ${fmt1(f.linesPerWeek)} | ${fmtInt(f.innersPerWeek)} | ${loc.id} | ${loc.level}${GOLDEN_LEVELS.has(loc.level) ? " (golden)" : ""} | ${fmtInt(slotCostFt(layout, loc, std))} | ${faces.get(f.sku.id)} |`;
    });

    return text(
      [
        `# ${ctx.network.dcs.find((d) => d.id === site.id)?.name} (${site.id}) — ${args.slotting} slotting`,
        ``,
        `**Building** ${Math.round(site.building.widthFt)}×${Math.round(site.building.depthFt)} ft${args.layout ? ` (imported from ${args.layout.source.format.toUpperCase()}${args.layout.source.file ? ` ${args.layout.source.file}` : ""})` : ""}. Doors: ${layout.doors.map((d) => d.id).join(", ")}. Equipment: ${site.equipment.forklifts} forklift(s), ${site.equipment.palletJacks} pallet jacks.`,
        `**Pick zone** ${layout.pickAisles.length} aisles, ${new Set(layout.pick.map((l) => l.level)).size} levels: ${layout.pick.length} faces for ${freq.length} SKUs (${pct(freq.length / layout.pick.length)} occupied); ${Math.round(layout.pickAisleLength)} ft between the front and back cross aisles; depot in the front cross aisle.`,
        `**Reserve** ${layout.reserveAisles.length} aisles: ${layout.reserve.length} pallet positions.`,
        ``,
        `**Velocity:** the fastest 20% of SKUs take ${pct(topShare)} of pick lines. ${dead} SKU(s) sell nothing through this center and still hold a face.`,
        `**Picking:** ${pct(goldenLines / Math.max(1, totalLines))} of lines come from golden levels 2–3; ${fmt1(slotEval.feetPerLine)} ft walked per line; ${fmt1(slotEval.linesPerHour)} lines per picker-hour at standard; ${fmtInt(slotEval.pickMinutesPerWeek / 60)} picker-hours in an ordinary week.`,
        `**Pick faces:** ${args.slotting === "current" ? `every SKU gets ${site.pick.faceCases} master cases` : `sized to ${std.faceDaysOfSupply} days of demand, ${site.pick.faceCases}–${Math.max(...faces.values())} cases`}; about ${fmtInt(replenishmentsPerWeek(freq, faces))} forklift replenishments in an ordinary week.`,
        ``,
        `| # | SKU | product | lines/wk | inners/wk | face | level | slot cost ft | face cases |`,
        `|---|---|---|---:|---:|---|---|---:|---:|`,
        ...rows,
        ``,
        `Slot cost is walking feet from the depot plus the bend-or-reach penalty outside the golden levels (${std.pickBendReachSec}s a line, as feet). Face ids read P<aisle>-<side><bay>-<level>.`,
      ].join("\n")
    );
  });
}
