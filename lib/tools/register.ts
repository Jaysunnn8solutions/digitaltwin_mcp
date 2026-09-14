/**
 * One registration function for both transports: the HTTP handler on Vercel
 * and the stdio server run locally. The stdio server adds render_floor on
 * top, because only a local process can write a file.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { buildScheduleConfig, buildScheduleHandler } from "./build-schedule";
import { describeTwinConfig, describeTwinHandler } from "./describe-twin";
import { findCapacityConfig, findCapacityHandler } from "./find-capacity";
import { getLayoutConfig, getLayoutHandler } from "./get-layout";
import { getWorkforceConfig, getWorkforceHandler } from "./get-workforce";
import { importLayoutTool } from "./import-layout";
import { inventoryStatusConfig, inventoryStatusHandler } from "./inventory-status";
import { optimizeOperationsConfig, optimizeOperationsHandler } from "./optimize-operations";
import { optimizeSlottingConfig, optimizeSlottingHandler } from "./optimize-slotting";
import { planLaborConfig, planLaborHandler } from "./plan-labor";
import { disruptionPrompt, expansionPrompt, peakPrompt } from "./prompts";
import { manifestResource, methodResource, networkResource, sitesResource } from "./resources";
import { simulateOperationsConfig, simulateOperationsHandler } from "./simulate-operations";
import { stressTestConfig, stressTestHandler } from "./stress-test";
import { whatIfConfig, whatIfHandler } from "./what-if";

export function registerTools(server: McpServer, opts: { local?: boolean } = {}): void {
  const importTool = importLayoutTool(opts.local ?? false);
  server.registerTool("describe_twin", describeTwinConfig, describeTwinHandler);
  server.registerTool("import_layout", importTool.config, importTool.handler);
  server.registerTool("get_layout", getLayoutConfig, getLayoutHandler);
  server.registerTool("get_workforce", getWorkforceConfig, getWorkforceHandler);
  server.registerTool("simulate_operations", simulateOperationsConfig, simulateOperationsHandler);
  server.registerTool("what_if", whatIfConfig, whatIfHandler);
  server.registerTool("stress_test", stressTestConfig, stressTestHandler);
  server.registerTool("find_capacity", findCapacityConfig, findCapacityHandler);
  server.registerTool("optimize_operations", optimizeOperationsConfig, optimizeOperationsHandler);
  server.registerTool("optimize_slotting", optimizeSlottingConfig, optimizeSlottingHandler);
  server.registerTool("inventory_status", inventoryStatusConfig, inventoryStatusHandler);
  server.registerTool("plan_labor", planLaborConfig, planLaborHandler);
  server.registerTool("build_schedule", buildScheduleConfig, buildScheduleHandler);

  server.registerPrompt(peakPrompt.name, peakPrompt.config, peakPrompt.handler);
  server.registerPrompt(disruptionPrompt.name, disruptionPrompt.config, disruptionPrompt.handler);
  server.registerPrompt(expansionPrompt.name, expansionPrompt.config, expansionPrompt.handler);
  for (const r of [manifestResource, networkResource, sitesResource, methodResource]) {
    server.registerResource(r.name, r.uri, r.config, r.handler);
  }
}
