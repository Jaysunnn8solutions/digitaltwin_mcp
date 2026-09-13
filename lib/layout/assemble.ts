/**
 * From classified drawing features to a layout spec. Every importer reduces
 * its format to RawFeatures (shapes in feet with a source label such as a
 * DXF layer, an IMDF category or an IFC type and name); this module decides
 * what each one is, orients the building, turns rack footprints into runs,
 * picks the dock doors, and checks the result builds.
 *
 * Orientation: racks are rotated to run in y, and the building is turned so
 * the wall with the dock doors is y = 0.
 */

import { bbox, convexHull, dominantAngle, orientedBox, rotate, simplify, type OrientedBox } from "./geometry";
import { LIMITS } from "./limits";
import { compactSpec, type DoorSpec, type LayoutSpec, type Point, type RackRun, type ZoneSpec } from "./spec";

export type Role = "pick" | "reserve" | "mixed" | "rack" | "door" | "door-inbound" | "door-outbound" | "wall" | "outline" | "staging" | "office" | "zone" | "ignore";
export const ROLES: Role[] = ["pick", "reserve", "mixed", "rack", "door", "door-inbound", "door-outbound", "wall", "outline", "staging", "office", "zone", "ignore"];

export interface RawFeature {
  /** What the file calls it: a layer, block, category or type and name. Matched against role patterns. */
  source: string;
  kind: "ring" | "line" | "point";
  points: Point[];
  /** The importer's semantic reading (an IMDF category, an IFC type), used when no pattern matches. */
  hint?: Role;
  widthFt?: number;
}

export interface AssembleOptions {
  name: string;
  format: LayoutSpec["source"]["format"];
  file?: string;
  /** Pattern → role. A pattern is a case-insensitive substring, or /regex/. Checked before the defaults. */
  roleMap?: Record<string, Role>;
  levels?: number;
  pickLevels?: number;
  bayWidthFt?: number;
  slotsPerBay?: number;
  aisleWidthFt?: number;
  /** What an unlabelled rack is. auto: shelving-depth runs pick, the rest reserve, or mixed when nothing is pick. */
  rackUse?: "auto" | "pick" | "reserve" | "mixed";
  notes?: string[];
}

export class ImportError extends Error {}

export interface ImportReport {
  sources: Array<{ source: string; role: Role; features: number }>;
  rotationDeg: number;
  racks: { runs: number; pick: number; reserve: number; mixed: number };
  doors: { inbound: number; outbound: number };
  walls: number;
  zones: number;
  notes: string[];
}

const DEFAULT_PATTERNS: Array<[RegExp, Role]> = [
  [/(^|[^a-z])(text|dim|dimension|anno|annotation|hatch|grid|title|border|defpoints|viewport|xref|symbol|light|elec|plumb|hvac|sprink)/i, "ignore"],
  [/(receiv|recv|inbound)/i, "door-inbound"],
  [/(shipping|ship|outbound)/i, "door-outbound"],
  [/(dock|door|overhead|ohd|opening|leveler)/i, "door"],
  [/(mixed)/i, "mixed"],
  [/(pick|shelv|shlf|flow|carton|forward|bin)/i, "pick"],
  [/(reserve|pallet|bulk|overstock|high.?bay)/i, "reserve"],
  // A-EQPM, A-FURN-STOR and Q-SPCL are where NCS drawings usually put racking.
  [/(rack|racking|gondola|eqpm|furn-stor|q-spcl)/i, "rack"],
  [/(outline|otln|footprint|perimeter|exterior|building|bldg)/i, "outline"],
  [/(wall|partition|column|a-cols)/i, "wall"],
  [/(staging|stage|marshal)/i, "staging"],
  [/(office|restroom|toilet|break|lobby|locker)/i, "office"],
];

function matchPattern(pattern: string, source: string): boolean {
  const m = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try {
      return new RegExp(m[1], m[2].includes("i") ? m[2] : `${m[2]}i`).test(source);
    } catch {
      return false;
    }
  }
  return source.toLowerCase().includes(pattern.toLowerCase());
}

