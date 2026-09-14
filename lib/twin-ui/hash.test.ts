/**
 * The hash codec is the contract between the MCP tools' "watch this run"
 * links and the /twin page, so these tests pin the format: a round trip is
 * lossless, a layout never gets through, oversized scenarios are refused,
 * and anything unreadable decodes to the defaults rather than throwing.
 */
import { deflateSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { TwinScenario } from "../twin/twin";
import { SITE_URL, twinLink, twinUrl } from "../tools/shared";
import { decodeHash, encodeHash, encodeScenario, HASH_DEFAULTS, HASH_MAX_DAYS, HASH_MAX_SCENARIO_BYTES, HashError } from "./hash";

const outages: TwinScenario = {
  demandScale: 1.3,
  demandShocks: [{ fromDay: 3, toDay: 9, factor: 2.5, category: "traditional" }],
  slotting: "optimized",
  forecast: "trailing",
  serviceLevel: 0.95,
  supplierDelays: [{ fromDay: 0, toDay: 20, category: "specialty:latam", extraDays: 14 }],
  absenteeism: 0.1,
  doorOutages: [
    { fromDay: 0, toDay: 2, kind: "inbound", count: 1 },
    { fromDay: 5, toDay: 6, kind: "outbound", count: 2 },
  ],
  forkliftOutages: [
    { fromDay: 1, toDay: 1, count: 1 },
    { fromDay: 8, toDay: 12, count: 2 },
  ],
  wmsOutages: [
    { day: 1, start: "07:00", hours: 3 },
    { day: 4, start: "09:30", hours: 0.5 },
  ],
  workerLeave: [{ fromDay: 0, toDay: 4, role: "Forklift operator" }],
  addWorkers: [{ role: "selector", shift: "day", type: "temp", count: 2 }],
  removeWorkers: ["W-E-004"],
  crossTrain: [{ role: "Order selector", skill: "forklift" }],
  flex: false,
  overtimeMaxHours: 3,
  forklifts: 2,
  palletJacks: 4,
  inboundDoors: 3,
  outboundDoors: 3,
  faceCases: 5,
  targetUtilization: 0.9,
};

/** Deterministic noise that deflate cannot compress, to overflow the link cap with a schema-shaped object. */
function noisyIds(n: number): string[] {
  let x = 12345;
  const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: n }, () => Array.from({ length: 12 }, () => alphabet[next() % alphabet.length]).join(""));
}

