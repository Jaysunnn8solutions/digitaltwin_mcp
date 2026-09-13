# digitaltwin_mcp

**A digital twin of a candy distribution center.** [candystore_mcp](https://github.com/Jaysunnn8solutions/candystore_mcp) decides what its stores sell and which of its two distribution centers supplies them; this project runs those two buildings minute by minute. Supplier trucks, unloading, receiving, putaway, pick-face replenishment, store-order picking, packing, loading, and the people, forklifts and doors doing it, through the Halloween and Christmas peaks. An [MCP](https://modelcontextprotocol.io) server over a discrete-event simulation, with a small web page.

**Remote MCP endpoint:** `https://<your-vercel-domain>/mcp`
**Local MCP server:** `npm run mcp:stdio` (adds `render_floor`, which writes the floor plan to an HTML file)

This is the fourth project in a portfolio sequence: [census-mcp](https://github.com/Jaysunnn8solutions/census-mcp) (a stateless tool server), [atl-mcp](https://github.com/Jaysunnn8solutions/atl-mcp) (a spatial engine with scenarios), [candystore_mcp](https://github.com/Jaysunnn8solutions/candystore_mcp) (a market model with a supply chain), and this one, which takes candystore's supply chain down to the floor.

The company, its buildings and its people are fictional. candystore's demand comes from real demographics.

---

## The question

candystore says Norcross can ship $383k a week and Fulton Industrial $350k. Can they? Those are numbers on a spreadsheet. The twin answers with doors, forklifts, pick faces, cutoffs and a crew of three or four.

- Can the buildings take candystore's expansion, and what breaks first?
- Is each center ready for Halloween, when a week runs 2.1× an average one?
- What happens when the only forklift breaks, or the one person who can drive it is out?
- Who should work which day on what, and where would one absence stop a skill?
- Is re-slotting the pick faces worth the labor to move them?

---

## What the twin found (baseline data, mock standards)

- **Both buildings are small and lean.** Norcross ships about 7,700 display boxes a week with four people; Fulton about 3,800 with three. Labor utilization in an ordinary week is 45–55%, but the pick window between the start of shift and the 14:00 truck is what binds.
- **candystore's capacity assumption is optimistic.** `find_capacity` puts Norcross at roughly 1.2× today's demand before trucks start leaving late (about $240k in an average-season week, 63% of candystore's assumed cap) and Fulton at about 1.25× (37%). Norcross runs out of picker time; Fulton runs out of forklift, because it has one.
- **Halloween breaks Norcross as staffed.** In week 44 the simulation ships 7 trucks late and cuts 6% of display boxes; one temp selector fixes fill but not lateness, because forklift hours are the gap and temps cannot drive.
- **Most of slotting's value is face sizing, not walking.** In a building this size a pick line is mostly handling. Giving fast movers a week of stock on the face halves forklift replenishments; a 20-swap partial re-slot pays back in under a week.
- **Fulton is fragile.** Three people, one forklift: in a stress test with ordinary breakdown and absence rates, most fortnights ship at least one truck late, and a Tuesday with the lead out leaves nobody who can pick.

---

## Model

**Network.** candystore's market model sets each store's annual retail dollars by category (traditional, plus specialty candy for heritage segments) and its supplying center. `data/network.json` is a snapshot of candystore's live API; tools that take a `candystore` scenario (stores added or closed) call the API for that scenario instead.

**Demand.** General stores get deliveries Monday, Wednesday and Friday; specialty stores Tuesday and Friday. A delivery carries the store's weekly category dollars ÷ deliveries × candystore's seasonal index for the week, split across SKUs by velocity share and turned into display boxes ("inners") at retail price, with a Poisson draw per SKU.

**Building.** Rack locations, doors and a pick depot in feet. Pick tours use S-shape routing and split when the cart is full. Forklift trips are rectilinear with lift time per level. Picks outside golden levels 2–3 pay a bend-or-reach allowance.

**Operations.** A discrete-event simulation by the minute. Orders drop at 17:00, are allocated against put-away stock, and are picked from 06:30 for a 14:00 truck. Every task is a job in a queue: tours, replenishments (routine at a face's last case, hot when a pick finds it short, then a re-pick), packing, loading, and unloading, receiving and putaway for supplier trucks. A worker takes the most urgent job their primary skill allows, then anything else they're cross-trained for. Jobs also wait for forklifts, pallet jacks and doors. Durations are engineered standards ÷ worker productivity. The last shift stays on overtime, to a cap, while trucks due before the next shift aren't loaded. Waits count floor time only.

**Inventory.** Periodic review on each supplier's order day, order-up-to S = mean demand over review + lead time + z·σ. The seasonal forecast looks ahead through the candy calendar; trailing averages four weeks. Suppliers ship full single-SKU pallets and consolidate remainders onto mixed pallets. Eight weeks of warm-up. Stores don't backorder: what can't be allocated is cut.

**Slotting.** Current: catalog order, uniform 3-case faces. Optimized: the most-picked SKUs in the cheapest slots, faces sized to five days of demand. A partial re-slot makes only the highest-gain swaps.

**Workforce.** Workload = expected volume × standards, by shift and skill. Requirement = workload ÷ productivity ÷ target utilization ÷ (1 − absenteeism). The schedule gives full-timers every operating day and part-timers their heaviest days, assigns primaries scarcest-skill-first to the least flexible people, and lets cross-trained spare hours cover short skills. The season plan closes the rest with overtime, then temps (slower, never forklift-certified), and flags forklift hours that only cross-training or hiring can cover, with lead times.

**Capacity.** Scale every store's demand until on-time or fill misses the target, and compare the most the building ships with candystore's assumption.

Everything is implemented from these rules in `lib/twin/` with tests.

---

## Tools

Eleven tools on both transports; `render_floor` is a twelfth that exists only on the local stdio server.

| Tool | Purpose |
|---|---|
| `describe_twin` | Network, buildings, crews, and a baseline run of each center. Call first. |
| `get_layout` | Zones, faces, doors, equipment, fastest SKUs and where they sit, face sizes. |
| `get_workforce` | Roster, skills, single points of failure, labor standards, cost rates. |
| `simulate_operations` | Run the floor for up to 8 weeks: service, labor, flow, queues, crew, days, bottleneck. |
| `what_if` | Baseline against a scenario with the same random draws. |
| `stress_test` | Random breakdowns, outages, sick leave, supplier delays and surges over many runs. |
| `find_capacity` | The most candystore demand the building ships on time, and what breaks first. |
| `optimize_slotting` | Current, partial and full re-slot: labor saved, moves, payback, floor check. |
| `inventory_status` | Stock by category, open POs, weekly projection, stockouts, both forecast methods. |
| `plan_labor` | Week-by-week requirement, gaps, overtime, temps, cost, and a floor check of the peak. |
| `build_schedule` | Who works which day on what; hours needed and covered; one-absence risks. |
| `render_floor` | **Local only.** Self-contained HTML floor plan shaded by pick frequency. |

Every simulation tool takes the same scenario fields, so a conversation can chain "plan labor, test the fix, stress-test it" with one set of assumptions:

- **Demand:** `demandScale`, `demandShocks`, `candystore` (live store scenario).
- **Policy:** `slotting`, `forecast`, `serviceLevel`, `flex`, `overtimeMaxHours`, `targetUtilization`.
- **People:** `addWorkers`, `removeWorkers`, `crossTrain`, `workerLeave`, `absenteeism`.
- **Facility:** `forklifts`, `palletJacks`, `inboundDoors`, `outboundDoors`, `faceCases`.
- **Disruptions:** `doorOutages`, `forkliftOutages`, `wmsOutages`, `supplierDelays`.

Days count from 0, the Monday of `startWeek`. Three prompts package common chains: `peak_readiness`, `disruption_drill`, `expansion_impact`. Resources expose the manifest, the candystore snapshot, the buildings and the method.

### Remote

```bash
claude mcp add --transport http dc-twin https://<your-vercel-domain>/mcp
```

### Local, with the floor-plan renderer

```bash
git clone https://github.com/Jaysunnn8solutions/digitaltwin_mcp.git
cd digitaltwin_mcp && npm install
claude mcp add dc-twin-local -- npx tsx /absolute/path/to/digitaltwin_mcp/mcp/stdio.ts
```

Then ask: *"Is Norcross ready for Halloween? If not, what's the cheapest fix?"*

---

## Data

| File | What | Source |
|---|---|---|
| `data/network.json` | Centers, stores, weekly dollars by category, assumed capacity | candystore_mcp live API (`npm run pipeline`) |
| `data/catalog.json` | 281 SKUs, 11 suppliers, pack sizes, cube, velocity, lead times | Generated, fixed seed; generic product types, no brands |
| `data/roster.json` | 7 workers by id, role, skills, productivity, wage | Generated, fixed seed; no names |
| `data/sites.json` | Buildings, zones, doors, equipment, delivery days, clock, shifts | Hand-written |
| `lib/twin/standards.ts` | Labor standards and cost rates | Placeholders |

---

## Architecture

```
pipeline/         candystore snapshot, catalog and roster generators
data/             committed network, catalog, roster, sites, manifest
lib/util/         seeded random streams, event heap
lib/twin/         season, layout, demand, slotting, inventory, workforce, operations (DES), replicate, twin (scenario → context)
lib/tools/        MCP tools, prompts, resources, one registration for both transports
lib/render/       the floor-plan SVG
app/mcp/          remote MCP endpoint (mcp-handler)
app/page.tsx      the web page
mcp/stdio.ts      local MCP server (StdioServerTransport) + render_floor
```

---

## Running locally

```bash
npm install
npm run dev          # http://localhost:3000
npm test
npm run type-check && npm run lint
npm run pipeline     # refresh the candystore snapshot; CANDYSTORE_URL overrides the source
npm run test:client -- http://localhost:3000   # every tool over HTTP
npm run test:client -- stdio                   # every tool over stdio, plus render_floor
```

---

## Limitations

- The volumes are candystore's, and candystore is five stores, so the buildings are small. The dynamics (time-window capacity, single points of failure, face sizing) are what carry over to a real building, not the headcounts.
- Standards, costs, the roster and the buildings are placeholders. Calibrate `lib/twin/standards.ts` and `data/` before trusting a number.
- One shift, Monday to Friday. A second shift can be approximated with a `shifts` edit in `data/sites.json`; the planner and the simulation both read it, but the default calendar was only tuned for one.
- Reserve locations are fixed per SKU and capacity is checked, not enforced: overflow is reported, not simulated as floor stacking.
- The labor plan works in weekly hours and the floor in cutoffs, so a plan that balances can still ship late. `plan_labor` checks its peak week on the floor for that reason.
- Replications are few by default for speed. Raise `runs` when a decision rests on a small difference.
