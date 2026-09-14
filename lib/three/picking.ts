/**
 * Ray-casting into the scene and naming what was hit in the page's terms
 * (PickResult). Instanced meshes resolve through instanceId: faces and
 * reserve positions are indexed like the layout, loose pallets through the
 * pool's entity table, and the stack mesh folds n + i back to i. Actors
 * resolve through userData.entity on any child. Lanes have no solid, so a
 * hit on the floor near a lane slot names the slot. Queue chips are DOM
 * elements and never come from a ray.
 */

import { Camera, InstancedMesh, Mesh, Object3D, Raycaster, Vector2 } from "three";
import type { World } from "../trace/types";
import type { PickResult } from "./api";

export interface PickTargets {
  actors: Object3D;
  faces: InstancedMesh;
  reserve: InstancedMesh;
  reserveStack: InstancedMesh;
  loose: InstancedMesh;
  looseEntity: Int32Array;
  doorPads: Mesh[];
  doorLamps: Mesh[];
  stations: Mesh[];
  floor: Mesh;
  world: World;
}

const _ndc = new Vector2();

export class Picker {
  private readonly ray = new Raycaster();

  pick(ndcX: number, ndcY: number, camera: Camera, targets: PickTargets): PickResult | null {
    _ndc.set(ndcX, ndcY);
    this.ray.setFromCamera(_ndc, camera);
    const objects: Object3D[] = [targets.actors, targets.faces, targets.reserve, targets.reserveStack, targets.loose, ...targets.doorPads, ...targets.doorLamps, ...targets.stations, targets.floor];
    const hits = this.ray.intersectObjects(objects, true);
    const nRes = targets.reserve.count;
    for (const hit of hits) {
      const o = hit.object;
      if (!o.visible) continue;
      if (o === targets.faces) {
        if (hit.instanceId !== undefined) return { kind: "face", index: hit.instanceId };
        continue;
      }
      if (o === targets.reserve) {
        if (hit.instanceId !== undefined) return { kind: "reserve", index: hit.instanceId };
        continue;
      }
      if (o === targets.reserveStack) {
        if (hit.instanceId !== undefined) return { kind: "reserve", index: hit.instanceId % Math.max(1, nRes) };
        continue;
      }
      if (o === targets.loose) {
        if (hit.instanceId === undefined) continue;
        const entity = targets.looseEntity[hit.instanceId];
        if (entity >= 0) return { kind: "entity", entity };
        continue;
      }
      if (o === targets.floor) {
        const x = hit.point.x;
        const y = -hit.point.z;
        let best: { d: number; door: number; slot: number } | null = null;
        targets.world.lanes.forEach((lane, door) => {
          lane.slots.forEach((s, slot) => {
            const d = Math.hypot(s[0] - x, s[1] - y);
            if (d <= 2.6 && (!best || d < best.d)) best = { d, door, slot };
          });
        });
        if (best) {
          const b: { door: number; slot: number } = best;
          return { kind: "lane", door: b.door, slot: b.slot };
        }
        continue;
      }
      const pick = o.userData.pick as PickResult | undefined;
      if (pick) return pick;
      let node: Object3D | null = o;
      while (node) {
        const entity = node.userData.entity;
        if (typeof entity === "number" && entity >= 0) return { kind: "entity", entity };
        node = node.parent;
      }
    }
    return null;
  }
}
