import { loadCatalog, loadManifest, loadNetwork, loadRoster, loadSites } from "../data/load";
import { replicate } from "../twin/replicate";
import { seasonFactor } from "../twin/season";
import { buildTwin } from "../twin/twin";
import { SKILLS } from "../twin/types";
import { fmt1, fmtInt, guarded, hours, money, pct, readOnly, text, z } from "./shared";

export const describeTwinConfig = {
  title: "Describe the distribution-center twin",
  description:
    "What the twin models and how: candystore_mcp's network (its two distribution centers, the stores each supplies and their weekly dollar demand), " +
    "each building (zones, pick faces, reserve positions, doors, forklifts, shifts, crew), the catalog, and a baseline two-week simulation of each center. " +
    "Call first.",
  inputSchema: z.object({}).strict(),
  annotations: readOnly,
};

export async function describeTwinHandler() {
  return guarded(async () => {
    const network = loadNetwork();
    const sites = loadSites();
    const catalog = loadCatalog();
    const roster = loadRoster();
    const manifest = loadManifest();
    const lines: string[] = [
      `# Distribution-center twin for candystore_mcp`,
      ``,
      `A discrete-event model of candystore's two distribution centers, minute by minute: supplier trucks, unloading, receiving, putaway, pick-face replenishment, store-order picking, packing, loading, and the people and forklifts doing it. ` +
        `Demand is candystore's: each store's annual dollars by category, snapshotted from ${network.source} on ${network.fetchedAt.slice(0, 10)}, spread over delivery days with candy seasonality (Halloween week 44 runs ${fmt1(seasonFactor(44))}× an average week). ` +
        `Buildings, catalog (${catalog.skus.length} SKUs from ${catalog.suppliers.length} suppliers), roster (${roster.workers.length} people) and labor standards are mock inputs.`,
      ``,
      `Stores order display boxes ("inners"). Orders drop at the evening release, are picked the next morning, and the truck leaves at the departure time; supplier trucks arrive in the inbound window.`,
      ``,
    ];

    for (const site of sites) {
      const dc = network.dcs.find((d) => d.id === site.id);
      if (!dc) continue;
      const weekly = Object.values(dc.weeklyDemand).reduce((a, b) => a + b, 0);
      const cap = Object.values(dc.capacity).reduce((a, b) => a + b, 0);
      const stores = network.stores.filter((s) => s.dc === site.id);
      const crew = roster.workers.filter((w) => w.dc === site.id);
      const holders = SKILLS.map((k) => `${k} ${crew.filter((w) => w.skills.includes(k)).length}`).join(", ");
      const ctx = await buildTwin(site.id, 36, {});
      const rep = replicate(ctx, 14, 3);
      const k = rep.mean;
      const shift = site.shifts.map((s) => `${s.id} ${s.start}–${s.end}`).join(", ");
      lines.push(
        `## ${dc.name} (${site.id})`,
        ``,
        `- **Demand from candystore:** ${money(weekly)}/week retail across ${stores.length} stores (${stores.map((s) => `${s.name}, ${s.type}`).join("; ")}). candystore assumes this center can ship ${money(cap)}/week; \`find_capacity\` tests that against the building.`,
        `- **Building:** ${site.building.widthFt}×${site.building.depthFt} ft; ${ctx.layout.pick.length} pick faces in ${site.pick.aisles} aisles (${site.pick.levels} levels, golden levels 2–3), ${ctx.layout.reserve.length} reserve pallet positions; ${site.doors.inbound} inbound and ${site.doors.outbound} outbound doors; ${site.equipment.forklifts} forklift(s), ${site.equipment.palletJacks} pallet jacks.`,
        `- **Clock:** shift ${shift} Mon–Fri with ${site.shifts[0].breakMin} min break and ${site.shifts[0].indirectMin} min indirect; orders release ${site.times.orderRelease}, trucks leave ${site.times.truckDeparture}; suppliers arrive ${site.times.inboundWindow.join("–")}.`,
        `- **Crew:** ${crew.length} people (${crew.map((w) => `${w.id} ${w.role}${w.type === "part-time" ? " (PT)" : ""}`).join(", ")}). Skill holders: ${holders}.`,
        `- **Baseline, weeks 36–37, 3 runs:** ${fmt1(k.trucks)} store trucks, ${fmt1(k.lateTrucks)} late; fill ${(k.fillRate * 100).toFixed(1)}%; ${fmtInt(k.innersShipped)} inners (${money(k.shippedDollars)}) shipped; ${fmt1(k.paidHours)} paid hours at ${pct(k.utilization)} utilization, ${fmt1(k.overtimeHours)} overtime; labor ${money(k.laborCost)} ($${k.costPerThousand.toFixed(2)} per $1k shipped); dock-to-stock ${hours(k.dockToStockAvgMin)}; forklift utilization ${pct(k.forkliftUtilization)}. Busiest queue: ${rep.bottleneck.process ?? "none"} (${rep.bottleneck.constraint}).`,
        ``
      );
    }

    lines.push(
      `## Tools`,
      ``,
      `- \`get_layout\`, \`get_workforce\`: the building and the crew.`,
      `- \`simulate_operations\`: run the floor for up to 8 weeks from any calendar week, with any scenario.`,
      `- \`what_if\`: baseline versus a scenario, same random draws.`,
      `- \`stress_test\`: random breakdowns, absences and supplier delays over many runs.`,
      `- \`find_capacity\`: how much candystore demand the building actually ships on time.`,
      `- \`optimize_slotting\`: velocity slotting and face sizing, with the moves and the payback.`,
      `- \`inventory_status\`: stock, order-up-to levels, projected cuts and reserve space.`,
      `- \`plan_labor\`, \`build_schedule\`: weekly staffing against the season, and who works what.`,
      ``,
      `Every simulation tool takes the same scenario fields: demand (\`demandScale\`, \`demandShocks\`, a live \`candystore\` store scenario), policy (\`slotting\`, \`forecast\`, \`serviceLevel\`, \`flex\`, \`overtimeMaxHours\`), people (\`addWorkers\`, \`removeWorkers\`, \`crossTrain\`, \`workerLeave\`, \`absenteeism\`), facility (\`forklifts\`, \`palletJacks\`, \`inboundDoors\`, \`outboundDoors\`, \`faceCases\`) and disruptions (\`doorOutages\`, \`forkliftOutages\`, \`wmsOutages\`, \`supplierDelays\`). Days count from 0, the Monday of \`startWeek\`.`,
      ``,
      `Data built ${manifest.generatedAt.slice(0, 10)}. Standards, costs, buildings and the roster are placeholders to be edited.`
    );
    return text(lines.join("\n"));
  });
}
