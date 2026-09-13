import { replicate, type Replications } from "../twin/replicate";
import { seasonFactor } from "../twin/season";
import { buildTwin } from "../twin/twin";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { dcName, fmt1, guarded, money, pct, readOnlyOpenWorld, scenarioLine, text, z } from "./shared";

export const findCapacityConfig = {
  title: "Find the building's real capacity",
  description:
    "Scale candystore's demand for one center up (or down) until the building stops shipping on time, and report the most retail dollars a week it ships " +
    "within the service targets, what breaks first past that point, and how that compares with the weekly capacity candystore_mcp assumes for the center. " +
    "Takes any scenario, so it answers 'what does an extra forklift, a cross-trained crew or optimized slotting buy in capacity'.",
  inputSchema: z
    .object({
      dc: baseShape.dc,
      startWeek: z.number().int().min(1).max(52).default(20).describe("Calendar week to test in; week 20 is an ordinary week, 44 is Halloween."),
      days: z.number().int().min(7).max(28).default(14),
      runs: z.number().int().min(1).max(5).default(2),
      targetOnTime: z.number().min(0.5).max(1).default(0.95).describe("Minimum share of store trucks leaving on time."),
      targetFill: z.number().min(0.5).max(1).default(0.98).describe("Minimum fill rate."),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof findCapacityConfig.inputSchema>;

export async function findCapacityHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const r = rest as { dc: string; startWeek: number; days: number; runs: number; targetOnTime: number; targetFill: number };
    const baseScale = scenario.demandScale ?? 1;
    const probe = async (scale: number) => {
      const ctx = await buildTwin(r.dc, r.startWeek, { ...scenario, demandScale: Math.round(scale * 1000) / 1000 });
      const rep = replicate(ctx, r.days, r.runs);
      const ok = rep.mean.onTimeRate >= r.targetOnTime && rep.mean.fillRate >= r.targetFill && rep.worst.notLoaded === 0;
      return { scale, rep, ok, ctx };
    };

    const log: Array<{ scale: number; rep: Replications; ok: boolean }> = [];
    let lo = await probe(baseScale);
    log.push(lo);
    let hi = lo;
    if (lo.ok) {
      // Grow until it fails or demand reaches six times candystore's.
      let s = baseScale;
      while (hi.ok && s < 6) {
        s = Math.min(6, s * 1.5);
        hi = await probe(s);
        log.push(hi);
        if (hi.ok) lo = hi;
      }
    } else {
      let s = baseScale;
      while (!lo.ok && s > 0.15) {
        s = s / 1.5;
        lo = await probe(s);
        log.push(lo);
        if (!lo.ok) hi = lo;
      }
    }
    if (lo.ok && !hi.ok) {
      for (let i = 0; i < 4; i++) {
        const mid = await probe((lo.scale + hi.scale) / 2);
        log.push(mid);
        if (mid.ok) lo = mid;
        else hi = mid;
      }
    }

    const ctx = lo.ctx;
    const dc = ctx.network.dcs.find((d) => d.id === r.dc)!;
    const avgWeek = Object.values(dc.weeklyDemand).reduce((a, b) => a + b, 0);
    const season = seasonFactor(r.startWeek);
    const capacity = Object.values(dc.capacity).reduce((a, b) => a + b, 0);
    const shippedPerWeek = (x: { rep: Replications }) => (x.rep.mean.shippedDollars / r.days) * 7;
    const rows = [...log]
      .sort((a, b) => a.scale - b.scale)
      .map((x) => `| ×${x.scale.toFixed(2)} | ${money(shippedPerWeek(x))} | ${pct(x.rep.mean.onTimeRate)} | ${(x.rep.mean.fillRate * 100).toFixed(1)}% | ${fmt1(x.rep.mean.overtimeHours)} | ${pct(x.rep.mean.utilization)} | ${x.rep.bottleneck.process ?? "—"} | ${x.ok ? "meets" : "misses"} |`);

    const lines = [
      `# Capacity of ${dcName(ctx)} in week ${r.startWeek}`,
      scenarioLine(await buildTwin(r.dc, r.startWeek, scenario)),
      `Targets: ${pct(r.targetOnTime)} of trucks on time, ${pct(r.targetFill)} fill, every truck loaded. ${r.runs} run(s) of ${r.days} days per probe.`,
      ``,
    ];
    if (!lo.ok) {
      lines.push(`**The building misses the targets even at ×${lo.scale.toFixed(2)} of candystore's demand.** Something other than volume is broken in this scenario; run simulate_operations to see what.`);
    } else {
      const maxWeekly = shippedPerWeek(lo);
      const atAverage = maxWeekly / season;
      lines.push(
        `**Ships up to about ${money(maxWeekly)}/week of retail value on time** (×${lo.scale.toFixed(2)} candystore's demand${hi.ok ? ", the top of the search range" : ""}). In an average-season week that is about ${money(atAverage)}.`,
        `candystore routes ${money(avgWeek)}/week to this center today and assumes it can ship ${money(capacity)}/week. By the twin, the building's limit is ${pct(atAverage / capacity)} of that assumption${atAverage < capacity ? `, so candystore's supply cap is optimistic for this crew and building` : `, so candystore's cap binds before the building does`}.`,
        hi.ok ? `` : `**What breaks first** past ×${lo.scale.toFixed(2)}: ${hi.rep.bottleneck.process ? `${hi.rep.bottleneck.process} (${hi.rep.bottleneck.constraint})` : "no single process"}; at ×${hi.scale.toFixed(2)} on-time falls to ${pct(hi.rep.mean.onTimeRate)} and fill to ${(hi.rep.mean.fillRate * 100).toFixed(1)}%.`
      );
    }
    lines.push(``, `| demand | shipped/week | on time | fill | OT h | utilization | bottleneck | targets |`, `|---|---:|---:|---:|---:|---:|---|---|`, ...rows, ``, `Demand scales every store's candystore dollars; buyers' forecasts scale with it, so the limit found is the floor's, not a stock-out artifact. Overtime is capped at ${ctx.scenario.overtimeMaxHours ?? 2} h a person a day.`);
    return text(lines.join("\n"));
  });
}
