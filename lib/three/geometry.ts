/**
 * Procedural low-poly geometry for the twin, and the two helpers everything
 * else is built on: the engine → three.js frame mapping and a resource
 * tracker so dispose() can prove it freed every geometry it made.
 *
 * Frame: engine (x across, y from the dock wall inward, z up) maps to three
 * (X = x, Y = z, Z = -y). Actors are modelled facing +X so `rotation.y = h`
 * turns an engine heading (radians in the x/y plane, 0 = +x) into the right
 * direction: rotating +X about Y by h gives (cos h, 0, -sin h) = engine
 * (cos h, sin h).
 *
 * Every actor part stays under 300 triangles; racks and walls use BoxBatch,
 * which writes thousands of boxes straight into one BufferGeometry instead of
 * merging thousands of BoxGeometry objects (a 25k-face import builds in well
 * under half a second that way).
 */

import { BoxGeometry, BufferGeometry, CapsuleGeometry, CylinderGeometry, Float32BufferAttribute, Material, PlaneGeometry, RingGeometry, SphereGeometry, Texture, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export function toWorld(x: number, y: number, z: number, target: Vector3 = new Vector3()): Vector3 {
  return target.set(x, z, -y);
}

/** Inverse of toWorld: a world point back to engine (x, y, z). */
export function toEngine(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: -v.z, z: v.y };
}

// ---------------------------------------------------------------------------
// Resource tracking
// ---------------------------------------------------------------------------

/**
 * Everything a scene allocates registers here, so dispose() is one call and
 * a test can assert created === disposed. Registering the same geometry
 * twice counts once.
 */
export class ResourceTracker {
  readonly geometries = new Set<BufferGeometry>();
  readonly materials = new Set<Material>();
  readonly textures = new Set<Texture>();
  created = 0;
  disposed = 0;
  materialsCreated = 0;
  materialsDisposed = 0;

  geometry<T extends BufferGeometry>(g: T): T {
    if (!this.geometries.has(g)) {
      this.geometries.add(g);
      this.created++;
    }
    return g;
  }

  material<T extends Material>(m: T): T {
    if (!this.materials.has(m)) {
      this.materials.add(m);
      this.materialsCreated++;
    }
    return m;
  }

  texture<T extends Texture>(t: T): T {
    this.textures.add(t);
    return t;
  }

  /** Dispose one geometry early (a rebuilt rack set, a pool shrink). */
  release(g: BufferGeometry): void {
    if (this.geometries.delete(g)) {
      g.dispose();
      this.disposed++;
    }
  }

  disposeAll(): void {
    for (const g of this.geometries) {
      g.dispose();
      this.disposed++;
    }
    this.geometries.clear();
    for (const m of this.materials) {
      m.dispose();
      this.materialsDisposed++;
    }
    this.materials.clear();
    for (const t of this.textures) t.dispose();
    this.textures.clear();
  }
}

export function triangleCount(g: BufferGeometry): number {
  const index = g.getIndex();
  if (index) return index.count / 3;
  const pos = g.getAttribute("position");
  return pos ? pos.count / 3 : 0;
}

// ---------------------------------------------------------------------------
// Box batching
// ---------------------------------------------------------------------------

