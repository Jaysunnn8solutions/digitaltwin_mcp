/**
 * Smoke test. Against a running HTTP server:
 *   npm run test:client -- http://localhost:3000
 * Against the local stdio server (spawns it, exercises render_floor too):
 *   npm run test:client -- stdio
 *
 * Calls every registered tool on the transport under test, every prompt and
 * resource, and the arguments that must be rejected: an unknown center, an
 * unknown worker, a temp certified on forklifts, an unknown supplier, and
 * render_floor refusing to clobber a file. The live candystore call is
 * skipped with --offline.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const target = argv.find((a) => !a.startsWith("--")) ?? "http://localhost:3000";
const offline = argv.includes("--offline");
const PREVIEW = 10;

const OUT_DIR = path.join(os.tmpdir(), "digitaltwin-smoke");
const FLOOR_FILE = path.join(OUT_DIR, "floor.html");

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

async function main() {
  const client = new Client({ name: "digitaltwin-smoke", version: "0.1.0" });
  if (target === "stdio") {
    const root = path.resolve(import.meta.dirname, "..");
    await client.connect(
      new StdioClientTransport({
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args: ["tsx", path.join(root, "mcp", "stdio.ts")],
        cwd: root,
      })
    );
    console.log("Connected to local stdio server");
  } else {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", `${target}/`)));
    console.log("Connected to", target);
  }

  const { tools } = await client.listTools();
  console.log(`Tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
  const { prompts } = await client.listPrompts();
  console.log(`Prompts (${prompts.length}):`, prompts.map((p) => p.name).join(", "));
  const { resources } = await client.listResources();
  console.log(`Resources (${resources.length}):`, resources.map((r) => r.uri).join(", "));

  const calls: Array<[string, Record<string, unknown>]> = [
    ["describe_twin", {}],
    ["get_layout", { dc: "dc-east", top: 5 }],
    ["get_workforce", { dc: "dc-west" }],
    ["simulate_operations", { dc: "dc-east", startWeek: 43, days: 7, runs: 2 }],
    ["what_if", { dc: "dc-west", startWeek: 36, days: 7, runs: 2, forklifts: 2, crossTrain: [{ role: "Order selector", skill: "forklift" }] }],
    ["stress_test", { dc: "dc-west", days: 10, runs: 10 }],
    ["find_capacity", { dc: "dc-east", days: 7, runs: 1 }],
    ["optimize_slotting", { dc: "dc-east", maxMoves: 20, listMoves: 5 }],
    ["inventory_status", { dc: "dc-east", startWeek: 38, weeks: 8, forecast: "trailing", supplierDelays: [{ category: "specialty:latam", extraDays: 14, fromDay: 0, toDay: 20 }] }],
    ["plan_labor", { dc: "dc-east", startWeek: 38, weeks: 10 }],
    ["build_schedule", { dc: "dc-west", week: 44, addWorkers: [{ role: "selector", shift: "day", type: "temp", count: 1 }] }],
    ["simulate_operations", { dc: "dc-east", startWeek: 36, days: 5, runs: 1, forkliftOutages: [{ count: 1, fromDay: 0, toDay: 2 }], wmsOutages: [{ day: 1, start: "07:00", hours: 3 }], workerLeave: [{ role: "Forklift operator", fromDay: 0, toDay: 4 }] }],
  ];
  if (!offline) calls.push(["what_if", { dc: "dc-east", days: 7, runs: 1, candystore: { add: [{ type: "general", lon: -84.16, lat: 33.95 }] } }]);
  if (target === "stdio") {
    mkdirSync(OUT_DIR, { recursive: true });
    rmSync(FLOOR_FILE, { force: true });
    calls.push(["render_floor", { dc: "dc-east", slotting: "optimized", path: FLOOR_FILE }]);
  }

  const rejects: Array<[string, string, Record<string, unknown>]> = [
    ["simulate_operations", "unknown center", { dc: "dc-north", days: 3, runs: 1 }],
    ["what_if", "unknown worker", { dc: "dc-east", removeWorkers: ["W-E-099"], days: 3, runs: 1 }],
    ["what_if", "temp forklift certification", { dc: "dc-east", addWorkers: [{ role: "selector", shift: "day", type: "temp", count: 1 }], crossTrain: [{ worker: "NEW-01", skill: "forklift" }], days: 3, runs: 1 }],
    ["inventory_status", "unknown supplier", { dc: "dc-west", supplierDelays: [{ supplier: "SUP-NOPE", extraDays: 5, fromDay: 0, toDay: 3 }] }],
    ["simulate_operations", "days out of range", { dc: "dc-east", days: 400 }],
  ];
  if (target === "stdio") rejects.push(["render_floor", "existing file, no overwrite", { dc: "dc-east", path: FLOOR_FILE }]);

  let failures = 0;
  for (const [name, args] of calls) {
    const started = Date.now();
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    const body = result.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result);
    if (result.isError) failures++;
    console.log(`\n=== ${name} (${result.isError ? "ERROR" : "ok"}, ${Date.now() - started} ms) ===`);
    console.log(body.split("\n").slice(0, PREVIEW).join("\n"));
  }

  const promptCalls: Array<[string, Record<string, string>]> = [
    ["peak_readiness", { dc: "dc-east", week: "44" }],
    ["disruption_drill", { dc: "dc-west" }],
    ["expansion_impact", { lon: "-84.16", lat: "33.95", type: "general" }],
  ];
  for (const [name, args] of promptCalls) {
    try {
      const r = await client.getPrompt({ name, arguments: args });
      const body = r.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
      console.log(`\n=== prompt ${name} (ok) ===`);
      console.log(body.split("\n").slice(0, 3).join("\n"));
    } catch (e) {
      failures++;
      console.log(`\n=== prompt ${name} (ERROR) ===\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const uris = ["twin://data/manifest", "twin://data/network", "twin://data/sites", "twin://method"];
  for (const uri of uris) {
    try {
      const r = await client.readResource({ uri });
      const body = r.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
      console.log(`\n=== resource ${uri} (ok, ${body.length} chars) ===`);
    } catch (e) {
      failures++;
      console.log(`\n=== resource ${uri} (ERROR) ===\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const [name, label, args] of rejects) {
    let rejected = false;
    let body = "";
    try {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      rejected = result.isError === true;
      body = result.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result);
    } catch (e) {
      rejected = true;
      body = e instanceof Error ? e.message : String(e);
    }
    if (!rejected) failures++;
    console.log(`\n=== ${name}: ${label} (${rejected ? "rejected, as it should be" : "ACCEPTED — should have been rejected"}) ===`);
    console.log(body.split("\n").slice(0, 3).join("\n"));
  }

  if (target === "stdio") console.log(`\nrender_floor wrote ${FLOOR_FILE}: ${existsSync(FLOOR_FILE) ? "yes" : "NO"}`);

  await client.close();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${calls.length + promptCalls.length + uris.length + rejects.length} checks passed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
