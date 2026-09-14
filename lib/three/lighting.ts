/**
 * Lights and the sky model. The building has no roof (the camera looks into
 * it), so its interior is lit by three things: an "interior" hemisphere light
 * standing in for the ceiling strips, a sky hemisphere light and one
 * directional sun with a 2048 shadow map fitted to the building plus the yard.
 *
 * The strips are on from STRIPS_ON_MIN (05:30) until STRIPS_AFTER_LAST_OUT_MIN
 * after the last worker clocks out that day (scheduleFromPlayback reads the
 * clock-outs from the worker tracks); while they are on, the interior light
 * is set each frame so that the light landing on the floor stays about the
 * same whatever the sun does, which is what keeps a 06:30 shift start as
 * readable as noon. dayNight only moves the sun, recolours the sky and adds
 * a subtle warmth inside at dawn and dusk. With dayNight off everything is
 * fixed at noon.
 *
 * lightLevels, skyAt and the schedule are pure functions, tested under Node.
 */

import { Color, DirectionalLight, Group, HemisphereLight, Vector3 } from "three";
import { ActorState, type Playback } from "../trace/types";
import { SURFACES, THEMES, type ThemeName } from "./palette";

const SUNRISE = 6 * 60;
const SUNSET = 20 * 60;
const NOON = 12 * 60;
const DAY_SKY_LIGHT = new Color(0xcfe3ff);
const NIGHT_SKY_LIGHT = new Color(0x2b3550);
const SUN_NOON = new Color(0xfff6e8);
const SUN_LOW = new Color(0xffb070);
const STRIP_WHITE = new Color(0xfff3dd);

/** Ceiling strips come on at 05:30. */
export const STRIPS_ON_MIN = 5 * 60 + 30;
/** ... and go off this long after the last clock-out of the day. */
export const STRIPS_AFTER_LAST_OUT_MIN = 30;
/** A day with no clock-out on record (no workers, or the horizon cut the day) keeps the strips on until 22:00. */
export const STRIPS_OFF_DEFAULT_MIN = 22 * 60;
/** Light the strips hold on an up-facing surface (sum of interior, the sky's share and the sun's vertical component). */
export const FLOOR_LIGHT_TARGET = 1.05;
/**
 * three r155+ feeds a light's bare intensity to the shader and Lambert's
 * BRDF divides by π, so intensity 1 lights an up-facing surface to only 1/π
 * of its albedo. lightLevels works in floor units (1 = the surface shows its
 * full colour); the three lights get the levels times this.
 */
export const LIGHT_SCALE = Math.PI;
/** The least the strips give while on, so a noon floor is a little brighter than a 06:30 one rather than identical. */
export const STRIPS_MIN = 0.3;

export interface LightSchedule {
  /** Minute of day the strips go off, per simulated day; -1 where no clock-out is known. */
  offByDay: number[];
}

/** The last clock-out per day, read from the worker tracks: an Off keyframe that follows a non-Off one. */
export function scheduleFromPlayback(pb: Pick<Playback, "tracks" | "entities">): LightSchedule {
  const offByDay: number[] = [];
  for (const tr of pb.tracks) {
    if (!tr || pb.entities[tr.entity]?.kind !== "worker") continue;
    const n = tr.t.length;
    for (let i = 1; i < n; i++) {
      if (tr.s[i] !== ActorState.Off || tr.s[i - 1] === ActorState.Off) continue;
      const day = Math.floor(tr.t[i] / 1440);
      const out = Math.min(1439, tr.t[i] - day * 1440 + STRIPS_AFTER_LAST_OUT_MIN);
      while (offByDay.length <= day) offByDay.push(-1);
      offByDay[day] = Math.max(offByDay[day], out);
    }
  }
  return { offByDay };
}

/** Whether the ceiling strips are on at simulated minute t. */
export function stripsOn(t: number, schedule: LightSchedule | null): boolean {
  const day = Math.floor(t / 1440);
  const m = t - day * 1440;
  const known = schedule?.offByDay[day] ?? -1;
  const off = known >= 0 ? Math.max(known, STRIPS_ON_MIN + 60) : STRIPS_OFF_DEFAULT_MIN;
  return m >= STRIPS_ON_MIN && m < off;
}

export interface LightLevels {
  /** Sun elevation 0..1 (sin of its arc), 0 at night. */
  elev: number;
  /** Exterior light level 0..1: 0 at night, 1 from mid-morning to mid-afternoon. */
  daylight: number;
  /** Warm horizon glow 0..1 around sunrise and sunset. */
  dusk: number;
  night: boolean;
  /** Intensities. */
  sun: number;
  sky: number;
  interior: number;
  /** Unit sun direction in three's frame (x east, y up, z south). */
  dir: [number, number, number];
}

const _dir = new Vector3();

