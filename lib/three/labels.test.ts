/**
 * Overlapping label pills stack upwards, chips stay put, and the projector
 * applies the same pass to what it hands the page.
 */
import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three";
import type { LabelPos } from "./api";
import { deoverlap, LABEL_GAP_PX, LABEL_HEIGHT_PX, LabelProjector, labelWidth, MAX_LABELS, queueChipEntity, wallsHide, type LabelOccluder, type LabelSource } from "./labels";

const at = (entity: number, text: string, x: number, y: number, depth: number): LabelPos => ({ entity, text, x, y, depth, visible: true });

describe("deoverlap", () => {
  it("leaves labels that do not touch alone", () => {
    const labels = [at(0, "W-E-001", 100, 100, 10), at(1, "W-E-002", 300, 100, 20), at(2, "W-E-003", 100, 300, 5)];
    const before = labels.map((l) => l.y);
    deoverlap(labels);
    expect(labels.map((l) => l.y)).toEqual(before);
  });

  it("stacks the farther of two labels on one anchor above the nearer", () => {
    const near = at(0, "W-E-001", 100, 100, 10);
    const far = at(1, "W-E-002", 104, 102, 40);
    deoverlap([far, near]);
    expect(near.y).toBe(100);
    expect(far.y).toBe(100 - LABEL_HEIGHT_PX - LABEL_GAP_PX);
  });

  it("keeps a queue chip where it is and moves the actor above it", () => {
    const chip = at(queueChipEntity(0), "pick 3", 100, 90, 50);
    const actor = at(7, "W-E-001", 100, 100, 10);
    deoverlap([actor, chip]);
    expect(chip.y).toBe(90);
    expect(actor.y).toBe(90 - LABEL_HEIGHT_PX - LABEL_GAP_PX);
  });

  it("stacks two chips whose homes coincide on screen, nearer one on its anchor", () => {
    const receive = at(queueChipEntity(0), "receive 1", 100, 90, 30);
    const replenish = at(queueChipEntity(2), "replenish 6", 120, 92, 45);
    const actor = at(7, "W-E-001", 110, 100, 10);
    deoverlap([actor, replenish, receive]);
    expect(receive.y).toBe(90);
    expect(replenish.y).toBe(90 - LABEL_HEIGHT_PX - LABEL_GAP_PX);
    expect(actor.y).toBe(replenish.y - LABEL_HEIGHT_PX - LABEL_GAP_PX);
  });

  it("climbs a stack of three without leaving a gap or an overlap", () => {
    const labels = [at(0, "A", 100, 100, 1), at(1, "B", 100, 100, 2), at(2, "C", 100, 100, 3)];
    deoverlap(labels);
    const ys = labels.map((l) => l.y).sort((a, b) => b - a);
    expect(ys[0] - ys[1]).toBe(LABEL_HEIGHT_PX + LABEL_GAP_PX);
    expect(ys[1] - ys[2]).toBe(LABEL_HEIGHT_PX + LABEL_GAP_PX);
  });

  it("only moves a label whose pill actually overlaps", () => {
    const a = at(0, "W-E-001", 100, 100, 1);
    const b = at(1, "W-E-002", 100 + labelWidth("W-E-001") + 1, 100, 2);
    deoverlap([a, b]);
    expect(b.y).toBe(100);
  });
});

