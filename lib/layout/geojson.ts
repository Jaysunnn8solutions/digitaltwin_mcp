/**
 * Indoor GeoJSON: IMDF archives (OGC CS 20-094), ArcGIS Indoors exports
 * (Features To JSON on the Indoors model's classes), and plain GeoJSON with
 * name, layer or category properties.
 *
 * IMDF has no rack or dock categories: racks arrive as fixtures of category
 * equipment, furniture or obstruction, recognised by name; dock doors as
 * openings of category service or automobile. ArcGIS Indoors' USE_TYPE is
 * free text on Units and Details ("Wall", "Door", "Opening", "Storage Rack").
 * Coordinates are WGS84 lon/lat (IMDF, RFC 7946), or Web Mercator when an
 * Indoors export kept its native reference and says so in a crs member.
 */

import { unzipSync } from "fflate";
import { assemble, ImportError, type AssembleOptions, type ImportReport, type RawFeature, type Role } from "./assemble";
import { lonLatToFeet } from "./geometry";
import { LIMITS, formatBytes } from "./limits";
import type { LayoutSpec, Point } from "./spec";

interface GeoFeature {
  type: "Feature";
  id?: string | number;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
  feature_type?: string;
}

interface Collection {
  /** File or class name, e.g. "unit" for unit.geojson or "Details". */
  name: string;
  crs?: string;
  features: GeoFeature[];
}

const RACK_NAME = /(rack|shelv|shelf|pallet|gondola|storage.?unit)/i;

function label(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o.en ?? Object.values(o)[0] ?? "");
  }
  return String(v);
}

/** Every ring or line of a geometry, in its own coordinates. */
function parts(g: GeoFeature["geometry"]): Array<{ kind: "ring" | "line" | "point"; coords: Point[] }> {
  if (!g) return [];
  const c = g.coordinates as unknown;
  const pt = (p: unknown) => [Number((p as number[])[0]), Number((p as number[])[1])] as Point;
  switch (g.type) {
    case "Point":
      return [{ kind: "point", coords: [pt(c)] }];
    case "LineString":
      return [{ kind: "line", coords: (c as unknown[]).map(pt) }];
    case "MultiLineString":
      return (c as unknown[][]).map((l) => ({ kind: "line" as const, coords: l.map(pt) }));
    case "Polygon":
      return [{ kind: "ring", coords: ((c as unknown[][])[0] ?? []).map(pt) }];
    case "MultiPolygon":
      return (c as unknown[][][]).map((poly) => ({ kind: "ring" as const, coords: (poly[0] ?? []).map(pt) }));
    default:
      return [];
  }
}

