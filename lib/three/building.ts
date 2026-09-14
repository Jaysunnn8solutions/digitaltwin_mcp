/**
 * The static building: floor and grid, outline walls extruded with the dock
 * doors cut out, imported interior walls, zones, aisle dashes, painted floor
 * markings (rack-face lines, cross-aisle lines, pack-station outlines,
 * equipment stalls, the zebra hatch behind every door), dock doors (parts
 * merged per kind, black bumpers, one pad and one lamp per door so a door can
 * show free / busy / outage and be picked), a numbered plate above each door
 * on both faces of the wall, the yard slab with queue marks, dock and staging
 * lane marks, pack stations, entrance and break bench, and the ceiling strips
 * that light the interior. Pure Object3D graphs: no DOM, no renderer, so it
 * runs under vitest on Node (the door plates then have no lettering, since
 * that needs a canvas).
 *
 * Every surface uses palette.ts SURFACES, the same in both UI themes; only
 * the yard slab darkens with the sky at night (setLight).
 *
 * Child count of the returned group is a function of the spec and world:
 * FIXED_CHILDREN + (imported walls ? 1 : 0) + zones with a ring + 2 × doors
 * + stations, which scene.test.ts asserts by deltas.
 */

import { BoxGeometry, BufferGeometry, CanvasTexture, Color, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, Shape, ShapeGeometry, SRGBColorSpace, Texture, Vector2 } from "three";
import type { LayoutSpec, Point } from "../layout/spec";
import type { DoorFrame, Lane, Pt, World } from "../trace/types";
import type { Layout } from "../twin/layout";
import type { Skill } from "../twin/types";
import { BoxBatch, ResourceTracker, toWorld } from "./geometry";
import { DOOR_COLORS, STATE_COLORS, SURFACES, darken } from "./palette";
import { defaultLevelHeights } from "./racks";

export const WALL_HEIGHT = 28;
export const DOOR_HEIGHT = 14;
export const WALL_THICKNESS = 1;
export const CEILING_HEIGHT = 26;
/** Height of the door number plate's centre on the wall, between the header's bottom and the top of the wall. */
export const PLATE_HEIGHT = DOOR_HEIGHT + 5;

/**
 * Children that every building has: floor, grid, outline walls, aisle dashes,
 * paint, two merged door-part meshes (one per kind), bumpers, door plates,
 * yard slab, queue marks, lane marks, entrance, ceiling strips.
 */
export const FIXED_CHILDREN = 14;

export type DoorState = "free" | "busy" | "outage";

export interface BuildingOptions {
  tracker: ResourceTracker;
}

export interface Building {
  group: Group;
  floor: Mesh;
  doorPads: Mesh[];
  doorLamps: Mesh[];
  stations: Mesh[];
  ceilingStrips: Mesh;
  /** Door number plates; the material carries the lettering atlas when a canvas was available. */
  doorPlates: Mesh;
  setDoor(index: number, state: DoorState): void;
  setStation(index: number, busy: boolean): void;
  /** Ceiling strips glow while on; the yard slab follows the exterior light level (0 night .. 1 day). */
  setLight(strips: boolean, daylight: number): void;
  dispose(): void;
}

/** Positions-only line geometry builder (grid, dashes, marks). */
class LineBatch {
  private readonly pos: number[] = [];
  segments = 0;
  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.pos.push(x0, y0, z0, x1, y1, z1);
    this.segments++;
  }
  /** A rectangle on the floor at height h, centred at engine (cx, cy), size (w along tangent, l along inward), rotated by the door frame. */
  rect(cx: number, cy: number, w: number, l: number, h: number, tangent: Pt = [1, 0], inward: Pt = [0, 1]): void {
    const corners: Pt[] = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      corners.push([cx + (tangent[0] * a * w) / 2 + (inward[0] * b * l) / 2, cy + (tangent[1] * a * w) / 2 + (inward[1] * b * l) / 2]);
    }
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      const q = corners[(i + 1) % 4];
      this.add(p[0], h, -p[1], q[0], h, -q[1]);
    }
  }
  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Painted floor bands (thin boxes just above the slab, so they scale with distance unlike 1 px lines). */
const PAINT_Y = 0.035;
const PAINT_T = 0.02;