export function roleOf(f: RawFeature, roleMap?: Record<string, Role>): Role {
  for (const [p, r] of Object.entries(roleMap ?? {})) if (matchPattern(p, f.source)) return r;
  // Door-direction words also appear on non-door layers ("RECEIVING OFFICE"), so a direction only counts on a door.
  let role: Role | null = null;
  for (const [re, r] of DEFAULT_PATTERNS) {
    if (!re.test(f.source)) continue;
    if ((r === "door-inbound" || r === "door-outbound") && !/(dock|door|overhead|ohd|opening|leveler)/i.test(f.source) && f.hint !== "door") continue;
    role = r;
    break;
  }
  return role ?? f.hint ?? "ignore";
}

// ---------------------------------------------------------------------------

interface RackBox extends OrientedBox {
  role: "pick" | "reserve" | "mixed" | "rack";
  source: string;
}

export function assemble(features: RawFeature[], opts: AssembleOptions): { spec: LayoutSpec; report: ImportReport } {
  if (features.length > LIMITS.maxEntities) throw new ImportError(`The file has ${features.length.toLocaleString("en-US")} shapes; the limit is ${LIMITS.maxEntities.toLocaleString("en-US")}. Delete annotation and furniture layers before exporting.`);
  const notes = [...(opts.notes ?? [])];
  const bySource = new Map<string, { role: Role; features: number }>();
  const classified = features.map((f) => {
    const role = roleOf(f, opts.roleMap);
    const s = bySource.get(f.source) ?? { role, features: 0 };
    s.features++;
    bySource.set(f.source, s);
    return { f, role };
  });

  // Rack footprints.
  const boxes: RackBox[] = [];
  for (const { f, role } of classified) {
    if (!["pick", "reserve", "mixed", "rack"].includes(role) || f.points.length < 2) continue;
    const ob = orientedBox(f.points);
    if (!ob || ob.length < 1.5 || ob.width < 0.5 || ob.width > 16) continue;
    boxes.push({ ...ob, role: role as RackBox["role"], source: f.source });
  }
  if (boxes.length === 0) {
    const seen = [...bySource.entries()].slice(0, 25).map(([s, v]) => `${s} → ${v.role}`).join("; ");
    throw new ImportError(`No racks found. Sources and how they were read: ${seen || "none"}. Pass roleMap to say which layers or categories are racks, e.g. {"A-EQPM-STOR": "reserve", "SHELF": "pick"}.`);
  }

  // Orient: racks along y.
  const angle = dominantAngle(boxes.map((b) => ({ angle: b.angle, weight: b.length })));
  let theta = Math.PI / 2 - angle;
  const all = classified.filter((c) => c.role !== "ignore").flatMap((c) => c.f.points);
  const turn = (p: Point): Point => rotate(p, theta);
  let pts = all.map(turn);
  let bb = bbox(pts);

  // Doors decide which side is the dock; turn it to y = 0.
  const doorFeatures = classified.filter((c) => c.role === "door" || c.role === "door-inbound" || c.role === "door-outbound");
  const doorCenters = doorFeatures.map((c) => {
    const p = c.f.points.map(turn);
    const b = bbox(p);
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] as Point;
  });
  let flip = false;
  if (doorCenters.length) {
    const d = { bottom: 0, top: 0, left: 0, right: 0 };
    for (const [x, y] of doorCenters) {
      const dist = { bottom: y - bb.minY, top: bb.maxY - y, left: x - bb.minX, right: bb.maxX - x };
      const side = (Object.keys(dist) as Array<keyof typeof dist>).reduce((a, k) => (dist[k] < dist[a] ? k : a), "bottom");
      d[side]++;
    }
    const side = (Object.keys(d) as Array<keyof typeof d>).reduce((a, k) => (d[k] > d[a] ? k : a), "bottom");
    if (side === "top") flip = true;
    if (side === "left" || side === "right") notes.push("The dock doors are on a wall parallel to the rack runs; routing assumes the front cross aisle is on the dock side, so travel is approximate.");
  } else {
    notes.push("No dock doors found; two doors were placed on the wall nearest the racks' front ends. Pass roleMap to map the door layer.");
  }
  if (flip) theta += Math.PI;
  pts = all.map((p) => rotate(p, theta));
  bb = bbox(pts);
  const T = (p: Point): Point => {
    const r = rotate(p, theta);
    return [r[0] - bb.minX, r[1] - bb.minY];
  };
  const W = bb.maxX - bb.minX;
  const D = bb.maxY - bb.minY;
  if (W > LIMITS.maxSideFt || D > LIMITS.maxSideFt) {
    throw new ImportError(`The drawing is ${Math.round(W)}×${Math.round(D)} ft, over the ${LIMITS.maxSideFt} ft limit on a side. Check the units (pass units, e.g. "mm" or "in"), or delete site-plan geometry around the building.`);
  }
  const rotationDeg = Math.round((((theta * 180) / Math.PI) % 360 + 360) % 360);

  // Racks → runs. A box deeper than a pallet rack is back to back: split it.
  // Pallet-rack bays are typically 9 ft and shelving sections 8 ft.
  const bayWidthFor = (use: RackRun["use"]) => opts.bayWidthFt ?? (use === "pick" ? 8 : 9);
  const placed = boxes.flatMap((b) => {
    const [cx, cy] = T([b.cx, b.cy]);
    const one = { x: cx, y0: cy - b.length / 2, y1: cy + b.length / 2, depth: b.width, role: b.role, source: b.source };
    if (b.width >= 6.5) return [{ ...one, x: cx - b.width / 4, depth: b.width / 2 }, { ...one, x: cx + b.width / 4, depth: b.width / 2 }];
    return [one];
  });
  placed.sort((a, b) => a.x - b.x || a.y0 - b.y0);
  type Group = { x: number; depth: number; y0: number; y1: number; count: number; longest: number; role: RackBox["role"]; sources: Set<string> };
  const groups: Group[] = [];
  for (const p of placed) {
    const g = groups.find((q) => Math.abs(q.x - p.x) < 0.75 && Math.abs(q.depth - p.depth) < 1 && q.role === p.role && p.y0 - q.y1 <= 1.5 && p.y0 >= q.y0 - 0.5);
    if (g) {
      g.y1 = Math.max(g.y1, p.y1);
      g.count++;
      g.longest = Math.max(g.longest, p.y1 - p.y0);
      g.sources.add(p.source);
    } else {
      groups.push({ x: p.x, depth: p.depth, y0: p.y0, y1: p.y1, count: 1, longest: p.y1 - p.y0, role: p.role, sources: new Set([p.source]) });
    }
  }
  const hasPick = groups.some((g) => g.role === "pick" || g.role === "mixed");
  const racks: RackRun[] = groups.map((g, i) => {
    let use: RackRun["use"];
    if (g.role === "pick" || g.role === "reserve" || g.role === "mixed") use = g.role;
    else if (opts.rackUse && opts.rackUse !== "auto") use = opts.rackUse;
    else if (g.depth < 3) use = "pick";
    else use = hasPick ? "reserve" : "mixed";
    const length = g.y1 - g.y0;
    // Drawn bay by bay: one box a bay. Drawn as a run: divide by bay width.
    const bays = g.count > 1 && g.longest <= 14 ? g.count : Math.max(1, Math.round(length / bayWidthFor(use)));
    const levels = use === "pick" ? (opts.pickLevels ?? opts.levels ?? 4) : (opts.levels ?? 4);
    return { id: `RK${i + 1}`, use, x: g.x, y0: g.y0, y1: g.y1, depthFt: Math.max(1, g.depth), bays: Math.min(500, bays), levels, slotsPerBay: use === "reserve" ? 1 : (opts.slotsPerBay ?? 1) };
  });
  if (!hasPick && racks.some((r) => r.use === "mixed")) notes.push("No racks were marked pick, so racks deeper than shelving pick from level 1 and store pallets above (mixed). Pass roleMap or rackUse to change that.");

  // Doors: on or near the dock wall.
  const doors: DoorSpec[] = [];
  const doorCands = doorFeatures.map((c) => {
    const p = c.f.points.map(T);
    const b = bbox(p);
    const width = c.f.widthFt ?? Math.max(b.maxX - b.minX, b.maxY - b.minY, 0);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, width, role: c.role };
  });
  const dock = doorCands.filter((d) => d.y <= Math.max(25, D * 0.15));
  const skipped = doorCands.length - dock.length;
  if (skipped > 0) notes.push(`${skipped} door(s) away from the dock wall were treated as personnel doors and ignored.`);
  const narrow = dock.filter((d) => d.width > 0 && d.width < 6);
  const dockDoors = dock.length - narrow.length >= 2 ? dock.filter((d) => !(d.width > 0 && d.width < 6)) : dock;
  if (narrow.length && dockDoors.length < dock.length) notes.push(`${narrow.length} door(s) under 6 ft wide on the dock wall were treated as personnel doors.`);
  dockDoors.sort((a, b) => a.x - b.x);
  const explicit = dockDoors.some((d) => d.role !== "door");
  dockDoors.forEach((d, i) => {
    let kind: "inbound" | "outbound";
    if (d.role === "door-inbound") kind = "inbound";
    else if (d.role === "door-outbound") kind = "outbound";
    else if (explicit) kind = dockDoors.filter((x) => x.role === "door-inbound").length <= dockDoors.filter((x) => x.role === "door-outbound").length ? "inbound" : "outbound";
    else kind = i < Math.max(1, Math.round(dockDoors.length * 0.4)) ? "inbound" : "outbound";
    doors.push({ id: "", kind, x: d.x, y: Math.max(0, d.y), widthFt: d.width >= 6 ? d.width : 9 });
  });
  if (doors.length && !explicit) notes.push("Door directions were not labelled: the left 40% of dock doors are taken as receiving and the rest as shipping.");
  if (doors.length === 1) {
    doors.push({ ...doors[0], kind: doors[0].kind === "inbound" ? "outbound" : "inbound" });
    notes.push("Only one dock door: it serves both receiving and shipping.");
  }
  if (doors.length === 0) {
    const x0 = Math.min(...racks.map((r) => r.x));
    const x1 = Math.max(...racks.map((r) => r.x));
    doors.push({ id: "", kind: "inbound", x: x0 + (x1 - x0) * 0.25, y: 0, widthFt: 9 }, { id: "", kind: "outbound", x: x0 + (x1 - x0) * 0.75, y: 0, widthFt: 9 });
  }
  if (!doors.some((d) => d.kind === "inbound")) doors[0].kind = "inbound";
  if (!doors.some((d) => d.kind === "outbound")) doors[doors.length - 1].kind = "outbound";
  if (doors.length > LIMITS.maxDoors) throw new ImportError(`Found ${doors.length} dock doors; the limit is ${LIMITS.maxDoors}. Map the door layer more narrowly with roleMap.`);
  let nIn = 0;
  let nOut = 0;
  for (const d of doors) d.id = d.kind === "inbound" ? `IN-${++nIn}` : `OUT-${++nOut}`;

  // Walls, outline, zones: drawing only, simplified.
  let wallPoints = 0;
  const walls: Point[][] = [];
  for (const { f, role } of classified) {
    if (role !== "wall" || f.points.length < 2) continue;
    const w = simplify(f.points.map(T), 0.5);
    wallPoints += w.length;
    if (wallPoints > 20_000) {
      notes.push("Wall geometry was truncated at 20,000 points; it is only drawn, so the simulation is unaffected.");
      break;
    }
    walls.push(f.kind === "ring" ? [...w, w[0]] : w);
  }
  const outlines = classified.filter((c) => c.role === "outline" && c.f.points.length >= 3).map((c) => c.f.points.map(T));
  let outline: Point[];
  if (outlines.length) {
    outline = simplify(outlines.sort((a, b) => area(b) - area(a))[0], 0.5);
  } else {
    outline = [[0, 0], [W, 0], [W, D], [0, D]];
    notes.push("No building outline layer; the outline is the extent of the drawing.");
  }
  const zones: ZoneSpec[] = [];
  for (const { f, role } of classified) {
    if ((role !== "staging" && role !== "office" && role !== "zone") || f.points.length < 3 || zones.length >= 500) continue;
    zones.push({ kind: role === "zone" ? "other" : role, name: f.source.slice(0, 80), ring: simplify(convexHull(f.points.map(T)), 0.5).slice(0, 500) });
  }

  const spec = compactSpec({
    version: 1,
    name: opts.name.slice(0, 120),
    source: { format: opts.format, file: opts.file?.slice(0, 260), notes: notes.slice(0, 50).map((n) => n.slice(0, 400)) },
    widthFt: Math.max(W, 1),
    depthFt: Math.max(D, 1),
    outline,
    walls,
    zones,
    racks,
    doors,
    aisleWidthFt: opts.aisleWidthFt ?? 10,
  });
  const report: ImportReport = {
    sources: [...bySource.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.features - a.features),
    rotationDeg,
    racks: { runs: racks.length, pick: racks.filter((r) => r.use === "pick").length, reserve: racks.filter((r) => r.use === "reserve").length, mixed: racks.filter((r) => r.use === "mixed").length },
    doors: { inbound: nIn, outbound: nOut },
    walls: walls.length,
    zones: zones.length,
    notes,
  };
  return { spec, report };
}