describe("encodeHash / decodeHash", () => {
  it("round-trips every key, scenario arrays of outages included", () => {
    const state = { dc: "dc-west", week: 44, days: 14, seed: 3, t: 510, cam: "dock" as const, src: "session" as const, shot: true, chrome: true, perf: true, scenario: outages };
    const hash = encodeHash(state);
    expect(hash.startsWith("#dc=dc-west&week=44&days=14&seed=3&t=510&cam=dock&src=session&shot=1&chrome=1&perf=1&s=")).toBe(true);
    expect(hash).toMatch(/^#[A-Za-z0-9=&_.:-]*$/);
    const back = decodeHash(hash);
    expect(back).toEqual({ ...state, layoutDropped: false });
    expect(back.scenario.doorOutages).toHaveLength(2);
    expect(back.scenario.wmsOutages?.[1]).toEqual({ day: 4, start: "09:30", hours: 0.5 });
  });

  it("omits absent optional keys and an empty scenario", () => {
    const hash = encodeHash({ dc: "dc-east", week: 36, days: 7, seed: 1 });
    expect(hash).toBe("#dc=dc-east&week=36&days=7&seed=1");
    expect(encodeHash({ dc: "dc-east", week: 36, days: 7, seed: 1, scenario: {}, shot: false, chrome: false, perf: false })).toBe(hash);
    expect(decodeHash(hash)).toEqual({ dc: "dc-east", week: 36, days: 7, seed: 1, scenario: {}, layoutDropped: false });
  });

  it("keeps the chrome flag independent of shot, so a layout capture is shot=1&chrome=1", () => {
    expect(decodeHash("#shot=1&chrome=1")).toMatchObject({ shot: true, chrome: true });
    expect(decodeHash("#shot=1")).not.toHaveProperty("chrome");
    expect(decodeHash("#chrome=true")).toMatchObject({ chrome: true });
    expect(decodeHash("#chrome=0")).not.toHaveProperty("chrome");
    expect(encodeHash({ dc: "dc-east", week: 36, days: 7, seed: 1, shot: true, chrome: true })).toBe("#dc=dc-east&week=36&days=7&seed=1&shot=1&chrome=1");
  });

  it("is deterministic: the same state encodes to the same bytes", () => {
    const a = encodeHash({ dc: "dc-east", week: 36, days: 7, seed: 1, scenario: outages });
    const b = encodeHash({ dc: "dc-east", week: 36, days: 7, seed: 1, scenario: JSON.parse(JSON.stringify(outages)) });
    expect(a).toBe(b);
  });

  it("refuses to encode a layout", () => {
    const layout = { version: 1, name: "x", source: { format: "dxf", notes: [] }, widthFt: 100, depthFt: 100, outline: [], walls: [], zones: [], racks: [], doors: [], aisleWidthFt: 10 };
    expect(() => encodeHash({ dc: "dc-east", week: 36, days: 7, seed: 1, scenario: { layout } as unknown as TwinScenario })).toThrow(HashError);
    expect(() => encodeScenario({ forklifts: 2, layout } as unknown as TwinScenario)).toThrow(/layout/);
  });

  it("drops a smuggled layout with the flag set and keeps the rest", () => {
    // The encoder refuses a layout, so the payload is built the way the codec compresses, outside it.
    const b64 = encodeScenarioRaw(JSON.stringify({ forklifts: 2, layout: { version: 1, name: "x" } }));
    const back = decodeHash(`#dc=dc-west&week=40&days=3&seed=2&s=${b64}`);
    expect(back.layoutDropped).toBe(true);
    expect(back.scenario).toEqual({ forklifts: 2 });
    expect(back.dc).toBe("dc-west");
    // With the layout gone the rest must still validate; when it does not, the scenario is empty but the flag stays.
    const bad = decodeHash(`#s=${encodeScenarioRaw(JSON.stringify({ forklifts: 99, layout: {} }))}`);
    expect(bad).toMatchObject({ scenario: {}, layoutDropped: true });
  });

  it("enforces the encoded-size cap", () => {
    const big = { removeWorkers: noisyIds(900) } as unknown as TwinScenario;
    expect(() => encodeHash({ dc: "dc-east", week: 36, days: 7, seed: 1, scenario: big })).toThrow(HashError);
    expect(() => encodeScenario(big)).toThrow(new RegExp(`${HASH_MAX_SCENARIO_BYTES}`));
    const fits = { removeWorkers: noisyIds(40) } as unknown as TwinScenario;
    expect(encodeScenario(fits)!.length).toBeLessThan(HASH_MAX_SCENARIO_BYTES);
  });

  it("decodes garbage to the defaults without throwing", () => {
    const expected = { ...HASH_DEFAULTS, scenario: {}, layoutDropped: false };
    expect(decodeHash("")).toEqual(expected);
    expect(decodeHash("#")).toEqual(expected);
    expect(decodeHash("#garbage")).toEqual(expected);
    expect(decodeHash("#dc=&week=abc&days=NaN&seed=&s=!!!not-base64!!!")).toEqual(expected);
    // Valid base64url that is not a deflate stream.
    expect(decodeHash("#s=AAAAAAAA").scenario).toEqual({});
    // A deflate stream of JSON that is not an object.
    expect(decodeHash(`#s=${encodeScenarioRaw("[1,2,3]")}`).scenario).toEqual({});
    // A scenario that fails the schema (out of range) is dropped whole.
    expect(decodeHash(`#s=${encodeScenarioRaw(JSON.stringify({ demandScale: 99 }))}`).scenario).toEqual({});
    // A dc longer than the schema allows.
    expect(decodeHash(`#dc=${"x".repeat(41)}`).dc).toBe(HASH_DEFAULTS.dc);
  });

  it("clamps numbers into range and ignores unknown keys and bad enums", () => {
    const back = decodeHash("#dc=dc-west&week=99&days=400&seed=-5&t=-10&cam=moon&src=ftp&shot=maybe&perf=true&foo=bar&week2=3");
    expect(back).toEqual({ dc: "dc-west", week: 52, days: HASH_MAX_DAYS, seed: 1, t: 0, perf: true, scenario: {}, layoutDropped: false });
    expect(decodeHash("#days=2&t=99999").t).toBe(2 * 1440);
    expect(decodeHash("#week=0.4&days=7.6").week).toBe(1);
    expect(decodeHash("#week=0.4&days=7.6").days).toBe(8);
  });

  it("accepts custom defaults", () => {
    expect(decodeHash("#seed=4", { dc: "dc-west", week: 10, days: 3, seed: 1 })).toEqual({ dc: "dc-west", week: 10, days: 3, seed: 4, scenario: {}, layoutDropped: false });
  });
});

describe("twinUrl / twinLink", () => {
  it("links a tool run to the page with seed 1 and the scenario", () => {
    const url = twinUrl("dc-east", 43, 7, { forklifts: 2 });
    expect(url).toBe(`${SITE_URL}/twin${encodeHash({ dc: "dc-east", week: 43, days: 7, seed: 1, scenario: { forklifts: 2 } })}`);
    expect(url).toContain("/twin#");
    const back = decodeHash(url!.slice(url!.indexOf("#")));
    expect(back).toMatchObject({ dc: "dc-east", week: 43, days: 7, seed: 1, scenario: { forklifts: 2 } });
    expect(twinLink("dc-east", 43, 7, { forklifts: 2 })).toBe(`Watch this run in 3D (seed 1 replays exactly): ${url}`);
  });

  it("caps the page horizon and says so", () => {
    const url = twinUrl("dc-east", 36, 56, {});
    expect(decodeHash(url!.slice(url!.indexOf("#"))).days).toBe(HASH_MAX_DAYS);
    expect(twinLink("dc-east", 36, 56, {})).toContain(`first ${HASH_MAX_DAYS} days`);
  });

  it("sends imported buildings to /import and candystore scenarios nowhere", () => {
    const layout = { version: 1 } as unknown as TwinScenario["layout"];
    expect(twinUrl("dc-east", 36, 7, { layout })).toBeNull();
    expect(twinLink("dc-east", 36, 7, { layout })).toBe(`For an imported building, open ${SITE_URL}/import, import the drawing and use Open in 3D.`);
    expect(twinLink("dc-east", 36, 7, { candystore: { add: [{ type: "general", lon: -84, lat: 33 }] } })).not.toContain("/twin#");
  });
});

/** Compress arbitrary JSON text the way the codec does, for payloads the encoder refuses to build. Node's base64url must agree with the codec's own. */
function encodeScenarioRaw(json: string): string {
  return Buffer.from(deflateSync(strToU8(json), { level: 9 })).toString("base64url");
}
