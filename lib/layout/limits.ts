/**
 * Every size limit on layout import in one place.
 *
 * Why these numbers:
 * - Vercel caps a function request body at 4.5 MB, a hard ceiling for
 *   anything sent to the hosted endpoint.
 * - Through the hosted MCP, file content arrives as a tool argument the model
 *   wrote, at roughly 300 tokens per KB, so inline content has to stay small;
 *   large files are parsed where they already are (the browser or the local
 *   server) and only the compact layout spec travels.
 * - Simulation cost depends on locations and SKUs, not megabytes, so the
 *   layout itself is capped too.
 */

const MB = 1024 * 1024;
const KB = 1024;

export const LIMITS = {
  /** Web page, parsed in the browser. */
  browser: { dxf: 50 * MB, ifc: 50 * MB, geojson: 50 * MB, csv: 10 * MB, imdfZip: 25 * MB },
  /** Local stdio server, read from a path. */
  local: { dxf: 200 * MB, ifc: 200 * MB, geojson: 50 * MB, csv: 50 * MB, imdfZip: 50 * MB },
  /** Hosted MCP, content inline in a tool call. IFC is not accepted there. */
  inline: { text: 256 * KB, zip: 256 * KB },
  /** Uncompressed IMDF archive, anywhere: guards against zip bombs. */
  imdfUnzipped: 100 * MB,
  imdfFiles: 200,
  /** A layout spec passed to any tool or API. */
  specJson: 1 * MB,
  /** The building a spec describes. */
  maxPickFaces: 25_000,
  maxReservePositions: 50_000,
  maxDoors: 100,
  maxRackRuns: 5_000,
  maxSideFt: 2_000,
  /** Parsed entities kept from a drawing before classification. */
  maxEntities: 500_000,
} as const;

export type Surface = "browser" | "local" | "inline";

export function formatBytes(n: number): string {
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${n} bytes`;
}

/** A file or layout past a limit; the message says where to send it instead. */
export class LimitError extends Error {}

export function checkSize(format: "dxf" | "ifc" | "geojson" | "csv" | "imdfZip", bytes: number, surface: Surface) {
  if (surface === "inline") {
    if (format === "ifc") throw new LimitError("IFC files are not accepted by the hosted MCP server: parse them on the web page or with the local server, then pass the layout spec it returns.");
    const cap = format === "imdfZip" ? LIMITS.inline.zip : LIMITS.inline.text;
    if (bytes > cap) {
      throw new LimitError(
        `${formatBytes(bytes)} is over the ${formatBytes(cap)} limit for file content sent through the hosted MCP server (about ${Math.round(cap / KB) * 300 / 1000}k tokens). ` +
          `Upload it on the web page or import it with the local server (limit ${formatBytes(LIMITS.local[format])}), then pass the layout spec.`
      );
    }
    return;
  }
  const cap = LIMITS[surface][format];
  if (bytes > cap) {
    const hint = surface === "browser" && LIMITS.local[format] > cap ? ` The local MCP server accepts up to ${formatBytes(LIMITS.local[format])}.` : "";
    throw new LimitError(`${formatBytes(bytes)} is over the ${formatBytes(cap)} limit for ${format.toUpperCase()} files here.${hint}`);
  }
}