function webMercatorToLonLat([x, y]: Point): Point {
  const R = 6378137;
  return [(x / R) * (180 / Math.PI), (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * (180 / Math.PI)];
}

type Flavor = "imdf" | "indoors" | "plain";

function flavorOf(cols: Collection[]): Flavor {
  const props = cols.flatMap((c) => c.features.slice(0, 20).map((f) => f.properties ?? {}));
  if (cols.some((c) => c.features.some((f) => f.feature_type)) || props.some((p) => "level_id" in p && "category" in p)) return "imdf";
  if (props.some((p) => "USE_TYPE" in p || "LEVEL_ID" in p || "FACILITY_ID" in p)) return "indoors";
  return "plain";
}

/** Class of a feature: IMDF feature_type, or the Indoors class inferred from the file name and fields. */
function classOf(col: Collection, f: GeoFeature, flavor: Flavor): string {
  if (flavor === "imdf") return (f.feature_type ?? col.name).toLowerCase();
  const n = col.name.toLowerCase();
  for (const k of ["details", "units", "levels", "facilities", "sites", "sections", "zones"]) if (n.includes(k.slice(0, -1))) return k;
  const p = f.properties ?? {};
  if ("DETAIL_ID" in p) return "details";
  if ("UNIT_ID" in p) return "units";
  if ("LEVEL_NUMBER" in p || "VERTICAL_ORDER" in p) return "levels";
  if ("FACILITY_ID" in p && !("LEVEL_ID" in p)) return "facilities";
  return n;
}

function describe(col: Collection, f: GeoFeature, flavor: Flavor): { source: string; hint?: Role; level?: string } {
  const p = f.properties ?? {};
  const cls = classOf(col, f, flavor);
  if (flavor === "imdf") {
    const cat = String(p.category ?? "");
    const name = label(p.name) || label(p.alt_name);
    const source = `${cls}:${cat}${name ? `:${name}` : ""}`;
    const level = p.level_id != null ? String(p.level_id) : undefined;
    let hint: Role | undefined;
    if (cls === "fixture" && ["equipment", "furniture", "obstruction"].includes(cat) && RACK_NAME.test(name)) hint = "rack";
    else if (cls === "fixture" && cat === "wall") hint = "wall";
    else if (cls === "opening" && (cat === "service" || cat === "automobile")) hint = "door";
    else if (cls === "detail") hint = "wall";
    else if (cls === "footprint") hint = "outline";
    else if (cls === "unit" && ["structure", "column", "drywall", "concrete", "brick", "wood", "glass"].includes(cat)) hint = "wall";
    else if (cls === "unit" && cat === "storage") hint = RACK_NAME.test(name) ? "rack" : "zone";
    else if (cls === "unit" && ["office", "restroom", "room", "lounge", "kitchen", "conferenceroom"].some((k) => cat.startsWith(k))) hint = "office";
    else if (cls === "section" && cat === "servicearea") hint = "staging";
    return { source, hint, level };
  }
  if (flavor === "indoors") {
    const use = String(p.USE_TYPE ?? "");
    const name = String(p.NAME ?? p.NAME_LONG ?? "");
    const source = `${cls}:${use}${name ? `:${name}` : ""}`;
    const level = p.LEVEL_ID != null ? String(p.LEVEL_ID) : undefined;
    let hint: Role | undefined;
    if (cls === "details") hint = /door|opening/i.test(use) ? "door" : /wall|column/i.test(use) ? "wall" : undefined;
    else if (cls === "units") hint = RACK_NAME.test(`${use} ${name}`) ? "rack" : /office|restroom|conference|break|room/i.test(use) ? "office" : /stag|dock/i.test(use) ? "staging" : "zone";
    else if (cls === "levels" || cls === "facilities") hint = "outline";
    return { source, hint, level };
  }
  const name = String(p.layer ?? p.Layer ?? p.name ?? p.NAME ?? p.category ?? p.type ?? col.name);
  return { source: `${col.name}:${name}` };
}

export interface GeoInput {
  /** An IMDF zip archive. */
  zip?: Uint8Array;
  /** GeoJSON files by name (e.g. "Units.geojson" → contents). */
  files?: Record<string, string>;
}

function collectionsOf(input: GeoInput): Collection[] {
  const texts: Record<string, string> = { ...(input.files ?? {}) };
  if (input.zip) {
    let total = 0;
    let count = 0;
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(input.zip, {
        filter: (file) => {
          count++;
          total += file.originalSize;
          if (count > LIMITS.imdfFiles) throw new ImportError(`The archive has over ${LIMITS.imdfFiles} files.`);
          if (total > LIMITS.imdfUnzipped) throw new ImportError(`The archive unpacks to over ${formatBytes(LIMITS.imdfUnzipped)}.`);
          return /\.(geo)?json$/i.test(file.name) && !file.name.startsWith("__MACOSX");
        },
      });
    } catch (err) {
      if (err instanceof ImportError) throw err;
      throw new ImportError(`Could not read the zip archive: ${err instanceof Error ? err.message : String(err)}`);
    }
    const dec = new TextDecoder();
    for (const [name, bytes] of Object.entries(unzipped)) texts[name] = dec.decode(bytes);
  }
  const cols: Collection[] = [];
  for (const [file, text] of Object.entries(texts)) {
    const base = file.split(/[\\/]/).pop()!.replace(/\.(geo)?json$/i, "");
    if (base.toLowerCase() === "manifest") continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ImportError(`${file} is not valid JSON.`);
    }
    const j = json as { type?: string; features?: GeoFeature[]; crs?: { properties?: { name?: string } }; spatialReference?: { wkid?: number; latestWkid?: number } };
    if (j.type === "Feature") cols.push({ name: base, features: [j as unknown as GeoFeature] });
    else if (Array.isArray(j.features)) {
      const crs = j.crs?.properties?.name ?? (j.spatialReference ? String(j.spatialReference.latestWkid ?? j.spatialReference.wkid) : undefined);
      cols.push({ name: base, crs, features: j.features });
    } else throw new ImportError(`${file} is not a GeoJSON FeatureCollection.`);
  }
  if (cols.length === 0) throw new ImportError("No GeoJSON found. Upload an IMDF .zip, or .geojson files exported from ArcGIS Indoors (Units, Details, Levels).");
  return cols;
}

