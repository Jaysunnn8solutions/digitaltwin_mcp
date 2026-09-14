/**
 * three.js runs under Node for everything but the renderer, the procedural
 * actors stay inside the triangle budget, the building's child count is a
 * function of doors, zones and walls, and the environment around it follows
 * the theme and the clock.
 */
import { describe, expect, it } from "vitest";
import { Color, Mesh, MeshBasicMaterial, MeshLambertMaterial, ShaderMaterial, SphereGeometry } from "three";
import sitesJson from "../../data/sites.json";
import type { LayoutSpec } from "../layout/spec";
import { buildLayout, siteToSpec, withDoorCounts } from "../twin/layout";
import type { Site } from "../twin/types";
import { buildBuilding, FIXED_CHILDREN, PLATE_W, worldFromLayout } from "./building";
import { buildEnvironment, SKY_RADIUS } from "./environment";
import { cartGeometry, forkliftParts, jackParts, palletGeometry, ResourceTracker, triangleCount, truckParts, workerParts } from "./geometry";
import { DOOR_COLORS, STATE_COLORS, SURFACES, THEMES, darken } from "./palette";

const sites = sitesJson as Site[];
const site = sites.find((s) => s.id === "dc-west")!;

function build(spec: LayoutSpec) {
  const layout = buildLayout(spec, site);
  const world = worldFromLayout(layout);
  const tracker = new ResourceTracker();
  const building = buildBuilding(spec, layout, world, { tracker });
  return { layout, world, tracker, building };
}

describe("three under Node", () => {
  it("imports three and its addons without a DOM", async () => {
    const three = await import("three");
    expect(three.REVISION).toBe("186");
    expect(new three.Vector3(1, 2, 3).length()).toBeCloseTo(Math.sqrt(14));
    const utils = await import("three/examples/jsm/utils/BufferGeometryUtils.js");
    expect(typeof utils.mergeGeometries).toBe("function");
  });

  it("keeps every actor under 300 triangles", () => {
    const w = workerParts();
    expect(triangleCount(w.body) + triangleCount(w.head) + triangleCount(w.vest) + triangleCount(cartGeometry())).toBeLessThanOrEqual(300);
    const f = forkliftParts();
    expect(triangleCount(f.chassis) + triangleCount(f.mast) + triangleCount(f.carriage)).toBeLessThanOrEqual(300);
    expect(triangleCount(jackParts().body)).toBeLessThanOrEqual(300);
    const t = truckParts();
    expect(triangleCount(t.cab) + triangleCount(t.trailer) + triangleCount(t.wheels) + triangleCount(t.sticker) + triangleCount(t.lights)).toBeLessThanOrEqual(300);
    expect(triangleCount(palletGeometry("low"))).toBe(8);
    expect(triangleCount(palletGeometry("high"))).toBe(24);
  });
});

describe("buildBuilding", () => {
  const base = siteToSpec(site);

  it("has FIXED_CHILDREN + zones + 2 × doors + stations children for dc-west", () => {
    const { layout, world, tracker, building } = build(base);
    const expected = FIXED_CHILDREN + base.zones.length + 2 * layout.doors.length + world.stations.length;
    expect(building.group.children.length).toBe(expected);
    expect(building.doorPads).toHaveLength(4);
    expect(building.doorLamps).toHaveLength(4);
    expect(building.stations).toHaveLength(world.stations.length);
    const names = building.group.children.map((c) => c.name);
    for (const n of ["floor", "grid", "walls", "aisles", "paint", "doors:inbound", "doors:outbound", "bumpers", "doorPlates", "road", "queueMarks", "lanes", "entrance", "ceilingStrips"]) expect(names).toContain(n);
    building.dispose();
    tracker.disposeAll();
    expect(tracker.created).toBeGreaterThan(0);
    expect(tracker.disposed).toBe(tracker.created);
  });

  it("grows by two per door, one per zone and one for imported walls", () => {
    const b0 = build(base).building.group.children.length;
    const moreDoors = withDoorCounts(base, 3, 3);
    expect(build(moreDoors).building.group.children.length).toBe(b0 + 2 * 2);
    const zoned: LayoutSpec = { ...base, zones: [...base.zones, { kind: "office", name: "Office", ring: [[200, 170], [240, 170], [240, 200], [200, 200]] }] };
    expect(build(zoned).building.group.children.length).toBe(b0 + 1);
    const walled: LayoutSpec = { ...base, walls: [[[10, 50], [60, 50], [60, 65]]] };
    expect(build(walled).building.group.children.length).toBe(b0 + 1);
    const degenerate: LayoutSpec = { ...base, walls: [[[10, 50]]], zones: [...base.zones, { kind: "other", name: "line", ring: [[0, 0], [1, 1]] }] };
    expect(build(degenerate).building.group.children.length).toBe(b0);
  });

  it("cuts the doors out of the dock wall and shows door state on the lamp", () => {
    const { building } = build(base);
    const walls = building.group.children.find((c) => c.name === "walls")!;
    expect(walls).toBeDefined();
    const lamp = building.doorLamps[0].material as MeshBasicMaterial;
    expect(lamp.color.getHex()).toBe(darken(DOOR_COLORS.inbound, 0.45));
    building.setDoor(0, "busy");
    expect(lamp.color.getHex()).toBe(DOOR_COLORS.inbound);
    building.setDoor(0, "outage");
    expect(lamp.color.getHex()).toBe(STATE_COLORS.outage);
    building.setDoor(0, "free");
    expect(lamp.color.getHex()).toBe(darken(DOOR_COLORS.inbound, 0.45));
    expect(building.doorPads[2].userData.pick).toEqual({ kind: "door", index: 2 });
  });

  it("puts a plate on both faces of the wall above every door, unlettered without a canvas", () => {
    const { building, world } = build(base);
    const pos = building.doorPlates.geometry.getAttribute("position");
    expect(pos.count).toBe(world.frames.length * 8);
    expect(building.doorPlates.geometry.getAttribute("uv").count).toBe(pos.count);
    expect((building.doorPlates.material as MeshBasicMaterial).map).toBeNull();
    // Door 0 is on the dock wall (inward +y): its outside plate is just outside the wall, at plate height.
    const f = world.frames[0];
    expect(pos.getX(0)).toBeCloseTo(f.origin[0] - PLATE_W / 2, 5);
    expect(pos.getZ(0)).toBeGreaterThan(0.5);
    expect(pos.getY(2)).toBeGreaterThan(pos.getY(0));
  });

  it("lights the strips and darkens the yard slab with the exterior light level", () => {
    const { building } = build(base);
    const strips = building.ceilingStrips.material as MeshLambertMaterial;
    const yard = building.group.children.find((c) => c.name === "road") as Mesh;
    const yardMat = yard.material as MeshLambertMaterial;
    building.setLight(true, 1);
    expect(strips.emissiveIntensity).toBeGreaterThan(0.5);
    const day = yardMat.color.clone();
    expect(day.getHex()).toBe(SURFACES.yard);
    building.setLight(false, 0);
    expect(strips.emissiveIntensity).toBe(0);
    const night = yardMat.color.clone();
    expect(night.r).toBeLessThan(day.r * 0.5);
    building.setLight(true, 1);
    expect(yardMat.color.getHex()).toBe(day.getHex());
  });

  it("derives a World from the layout with the compiler's rules", () => {
    const layout = buildLayout(base, site);
    const world = worldFromLayout(layout);
    expect(world.frames).toHaveLength(4);
    expect(world.frames[0].inward).toEqual([0, 1]);
    expect(world.lanes[0].slots).toHaveLength(8);
    expect(world.lanes[0].slots[0]).toEqual([24 - 3, 8]);
    expect(world.stations).toHaveLength(2);
    expect(world.homes.pick).toEqual([layout.depot.x, layout.depot.y]);
    expect(world.levelHeights["P1L"]).toEqual([0, 1.5, 3, 4.5]);
    expect(world.levelHeights["R1L"]).toEqual([0, 5, 10, 15]);
    expect(world.yard.queue[0]).toHaveLength(3);
  });
});

