import { DEFAULT_COSTS, DEFAULT_STANDARDS, shiftPaidHours } from "../twin/standards";
import { buildTwin, dcSchema, scenarioShape } from "../twin/twin";
import { SKILLS } from "../twin/types";
import { guarded, readOnly, scenarioLine, text, z } from "./shared";

export const getWorkforceConfig = {
  title: "Crew, skills and labor standards",
  description:
    "One center's roster: each worker's id, role, shift, employment type, skills, productivity and wage; how many people hold each skill and which skills " +
    "rest on one person; the engineered labor standards and cost rates every plan uses. Accepts addWorkers, removeWorkers and crossTrain to preview a changed roster.",
  inputSchema: z
    .object({
      dc: dcSchema,
      addWorkers: scenarioShape.addWorkers,
      removeWorkers: scenarioShape.removeWorkers,
      crossTrain: scenarioShape.crossTrain,
    })
    .strict(),
  annotations: readOnly,
};

type Args = { dc: string; addWorkers?: z.infer<typeof scenarioShape.addWorkers>; removeWorkers?: string[]; crossTrain?: z.infer<typeof scenarioShape.crossTrain> };

export async function getWorkforceHandler({ dc, ...people }: Args) {
  return guarded(async () => {
    const ctx = await buildTwin(dc, 36, people);
    const { workers, site } = ctx;
    const rows = workers.map(
      (w) => `| ${w.id} | ${w.role} | ${w.type} | ${w.homeShift} | ${w.skills.join(", ")} | ${w.productivity.toFixed(2)} | $${w.hourlyRate.toFixed(2)} | ${w.maxWeeklyHours} |`
    );
    const coverage = SKILLS.map((k) => {
      const holders = workers.filter((w) => w.skills.includes(k));
      return `| ${k} | ${holders.length} | ${holders.map((h) => h.id).join(", ") || "—"} |`;
    });
    const single = SKILLS.filter((k) => workers.filter((w) => w.skills.includes(k)).length === 1);
    const none = SKILLS.filter((k) => workers.filter((w) => w.skills.includes(k)).length === 0);
    const shift = site.shifts[0];
    const paid = shiftPaidHours(shift.start, shift.end) - shift.breakMin / 60;
    const weeklyHours = workers.reduce((a, w) => a + Math.min(w.maxWeeklyHours, Math.floor(w.maxWeeklyHours / paid) * paid), 0);
    const s = DEFAULT_STANDARDS;
    const c = DEFAULT_COSTS;
    return text(
      [
        `# Crew at ${ctx.network.dcs.find((d) => d.id === dc)?.name} (${dc})`,
        scenarioLine(ctx),
        ``,
        `${workers.length} people, about ${Math.round(weeklyHours)} scheduled hours a week. Shifts: ${site.shifts.map((x) => `${x.id} ${x.start}–${x.end} (${x.breakMin} min unpaid break, ${x.indirectMin} min indirect)`).join("; ")}.`,
        ``,
        `| id | role | type | shift | skills | productivity | wage | max h/wk |`,
        `|---|---|---|---|---|---:|---:|---:|`,
        ...rows,
        ``,
        `| skill | holders | who |`,
        `|---|---:|---|`,
        ...coverage,
        ``,
        none.length ? `**Nobody holds:** ${none.join(", ")}. That work cannot be done at all.` : "",
        single.length ? `**Single points of failure:** ${single.join(", ")} rest on one person; when they are out, that work waits. Forklift work (putaway, replenishment) needs certification, which temps never have.` : `Every skill has at least two holders.`,
        ``,
        `**Labor standards (minutes, before productivity):** unload ${s.unloadPerPallet}/pallet + ${s.unloadPerTruck}/truck; receive ${s.receivePerPallet}/pallet + ${s.receivePerCase}/case, labels ${s.labelPerImportCase}/imported case; putaway ${s.putawayHandling} handling + forklift travel at ${s.forkliftFtPerMin} ft/min + ${s.liftMinPerLevel}/level; replenish ${s.replenHandling} + travel; pick ${s.pickPerLine}/line + ${s.pickPerInner}/inner + ${s.pickPerTour}/tour + walking at ${s.walkFtPerMin} ft/min, ${s.pickBendReachSec}s extra per line off the golden levels; pack ${s.packPerPallet}/pallet; load ${s.loadPerPallet}/pallet + ${s.loadPerTruck}/truck.`,
        `**Cost rates:** overtime ×${c.overtimeMultiplier}; agency temps $${c.tempHourly}/h at ${Math.round(c.tempProductivity * 100)}% productivity, no forklift; cross-training $${c.crossTrainCost} and ${c.crossTrainWeeks} weeks; a hire $${c.hireCost} and ${c.hireWeeks} weeks.`,
      ]
        .filter((l) => l !== "")
        .join("\n")
    );
  });
}