function area(ring: Point[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Build a spec directly from rack runs already in the canonical frame (the
 * CSV importer's path), adding doors, outline and the same report.
 */
export function specFromRuns(
  racks: RackRun[],
  doorsIn: Array<{ kind?: "inbound" | "outbound"; x: number; y: number; widthFt?: number }>,
  opts: AssembleOptions & { marginFt?: number }
): { spec: LayoutSpec; report: ImportReport } {
  if (racks.length === 0) throw new ImportError("No rack locations found in the file.");
  if (racks.length > LIMITS.maxRackRuns) throw new ImportError(`The file describes ${racks.length} rack runs; the limit is ${LIMITS.maxRackRuns}.`);
  const notes = [...(opts.notes ?? [])];
  const margin = opts.marginFt ?? 20;
  const minX = Math.min(...racks.map((r) => r.x - r.depthFt / 2), ...doorsIn.map((d) => d.x)) - margin;
  const minY = Math.min(0, ...racks.map((r) => r.y0 - 40), ...doorsIn.map((d) => d.y));
  const maxX = Math.max(...racks.map((r) => r.x + r.depthFt / 2), ...doorsIn.map((d) => d.x)) + margin;
  const maxY = Math.max(...racks.map((r) => r.y1), ...doorsIn.map((d) => d.y)) + margin;
  const shifted = racks.map((r) => ({ ...r, x: r.x - minX, y0: r.y0 - minY, y1: r.y1 - minY }));
  const W = maxX - minX;
  const D = maxY - minY;
  if (W > LIMITS.maxSideFt || D > LIMITS.maxSideFt) throw new ImportError(`The locations span ${Math.round(W)}×${Math.round(D)} ft, over the ${LIMITS.maxSideFt} ft limit; check the coordinate units.`);
  let doors: DoorSpec[] = doorsIn.map((d) => ({ id: "", kind: d.kind ?? "inbound", x: d.x - minX, y: Math.max(0, d.y - minY), widthFt: d.widthFt ?? 9 }));
  if (doors.length === 0) {
    const x0 = Math.min(...shifted.map((r) => r.x));
    const x1 = Math.max(...shifted.map((r) => r.x));
    doors = [0.15, 0.3, 0.6, 0.75, 0.9].map((t, i) => ({ id: "", kind: i < 2 ? "inbound" : "outbound", x: x0 + (x1 - x0) * t, y: 0, widthFt: 9 }));
    notes.push("The file has no doors; two receiving and three shipping doors were placed along the front wall.");
  } else if (!doorsIn.some((d) => d.kind)) {
    doors.sort((a, b) => a.x - b.x).forEach((d, i) => (d.kind = i < Math.max(1, Math.round(doors.length * 0.4)) ? "inbound" : "outbound"));
    notes.push("Door directions were not given: the left 40% are receiving.");
  }
  if (!doors.some((d) => d.kind === "inbound")) doors[0].kind = "inbound";
  if (!doors.some((d) => d.kind === "outbound")) doors[doors.length - 1].kind = "outbound";
  let nIn = 0;
  let nOut = 0;
  for (const d of doors) d.id = d.kind === "inbound" ? `IN-${++nIn}` : `OUT-${++nOut}`;
  const spec = compactSpec({
    version: 1,
    name: opts.name.slice(0, 120),
    source: { format: opts.format, file: opts.file?.slice(0, 260), notes: notes.slice(0, 50) },
    widthFt: W,
    depthFt: D,
    outline: [[0, 0], [W, 0], [W, D], [0, D]],
    walls: [],
    zones: [{ kind: "staging", name: "Dock staging", ring: [[0, 0], [W, 0], [W, Math.min(40, D / 4)], [0, Math.min(40, D / 4)]] }],
    racks: shifted,
    doors,
    aisleWidthFt: opts.aisleWidthFt ?? 10,
  });
  return {
    spec,
    report: {
      sources: [],
      rotationDeg: 0,
      racks: { runs: racks.length, pick: racks.filter((r) => r.use === "pick").length, reserve: racks.filter((r) => r.use === "reserve").length, mixed: racks.filter((r) => r.use === "mixed").length },
      doors: { inbound: nIn, outbound: nOut },
      walls: 0,
      zones: 1,
      notes,
    },
  };
}
