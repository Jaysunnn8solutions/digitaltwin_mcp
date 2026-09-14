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
 * (priority 3) stay where they are; every other label is placed nearest
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
 * Moves overlapping labels up, in place. `fixed` says which labels never
 * move (queue chips); the rest are visited nearest first so the label a
 * viewer is closest to keeps its anchor.
 */
export function deoverlap(labels: LabelPos[], fixed: (l: LabelPos) => boolean = (l) => isQueueChip(l.entity), height = LABEL_HEIGHT_PX, gap = LABEL_GAP_PX): void {
  const placed: Placed[] = [];
  const box = (l: LabelPos): Placed => {
    const hw = labelWidth(l.text) / 2;
    return { x0: l.x - hw, x1: l.x + hw, y0: l.y - height, y1: l.y };
  };
  const order = labels.map((l, i) => i).sort((a, b) => {
    const fa = fixed(labels[a]) ? 0 : 1;
    const fb = fixed(labels[b]) ? 0 : 1;
    return fa - fb || labels[a].depth - labels[b].depth;
  });
  for (const i of order) {
    const l = labels[i];
    if (fixed(l)) {
      placed.push(box(l));
      continue;
    }
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
  project(sources: readonly LabelSource[], camera: Camera, width: number, height: number, max = MAX_LABELS): LabelPos[] {
    const out: Array<LabelPos & { priority: number }> = [];
    camera.updateMatrixWorld();
    const camPos = _w.setFromMatrixPosition(camera.matrixWorld);
    for (const s of sources) {
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
