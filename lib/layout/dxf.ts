/**
 * A minimal ASCII DXF reader for floor plans: header units, blocks, and the
 * entities that carry plan geometry (LINE, LWPOLYLINE, POLYLINE/VERTEX,
 * INSERT, SOLID, CIRCLE, ARC). Written here rather than pulled in, since a
 * floor plan needs a few hundred lines of the format and nothing else.
 *
 * Output is RawFeatures for the assembler:
 * - closed polylines and solids become rings on their layer;
 * - loose LINEs on a layer are chained, and closed chains become rings;
 * - an INSERT becomes one ring (the hull of its block's geometry, transformed)
 *   labelled "<layer>|<block name>", because racks and doors are almost
 *   always blocks and the block name is often the only label.
 */

import { chainSegments, convexHull, isClosed } from "./geometry";
import { ImportError, type RawFeature } from "./assemble";
import { LIMITS } from "./limits";
import type { Point } from "./spec";

/** Feet per drawing unit, by $INSUNITS. */
const INSUNITS_TO_FT: Record<number, { ft: number; name: string }> = {
  1: { ft: 1 / 12, name: "inches" },
  2: { ft: 1, name: "feet" },
  4: { ft: 0.00328084, name: "millimeters" },
  5: { ft: 0.0328084, name: "centimeters" },
  6: { ft: 3.28084, name: "meters" },
  8: { ft: 1 / 12_000_000, name: "microinches" },
  9: { ft: 1 / 12_000, name: "mils" },
  10: { ft: 3, name: "yards" },
  14: { ft: 0.328084, name: "decimeters" },
};

export const UNIT_NAMES: Record<string, number> = { in: 1 / 12, inch: 1 / 12, inches: 1 / 12, ft: 1, feet: 1, foot: 1, mm: 0.00328084, cm: 0.0328084, m: 3.28084, meters: 3.28084, yd: 3 };

interface Entity {
  type: string;
  layer: string;
  codes: Array<[number, string]>;
}

function tokens(text: string): Array<[number, string]> {
  const lines = text.split(/\r?\n/);
  const out: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) throw new ImportError(`Not a readable DXF: expected a group code on line ${i + 1}. Save the drawing as ASCII DXF.`);
    out.push([code, lines[i + 1].replace(/\s+$/, "")]);
  }
  return out;
}

/** Split a token stream into entities (each starts at a code-0 record). */
function entitiesOf(toks: Array<[number, string]>, start: number, end: number): Entity[] {
  const out: Entity[] = [];
  let cur: Entity | null = null;
  for (let i = start; i < end; i++) {
    const [c, v] = toks[i];
    if (c === 0) {
      if (cur) out.push(cur);
      cur = { type: v, layer: "0", codes: [] };
    } else if (cur) {
      if (c === 8) cur.layer = v;
      cur.codes.push([c, v]);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const n = (e: Entity, code: number, def = 0) => {
  const hit = e.codes.find(([c]) => c === code);
  return hit ? Number.parseFloat(hit[1]) : def;
};
const s = (e: Entity, code: number) => e.codes.find(([c]) => c === code)?.[1] ?? "";

type Geom = { kind: "ring" | "line"; points: Point[] };

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): Point[] {
  let sweep = a1 - a0;
  if (sweep <= 0) sweep += 360;
  const steps = Math.max(4, Math.ceil(sweep / 15));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((a0 + (sweep * i) / steps) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Point;
  });
}

/**
 * Mirrored entities carry an extrusion of (0, 0, -1): their object coordinate
 * system has x negated relative to the world. Plans only need that case.
 */
function mirrored(e: Entity): boolean {
  return n(e, 230, 1) < 0 && e.type !== "LINE" && e.type !== "SOLID" && e.type !== "3DFACE";
}

/** Geometry of simple entities; POLYLINE sequences and INSERTs are handled by the caller. */
function geomOf(e: Entity): Geom | null {
  const g = rawGeomOf(e);
  if (g && mirrored(e)) g.points = g.points.map(([x, y]) => [-x, y]);
  return g;
}

function rawGeomOf(e: Entity): Geom | null {
  switch (e.type) {
    case "LINE":
      return { kind: "line", points: [[n(e, 10), n(e, 20)], [n(e, 11), n(e, 21)]] };
    case "LWPOLYLINE": {
      const pts: Point[] = [];
      let x: number | null = null;
      for (const [c, v] of e.codes) {
        if (c === 10) x = Number.parseFloat(v);
        else if (c === 20 && x !== null) {
          pts.push([x, Number.parseFloat(v)]);
          x = null;
        }
      }
      const closed = (n(e, 70) & 1) === 1;
      return pts.length >= 2 ? { kind: closed ? "ring" : "line", points: pts } : null;
    }
    case "SOLID":
    case "3DFACE": {
      // SOLID vertex order is 1, 2, 4, 3.
      const p: Point[] = [[n(e, 10), n(e, 20)], [n(e, 11), n(e, 21)], [n(e, 13), n(e, 23)], [n(e, 12), n(e, 22)]];
      return { kind: "ring", points: p };
    }
    case "CIRCLE":
      return { kind: "ring", points: arcPoints(n(e, 10), n(e, 20), n(e, 40), 0, 360) };
    case "ARC":
      return { kind: "line", points: arcPoints(n(e, 10), n(e, 20), n(e, 40), n(e, 50), n(e, 51)) };
    default:
      return null;
  }
}

interface Block {
  name: string;
  base: Point;
  entities: Entity[];
}

function transform(p: Point, ins: { x: number; y: number; sx: number; sy: number; rot: number }, base: Point): Point {
  const x = (p[0] - base[0]) * ins.sx;
  const y = (p[1] - base[1]) * ins.sy;
  const c = Math.cos(ins.rot);
  const si = Math.sin(ins.rot);
  return [ins.x + x * c - y * si, ins.y + x * si + y * c];
}

/** Collect every point of a block, expanding nested inserts to a small depth. */
function blockPoints(block: Block, blocks: Map<string, Block>, depth: number): Point[] {
  const pts: Point[] = [];
  const list = block.entities;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.type === "INSERT" && depth < 4) {
      const inner = blocks.get(s(e, 2));
      if (!inner) continue;
      const ins = { x: n(e, 10), y: n(e, 20), sx: n(e, 41, 1), sy: n(e, 42, 1), rot: (n(e, 50) * Math.PI) / 180 };
      for (const p of blockPoints(inner, blocks, depth + 1)) pts.push(transform(p, ins, inner.base));
    } else if (e.type === "VERTEX") {
      pts.push([n(e, 10), n(e, 20)]);
    } else {
      const g = geomOf(e);
      if (g) pts.push(...g.points);
    }
    if (pts.length > 200_000) break;
  }
  return pts;
}

