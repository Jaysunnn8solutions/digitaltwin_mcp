/**
 * A fitted preset puts every corner of its box inside the frustum at the
 * requested fill, on any aspect, and the rig re-fits on resize until the
 * user takes the camera.
 */
import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import sitesJson from "../../data/sites.json";
import { buildLayout, siteToSpec } from "../twin/layout";
import type { Site } from "../twin/types";
import type { CameraPreset } from "./api";
import { worldFromLayout } from "./building";
import { CameraRig, fitDistance, fitView, PRESET_FILL, presetSpecs, type PresetView, type StageBox } from "./cameras";
import { toWorld } from "./geometry";

const site = (sitesJson as Site[]).find((s) => s.id === "dc-east")!;
const layout = buildLayout(siteToSpec(site), site);
const world = worldFromLayout(layout);

/** Largest |ndc| over the box corners for a camera placed at the view. */
function extent(box: StageBox, view: PresetView, fov: number, aspect: number): { max: number; behind: boolean } {
  const cam = new PerspectiveCamera(fov, aspect, 0.5, 5000);
  cam.position.copy(view.pos);
  cam.lookAt(view.target);
  cam.updateMatrixWorld();
  let max = 0;
  let behind = false;
  const v = new Vector3();
  for (const x of [box.x0, box.x1]) {
    for (const y of [box.y0, box.y1]) {
      for (const z of [box.z0, box.z1]) {
        toWorld(x, y, z, v).project(cam);
        if (v.z > 1 || v.z < -1) behind = true;
        max = Math.max(max, Math.abs(v.x), Math.abs(v.y));
      }
    }
  }
  return { max, behind };
}

describe("fitDistance", () => {
  it("puts a unit cube seen head-on at twice its half-size for a 90° square frustum", () => {
    const box: StageBox = { x0: -1, x1: 1, y0: -1, y1: 1, z0: -1, z1: 1 };
    expect(fitDistance(box, [0, -1, 0], 90, 1, 1)).toBeCloseTo(2, 6);
    // Half the fill needs twice the lateral room: the near face is 1 in front, so 1 / 0.5 + 1.
    expect(fitDistance(box, [0, -1, 0], 90, 1, 0.5)).toBeCloseTo(3, 6);
    // A wide aspect does not change the vertical limit, a narrow one binds on the width.
    expect(fitDistance(box, [0, -1, 0], 90, 2, 1)).toBeCloseTo(2, 6);
    expect(fitDistance(box, [0, -1, 0], 90, 0.5, 1)).toBeCloseTo(3, 6);
  });
});

describe("presets", () => {
  const specs = presetSpecs(layout, world);
  const presets = Object.keys(specs) as CameraPreset[];

  it.each([1.6, 1.0, 0.45])("fill the viewport at aspect %s without clipping the subject", (aspect) => {
    for (const p of presets) {
      const spec = specs[p];
      const view = fitView(spec, 55, aspect);
      const { max, behind } = extent(spec.box, view, 55, aspect);
      expect(behind, p).toBe(false);
      expect(max, p).toBeLessThanOrEqual((spec.fill ?? PRESET_FILL) + 0.02);
      // A fitted view touches the fill on at least one side unless a height floor pushed it back.
      if (spec.minHeight === undefined) expect(max, p).toBeGreaterThan((spec.fill ?? PRESET_FILL) - 0.05);
    }
  });

  it("looks at the building from the dock side, above the yard, and never below a preset's height floor", () => {
    const overview = fitView(specs.overview, 55, 1.6);
    expect(-overview.pos.z).toBeLessThan(world.yard.roadY);
    expect(overview.pos.y).toBeGreaterThan(100);
    const dock = fitView(specs.dock, 55, 1.6);
    expect(dock.pos.y).toBeGreaterThanOrEqual(specs.dock.minHeight!);
    expect(dock.pos.y).toBeLessThan(overview.pos.y);
    const pick = fitView(specs.pick, 55, 1.6);
    expect(pick.pos.y).toBeGreaterThanOrEqual(specs.pick.minHeight!);
    expect(-pick.pos.z).toBeLessThan(layout.pickFrontY);
    expect(specs.pick.box.x1 - specs.pick.box.x0).toBeLessThan(layout.spec.widthFt);
  });
});

describe("CameraRig", () => {
  it("re-fits the active preset on an aspect change and lets go once the user moves the camera", () => {
    const rig = new CameraRig();
    rig.setAspect(1.6);
    rig.setWorld(layout, world);
    expect(rig.activePreset).toBe("overview");
    const wide = rig.camera.position.clone();
    rig.setAspect(0.6);
    const tall = rig.camera.position.clone();
    expect(tall.distanceTo(new Vector3(150, 0, -100))).toBeGreaterThan(wide.distanceTo(new Vector3(150, 0, -100)));
    rig.preset("pick");
    expect(rig.activePreset).toBe("pick");
    rig.lookAt(10, 10);
    expect(rig.activePreset).toBeNull();
    const held = rig.camera.position.clone();
    rig.setAspect(1.2);
    expect(rig.camera.position.equals(held)).toBe(true);
    rig.setMode("follow", 3);
    expect(rig.activePreset).toBeNull();
    rig.dispose();
  });
});
