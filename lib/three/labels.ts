/**
 * DOM label anchors. The renderer never draws text: each frame it collects
 * the things worth naming (workers and trucks on the floor, queue chips over
 * the process homes, ×n badges on overflowing reserve positions), projects
 * them with the camera, nudges overlapping anchors apart and hands the page
 * at most MAX_LABELS screen positions. The page owns the DOM elements.
 *
 * LabelPos.entity is the entity index for actors. Two negative ranges carry
 * the other anchors: queue chips are -1 - processIndex (PROCESSES order) and
 * reserve badges are -100 - reserveIndex; `text` is ready to show either way.
 *
 * De-overlap: the page draws each label as a pill whose bottom-centre is the
 * anchor (translate(-50%, -100%)), 11 px text with 6 px side padding. Chips
 * (priority 3) are placed first, so a chip keeps its home unless another
 * chip is already there (two homes a few feet apart, like the receive lane
 * mouth and the forklift park, stack); every other label is placed nearest
 * first and, when its pill would cover one already placed, moved up to sit
 * on top of that pill, so two names at the depot stack instead of printing
 * over each other. Anything past MAX_HOPS hops stays where it landed.
 */

import { Camera, Vector3 } from "three";
import type { LabelPos } from "./api";
import { toWorld } from "./geometry";

export const MAX_LABELS = 24;
/** Pill metrics matching app/twin/twin.css .twin-label at 11 px. */
export const LABEL_CHAR_PX = 6.4;
export const LABEL_PAD_PX = 14;
export const LABEL_HEIGHT_PX = 17;
export const LABEL_GAP_PX = 2;
const MAX_HOPS = 6;

export interface LabelSource {
  entity: number;
  text: string;
  /** Engine frame. */
  x: number;
  y: number;
  z: number;
  /** Higher wins when more than MAX_LABELS are on screen. */
  priority: number;
  /** Hidden by the walls: dropped when the camera is outside the building and below the wall top (workers; not trucks, which stand at the wall, nor chips). */
  occludable?: boolean;
}

/** A dock door as an opening in the wall: its centre on the wall, the wall's tangent and half the opening's width, engine feet. */
export interface LabelDoorway {
  x: number;
  y: number;
  tx: number;
  ty: number;
  halfWidth: number;
}

/** The building's footprint, wall height and door openings, for the occlusion test in project(). */
export interface LabelOccluder {
  /** Engine feet: the building spans 0..w across and 0..d in from the dock wall. */
  w: number;
  d: number;
  wallHeight: number;
  /** Openings a sightline passes through below doorHeight (the receiver at a docked trailer keeps its pill from the yard). */
  doors?: LabelDoorway[];
  doorHeight?: number;
}

const OCCLUDE_MARGIN_FT = 0.5;

/** Where a ray from p along dp enters the slab [0, hi]: -Infinity when already inside it, Infinity when it never does. */
function slabEntry(p: number, dp: number, hi: number): number {
  if (Math.abs(dp) < 1e-9) return p >= 0 && p <= hi ? -Infinity : Infinity;
  return Math.min(-p / dp, (hi - p) / dp);
}

/** How far off the wall line a crossing point may be and still count as passing through a doorway on it. */
const DOORWAY_DEPTH_FT = 1.5;

/**
 * Whether the walls stand between the camera and an anchor inside the
 * building, so a pill would float on a blank wall: the camera is outside the
 * footprint and the sightline to the anchor is below the wall top where it
 * crosses the footprint's edge, and not through a door opening there. The
 * roofless model means a sightline that clears the wall sees inside; a camera
 * a little above the wall top still loses a low anchor deep inside, which the
 * dock preset showed, while the receiver on the apron behind an open door is
 * seen through it.
 */
