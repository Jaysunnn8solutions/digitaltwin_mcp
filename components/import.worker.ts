/**
 * Parses an uploaded layout off the main thread. The file never leaves the
 * browser: the worker returns the compact layout spec and the report, and
 * only the spec is sent to the server when the user runs the twin.
 */

import { importLayout, type ImportInput, type ImportOptions, type ImportResult } from "../lib/layout/import";

export type WorkerRequest = {
  files: Array<{ name: string; bytes: ArrayBuffer }>;
  options: ImportOptions;
};

export type WorkerResponse = { ok: true; result: ImportResult } | { ok: false; error: string };

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { files, options } = e.data;
  try {
    const dec = new TextDecoder();
    let input: ImportInput;
    const geo = files.filter((f) => /\.(geo)?json$/i.test(f.name));
    if (files.length > 1) {
      if (geo.length !== files.length) throw new Error("Several files at once only works for GeoJSON (an ArcGIS Indoors export). Upload one DXF, CSV, IFC or IMDF zip at a time.");
      input = { files: Object.fromEntries(geo.map((f) => [f.name, dec.decode(f.bytes)])) };
    } else {
      const f = files[0];
      const bytes = new Uint8Array(f.bytes);
      const binary = /\.(zip|imdf|ifc)$/i.test(f.name);
      input = binary ? { fileName: f.name, bytes } : { fileName: f.name, text: dec.decode(bytes) };
    }
    const result = await importLayout(input, { ...options, wasmPath: `${self.location.origin}/` }, "browser");
    (self as unknown as Worker).postMessage({ ok: true, result } satisfies WorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
