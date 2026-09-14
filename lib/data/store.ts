/**
 * The committed data as a registry, free of Node APIs, so the same engine runs
 * on the server (lib/data/load.ts registers a lazy fs provider at import time)
 * and in a Web Worker (components/twin.worker.ts calls setData with the JSON
 * bundled by lib/data/bundle.ts). lib/twin/twin.ts imports the loaders from
 * here, never from load.ts, which keeps node:fs out of the browser bundle.
 *
 * Lead-written contract: the API below is what every caller of the old
 * lib/data/load.ts already uses, with the same names and bodies.
 */

import type { Catalog, Network, Roster, Site } from "../twin/types";

export interface DataManifest {
  generatedAt: string;
  candystore: { source: string; fetchedAt: string };
  counts: { dcs: number; stores: number; skus: number; suppliers: number; workers: number };
  seeds: { catalog: number; roster: number };
}

export interface DataBundle {
  network: Network;
  sites: Site[];
  catalog: Catalog;
  roster: Roster;
  manifest: DataManifest;
}

/** An argument naming something that does not exist; tools turn it into an isError result. */
export class UnknownIdError extends Error {}

/** Nothing registered the data yet: import lib/data/load on Node, or call setData() in the browser. */
export class DataNotLoadedError extends Error {}

let bundle: DataBundle | null = null;
let provider: (() => DataBundle) | null = null;
let version = 0;

/** Browser and worker path: hand over the bundled JSON. Replaces any earlier bundle. */
export function setData(b: DataBundle): void {
  bundle = b;
  version++;
}

/**
 * Node path: register a lazy reader. It runs on the first loader call, not at
 * import time, so mcp/stdio.ts can still set TWIN_DATA_DIR after its imports
 * evaluate and vitest's env applies before any test module reads.
 */
export function setDataProvider(p: () => DataBundle): void {
  provider = p;
  bundle = null;
  version++;
}

export function hasData(): boolean {
  return bundle !== null || provider !== null;
}

/** Increments on every setData/setDataProvider; buildTwin keys its context cache on it. */
export function dataVersion(): number {
  return version;
}

function data(): DataBundle {
  if (!bundle) {
    if (!provider) throw new DataNotLoadedError("Twin data is not loaded: import lib/data/load on Node, or call setData() from lib/data/store in the browser first.");
    bundle = provider();
  }
  return bundle;
}

/** candystore_mcp's baseline network: centers, stores, weekly dollars by category. */
export function loadNetwork(): Network {
  return data().network;
}

/** Buildings, zones, doors, equipment and shifts. Mock. */
export function loadSites(): Site[] {
  return data().sites;
}

export function loadCatalog(): Catalog {
  return data().catalog;
}

export function loadRoster(): Roster {
  return data().roster;
}

export function loadManifest(): DataManifest {
  return data().manifest;
}

export function dcIds(): string[] {
  return loadSites().map((s) => s.id);
}

export function findSite(dc: string): Site {
  const site = loadSites().find((s) => s.id === dc);
  if (!site) throw new UnknownIdError(`Unknown distribution center "${dc}". Known: ${dcIds().join(", ")}.`);
  return site;
}