describe("LabelProjector", () => {
  it("projects on-screen anchors and stacks the ones that coincide", () => {
    const camera = new PerspectiveCamera(55, 1.6, 0.5, 5000);
    camera.position.set(100, 80, 60);
    camera.lookAt(100, 0, -100);
    camera.updateMatrixWorld();
    const sources: LabelSource[] = [
      { entity: 0, text: "W-E-001", x: 100, y: 100, z: 6.5, priority: 1 },
      { entity: 1, text: "W-E-002", x: 100.5, y: 100, z: 6.5, priority: 1 },
      // Past the camera's 5000 ft far plane along the view axis (the anchor lies almost on it).
      { entity: 2, text: "beyond the far plane", x: 100, y: 6000, z: 6.5, priority: 1 },
      { entity: 3, text: "behind", x: 100, y: -600, z: 6.5, priority: 1 },
      { entity: 4, text: "off to the side", x: 100 + 4000, y: 100, z: 6.5, priority: 1 },
    ];
    const out = new LabelProjector().project(sources, camera, 1600, 1000);
    expect(out.map((l) => l.entity).sort()).toEqual([0, 1]);
    const a = out.find((l) => l.entity === 0)!;
    const b = out.find((l) => l.entity === 1)!;
    expect(Math.abs(a.x - b.x)).toBeLessThan(10);
    expect(Math.abs(a.y - b.y)).toBe(LABEL_HEIGHT_PX + LABEL_GAP_PX);
  });

  it("drops a worker's pill behind the walls from a low camera outside, keeps trucks and chips, and shows it again from above", () => {
    // One dock door IN-1 at x = 30 on the dock wall, 9 ft wide, 14 ft high.
    const occ: LabelOccluder = { w: 300, d: 200, wallHeight: 28, doors: [{ x: 30, y: 0, tx: 1, ty: 0, halfWidth: 4.5 }], doorHeight: 14 };
    // Engine (x, y, height) → world (x, height, -y): the dock preset stands in the yard (y = -60) at 20 ft, here in front of IN-1.
    const low = new PerspectiveCamera(55, 1.6, 0.5, 5000);
    low.position.set(25, 20, 60);
    low.lookAt(150, 0, -100);
    low.updateMatrixWorld();
    const sources: LabelSource[] = [
      { entity: 0, text: "W-E-002", x: 150, y: 100, z: 6.5, priority: 1, occludable: true },
      { entity: 1, text: "SUP-HARD truck", x: 30, y: 0, z: 14, priority: 2 },
      { entity: queueChipEntity(0), text: "unload 4", x: 30, y: 5, z: 13, priority: 3 },
      // A worker on the apron behind the open door is seen through it (the sightline meets the wall at 7.7 ft inside the 9 ft opening); one in the doorway too; one behind the blank wall beside the door is not.
      { entity: 2, text: "W-E-001", x: 30, y: 6, z: 6.5, priority: 1, occludable: true },
      { entity: 3, text: "W-E-003", x: 30, y: 0.2, z: 6.5, priority: 1, occludable: true },
      { entity: 4, text: "W-E-004", x: 45, y: 6, z: 6.5, priority: 1, occludable: true },
    ];
    const seen = new LabelProjector().project(sources, low, 1600, 1000, MAX_LABELS, occ).map((l) => l.entity);
    expect(seen).not.toContain(0);
    expect(seen).not.toContain(4);
    expect(seen).toContain(2);
    expect(seen).toContain(1);
    expect(seen).toContain(queueChipEntity(0));
    expect(seen).toContain(3);
    // Without an occluder (or with the flag off) nothing is dropped.
    expect(new LabelProjector().project(sources, low, 1600, 1000).map((l) => l.entity)).toContain(0);
    const high = new PerspectiveCamera(55, 1.6, 0.5, 5000);
    high.position.set(25, 80, 60);
    high.lookAt(150, 0, -100);
    high.updateMatrixWorld();
    expect(new LabelProjector().project(sources, high, 1600, 1000, MAX_LABELS, occ).map((l) => l.entity)).toContain(0);
    // A camera inside the building at eye level (walk mode) sees every pill.
    expect(wallsHide(150, 50, 5.5, 150, 100, 6.5, occ)).toBe(false);
    // From 60 ft outside, the sightline to a pill 100 ft inside crosses the wall plane at 3/8 of the way: 20 → 14.9 ft (hidden), 80 → 52 ft (seen).
    expect(wallsHide(-40, -60, 20, 150, 100, 6.5, occ)).toBe(true);
    expect(wallsHide(-40, -60, 80, 150, 100, 6.5, occ)).toBe(false);
    // Just above the wall top is not enough: at 36 ft the sightline to a low pill deep inside meets the wall at 25 ft, over the door head, in the door's span.
    expect(wallsHide(-40, -60, 36, 150, 100, 6.5, occ)).toBe(true);
    // A pill on the apron behind the door is seen through the opening from in front of it (the sightline meets the wall at 9 ft), not from beside it.
    expect(wallsHide(25, -60, 36, 30, 6, 6.5, occ)).toBe(false);
    expect(wallsHide(25, -60, 12, 45, 6, 6.5, occ)).toBe(true);
    expect(wallsHide(-40, -60, 12, 30, 6, 6.5, occ)).toBe(true);
    // A camera level with a side wall's slab never enters it along that axis; the other axis decides.
    expect(wallsHide(150, -60, 20, 150, 100, 6.5, occ)).toBe(true);
  });
});