/** A painted rectangle outline of band width `band`, centred at engine (cx, cy), w along x and l along y. */
function paintRect(paint: BoxBatch, cx: number, cy: number, w: number, l: number, band = 0.3): void {
  paint.add(w, PAINT_T, band, cx, PAINT_Y, -(cy - l / 2));
  paint.add(w, PAINT_T, band, cx, PAINT_Y, -(cy + l / 2));
  paint.add(band, PAINT_T, l, cx - w / 2, PAINT_Y, -cy);
  paint.add(band, PAINT_T, l, cx + w / 2, PAINT_Y, -cy);
}

function outlineRing(spec: LayoutSpec): Point[] {
  if (spec.outline.length >= 3) return spec.outline;
  return [[0, 0], [spec.widthFt, 0], [spec.widthFt, spec.depthFt], [0, spec.depthFt]];
}

function shapeGeometry(ring: Point[], height: number): ShapeGeometry {
  const shape = new Shape(ring.map(([x, y]) => new Vector2(x, y)));
  return new ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, height, 0);
}

/**
 * Outline walls as boxes along each edge, split at the doors on that edge,
 * with a header over every opening so the wall reads as one surface.
 */
function outlineWalls(spec: LayoutSpec, frames: DoorFrame[]): BoxBatch {
  const batch = new BoxBatch();
  const ring = outlineRing(spec);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.1) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const angle = Math.atan2(uy, ux);
    const spans: Array<[number, number]> = [];
    for (const f of frames) {
      const px = f.origin[0] - a[0];
      const py = f.origin[1] - a[1];
      const s = px * ux + py * uy;
      const dist = Math.abs(px * uy - py * ux);
      if (s < -0.5 || s > len + 0.5 || dist > 1.5) continue;
      spans.push([Math.max(0, s - f.widthFt / 2), Math.min(len, s + f.widthFt / 2)]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    const piece = (s0: number, s1: number, y0: number, y1: number) => {
      const L = s1 - s0;
      if (L < 0.1 || y1 - y0 < 0.1) return;
      const mid = s0 + L / 2;
      batch.add(L, y1 - y0, WALL_THICKNESS, a[0] + ux * mid, (y0 + y1) / 2, -(a[1] + uy * mid), angle);
    };
    let cursor = 0;
    for (const [s0, s1] of spans) {
      if (s0 < cursor) continue;
      piece(cursor, s0, 0, WALL_HEIGHT);
      piece(s0, s1, DOOR_HEIGHT, WALL_HEIGHT);
      cursor = s1;
    }
    piece(cursor, len, 0, WALL_HEIGHT);
  }
  return batch;
}

function frameAngle(f: DoorFrame): number {
  return Math.atan2(f.tangent[1], f.tangent[0]);
}

// ---------------------------------------------------------------------------
// Door number plates: one quad per door face, lettered from a canvas atlas
// ---------------------------------------------------------------------------

const PLATE_W = 5;
const PLATE_H = 2;
const ATLAS_COLS = 8;
const CELL_W = 160;
const CELL_H = 56;

