# digitaltwin_mcp

**A digital twin of a candy distribution center.** [candystore_mcp](https://github.com/Jaysunnn8solutions/candystore_mcp) decides what its stores sell and which of its two distribution centers supplies them; this project runs those two buildings minute by minute. Supplier trucks, unloading, receiving, putaway, pick-face replenishment, store-order picking, packing, loading, and the people, forklifts and doors doing it, through the Halloween and Christmas peaks. An [MCP](https://modelcontextprotocol.io) server over a discrete-event simulation, with a small web page.

**Live site:** `https://digitaltwin-mcp.vercel.app` · **Import your building:** `https://digitaltwin-mcp.vercel.app/import`
**3D twin:** `https://digitaltwin-mcp.vercel.app/twin`
**Remote MCP endpoint:** `https://digitaltwin-mcp.vercel.app/mcp`
**Local MCP server:** `npm run mcp:stdio` (adds `render_floor`, which writes the floor plan to an HTML file, and imports files by path, IFC included)

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

## Your own building

The twin runs in any building you bring. Upload a floor plan on the web page, or import it through MCP, and every simulation tool takes the result as `layout`: the building comes from your file, while demand, crew and equipment still come from a center (`dc`).

| Format | What it reads | How it's read |
|---|---|---|
| **DXF** (CAD) | Rack blocks or outlines, shelving, dock-door blocks, walls, outline, rooms | Layer and block names matched to roles (pick, reserve, mixed, rack, door, receiving/shipping door, wall, outline, staging, office, ignore), with NCS names such as A-WALL, A-EQPM and A-FLOR-OTLN recognised. Units come from `$INSUNITS`, or are guessed when the file is unitless. **DWG:** export to DXF first (Autodesk DWG TrueView or the ODA File Converter, both free); DWG libraries are paid or GPL. |
| **WMS location CSV** | Every location's zone, aisle, side, bay, level, optional x/y, door rows | Column names matched loosely; aisle-side groups become rack runs. Without coordinates, aisles are laid out at standard pitches. |
| **ArcGIS Indoors** GeoJSON | Units (USE_TYPE, NAME), Details (walls, doors, openings), Levels | Features To JSON exports, several files at once; Web Mercator or WGS84 |
| **IMDF** archive | fixture (racks as equipment or furniture), opening (service or automobile doors), unit, detail, footprint, level | OGC CS 20-094 zip in WGS84; the level with the most racks, or `level` |
| **IFC** (BIM) | Walls, doors, slabs, spaces, and furnishing or proxy elements named as racks | web-ifc (MPL-2.0), ground floor only. Web page and local server only. |

Every import goes through the same pipeline:

1. **Classify** each shape by its layer or category.
2. **Orient** the building so rack runs point away from the dock wall, which becomes the front.
3. **Build rack runs.** Bay-sized rectangles merge into runs, and double-deep boxes split into back-to-back rows.
4. **Find aisles** from the gaps between facing rack runs.
5. **Pick dock doors.** Personnel doors, and doors away from the dock wall, are dropped.
6. **Report** how every layer was read, what was assumed, and the pick faces and reserve positions the twin will simulate.

If a layer was read wrong, override it with `roleMap` (or the role table on the page) and import again.

**Nothing is stored.** The page parses the file in your browser, and only the compact layout spec (a few KB) goes to the server when you run the twin. The MCP tools return the spec to the caller.

**Size limits**, set by where the file is parsed:

| Where | Limit | Why |
|---|---|---|
| Web page, parsed in the browser | DXF, IFC, GeoJSON 50 MB; IMDF zip 25 MB (100 MB unzipped, 200 files); CSV 10 MB | A few seconds in a Web Worker on a laptop |
| Local MCP server, reading a path | DXF and IFC 200 MB; CSV, GeoJSON and IMDF 50 MB | Your machine, no network |
| Hosted MCP, content inline in a tool call | 256 KB; no IFC | Content travels through the model at about 300 tokens per KB, and Vercel caps requests at 4.5 MB |
| Any layout spec | 1 MB; ≤25,000 pick faces, ≤50,000 reserve positions, ≤100 doors, ≤2,000 ft a side, one floor | Keeps a simulation under ~10 s on Vercel |

All of them live in `lib/layout/limits.ts`. `public/samples/` has the same sample warehouse in every format (`npm run samples` rebuilds them).

---

## Watch it run in 3D

`https://digitaltwin-mcp.vercel.app/twin` plays a run back in three dimensions in your browser: supplier trucks backing onto the doors, pallets unloaded and put away, pickers walking S-shape tours through the aisles, forklifts replenishing faces, pallets packed, staged and loaded, and the store trucks leaving on time or late, with the queues, the pick faces and the KPIs as they accrue.

- **Same engine, same numbers.** The page runs `lib/twin/operations.ts` in a Web Worker and records its event stream. Nothing is animated that the engine did not do, and the HUD's figures equal the tools' KPIs at the end of the run. What the engine does not decide (which forklift, which door, walking between jobs, staging lanes, the yard) is synthesized as a deterministic function of the event stream, so the same seed always plays back the same way and the animation never feeds back into the results. The inspector shows engine facts and synthesized detail separately, with how each job's animation was fitted into its engine duration.
- **Seed 1 replays a tool's first run.** `simulate_operations` and `what_if` end with a link carrying the building, week, days and scenario. `replicate()` runs seeds 1..runs, so the page's seed 1 is run 1 of the table. The URL hash holds everything (`lib/twin-ui/hash.ts`: the scenario deflated and base64url-encoded, 6 KB at most); the server is never involved.
- **Scenarios.** Every scenario field, in tabs: labor (shifts, operating days, roster, cross-training, per-worker productivity, standards), supply (forecast, service level, supplier lead times and delays, inbound window and lateness), deliveries (demand, shocks, delivery days, release and departure times), space (slotting, face sizes, doors, forklifts, rack zones; an imported building comes from the `/import` page's "Open in 3D") and disruptions (door, forklift and WMS outages). Compare a run against the previous one on the timeline.
- **Playback.** Scrub, 1× to 1800×, skip the hours when nobody is on the floor, follow a worker or a truck, walk the floor in first person, presets for the dock, the pick module, the reserve and the yard. Lighting follows the simulated clock.

Nothing is stored. The run lives in the browser tab, and an imported drawing stays there too.

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

Twelve tools on both transports; `render_floor` is a thirteenth that exists only on the local stdio server.

| Tool | Purpose |
|---|---|
| `describe_twin` | Network, buildings, crews, and a baseline run of each center. Call first. |
| `import_layout` | DXF, WMS CSV, ArcGIS Indoors, IMDF (and IFC locally) → a layout spec every tool accepts, with a report of how it was read. |
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

- **Building:** `layout` (from `import_layout` or the web page).
- **Demand:** `demandScale`, `demandShocks`, `candystore` (live store scenario).
- **Policy:** `slotting`, `forecast`, `serviceLevel`, `flex`, `overtimeMaxHours`, `targetUtilization`.
- **People:** `addWorkers`, `removeWorkers`, `crossTrain`, `workerLeave`, `absenteeism`.
- **Facility:** `forklifts`, `palletJacks`, `inboundDoors`, `outboundDoors`, `faceCases`.
- **Disruptions:** `doorOutages`, `forkliftOutages`, `wmsOutages`, `supplierDelays`.
- **Added with the 3D twin:** `shifts` (patterns, breaks, indirect time), `operatingDays`, `times` (order release, truck departure, inbound window), `deliveryDays` by store type, `workerOverrides` (productivity, weekly hours, wage), `standards` (the engineered minutes and speeds), `supplierOverrides` (lead time, its variability, order day), `inboundLatenessSdMin`, and `rackZones` to re-rack a built-in building (ignored, with a note, when a `layout` is imported).

Days count from 0, the Monday of `startWeek`. Three prompts package common chains: `peak_readiness`, `disruption_drill`, `expansion_impact`. Resources expose the manifest, the candystore snapshot, the buildings and the method.

### Remote

```bash
claude mcp add --transport http dc-twin https://digitaltwin-mcp.vercel.app/mcp
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
lib/layout/       layout spec and limits; DXF, CSV, GeoJSON (IMDF, Indoors) and IFC importers; the shared assembler; samples
lib/twin/         season, layout (aisles and locations from a spec), demand, slotting, inventory, workforce, operations (DES, with trace hooks), replicate, twin (scenario → context), scenario-ext (the 3D twin's fields)
lib/trace/        the engine's event contract and the compiler: world, exact paths, identities (which forklift, door, lane), fit, running KPIs, cursor → typed-array playback
lib/three/        the three.js renderer: building, racks, actors, cameras, walk mode, picking, lighting, labels, viewer
lib/twin-worker/  the browser run: bundled data, buildTwin, runOperations with a tracer, compile, transfer
lib/twin-ui/      the URL hash codec shared by the page and the tools' links
lib/tools/        MCP tools, prompts, resources, one registration for both transports
lib/render/       the floor-plan SVG, shared by page, browser preview and render_floor
components/       the import workbench and its Web Worker; components/twin/ the 3D workbench, scene, timeline, inspector and the simulation worker
app/mcp/          remote MCP endpoint (mcp-handler)
app/api/twin/     stateless simulation of an imported layout
app/page.tsx      the web page; app/import/ the upload page; app/twin/ the 3D twin
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
- One shift, Monday to Friday, by default. The `shifts` and `operatingDays` scenario fields change that; the planner and the simulation both read them, but the default calendar was only tuned for one shift.
- The 3D page runs in the browser and stops at 28 days (the tools go to 56). candystore store scenarios go through the tools only, because candystore's API is fetched server-side. A second shift is approximated: planning assigns the outbound work to the shift on the floor at 19:30, and the animation of a job that spans a shift change is fitted, not re-planned.
- Reserve locations are fixed per SKU and capacity is checked, not enforced: overflow is reported, not simulated as floor stacking.
- The labor plan works in weekly hours and the floor in cutoffs, so a plan that balances can still ship late. `plan_labor` checks its peak week on the floor for that reason.
- Imports read plan geometry, not engineering detail: DXF arc bulges become straight segments and HATCH fills are skipped; rack levels come from the `levels` option unless a CSV or IFC says otherwise; one floor is modelled; and aisles are assumed to run front to back from a cross aisle on the dock side. Always read the import report before trusting a result.
- Replications are few by default for speed. Raise `runs` when a decision rests on a small difference.
