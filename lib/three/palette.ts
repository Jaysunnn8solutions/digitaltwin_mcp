/**
 * Colours for the 3D twin. The scene keeps the 2D floor plan's vocabulary
 * (lib/render/floor.ts: pick blue-grey, reserve tan, mixed lilac, inbound
 * green, outbound orange) so someone who has looked at the SVG recognises the
 * building.
 *
 * Two kinds of colour live here. SURFACES are the building and everything in
 * it: concrete, steel, paint, trailers and skin, the same in both UI themes,
 * because a warehouse does not change colour when the page's chrome does and
 * the readability of fill ramps and role tints depends on a stable ground.
 * THEMES are only the world outside and the stage: sky, ground, lot and
 * fence, which follow the theme so a dark page gets a dusk sky rather than a
 * bright blue one.
 *
 * Values are 0xRRGGBB for Color.setHex; the ramps write into a caller-owned
 * Color so the per-frame loops in apply.ts allocate nothing.
 */

import { Color } from "three";
import type { ViewerOptions } from "./api";

export type ThemeName = ViewerOptions["theme"];

export interface Theme {
  /** Stage colour before the first frame; app/twin/twin.css mirrors it. */
  background: number;
  /** Sky dome at noon: zenith and horizon (the horizon is also the fog colour). */
  sky: { top: number; horizon: number };
  /** Sky dome at night. */
  night: { top: number; horizon: number };
  /** Warm horizon tint blended in at sunrise and sunset. */
  dusk: number;
  /** Open ground beyond the lot (dry grass). */
  ground: number;
  /** Asphalt: the lot around the site and the public road. */
  lot: number;
  /** Fence posts and rails, light poles. */
  fence: number;
}

export const THEMES: Record<ThemeName, Theme> = {
  light: {
    background: 0xe9eef3,
    sky: { top: 0x6ea6dc, horizon: 0xdde7ee },
    night: { top: 0x0a1120, horizon: 0x243044 },
    dusk: 0xf1b57e,
    ground: 0xa4ae87,
    lot: 0x6d6e70,
    fence: 0x8b9099,
  },
  dark: {
    background: 0x15171b,
    sky: { top: 0x1a2231, horizon: 0x3c4756 },
    night: { top: 0x05080e, horizon: 0x141a26 },
    dusk: 0x7d5238,
    ground: 0x2c3128,
    lot: 0x25272b,
    fence: 0x4a5058,
  },
};

/** Interior and site surfaces, theme-independent. */
export const SURFACES = {
  /** Sealed concrete slab. */
  floor: 0xc6c2b8,
  grid: 0xb8b4aa,
  wall: 0xd9d5cb,
  zone: 0xd1cdc4,
  staging: 0xe3d3c7,
  aisle: 0x8f98a3,
  /** Yard slab between the road and the dock wall. */
  yard: 0x8d8d88,
  roadMark: 0xf1f0ea,
  laneMark: 0xa89f8d,
  station: 0xd9480f,
  stationBusy: 0xff8a3d,
  entrance: 0x6d6a63,
  ceilingStrip: 0xf4f2ea,
  /** Painted floor markings (corridors, station outlines, stalls, the dock hatch). */
  paint: 0xe0b20c,
  /** Rubber dock bumpers. */
  bumper: 0x2a2a2a,
  /** Door number plate on the wall and its lettering. */
  plate: 0xf6f4ee,
  plateText: "#1f2328",
  /** Rack steel per run use. */
  rack: { pick: 0x8fa5b8, reserve: 0xbfb6a3, mixed: 0xb1a7c6 },
  deck: 0xd0d8e0,
  trailer: 0xf2f2ef,
  steel: 0x6f7883,
  skin: 0xe8c4a0,
  body: 0x3b4252,
  /** Hemisphere ground bounce inside the building. */
  bounce: 0x7a746a,
} as const;

/** Door kinds, same as the floor plan. */
export const DOOR_COLORS = { inbound: 0x2f9e44, outbound: 0xd9480f } as const;

/**
 * Worker roles by EntityDef.colorIdx. The compiler numbers roles in roster
 * order; anything past the list wraps, so a big scenario still tints.
 */
export const ROLE_COLORS = [0x1c7ed6, 0xf08c00, 0x2f9e44, 0x9c36b5, 0xe8590c, 0x0ca678, 0xc2255c, 0x5f3dc4];

/** Pallet categories by EntityDef.colorIdx: traditional first, then the seven specialty segments. */
export const CATEGORY_COLORS = [0x8b5e3c, 0xe64980, 0x15aabf, 0xfab005, 0x7950f2, 0x40c057, 0xf76707, 0x228be6];

export const STATE_COLORS = {
  late: 0xe03131,
  overtime: 0xf5c518,
  hot: 0xff922b,
  outage: 0x868e96,
  absent: 0xadb5bd,
  break: 0x4dabf7,
  indirect: 0x91a7ff,
  wait: 0x9aa5b1,
  lift: 0x20c997,
  selection: 0xffd43b,
  fast: 0xf03e9e,
  sticker: 0xffe066,
  lampOff: 0x343a40,
} as const;

export function roleColor(idx: number): number {
  return ROLE_COLORS[((idx % ROLE_COLORS.length) + ROLE_COLORS.length) % ROLE_COLORS.length];
}

export function categoryColor(idx: number): number {
  return CATEGORY_COLORS[((idx % CATEGORY_COLORS.length) + CATEGORY_COLORS.length) % CATEGORY_COLORS.length];
}

const RED = new Color(0xe03131);
const AMBER = new Color(0xf59f00);
const GREEN = new Color(0x2f9e44);

/**
 * Face fill ramp: green when stocked, amber at one case or less (a picker
 * will short it soon), red when empty. Written into `target`.
 */
export function fillColor(target: Color, inners: number, cap: number, innersPerCase: number): Color {
  if (inners <= 0) return target.copy(RED);
  const oneCase = Math.max(1, innersPerCase);
  if (inners <= oneCase) return target.copy(AMBER);
  const f = Math.min(1, (inners - oneCase) / Math.max(1, cap - oneCase));
  return target.lerpColors(AMBER, GREEN, f);
}

const HEAT_STOPS = [
  [237, 244, 250],
  [158, 202, 225],
  [66, 146, 198],
  [8, 81, 156],
  [8, 48, 107],
];

/** The floor plan's five-stop blue ramp, t in [0, 1]. Written into `target`. */
export function heatColor(target: Color, t: number): Color {
  const x = Math.max(0, Math.min(1, t)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = HEAT_STOPS[i];
  const b = HEAT_STOPS[i + 1];
  return target.setRGB((a[0] + (b[0] - a[0]) * f) / 255, (a[1] + (b[1] - a[1]) * f) / 255, (a[2] + (b[2] - a[2]) * f) / 255);
}

/** Darken a hex colour by a factor in (0, 1], for "off" lamps and idle pads. */
export function darken(hex: number, factor: number): number {
  const r = Math.round(((hex >> 16) & 255) * factor);
  const g = Math.round(((hex >> 8) & 255) * factor);
  const b = Math.round((hex & 255) * factor);
  return (r << 16) | (g << 8) | b;
}
