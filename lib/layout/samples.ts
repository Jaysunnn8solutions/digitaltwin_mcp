/**
 * One sample warehouse written in every supported format, for tests and for
 * the web page's "try a sample" files. The same building in each, drawn the
 * way each format's users draw it:
 *
 * - DXF in millimeters, turned 90° (racks run along x), pallet bays as block
 *   inserts, shelving as polylines, dock doors as blocks on direction layers,
 *   plus annotation to ignore;
 * - a WMS location CSV with coordinates in feet and door rows;
 * - an IMDF archive in lon/lat near Norcross, racks as equipment fixtures;
 * - ArcGIS Indoors Units and Details in Web Mercator with a crs member;
 * - IFC4 with walls, doors and racks as building element proxies.
 *
 * Building: 260×190 ft. Eight dock doors on the south wall (four receiving,
 * four shipping). Reserve: five back-to-back double rows of pallet rack,
 * 10 bays of 9 ft. Pick: six aisles of 2 ft shelving, 10 bays of 8 ft.
 */

import { zipSync, strToU8 } from "fflate";
import type { Point } from "./spec";

export const SAMPLE = {
  widthFt: 260,
  depthFt: 190,
  doors: [30, 45, 60, 75, 150, 170, 190, 210].map((x, i) => ({ x, kind: i < 4 ? ("inbound" as const) : ("outbound" as const) })),
  /** Reserve double rows: center x of the 8 ft back-to-back box, y from 60 to 150. */
  reserveRows: [24, 43, 62, 81, 100].map((x) => ({ x, y0: 60, y1: 150, depth: 8, bays: 10 })),
  /** Pick shelving runs: pairs across 6 ft aisles, 2 ft deep, y from 60 to 140. */
  pickRuns: Array.from({ length: 6 }, (_, a) => [140 + a * 10 + 1, 140 + a * 10 + 9]).flat().map((x) => ({ x, y0: 60, y1: 140, depth: 2, bays: 10 })),
};

const rect = (cx: number, y0: number, y1: number, depth: number): Point[] => [
  [cx - depth / 2, y0],
  [cx + depth / 2, y0],
  [cx + depth / 2, y1],
  [cx - depth / 2, y1],
];

// ---------------------------------------------------------------------------
// DXF (millimeters, rotated 90°: canonical (x, y) → drawing (y, -x))
// ---------------------------------------------------------------------------

