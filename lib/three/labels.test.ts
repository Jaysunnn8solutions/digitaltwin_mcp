/**
 * Overlapping label pills stack upwards, chips stay put, and the projector
 * applies the same pass to what it hands the page.
 */
import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three";
import type { LabelPos } from "./api";
import { deoverlap, LABEL_GAP_PX, LABEL_HEIGHT_PX, LabelProjector, labelWidth, queueChipEntity, type LabelSource } from "./labels";

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
});
