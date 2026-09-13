import { loadManifest, loadNetwork, loadSites } from "../data/load";

export const METHOD_MARKDOWN = `# Distribution-center twin — method

**Network.** candystore_mcp decides what each store sells a year by category (traditional, and specialty candy for heritage segments) and which of its two distribution centers supplies it. The twin takes that as given: a committed snapshot of candystore's baseline, or its live API for a store scenario.

**Demand.** General stores receive deliveries Monday, Wednesday and Friday; specialty stores Tuesday and Friday. A delivery carries the store's weekly category dollars divided by its deliveries, times candystore's seasonal index for that week (Halloween week 44 is 2.1× an average week). Dollars split across SKUs by velocity share (Zipf within a category) and become display boxes ("inners") at retail price; each SKU's quantity is a Poisson draw on that mean.

**Building.** Rack locations, doors and a pick depot in feet. Pick tours follow S-shape routing through the aisles that hold a pick and split when the cart is full; forklift trips are rectilinear with a lift time per level. Slots outside golden levels 2–3 cost a bend-or-reach allowance per line.

**Operations.** A discrete-event simulation by the minute. Orders drop at the evening release and are allocated against stock that is put away; picking starts when the shift does. Tours, pick-face replenishments (triggered at the last case, or hot when a pick finds the face short, followed by a re-pick), pallet packing and loading are jobs in queues; supplier trucks queue for inbound doors, are unloaded pallet by pallet, received (with compliance labels on imported candy) and put away, and stock becomes pickable only then. A worker on shift takes the most urgent job their primary skill allows and, if cross-trained and flexing is on, any job their other skills allow. Jobs also wait for forklifts, pallet jacks and doors. Durations are engineered standards divided by the worker's productivity. The last shift stays on overtime, to a cap, while trucks due before the next shift are unloaded. Waits and cycle times are counted in floor time, so a night is not a queue.

**Inventory.** Periodic review on each supplier's order day, order-up-to S = mean demand over review plus lead time + z·σ, σ combining demand (dispersion 2) and lead-time variance, rounded to master cases. The seasonal forecast looks ahead through candystore's calendar; the trailing forecast averages four weeks shipped. Suppliers ship full single-SKU pallets and consolidate remainders onto mixed pallets by cube. Every run warms up eight weeks from steady state. Stores do not backorder: what cannot be allocated is cut.

**Slotting.** Current slotting is catalog order with a uniform face. Optimized slotting ranks SKUs by lines per week and gives the most frequent the cheapest slots (walking feet plus the bend penalty), and sizes each face to five days of demand within what the slot holds. A partial re-slot makes only the highest-gain swaps.

**Workforce.** Workload = expected volume × standards, by shift and skill, with travel from the building. Requirement hours = workload ÷ productivity ÷ target utilization ÷ (1 − absenteeism). The weekly schedule gives full-timers every operating day and part-timers their heaviest days, assigns primaries scarcest-skill-first to the least flexible people, then lets spare hours of cross-trained people cover short skills. The season plan closes remaining gaps with overtime, then agency temps (slower, never forklift-certified), and flags forklift hours that only cross-training or hiring can cover, with lead times.

**Capacity.** find_capacity scales every store's candystore dollars until trucks miss the on-time or fill target and compares the most the building ships with candystore's assumed weekly capacity for the center.

**Imported buildings.** import_layout (and the web page) read DXF, a WMS location CSV, ArcGIS Indoors GeoJSON, IMDF archives and IFC into a layout spec: rack runs with bays and levels, doors, walls, outline, zones. Shapes are classified by layer or category (roleMap overrides), the building is turned so racks run away from the dock wall, bay rectangles merge into runs, double-deep boxes split back to back, aisles are found from the gaps between facing runs, and personnel doors are dropped. Every simulation tool accepts the spec as layout; demand, crew and equipment still come from dc. Nothing is stored.

**Mock inputs.** Buildings, catalog, suppliers, roster, labor standards and costs are placeholders. candystore's demand is its own model over real demographics; its stores and centers are fictional too.
`;

export const manifestResource = {
  name: "manifest",
  uri: "twin://data/manifest",
  config: { title: "Data manifest", description: "When the data was built, from which candystore snapshot, and the counts.", mimeType: "application/json" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadManifest(), null, 2) }] }),
};

export const networkResource = {
  name: "network",
  uri: "twin://data/network",
  config: { title: "candystore network snapshot", description: "Centers, stores, weekly dollar demand and assumed capacity from candystore_mcp.", mimeType: "application/json" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadNetwork(), null, 2) }] }),
};

export const sitesResource = {
  name: "sites",
  uri: "twin://data/sites",
  config: { title: "Buildings", description: "Zones, doors, equipment, delivery days, clock and shifts for each center.", mimeType: "application/json" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(loadSites(), null, 2) }] }),
};

export const methodResource = {
  name: "method",
  uri: "twin://method",
  config: { title: "Method", description: "How demand, operations, inventory, slotting, workforce and capacity are modeled.", mimeType: "text/markdown" },
  handler: (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: METHOD_MARKDOWN }] }),
};
