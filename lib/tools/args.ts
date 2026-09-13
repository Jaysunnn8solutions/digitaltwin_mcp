import { z } from "zod";
import { dcSchema, scenarioShape, startWeekSchema, type TwinScenario } from "../twin/twin";

const SCENARIO_KEYS = Object.keys(scenarioShape) as Array<keyof TwinScenario>;

/** Pull the scenario fields out of a tool's arguments, leaving the rest. */
export function splitScenario<T extends Record<string, unknown>>(args: T): { scenario: TwinScenario; rest: Omit<T, keyof TwinScenario> } {
  const scenario: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if ((SCENARIO_KEYS as string[]).includes(k)) {
      if (v !== undefined) scenario[k] = v;
    } else rest[k] = v;
  }
  return { scenario: scenario as TwinScenario, rest: rest as Omit<T, keyof TwinScenario> };
}

export const baseShape = {
  dc: dcSchema,
  startWeek: startWeekSchema.default(36),
};

export { scenarioShape, z };
