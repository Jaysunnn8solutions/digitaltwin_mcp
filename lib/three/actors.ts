/**
 * Moving things: pooled Groups for workers, forklifts, pallet jacks and
 * trucks, and one InstancedMesh for the loose pallets sitting in dock lanes,
 * staging lanes and at pack stations. Actors are Groups rather than
 * instances because each one carries its own tint, a state ring, a cart or a
 * pallet child and, for trucks, a sticker and rear lights; a building never
 * has more than a few dozen on the floor at once, so the draw calls fit. The
 * pool keeps released groups for the next truck of the same kind, so a
 * 28-day run with hundreds of trucks reuses a handful of groups.
 *
 * Materials are shared per colour through MaterialCache; swapping a mesh's
 * material is how an actor changes tint or state. Geometries are built once
 * per pool and shared by every actor of the kind.
 */

import { Color, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, Quaternion, Vector3 } from "three";
import type { EntityKind } from "../trace/types";
import { cartGeometry, forkliftParts, jackParts, palletGeometry, ResourceTracker, ringGeometry, truckParts, workerParts } from "./geometry";
import { DOOR_COLORS, STATE_COLORS, SURFACES } from "./palette";
import type { BufferGeometry } from "three";

export type ActorKind = "worker" | "forklift" | "jack" | "truck";

/**
 * Figures are drawn a fifth larger than the 4.8 ft parts (a 5.8 ft person),
 * so a picker is legible from the overview while carts, forklifts and racks
 * keep their proportions.
 */
export const WORKER_SCALE = 1.2;
/** Floor state rings: wide enough to read as a ring from the overview. */
export const RING_INNER = 1.7;
export const RING_OUTER = 2.5;

export function actorKindOf(kind: EntityKind): ActorKind | null {
  switch (kind) {
    case "worker":
      return "worker";
    case "forklift":
      return "forklift";
    case "jack":
      return "jack";
    case "truckIn":
    case "truckOut":
      return "truck";
    default:
      return null;
  }
}

export const EQUIPMENT_COLORS = { forklift: 0xf08c00, jack: 0x1c7ed6 } as const;

/** Where a truck's state ring sits: the middle of the trailer, in truck space. */
const TRAILER_MID = 26;

/** One material per colour, so a hundred actors in eight roles cost eight materials. */
export class MaterialCache {
  private readonly lamberts = new Map<number, MeshLambertMaterial>();
  private readonly basics = new Map<number, MeshBasicMaterial>();
  readonly ghost: MeshLambertMaterial;

  constructor(readonly tracker: ResourceTracker) {
    this.ghost = tracker.material(new MeshLambertMaterial({ color: STATE_COLORS.absent, transparent: true, opacity: 0.35, depthWrite: false }));
  }

  lambert(hex: number): MeshLambertMaterial {
    let m = this.lamberts.get(hex);
    if (!m) {
      m = this.tracker.material(new MeshLambertMaterial({ color: hex }));
      this.lamberts.set(hex, m);
    }
    return m;
  }

  basic(hex: number): MeshBasicMaterial {
    let m = this.basics.get(hex);
    if (!m) {
      m = this.tracker.material(new MeshBasicMaterial({ color: hex }));
      this.basics.set(hex, m);
    }
    return m;
  }
}

export interface Actor {
  kind: ActorKind;
  entity: number;
  group: Group;
  /** The part that carries the role or kind tint (vest, chassis, jack body, cab). */
  tint: Mesh;
  ring: Mesh;
  cart: Mesh | null;
  /** Forklift carriage: rises with the track's z. */
  carriage: Object3D | null;
  /** Pallet child of a forklift or jack. */
  carried: Mesh | null;
  sticker: Mesh | null;
  lights: Mesh | null;
  /** The figure that bobs while walking. */
  bob: Object3D | null;
  phase: number;
  ghost: boolean;
  baseTint: number;
}

interface KindGeometries {
  worker?: ReturnType<typeof workerParts> & { cart: BufferGeometry };
  forklift?: ReturnType<typeof forkliftParts> & { pallet: BufferGeometry };
  jack?: ReturnType<typeof jackParts> & { pallet: BufferGeometry };
  truck?: ReturnType<typeof truckParts>;
  ring?: BufferGeometry;
}

export class ActorPool {
  readonly root = new Group();
  readonly active = new Map<number, Actor>();
  private readonly free: Record<ActorKind, Actor[]> = { worker: [], forklift: [], jack: [], truck: [] };
  private readonly geoms: KindGeometries = {};
  private readonly bodyMat: MeshLambertMaterial;
  private readonly skinMat: MeshLambertMaterial;
  private readonly steelMat: MeshLambertMaterial;
  private readonly trailerMat: MeshLambertMaterial;
  private readonly wheelMat: MeshLambertMaterial;
  private readonly lightsOff: MeshBasicMaterial;
  private disposed = false;

