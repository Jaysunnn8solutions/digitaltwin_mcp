/**
 * One entry point for every layout format: detect it, enforce the size limit
 * for where the file came from, parse, assemble, and dry-run the layout so
 * the report says what the twin will simulate before anything runs.
 * Stateless: nothing is stored, the spec is returned to the caller.
 *
 * Runs in Node and in the browser. IFC loads web-ifc on demand.
 */

import type { Site } from "../twin/types";
import { buildLayout } from "../twin/layout";
import { assemble, ImportError, type AssembleOptions, type ImportReport, type Role } from "./assemble";
import { readCsv } from "./csv";
import { readDxf } from "./dxf";
import { readGeo } from "./geojson";
import { checkSize, formatBytes, LimitError, type Surface } from "./limits";
import type { LayoutSpec } from "./spec";

export type LayoutFormat = "dxf" | "csv" | "geojson" | "imdf" | "ifc";
export const LAYOUT_FORMATS: LayoutFormat[] = ["dxf", "csv", "geojson", "imdf", "ifc"];

export interface ImportInput {
  fileName?: string;
  format?: LayoutFormat;
  /** Text formats: DXF, CSV, GeoJSON. */
  text?: string;
  /** Binary formats: IMDF zip, IFC. Text formats may also arrive as bytes. */
  bytes?: Uint8Array;
  /** Several GeoJSON files at once (an ArcGIS Indoors export). */
  files?: Record<string, string>;
}

export interface ImportOptions {
  name?: string;
  roleMap?: Record<string, Role>;
  units?: string;
  level?: string;
  levels?: number;
  pickLevels?: number;
  bayWidthFt?: number;
  slotsPerBay?: number;
  aisleWidthFt?: number;
  rackUse?: AssembleOptions["rackUse"];
  /** Where web-ifc.wasm is served from, in the browser. */
  wasmPath?: string;
}

export interface LayoutStats {
  pickFaces: number;
  reservePositions: number;
  pickAisles: number;
  reserveAisles: number;
}

export interface ImportResult {
  spec: LayoutSpec;
  report: ImportReport & { format: LayoutFormat; bytes: number; units?: string };
  stats: LayoutStats | null;
  /** Why the layout would not simulate as it stands, if it would not. */
  buildError: string | null;
}

