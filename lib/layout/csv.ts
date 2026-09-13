/**
 * WMS location master (CSV). Usually the most precise input for a
 * distribution center: every location already says its zone, aisle, bay and
 * level, and often its coordinates.
 *
 * Columns (header names are matched loosely, case-insensitive):
 *   location | loc | location_id | id        optional
 *   zone | type | area | location_type        pick / reserve / door (free text: "forward pick", "pallet reserve", "dock door receiving")
 *   aisle                                     required for locations
 *   bay | section | column | position         required for locations
 *   level | shelf | tier                      default 1
 *   slot | sub | bin                          optional
 *   side                                      optional L/R; without it and without x/y, odd bays are left and even bays right
 *   x, y                                      optional coordinates in `units`
 *   direction | kind                          for doors: inbound/outbound
 *   width                                     for doors, optional
 *
 * With coordinates, each aisle-side group becomes a run at its mean x (or y,
 * if the aisle runs across). Without them, aisles are laid out in order with
 * standard pitches, reserve on the left and pick on the right.
 */

import { ImportError, specFromRuns, type AssembleOptions, type ImportReport } from "./assemble";
import { UNIT_NAMES } from "./dxf";
import { LIMITS } from "./limits";
import type { LayoutSpec, RackRun } from "./spec";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  location: ["location", "loc", "location_id", "locationid", "id", "slot_id"],
  zone: ["zone", "type", "area", "location_type", "loc_type", "zone_type", "use"],
  aisle: ["aisle", "aisle_id", "row"],
  bay: ["bay", "section", "column", "col", "position", "bay_id"],
  level: ["level", "shelf", "tier", "lvl", "height"],
  slot: ["slot", "sub", "bin", "subslot", "position_in_bay"],
  side: ["side", "face"],
  x: ["x", "x_ft", "xft", "x_m", "easting", "coord_x"],
  y: ["y", "y_ft", "yft", "y_m", "northing", "coord_y"],
  direction: ["direction", "kind", "door_type", "flow"],
  width: ["width", "width_ft", "door_width"],
};

function columns(header: string[]): Record<string, number> {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const out: Record<string, number> = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) out[key] = i;
  }
  return out;
}

const naturalKey = (s: string) => s.replace(/\d+/g, (d) => d.padStart(8, "0"));