export function sampleDxf(): string {
  const MM = 304.8;
  const tr = ([x, y]: Point): Point => [y * MM, -x * MM];
  const out: string[] = [];
  const pair = (c: number, v: string | number) => out.push(String(c), String(v));
  pair(0, "SECTION"); pair(2, "HEADER"); pair(9, "$INSUNITS"); pair(70, 4); pair(0, "ENDSEC");
  // Blocks: a pallet bay (9 ft × 4 ft, drawn along the block's x) and a dock door (9 ft wide).
  pair(0, "SECTION"); pair(2, "BLOCKS");
  const lw = (layer: string, pts: Point[], closed: boolean) => {
    pair(0, "LWPOLYLINE"); pair(8, layer); pair(90, pts.length); pair(70, closed ? 1 : 0);
    for (const [x, y] of pts) { pair(10, x.toFixed(1)); pair(20, y.toFixed(1)); }
  };
  pair(0, "BLOCK"); pair(8, "0"); pair(2, "PALLET_BAY"); pair(70, 0); pair(10, 0); pair(20, 0);
  lw("0", [[0, 0], [9 * MM, 0], [9 * MM, 4 * MM], [0, 4 * MM]], true);
  pair(0, "ENDBLK");
  pair(0, "BLOCK"); pair(8, "0"); pair(2, "DOCK_DOOR_9FT"); pair(70, 0); pair(10, 0); pair(20, 0);
  pair(0, "LINE"); pair(8, "0"); pair(10, -4.5 * MM); pair(20, 0); pair(11, 4.5 * MM); pair(21, 0);
  pair(0, "LINE"); pair(8, "0"); pair(10, -4.5 * MM); pair(20, 0); pair(11, -4.5 * MM); pair(21, 1.5 * MM);
  pair(0, "LINE"); pair(8, "0"); pair(10, 4.5 * MM); pair(20, 0); pair(11, 4.5 * MM); pair(21, 1.5 * MM);
  pair(0, "ENDBLK");
  pair(0, "ENDSEC");

  pair(0, "SECTION"); pair(2, "ENTITIES");
  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  lw("A-FLOR-OTLN", ([[0, 0], [W, 0], [W, D], [0, D]] as Point[]).map(tr), true);
  // Walls as loose LINEs, to exercise chaining.
  const wall: Point[] = [[0, 0], [W, 0], [W, D], [0, D], [0, 0]];
  for (let i = 0; i < wall.length - 1; i++) {
    const a = tr(wall[i]);
    const b = tr(wall[i + 1]);
    pair(0, "LINE"); pair(8, "A-WALL"); pair(10, a[0]); pair(20, a[1]); pair(11, b[0]); pair(21, b[1]);
  }
  // Office in the back corner.
  lw("A-AREA-OFFICE", ([[W - 40, D - 30], [W, D - 30], [W, D], [W - 40, D]] as Point[]).map(tr), true);
  // Reserve: two rows of bay blocks per double row. Block x runs along the row, rotated -90° by the drawing turn.
  for (const r of SAMPLE.reserveRows) {
    for (const face of [r.x - 4, r.x]) {
      for (let b = 0; b < r.bays; b++) {
        // The block runs 9 ft along drawing +x (canonical +y) and 4 ft along
        // drawing +y (canonical -x), so it is inserted at the canonical corner
        // on the far side of its depth.
        const [ix, iy] = tr([face + 4, r.y0 + b * 9]);
        pair(0, "INSERT"); pair(8, "RACK-PALLET"); pair(2, "PALLET_BAY"); pair(10, ix); pair(20, iy); pair(50, 0);
      }
    }
  }
  // Pick shelving runs as single polylines.
  for (const p of SAMPLE.pickRuns) lw("SHELVING", rect(p.x, p.y0, p.y1, p.depth).map(tr), true);
  // Dock doors: canonical x along the south wall becomes drawing -y; rotate the block -90°.
  for (const d of SAMPLE.doors) {
    const [ix, iy] = tr([d.x, 0]);
    pair(0, "INSERT"); pair(8, d.kind === "inbound" ? "DOCK-DOOR-RECEIVING" : "DOCK-DOOR-SHIPPING"); pair(2, "DOCK_DOOR_9FT"); pair(10, ix); pair(20, iy); pair(50, -90);
  }
  // Annotation that must be ignored.
  pair(0, "TEXT"); pair(8, "A-ANNO-TEXT"); pair(10, 0); pair(20, 0); pair(40, 300); pair(1, "SAMPLE DC");
  lw("A-ANNO-DIMS", [tr([0, -10]), tr([W, -10])], false);
  pair(0, "ENDSEC"); pair(0, "EOF");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CSV (feet, aisles along y)
// ---------------------------------------------------------------------------

/**
 * WMS convention: an aisle is the walking aisle, and each location is on its
 * left or right side. x is the center of the rack face the location is in.
 */
export function sampleCsv(): string {
  const rows = ["location,zone,aisle,side,bay,level,x,y,direction"];
  const faces = [
    ...SAMPLE.reserveRows.flatMap((r) => [
      { zone: "pallet reserve", x: r.x - 2, depth: 4, y0: r.y0, bays: r.bays, bayLen: 9 },
      { zone: "pallet reserve", x: r.x + 2, depth: 4, y0: r.y0, bays: r.bays, bayLen: 9 },
    ]),
    ...SAMPLE.pickRuns.map((p) => ({ zone: "forward pick", x: p.x, depth: p.depth, y0: p.y0, bays: p.bays, bayLen: 8 })),
  ].sort((a, b) => a.x - b.x);
  const emit = (aisle: string, side: "L" | "R", f: (typeof faces)[number]) => {
    for (let b = 1; b <= f.bays; b++) for (let lv = 1; lv <= 4; lv++) rows.push(`${aisle}-${side}${b}-${lv},${f.zone},${aisle},${side},${b},${lv},${f.x},${f.y0 + (b - 0.5) * f.bayLen},`);
  };
  // Walk the faces in x order; a gap of aisle width between two faces is an aisle.
  const used = new Set<number>();
  let n = 0;
  for (let i = 0; i + 1 < faces.length; i++) {
    const a = faces[i];
    const b = faces[i + 1];
    const gap = b.x - b.depth / 2 - (a.x + a.depth / 2);
    if (gap >= 3 && gap <= 20) {
      const id = `${a.zone.startsWith("pallet") ? "R" : "P"}${String(++n).padStart(2, "0")}`;
      emit(id, "L", a);
      emit(id, "R", b);
      used.add(i).add(i + 1);
    }
  }
  // Faces along an outside aisle.
  faces.forEach((f, i) => {
    if (!used.has(i)) emit(`${f.zone.startsWith("pallet") ? "R" : "P"}${String(++n).padStart(2, "0")}`, i === 0 ? "R" : "L", f);
  });
  SAMPLE.doors.forEach((d, i) => rows.push(`D${i + 1},dock door,,,,,${d.x},0,${d.kind}`));
  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// GeoJSON: IMDF (lon/lat) and ArcGIS Indoors (Web Mercator)
// ---------------------------------------------------------------------------

const ORIGIN: Point = [-84.2, 33.94];
function toLonLat([x, y]: Point): Point {
  const ftPerDegLat = 364_000;
  const ftPerDegLon = ftPerDegLat * Math.cos((ORIGIN[1] * Math.PI) / 180);
  // A slight turn (20°), as real sites never sit square to the meridian.
  const a = (20 * Math.PI) / 180;
  const rx = x * Math.cos(a) - y * Math.sin(a);
  const ry = x * Math.sin(a) + y * Math.cos(a);
  return [ORIGIN[0] + rx / ftPerDegLon, ORIGIN[1] + ry / ftPerDegLat];
}
const ring = (pts: Point[], f: (p: Point) => Point) => {
  const c = pts.map(f);
  return [...c, c[0]];
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function sampleImdf(): Uint8Array {
  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  const levelId = uuid(2);
  let n = 100;
  const fc = (features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features });
  const building: Point[] = [[0, 0], [W, 0], [W, D], [0, D]];
  const fixtures = [
    ...SAMPLE.reserveRows.map((r) => ({ type: "Feature", id: uuid(n++), feature_type: "fixture", geometry: { type: "Polygon", coordinates: [ring(rect(r.x, r.y0, r.y1, r.depth), toLonLat)] }, properties: { category: "equipment", name: { en: "Pallet rack double row" }, level_id: levelId, alt_name: null, anchor_id: null, display_point: null } })),
    ...SAMPLE.pickRuns.map((p) => ({ type: "Feature", id: uuid(n++), feature_type: "fixture", geometry: { type: "Polygon", coordinates: [ring(rect(p.x, p.y0, p.y1, p.depth), toLonLat)] }, properties: { category: "furniture", name: { en: "Pick shelving" }, level_id: levelId, alt_name: null, anchor_id: null, display_point: null } })),
  ];
  const openings = SAMPLE.doors.map((d) => ({
    type: "Feature",
    id: uuid(n++),
    feature_type: "opening",
    geometry: { type: "LineString", coordinates: [toLonLat([d.x - 4.5, 0]), toLonLat([d.x + 4.5, 0])] },
    properties: { category: "service", name: { en: d.kind === "inbound" ? "Receiving dock door" : "Shipping dock door" }, level_id: levelId, door: { type: "shutter", automatic: false, material: "metal" } },
  }));
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify({ version: "1.0.0", created: "2026-09-13T00:00:00Z", language: "en-US", generated_by: "digitaltwin_mcp sample" })),
    "venue.geojson": strToU8(fc([{ type: "Feature", id: uuid(1), feature_type: "venue", geometry: { type: "Polygon", coordinates: [ring(building, toLonLat)] }, properties: { category: "businesscampus", name: { en: "Sample DC" }, display_point: { type: "Point", coordinates: toLonLat([W / 2, D / 2]) }, address_id: uuid(9) } }])),
    "level.geojson": strToU8(fc([{ type: "Feature", id: levelId, feature_type: "level", geometry: { type: "Polygon", coordinates: [ring(building, toLonLat)] }, properties: { category: "unspecified", outdoor: false, ordinal: 0, name: { en: "Ground" }, short_name: { en: "G" } } }])),
    "footprint.geojson": strToU8(fc([{ type: "Feature", id: uuid(3), feature_type: "footprint", geometry: { type: "Polygon", coordinates: [ring(building, toLonLat)] }, properties: { category: "ground", name: null, building_ids: [uuid(4)] } }])),
    "unit.geojson": strToU8(fc([
      { type: "Feature", id: uuid(5), feature_type: "unit", geometry: { type: "Polygon", coordinates: [ring([[0, 0], [W - 40, 0], [W - 40, D], [0, D]], toLonLat)] }, properties: { category: "storage", name: { en: "Warehouse" }, level_id: levelId } },
      { type: "Feature", id: uuid(6), feature_type: "unit", geometry: { type: "Polygon", coordinates: [ring([[W - 40, D - 30], [W, D - 30], [W, D], [W - 40, D]], toLonLat)] }, properties: { category: "office", name: { en: "Office" }, level_id: levelId } },
    ])),
    "fixture.geojson": strToU8(fc(fixtures)),
    "opening.geojson": strToU8(fc(openings)),
  };
  return zipSync(files);
}

