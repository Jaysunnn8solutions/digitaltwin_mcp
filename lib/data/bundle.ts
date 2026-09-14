/**
 * The committed data as module imports, for the browser worker: the five JSON
 * files (about 96 KB) are inlined into the worker chunk, so the 3D page needs
 * no fetch, no route and no filesystem, and runs the very same numbers the
 * server does (lib/data/store.test.ts compares a run on this bundle with a
 * run on the fs provider). Relative paths on purpose: vitest resolves them
 * without the @/ alias.
 */

import catalog from "../../data/catalog.json";
import manifest from "../../data/manifest.json";
import network from "../../data/network.json";
import roster from "../../data/roster.json";
import sites from "../../data/sites.json";
import type { Catalog, Network, Roster, Site } from "../twin/types";
import { setData, type DataBundle, type DataManifest } from "./store";

// Double casts where JSON typing disagrees with the interfaces: network's
// per-store revenueBy is inferred as a union with `?: undefined` keys (not a
// Record<string, number>), and sites' inboundWindow tuple widens to string[].
export const BUNDLE: DataBundle = {
  network: network as unknown as Network,
  sites: sites as unknown as Site[],
  catalog: catalog as Catalog,
  roster: roster as Roster,
  manifest: manifest as DataManifest,
};

/** Register the bundled data with the store; components/twin.worker.ts calls this once at start-up. */
export function installBundledData(): void {
  setData(BUNDLE);
}
