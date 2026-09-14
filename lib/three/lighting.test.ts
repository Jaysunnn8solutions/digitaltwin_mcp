/**
 * The strip schedule follows the workers' clock-outs, the interior stays lit
 * whatever the sun does while the strips are on, and the sky model goes
 * dark at night and warm at sunrise.
 */
import { describe, expect, it } from "vitest";
import { Color } from "three";
import { ActorState, type EntityDef, type Track } from "../trace/types";
import { createLighting, FLOOR_LIGHT_TARGET, lightLevels, scheduleFromPlayback, skyAt, STRIPS_AFTER_LAST_OUT_MIN, STRIPS_MIN, STRIPS_OFF_DEFAULT_MIN, STRIPS_ON_MIN, stripsOn } from "./lighting";
import { THEMES } from "./palette";

function track(entity: number, keys: Array<[t: number, s: number]>): Track {
  const n = keys.length;
  const tr: Track = { entity, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), h: new Float32Array(n), s: new Uint8Array(n), seg: new Uint8Array(n), job: new Int32Array(n), carry: new Int32Array(n).fill(-1) };
  keys.forEach(([t, s], i) => {
    tr.t[i] = t;
    tr.s[i] = s;
  });
  return tr;
}

/** Light on an up-facing surface: the interior strips (warm white, ~1), the sky's share and the sun's vertical component. */
function onFloor(minute: number | null, strips: boolean): number {
  const L = lightLevels(minute, strips);
  return L.interior + L.sky * 0.85 + L.sun * L.dir[1];
}

describe("scheduleFromPlayback / stripsOn", () => {
  const entities: EntityDef[] = [
    { kind: "worker", id: "W1", label: "W1", colorIdx: 0, meta: {} },
    { kind: "forklift", id: "F0", label: "F0", colorIdx: 0, meta: {} },
    { kind: "worker", id: "W2", label: "W2", colorIdx: 1, meta: {} },
  ];
  const tracks = [
    // W1: day 0 06:00-14:30, day 1 06:00-16:00.
    track(0, [[0, ActorState.Off], [360, ActorState.Idle], [870, ActorState.Off], [1800, ActorState.Idle], [2400, ActorState.Off]]),
    // A forklift parked all night must not count as a clock-out.
    track(1, [[0, ActorState.Idle], [2000, ActorState.Off]]),
    // W2 leaves at 15:00 on day 0 and is still in flight at the horizon on day 1.
    track(2, [[0, ActorState.Off], [400, ActorState.Work], [900, ActorState.Off], [1900, ActorState.Work]]),
  ];
  const schedule = scheduleFromPlayback({ tracks, entities });

  it("records the last clock-out of each day plus the grace period", () => {
    expect(schedule.offByDay).toEqual([900 + STRIPS_AFTER_LAST_OUT_MIN, 960 + STRIPS_AFTER_LAST_OUT_MIN]);
  });

  it("switches the strips on at 05:30 and off after the last clock-out, with a default for unknown days", () => {
    expect(stripsOn(STRIPS_ON_MIN - 1, schedule)).toBe(false);
    expect(stripsOn(STRIPS_ON_MIN, schedule)).toBe(true);
    expect(stripsOn(929, schedule)).toBe(true);
    expect(stripsOn(930, schedule)).toBe(false);
    expect(stripsOn(1440 + 989, schedule)).toBe(true);
    expect(stripsOn(1440 + 990, schedule)).toBe(false);
    expect(stripsOn(2 * 1440 + STRIPS_OFF_DEFAULT_MIN - 1, schedule)).toBe(true);
    expect(stripsOn(2 * 1440 + STRIPS_OFF_DEFAULT_MIN, schedule)).toBe(false);
    expect(stripsOn(3 * 60, null)).toBe(false);
    expect(stripsOn(12 * 60, null)).toBe(true);
  });

  it("never lets an early clock-out switch the strips off before 06:30", () => {
    const early = scheduleFromPlayback({ tracks: [track(0, [[0, ActorState.Off], [340, ActorState.Idle], [345, ActorState.Off]])], entities });
    expect(early.offByDay[0]).toBe(345 + STRIPS_AFTER_LAST_OUT_MIN);
    expect(stripsOn(6 * 60 + 20, early)).toBe(true);
    expect(stripsOn(6 * 60 + 30, early)).toBe(false);
  });
});

