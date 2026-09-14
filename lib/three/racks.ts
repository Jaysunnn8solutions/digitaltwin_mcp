/**
 * Rack runs and everything stored in them. The steel is merged per use (one
 * structure mesh, one deck mesh at most: two draw calls for every pick run in
 * the building). Pick faces are one InstancedMesh indexed exactly like
 * layout.pick, reserve pallets one InstancedMesh indexed like layout.reserve,
 * plus a second InstancedMesh holding the second and third pallet of a stack
 * (instance i and n + i), so a 25k-face import is still a handful of draw
 * calls and the compiler's CSR timelines address instances by index with no
 * lookup.
 *
 * Location.x is the aisle centreline, not the rack; the face sits in the run
 * on that location's side (layout.pickAisles[aisle].left / right), which is
 * the same lookup the 2D heat layer does. Level heights come from the World
 * (pick pitch 1.5 ft, reserve 5 ft, mixed 1.5 + 5·(L − 2)) with the same
 * defaults when a run is missing.
 */

import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, Vector3 } from "three";
import type { RackRun } from "../layout/spec";
import type { World } from "../trace/types";
import type { Aisle, Layout, Location } from "../twin/layout";
import { BoxBatch, PALLET_HEIGHT, palletGeometry, ResourceTracker } from "./geometry";
import { SURFACES } from "./palette";

export const PICK_PITCH = 1.5;
export const RESERVE_PITCH = 5;
/** Clearance above a beam before the stored goods start. */
const BEAM_CLEAR = 0.36;
/** Most pallets shown stacked in one position; beyond that a ×n badge says how many. */
export const MAX_STACK = 3;

function levelZone(run: RackRun, level: number): "pick" | "reserve" {
  if (run.use === "mixed") return level === 1 ? "pick" : "reserve";
  return run.use;
}

/** Base height of each level, index level − 1: the compiler's rule, used when the World has no entry for the run. */
export function defaultLevelHeights(run: RackRun): number[] {
  const out: number[] = [];
  for (let lv = 1; lv <= run.levels; lv++) {
    if (run.use === "pick") out.push(PICK_PITCH * (lv - 1));
    else if (run.use === "reserve") out.push(RESERVE_PITCH * (lv - 1));
    else out.push(lv === 1 ? 0 : PICK_PITCH + RESERVE_PITCH * (lv - 2));
  }
  return out;
}

export function levelBase(world: World | null, run: RackRun, level: number): number {
  const h = world?.levelHeights[run.id];
  if (h && h.length >= level) return h[level - 1];
  return defaultLevelHeights(run)[Math.min(run.levels, level) - 1] ?? 0;
}

export function levelPitch(world: World | null, run: RackRun, level: number): number {
  if (level < run.levels) return levelBase(world, run, level + 1) - levelBase(world, run, level);
  return levelZone(run, level) === "pick" ? PICK_PITCH : RESERVE_PITCH;
}

function runFor(aisles: Aisle[], loc: Location): RackRun | null {
  const a = aisles[loc.aisle];
  if (!a) return null;
  return loc.side === "L" ? a.left : a.right;
}

export interface RacksOptions {
  tracker: ResourceTracker;
  quality: "high" | "low";
}

export interface Racks {
  group: Group;
  /** Merged steel, at most two per use (structure and decks). */
  frames: Mesh[];
  faces: InstancedMesh;
  reserve: InstancedMesh;
  reserveStack: InstancedMesh;
  faceIndex: Map<string, number>;
  reserveIndex: Map<string, number>;
  /** Visual pallets at each reserve position after the last setReserve. */
  stackCount: Uint8Array;
  /** Fill fraction 0..1 sets the Y scale; a negative fraction hides the face (no SKU). */
  setFace(i: number, fraction: number, color: Color | null): void;
  setReserve(i: number, count: number, color: Color | null): void;
  /** Flags the instance buffers for upload; call once per frame after the sets. */
  commit(): void;
  faceWorld(i: number, target: Vector3): Vector3;
  reserveWorld(i: number, target: Vector3): Vector3;
  dispose(): void;
}

const _m = new Matrix4();
const _hidden = new Matrix4().makeScale(0, 0, 0);

