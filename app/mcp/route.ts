import { createMcpHandler } from "mcp-handler";
// Explicit, so the fs data provider is registered even if no tool imports it transitively one day.
import "@/lib/data/load";
import { registerTools } from "@/lib/tools/register";

/**
 * stress_test (60 runs) and find_capacity (a dozen probes) are the expensive
 * tools; both finish in a few seconds locally. This leaves room for a cold
 * start on a slower serverless vCPU and stays inside Vercel Hobby's 60s.
 */
export const maxDuration = 60;

/** Remote MCP endpoint. Same tools as the local stdio server, minus render_floor. */
const handler = createMcpHandler((server) => registerTools(server), {
  serverInfo: { name: "digitaltwin-mcp", version: "0.1.0" },
});

export { handler as GET, handler as POST };