describe("lightLevels", () => {
  it("holds the light on the floor near the target from shift start to the evening while the strips are on", () => {
    for (const minute of [STRIPS_ON_MIN, 6 * 60 + 30, 7 * 60, 9 * 60 + 30, 12 * 60, 15 * 60, 19 * 60, 21 * 60]) {
      const total = onFloor(minute, true);
      expect(total, `minute ${minute}`).toBeGreaterThanOrEqual(FLOOR_LIGHT_TARGET - 1e-6);
      expect(total, `minute ${minute}`).toBeLessThan(1.3);
    }
    // At 06:30 the strips supply most of it; at noon the sun and sky do, and the strips sit at their floor.
    expect(lightLevels(6 * 60 + 30, true).interior).toBeGreaterThan(0.8);
    expect(lightLevels(12 * 60, true).interior).toBe(STRIPS_MIN);
    expect(onFloor(6 * 60 + 30, true)).toBeCloseTo(FLOOR_LIGHT_TARGET, 6);
    expect(onFloor(null, true)).toBeCloseTo(onFloor(12 * 60, true), 6);
  });

  it("is dim with the strips off at night and dark-sky at 03:00", () => {
    const night = lightLevels(3 * 60, false);
    expect(night.night).toBe(true);
    expect(night.sun).toBe(0);
    expect(night.daylight).toBe(0);
    expect(onFloor(3 * 60, false)).toBeLessThan(0.4);
    // With the strips on, a night floor is as bright as a 06:30 one: the night sky's share is the only difference.
    expect(onFloor(3 * 60, true)).toBeCloseTo(FLOOR_LIGHT_TARGET, 6);
    expect(lightLevels(3 * 60, true).interior).toBeGreaterThan(0.9);
  });

  it("rises the sun in the east and sets it in the west, warm near the horizon", () => {
    const dawn = lightLevels(6 * 60 + 30, true);
    expect(dawn.dir[0]).toBeGreaterThan(0.9);
    expect(dawn.dusk).toBeGreaterThan(0.5);
    expect(dawn.night).toBe(false);
    const dusk = lightLevels(19 * 60 + 30, true);
    expect(dusk.dir[0]).toBeLessThan(-0.9);
    // Sunrise 06:00 and sunset 20:00 put the sun's peak at 13:00; 12:00 is just short of it.
    const peak = lightLevels(13 * 60, true);
    expect(peak.elev).toBeCloseTo(1, 6);
    expect(peak.dir[1]).toBeGreaterThan(0.9);
    const noon = lightLevels(12 * 60, true);
    expect(noon.elev).toBeGreaterThan(0.95);
    expect(noon.dusk).toBe(0);
    expect(noon.daylight).toBe(1);
  });
});

describe("skyAt", () => {
  const target = { top: new Color(), horizon: new Color() };

  it("is the theme's day sky at noon and its night sky at 02:00", () => {
    skyAt("light", null, target);
    expect(target.top.getHex()).toBe(THEMES.light.sky.top);
    expect(target.horizon.getHex()).toBe(THEMES.light.sky.horizon);
    skyAt("light", 2 * 60, target);
    expect(target.top.getHex()).toBe(THEMES.light.night.top);
    expect(target.horizon.getHex()).toBe(THEMES.light.night.horizon);
    skyAt("dark", null, target);
    expect(target.top.getHex()).toBe(THEMES.dark.sky.top);
  });

  it("warms the horizon at sunrise", () => {
    skyAt("light", 6 * 60 + 15, target);
    const dawn = target.horizon.clone();
    skyAt("light", 12 * 60, target);
    expect(dawn.r - dawn.b).toBeGreaterThan(target.horizon.r - target.horizon.b);
  });
});

describe("createLighting", () => {
  it("drives the sun, sky and interior lights from the clock and frees them", () => {
    const L = createLighting("light");
    L.fit(300, 200);
    const noon = L.setTime(null, true);
    expect(noon.night).toBe(false);
    expect(noon.strips).toBe(true);
    expect(L.sun.visible).toBe(true);
    expect(L.sun.intensity).toBeCloseTo(noon.sun, 6);
    expect(L.sun.intensity).toBeGreaterThan(0.45);
    expect(L.interior.intensity).toBeCloseTo(noon.interior, 6);
    const dayHemi = L.hemi.intensity;
    const night = L.setTime(23 * 60, false);
    expect(night.night).toBe(true);
    expect(L.sun.visible).toBe(false);
    expect(L.hemi.intensity).toBeLessThan(dayHemi);
    expect(L.interior.intensity).toBeCloseTo(0.18, 6);
    const lateShift = L.setTime(23 * 60, true);
    expect(L.interior.intensity).toBeCloseTo(lateShift.interior, 6);
    expect(L.interior.intensity).toBeGreaterThan(0.9);
    L.setTheme("dark");
    L.setTime(null, true);
    expect(L.hemi.intensity).toBeLessThan(dayHemi);
    L.setShadows(false);
    expect(L.sun.castShadow).toBe(false);
    L.dispose();
    expect(L.group.children).toHaveLength(0);
  });
});