export function readCsv(text: string, opts: AssembleOptions & { units?: string }): { spec: LayoutSpec; report: ImportReport } {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportError("The CSV needs a header row and at least one location.");
  if (rows.length > 1_000_000) throw new ImportError("The CSV has over a million rows.");
  const col = columns(rows[0]);
  if (col.aisle === undefined || col.bay === undefined) {
    throw new ImportError(`The CSV needs aisle and bay columns (found: ${rows[0].join(", ")}). Accepted names: aisle; bay, section, column or position; level, shelf or tier; zone or type; x and y.`);
  }
  const scale = opts.units ? UNIT_NAMES[opts.units.toLowerCase()] : 1;
  if (!scale) throw new ImportError(`Unknown units "${opts.units}". Use in, ft, mm, cm, m or yd.`);
  const get = (r: string[], k: string) => (col[k] === undefined ? "" : (r[col[k]] ?? "").trim());
  const hasXY = col.x !== undefined && col.y !== undefined;
  const notes: string[] = [...(opts.notes ?? [])];

  type Loc = { zone: "pick" | "reserve"; aisle: string; bay: string; level: number; slot: string; side: string; x: number; y: number };
  const locs: Loc[] = [];
  const doors: Array<{ kind?: "inbound" | "outbound"; x: number; y: number; widthFt?: number }> = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const zoneText = get(r, "zone").toLowerCase();
    if (/door|dock/.test(zoneText)) {
      if (!hasXY) {
        skipped++;
        continue;
      }
      const dir = `${get(r, "direction")} ${zoneText}`.toLowerCase();
      const kind = /in|recv|receiv/.test(dir) && !/out|ship/.test(dir) ? "inbound" : /out|ship/.test(dir) ? "outbound" : undefined;
      doors.push({ kind, x: Number.parseFloat(get(r, "x")) * scale, y: Number.parseFloat(get(r, "y")) * scale, widthFt: get(r, "width") ? Number.parseFloat(get(r, "width")) * scale : undefined });
      continue;
    }
    const aisle = get(r, "aisle");
    const bay = get(r, "bay");
    if (!aisle || !bay) {
      skipped++;
      continue;
    }
    const level = Number.parseInt(get(r, "level") || "1", 10);
    const zone: Loc["zone"] = /pick|shelf|shelv|forward|flow|carton|each/.test(zoneText) ? "pick" : /reserve|pallet|bulk|overstock|storage|rack/.test(zoneText) ? "reserve" : "reserve";
    const x = hasXY ? Number.parseFloat(get(r, "x")) * scale : NaN;
    const y = hasXY ? Number.parseFloat(get(r, "y")) * scale : NaN;
    if (hasXY && (!Number.isFinite(x) || !Number.isFinite(y))) {
      skipped++;
      continue;
    }
    locs.push({ zone, aisle, bay, level: Number.isFinite(level) && level > 0 ? level : 1, slot: get(r, "slot"), side: get(r, "side").toUpperCase().slice(0, 1), x, y });
  }
  if (skipped) notes.push(`${skipped} row(s) without an aisle and bay${hasXY ? " or coordinates" : ""} were skipped.`);
  if (locs.length === 0) throw new ImportError("No usable location rows.");
  if (!locs.some((l) => l.zone === "pick") && !opts.rackUse) notes.push("No rows are labelled pick; level 1 of every location is used as a pick face (mixed racks).");

  // Group into runs: zone use is decided per aisle-side group.
  const groups = new Map<string, Loc[]>();
  for (const l of locs) {
    let side = l.side === "L" || l.side === "R" ? l.side : "";
    if (!side && !hasXY) {
      const num = Number.parseInt(l.bay.replace(/\D+/g, ""), 10);
      side = Number.isFinite(num) && num % 2 === 0 ? "R" : "L";
    }
    const key = `${l.aisle}|${side}`;
    const list = groups.get(key) ?? [];
    list.push(l);
    groups.set(key, list);
  }

  const rackUseOf = (g: Loc[]): RackRun["use"] => {
    if (opts.rackUse && opts.rackUse !== "auto") return opts.rackUse;
    const pick = g.filter((l) => l.zone === "pick");
    if (!locs.some((l) => l.zone === "pick")) return "mixed";
    if (pick.length === g.length) return "pick";
    if (pick.length === 0) return "reserve";
    return pick.every((l) => l.level === 1) ? "mixed" : "pick";
  };
  const shape = (g: Loc[]) => {
    const bays = [...new Set(g.map((l) => l.bay))];
    const levels = Math.max(...g.map((l) => l.level));
    const perBayLevel = new Map<string, Set<string>>();
    for (const l of g) {
      const k = `${l.bay}|${l.level}`;
      const set = perBayLevel.get(k) ?? new Set();
      set.add(l.slot);
      perBayLevel.set(k, set);
    }
    const slots = Math.min(10, Math.max(1, ...[...perBayLevel.values()].map((v) => v.size)));
    return { bays: Math.min(500, bays.length), levels: Math.min(12, levels), slots };
  };

  const racks: RackRun[] = [];
  let i = 0;
  if (hasXY) {
    // Aisles along y if locations in a group spread more in y than in x.
    let vertical = 0;
    let horizontal = 0;
    for (const g of groups.values()) {
      const xs = g.map((l) => l.x);
      const ys = g.map((l) => l.y);
      const sx = Math.max(...xs) - Math.min(...xs);
      const sy = Math.max(...ys) - Math.min(...ys);
      if (sy >= sx) vertical += g.length;
      else horizontal += g.length;
    }
    const swap = horizontal > vertical;
    if (swap) notes.push("Aisles run along x in the file; the layout is turned so they run front to back.");
    // Within an aisle without a side column, split locations by which side of the aisle's median they fall.
    const split = new Map<string, Loc[]>();
    for (const [key, g] of groups) {
      if (!key.endsWith("|")) {
        split.set(key, g);
        continue;
      }
      const across = g.map((l) => (swap ? l.y : l.x)).sort((a, b) => a - b);
      const mid = (across[0] + across[across.length - 1]) / 2;
      const spread = across[across.length - 1] - across[0];
      if (spread < 1) {
        // Coordinates at the aisle centerline: both faces share an x. Split by
        // the odd/even bay convention and set the faces either side of it.
        const odd = g.filter((l) => Number.parseInt(l.bay.replace(/\D+/g, ""), 10) % 2 === 1);
        const even = g.filter((l) => !odd.includes(l));
        const off = (l: Loc[], sign: number) => l.map((q) => (swap ? { ...q, y: q.y + sign * 4 } : { ...q, x: q.x + sign * 4 }));
        if (odd.length && even.length) {
          split.set(`${key}L`, off(odd, -1));
          split.set(`${key}R`, off(even, 1));
        } else split.set(`${key}L`, off(g, -1));
      } else {
        split.set(`${key}L`, g.filter((l) => (swap ? l.y : l.x) <= mid));
        split.set(`${key}R`, g.filter((l) => (swap ? l.y : l.x) > mid));
      }
    }
    for (const [key, g] of [...split].sort((a, b) => naturalKey(a[0]).localeCompare(naturalKey(b[0])))) {
      if (!g.length) continue;
      const along = g.map((l) => (swap ? l.x : l.y));
      const across = g.map((l) => (swap ? l.y : l.x));
      const { bays, levels, slots } = shape(g);
      const len = Math.max(...along) - Math.min(...along);
      const pitch = bays > 1 ? len / (bays - 1) : 8;
      const use = rackUseOf(g);
      racks.push({
        id: `A${key.replace("|", "")}`.slice(0, 40) || `RK${++i}`,
        use,
        x: across.reduce((a, b) => a + b, 0) / across.length,
        y0: Math.min(...along) - pitch / 2,
        y1: Math.max(...along) + pitch / 2,
        depthFt: use === "pick" ? 2 : 4,
        bays,
        levels,
        slotsPerBay: use === "reserve" ? 1 : slots,
      });
    }
    if (swap) for (const d of doors) [d.x, d.y] = [d.y, d.x];
  } else {
    notes.push("No coordinates: aisles are laid out in order at standard pitches (pick 10 ft, reserve 19 ft, bays 8–9 ft), reserve on the left.");
    const aisleIds = (zoneUse: "pick" | "reserve") =>
      [...new Set([...groups.entries()].filter(([, g]) => (rackUseOf(g) === "pick") === (zoneUse === "pick")).map(([k]) => k.split("|")[0]))].sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)));
    let x = 20;
    for (const zoneUse of ["reserve", "pick"] as const) {
      const depth = zoneUse === "pick" ? 2 : 4;
      const aisleW = zoneUse === "pick" ? 6 : 11;
      const bayW = zoneUse === "pick" ? 8 : 9;
      const ids = aisleIds(zoneUse);
      for (const a of ids) {
        for (const side of ["L", "R"] as const) {
          const g = groups.get(`${a}|${side}`);
          if (!g) continue;
          const { bays, levels, slots } = shape(g);
          const use = rackUseOf(g);
          racks.push({ id: `A${a}${side}`.slice(0, 40), use, x: side === "L" ? x + depth / 2 : x + depth + aisleW + depth / 2, y0: 60, y1: 60 + bays * bayW, depthFt: depth, bays, levels, slotsPerBay: use === "reserve" ? 1 : slots });
        }
        x += 2 * depth + aisleW;
      }
      if (ids.length) x += 30;
    }
  }
  if (racks.length > LIMITS.maxRackRuns) throw new ImportError(`The CSV describes ${racks.length} aisle faces; the limit is ${LIMITS.maxRackRuns}.`);
  return specFromRuns(racks, doors, { ...opts, notes });
}
