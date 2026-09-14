/**
 * The renderer's contract with the page. lib/three/viewer.ts implements it;
 * components/twin/TwinScene.tsx is the only React code that calls it. Nothing
 * here imports three, so the page compiles and tests without WebGL.
 *
 * Lead-written contract.
 */

import type { Playback, WorldPayload } from "../trace/types";
import type { Process } from "../twin/types";

export type CameraMode = "orbit" | "walk" | "follow";
export type CameraPreset = "overview" | "dock" | "pick" | "reserve" | "yard";

export interface ViewerOptions {
  shadows: boolean;
  /** Tint pick faces by lines per week (the 2D SVG's heat ramp) instead of fill. */
  heat: boolean;
  labels: boolean;
  /** Sun and interior lighting follow the simulated clock. */
  dayNight: boolean;
  quality: "auto" | "high" | "low";
  theme: "light" | "dark";
  /** Tint actors whose fitted speed exceeds the engine's by more than 50%. */
  debugSpeed: boolean;
}

export const DEFAULT_VIEWER_OPTIONS: ViewerOptions = { shadows: true, heat: false, labels: true, dayNight: true, quality: "auto", theme: "light", debugSpeed: false };

export type PickResult =
  | { kind: "entity"; entity: number }
  | { kind: "face"; index: number }
  | { kind: "reserve"; index: number }
  | { kind: "door"; index: number }
  | { kind: "station"; index: number }
  | { kind: "lane"; door: number; slot: number }
  | { kind: "queue"; process: Process };

/** Screen-space anchor for a DOM label, computed by the viewer each frame. */
export interface LabelPos {
  entity: number;
  text: string;
  x: number;
  y: number;
  /** Camera distance in feet, for sorting and fading. */
  depth: number;
  visible: boolean;
}

export interface ViewerStats {
  drawCalls: number;
  triangles: number;
  frameMs: number;
  /** Actors and trucks currently shown. */
  actors: number;
}

export interface TwinViewer {
  /** Creates the WebGLRenderer and attaches pointer and keyboard listeners to the canvas. The only method that needs a DOM. */
  mount(canvas: HTMLCanvasElement): void;
  /** Rebuild the static scene (building, racks, doors, yard) for a new world. */
  setWorld(world: WorldPayload): void;
  setPlayback(pb: Playback | null): void;
  /** Sample the playback at simulated minute t and render one frame; dtRealSec drives cosmetic animation (walk cycle, wheels). */
  frame(t: number, dtRealSec: number): void;
  /** Reset every cursor for a jump in time; the next frame() re-samples everything. */
  seek(t: number): void;
  setCamera(mode: CameraMode, target?: number): void;
  preset(p: CameraPreset): void;
  /** Point the orbit camera at an engine floor position (x across, y from the dock wall), leaving walk or follow mode for orbit. */
  lookAt(x: number, y: number): void;
  setSelection(sel: PickResult | null): void;
  /** Ray-cast at normalized device coordinates. */
  pick(ndcX: number, ndcY: number): PickResult | null;
  setOptions(o: Partial<ViewerOptions>): void;
  /** Label anchors for the DOM overlay after the last frame. */
  labels(): LabelPos[];
  resize(width: number, height: number, dpr: number): void;
  stats(): ViewerStats;
  /** Disposes the renderer, controls, geometries, materials and listeners; safe to call twice. */
  dispose(): void;
}
