import { z } from "zod";

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export const peakPrompt = {
  name: "peak_readiness",
  config: {
    title: "Halloween readiness",
    description: "Is a center ready for the Halloween peak: what breaks, what it costs to fix, and what to book now.",
    // Prompt arguments arrive as strings over the wire.
    argsSchema: z.object({ dc: z.string().default("dc-east"), week: z.coerce.number().int().min(1).max(52).default(44) }),
  },
  handler: ({ dc, week }: { dc: string; week: number }) =>
    userMessage(
      [
        `Assess whether ${dc} is ready for the candy peak around calendar week ${week}.`,
        `1. Call describe_twin, then simulate_operations for ${dc} with startWeek ${week - 2} and days 21.`,
        `2. Call plan_labor for ${dc} from week ${week - 8} for 10 weeks.`,
        `3. Call inventory_status for ${dc} from week ${week - 6} for 8 weeks, and again with forecast "trailing" if the buyers do not plan seasonally.`,
        `4. Test the fixes with what_if at startWeek ${week - 1}, days 14: the plan's temps (addWorkers with type temp), optimized slotting, a second forklift, and cross-training a selector on forklift.`,
        `Report: late trucks and cut dollars as things stand, the bottleneck, which fix buys the most on-time trucks per dollar, what must be booked now given the lead times, and the risks that remain. Say that standards, costs and the roster are mock inputs.`,
      ].join("\n")
    ),
};

export const disruptionPrompt = {
  name: "disruption_drill",
  config: {
    title: "Disruption drill",
    description: "How fragile a center is: random breakdowns and absences, then the single failures that hurt most and what protects against them.",
    argsSchema: z.object({ dc: z.string().default("dc-west"), week: z.coerce.number().int().min(1).max(52).default(36) }),
  },
  handler: ({ dc, week }: { dc: string; week: number }) =>
    userMessage(
      [
        `Run a disruption drill for ${dc} starting week ${week}.`,
        `1. Call get_workforce for ${dc} and note single points of failure.`,
        `2. Call stress_test for ${dc} at startWeek ${week}.`,
        `3. For the two disruptions with the largest late-truck gap, call what_if with a deterministic version (for example forkliftOutages for days 0–1, or workerLeave for the only forklift operator for days 0–4).`,
        `4. Test a protection for each with what_if: cross-training, an extra forklift, or overtime cap changes.`,
        `Report the probability of a late truck in a normal fortnight, the failures that matter, and the cheapest protection for each.`,
      ].join("\n")
    ),
};

export const expansionPrompt = {
  name: "expansion_impact",
  config: {
    title: "What a candystore expansion does to the floor",
    description: "Take candystore_mcp's expansion stores and see whether each distribution center can ship them.",
    argsSchema: z.object({ lon: z.coerce.number().default(-84.16), lat: z.coerce.number().default(33.95), type: z.enum(["general", "specialty"]).default("general") }),
  },
  handler: ({ lon, lat, type }: { lon: number; lat: number; type: "general" | "specialty" }) =>
    userMessage(
      [
        `candystore is considering a new ${type} store at ${lat}, ${lon}.`,
        `1. Call what_if for both dc-east and dc-west with candystore: { add: [{ type: "${type}", lon: ${lon}, lat: ${lat} }] }, startWeek 36, days 14.`,
        `2. For the center that gains volume, call find_capacity with and without that candystore scenario, and plan_labor for 12 weeks from week 36 with it.`,
        `Report which center supplies the store, how much volume it adds, whether the building and crew absorb it, the hires or equipment needed before Halloween, and how the twin's capacity compares with candystore's assumption.`,
      ].join("\n")
    ),
};
