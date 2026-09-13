import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ROLES } from "../layout/assemble";
import { describeImport, importLayout, LAYOUT_FORMATS, type ImportInput } from "../layout/import";
import { formatBytes, LIMITS } from "../layout/limits";
import { error, guarded, text, z } from "./shared";

const baseShape = {
  format: z.enum(LAYOUT_FORMATS as [string, ...string[]]).optional().describe("dxf, csv, geojson (ArcGIS Indoors or plain), imdf (zip) or ifc. Detected from the file name or content when omitted."),
  fileName: z.string().max(260).optional().describe("Original file name; its extension helps detect the format."),
  content: z.string().optional().describe(`File content as text (DXF, CSV, GeoJSON). Up to ${formatBytes(LIMITS.inline.text)} on the hosted server.`),
  contentBase64: z.string().optional().describe(`Binary file content as base64 (an IMDF .zip). Up to ${formatBytes(LIMITS.inline.zip)} decoded on the hosted server.`),
  files: z.record(z.string(), z.string()).optional().describe("Several GeoJSON files by name, e.g. an ArcGIS Indoors export: {\"Units.geojson\": \"…\", \"Details.geojson\": \"…\"}."),
  name: z.string().max(120).optional(),
  roleMap: z
    .record(z.string().max(120), z.enum(ROLES as [string, ...string[]]))
    .optional()
    .describe(`How to read layers, block names or categories: pattern (substring, or /regex/) → role. Roles: ${ROLES.join(", ")}. Checked before the built-in guesses; run once without it and read the report.`),
  units: z.string().max(10).optional().describe("Drawing or coordinate units when the file does not say: in, ft, mm, cm, m, yd."),
  level: z.string().max(80).optional().describe("Which floor of a multi-level IMDF or Indoors file (id or name). Defaults to the one with the most racks."),
  levels: z.number().int().min(1).max(12).optional().describe("Rack levels, when the drawing does not say (default 4)."),
  pickLevels: z.number().int().min(1).max(12).optional().describe("Levels of pick shelving (defaults to levels)."),
  bayWidthFt: z.number().min(2).max(20).optional().describe("Bay width used to count bays in a rack run drawn as one shape (default 9 ft for pallet rack, 8 ft for shelving)."),
  slotsPerBay: z.number().int().min(1).max(10).optional(),
  aisleWidthFt: z.number().min(3).max(20).optional(),
  rackUse: z.enum(["auto", "pick", "reserve", "mixed"]).optional().describe("What unlabelled racks are. auto: shelving-depth runs pick, the rest reserve (or mixed when nothing is pick)."),
};

export function importLayoutTool(local: boolean) {
  const config = {
    title: "Import a building layout",
    description:
      "Turn a floor plan into a layout the twin can simulate: DXF (CAD; export DWG to DXF first), a WMS location CSV, ArcGIS Indoors GeoJSON, an IMDF archive" +
      (local ? ", or IFC (BIM)" : " (IFC only on the web page or the local server)") +
      ". Reports how each layer or category was read, the racks, doors, pick faces and reserve positions found, and anything assumed, and returns the " +
      "layout spec. Pass that spec as `layout` to simulate_operations, what_if, find_capacity or any other simulation tool. Nothing is stored." +
      (local ? ` Give a local file path (up to ${formatBytes(LIMITS.local.dxf)} for DXF and IFC).` : ` Files over ${formatBytes(LIMITS.inline.text)} belong on the web page or the local server.`),
    inputSchema: z
      .object({
        ...baseShape,
        path: z.string().max(400).optional().describe(local ? "Path to the file on this machine." : "Only on the local server; the hosted server cannot read your files."),
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };

  type Args = z.infer<typeof config.inputSchema>;

  const handler = (args: Args) =>
    guarded(async () => {
      if (!local && args.path !== undefined) return error("The hosted server cannot read files on your machine. Send the content, use the web page, or run the local server (npm run mcp:stdio).");
      const sources = [args.content !== undefined, args.contentBase64 !== undefined, args.files !== undefined, local && args.path !== undefined].filter(Boolean).length;
      if (sources !== 1) return error(`Give exactly one of content, contentBase64, files${local ? " or path" : ""}.`);
      const input: ImportInput = { format: args.format as ImportInput["format"], fileName: args.fileName };
      let surface: "inline" | "local" = "inline";
      if (local && args.path) {
        const file = path.resolve(args.path);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return error(`No file at ${file}.`);
        if (info.size > LIMITS.local.dxf) return error(`${formatBytes(info.size)} is over the ${formatBytes(LIMITS.local.dxf)} limit for local files.`);
        input.bytes = new Uint8Array(await readFile(file));
        input.fileName ??= path.basename(file);
        surface = "local";
      } else if (args.content !== undefined) {
        input.text = args.content;
      } else if (args.contentBase64 !== undefined) {
        if (args.contentBase64.length > (LIMITS.inline.zip * 4) / 3 + 8) return error(`The base64 content is over the ${formatBytes(LIMITS.inline.zip)} limit.`);
        input.bytes = new Uint8Array(Buffer.from(args.contentBase64, "base64"));
      } else {
        input.files = args.files;
        const total = Object.values(args.files ?? {}).reduce((a, t) => a + t.length, 0);
        if (total > LIMITS.inline.text && !local) return error(`The files total ${formatBytes(total)}, over the ${formatBytes(LIMITS.inline.text)} limit here. Use the web page or the local server.`);
      }
      const result = await importLayout(
        input,
        {
          name: args.name,
          roleMap: args.roleMap as Record<string, (typeof ROLES)[number]> | undefined,
          units: args.units,
          level: args.level,
          levels: args.levels,
          pickLevels: args.pickLevels,
          bayWidthFt: args.bayWidthFt,
          slotsPerBay: args.slotsPerBay,
          aisleWidthFt: args.aisleWidthFt,
          rackUse: args.rackUse,
        },
        surface
      );
      const json = JSON.stringify(result.spec);
      return text(
        [
          describeImport(result),
          "",
          result.stats
            ? `Layout spec (${formatBytes(json.length)}). Pass it as \`layout\` with a dc (dc-east or dc-west supplies the demand, crew and equipment):`
            : `Layout spec so far (${formatBytes(json.length)}); fix the problem above with roleMap or the rack options and import again:`,
          "```json",
          json,
          "```",
        ].join("\n")
      );
    });

  return { config, handler };
}