/** Draws every label into one canvas; null under Node or when the labels would not fit a 4096 px texture. */
function plateAtlas(labels: string[]): CanvasTexture | null {
  if (labels.length === 0 || typeof document === "undefined") return null;
  const rows = Math.ceil(labels.length / ATLAS_COLS);
  if (rows * CELL_H > 4096) return null;
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_COLS * CELL_W;
  canvas.height = rows * CELL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = `#${SURFACES.plate.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 30px system-ui, Segoe UI, Arial, sans-serif";
  labels.forEach((label, i) => {
    const x = (i % ATLAS_COLS) * CELL_W;
    const y = Math.floor(i / ATLAS_COLS) * CELL_H;
    ctx.strokeStyle = SURFACES.plateText;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 3, y + 3, CELL_W - 6, CELL_H - 6);
    ctx.fillStyle = SURFACES.plateText;
    ctx.fillText(label, x + CELL_W / 2, y + CELL_H / 2 + 1, CELL_W - 16);
  });
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Quads with position, normal and uv for every door: the outside face and the inside face of the wall. */
function plateGeometry(frames: DoorFrame[], atlasRows: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (cx: number, cy: number, cz: number, rx: number, rz: number, nx: number, nz: number, cell: number) => {
    const base = pos.length / 3;
    const hw = PLATE_W / 2;
    const hh = PLATE_H / 2;
    const col = cell % ATLAS_COLS;
    const row = Math.floor(cell / ATLAS_COLS);
    const u0 = col / ATLAS_COLS;
    const u1 = (col + 1) / ATLAS_COLS;
    const v1 = 1 - row / Math.max(1, atlasRows);
    const v0 = 1 - (row + 1) / Math.max(1, atlasRows);
    const corners: Array<[number, number, number, number]> = [
      [-hw, -hh, u0, v0],
      [hw, -hh, u1, v0],
      [hw, hh, u1, v1],
      [-hw, hh, u0, v1],
    ];
    for (const [a, b, u, v] of corners) {
      pos.push(cx + rx * a, cy + b, cz + rz * a);
      nrm.push(nx, 0, nz);
      uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  frames.forEach((f, i) => {
    const off = WALL_THICKNESS / 2 + 0.06;
    // Outside: viewer looks along +inward, screen right is the tangent. Inside: the opposite.
    const ox = f.origin[0] - f.inward[0] * off;
    const oy = f.origin[1] - f.inward[1] * off;
    quad(ox, PLATE_HEIGHT, -oy, f.tangent[0], -f.tangent[1], -f.inward[0], f.inward[1], i);
    const ix = f.origin[0] + f.inward[0] * off;
    const iy = f.origin[1] + f.inward[1] * off;
    quad(ix, PLATE_HEIGHT, -iy, -f.tangent[0], f.tangent[1], f.inward[0], -f.inward[1], i);
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildBuilding(spec: LayoutSpec, layout: Layout, world: World, opts: BuildingOptions): Building {
  const { tracker } = opts;
  const group = new Group();
  group.name = "building";
  const W = spec.widthFt;
  const D = spec.depthFt;

  const floorMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.floor }));
  const wallMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.wall }));
  const zoneMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.zone }));
  const stagingMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.staging }));
  const gridMat = tracker.material(new LineBasicMaterial({ color: SURFACES.grid }));
  const aisleMat = tracker.material(new LineBasicMaterial({ color: SURFACES.aisle }));
  const yardMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.yard }));
  const roadMarkMat = tracker.material(new LineBasicMaterial({ color: SURFACES.roadMark }));
  const laneMat = tracker.material(new LineBasicMaterial({ color: SURFACES.laneMark }));
  const paintMat = tracker.material(new MeshBasicMaterial({ color: SURFACES.paint }));
  const bumperMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.bumper }));
  const stationMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.station }));
  const stationBusyMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.stationBusy, emissive: SURFACES.stationBusy, emissiveIntensity: 0.35 }));
  const entranceMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.entrance }));
  const ceilingMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.ceilingStrip, emissive: 0x000000 }));
  const doorMats = {
    inbound: tracker.material(new MeshLambertMaterial({ color: DOOR_COLORS.inbound })),
    outbound: tracker.material(new MeshLambertMaterial({ color: DOOR_COLORS.outbound })),
  };
  const padMats = {
    inbound: tracker.material(new MeshLambertMaterial({ color: darken(DOOR_COLORS.inbound, 0.85) })),
    outbound: tracker.material(new MeshLambertMaterial({ color: darken(DOOR_COLORS.outbound, 0.85) })),
  };
  const padOutageMat = tracker.material(new MeshLambertMaterial({ color: STATE_COLORS.outage }));

  // Floor.
  const floor = new Mesh(tracker.geometry(spec.outline.length >= 3 ? shapeGeometry(spec.outline, 0) : new PlaneGeometry(W, D).rotateX(-Math.PI / 2).translate(W / 2, 0, -D / 2)), floorMat);
  floor.name = "floor";
  floor.receiveShadow = true;
  group.add(floor);

  // Grid every 10 ft.
  const grid = new LineBatch();
  for (let x = 0; x <= W + 1e-6; x += 10) grid.add(x, 0.01, 0, x, 0.01, -D);
  for (let y = 0; y <= D + 1e-6; y += 10) grid.add(0, 0.01, -y, W, 0.01, -y);
  const gridLines = new LineSegments(tracker.geometry(grid.build()), gridMat);
  gridLines.name = "grid";
  group.add(gridLines);

  // Outline walls with door openings.
  const walls = new Mesh(tracker.geometry(outlineWalls(spec, world.frames).build()), wallMat);
  walls.name = "walls";
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // Imported interior walls, half height so the floor stays readable.
  const wallLines = spec.walls.filter((w) => w.length >= 2);
  if (wallLines.length) {
    const batch = new BoxBatch();
    for (const line of wallLines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i];
        const b = line[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.1) continue;
        batch.add(len, WALL_HEIGHT / 2, 0.5, (a[0] + b[0]) / 2, WALL_HEIGHT / 4, -(a[1] + b[1]) / 2, Math.atan2(b[1] - a[1], b[0] - a[0]));
      }
    }
    const inner = new Mesh(tracker.geometry(batch.build()), wallMat);
    inner.name = "innerWalls";
    inner.castShadow = true;
    group.add(inner);
  }

  // Zones, flat on the floor.
  for (const z of spec.zones) {
    if (z.ring.length < 3) continue;
    const mesh = new Mesh(tracker.geometry(shapeGeometry(z.ring, z.kind === "staging" ? 0.02 : 0.025)), z.kind === "staging" ? stagingMat : zoneMat);
    mesh.name = `zone:${z.name}`;
    group.add(mesh);
  }

  // Aisle centrelines as dashes.
  const dashes = new LineBatch();
  const aisles = [...layout.reserveAisles, ...layout.pickAisles];
  for (const a of aisles) {
    for (let y = a.y0; y < a.y1; y += 6) dashes.add(a.x, 0.03, -y, a.x, 0.03, -Math.min(a.y1, y + 3));
  }
  const aisleLines = new LineSegments(tracker.geometry(dashes.build()), aisleMat);
  aisleLines.name = "aisles";
  group.add(aisleLines);

  // Painted markings: a line along every rack face, a cross-aisle line off each rack block's ends,
  // pack-station outlines, equipment stalls and the zebra hatch on the apron behind every door.
  const paint = new BoxBatch();
  for (const a of aisles) {
    for (const run of [a.left, a.right]) {
      if (!run) continue;
      const side = run.x < a.x ? 1 : -1;
      paint.add(0.3, PAINT_T, Math.max(0.5, a.y1 - a.y0), run.x + side * (run.depthFt / 2 + 0.5), PAINT_Y, -(a.y0 + a.y1) / 2);
    }
  }
  const block = (list: typeof aisles) => {
    if (list.length === 0) return;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const a of list) {
      for (const run of [a.left, a.right]) {
        if (!run) continue;
        x0 = Math.min(x0, run.x - run.depthFt / 2);
        x1 = Math.max(x1, run.x + run.depthFt / 2);
      }
      y0 = Math.min(y0, a.y0);
      y1 = Math.max(y1, a.y1);
    }
    if (!Number.isFinite(x0) || x1 - x0 < 1) return;
    paint.add(x1 - x0 + 4, PAINT_T, 0.4, (x0 + x1) / 2, PAINT_Y, -(y0 - 2));
    paint.add(x1 - x0 + 4, PAINT_T, 0.4, (x0 + x1) / 2, PAINT_Y, -(y1 + 2));
  };
  block(layout.pickAisles);
  block(layout.reserveAisles);
  for (const s of world.stations) paintRect(paint, s[0], s[1] + 1.5, 10, 9);
  for (const p of world.parks.forklifts) paintRect(paint, p[0], p[1], 6.5, 9.5);
  for (const p of world.parks.jacks) paintRect(paint, p[0], p[1], 4.5, 6.5);
  for (const f of world.frames) {
    const angle = frameAngle(f);
    const half = f.widthFt / 2 - 1.5;
    for (let across = -half; across <= half + 1e-6; across += 2.4) {
      const cx = f.origin[0] + f.inward[0] * 4 + f.tangent[0] * across;
      const cy = f.origin[1] + f.inward[1] * 4 + f.tangent[1] * across;
      paint.add(7, PAINT_T, 0.4, cx, PAINT_Y + 0.01, -cy, angle + Math.PI / 4);
    }
  }
  const paintMesh = new Mesh(tracker.geometry(paint.build()), paintMat);
  paintMesh.name = "paint";
  group.add(paintMesh);

  // Door parts merged per kind: leveler plate inside and a canopy outside; bumpers in black rubber.
  const doorBatches = { inbound: new BoxBatch(), outbound: new BoxBatch() };
  const bumpers = new BoxBatch();
  for (const f of world.frames) {
    const angle = frameAngle(f);
    const at = (along: number, across: number, h: number): [number, number, number] => [f.origin[0] + f.inward[0] * along + f.tangent[0] * across, h, -(f.origin[1] + f.inward[1] * along + f.tangent[1] * across)];
    const b = doorBatches[f.kind];
    let p = at(4, 0, 0.12);
    b.add(Math.max(4, f.widthFt - 2), 0.24, 7, p[0], p[1], p[2], angle);
    for (const side of [-1, 1]) {
      p = at(-0.75, side * (f.widthFt / 2 - 0.7), 1.9);
      bumpers.add(1.0, 1.8, 1.0, p[0], p[1], p[2], angle);
    }
    p = at(-2.2, 0, DOOR_HEIGHT + 1.2);
    b.add(f.widthFt + 2, 0.35, 4.4, p[0], p[1], p[2], angle);
  }
  for (const kind of ["inbound", "outbound"] as const) {
    const mesh = new Mesh(tracker.geometry(doorBatches[kind].build()), doorMats[kind]);
    mesh.name = `doors:${kind}`;
    mesh.castShadow = true;
    group.add(mesh);
  }
  const bumperMesh = new Mesh(tracker.geometry(bumpers.build()), bumperMat);
  bumperMesh.name = "bumpers";
  group.add(bumperMesh);

  // Numbered plates above every door, outside and inside.
  const atlas = plateAtlas(world.frames.map((f) => f.door));
  if (atlas) tracker.texture(atlas);
  const plateMat = tracker.material(atlas ? new MeshBasicMaterial({ map: atlas as Texture }) : new MeshBasicMaterial({ color: SURFACES.plate }));
  const doorPlates = new Mesh(tracker.geometry(plateGeometry(world.frames, Math.ceil(world.frames.length / ATLAS_COLS))), plateMat);
  doorPlates.name = "doorPlates";
  group.add(doorPlates);

  // One pad and one lamp per door: the pad is the pick target, the lamp shows state.
  const doorPads: Mesh[] = [];
  const doorLamps: Mesh[] = [];
  world.frames.forEach((f, index) => {
    const angle = frameAngle(f);
    const pad = new Mesh(tracker.geometry(new BoxGeometry(f.widthFt, 0.1, 8)), padMats[f.kind]);
    pad.position.set(f.origin[0] + f.inward[0] * 4, 0.05, -(f.origin[1] + f.inward[1] * 4));
    pad.rotation.y = angle;
    pad.name = `doorPad:${f.door}`;
    pad.userData.pick = { kind: "door", index };
    group.add(pad);
    doorPads.push(pad);
    const lamp = new Mesh(tracker.geometry(new BoxGeometry(1.4, 0.7, 0.6)), tracker.material(new MeshBasicMaterial({ color: darken(DOOR_COLORS[f.kind], 0.45) })));
    lamp.position.set(f.origin[0] + f.inward[0] * 0.8, DOOR_HEIGHT + 0.6, -(f.origin[1] + f.inward[1] * 0.8));
    lamp.rotation.y = angle;
    lamp.name = `doorLamp:${f.door}`;
    lamp.userData.pick = { kind: "door", index };
    group.add(lamp);
    doorLamps.push(lamp);
  });

  // Yard: one slab from the road to the dock wall, centre line and queue marks.
  const yard = world.yard;
  const x0 = Math.min(yard.spawnLeft[0], 0) - 20;
  const x1 = Math.max(yard.spawnRight[0], W) + 20;
  const yTop = Math.max(...world.frames.map((f) => f.origin[1]), 0) + 0.5;
  const yBottom = yard.roadY - 20;
  const road = new Mesh(tracker.geometry(new PlaneGeometry(x1 - x0, yTop - yBottom).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, -0.03, -(yTop + yBottom) / 2)), yardMat);
  road.name = "road";
  road.receiveShadow = true;
  group.add(road);
  const marks = new LineBatch();
  for (let x = x0 + 10; x < x1 - 10; x += 16) marks.add(x, 0.02, -yard.roadY, x + 8, 0.02, -yard.roadY);
  for (const [doorIndex, spots] of Object.entries(yard.queue)) {
    const f = world.frames[Number(doorIndex)];
    for (const s of spots) marks.rect(s[0], s[1], 10, 60, 0.02, f?.tangent ?? [1, 0], f?.inward ?? [0, 1]);
  }
  const roadMarks = new LineSegments(tracker.geometry(marks.build()), roadMarkMat);
  roadMarks.name = "queueMarks";
  group.add(roadMarks);

  // Dock and staging lane slots.
  const laneBatch = new LineBatch();
  world.lanes.forEach((lane: Lane, i: number) => {
    const f = world.frames[i];
    for (const s of lane.slots) laneBatch.rect(s[0], s[1], 4.2, 4.2, 0.03, f?.tangent ?? [1, 0], f?.inward ?? [0, 1]);
  });
  const lanes = new LineSegments(tracker.geometry(laneBatch.build()), laneMat);
  lanes.name = "lanes";
  group.add(lanes);

  // Pack stations.
  const stationGeom = tracker.geometry(new BoxGeometry(6, 2.8, 3));
  const stations = world.stations.map((s, index) => {
    const m = new Mesh(stationGeom, stationMat);
    m.position.copy(toWorld(s[0], s[1], 1.4));
    m.castShadow = true;
    m.name = `station:${index}`;
    m.userData.pick = { kind: "station", index };
    group.add(m);
    return m;
  });

  // Entrance mat and break bench.
  const entranceBatch = new BoxBatch();
  entranceBatch.add(6, 0.1, 3, world.entrance[0], 0.05, -world.entrance[1]);
  entranceBatch.add(5, 1.5, 1.5, world.breakArea[0], 0.75, -world.breakArea[1]);
  const entrance = new Mesh(tracker.geometry(entranceBatch.build()), entranceMat);
  entrance.name = "entrance";
  group.add(entrance);

  // Ceiling light strips every 30 ft.
  const stripBatch = new BoxBatch();
  for (let y = 15; y < D - 5; y += 30) stripBatch.add(Math.max(10, W - 10), 0.3, 1.5, W / 2, CEILING_HEIGHT, -y);
  const ceilingStrips = new Mesh(tracker.geometry(stripBatch.build()), ceilingMat);
  ceilingStrips.name = "ceilingStrips";
  group.add(ceilingStrips);

  const doorState: DoorState[] = world.frames.map(() => "free");
  const setDoor = (index: number, state: DoorState) => {
    const f = world.frames[index];
    const lamp = doorLamps[index];
    const pad = doorPads[index];
    if (!f || !lamp || !pad) return;
    doorState[index] = state;
    const mat = lamp.material as MeshBasicMaterial;
    if (state === "outage") {
      mat.color.setHex(STATE_COLORS.outage);
      pad.material = padOutageMat;
    } else {
      mat.color.setHex(state === "busy" ? DOOR_COLORS[f.kind] : darken(DOOR_COLORS[f.kind], 0.45));
      pad.material = padMats[f.kind];
    }
  };

  const base = new Color();
  let lastStrips: boolean | null = null;
  let lastDaylight = -1;
  const setLight = (strips: boolean, daylight: number) => {
    if (strips !== lastStrips) {
      lastStrips = strips;
      ceilingMat.emissive.setHex(strips ? 0xfff1c2 : 0x000000);
      ceilingMat.emissiveIntensity = strips ? 0.9 : 0;
    }
    const k = Math.round((0.3 + 0.7 * Math.min(1, Math.max(0, daylight))) * 100) / 100;
    if (k !== lastDaylight) {
      lastDaylight = k;
      yardMat.color.copy(base.setHex(SURFACES.yard)).multiplyScalar(k);
      roadMarkMat.color.copy(base.setHex(SURFACES.roadMark)).multiplyScalar(0.5 + 0.5 * k);
    }
  };
  setLight(true, 1);

  let disposed = false;
  return {
    group,
    floor,
    doorPads,
    doorLamps,
    stations,
    ceilingStrips,
    doorPlates,
    setDoor,
    setStation(index, busy) {
      const m = stations[index];
      if (m) m.material = busy ? stationBusyMat : stationMat;
    },
    setLight,
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// A minimal World, for tests and previews without the compiler
// ---------------------------------------------------------------------------

function centroid(ring: Point[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

/** Inward normal of the outline edge nearest a door (built-ins: (0, 1)). */
function inwardAt(spec: LayoutSpec, p: Pt): Pt {
  if (spec.outline.length < 3) return [0, 1];
  const ring = spec.outline;
  const c = centroid(ring);
  let best: { d: number; n: Pt } = { d: Infinity, n: [0, 1] };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const s = Math.max(0, Math.min(len, (p[0] - a[0]) * ux + (p[1] - a[1]) * uy));
    const qx = a[0] + ux * s;
    const qy = a[1] + uy * s;
    const d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < best.d) {
      let nx = -uy;
      let ny = ux;
      if ((c[0] - qx) * nx + (c[1] - qy) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      best = { d, n: [nx || 0, ny || 0] };
    }
  }
  return best.n;
}

/**
 * The World the compiler would synthesize (design section C), built from the
 * layout alone with the same rules, so the renderer, its tests and the
 * import preview can run without lib/trace/world.ts. The compiler's World
 * wins when a playback carries one.
 */
export function worldFromLayout(layout: Layout, packers = 2): World {
  const spec = layout.spec;
  const W = spec.widthFt;
  const frames: DoorFrame[] = layout.doors.map((d, index) => {
    const inward = inwardAt(spec, [d.x, d.y]);
    const tangent: Pt = [inward[1], -inward[0]];
    const widthFt = spec.doors[index]?.widthFt ?? 9;
    return { door: d.id, kind: d.kind, index, origin: [d.x, d.y], inward, tangent, widthFt };
  });
  const lanes: Lane[] = frames.map((f) => {
    const slots: Pt[] = [];
    for (let k = 0; k < 8; k++) {
      const col = k % 2 === 0 ? -3 : 3;
      const row = 8 + 5 * Math.floor(k / 2);
      slots.push([f.origin[0] + f.inward[0] * row + f.tangent[0] * col, f.origin[1] + f.inward[1] * row + f.tangent[1] * col]);
    }
    return { door: f.door, kind: f.kind, slots };
  });
  const K = Math.max(2, Math.min(6, packers));
  const stationY = Math.max(8, layout.depot.y - 14);
  const stations: Pt[] = Array.from({ length: K }, (_, i) => [layout.depot.x + (i - (K - 1) / 2) * 10, stationY]);
  const office = spec.zones.find((z) => z.kind === "office" && z.ring.length >= 3);
  const entrance: Pt = office ? centroid(office.ring) : [W - 10, 6];
  const breakArea: Pt = [entrance[0], entrance[1] + 12];
  const inbound = frames.filter((f) => f.kind === "inbound");
  const outbound = frames.filter((f) => f.kind === "outbound");
  const leftIn = inbound.length ? Math.min(...inbound.map((f) => f.origin[0])) : 10;
  const forklifts: Pt[] = Array.from({ length: layout.site.equipment.forklifts }, (_, i) => [leftIn + 14 + 8 * i, 12]);
  const maxIn = inbound.length ? Math.max(...inbound.map((f) => f.origin[0])) : 0;
  const minOut = outbound.length ? Math.min(...outbound.map((f) => f.origin[0])) : W;
  const jacks: Pt[] = Array.from({ length: layout.site.equipment.palletJacks }, (_, i) => [(maxIn + minOut) / 2 + (i - (layout.site.equipment.palletJacks - 1) / 2) * 6, 12]);
  const queue: Record<number, Pt[]> = {};
  for (const f of inbound) queue[f.index] = [0, 1, 2].map((k) => [f.origin[0] - f.inward[0] * (40 + 45 * k), f.origin[1] - f.inward[1] * (40 + 45 * k)]);
  const reserveY0 = layout.reserveAisles.length ? Math.min(...layout.reserveAisles.map((a) => a.y0)) : layout.pickFrontY;
  const reserveFront = Math.max(2, reserveY0 - 4);
  const levelHeights: Record<string, number[]> = {};
  for (const r of spec.racks) levelHeights[r.id] = defaultLevelHeights(r);
  const laneMouth = (f: DoorFrame | undefined): Pt => (f ? lanes[f.index].slots[0] : [W / 2, 20]);
  const homes: Record<Skill, Pt> = {
    receive: laneMouth(inbound[0]),
    forklift: forklifts[0] ?? [leftIn + 14, 12],
    pick: [layout.depot.x, layout.depot.y],
    pack: stations[Math.floor(K / 2)],
    load: laneMouth(outbound[0]),
  };
  return {
    bbox: { w: W, d: spec.depthFt },
    frames,
    lanes,
    stations,
    entrance,
    breakArea,
    parks: { forklifts, jacks },
    yard: { roadY: -60, queue, spawnLeft: [-80, -60], spawnRight: [W + 80, -60] },
    corridors: { front: Math.max(layout.pickFrontY - 3, layout.pickFrontY / 2), back: layout.pickBackY + 3, reserveFront, apron: Math.min(12, reserveFront - 2) },
    levelHeights,
    homes,
  };
}
