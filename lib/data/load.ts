/**
 * The Node side of the data seam: reads the committed JSON with fs and hands
 * the pure registry in ./store a lazy provider. Importing this module is the
 * side effect every server entry point relies on (app/mcp/route.ts, the tools,
 * mcp/stdio.ts, the vitest setup file); the engine itself imports ./store, so
 * node:fs never reaches a browser or worker chunk. Everything this module used
 * to export (loaders, UnknownIdError) comes back from ./store, so existing
 * callers and their instanceof checks are unchanged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { setDataProvider } from "./store";

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

// Lazy on purpose: the files are read on the first loader call, not here, so
// mcp/stdio.ts can set TWIN_DATA_DIR after its imports have evaluated.
setDataProvider(() => ({
  network: readJson("network.json"),
  sites: readJson("sites.json"),
  catalog: readJson("catalog.json"),
  roster: readJson("roster.json"),
  manifest: readJson("manifest.json"),
}));

export * from "./store";
