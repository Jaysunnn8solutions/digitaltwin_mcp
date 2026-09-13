/**
 * IFC (BIM) floor plans through web-ifc (MPL-2.0, WebAssembly). Walls,
 * doors, slabs, spaces, columns, and furnishing or proxy elements are
 * meshed; each element's plan footprint is the convex hull of its world
 * vertices dropped onto the floor. web-ifc's meshes are Y-up in meters (IFC's
 * +Y becomes -Z), so the plan point of a vertex is (x, -z).
 *
 * Racks are rarely modelled as racks: they come as IfcFurnishingElement,
 * IfcSystemFurnitureElement or IfcBuildingElementProxy, recognised by name or
 * object type. Only the ground floor is kept: elements whose base sits more
 * than 2.5 m above the lowest rack (or the lowest element) are dropped.
 *
 * web-ifc is loaded on demand, so bundles that never import IFC (the hosted
 * MCP route) do not carry it.
 */

import { assemble, ImportError, type AssembleOptions, type ImportReport, type RawFeature, type Role } from "./assemble";
import { convexHull } from "./geometry";
import type { LayoutSpec, Point } from "./spec";

const RACK_NAME = /(rack|shelv|shelf|pallet|gondola|storage)/i;
const M_TO_FT = 3.28084;

export async function readIfc(bytes: Uint8Array, opts: AssembleOptions & { wasmPath?: string }): Promise<{ spec: LayoutSpec; report: ImportReport }> {
  const WebIFC = await import("web-ifc");
  const api = new WebIFC.IfcAPI();
  if (opts.wasmPath) api.SetWasmPath(opts.wasmPath, true);
  await api.Init(undefined, true);
  const model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 8 });
  if (model < 0) throw new ImportError("web-ifc could not open this file. It reads IFC2X3, IFC4 and IFC4X3 STEP files (.ifc), not .ifczip or .ifcxml.");

  const T = WebIFC;
  const typeRoles: Array<[number, Role | "furniture"]> = [
    [T.IFCWALL, "wall"],
    [T.IFCWALLSTANDARDCASE, "wall"],
    [T.IFCCOLUMN, "wall"],
    [T.IFCDOOR, "door"],
    [T.IFCSLAB, "outline"],
    [T.IFCFURNISHINGELEMENT, "furniture"],
    [T.IFCSYSTEMFURNITUREELEMENT, "furniture"],
    [T.IFCBUILDINGELEMENTPROXY, "furniture"],
  ];
  const roleByType = new Map(typeRoles.filter(([t]) => typeof t === "number"));
  const elements: Array<{ source: string; hint?: Role; points: Point[]; minUp: number }> = [];
  try {
    const collect = (mesh: { expressID: number; geometries: { size(): number; get(i: number): { geometryExpressID: number; flatTransformation: number[] } } }) => {
      const line = api.GetLine(model, mesh.expressID);
      const typeCode = api.GetLineType(model, mesh.expressID) as number;
      const typeName = api.GetNameFromTypeCode(typeCode) || "IFC";
      const name = `${line?.Name?.value ?? ""}`;
      const objectType = `${line?.ObjectType?.value ?? line?.LongName?.value ?? ""}`;
      const pts: Point[] = [];
      let minUp = Infinity;
      for (let i = 0; i < mesh.geometries.size(); i++) {
        const pg = mesh.geometries.get(i);
        const geom = api.GetGeometry(model, pg.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const m = pg.flatTransformation;
        // Every third vertex is plenty for a footprint hull.
        const step = verts.length > 6 * 3000 ? 18 : 6;
        for (let v = 0; v + 2 < verts.length; v += step) {
          const x = verts[v];
          const y = verts[v + 1];
          const z = verts[v + 2];
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          pts.push([wx * M_TO_FT, -wz * M_TO_FT]);
          if (wy < minUp) minUp = wy;
        }
        geom.delete();
      }
      if (pts.length < 3) return;
      let hint = roleByType.get(typeCode);
      if (typeCode === T.IFCSPACE) hint = /office|restroom|toilet|break|lobby/i.test(`${name} ${objectType}`) ? "office" : /stag|dock|ship|receiv/i.test(`${name} ${objectType}`) ? "staging" : "zone";
      if (hint === "furniture") hint = RACK_NAME.test(`${name} ${objectType}`) ? "rack" : "ignore";
      elements.push({ source: `${typeName}:${name}${objectType ? `:${objectType}` : ""}`, hint: hint as Role | undefined, points: convexHull(pts), minUp });
    };
    api.StreamAllMeshesWithTypes(model, [...roleByType.keys()], collect as never);
    // Spaces are skipped by the default streaming; ask for them by type.
    api.StreamAllMeshesWithTypes(model, [T.IFCSPACE], collect as never);
  } finally {
    api.CloseModel(model);
  }
  if (elements.length === 0) throw new ImportError("The IFC model has no walls, doors, slabs, spaces or furnishing elements with geometry.");

  const racks = elements.filter((e) => e.hint === "rack");
  const ground = Math.min(...(racks.length ? racks : elements).map((e) => e.minUp));
  const kept = elements.filter((e) => e.minUp <= ground + 2.5);
  const notes = [...(opts.notes ?? [])];
  if (kept.length < elements.length) notes.push(`${elements.length - kept.length} element(s) above the ground floor were left out; the twin models one floor.`);
  const features: RawFeature[] = kept.map((e) => ({ source: e.source, kind: "ring", points: e.points, hint: e.hint }));
  return assemble(features, { ...opts, format: "ifc", notes });
}
