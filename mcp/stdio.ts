/**
 * Local MCP server over stdio. Same tools as the Vercel endpoint, plus
 * render_floor, which writes a floor plan to an HTML file. Add it to Claude
 * Code with:
 *
 *   claude mcp add dc-twin -- npx tsx C:/path/to/digitaltwin_mcp/mcp/stdio.ts
 *
 * The data directory is resolved relative to this file, so the server works
 * from any working directory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { floorSvg } from "../lib/render/floor";
import { registerTools } from "../lib/tools/register";
import { error, guarded, text, z } from "../lib/tools/shared";
import { buildTwin, dcSchema } from "../lib/twin/twin";

// ||= rather than ??=: the loader tests the variable for truthiness, so an
// empty string has to be replaced too.
process.env.TWIN_DATA_DIR ||= path.resolve(import.meta.dirname, "..", "data");

const server = new McpServer({ name: "digitaltwin-mcp", version: "0.1.0" });
registerTools(server);

const renderConfig = {
  title: "Render the floor plan to an HTML file",
  description:
    "Write a self-contained HTML floor plan of one center (no server needed): reserve racks, pick faces shaded by pick frequency, the depot and the doors, " +
    "for the current or optimized slotting. Returns the file path. Local only.",
  inputSchema: z
    .object({
      dc: dcSchema,
      slotting: z.enum(["current", "optimized"]).default("current"),
      path: z.string().max(400).optional().describe("Output file path. Defaults to ./dc-floor-<dc>-<timestamp>.html in the current directory."),
      overwrite: z.boolean().default(false).describe("Replace the file if it exists. Off by default, so a render never overwrites an existing file."),
    })
    .strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

server.registerTool("render_floor", renderConfig, (args: { dc: string; slotting: "current" | "optimized"; path?: string; overwrite: boolean }) =>
  guarded(async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.resolve(args.path ?? `dc-floor-${args.dc}-${stamp}.html`);
    // destructiveHint: false is only honest if the tool never replaces a file
    // the caller did not mean to lose.
    if (!args.overwrite && existsSync(file)) {
      return error(`${file} already exists. Pass overwrite: true to replace it, or omit path for a fresh timestamped file.`);
    }
    const ctx = await buildTwin(args.dc, 36, { slotting: args.slotting });
    const name = ctx.network.dcs.find((d) => d.id === args.dc)?.name ?? args.dc;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name} floor plan</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:900px;color:#222;background:#fff}h1{font-size:20px;margin:0 0 4px}p{color:#555;margin:0 0 16px}</style></head>
<body><h1>${name} (${args.dc})</h1><p>${args.slotting} slotting · ${ctx.layout.pick.length} pick faces, ${ctx.layout.reserve.length} reserve positions · ${ctx.slotEval.feetPerLine.toFixed(1)} ft walked per line, ${Math.round(ctx.slotEval.bendReachShare * 100)}% of lines off the golden levels</p>
${floorSvg(ctx, { width: 860 })}</body></html>`;
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, html, "utf8");
    return text(`Wrote ${file} (${(html.length / 1024).toFixed(0)} KB). Open it in a browser; it needs no server.`);
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