function toMercator(p: Point): Point {
  const [lon, lat] = toLonLat(p);
  const R = 6378137;
  return [((lon * Math.PI) / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R];
}

export function sampleIndoors(): Record<string, string> {
  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  const crs = { type: "name", properties: { name: "EPSG:3857" } };
  let id = 1;
  const unit = (pts: Point[], use: string, name: string) => ({ type: "Feature", id: id++, geometry: { type: "Polygon", coordinates: [ring(pts, toMercator)] }, properties: { UNIT_ID: `U${id}`, LEVEL_ID: "L1", USE_TYPE: use, NAME: name } });
  const units = [
    ...SAMPLE.reserveRows.map((r, i) => unit(rect(r.x, r.y0, r.y1, r.depth), "Storage Rack", `Pallet rack ${i + 1}`)),
    ...SAMPLE.pickRuns.map((p, i) => unit(rect(p.x, p.y0, p.y1, p.depth), "Shelving", `Pick shelving ${i + 1}`)),
    unit([[W - 40, D - 30], [W, D - 30], [W, D], [W - 40, D]], "Office", "Office"),
  ];
  const details = [
    { type: "Feature", id: id++, geometry: { type: "LineString", coordinates: ([[0, 0], [W, 0], [W, D], [0, D], [0, 0]] as Point[]).map(toMercator) }, properties: { DETAIL_ID: "W1", LEVEL_ID: "L1", USE_TYPE: "Wall" } },
    ...SAMPLE.doors.map((d) => ({ type: "Feature", id: id++, geometry: { type: "LineString", coordinates: [toMercator([d.x - 4.5, 0]), toMercator([d.x + 4.5, 0])] }, properties: { DETAIL_ID: `D${id}`, LEVEL_ID: "L1", USE_TYPE: d.kind === "inbound" ? "Door - Receiving Dock" : "Door - Shipping Dock" } })),
  ];
  const levels = [{ type: "Feature", id: id++, geometry: { type: "Polygon", coordinates: [ring([[0, 0], [W, 0], [W, D], [0, D]], toMercator)] }, properties: { LEVEL_ID: "L1", FACILITY_ID: "F1", NAME: "Ground", LEVEL_NUMBER: 1, VERTICAL_ORDER: 0 } }];
  return {
    "Units.geojson": JSON.stringify({ type: "FeatureCollection", crs, features: units }),
    "Details.geojson": JSON.stringify({ type: "FeatureCollection", crs, features: details }),
    "Levels.geojson": JSON.stringify({ type: "FeatureCollection", crs, features: levels }),
  };
}

// ---------------------------------------------------------------------------
// IFC4 (meters), boxes as extruded rectangles
// ---------------------------------------------------------------------------

export function sampleIfc(): string {
  const M = 0.3048;
  const lines: string[] = [];
  let id = 0;
  const add = (s: string) => {
    lines.push(`#${++id}=${s};`);
    return id;
  };
  const guid = () => {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
    let s = "";
    let x = id * 2654435761;
    for (let i = 0; i < 22; i++) {
      s += chars[Math.abs(x) % 64];
      x = Math.floor(x / 7) + i * 31;
    }
    return s;
  };
  const f = (v: number) => (Number.isInteger(v) ? `${v}.` : `${v}`);
  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const zDir = add("IFCDIRECTION((0.,0.,1.))");
  const xDir = add("IFCDIRECTION((1.,0.,0.))");
  const worldPlace = add(`IFCAXIS2PLACEMENT3D(#${origin},#${zDir},#${xDir})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${worldPlace},$)`);
  const lenUnit = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
  const units = add(`IFCUNITASSIGNMENT((#${lenUnit}))`);
  const project = add(`IFCPROJECT('${guid()}',$,'Sample DC',$,$,$,$,(#${ctx}),#${units})`);
  const sitePlace = add(`IFCLOCALPLACEMENT($,#${worldPlace})`);
  const site = add(`IFCSITE('${guid()}',$,'Site',$,$,#${sitePlace},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPlace = add(`IFCLOCALPLACEMENT(#${sitePlace},#${worldPlace})`);
  const building = add(`IFCBUILDING('${guid()}',$,'Sample DC',$,$,#${bldPlace},$,$,.ELEMENT.,$,$,$)`);
  const stPlace = add(`IFCLOCALPLACEMENT(#${bldPlace},#${worldPlace})`);
  const storey = add(`IFCBUILDINGSTOREY('${guid()}',$,'Ground',$,$,#${stPlace},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${site},(#${building}))`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${building},(#${storey}))`);
  const elements: number[] = [];
  // A box centered at (cx, cy) feet, sized w × d feet, h meters high, at z0 meters.
  const box = (entity: string, name: string, objectType: string, cx: number, cy: number, w: number, d: number, h: number) => {
    const pt = add(`IFCCARTESIANPOINT((${f(cx * M)},${f(cy * M)},0.))`);
    const place = add(`IFCAXIS2PLACEMENT3D(#${pt},#${zDir},#${xDir})`);
    const lp = add(`IFCLOCALPLACEMENT(#${stPlace},#${place})`);
    const p2 = add("IFCAXIS2PLACEMENT2D(#" + add("IFCCARTESIANPOINT((0.,0.))") + ",$)");
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${p2},${f(w * M)},${f(d * M)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${prof},#${worldPlace},#${zDir},${f(h)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(#${solid}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const el =
      entity === "IFCWALL"
        ? add(`IFCWALL('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,.STANDARD.)`)
        : entity === "IFCDOOR"
          ? add(`IFCDOOR('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,3.,${f(w * M)},.DOOR.,.SWINGING.,$)`)
          : add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,'${name}',$,'${objectType}',#${lp},#${shape},$,.ELEMENT.)`);
    elements.push(el);
  };
  const W = SAMPLE.widthFt;
  const D = SAMPLE.depthFt;
  box("IFCWALL", "South wall", "Exterior", W / 2, -0.5, W, 1, 9);
  box("IFCWALL", "North wall", "Exterior", W / 2, D + 0.5, W, 1, 9);
  box("IFCWALL", "West wall", "Exterior", -0.5, D / 2, 1, D, 9);
  box("IFCWALL", "East wall", "Exterior", W + 0.5, D / 2, 1, D, 9);
  for (const r of SAMPLE.reserveRows) box("IFCBUILDINGELEMENTPROXY", "Pallet rack", "Selective pallet rack double row", r.x, (r.y0 + r.y1) / 2, r.depth, r.y1 - r.y0, 6);
  for (const p of SAMPLE.pickRuns) box("IFCBUILDINGELEMENTPROXY", "Pick shelving", "Shelving", p.x, (p.y0 + p.y1) / 2, p.depth, p.y1 - p.y0, 2.2);
  for (const d of SAMPLE.doors) box("IFCDOOR", d.kind === "inbound" ? "Receiving dock door" : "Shipping dock door", "Overhead dock door", d.x, 0, 9, 1, 3);
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${elements.map((e) => `#${e}`).join(",")}),#${storey})`);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('sample-dc.ifc','2026-09-13T00:00:00',(''),(''),'digitaltwin_mcp','digitaltwin_mcp','');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}
