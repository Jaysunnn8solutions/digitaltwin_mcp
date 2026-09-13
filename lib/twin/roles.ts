import type { Skill } from "./types";

/** Job roles, their skills and base wage. Shared by the roster pipeline and scenarios that add people. */
export const ROLES = {
  lead: { role: "Shift lead", skills: ["receive", "forklift", "pick", "pack", "load"] as Skill[], wage: 25 },
  forklift: { role: "Forklift operator", skills: ["forklift", "receive", "load"] as Skill[], wage: 22 },
  receiver: { role: "Receiver", skills: ["receive", "pack"] as Skill[], wage: 19 },
  selector: { role: "Order selector", skills: ["pick", "pack"] as Skill[], wage: 18.5 },
  loader: { role: "Loader", skills: ["load", "pack", "pick"] as Skill[], wage: 19 },
} as const;

export type RoleKey = keyof typeof ROLES;
export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];
