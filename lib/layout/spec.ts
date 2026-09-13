/**
 * The layout spec: one compact description of a building that every importer
 * produces and every tool accepts. Racks are described as runs (a position,
 * a length, bays and levels) rather than one record per location, so a real
 * distribution center is a few kilobytes and can travel through a tool call.
 *
 * Canonical frame: feet, x across the building, y from the dock wall (y = 0)
 * toward the back, rack runs parallel to y. Importers rotate and translate
 * drawings into this frame.
 */

import { z } from "zod";
import { LIMITS } from "./limits";

export type Point = [number, number];

export interface RackRun {
  id: string;
  /** pick: every level is a pick face; reserve: pallet positions; mixed: level 1 picks, the rest is reserve. */
  use: "pick" | "reserve" | "mixed";
  /** Center of the rack footprint across its depth. */
  x: number;
  y0: number;
  y1: number;
  depthFt: number;
  bays: number;
  levels: number;
  slotsPerBay: number;
}

export interface DoorSpec {
  id: string;
  kind: "inbound" | "outbound";
  x: number;
  y: number;
  widthFt: number;
}

export interface ZoneSpec {
  kind: "staging" | "office" | "storage" | "other";
  name: string;
  ring: Point[];
}

export interface LayoutSpec {
  version: 1;
  name: string;
  source: { format: "builtin" | "dxf" | "csv" | "imdf" | "indoors" | "ifc"; file?: string; notes: string[] };
  widthFt: number;
  depthFt: number;
  outline: Point[];
  walls: Point[][];
  zones: ZoneSpec[];
  racks: RackRun[];
  doors: DoorSpec[];
  /** Aisle width assumed for a rack run with open space on one side only. */
  aisleWidthFt: number;
}

const num = z.number().finite();
const point = z.tuple([num, num]);

export const layoutSpecSchema = z
  .object({
    version: z.literal(1),
    name: z.string().max(120),
    source: z.object({ format: z.enum(["builtin", "dxf", "csv", "imdf", "indoors", "ifc"]), file: z.string().max(260).optional(), notes: z.array(z.string().max(400)).max(50) }),
    widthFt: num.positive().max(LIMITS.maxSideFt),
    depthFt: num.positive().max(LIMITS.maxSideFt),
    outline: z.array(point).max(2000),
    walls: z.array(z.array(point).max(2000)).max(5000),
    zones: z.array(z.object({ kind: z.enum(["staging", "office", "storage", "other"]), name: z.string().max(80), ring: z.array(point).max(500) })).max(500),
    racks: z
      .array(
        z.object({
          id: z.string().max(40),
          use: z.enum(["pick", "reserve", "mixed"]),
          x: num,
          y0: num,
          y1: num,
          depthFt: num.positive().max(20),
          bays: z.number().int().min(1).max(500),
          levels: z.number().int().min(1).max(12),
          slotsPerBay: z.number().int().min(1).max(10),
        })
      )
      .min(1)
      .max(LIMITS.maxRackRuns),
    doors: z.array(z.object({ id: z.string().max(40), kind: z.enum(["inbound", "outbound"]), x: num, y: num, widthFt: num.positive().max(60) })).max(LIMITS.maxDoors),
    aisleWidthFt: num.min(3).max(20),
  })
  .describe(
    "A building layout from import_layout (or the web page's import). Replaces the center's built-in building; demand, crew and equipment still come from dc."
  );

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Round coordinates to 0.1 ft so a spec stays compact. */
export function compactSpec(spec: LayoutSpec): LayoutSpec {
  const p = (pt: Point): Point => [r1(pt[0]), r1(pt[1])];
  return {
    ...spec,
    widthFt: r1(spec.widthFt),
    depthFt: r1(spec.depthFt),
    outline: spec.outline.map(p),
    walls: spec.walls.map((w) => w.map(p)),
    zones: spec.zones.map((z) => ({ ...z, ring: z.ring.map(p) })),
    racks: spec.racks.map((r) => ({ ...r, x: r1(r.x), y0: r1(r.y0), y1: r1(r.y1), depthFt: r1(r.depthFt) })),
    doors: spec.doors.map((d) => ({ ...d, x: r1(d.x), y: r1(d.y), widthFt: r1(d.widthFt) })),
  };
}