export function buildRacks(layout: Layout, world: World, opts: RacksOptions): Racks {
  const { tracker } = opts;
  const spec = layout.spec;
  const group = new Group();
  group.name = "racks";

  // Steel, merged per use.
  const structure = { pick: new BoxBatch(), reserve: new BoxBatch(), mixed: new BoxBatch() };
  const decks = { pick: new BoxBatch(), reserve: new BoxBatch(), mixed: new BoxBatch() };
  for (const run of spec.racks) {
    const bayLen = (run.y1 - run.y0) / run.bays;
    const top = levelBase(world, run, run.levels) + levelPitch(world, run, run.levels);
    const s = structure[run.use];
    const zMid = -(run.y0 + run.y1) / 2;
    for (let b = 0; b <= run.bays; b++) s.add(run.depthFt, top, 0.3, run.x, top / 2, -(run.y0 + b * bayLen));
    for (let lv = 1; lv <= run.levels; lv++) {
      const base = levelBase(world, run, lv);
      s.add(0.25, 0.35, run.y1 - run.y0, run.x + run.depthFt / 2 - 0.15, base + 0.17, zMid);
      s.add(0.25, 0.35, run.y1 - run.y0, run.x - run.depthFt / 2 + 0.15, base + 0.17, zMid);
      if (levelZone(run, lv) === "pick") decks[run.use].add(Math.max(0.3, run.depthFt - 0.3), 0.1, run.y1 - run.y0, run.x, base + 0.3, zMid);
    }
  }
  const steelMats = {
    pick: tracker.material(new MeshLambertMaterial({ color: SURFACES.rack.pick })),
    reserve: tracker.material(new MeshLambertMaterial({ color: SURFACES.rack.reserve })),
    mixed: tracker.material(new MeshLambertMaterial({ color: SURFACES.rack.mixed })),
  };
  const deckMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.deck }));
  const frames: Mesh[] = [];
  for (const use of ["pick", "reserve", "mixed"] as const) {
    if (structure[use].boxes) {
      const m = new Mesh(tracker.geometry(structure[use].build()), steelMats[use]);
      m.name = `rack:${use}`;
      m.userData.use = use;
      m.castShadow = true;
      m.receiveShadow = true;
      frames.push(m);
      group.add(m);
    }
    if (decks[use].boxes) {
      const m = new Mesh(tracker.geometry(decks[use].build()), deckMat);
      m.name = `deck:${use}`;
      m.userData.use = use;
      frames.push(m);
      group.add(m);
    }
  }

  // Pick faces: unit box with its base at the origin, scaled per instance.
  const nFaces = layout.pick.length;
  const faceGeom = tracker.geometry(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const faceMat = tracker.material(new MeshLambertMaterial({ color: 0xffffff }));
  const faces = new InstancedMesh(faceGeom, faceMat, nFaces);
  faces.name = "faces";
  faces.frustumCulled = false;
  faces.castShadow = false;
  const faceBase = new Float32Array(nFaces * 6);
  const faceIndex = new Map<string, number>();
  const tint = new Color(SURFACES.rack.pick);
  layout.pick.forEach((loc, i) => {
    faceIndex.set(loc.id, i);
    const run = runFor(layout.pickAisles, loc);
    const b = i * 6;
    if (!run) {
      faces.setMatrixAt(i, _hidden);
      faces.setColorAt(i, tint);
      return;
    }
    const bayLen = (run.y1 - run.y0) / run.bays;
    const slots = Math.max(1, run.slotsPerBay);
    const w = Math.max(0.3, bayLen / slots - 0.3);
    const d = Math.max(0.4, run.depthFt - 0.4);
    const z = levelBase(world, run, loc.level) + BEAM_CLEAR;
    const hMax = Math.max(0.3, levelPitch(world, run, loc.level) - BEAM_CLEAR - 0.15);
    faceBase[b] = run.x;
    faceBase[b + 1] = z;
    faceBase[b + 2] = -loc.y;
    faceBase[b + 3] = w;
    faceBase[b + 4] = hMax;
    faceBase[b + 5] = d;
    _m.makeScale(d, hMax, w).setPosition(run.x, z, -loc.y);
    faces.setMatrixAt(i, _m);
    faces.setColorAt(i, tint);
  });
  group.add(faces);

  // Reserve pallets, one per position, plus the stack mesh for pallets 2 and 3.
  const nRes = layout.reserve.length;
  const palletGeom = tracker.geometry(palletGeometry(opts.quality));
  const palletMat = tracker.material(new MeshLambertMaterial({ color: 0xffffff }));
  const reserve = new InstancedMesh(palletGeom, palletMat, nRes);
  reserve.name = "reserve";
  reserve.frustumCulled = false;
  const reserveStack = new InstancedMesh(palletGeom, palletMat, Math.max(1, nRes * 2));
  reserveStack.name = "reserveStack";
  reserveStack.frustumCulled = false;
  const reserveBase = new Float32Array(nRes * 3);
  const reserveIndex = new Map<string, number>();
  const stackCount = new Uint8Array(nRes);
  const palletTint = new Color(0x8b5e3c);
  layout.reserve.forEach((loc, i) => {
    reserveIndex.set(loc.id, i);
    const run = runFor(layout.reserveAisles, loc);
    const b = i * 3;
    if (run) {
      reserveBase[b] = run.x;
      reserveBase[b + 1] = levelBase(world, run, loc.level) + BEAM_CLEAR;
      reserveBase[b + 2] = -loc.y;
    }
    reserve.setMatrixAt(i, _hidden);
    reserve.setColorAt(i, palletTint);
    reserveStack.setMatrixAt(i, _hidden);
    reserveStack.setColorAt(i, palletTint);
    reserveStack.setMatrixAt(nRes + i, _hidden);
    reserveStack.setColorAt(nRes + i, palletTint);
  });
  if (nRes === 0) reserveStack.setMatrixAt(0, _hidden);
  group.add(reserve);
  group.add(reserveStack);

  const setFace = (i: number, fraction: number, color: Color | null) => {
    if (i < 0 || i >= nFaces) return;
    const b = i * 6;
    if (fraction < 0 || faceBase[b + 4] === 0) {
      faces.setMatrixAt(i, _hidden);
    } else {
      const h = Math.max(0.06, Math.min(1, fraction)) * faceBase[b + 4];
      _m.makeScale(faceBase[b + 5], h, faceBase[b + 3]).setPosition(faceBase[b], faceBase[b + 1], faceBase[b + 2]);
      faces.setMatrixAt(i, _m);
    }
    if (color) faces.setColorAt(i, color);
  };

  const setReserve = (i: number, count: number, color: Color | null) => {
    if (i < 0 || i >= nRes) return;
    const b = i * 3;
    const n = Math.max(0, Math.round(count));
    stackCount[i] = Math.min(255, n);
    const shown = Math.min(MAX_STACK, n);
    const sy = shown > 0 ? 1 / shown : 1;
    const step = PALLET_HEIGHT * sy;
    const put = (mesh: InstancedMesh, idx: number, j: number) => {
      if (j < shown) {
        _m.makeScale(1, sy, 1).setPosition(reserveBase[b], reserveBase[b + 1] + j * step, reserveBase[b + 2]);
        mesh.setMatrixAt(idx, _m);
      } else mesh.setMatrixAt(idx, _hidden);
      if (color) mesh.setColorAt(idx, color);
    };
    put(reserve, i, 0);
    put(reserveStack, i, 1);
    put(reserveStack, nRes + i, 2);
  };

  const commit = () => {
    faces.instanceMatrix.needsUpdate = true;
    reserve.instanceMatrix.needsUpdate = true;
    reserveStack.instanceMatrix.needsUpdate = true;
    if (faces.instanceColor) faces.instanceColor.needsUpdate = true;
    if (reserve.instanceColor) reserve.instanceColor.needsUpdate = true;
    if (reserveStack.instanceColor) reserveStack.instanceColor.needsUpdate = true;
  };
  commit();

  let disposed = false;
  return {
    group,
    frames,
    faces,
    reserve,
    reserveStack,
    faceIndex,
    reserveIndex,
    stackCount,
    setFace,
    setReserve,
    commit,
    faceWorld(i, target) {
      const b = i * 6;
      return target.set(faceBase[b], faceBase[b + 1] + faceBase[b + 4] / 2, faceBase[b + 2]);
    },
    reserveWorld(i, target) {
      const b = i * 3;
      return target.set(reserveBase[b], reserveBase[b + 1] + PALLET_HEIGHT / 2, reserveBase[b + 2]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      faces.dispose();
      reserve.dispose();
      reserveStack.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