export function readGeo(input: GeoInput, opts: AssembleOptions & { level?: string }): { spec: LayoutSpec; report: ImportReport } {
  const cols = collectionsOf(input);
  const flavor = flavorOf(cols);
  const notes = [...(opts.notes ?? [])];

  // Levels: keep the one asked for, or the one with the most racks.
  const described = cols.flatMap((col) => col.features.map((f) => ({ col, f, d: describe(col, f, flavor) })));
  const levelNames = new Map<string, string>();
  for (const { col, f } of described) {
    const cls = classOf(col, f, flavor);
    if (cls === "level" || cls === "levels") {
      const p = f.properties ?? {};
      const id = String(f.id ?? p.LEVEL_ID ?? p.id ?? "");
      levelNames.set(id, `${label(p.name) || String(p.NAME ?? "")} ${label(p.short_name) || String(p.NAME_SHORT ?? "")} ${p.ordinal ?? p.VERTICAL_ORDER ?? ""}`.trim());
    }
  }
  const levels = [...new Set(described.map((x) => x.d.level).filter((l): l is string => !!l))];
  let keepLevel: string | undefined;
  if (levels.length > 1) {
    if (opts.level) {
      keepLevel = levels.find((l) => l === opts.level || (levelNames.get(l) ?? "").toLowerCase().includes(opts.level!.toLowerCase()));
      if (!keepLevel) throw new ImportError(`No level matches "${opts.level}". Levels: ${levels.map((l) => `${l} (${levelNames.get(l) ?? "?"})`).join(", ")}.`);
    } else {
      const count = (l: string) => described.filter((x) => x.d.level === l && (x.d.hint === "rack" || RACK_NAME.test(x.d.source))).length;
      keepLevel = [...levels].sort((a, b) => count(b) - count(a))[0];
      notes.push(`${levels.length} levels found; using ${levelNames.get(keepLevel) || keepLevel}, which has the most racks. Pass level to choose another.`);
    }
  }

  // Coordinates → feet.
  const sample = described.flatMap((x) => parts(x.f.geometry).flatMap((p) => p.coords)).slice(0, 2000);
  if (sample.length === 0) throw new ImportError("The GeoJSON has no geometry.");
  const mercator = cols.some((c) => /3857|900913|102100|102113/.test(c.crs ?? "")) || sample.some(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 90);
  const projected = mercator && !cols.some((c) => /3857|900913|102100|102113/.test(c.crs ?? "")) && sample.every(([x, y]) => Math.abs(x) < 5e5 && Math.abs(y) < 5e5);
  let toFeet: (p: Point) => Point;
  if (projected) {
    // Large numbers but not a Web Mercator range: a local projected system in meters.
    toFeet = ([x, y]) => [x * 3.28084, y * 3.28084];
    notes.push("Coordinates look like a local projected system in meters.");
  } else {
    const lonlat = mercator ? sample.map(webMercatorToLonLat) : sample;
    const origin: Point = [lonlat.reduce((a, p) => a + p[0], 0) / lonlat.length, lonlat.reduce((a, p) => a + p[1], 0) / lonlat.length];
    const proj = lonLatToFeet(origin);
    toFeet = mercator ? (p) => proj(webMercatorToLonLat(p)) : proj;
    if (mercator) notes.push("Coordinates are Web Mercator (EPSG:3857), converted to lon/lat and then feet.");
  }

  const features: RawFeature[] = [];
  for (const { f, d } of described) {
    if (keepLevel && d.level && d.level !== keepLevel) continue;
    for (const part of parts(f.geometry)) {
      if (part.coords.length === 0) continue;
      const pts = part.coords.map(toFeet);
      const widthFt = d.hint === "door" && part.kind === "line" && pts.length >= 2 ? Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) : undefined;
      features.push({ source: d.source, kind: part.kind, points: part.kind === "ring" && pts.length > 1 ? pts.slice(0, -1) : pts, hint: d.hint, widthFt });
    }
  }
  const format = flavor === "indoors" ? "indoors" : "imdf";
  if (flavor === "plain") notes.push("Plain GeoJSON: features were classified by their layer, name or category property.");
  return assemble(features, { ...opts, format, notes });
}
