import { replicate } from "../twin/replicate";
import { buildTwin, dcSchema, scenarioShape } from "../twin/twin";
import { planLabor } from "../twin/workforce";
import { dcName, fmt1, fmtInt, guarded, money, pct, readOnlyOpenWorld, scenarioLine, text, z } from "./shared";

export const planLaborConfig = {
  title: "Plan labor through the season",
  description:
    "Week by week for up to 26 weeks: labor hours each skill needs from candystore's seasonal volume and the engineered standards, what the roster covers, " +
    "the gap, and how to close it (overtime, agency temps, and the forklift hours only cross-training or hiring can fix, with their lead times), with the cost. " +
    "Then simulates the heaviest week with the roster as it is and with the plan's temps added, to check the plan on the floor.",
  inputSchema: z
    .object({
      dc: dcSchema,
      startWeek: z.number().int().min(1).max(52).default(36),
      weeks: z.number().int().min(1).max(26).default(12),
      maxOvertimePerWorker: z.number().min(0).max(20).default(8).describe("Overtime hours a week each person can take."),
      validate: z.boolean().default(true),
      targetUtilization: scenarioShape.targetUtilization,
      absenteeism: scenarioShape.absenteeism,
      addWorkers: scenarioShape.addWorkers,
      removeWorkers: scenarioShape.removeWorkers,
      crossTrain: scenarioShape.crossTrain,
      demandScale: scenarioShape.demandScale,
      slotting: scenarioShape.slotting,
      candystore: scenarioShape.candystore,
    })
    .strict(),
  annotations: readOnlyOpenWorld,
};

type Args = z.infer<typeof planLaborConfig.inputSchema>;

export async function planLaborHandler(args: Args) {
  return guarded(async () => {
    const { dc, startWeek, weeks, maxOvertimePerWorker, validate, ...scenario } = args;
    const ctx = await buildTwin(dc, startWeek, scenario);
    const plan = planLabor(ctx.workloadContext, ctx.workers, weeks, ctx.costs, { ...ctx.scheduleOptions, maxOvertimePerWorker });
    const rows = plan.weeks.map((w) => {
      const gaps = Object.entries(w.gaps).filter(([, h]) => (h ?? 0) > 0.5).map(([k, h]) => `${k} ${fmt1(h ?? 0)}`).join(", ");
      return `| ${w.week} | ×${w.season.toFixed(2)} | ${fmtInt(w.volume.inners)} | ${fmt1(w.requiredHours)} | ${fmt1(w.scheduledHours)} | ${gaps || "—"} | ${fmt1(w.overtimeHours)} | ${w.tempHeadcount} | ${w.uncoveredForkliftHours > 0.5 ? fmt1(w.uncoveredForkliftHours) : "—"} | ${money(w.cost.total)} |`;
    });
    const total = plan.weeks.reduce((a, w) => ({ reg: a.reg + w.cost.regular, ot: a.ot + w.cost.overtime, tmp: a.tmp + w.cost.temps, all: a.all + w.cost.total }), { reg: 0, ot: 0, tmp: 0, all: 0 });

    const lines = [
      `# Labor plan for ${dcName(ctx)}: ${weeks} weeks from week ${startWeek}`,
      scenarioLine(ctx),
      `Requirement = standard minutes ÷ average productivity ÷ ${pct(ctx.scheduleOptions.targetUtilization)} target utilization ÷ (1 − ${pct(ctx.scheduleOptions.absenteeism)} absenteeism). Cross-trained people cover short skills with their spare hours before anything counts as a gap.`,
      ``,
      `| week | season | inners | required h | scheduled h | gap by skill (h) | overtime h | temps | forklift h uncovered | cost |`,
      `|---|---:|---:|---:|---:|---|---:|---:|---:|---:|`,
      ...rows,
      ``,
      `Total ${money(total.all)}: regular ${money(total.reg)}, overtime ${money(total.ot)}, temps ${money(total.tmp)}.`,
      ``,
      `## Recommendations`,
      ...plan.recommendations.map((r) => `- ${r}`),
    ];

    if (validate) {
      const peak = plan.weeks.reduce((a, w, i) => (w.requiredHours > plan.weeks[a].requiredHours ? i : a), 0);
      const pw = plan.weeks[peak];
      const peakWeek = pw.week;
      const asIs = replicate(await buildTwin(dc, peakWeek, scenario), 7, 3);
      const shift = ctx.site.shifts[0].id;
      lines.push(``, `## Check on the floor: week ${peakWeek}, the heaviest (3 runs)`);
      const row = (label: string, k: typeof asIs.mean) => `| ${label} | ${fmt1(k.lateTrucks)} | ${(k.fillRate * 100).toFixed(1)}% | ${fmt1(k.overtimeHours)} | ${pct(k.utilization)} | ${money(k.laborCost)} |`;
      const table = [`| roster | late trucks | fill | OT h | utilization | labor cost |`, `|---|---:|---:|---:|---:|---:|`, row("as planned, no temps", asIs.mean)];
      if (pw.tempHeadcount > 0) {
        const withTemps = replicate(await buildTwin(dc, peakWeek, { ...scenario, addWorkers: [...(scenario.addWorkers ?? []), { role: "selector", shift, type: "temp", count: pw.tempHeadcount }] }), 7, 3);
        table.push(row(`+${pw.tempHeadcount} temp selector(s)`, withTemps.mean));
      }
      lines.push(...table, ``, `The plan works in weekly hours; the floor has a truck cutoff every delivery day, so a week that balances on paper can still ship late. Temps here are order selectors, the one role that needs no certification.`);
    }
    return text(lines.join("\n"));
  });
}
