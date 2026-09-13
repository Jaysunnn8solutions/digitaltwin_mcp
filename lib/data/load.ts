import { readFileSync } from "node:fs";
import path from "node:path";
import type { Catalog, Network, Roster, Site } from "../twin/types";

export interface DataManifest {
  generatedAt: string;
  candystore: { source: string; fetchedAt: string };
  counts: { dcs: number; stores: number; skus: number; suppliers: number; workers: number };
  seeds: { catalog: number; roster: number };
}

/**
 * Committed data, read once per process. The production path is statically
 * scoped to ./data so Next.js traces just that folder; TWIN_DATA_DIR
 * overrides it for tests and the stdio server.
 */
function readJson<T>(name: string): T {
  // Tested for truthiness, so TWIN_DATA_DIR="" is no override. Keep it a bare
  // read of the variable, which lets Turbopack see the ./data branch as
  // statically scoped.
  const override = process.env.TWIN_DATA_DIR;
  const text = override
    ? readFileSync(/* turbopackIgnore: true */ path.join(override, name), "utf8")
    : readFileSync(path.join(process.cwd(), "data", name), "utf8");
  return JSON.parse(text) as T;
}

let network: Network | null = null;
let sites: Site[] | null = null;
let catalog: Catalog | null = null;
let roster: Roster | null = null;
let manifest: DataManifest | null = null;

/** candystore_mcp's baseline network: centers, stores, weekly dollars by category. */
export function loadNetwork(): Network {
  if (!network) network = readJson<Network>("network.json");
  return network;
}

/** Buildings, zones, doors, equipment and shifts. Mock. */
export function loadSites(): Site[] {
  if (!sites) sites = readJson<Site[]>("sites.json");
  return sites;
}

export function loadCatalog(): Catalog {
  if (!catalog) catalog = readJson<Catalog>("catalog.json");
  return catalog;
}

export function loadRoster(): Roster {
  if (!roster) roster = readJson<Roster>("roster.json");
  return roster;
}

export function loadManifest(): DataManifest {
  if (!manifest) manifest = readJson<DataManifest>("manifest.json");
  return manifest;
}

export function dcIds(): string[] {
  return loadSites().map((s) => s.id);
}

export function findSite(dc: string): Site {
  const site = loadSites().find((s) => s.id === dc);
  if (!site) throw new UnknownIdError(`Unknown distribution center "${dc}". Known: ${dcIds().join(", ")}.`);
  return site;
}

/** An argument naming something that does not exist; tools turn it into an isError result. */
export class UnknownIdError extends Error {}
