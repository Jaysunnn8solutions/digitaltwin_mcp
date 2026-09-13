import { PROCESS_SKILL, PROCESSES } from "../twin/types";
import { replicate } from "../twin/replicate";
import { calendarWeekOfDay } from "../twin/season";
import { buildTwin } from "../twin/twin";
import { baseShape, scenarioShape, splitScenario } from "./args";
import { daysSchema, dayLabel, dcName, fmt1, fmtInt, guarded, hours, kpiTable, money, pct, readOnlyOpenWorld, runsSchema, scenarioLine, text, z } from "./shared";

export const simulateOperationsConfig = {
  title: "Simulate the floor",
  description:
    "Run one center minute by minute for up to eight weeks from a calendar week: supplier trucks, unloading, receiving, putaway, replenishment, " +
    "picking, packing, loading and store trucks, with the crew, forklifts and doors. Reports service (late trucks, fill rate), labor (hours, overtime, " +
    "utilization, cost), flow (dock-to-stock, order cycle), each process's queue, each worker's day, the bottleneck, and a day-by-day table. " +
    "Accepts every scenario field: demand changes, a candystore store scenario, slotting, roster and cross-training, equipment, and disruptions.",
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

type Args = z.infer<typeof simulateOperationsConfig.inputSchema>;

export async function simulateOperationsHandler(args: Args) {
  return guarded(async () => {
    const { scenario, rest } = splitScenario(args);
    const { dc, startWeek, days, runs } = rest as { dc: string; startWeek: number; days: number; runs: number };
    const ctx = await buildTwin(dc, startWeek, scenario);
    const rep = replicate(ctx, days, runs);
    const first = rep.runs[0];
    const k = rep.mean;

    const procRows = PROCESSES.map((p) => {
      const jobs = rep.runs.reduce((a, r) => a + r.processes[p].jobs, 0) / runs;
      const busy = rep.runs.reduce((a, r) => a + r.processes[p].busyMin, 0) / runs;
      const wait = rep.runs.reduce((a, r) => a + r.processes[p].waitTotalMin, 0) / runs;
      const eq = rep.runs.reduce((a, r) => a + r.processes[p].equipmentWaitMin, 0) / runs;
      const maxQ = Math.max(...rep.runs.map((r) => r.processes[p].maxQueue));
      const maxWait = Math.max(...rep.runs.map((r) => r.processes[p].waitMaxMin));
      return `| ${p} | ${PROCESS_SKILL[p]} | ${fmt1(jobs)} | ${fmt1(busy / 60)} | ${jobs ? hours(wait / jobs) : "—"} | ${hours(maxWait)} | ${maxQ} | ${wait > 0 ? pct(eq / wait) : "—"} |`;
    });

    const workerRows = first.workers.map((w) => {
      const top = Object.entries(w.byProcess).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, m]) => `${p} ${fmt1(m / 60)}h`).join(", ");
      const prim = Object.entries(w.primaries).map(([s, n]) => `${s}×${n}`).join(", ");
      return `| ${w.id} | ${w.role} | ${w.shiftsWorked} | ${w.absences} | ${fmt1(w.paidHours + w.overtimeHours)} | ${fmt1(w.overtimeHours)} | ${w.paidHours ? pct(w.busyHours / (w.paidHours + w.overtimeHours)) : "—"} | ${prim || "—"} | ${top || "—"} |`;
    });

    const dayRows = first.daily
      .filter((d) => d.orders > 0 || d.inboundTrucks > 0 || d.trucksLate > 0)
      .map((d) => `| ${dayLabel(d.day)} | wk ${d.calendarWeek} | ${d.orders} | ${fmtInt(d.lines)} | ${fmtInt(d.innersShipped)} | ${fmtInt(d.cutInners)} | ${d.inboundTrucks}/${d.inboundPallets} | ${d.trucksLate}${d.lateMin ? ` (${hours(d.lateMin)})` : ""} | ${fmt1(d.overtimeHours)} | ${d.absences} |`);

    const late = first.trucks.filter((t) => t.lateMin > 0).sort((a, b) => b.lateMin - a.lateMin).slice(0, 5);
    const endWeek = calendarWeekOfDay(startWeek, days - 1);
    const b = rep.bottleneck;

    return text(
      [
        `# Operations at ${dcName(ctx)}: ${days} days from week ${startWeek}${endWeek !== startWeek ? ` to week ${endWeek}` : ""}, ${runs} run(s)`,
        scenarioLine(ctx),
        ``,
        kpiTable([["mean", k], ...(runs > 1 ? ([["worst run", rep.worst]] as Array<[string, typeof k]>) : [])]),
        ``,
        `**Bottleneck:** ${b.process ? `${b.process}, about ${fmt1(b.waitHours)} job-hours of floor-time waiting per run; ${b.constraint}.` : b.constraint}`,
        first.reserve.palletsNeededEnd > first.reserve.positions ? `**Reserve overflow:** stock needs ${first.reserve.palletsNeededEnd} pallet positions and the racks have ${first.reserve.positions}; the rest sits on the floor.` : `Reserve: ${first.reserve.palletsNeededEnd} of ${first.reserve.positions} pallet positions needed at the end of run 1.`,
        ``,
        `## Processes (mean per run)`,
        `| process | skill | jobs | busy h | avg wait | max wait | max queue | wait held by equipment |`,
        `|---|---|---:|---:|---:|---:|---:|---:|`,
        ...procRows,
        ``,
        `Waits are floor time: hours with nobody on shift are not counted, so work carried overnight shows as the shift minutes it sat.`,
        ``,
        `## Crew (run 1)`,
        `| worker | role | shifts | absent | paid h | OT h | busy | primary skill days | where the time went |`,
        `|---|---|---:|---:|---:|---:|---:|---|---|`,
        ...workerRows,
        ``,
        `## Days (run 1)`,
        `| day | week | store orders | lines | inners shipped | inners cut | inbound trucks/pallets | late trucks | OT h | absent |`,
        `|---|---|---:|---:|---:|---:|---|---|---:|---:|`,
        ...dayRows,
        late.length ? `\nLatest trucks in run 1: ${late.map((t) => `${t.store} ${dayLabel(t.day)} ${t.loadedAt === null ? "never loaded" : `${hours(t.lateMin)} late`}`).join("; ")}.` : ``,
        ``,
        `Dollars are candystore retail value. Inbound volume follows the buyers' ${ctx.policy.forecast} forecast at ${pct(ctx.policy.serviceLevel)} cycle service; the first weeks of stock come from an eight-week warm-up. ${money(k.cutDollars)} of orders were cut for lack of stock on average.`,
      ].join("\n")
    );
  });
}