export function detectFormat(input: ImportInput): LayoutFormat {
  if (input.format) return input.format;
  if (input.files && Object.keys(input.files).length) return "geojson";
  const ext = input.fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "dxf") return "dxf";
  if (ext === "csv" || ext === "txt") return "csv";
  if (ext === "geojson" || ext === "json") return "geojson";
  if (ext === "zip" || ext === "imdf") return "imdf";
  if (ext === "ifc") return "ifc";
  if (ext === "dwg") throw new ImportError("DWG is not read directly. Export the drawing to DXF (Autodesk DWG TrueView or the ODA File Converter do it for free) and import the DXF.");
  if (input.bytes && input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) return "imdf";
  const head = (input.text ?? new TextDecoder().decode((input.bytes ?? new Uint8Array()).slice(0, 2000))).slice(0, 2000);
  if (/ISO-10303-21/.test(head)) return "ifc";
  if (/^\s*0\s*\r?\n\s*SECTION/.test(head)) return "dxf";
  if (/^\s*[{[]/.test(head)) return "geojson";
  return "csv";
}

/** A stand-in site: layout dry runs only need the geometry. */
const PREVIEW_SITE = { id: "preview" } as unknown as Site;

export function layoutStats(spec: LayoutSpec): { stats: LayoutStats | null; error: string | null } {
  try {
    const l = buildLayout(spec, PREVIEW_SITE);
    return { stats: { pickFaces: l.pick.length, reservePositions: l.reserve.length, pickAisles: l.pickAisles.length, reserveAisles: l.reserveAisles.length }, error: null };
  } catch (err) {
    if (err instanceof LimitError || err instanceof ImportError) return { stats: null, error: err.message };
    throw err;
  }
}

export async function importLayout(input: ImportInput, opts: ImportOptions, surface: Surface): Promise<ImportResult> {
  const format = detectFormat(input);
  const bytes = input.bytes?.byteLength ?? (input.text !== undefined ? new TextEncoder().encode(input.text).byteLength : Object.values(input.files ?? {}).reduce((a, t) => a + t.length, 0));
  checkSize(format === "imdf" ? "imdfZip" : format, bytes, surface);
  const base = input.fileName?.replace(/\.[^.]+$/, "") ?? `Imported ${format.toUpperCase()} layout`;
  const assembleOpts: AssembleOptions = {
    name: opts.name ?? base,
    format: format === "geojson" ? "imdf" : format,
    file: input.fileName,
    roleMap: opts.roleMap,
    levels: opts.levels,
    pickLevels: opts.pickLevels,
    bayWidthFt: opts.bayWidthFt,
    slotsPerBay: opts.slotsPerBay,
    aisleWidthFt: opts.aisleWidthFt,
    rackUse: opts.rackUse,
  };
  const text = () => input.text ?? new TextDecoder().decode(input.bytes ?? new Uint8Array());

  let out: { spec: LayoutSpec; report: ImportReport };
  let units: string | undefined;
  switch (format) {
    case "dxf": {
      const dxf = readDxf(text(), { units: opts.units });
      units = dxf.unitsName;
      out = assemble(dxf.features, { ...assembleOpts, format: "dxf", notes: [`Drawing units: ${dxf.unitsName}.`] });
      break;
    }
    case "csv":
      out = readCsv(text(), { ...assembleOpts, format: "csv", units: opts.units });
      break;
    case "geojson":
      out = readGeo(input.files ? { files: input.files } : { files: { [input.fileName ?? "layout.geojson"]: text() } }, { ...assembleOpts, level: opts.level });
      break;
    case "imdf":
      if (!input.bytes) throw new ImportError("An IMDF archive must be sent as bytes (a .zip).");
      out = readGeo({ zip: input.bytes }, { ...assembleOpts, level: opts.level });
      break;
    case "ifc": {
      if (!input.bytes && input.text === undefined) throw new ImportError("No IFC content.");
      const { readIfc } = await import("./ifc");
      out = await readIfc(input.bytes ?? new TextEncoder().encode(input.text!), { ...assembleOpts, format: "ifc", wasmPath: opts.wasmPath });
      break;
    }
  }
  const { stats, error } = layoutStats(out.spec);
  return { spec: out.spec, report: { ...out.report, format, bytes, units }, stats, buildError: error };
}

export function describeImport(r: ImportResult): string {
  const rep = r.report;
  const lines = [
    `Imported ${rep.format.toUpperCase()} (${formatBytes(rep.bytes)}) as "${r.spec.name}": ${Math.round(r.spec.widthFt)}×${Math.round(r.spec.depthFt)} ft${rep.rotationDeg ? `, turned ${rep.rotationDeg}° so aisles run from the dock` : ""}.`,
    `Racks: ${rep.racks.runs} runs (${rep.racks.pick} pick, ${rep.racks.reserve} reserve, ${rep.racks.mixed} mixed). Dock doors: ${rep.doors.inbound} receiving, ${rep.doors.outbound} shipping. Walls drawn: ${rep.walls}. Zones: ${rep.zones}.`,
    r.stats
      ? `The twin reads ${r.stats.pickFaces.toLocaleString("en-US")} pick faces in ${r.stats.pickAisles} aisle(s) and ${r.stats.reservePositions.toLocaleString("en-US")} reserve pallet positions in ${r.stats.reserveAisles} aisle(s).`
      : `**This layout will not simulate yet:** ${r.buildError}`,
  ];
  if (rep.notes.length) lines.push("", "Notes:", ...rep.notes.map((n) => `- ${n}`));
  if (rep.sources.length) {
    const shown = rep.sources.slice(0, 30);
    lines.push("", "How each layer or category was read (override with roleMap):", ...shown.map((s) => `- ${s.source} → ${s.role} (${s.features})`));
    if (rep.sources.length > shown.length) lines.push(`- … ${rep.sources.length - shown.length} more`);
  }
  return lines.join("\n");
}