export interface DxfResult {
  features: RawFeature[];
  unitsToFt: number;
  unitsName: string;
  layers: string[];
}

/**
 * Read a DXF. `units` overrides $INSUNITS; when the file is unitless and no
 * override is given, the unit is guessed from the depth of rack-like blocks.
 */
export function readDxf(text: string, opts: { units?: string } = {}): DxfResult {
  if (text.startsWith("AutoCAD Binary DXF")) throw new ImportError("This is a binary DXF. Save it again as ASCII DXF (any DXF version).");
  if (/^\s*AC10\d\d/.test(text)) throw new ImportError("This looks like a DWG file. Export it to DXF first: Autodesk DWG TrueView and the ODA File Converter both do it for free.");
  const toks = tokens(text);

  // Sections.
  const sections = new Map<string, [number, number]>();
  for (let i = 0; i < toks.length; i++) {
    if (toks[i][0] === 0 && toks[i][1] === "SECTION" && toks[i + 1]?.[0] === 2) {
      const name = toks[i + 1][1];
      let j = i + 2;
      while (j < toks.length && !(toks[j][0] === 0 && toks[j][1] === "ENDSEC")) j++;
      sections.set(name, [i + 2, j]);
      i = j;
    }
  }
  const entSec = sections.get("ENTITIES");
  if (!entSec) throw new ImportError("The DXF has no ENTITIES section.");

  let insunits = 0;
  const header = sections.get("HEADER");
  if (header) {
    for (let i = header[0]; i < header[1]; i++) {
      if (toks[i][0] === 9 && toks[i][1] === "$INSUNITS") {
        insunits = Number.parseInt(toks[i + 1]?.[1] ?? "0", 10);
        break;
      }
    }
  }

  const blocks = new Map<string, Block>();
  const blkSec = sections.get("BLOCKS");
  if (blkSec) {
    let cur: Block | null = null;
    for (const e of entitiesOf(toks, blkSec[0], blkSec[1])) {
      if (e.type === "BLOCK") cur = { name: s(e, 2), base: [n(e, 10), n(e, 20)], entities: [] };
      else if (e.type === "ENDBLK") {
        if (cur) blocks.set(cur.name, cur);
        cur = null;
      } else if (cur) cur.entities.push(e);
    }
  }

  const entities = entitiesOf(toks, entSec[0], entSec[1]);
  if (entities.length > LIMITS.maxEntities) throw new ImportError(`The DXF has ${entities.length.toLocaleString("en-US")} entities; the limit is ${LIMITS.maxEntities.toLocaleString("en-US")}. Freeze or delete annotation layers before exporting.`);
  const features: RawFeature[] = [];
  const loose = new Map<string, Array<[Point, Point]>>();
  const layers = new Set<string>();
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    // Paper-space entities are sheet furniture (title blocks, viewports), not the plan.
    if (n(e, 67) === 1) continue;
    layers.add(e.layer);
    if (e.type === "POLYLINE") {
      const pts: Point[] = [];
      let j = i + 1;
      for (; j < entities.length && entities[j].type !== "SEQEND"; j++) if (entities[j].type === "VERTEX") pts.push([n(entities[j], 10), n(entities[j], 20)]);
      i = j;
      if (pts.length >= 2) features.push({ source: e.layer, kind: (n(e, 70) & 1) === 1 ? "ring" : "line", points: pts });
      continue;
    }
    if (e.type === "INSERT") {
      const name = s(e, 2);
      const block = blocks.get(name);
      if (!block || name.startsWith("*")) continue;
      const ins = { x: n(e, 10), y: n(e, 20), sx: n(e, 41, 1), sy: n(e, 42, 1), rot: (n(e, 50) * Math.PI) / 180 };
      const flipX = mirrored(e);
      const pts = blockPoints(block, blocks, 0).map((p) => {
        const q = transform(p, ins, block.base);
        return flipX ? ([-q[0], q[1]] as Point) : q;
      });
      if (pts.length < 2) continue;
      // Arrays of inserts (MINSERT-style rows and columns) repeat the block.
      const cols = Math.max(1, n(e, 70, 1));
      const rows = Math.max(1, n(e, 71, 1));
      const dc = n(e, 44);
      const dr = n(e, 45);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const off = rotateOffset(c * dc, r * dr, ins.rot);
          features.push({ source: `${e.layer}|${name}`, kind: "ring", points: convexHull(pts.map(([x, y]) => [x + off[0], y + off[1]] as Point)) });
        }
      }
      continue;
    }
    const g = geomOf(e);
    if (!g) continue;
    if (e.type === "LINE") {
      const list = loose.get(e.layer) ?? [];
      list.push([g.points[0], g.points[1]]);
      loose.set(e.layer, list);
    } else {
      features.push({ source: e.layer, kind: g.kind, points: g.points });
    }
  }

  // Units.
  let unitsToFt: number;
  let unitsName: string;
  if (opts.units) {
    const u = UNIT_NAMES[opts.units.toLowerCase()];
    if (!u) throw new ImportError(`Unknown units "${opts.units}". Use in, ft, mm, cm, m or yd.`);
    unitsToFt = u;
    unitsName = `${opts.units} (given)`;
  } else if (INSUNITS_TO_FT[insunits]) {
    unitsToFt = INSUNITS_TO_FT[insunits].ft;
    unitsName = INSUNITS_TO_FT[insunits].name;
  } else {
    const guess = guessUnits(features, loose);
    unitsToFt = guess.ft;
    unitsName = `${guess.name} (guessed; pass units to override)`;
  }

  // Chain loose lines per layer; closed chains are rings. Scale everything.
  const tol = 0.05 / unitsToFt;
  for (const [layer, segs] of loose) {
    for (const chain of chainSegments(segs, tol)) {
      const closed = isClosed(chain, tol);
      features.push({ source: layer, kind: closed ? "ring" : "line", points: closed ? chain.slice(0, -1) : chain });
    }
  }
  for (const f of features) f.points = f.points.map(([x, y]) => [x * unitsToFt, y * unitsToFt]);
  return { features, unitsToFt, unitsName, layers: [...layers] };
}