  constructor(
    readonly tracker: ResourceTracker,
    readonly materials: MaterialCache,
    private readonly quality: "high" | "low"
  ) {
    this.root.name = "actors";
    this.bodyMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.body }));
    this.skinMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.skin }));
    this.steelMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.steel }));
    this.trailerMat = tracker.material(new MeshLambertMaterial({ color: SURFACES.trailer }));
    this.wheelMat = tracker.material(new MeshLambertMaterial({ color: 0x2b2b2b }));
    this.lightsOff = materials.basic(0x5c1010);
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** The group for an entity, reusing a released one of the same kind; null for pallets. */
  acquire(entity: number, kind: EntityKind): Actor | null {
    const existing = this.active.get(entity);
    if (existing) return existing;
    const ak = actorKindOf(kind);
    if (!ak) return null;
    const actor = this.free[ak].pop() ?? this.build(ak);
    actor.entity = entity;
    actor.ghost = false;
    actor.phase = 0;
    actor.group.visible = true;
    actor.group.traverse((o) => {
      o.userData.entity = entity;
    });
    if (actor.cart) actor.cart.visible = false;
    if (actor.carried) actor.carried.visible = false;
    if (actor.sticker) actor.sticker.visible = false;
    if (actor.lights) actor.lights.material = this.lightsOff;
    actor.ring.visible = false;
    this.active.set(entity, actor);
    return actor;
  }

  release(entity: number): void {
    const actor = this.active.get(entity);
    if (!actor) return;
    this.active.delete(entity);
    actor.group.visible = false;
    actor.entity = -1;
    this.free[actor.kind].push(actor);
  }

  releaseAll(): void {
    for (const entity of [...this.active.keys()]) this.release(entity);
  }

  /** Swap the tint part's colour (shared material per colour). */
  setTint(actor: Actor, hex: number): void {
    actor.baseTint = hex;
    actor.tint.material = actor.ghost ? this.materials.ghost : this.materials.lambert(hex);
  }

  setGhost(actor: Actor, ghost: boolean): void {
    if (actor.ghost === ghost) return;
    actor.ghost = ghost;
    actor.tint.material = ghost ? this.materials.ghost : this.materials.lambert(actor.baseTint);
    if (actor.bob) {
      for (const child of actor.bob.children) {
        if (child === actor.tint || !(child instanceof Mesh)) continue;
        child.material = ghost ? this.materials.ghost : child.userData.baseMaterial;
      }
    }
  }

  setRing(actor: Actor, hex: number | null): void {
    if (hex === null) {
      actor.ring.visible = false;
      return;
    }
    actor.ring.visible = true;
    actor.ring.material = this.materials.basic(hex);
  }

  setLights(actor: Actor, on: boolean): void {
    if (!actor.lights) return;
    actor.lights.material = on ? this.materials.basic(STATE_COLORS.late) : this.lightsOff;
  }

  private ringGeom(): BufferGeometry {
    if (!this.geoms.ring) this.geoms.ring = this.tracker.geometry(ringGeometry(RING_INNER, RING_OUTER));
    return this.geoms.ring;
  }

  private build(kind: ActorKind): Actor {
    const group = new Group();
    group.name = kind;
    this.root.add(group);
    const ring = new Mesh(this.ringGeom(), this.materials.basic(STATE_COLORS.wait));
    ring.visible = false;
    group.add(ring);
    const base: Omit<Actor, "tint"> = { kind, entity: -1, group, ring, cart: null, carriage: null, carried: null, sticker: null, lights: null, bob: null, phase: 0, ghost: false, baseTint: 0xffffff };
    const shadow = (m: Mesh) => {
      m.castShadow = true;
      return m;
    };
    switch (kind) {
      case "worker": {
        if (!this.geoms.worker) {
          const p = workerParts();
          this.geoms.worker = { body: this.tracker.geometry(p.body), head: this.tracker.geometry(p.head), vest: this.tracker.geometry(p.vest), cart: this.tracker.geometry(cartGeometry()) };
        }
        const g = this.geoms.worker;
        const figure = new Group();
        const body = shadow(new Mesh(g.body, this.bodyMat));
        body.userData.baseMaterial = this.bodyMat;
        // Only the body casts: the shadow pass is a second draw per caster, and one silhouette per actor is enough.
        const head = new Mesh(g.head, this.skinMat);
        head.userData.baseMaterial = this.skinMat;
        const vest = new Mesh(g.vest, this.materials.lambert(0xffffff));
        figure.add(body, head, vest);
        figure.scale.setScalar(WORKER_SCALE);
        group.add(figure);
        const cart = new Mesh(g.cart, this.steelMat);
        cart.position.set(2.1, 0, 0);
        cart.visible = false;
        group.add(cart);
        return { ...base, tint: vest, cart, bob: figure };
      }
      case "forklift": {
        if (!this.geoms.forklift) {
          const p = forkliftParts();
          this.geoms.forklift = { chassis: this.tracker.geometry(p.chassis), mast: this.tracker.geometry(p.mast), carriage: this.tracker.geometry(p.carriage), carry: p.carry, pallet: this.tracker.geometry(palletGeometry(this.quality)) };
        }
        const g = this.geoms.forklift;
        const chassis = shadow(new Mesh(g.chassis, this.materials.lambert(EQUIPMENT_COLORS.forklift)));
        const mast = new Mesh(g.mast, this.steelMat);
        const carriage = new Mesh(g.carriage, this.steelMat);
        const carried = new Mesh(g.pallet, this.materials.lambert(0x8b5e3c));
        carried.position.copy(g.carry);
        carried.visible = false;
        carriage.add(carried);
        group.add(chassis, mast, carriage);
        return { ...base, tint: chassis, carriage, carried };
      }
      case "jack": {
        if (!this.geoms.jack) {
          const p = jackParts();
          this.geoms.jack = { body: this.tracker.geometry(p.body), carry: p.carry, pallet: this.tracker.geometry(palletGeometry(this.quality)) };
        }
        const g = this.geoms.jack;
        const body = shadow(new Mesh(g.body, this.materials.lambert(EQUIPMENT_COLORS.jack)));
        const carried = new Mesh(g.pallet, this.materials.lambert(0x8b5e3c));
        carried.position.copy(g.carry);
        carried.visible = false;
        group.add(body, carried);
        return { ...base, tint: body, carried };
      }
      case "truck": {
        if (!this.geoms.truck) {
          const p = truckParts();
          this.geoms.truck = { cab: this.tracker.geometry(p.cab), trailer: this.tracker.geometry(p.trailer), wheels: this.tracker.geometry(p.wheels), sticker: this.tracker.geometry(p.sticker), lights: this.tracker.geometry(p.lights) };
        }
        const g = this.geoms.truck;
        const cab = new Mesh(g.cab, this.materials.lambert(DOOR_COLORS.inbound));
        const trailer = shadow(new Mesh(g.trailer, this.trailerMat));
        const wheels = new Mesh(g.wheels, this.wheelMat);
        const sticker = new Mesh(g.sticker, this.materials.basic(STATE_COLORS.sticker));
        sticker.visible = false;
        const lights = new Mesh(g.lights, this.lightsOff);
        ring.scale.set(5, 1, 5);
        ring.position.set(TRAILER_MID, 0, 0);
        group.add(cab, trailer, wheels, sticker, lights);
        return { ...base, tint: cab, sticker, lights };
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAll();
    this.root.removeFromParent();
    this.root.clear();
    for (const k of Object.keys(this.free) as ActorKind[]) this.free[k].length = 0;
  }
}

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);
const _hidden = new Matrix4().makeScale(0, 0, 0);

