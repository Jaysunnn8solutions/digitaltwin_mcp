import { replicate } from "../twin/replicate";
import { buildTwin } from "../twin/twin";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { daysSchema, dcName, fmt1, guarded, kpiTable, readOnlyOpenWorld, runsSchema, scenarioLine, text, z } from "./shared";

export const whatIfConfig = {
  title: "Compare a scenario with the baseline",
  description:
    "Simulate one center twice over the same days with the same random draws, once as it is and once with the scenario, and report every KPI side by side " +
    "with the change and the bottleneck in each. Use it for a crew change, cross-training, an extra forklift or door, optimized slotting, a demand surge, " +
    "an outage, a supplier delay or a candystore store expansion.",
  inputSchema: z
    .object({
      ...baseShape,
      days: daysSchema.default(14),
      runs: runsSchema.default(3),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof whatIfConfig.inputSchema>;

export async function whatIfHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const { dc, startWeek, days, runs } = rest as { dc: string; startWeek: number; days: number; runs: number };
    const baseCtx = await buildTwin(dc, startWeek, {});
    const scenCtx = await buildTwin(dc, startWeek, scenario);
    if (scenCtx.changes.length === 0 && Object.keys(scenario).length === 0) {
      return text("No scenario fields were given, so there is nothing to compare. Add at least one, for example forklifts: 2, slotting: \"optimized\", or demandScale: 1.5.");
    }
    const base = replicate(baseCtx, days, runs);
    const scen = replicate(scenCtx, days, runs);
    const b = base.bottleneck;
    const s = scen.bottleneck;
    const lateDelta = scen.mean.lateTrucks - base.mean.lateTrucks;
    const costDelta = scen.mean.laborCost - base.mean.laborCost;
    const verdict: string[] = [];
    if (Math.abs(lateDelta) >= 0.5) verdict.push(`${lateDelta < 0 ? "removes" : "adds"} ${fmt1(Math.abs(lateDelta))} late truck(s) per run`);
    if (Math.abs(scen.mean.fillRate - base.mean.fillRate) >= 0.002) verdict.push(`fill rate ${scen.mean.fillRate > base.mean.fillRate ? "up" : "down"} ${(Math.abs(scen.mean.fillRate - base.mean.fillRate) * 100).toFixed(1)} points`);
    if (Math.abs(costDelta) >= 50) verdict.push(`labor cost ${costDelta > 0 ? "+" : "−"}$${Math.round(Math.abs(costDelta)).toLocaleString("en-US")} over ${days} days`);
    if (Math.abs(scen.mean.busyHours - base.mean.busyHours) >= 2) verdict.push(`${fmt1(Math.abs(scen.mean.busyHours - base.mean.busyHours))} ${scen.mean.busyHours < base.mean.busyHours ? "fewer" : "more"} busy labor hours`);

    return text(
      [
        `# What if, at ${dcName(scenCtx)}: ${days} days from week ${startWeek}, ${runs} run(s) each, same draws`,
        scenarioLine(scenCtx),
        ``,
        kpiTable([["baseline", base.mean], ["scenario", scen.mean]], true),
        ``,
        `**Bottleneck:** baseline ${b.process ? `${b.process} (${b.constraint})` : "none"}; scenario ${s.process ? `${s.process} (${s.constraint})` : "none"}.`,
        `**In short:** the scenario ${verdict.length ? verdict.join(", ") : "changes nothing material at this horizon"}.`,
        ``,
        `Means over runs. Demand draws, supplier arrivals and absences use the same seeds in both, so the difference is the scenario; a scenario that changes demand changes the draws it feeds.`,
      ].join("\n")
    );
  });
}