function rotateOffset(x: number, y: number, rot: number): Point {
  return [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)];
}

/**
 * Guess the unit of a unitless drawing from the overall extent: warehouse
 * buildings are 80–1,500 ft on a side, which is 24–460 m, 960–18,000 in, or
 * 24,000–460,000 mm. Feet and meters overlap, so the typical short side of a
 * closed rectangle (racks, columns, doors: 2–10 ft, 0.6–3 m) decides between them.
 */
function guessUnits(features: RawFeature[], loose: Map<string, Array<[Point, Point]>>): { ft: number; name: string } {
  const pts: Point[] = features.flatMap((f) => f.points);
  for (const segs of loose.values()) for (const [a, b] of segs) pts.push(a, b);
  if (pts.length === 0) return { ft: 1, name: "feet" };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  if (extent > 20_000) return { ft: 0.00328084, name: "millimeters" };
  if (extent > 2_500) return { ft: 1 / 12, name: "inches" };
  const shorts = features
    .filter((f) => f.kind === "ring" && f.points.length >= 4)
    .map((f) => {
      const xs = f.points.map((p) => p[0]);
      const ys = f.points.map((p) => p[1]);
      return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    })
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const median = shorts.length ? shorts[Math.floor(shorts.length / 2)] : 0;
  if (median > 0 && median < 1.8 && extent < 600) return { ft: 3.28084, name: "meters" };
  return { ft: 1, name: "feet" };
}