describe("buildEnvironment", () => {
  const base = siteToSpec(site);

  it("surrounds the site with sky, ground, lot, road, dashes and a fence, and frees them", () => {
    const layout = buildLayout(base, site);
    const world = worldFromLayout(layout);
    const tracker = new ResourceTracker();
    const env = buildEnvironment(base, world, { theme: "light", tracker });
    expect(env.group.children.map((c) => c.name)).toEqual(["sky", "ground", "lot", "publicRoad", "roadDashes", "fence"]);
    expect((env.sky.geometry as SphereGeometry).parameters.radius).toBe(SKY_RADIUS);
    expect(env.sky.frustumCulled).toBe(false);
    // The lot covers the yard slab, the queue spots and the building with room to spare.
    expect(env.lot.x0).toBeLessThan(world.yard.spawnLeft[0]);
    expect(env.lot.x1).toBeGreaterThan(world.yard.spawnRight[0]);
    expect(env.lot.y0).toBeLessThan(Math.min(...Object.values(world.yard.queue).flat().map((s) => s[1])));
    expect(env.lot.y1).toBeGreaterThan(base.depthFt);
    expect(env.fog.far).toBeGreaterThan(env.fog.near);
    env.dispose();
    env.dispose();
    tracker.disposeAll();
    expect(tracker.disposed).toBe(tracker.created);
    expect(tracker.materialsDisposed).toBe(tracker.materialsCreated);
  });

  it("colours the sky and fog for the theme and the clock, darkening the ground at night", () => {
    const layout = buildLayout(base, site);
    const world = worldFromLayout(layout);
    const tracker = new ResourceTracker();
    const env = buildEnvironment(base, world, { theme: "light", tracker });
    const sky = env.sky.material as ShaderMaterial;
    const ground = env.group.children.find((c) => c.name === "ground") as Mesh;
    const groundMat = ground.material as MeshLambertMaterial;
    env.setTime(null);
    const noonTop = (sky.uniforms.top.value as Color).clone();
    const noonHorizon = (sky.uniforms.horizon.value as Color).clone();
    expect(noonTop.getHex()).toBe(THEMES.light.sky.top);
    expect(env.fog.color.getHex()).toBe(noonHorizon.getHex());
    const dayGround = groundMat.color.clone();
    env.setTime(2 * 60);
    expect((sky.uniforms.top.value as Color).getHex()).toBe(THEMES.light.night.top);
    expect(groundMat.color.r).toBeLessThan(dayGround.r * 0.5);
    // Sunrise glows warm at the horizon: more red than the noon horizon.
    env.setTime(6 * 60 + 20);
    const dawn = (sky.uniforms.horizon.value as Color).clone();
    expect(dawn.r - dawn.b).toBeGreaterThan(noonHorizon.r - noonHorizon.b);
    env.setTheme("dark");
    env.setTime(null);
    expect((sky.uniforms.top.value as Color).getHex()).toBe(THEMES.dark.sky.top);
    expect(groundMat.color.getHex()).toBe(THEMES.dark.ground);
    env.dispose();
    tracker.disposeAll();
  });
});
