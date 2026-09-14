/**
 * The /twin page's URL hash: which building and week to run, for how many
 * days, the seed, where the playback stands, and the scenario, compressed.
 * Shared by the page (browser) and the MCP tools (lib/tools/shared.ts, Node),
 * so a tool's "watch this run" link and the page's own history entries are
 * the same bytes and decode the same way.
 *
 * Format, keys in this order, absent ones omitted:
 *   #dc=dc-east&week=36&days=7&seed=1&t=510&cam=dock&src=session&shot=1&chrome=1&perf=1
 *    &s=<base64url(deflate(JSON.stringify(scenario)))>
 *
 * A `layout` never travels in the URL: an imported building is up to 1 MB and
 * is handed to the page in-browser instead, so the encoder refuses one and
 * the decoder drops one with a flag. The encoder also refuses a scenario
 * whose encoded form is over HASH_MAX_SCENARIO_BYTES, so links stay inside
 * every browser's URL limit. Decoding never throws: anything unreadable falls
 * back to the defaults, and unknown keys are ignored so older links keep
 * working when the page learns new ones.
 *
 * Pure: fflate and zod only, no DOM, no node: modules. Imports only
 * scenarioSchema from lib/twin/twin.ts, which is browser-safe.
 */

import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { CameraPreset } from "../three/api";
import { scenarioSchema, type TwinScenario } from "../twin/twin";

/** Where a non-built-in building came from: the /import page's sessionStorage hand-off, or a bundled sample drawing. */
export type HashSource = "session" | "sample";

export interface TwinHashState {
  dc: string;
  /** Calendar week the horizon starts on its Monday, 1..52. */
  week: number;
  /** Days to run, 1..HASH_MAX_DAYS on the page. */
  days: number;
  /** Integer ≥ 1. replicate() runs seeds 1..runs, so seed 1 is a tool's first run. */
  seed: number;
  /** Playback position, engine minutes from 00:00 of day 0. */
  t?: number;
  cam?: CameraPreset;
  src?: HashSource;
  /** Screenshot mode: a fixed frame with the chrome hidden. */
  shot?: boolean;
  /** With `shot`: keep the page chrome (top bar, HUD, side panel, timeline) so a capture shows the layout, not just the frame. */
  chrome?: boolean;
  /** Performance overlay (draw calls, triangles, frame time). */
  perf?: boolean;
  scenario?: TwinScenario;
}

/** What decodeHash returns: every required key filled from the defaults, the scenario always an object. */
export interface DecodedHash extends TwinHashState {
  scenario: TwinScenario;
  /** The scenario in the URL carried a `layout`; it was dropped and the rest kept. */
  layoutDropped: boolean;
}

export type HashDefaults = Pick<TwinHashState, "dc" | "week" | "days" | "seed">;

/** The page's defaults: Norcross, an ordinary week, one week of playback, the tools' first seed. */
export const HASH_DEFAULTS: HashDefaults = { dc: "dc-east", week: 36, days: 7, seed: 1 };

/** The page runs at most four weeks; the tools allow 56 days. */
export const HASH_MAX_DAYS = 28;
/** Cap on the encoded scenario (base64url characters, one byte each in the URL). */
export const HASH_MAX_SCENARIO_BYTES = 6 * 1024;
const MAX_WEEK = 52;
const MAX_SEED = 2 ** 31 - 1;
const MAX_DC_CHARS = 40;

/** Thrown by encodeHash for a scenario that must not go in a URL: one with a layout, or one too large. */
export class HashError extends Error {}

/**
 * Both directions of the preset list are enforced by the type: a preset
 * missing here or an extra key is a compile error, so the codec never drifts
 * from lib/three/api.ts.
 */
const CAMERA_PRESETS: Record<CameraPreset, true> = { overview: true, dock: true, pick: true, reserve: true, yard: true };
const HASH_SOURCES: Record<HashSource, true> = { session: true, sample: true };

export function encodeHash(state: TwinHashState): string {
  const p = new URLSearchParams();
  p.set("dc", state.dc);
  p.set("week", String(state.week));
  p.set("days", String(state.days));
  p.set("seed", String(state.seed));
  if (state.t !== undefined) p.set("t", String(Math.round(state.t)));
  if (state.cam !== undefined) p.set("cam", state.cam);
  if (state.src !== undefined) p.set("src", state.src);
  if (state.shot) p.set("shot", "1");
  if (state.chrome) p.set("chrome", "1");
  if (state.perf) p.set("perf", "1");
  const s = encodeScenario(state.scenario);
  if (s !== null) p.set("s", s);
  return `#${p.toString()}`;
}