export function wallsHide(camX: number, camY: number, camHeight: number, ax: number, ay: number, aHeight: number, occ: LabelOccluder): boolean {
  const camOutside = camX < 0 || camX > occ.w || camY < 0 || camY > occ.d;
  if (!camOutside) return false;
  if (!(ax > OCCLUDE_MARGIN_FT && ax < occ.w - OCCLUDE_MARGIN_FT && ay > OCCLUDE_MARGIN_FT && ay < occ.d - OCCLUDE_MARGIN_FT)) return false;
  const dx = ax - camX;
  const dy = ay - camY;
  const sIn = Math.max(slabEntry(camX, dx, occ.w), slabEntry(camY, dy, occ.d));
  if (!Number.isFinite(sIn) || sIn < 0 || sIn > 1) return false;
  const hAtWall = camHeight + sIn * (aHeight - camHeight);
  if (hAtWall >= occ.wallHeight) return false;
  if (occ.doors && hAtWall < (occ.doorHeight ?? 0)) {
    const px = camX + sIn * dx;
    const py = camY + sIn * dy;
    for (const door of occ.doors) {
      const rx = px - door.x;
      const ry = py - door.y;
      const along = rx * door.tx + ry * door.ty;
      const off = Math.abs(rx * -door.ty + ry * door.tx);
      if (Math.abs(along) <= door.halfWidth && off <= DOORWAY_DEPTH_FT) return false;
    }
  }
  return true;
}

export function queueChipEntity(processIndex: number): number {
  return -1 - processIndex;
}

export function isQueueChip(entity: number): boolean {
  return entity < 0 && entity > -100;
}

export function reserveBadgeEntity(reserveIndex: number): number {
  return -100 - reserveIndex;
}

export function reserveBadgeIndex(entity: number): number {
  return -100 - entity;
}

/** Estimated pill width for a label's text. */
export function labelWidth(text: string): number {
  return LABEL_PAD_PX + text.length * LABEL_CHAR_PX;
}

interface Placed {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function overlaps(a: Placed, b: Placed): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * Moves overlapping labels up, in place. `first` says which labels are
 * placed before the rest (queue chips), so they keep their anchors against
 * everything but each other; the rest are visited nearest first so the
 * label a viewer is closest to keeps its anchor.
 */
export function deoverlap(labels: LabelPos[], first: (l: LabelPos) => boolean = (l) => isQueueChip(l.entity), height = LABEL_HEIGHT_PX, gap = LABEL_GAP_PX): void {
  const placed: Placed[] = [];
  const box = (l: LabelPos): Placed => {
    const hw = labelWidth(l.text) / 2;
    return { x0: l.x - hw, x1: l.x + hw, y0: l.y - height, y1: l.y };
  };
  const order = labels.map((l, i) => i).sort((a, b) => {
    const fa = first(labels[a]) ? 0 : 1;
    const fb = first(labels[b]) ? 0 : 1;
    return fa - fb || labels[a].depth - labels[b].depth;
  });
  for (const i of order) {
    const l = labels[i];
    let b = box(l);
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const hit = placed.find((p) => overlaps(b, p));
      if (!hit) break;
      l.y = hit.y0 - gap;
      b = box(l);
    }
    placed.push(b);
  }
}

const _v = new Vector3();
const _w = new Vector3();

export class LabelProjector {
  project(sources: readonly LabelSource[], camera: Camera, width: number, height: number, max = MAX_LABELS, occluder: LabelOccluder | null = null): LabelPos[] {
    const out: Array<LabelPos & { priority: number }> = [];
    camera.updateMatrixWorld();
    const camPos = _w.setFromMatrixPosition(camera.matrixWorld);
    // The camera in engine feet: world X is engine x, world -Z is engine y, world Y is height.
    const camX = camPos.x;
    const camY = -camPos.z;
    const camHeight = camPos.y;
    for (const s of sources) {
      if (s.occludable && occluder && wallsHide(camX, camY, camHeight, s.x, s.y, s.z, occluder)) continue;
      toWorld(s.x, s.y, s.z, _v);
      const depth = _v.distanceTo(camPos);
      _v.project(camera);
      const visible = _v.z > -1 && _v.z < 1 && _v.x >= -1.05 && _v.x <= 1.05 && _v.y >= -1.05 && _v.y <= 1.05;
      if (!visible) continue;
      out.push({ entity: s.entity, text: s.text, x: ((_v.x + 1) / 2) * width, y: ((1 - _v.y) / 2) * height, depth, visible: true, priority: s.priority });
    }
    out.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    const kept = out.slice(0, max).map(({ entity, text, x, y, depth, visible }) => ({ entity, text, x, y, depth, visible }));
    deoverlap(kept);
    return kept;
  }
}