/** Pallets on the floor (lanes, stations): one InstancedMesh, entity-addressed slots. */
export class LoosePallets {
  readonly mesh: InstancedMesh;
  readonly entityAt: Int32Array;
  private readonly slotOf = new Map<number, number>();
  private disposed = false;

  constructor(
    readonly tracker: ResourceTracker,
    quality: "high" | "low",
    readonly capacity = 64
  ) {
    const geom = tracker.geometry(palletGeometry(quality));
    const mat = tracker.material(new MeshLambertMaterial({ color: 0xffffff }));
    this.mesh = new InstancedMesh(geom, mat, capacity);
    this.mesh.name = "loosePallets";
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.entityAt = new Int32Array(capacity).fill(-1);
    const tint = new Color(0x8b5e3c);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, _hidden);
      this.mesh.setColorAt(i, tint);
    }
    this.commit();
  }

  /** Show a pallet for `entity` at a world position; false when every slot is taken. */
  place(entity: number, wx: number, wy: number, wz: number, color: Color, heading = 0): boolean {
    let slot = this.slotOf.get(entity);
    if (slot === undefined) {
      slot = this.entityAt.indexOf(-1);
      if (slot < 0) return false;
      this.slotOf.set(entity, slot);
      this.entityAt[slot] = entity;
    }
    _q.setFromAxisAngle(_up, heading);
    _m.compose(_p.set(wx, wy, wz), _q, _s);
    this.mesh.setMatrixAt(slot, _m);
    this.mesh.setColorAt(slot, color);
    return true;
  }

  remove(entity: number): void {
    const slot = this.slotOf.get(entity);
    if (slot === undefined) return;
    this.slotOf.delete(entity);
    this.entityAt[slot] = -1;
    this.mesh.setMatrixAt(slot, _hidden);
  }

  clear(): void {
    for (const entity of [...this.slotOf.keys()]) this.remove(entity);
  }

  get count(): number {
    return this.slotOf.size;
  }

  commit(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}