export function decodeHash(hash: string, defaults: HashDefaults = HASH_DEFAULTS): DecodedHash {
  const p = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const dcRaw = p.get("dc")?.trim() ?? "";
  const dc = dcRaw.length > 0 && dcRaw.length <= MAX_DC_CHARS ? dcRaw : defaults.dc;
  const week = int(p.get("week"), defaults.week, 1, MAX_WEEK);
  const days = int(p.get("days"), defaults.days, 1, HASH_MAX_DAYS);
  const seed = int(p.get("seed"), defaults.seed, 1, MAX_SEED);
  const out: DecodedHash = { dc, week, days, seed, ...decodeScenario(p.get("s")) };
  const t = p.get("t");
  if (t !== null && Number.isFinite(Number(t))) out.t = Math.min(days * 1440, Math.max(0, Number(t)));
  const cam = p.get("cam");
  if (cam !== null && Object.hasOwn(CAMERA_PRESETS, cam)) out.cam = cam as CameraPreset;
  const src = p.get("src");
  if (src !== null && Object.hasOwn(HASH_SOURCES, src)) out.src = src as HashSource;
  if (flag(p.get("shot"))) out.shot = true;
  if (flag(p.get("chrome"))) out.chrome = true;
  if (flag(p.get("perf"))) out.perf = true;
  return out;
}

/** The base64url form of a scenario, or null for an empty one. Exposed so a page can show the link size before writing it. */
export function encodeScenario(scenario: TwinScenario | undefined): string | null {
  if (!scenario) return null;
  if (scenario.layout !== undefined) throw new HashError("An imported layout never travels in the URL; hand it to the page in the browser instead.");
  const json = JSON.stringify(scenario);
  if (json === "{}") return null;
  const encoded = toBase64Url(deflateSync(strToU8(json), { level: 9 }));
  if (encoded.length > HASH_MAX_SCENARIO_BYTES) {
    throw new HashError(`The scenario encodes to ${encoded.length} bytes, over the ${HASH_MAX_SCENARIO_BYTES}-byte limit for a link.`);
  }
  return encoded;
}

/**
 * Cap on the inflated scenario JSON. The encoder never emits more than
 * HASH_MAX_SCENARIO_BYTES of deflate, and a real scenario inflates to a few
 * kilobytes; a crafted link could inflate to gigabytes (a 260 KB link holds
 * 190 MB of zeros), so the decoder refuses oversized input before inflating
 * and inflates into a fixed buffer with one spare byte as the overflow
 * sentinel (fflate truncates silently when the buffer is full).
 */
export const HASH_MAX_INFLATED_BYTES = 256 * 1024;

function decodeScenario(raw: string | null): { scenario: TwinScenario; layoutDropped: boolean } {
  if (!raw) return { scenario: {}, layoutDropped: false };
  if (raw.length > HASH_MAX_SCENARIO_BYTES) return { scenario: {}, layoutDropped: false };
  let parsed: unknown;
  try {
    const out = inflateSync(fromBase64Url(raw), { out: new Uint8Array(HASH_MAX_INFLATED_BYTES + 1) });
    if (out.length > HASH_MAX_INFLATED_BYTES) return { scenario: {}, layoutDropped: false };
    parsed = JSON.parse(strFromU8(out));
  } catch {
    return { scenario: {}, layoutDropped: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { scenario: {}, layoutDropped: false };
  const { layout, ...rest } = parsed as Record<string, unknown>;
  const layoutDropped = layout !== undefined;
  const res = scenarioSchema.safeParse(rest);
  return { scenario: res.success ? res.data : {}, layoutDropped };
}

/** An integer in [min, max]: clamped when out of range, the fallback when not a number. */
function int(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function flag(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

// ---------------------------------------------------------------------------
// base64url, hand-rolled so Node and the browser produce identical strings
// without going through binary strings (btoa) or Buffer.
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function toBase64Url(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(B64[n >> 18], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]);
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    parts.push(B64[n >> 18], B64[(n >> 12) & 63]);
    if (i + 1 < bytes.length) parts.push(B64[(n >> 6) & 63]);
  }
  return parts.join("");
}

function fromBase64Url(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (const ch of s) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) throw new HashError("Not base64url.");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}
