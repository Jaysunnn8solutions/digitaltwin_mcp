/**
 * The world outside the building, so an overview reads as a place rather
 * than a model floating in black: a gradient sky dome that follows the
 * camera, fog that fades the ground into the dome's horizon, an open ground
 * plane, an asphalt lot around the site that continues the yard slab, the
 * public road running off to the horizon with its dashes, a chain-link fence
 * on the three sides away from the road and four light poles. Six draw
 * calls, one texture-free shader. Everything follows the theme (sky, ground,
 * lot, fence) and the clock (sky colours, exterior light level); the building
 * itself does not, see palette.ts.
 *
 * The dome is a back-faced sphere of SKY_RADIUS around the camera, coloured
 * in the fragment shader from the horizon colour up to the zenith colour, and
 * the same horizon colour is the fog colour, so the ground plane, which ends
 * well inside the dome, dissolves into it without a seam.
 */

import { BackSide, BufferGeometry, Camera, Color, Float32BufferAttribute, Fog, Group, LineBasicMaterial, LineSegments, Mesh, MeshLambertMaterial, PlaneGeometry, ShaderMaterial, SphereGeometry } from "three";
import type { LayoutSpec } from "../layout/spec";
import type { World } from "../trace/types";
import { BoxBatch, ResourceTracker } from "./geometry";
import { lightLevels, skyAt } from "./lighting";
import { darken, THEMES, type ThemeName } from "./palette";

/** Inside the camera's far plane (5000) wherever the orbit limits let it go. */
export const SKY_RADIUS = 2500;
const GROUND_SIZE = 9000;
const ROAD_HALF_WIDTH = 16;
const FENCE_POST_FT = 12;
const FENCE_HEIGHT = 6;
const POLE_HEIGHT = 22;

export interface EnvironmentOptions {
  theme: ThemeName;
  tracker: ResourceTracker;
}

export interface Environment {
  group: Group;
  sky: Mesh;
  fog: Fog;
  /** Lot rectangle in engine feet, for framing the yard presets. */
  lot: { x0: number; x1: number; y0: number; y1: number };
  setTheme(theme: ThemeName): void;
  /** Recolour sky, fog and ground for a minute of day (null = noon). */
  setTime(minuteOfDay: number | null): void;
  /** Keep the dome centred on the camera; call before rendering. */
  follow(camera: Camera): void;
  dispose(): void;
}

const SKY_VERTEX = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = `
uniform vec3 top;
uniform vec3 horizon;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, 0.0, 1.0);
  gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);
  #include <colorspace_fragment>
}`;

