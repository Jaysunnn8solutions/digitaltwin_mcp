/**
 * Rebuild the committed data:
 *   network.json  candystore_mcp's baseline, fetched from its live API
 *   catalog.json  mock suppliers and SKUs for every candystore category
 *   roster.json   mock workers per center
 *   manifest.json what was built, when, and from where
 *
 * sites.json (buildings, zones, doors, shifts) is hand-written and not touched.
 * Set CANDYSTORE_URL to point at a local candystore (npm run dev there).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { CANDYSTORE_URL, fetchNetwork } from "../lib/twin/candystore";
import { buildCatalog } from "./catalog";
import { buildRoster } from "./roster";

const DATA = path.resolve(import.meta.dirname, "..", "data");

function write(name: string, value: unknown) {
  const file = path.join(DATA, name);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  console.log(`wrote ${file}`);
}

async function main() {
  console.log(`Fetching the baseline network from ${CANDYSTORE_URL} …`);
  const network = await fetchNetwork({});
  for (const dc of network.dcs) {
    const weekly = Object.values(dc.weeklyDemand).reduce((a, b) => a + b, 0);
    console.log(`  ${dc.id} ${dc.name}: $${Math.round(weekly).toLocaleString("en-US")}/week across ${dc.stores.length} stores`);
  }
  write("network.json", network);

  const catalog = buildCatalog(network);
  console.log(`  catalog: ${catalog.skus.length} SKUs from ${catalog.suppliers.length} suppliers`);
  write("catalog.json", catalog);

  const roster = buildRoster();
  console.log(`  roster: ${roster.workers.length} workers`);
  write("roster.json", roster);

  write("manifest.json", {
    generatedAt: new Date().toISOString(),
    candystore: { source: network.source, fetchedAt: network.fetchedAt },
    counts: {
      dcs: network.dcs.length,
      stores: network.stores.length,
      skus: catalog.skus.length,
      suppliers: catalog.suppliers.length,
      workers: roster.workers.length,
    },
    seeds: { catalog: catalog.seed, roster: roster.seed },
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
