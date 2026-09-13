/**
 * Mock roster: the people on each center's floor, by role, shift and skill.
 * Workers are identified by id only; there are no names, because nothing in
 * the twin needs one. Generated from a fixed seed.
 */

import { seededRandom } from "../lib/util/random";
import { ROLES, type RoleKey } from "../lib/twin/roles";
import type { Roster, Skill, Worker } from "../lib/twin/types";

export const ROSTER_SEED = 44;

interface Crew {
  role: string;
  shift: string;
  type: Worker["type"];
  count: number;
  skills: Skill[];
  wage: number;
}

function crew(key: RoleKey, shift: string, count: number, type: Worker["type"] = "full-time"): Crew {
  const r = ROLES[key];
  return { role: r.role, shift, type, count, skills: [...r.skills], wage: r.wage };
}

/**
 * Headcount by center, all on the one day shift. These are small buildings:
 * candystore's five stores need a few thousand display boxes a week, so the
 * crews are a handful of people and one absence is a real share of capacity.
 */
export const CREWS: Record<string, Crew[]> = {
  "dc-west": [
    crew("lead", "day", 1),
    crew("forklift", "day", 1),
    crew("selector", "day", 1, "part-time"),
  ],
  "dc-east": [
    crew("lead", "day", 1),
    crew("forklift", "day", 1),
    crew("selector", "day", 1),
    crew("loader", "day", 1, "part-time"),
  ],
};

export function buildRoster(): Roster {
  const rng = seededRandom(ROSTER_SEED);
  const workers: Worker[] = [];
  for (const [dc, crews] of Object.entries(CREWS)) {
    let n = 0;
    const tag = dc.replace("dc-", "").slice(0, 1).toUpperCase();
    for (const c of crews) {
      for (let i = 0; i < c.count; i++) {
        n++;
        workers.push({
          id: `W-${tag}-${String(n).padStart(3, "0")}`,
          dc,
          role: c.role,
          type: c.type,
          homeShift: c.shift,
          skills: c.skills,
          productivity: Math.round((0.9 + rng() * 0.2) * 100) / 100,
          hourlyRate: Math.round((c.wage + (rng() - 0.5) * 2) * 4) / 4,
          maxWeeklyHours: c.type === "part-time" ? 24 : 40,
        });
      }
    }
  }
  return { generatedAt: new Date().toISOString(), seed: ROSTER_SEED, workers };
}
