import { loadCatalog, findSite, loadRoster } from "../data/load";
import { runOperations } from "../twin/operations";
import { kpis, type Kpis } from "../twin/replicate";
import { buildTwin, operationsOptions, type TwinScenario } from "../twin/twin";
import { mean, quantile, randInt, seededRandom } from "../util/random";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { dcName, fmt1, guarded, hours, money, pct, readOnlyOpenWorld, scenarioLine, text, z } from "./shared";

export const stressTestConfig = {
  title: "Stress-test against random disruptions",
  description:
    "Monte Carlo over disruptions: each run draws its own forklift breakdowns, door failures, warehouse-system outages, workers out sick for days, " +
    "supplier delays and short demand surges at the given rates, on top of daily absenteeism, and simulates the center. Reports the distribution of late trucks, " +
    "fill rate, overtime and cost, how often each kind of disruption hit, how much worse runs were with it than without, and the worst run's story.",
  inputSchema: z
    .object({
      ...baseShape,
      days: z.number().int().min(5).max(56).default(20),
      runs: z.number().int().min(10).max(60).default(30),
      forkliftFailurePerDay: z.number().min(0).max(0.5).default(0.03).describe("Chance each forklift breaks on a given day; repair takes 1–2 days."),
      doorFailurePerDay: z.number().min(0).max(0.5).default(0.01).describe("Chance a dock door fails on a given day; repair takes 1–3 days."),
      wmsOutagePerDay: z.number().min(0).max(0.5).default(0.02).describe("Chance of a warehouse-system outage of 1–4 hours on a given day."),
      sickLeavePerWeek: z.number().min(0).max(0.5).default(0.04).describe("Chance each worker is out 2–5 days in a given week."),
      supplierDelayPerWeek: z.number().min(0).max(0.5).default(0.05).describe("Chance each supplier's orders placed in a week arrive 3–10 days late."),
      surgePerWeek: z.number().min(0).max(1).default(0.1).describe("Chance of a 2–4 day demand surge of 20–50% in a given week."),
      ...scenarioShape,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof stressTestConfig.inputSchema>;

type Kind = "forklift" | "door" | "wms" | "sick" | "supplier" | "surge";
const KIND_LABEL: Record<Kind, string> = { forklift: "forklift breakdown", door: "door failure", wms: "system outage", sick: "worker out sick", supplier: "supplier delay", surge: "demand surge" };

export async function stressTestHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const r = rest as { dc: string; startWeek: number; days: number; runs: number; forkliftFailurePerDay: number; doorFailurePerDay: number; wmsOutagePerDay: number; sickLeavePerWeek: number; supplierDelayPerWeek: number; surgePerWeek: number };
    const site = findSite(r.dc);
    const suppliers = loadCatalog().suppliers;
    const baseCtx = await buildTwin(r.dc, r.startWeek, scenario);
    const workers = baseCtx.workers.length ? baseCtx.workers : loadRoster().workers.filter((w) => w.dc === r.dc);
    const forklifts = scenario.forklifts ?? site.equipment.forklifts;
    const doors = { inbound: scenario.inboundDoors ?? site.doors.inbound, outbound: scenario.outboundDoors ?? site.doors.outbound };

    const results: Array<{ k: Kpis; hits: Set<Kind>; story: string[] }> = [];
    for (let run = 0; run < r.runs; run++) {
      const rng = seededRandom(9000 + run);
      const s: TwinScenario = structuredClone(scenario);
      const hits = new Set<Kind>();
      const story: string[] = [];
      for (let d = 0; d < r.days; d++) {
        if (!site.operatingDays.includes((d % 7) + 1)) continue;
        for (let f = 0; f < forklifts; f++) {
          if (rng() < r.forkliftFailurePerDay) {
            const len = randInt(rng, 1, 2);
            (s.forkliftOutages ??= []).push({ count: 1, fromDay: d, toDay: d + len - 1 });
            hits.add("forklift");
            story.push(`forklift down days ${d}–${d + len - 1}`);
          }
        }
        for (const kind of ["inbound", "outbound"] as const) {
          for (let i = 0; i < doors[kind]; i++) {
            if (rng() < r.doorFailurePerDay) {
              const len = randInt(rng, 1, 3);
              (s.doorOutages ??= []).push({ kind, count: 1, fromDay: d, toDay: d + len - 1 });
              hits.add("door");
              story.push(`${kind} door down days ${d}–${d + len - 1}`);
            }
          }
        }
        if (rng() < r.wmsOutagePerDay) {
          const h = randInt(rng, 1, 4);
          const start = `${String(randInt(rng, 6, 12)).padStart(2, "0")}:00`;
          (s.wmsOutages ??= []).push({ day: d, start, hours: h });
          hits.add("wms");
          story.push(`system down day ${d} ${start} for ${h} h`);
        }
      }
      for (let w = 0; w * 7 < r.days; w++) {
        for (const worker of workers) {
          if (rng() < r.sickLeavePerWeek) {
            const from = w * 7 + randInt(rng, 0, 4);
            const to = from + randInt(rng, 1, 4);
            (s.workerLeave ??= []).push({ worker: worker.id, fromDay: from, toDay: to });
            hits.add("sick");
            story.push(`${worker.id} (${worker.role}) out days ${from}–${to}`);
          }
        }
        for (const sup of suppliers) {
          if (rng() < r.supplierDelayPerWeek) {
            const extra = randInt(rng, 3, 10);
            (s.supplierDelays ??= []).push({ supplier: sup.id, extraDays: extra, fromDay: w * 7 - 14, toDay: w * 7 + 6 });
            hits.add("supplier");
            story.push(`${sup.name} +${extra} days`);
          }
        }
        if (rng() < r.surgePerWeek) {
          const from = w * 7 + randInt(rng, 0, 3);
          const len = randInt(rng, 2, 4);
          const factor = Math.round((1.2 + rng() * 0.3) * 100) / 100;
          (s.demandShocks ??= []).push({ fromDay: from, toDay: from + len - 1, factor });
          hits.add("surge");
          story.push(`demand ×${factor} days ${from}–${from + len - 1}`);
        }
      }
      // Clamp windows into the schema's range (supplier delays can start before day 0).
      for (const d of s.supplierDelays ?? []) d.fromDay = Math.max(0, d.fromDay);
      const ctx = await buildTwin(r.dc, r.startWeek, s);
      const res = runOperations(ctx, operationsOptions(ctx, r.days, 500 + run));
      results.push({ k: kpis(res), hits, story });
    }

    const col = (f: (k: Kpis) => number) => results.map((x) => f(x.k));
    const late = col((k) => k.lateTrucks);
    const anyLate = results.filter((x) => x.k.lateTrucks > 0).length / results.length;
    const attribution = (Object.keys(KIND_LABEL) as Kind[]).map((kind) => {
      const withK = results.filter((x) => x.hits.has(kind));
      const without = results.filter((x) => !x.hits.has(kind));
      const lw = withK.length ? mean(withK.map((x) => x.k.lateTrucks)) : NaN;
      const lo = without.length ? mean(without.map((x) => x.k.lateTrucks)) : NaN;
      const fw = withK.length ? mean(withK.map((x) => x.k.fillRate)) : NaN;
      const fo = without.length ? mean(without.map((x) => x.k.fillRate)) : NaN;
      return `| ${KIND_LABEL[kind]} | ${pct(withK.length / results.length)} | ${Number.isNaN(lw) ? "—" : fmt1(lw)} | ${Number.isNaN(lo) ? "—" : fmt1(lo)} | ${Number.isNaN(fw) ? "—" : `${(fw * 100).toFixed(1)}%`} | ${Number.isNaN(fo) ? "—" : `${(fo * 100).toFixed(1)}%`} |`;
    });
    const worst = [...results].sort((a, b) => b.k.lateMinTotal - a.k.lateMinTotal || a.k.fillRate - b.k.fillRate)[0];
    const row = (label: string, f: (k: Kpis) => number, fmt: (v: number) => string, lowIsBad = false) => {
      const xs = col(f);
      return `| ${label} | ${fmt(mean(xs))} | ${fmt(quantile(xs, 0.5))} | ${fmt(quantile(xs, lowIsBad ? 0.1 : 0.9))} | ${fmt(lowIsBad ? Math.min(...xs) : Math.max(...xs))} |`;
    };

    return text(
      [
        `# Stress test at ${dcName(baseCtx)}: ${r.runs} runs of ${r.days} days from week ${r.startWeek}`,
        scenarioLine(baseCtx),
        `Rates: forklift ${pct(r.forkliftFailurePerDay)}/day, door ${pct(r.doorFailurePerDay)}/day, system outage ${pct(r.wmsOutagePerDay)}/day, sick leave ${pct(r.sickLeavePerWeek)} per worker-week, supplier delay ${pct(r.supplierDelayPerWeek)} per supplier-week, demand surge ${pct(r.surgePerWeek)}/week; daily absenteeism ${pct(baseCtx.scenario.absenteeism ?? 0.04)}.`,
        ``,
        `**Runs with at least one late truck: ${pct(anyLate)}.** Late trucks per run: median ${fmt1(quantile(late, 0.5))}, 90th percentile ${fmt1(quantile(late, 0.9))}, worst ${fmt1(Math.max(...late))}.`,
        ``,
        `| KPI | mean | median | bad tail (p90, or p10) | worst |`,
        `|---|---:|---:|---:|---:|`,
        row("Late trucks", (k) => k.lateTrucks, fmt1),
        row("Late time, total", (k) => k.lateMinTotal, hours),
        row("Fill rate", (k) => k.fillRate, (v) => `${(v * 100).toFixed(1)}%`, true),
        row("Retail $ cut", (k) => k.cutDollars, money),
        row("Overtime hours", (k) => k.overtimeHours, fmt1),
        row("Labor cost", (k) => k.laborCost, money),
        row("Dock-to-stock avg", (k) => k.dockToStockAvgMin, hours),
        ``,
        `| disruption | share of runs hit | late trucks when hit | when not | fill when hit | when not |`,
        `|---|---:|---:|---:|---:|---:|`,
        ...attribution,
        ``,
        `**Worst run** (${fmt1(worst.k.lateTrucks)} late trucks, ${hours(worst.k.lateMinTotal)} late in total, fill ${(worst.k.fillRate * 100).toFixed(1)}%): ${worst.story.length ? worst.story.join("; ") : "no drawn disruptions; absences and demand alone"}.`,
        ``,
        `Hit-versus-not compares runs, not causes: a run can carry several disruptions, so read a large gap as a lead to test with what_if.`,
      ].join("\n")
    );
  });
}
