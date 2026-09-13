import { WEEKDAYS } from "../twin/standards";
import { buildTwin, dcSchema, scenarioShape } from "../twin/twin";
import { SKILLS } from "../twin/types";
import { buildWeekSchedule } from "../twin/workforce";
import { dcName, fmt1, guarded, money, readOnlyOpenWorld, scenarioLine, text, z } from "./shared";

export const buildScheduleConfig = {
  title: "Build a week's schedule",
  description:
    "Who works which day and on what, for one center and one calendar week: each present worker's primary skill per day, chosen to cover the scarcest skill " +
    "first with the least flexible people, the hours each skill needs and gets, the gaps, each person's hours and the cost, and the days where a skill " +
    "rests on one person. Takes roster changes and demand changes.",
  inputSchema: z
    .object({
      dc: dcSchema,
      week: z.number().int().min(1).max(52).default(36).describe("Calendar week to schedule."),
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

type Args = z.infer<typeof buildScheduleConfig.inputSchema>;

export async function buildScheduleHandler(args: Args) {
  return guarded(async () => {
    const { dc, week, ...scenario } = args;
    const ctx = await buildTwin(dc, week, scenario);
    const sched = buildWeekSchedule(ctx.workloadContext, ctx.workers, 0, ctx.scheduleOptions);
    const open = sched.days.filter((d) => ctx.site.operatingDays.includes(d.weekday));
    const header = `| worker | role | ${open.map((d) => WEEKDAYS[d.weekday - 1]).join(" | ")} | hours |`;
    const sep = `|---|---|${open.map(() => "---").join("|")}|---:|`;
    const rows = ctx.workers.map((w) => {
      const cells = open.map((d) => d.assignments.find((a) => a.worker === w.id)?.primary ?? "off");
      return `| ${w.id} | ${w.role}${w.type !== "full-time" ? ` (${w.type})` : ""} | ${cells.join(" | ")} | ${fmt1(sched.hours[w.id] ?? 0)} |`;
    });
    const skillRows = SKILLS.map((k) => {
      const cells = open.map((d) => {
        const req = Object.values(d.required).reduce((a, s) => a + (s[k] ?? 0), 0);
        const cov = Object.values(d.covered).reduce((a, s) => a + (s[k] ?? 0), 0);
        if (req < 0.05 && cov < 0.05) return "—";
        return `${fmt1(req)} / ${fmt1(cov)}`;
      });
      return `| ${k} | ${cells.join(" | ")} |`;
    });
    const fragile: string[] = [];
    for (const d of open) {
      const present = d.assignments.map((a) => ctx.workers.find((w) => w.id === a.worker)!);
      for (const k of SKILLS) {
        const req = Object.values(d.required).reduce((a, s) => a + (s[k] ?? 0), 0);
        const holders = present.filter((w) => w.skills.includes(k));
        if (req > 0.5 && holders.length === 1) fragile.push(`${WEEKDAYS[d.weekday - 1]} ${k} (${holders[0].id})`);
        if (req > 0.5 && holders.length === 0) fragile.push(`${WEEKDAYS[d.weekday - 1]} ${k} (nobody)`);
      }
    }
    const gaps = Object.entries(sched.gaps).filter(([, h]) => (h ?? 0) > 0.5);
    return text(
      [
        `# Schedule for ${dcName(ctx)}, week ${week}`,
        scenarioLine(ctx),
        ``,
        header,
        sep,
        ...rows,
        ``,
        `## Hours required / covered by skill`,
        `| skill | ${open.map((d) => WEEKDAYS[d.weekday - 1]).join(" | ")} |`,
        `|---|${open.map(() => "---:").join("|")}|`,
        ...skillRows,
        ``,
        gaps.length ? `**Gaps:** ${gaps.map(([k, h]) => `${k} ${fmt1(h ?? 0)} h`).join(", ")} for the week, beyond what anyone present can flex into.` : `**No gaps:** primaries plus flexing cover every skill's hours.`,
        fragile.length ? `**One absence away from stopping:** ${fragile.join("; ")}.` : `Every needed skill has at least two holders present each day.`,
        `Regular pay ${money(sched.regularCost)}.`,
        ``,
        `Required hours include the target-utilization and absenteeism allowances. A primary skill is where the person starts; on the floor, cross-trained people move to whatever queue is waiting.`,
      ].join("\n")
    );
  });
}