/** Light intensities for a minute of day (null = fixed noon) and a strip state. */
export function lightLevels(minute: number | null, strips: boolean): LightLevels {
  const m = minute === null ? NOON : ((minute % 1440) + 1440) % 1440;
  const f = (m - SUNRISE) / (SUNSET - SUNRISE);
  const up = f > 0 && f < 1;
  const elev = up ? Math.sin(Math.PI * f) : 0;
  const night = elev < 0.05;
  const daylight = Math.min(1, elev * 2.5);
  const dusk = up ? Math.max(0, 1 - elev / 0.3) : 0;
  _dir.set(Math.cos(Math.PI * f), Math.max(0.05, elev), 0.35).normalize();
  const sun = night ? 0 : 0.5 * Math.pow(elev, 0.6);
  const sky = 0.12 + 0.38 * daylight;
  // The strips hold the light on an up-facing surface near FLOOR_LIGHT_TARGET by filling in what the sky and sun do not supply.
  const interior = strips ? Math.min(1, Math.max(STRIPS_MIN, FLOOR_LIGHT_TARGET - sky * 0.85 - sun * _dir.y)) : 0.18;
  return { elev, daylight, dusk, night, sun, sky, interior, dir: [_dir.x, _dir.y, _dir.z] };
}

export interface SkyColors {
  top: Color;
  horizon: Color;
}

const _c = new Color();

/** Sky dome colours for a theme at a minute of day (null = noon); writes into `target`. */
export function skyAt(theme: ThemeName, minute: number | null, target: SkyColors): SkyColors {
  const t = THEMES[theme];
  const L = lightLevels(minute, true);
  target.top.setHex(t.night.top).lerp(_c.setHex(t.sky.top), L.daylight);
  target.horizon.setHex(t.night.horizon).lerp(_c.setHex(t.sky.horizon), L.daylight);
  if (L.dusk > 0) target.horizon.lerp(_c.setHex(t.dusk), L.dusk * 0.65);
  return target;
}

export interface LightState extends LightLevels {
  strips: boolean;
}

export interface Lighting {
  group: Group;
  hemi: HemisphereLight;
  sun: DirectionalLight;
  interior: HemisphereLight;
  /** Fit the shadow frustum to a building of w × d feet plus the yard. */
  fit(w: number, d: number): void;
  /** Minute of day (0..1440) to follow the clock, or null for fixed noon; whether the strips are on. */
  setTime(minuteOfDay: number | null, strips: boolean): LightState;
  setShadows(on: boolean): void;
  setTheme(theme: ThemeName): void;
  dispose(): void;
}

export function createLighting(theme: ThemeName): Lighting {
  const group = new Group();
  group.name = "lighting";
  let themeName = theme;
  const hemi = new HemisphereLight(DAY_SKY_LIGHT, SURFACES.bounce, 0.5);
  hemi.name = "sky";
  const interior = new HemisphereLight(STRIP_WHITE, SURFACES.bounce, 0.3);
  interior.name = "interior";
  const sun = new DirectionalLight(0xffffff, 0.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  group.add(hemi, interior, sun, sun.target);
  let centre = new Vector3(100, 0, -100);
  let radius = 200;

  const setTime = (minute: number | null, strips: boolean): LightState => {
    const L = lightLevels(minute, strips);
    sun.position.copy(centre).addScaledVector(_dir.set(L.dir[0], L.dir[1], L.dir[2]), radius * 2);
    sun.intensity = L.sun * LIGHT_SCALE;
    sun.color.lerpColors(SUN_LOW, SUN_NOON, Math.min(1, L.elev * 1.6));
    sun.visible = !L.night;
    // A dark theme's sky is dusk-like even at noon, so its sky light is dimmer.
    hemi.intensity = L.sky * LIGHT_SCALE * (themeName === "dark" ? 0.55 : 1);
    hemi.color.lerpColors(NIGHT_SKY_LIGHT, DAY_SKY_LIGHT, L.daylight);
    interior.intensity = L.interior * LIGHT_SCALE;
    interior.color.copy(STRIP_WHITE).lerp(SUN_LOW, L.dusk * 0.2);
    return { ...L, strips };
  };

  const fit = (w: number, d: number) => {
    centre = new Vector3(w / 2, 0, -d / 2 + 30);
    radius = Math.hypot(w, d + 60) / 2 + 20;
    const cam = sun.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = radius * 4;
    cam.updateProjectionMatrix();
    sun.target.position.copy(centre);
    sun.target.updateMatrixWorld();
    setTime(null, true);
  };

  fit(200, 200);

  return {
    group,
    hemi,
    sun,
    interior,
    fit,
    setTime,
    setShadows(on) {
      sun.castShadow = on;
    },
    setTheme(name) {
      themeName = name;
    },
    dispose() {
      sun.dispose();
      hemi.dispose();
      interior.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
