import { loadNetwork, loadSites } from "@/lib/data/load";
import { floorSvg } from "@/lib/render/floor";
import { replicate } from "@/lib/twin/replicate";
import { buildTwin } from "@/lib/twin/twin";

const TOOLS: Array<[string, string]> = [
  ["describe_twin", "The network, buildings, crews and a baseline run. Call first."],
  ["simulate_operations", "Run the floor by the minute for up to eight weeks, with any scenario."],
  ["what_if", "Baseline against a scenario, with the same random draws."],
  ["stress_test", "Random breakdowns, absences, outages and supplier delays over many runs."],
  ["find_capacity", "How much candystore demand the building really ships on time."],
  ["optimize_slotting", "Velocity slotting and face sizing: moves, labor saved, payback."],
  ["inventory_status", "Stock, days of supply, projected cuts and reserve space."],
  ["plan_labor", "Staffing through the candy season: gaps, overtime, temps, cost."],
  ["build_schedule", "Who works which day on what, and where one absence stops a skill."],
  ["get_layout · get_workforce", "The building, the slotting, the crew and the standards."],
];

/** Vercel sets the production domain at build time; locally the dev server's. */
const ENDPOINT = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/mcp` : "http://localhost:3000/mcp";

function money(d: number) {
  return d >= 1e6 ? `$${(d / 1e6).toFixed(1)}M` : `$${Math.round(d / 1e3)}k`;
}

export default async function Home() {
  const network = loadNetwork();
  const panels = await Promise.all(
    loadSites().map(async (site) => {
      const ctx = await buildTwin(site.id, 36, {});
      const rep = replicate(ctx, 14, 2);
      const dc = network.dcs.find((d) => d.id === site.id)!;
      return { site, ctx, k: rep.mean, bottleneck: rep.bottleneck, dc, weekly: Object.values(dc.weeklyDemand).reduce((a, b) => a + b, 0) };
    })
  );

  return (
    <main>
      <h1>A digital twin of a candy distribution center</h1>
      <p className="lede">
        candystore_mcp decides what its stores sell and which of two distribution centers supplies them. This twin runs those buildings minute by minute:
        supplier trucks, putaway, pick-face replenishment, store orders, packing and loading, with the crew, forklifts and doors, through the Halloween and
        Christmas peaks. Ask it through MCP whether a center can take an expansion, what breaks when a forklift does, or who to schedule next week.
      </p>
      <pre>claude mcp add --transport http dc-twin {ENDPOINT}</pre>

      <div className="grid">
        {panels.map(({ site, ctx, k, bottleneck, dc, weekly }) => (
          <section className="panel" key={site.id}>
            <h2>{dc.name}</h2>
            <div className="sub">
              {site.id} · {money(weekly)}/week of candystore demand · {ctx.workers.length} people, {site.equipment.forklifts} forklift{site.equipment.forklifts > 1 ? "s" : ""},{" "}
              {site.doors.inbound + site.doors.outbound} doors
            </div>
            <div dangerouslySetInnerHTML={{ __html: floorSvg(ctx, { width: 520 }) }} />
            <div className="tiles">
              <div className="tile">
                <b>{(k.onTimeRate * 100).toFixed(0)}%</b>
                <span>trucks on time</span>
              </div>
              <div className="tile">
                <b>{(k.fillRate * 100).toFixed(1)}%</b>
                <span>fill rate</span>
              </div>
              <div className="tile">
                <b>{(k.utilization * 100).toFixed(0)}%</b>
                <span>labor utilization</span>
              </div>
              <div className="tile">
                <b>${k.costPerThousand.toFixed(0)}</b>
                <span>labor per $1k shipped</span>
              </div>
            </div>
            <p className="sub" style={{ marginTop: 10 }}>
              Weeks 36–37 baseline, mean of 2 runs. Busiest queue: {bottleneck.process ?? "none"}.
            </p>
          </section>
        ))}
      </div>

      <h3>Tools</h3>
      <ul className="tools">
        {TOOLS.map(([name, what]) => (
          <li key={name}>
            <code>{name}</code> — {what}
          </li>
        ))}
      </ul>

      <h3>Run it locally</h3>
      <pre>{`git clone https://github.com/Jaysunnn8solutions/digitaltwin_mcp.git
cd digitaltwin_mcp && npm install
claude mcp add dc-twin-local -- npx tsx /absolute/path/to/digitaltwin_mcp/mcp/stdio.ts`}</pre>

      <footer>
        Demand from <a href="https://github.com/Jaysunnn8solutions/candystore_mcp">candystore_mcp</a>. Buildings, catalog, roster and labor standards are mock
        inputs. Source on <a href="https://github.com/Jaysunnn8solutions/digitaltwin_mcp">GitHub</a>.
      </footer>
    </main>
  );
}
