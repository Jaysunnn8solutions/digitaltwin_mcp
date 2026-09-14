/**
 * First-person walk: click the canvas for pointer lock, mouse to look, WASD
 * or arrows to move, Shift to run, E to inspect what the crosshair is on. The
 * eye is 5.5 ft up and the body a 1.5 ft circle that slides along rack runs,
 * walls and docked trailers (collide.ts). Key events are taken in the
 * capture phase and stopped only while walking, so the page's own shortcuts
 * (arrows scrub time in orbit mode) keep working the rest of the time.
 */

import { PerspectiveCamera } from "three";
import { slideCircle, type Aabb } from "./collide";

export const EYE_HEIGHT = 5.5;
export const WALK_RADIUS = 1.5;
export const WALK_SPEED = 6;
export const RUN_SPEED = 12;

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "KeyE"]);

export interface WalkOptions {
  onInspect: () => void;
  colliders: () => readonly Aabb[];
}

export class WalkController {
  active = false;
  x = 0;
  y = 0;
  yaw = 0;
  pitch = 0;
  private locked = false;
  private canvas: HTMLCanvasElement | null = null;
  private readonly keys = new Set<string>();

  private readonly onClick = () => {
    if (!this.active || !this.canvas) return;
    this.canvas.requestPointerLock?.();
  };
  private readonly onLockChange = () => {
    this.locked = !!this.canvas && document.pointerLockElement === this.canvas;
  };
  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.active || !this.locked) return;
    this.yaw -= e.movementX * 0.0025;
    this.pitch = Math.min(1.3, Math.max(-1.3, this.pitch - e.movementY * 0.0025));
  };
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.active || !MOVE_KEYS.has(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "KeyE") {
      if (!e.repeat) this.opts.onInspect();
      return;
    }
    this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private readonly onBlur = () => {
    this.keys.clear();
  };

  constructor(
    readonly camera: PerspectiveCamera,
    readonly opts: WalkOptions
  ) {}

  get pointerLocked(): boolean {
    return this.locked;
  }

  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas) return;
    this.canvas = canvas;
    canvas.addEventListener("click", this.onClick);
    document.addEventListener("pointerlockchange", this.onLockChange);
    document.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
  }

  detach(): void {
    if (!this.canvas) return;
    this.exit();
    this.canvas.removeEventListener("click", this.onClick);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    document.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    this.canvas = null;
  }

  /** Start walking at an engine position, facing yaw (camera rotation.y). */
  enter(x: number, y: number, yaw: number): void {
    this.active = true;
    const p = slideCircle(x, y, 0, 0, WALK_RADIUS, this.opts.colliders());
    this.x = p.x;
    this.y = p.y;
    this.yaw = yaw;
    this.pitch = 0;
    this.place();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    if (this.locked && typeof document !== "undefined") document.exitPointerLock?.();
  }

  private place(): void {
    this.camera.position.set(this.x, EYE_HEIGHT, -this.y);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  update(dt: number): void {
    if (!this.active) return;
    const k = this.keys;
    let fwd = 0;
    let side = 0;
    if (k.has("KeyW") || k.has("ArrowUp")) fwd += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) fwd -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) side += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) side -= 1;
    if (fwd !== 0 || side !== 0) {
      const speed = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;
      const len = Math.hypot(fwd, side);
      const step = (speed * Math.min(0.1, Math.max(0, dt))) / len;
      // Camera looks along local -Z: engine forward is (-sin yaw, cos yaw), right is (cos yaw, sin yaw).
      const dx = (-Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * side) * step;
      const dy = (Math.cos(this.yaw) * fwd + Math.sin(this.yaw) * side) * step;
      const p = slideCircle(this.x, this.y, dx, dy, WALK_RADIUS, this.opts.colliders());
      this.x = p.x;
      this.y = p.y;
    }
    this.place();
  }

  dispose(): void {
    this.detach();
  }
}