export function buildEnvironment(spec: LayoutSpec, world: World, opts: EnvironmentOptions): Environment {
  const { tracker } = opts;
  let themeName = opts.theme;
  const group = new Group();
  group.name = "environment";
  const W = spec.widthFt;
  const D = spec.depthFt;
  const yard = world.yard;
  const roadY = yard.roadY;

  // Sky dome.
  const skyMat = tracker.material(
    new ShaderMaterial({
      uniforms: { top: { value: new Color(0x6ea6dc) }, horizon: { value: new Color(0xdde7ee) } },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
    })
  );
  const sky = new Mesh(tracker.geometry(new SphereGeometry(SKY_RADIUS, 24, 12)), skyMat);
  sky.name = "sky";
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  group.add(sky);

  // Ground far beyond the site, then the lot (asphalt) around the yard and the building.
  const groundMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].ground }));
  const ground = new Mesh(tracker.geometry(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2).translate(W / 2, -0.12, -D / 2)), groundMat);
  ground.name = "ground";
  ground.receiveShadow = true;
  group.add(ground);

  let queueMin = roadY;
  for (const spots of Object.values(yard.queue)) for (const s of spots) queueMin = Math.min(queueMin, s[1]);
  const lot = { x0: Math.min(yard.spawnLeft[0], 0) - 60, x1: Math.max(yard.spawnRight[0], W) + 60, y0: Math.min(roadY - 40, queueMin - 30), y1: D + 40 };
  const lotMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].lot }));
  const lotMesh = new Mesh(tracker.geometry(new PlaneGeometry(lot.x1 - lot.x0, lot.y1 - lot.y0).rotateX(-Math.PI / 2).translate((lot.x0 + lot.x1) / 2, -0.08, -(lot.y0 + lot.y1) / 2)), lotMat);
  lotMesh.name = "lot";
  lotMesh.receiveShadow = true;
  group.add(lotMesh);

  // The public road, across the whole ground, with dashes outside the yard slab.
  const roadMat = tracker.material(new MeshLambertMaterial({ color: darken(THEMES[themeName].lot, 0.8) }));
  const road = new Mesh(tracker.geometry(new PlaneGeometry(GROUND_SIZE, ROAD_HALF_WIDTH * 2).rotateX(-Math.PI / 2).translate(W / 2, -0.06, -roadY)), roadMat);
  road.name = "publicRoad";
  road.receiveShadow = true;
  group.add(road);
  const dashes: number[] = [];
  const slabX0 = Math.min(yard.spawnLeft[0], 0) - 20;
  const slabX1 = Math.max(yard.spawnRight[0], W) + 20;
  for (let x = slabX1 + 10; x < W / 2 + GROUND_SIZE / 2; x += 16) dashes.push(x, -0.04, -roadY, x + 8, -0.04, -roadY);
  for (let x = slabX0 - 10; x > W / 2 - GROUND_SIZE / 2; x -= 16) dashes.push(x, -0.04, -roadY, x - 8, -0.04, -roadY);
  const dashGeom = new BufferGeometry();
  dashGeom.setAttribute("position", new Float32BufferAttribute(dashes, 3));
  dashGeom.computeBoundingSphere();
  const markMat = tracker.material(new LineBasicMaterial({ color: 0xf1f0ea }));
  const marks = new LineSegments(tracker.geometry(dashGeom), markMat);
  marks.name = "roadDashes";
  group.add(marks);

  // Fence on the sides and the back (the front is the road), plus light poles.
  const fence = new BoxBatch();
  const run = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const angle = Math.atan2(by - ay, bx - ax);
    const n = Math.max(1, Math.round(len / FENCE_POST_FT));
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      fence.add(0.35, FENCE_HEIGHT, 0.35, ax + (bx - ax) * s, FENCE_HEIGHT / 2, -(ay + (by - ay) * s));
    }
    fence.add(len, 0.15, 0.15, (ax + bx) / 2, FENCE_HEIGHT - 0.1, -(ay + by) / 2, angle);
    fence.add(len, 0.15, 0.15, (ax + bx) / 2, FENCE_HEIGHT / 2, -(ay + by) / 2, angle);
  };
  const fenceY0 = roadY + ROAD_HALF_WIDTH + 6;
  run(lot.x0, fenceY0, lot.x0, lot.y1);
  run(lot.x1, fenceY0, lot.x1, lot.y1);
  run(lot.x0, lot.y1, lot.x1, lot.y1);
  for (const [px, py] of [
    [slabX0 + 6, roadY + 26],
    [slabX1 - 6, roadY + 26],
    [slabX0 + 6, D + 20],
    [slabX1 - 6, D + 20],
  ]) {
    fence.add(0.7, POLE_HEIGHT, 0.7, px, POLE_HEIGHT / 2, -py);
    fence.add(3.5, 0.7, 1.2, px, POLE_HEIGHT, -py);
  }
  const fenceMat = tracker.material(new MeshLambertMaterial({ color: THEMES[themeName].fence }));
  const fenceMesh = new Mesh(tracker.geometry(fence.build()), fenceMat);
  fenceMesh.name = "fence";
  group.add(fenceMesh);

  const size = Math.max(W, D + 60);
  const fog = new Fog(0xdde7ee, size * 1.6, size * 7);
  const colors = { top: new Color(), horizon: new Color() };
  const base = new Color();
  const tint = (mat: MeshLambertMaterial | LineBasicMaterial, hex: number, k: number) => mat.color.copy(base.setHex(hex)).multiplyScalar(k);

  const setTime = (minute: number | null) => {
    const t = THEMES[themeName];
    skyAt(themeName, minute, colors);
    (skyMat.uniforms.top.value as Color).copy(colors.top);
    (skyMat.uniforms.horizon.value as Color).copy(colors.horizon);
    fog.color.copy(colors.horizon);
    // Outside, the strips do not reach: the ground darkens with the sky.
    const k = 0.3 + 0.7 * lightLevels(minute, true).daylight;
    tint(groundMat, t.ground, k);
    tint(lotMat, t.lot, k);
    tint(roadMat, darken(t.lot, 0.8), k);
    tint(fenceMat, t.fence, k);
    tint(markMat, 0xf1f0ea, 0.5 + 0.5 * k);
  };
  setTime(null);

  let disposed = false;
  return {
    group,
    sky,
    fog,
    lot,
    setTheme(name) {
      themeName = name;
    },
    setTime,
    follow(camera) {
      sky.position.copy(camera.position);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
    },
  };
}