const FACES: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
  { n: [1, 0, 0], c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

/**
 * Appends axis-aligned (or Y-rotated) boxes into flat arrays and builds one
 * indexed BufferGeometry with positions and normals (Lambert materials need
 * no UVs). Twelve triangles per box.
 */
export class BoxBatch {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly idx: number[] = [];
  boxes = 0;

  /** A box of size (w, h, d) centred at (cx, cy, cz), rotated `angle` radians about Y. */
  add(w: number, h: number, d: number, cx: number, cy: number, cz: number, angle = 0): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const hw = w / 2;
    const hh = h / 2;
    const hd = d / 2;
    for (const face of FACES) {
      const base = this.pos.length / 3;
      const nx = face.n[0] * c + face.n[2] * s;
      const nz = -face.n[0] * s + face.n[2] * c;
      for (const [fx, fy, fz] of face.c) {
        const lx = fx * hw;
        const ly = fy * hh;
        const lz = fz * hd;
        this.pos.push(cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c);
        this.nrm.push(nx, face.n[1], nz);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.boxes++;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.nrm, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Actor parts (local frame: facing +X, standing on Y = 0)
// ---------------------------------------------------------------------------

function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(w, h, d).translate(x, y, z);
}

/** A wheel: cylinder with its axle along Z (a vehicle facing +X). */
function wheel(r: number, width: number, x: number, y: number, z: number): BufferGeometry {
  return new CylinderGeometry(r, r, width, 6).rotateX(Math.PI / 2).translate(x, y, z);
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

export interface WorkerParts {
  body: BufferGeometry;
  head: BufferGeometry;
  vest: BufferGeometry;
}

/** Capsule torso on two legs, a head, and a vest that carries the role tint. ~120 triangles. */
export function workerParts(): WorkerParts {
  const body = merge([
    new CapsuleGeometry(0.55, 2.0, 2, 6).translate(0, 2.6, 0),
    box(0.4, 1.6, 0.4, 0, 0.8, 0.28),
    box(0.4, 1.6, 0.4, 0, 0.8, -0.28),
  ]);
  const head = new SphereGeometry(0.45, 6, 4).translate(0, 4.35, 0);
  const vest = box(1.3, 1.2, 1.3, 0, 2.9, 0);
  return { body, head, vest };
}

export interface ForkliftParts {
  chassis: BufferGeometry;
  mast: BufferGeometry;
  carriage: BufferGeometry;
  /** Where a carried pallet's bottom centre sits, in carriage space. */
  carry: Vector3;
}

/** Counterbalance forklift: chassis with guard and wheels, a fixed mast, a carriage with forks that rises with the track's z. ~265 triangles. */
export function forkliftParts(): ForkliftParts {
  const chassis = merge([
    box(5.5, 1.6, 3.6, -0.5, 1.6, 0),
    box(2.0, 1.4, 3.4, -3.0, 1.2, 0),
    box(1.4, 0.6, 1.8, -0.4, 2.6, 0),
    box(0.2, 3.0, 0.2, 1.4, 3.9, 1.6),
    box(0.2, 3.0, 0.2, 1.4, 3.9, -1.6),
    box(0.2, 3.0, 0.2, -1.6, 3.9, 1.6),
    box(0.2, 3.0, 0.2, -1.6, 3.9, -1.6),
    box(3.6, 0.15, 3.8, -0.1, 5.4, 0),
    wheel(0.75, 0.6, 1.6, 0.75, 1.9),
    wheel(0.75, 0.6, 1.6, 0.75, -1.9),
    wheel(0.75, 0.6, -2.2, 0.75, 1.9),
    wheel(0.75, 0.6, -2.2, 0.75, -1.9),
  ]);
  const mast = merge([box(0.35, 7.5, 0.35, 2.6, 3.75, 1.1), box(0.35, 7.5, 0.35, 2.6, 3.75, -1.1), box(0.3, 0.3, 2.6, 2.6, 7.4, 0)]);
  const carriage = merge([box(0.3, 1.6, 3.0, 2.85, 1.0, 0), box(4.0, 0.15, 0.4, 5.0, 0.3, 0.9), box(4.0, 0.15, 0.4, 5.0, 0.3, -0.9)]);
  return { chassis, mast, carriage, carry: new Vector3(5.0, 0.38, 0) };
}

export interface JackParts {
  body: BufferGeometry;
  carry: Vector3;
}

/** Electric pallet jack: body with handle, two forks forward. ~100 triangles. */
export function jackParts(): JackParts {
  const body = merge([
    box(1.2, 1.0, 2.2, -0.2, 0.6, 0),
    box(0.15, 3.2, 0.15, -0.9, 2.2, 0),
    box(1.2, 0.12, 0.12, -1.4, 3.7, 0),
    box(4.0, 0.2, 0.5, 2.4, 0.2, 0.85),
    box(4.0, 0.2, 0.5, 2.4, 0.2, -0.85),
    wheel(0.4, 0.5, -0.4, 0.4, 0.8),
    wheel(0.4, 0.5, -0.4, 0.4, -0.8),
  ]);
  return { body, carry: new Vector3(2.4, 0.32, 0) };
}

/** A picking cart: bin on a frame with a handle. ~85 triangles. */
export function cartGeometry(): BufferGeometry {
  return merge([
    box(2.4, 1.6, 1.6, 0, 1.2, 0),
    box(2.6, 0.15, 1.8, 0, 0.35, 0),
    box(0.1, 2.0, 1.6, -1.35, 1.6, 0),
    box(0.3, 0.3, 0.15, 1.0, 0.15, 0.8),
    box(0.3, 0.3, 0.15, 1.0, 0.15, -0.8),
    box(0.3, 0.3, 0.15, -1.0, 0.15, 0.8),
    box(0.3, 0.3, 0.15, -1.0, 0.15, -0.8),
  ]);
}

/** Total height of a pallet with its load, for stacking. */
export const PALLET_HEIGHT = 3.4;
export const PALLET_FOOT = 3.3;

/**
 * A pallet with a case stack, origin at the bottom centre. "high" is a deck
 * and a load (24 triangles); "low" is the four sides of the load only
 * (8 triangles) for buildings past the instance budget.
 */
export function palletGeometry(quality: "high" | "low"): BufferGeometry {
  if (quality === "high") return merge([box(PALLET_FOOT, 0.4, PALLET_FOOT, 0, 0.2, 0), box(3.0, PALLET_HEIGHT - 0.4, 3.0, 0, 0.4 + (PALLET_HEIGHT - 0.4) / 2, 0)]);
  const hw = 1.55;
  const h = PALLET_HEIGHT;
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const sides: Array<{ n: [number, number, number]; c: Array<[number, number]> }> = [
    { n: [1, 0, 0], c: [[hw, -hw], [hw, hw]] },
    { n: [0, 0, 1], c: [[hw, hw], [-hw, hw]] },
    { n: [-1, 0, 0], c: [[-hw, hw], [-hw, -hw]] },
    { n: [0, 0, -1], c: [[-hw, -hw], [hw, -hw]] },
  ];
  for (const s of sides) {
    const base = pos.length / 3;
    const [[x0, z0], [x1, z1]] = s.c;
    pos.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, h, z0);
    for (let i = 0; i < 4; i++) nrm.push(...s.n);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Trailer length; the truck's origin is the trailer's rear (the dock face) and the nose points +X. */
export const TRUCK_LENGTH = 63;
export const TRAILER_LENGTH = 53;
export const TRAILER_WIDTH = 8.5;

export interface TruckParts {
  cab: BufferGeometry;
  trailer: BufferGeometry;
  wheels: BufferGeometry;
  sticker: BufferGeometry;
  lights: BufferGeometry;
}

/** Tractor and 53 ft trailer, rear at the origin. ~270 triangles. */
export function truckParts(): TruckParts {
  const cab = merge([box(7, 7, 8.5, 56.5, 5.0, 0), box(3, 3.5, 8.0, 61.5, 3.0, 0)]);
  const trailer = merge([box(TRAILER_LENGTH, 9, TRAILER_WIDTH, TRAILER_LENGTH / 2, 8.0, 0), box(TRAILER_LENGTH - 4, 0.6, 6, TRAILER_LENGTH / 2, 3.2, 0)]);
  const wheels = merge([
    wheel(1.6, 0.8, 6, 1.6, 3.6),
    wheel(1.6, 0.8, 6, 1.6, -3.6),
    wheel(1.6, 0.8, 10, 1.6, 3.6),
    wheel(1.6, 0.8, 10, 1.6, -3.6),
    wheel(1.6, 0.8, 55, 1.6, 3.6),
    wheel(1.6, 0.8, 55, 1.6, -3.6),
    wheel(1.6, 0.8, 60.5, 1.6, 3.6),
    wheel(1.6, 0.8, 60.5, 1.6, -3.6),
  ]);
  const sticker = new PlaneGeometry(6, 3).translate(40, 8, TRAILER_WIDTH / 2 + 0.02);
  const lights = merge([box(0.3, 0.6, 0.8, 0.05, 4.0, 3.5), box(0.3, 0.6, 0.8, 0.05, 4.0, -3.5)]);
  return { cab, trailer, wheels, sticker, lights };
}

/** A flat ring on the floor, for actor state and selection. 20 triangles. */
export function ringGeometry(inner = 1.3, outer = 1.8): BufferGeometry {
  return new RingGeometry(inner, outer, 10).rotateX(-Math.PI / 2).translate(0, 0.06, 0);
}
