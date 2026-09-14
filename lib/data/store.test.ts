/**
 * The data seam: the pure store, the Node provider registered by load.ts, the
 * JSON bundle the browser worker installs, and the scenario extension hooks
 * wired into buildTwin. The setup file (vitest.setup.ts) has already
 * registered the fs provider in this file's module registry, so the tests
 * that need an empty store use vi.resetModules() and dynamic imports.
 */
import { describe, expect, it, vi } from "vitest";
import { UnknownIdError as UnknownIdErrorFromLoad } from "./load";
import { loadCatalog, loadRoster, UnknownIdError } from "./store";
import { NO_DISRUPTIONS, runOperations } from "../twin/operations";
import { EXTENSION_KEYS, type ExtensionScenario } from "../twin/scenario-ext";
import { DEFAULT_STANDARDS } from "../twin/standards";
import { buildTwin, operationsOptions, scenarioSchema, scenarioShape } from "../twin/twin";

/** A fresh module registry: a store with nothing registered, the bundle and the engine on top of it. */
async function freshModules() {
  vi.resetModules();
  const store = await import("./store");
  const bundle = await import("./bundle");
  const twin = await import("../twin/twin");
  const operations = await import("../twin/operations");
  return { store, bundle, twin, operations };
}

describe("store", () => {
  it("throws DataNotLoadedError until something registers the data", async () => {
    vi.resetModules();
    const store = await import("./store");
    expect(store.hasData()).toBe(false);
    expect(() => store.loadSites()).toThrow(store.DataNotLoadedError);
    expect(() => store.findSite("dc-east")).toThrow(/not loaded/);
  });

  it("serves the bundle after setData and bumps the data version", async () => {
    const { store, bundle } = await freshModules();
    const before = store.dataVersion();
    store.setData(bundle.BUNDLE);
    expect(store.hasData()).toBe(true);
    expect(store.loadSites()).toHaveLength(2);
    expect(store.dcIds()).toEqual(["dc-west", "dc-east"]);
    expect(store.loadManifest().counts.dcs).toBe(2);
    expect(store.dataVersion()).toBe(before + 1);
    store.setData(bundle.BUNDLE);
    expect(store.dataVersion()).toBe(before + 2);
  });

  it("exports one UnknownIdError from load.ts and store.ts, so instanceof checks keep working", () => {
    expect(UnknownIdErrorFromLoad).toBe(UnknownIdError);
    expect(new UnknownIdErrorFromLoad("x")).toBeInstanceOf(UnknownIdError);
  });

  it("registers the fs provider lazily, so mcp/stdio.ts can set TWIN_DATA_DIR after its imports", async () => {
    const dataDir = process.env.TWIN_DATA_DIR;
    expect(dataDir).toBeTruthy();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/nowhere");
    try {
      vi.resetModules();
      delete process.env.TWIN_DATA_DIR;
      // Import with no override and a useless cwd: an eager reader would throw here.
      const load = await import("./load");
      expect(load.hasData()).toBe(true);
      process.env.TWIN_DATA_DIR = dataDir;
      expect(load.loadSites().map((s) => s.id)).toEqual(["dc-west", "dc-east"]);
    } finally {
      process.env.TWIN_DATA_DIR = dataDir;
      cwd.mockRestore();
    }
  });
});

describe("bundle", () => {
  it("runs the engine on the bundled JSON with results identical to the fs provider", async () => {
    const ctxFs = await buildTwin("dc-east", 36, {});
    const a = runOperations(ctxFs, operationsOptions(ctxFs, 7, 5));

    const { store, bundle, twin, operations } = await freshModules();
    // The engine graph must not pull lib/data/load in: nothing is registered until setData.
    expect(store.hasData()).toBe(false);
    store.setData(bundle.BUNDLE);
    const ctxBundle = await twin.buildTwin("dc-east", 36, {});
    const b = operations.runOperations(ctxBundle, twin.operationsOptions(ctxBundle, 7, 5));

    expect(b).toEqual(a);
    expect(ctxBundle.changes).toEqual([]);
    expect(ctxBundle.workers.map((w) => w.id)).toEqual(ctxFs.workers.map((w) => w.id));
  });

  it("keys the context cache on the data version, so a second setData never serves a stale context", async () => {
    const { store, bundle, twin } = await freshModules();
    store.setData(bundle.BUNDLE);
    const first = await twin.buildTwin("dc-west", 36, {});
    expect(await twin.buildTwin("dc-west", 36, {})).toBe(first);
    store.setData(bundle.BUNDLE);
    expect(await twin.buildTwin("dc-west", 36, {})).not.toBe(first);
  });
});

describe("scenario extensions", () => {
  /** One valid value per extension field, accepted by zod, so what happens next is the hook's doing. */
  const samples: { [K in keyof ExtensionScenario]-?: NonNullable<ExtensionScenario[K]> } = {
    shifts: [{ id: "day", start: "06:00", end: "14:30", breakMin: 30, indirectMin: 30 }],
    operatingDays: [1, 2, 3, 4, 5],
    times: { orderRelease: "17:00" },
    deliveryDays: { general: [1, 3, 5] },
    workerOverrides: [{ worker: "W-E-001", productivity: 1.1 }],
    standards: { pickPerLine: 0.5 },
    supplierOverrides: [{ supplier: "SUP-IMP-LATAM", leadDays: 20 }],
    inboundLatenessSdMin: 15,
    rackZones: { pick: { aisles: 5 } },
  };

  it("accepts every extension field in the shared scenario schema", () => {
    for (const key of EXTENSION_KEYS) expect(scenarioShape).toHaveProperty(key);
    expect(scenarioSchema.parse(samples)).toEqual(samples);
    expect(() => scenarioSchema.parse({ shifts: [] })).toThrow();
    expect(() => scenarioSchema.parse({ times: { lunch: "12:00" } })).toThrow();
  });

  it("applies each extension field now that the hooks are implemented", async () => {
    expect(EXTENSION_KEYS.length).toBe(9);
    for (const key of EXTENSION_KEYS) {
      // inboundLatenessSdMin is applied by operationsOptions, the rest by buildTwin.
      const ctx = await buildTwin("dc-east", 36, { [key]: samples[key] });
      expect(() => operationsOptions(ctx, 7, 1), key).not.toThrow();
    }
    // The shifts/operatingDays/times/deliveryDays/rackZones samples restate
    // dc-east's own values, so only the overrides below leave an old → new note.
    expect((await buildTwin("dc-east", 36, { workerOverrides: samples.workerOverrides })).changes).toEqual(["W-E-001 productivity 1.01 → 1.1"]);
    expect((await buildTwin("dc-east", 36, { supplierOverrides: samples.supplierOverrides })).changes).toEqual(["SUP-IMP-LATAM lead days 31 → 20"]);
    expect((await buildTwin("dc-east", 36, { standards: samples.standards })).changes).toEqual(["standards: pickPerLine 0.35 → 0.5"]);
    expect(operationsOptions(await buildTwin("dc-east", 36, { inboundLatenessSdMin: 15 }), 7, 1).disruptions.inboundLatenessSdMin).toBe(15);
  });

  it("leaves a scenario without extension fields exactly as before", async () => {
    const ctx = await buildTwin("dc-east", 36, { forklifts: 3, slotting: "optimized" });
    expect(ctx.changes).toEqual(["forklifts 2 → 3", "optimized slotting"]);
    expect(ctx.std).toBe(DEFAULT_STANDARDS);
    expect(ctx.catalog).toBe(loadCatalog());
    expect(ctx.workers).toEqual(loadRoster().workers.filter((w) => w.dc === "dc-east"));
    expect(operationsOptions(ctx, 7, 1)).toEqual({ days: 7, seed: 1, flex: true, overtimeMaxHours: 2, disruptions: NO_DISRUPTIONS, warmupWeeks: 8 });

    const base = await buildTwin("dc-west", 36, {});
    expect(base.changes).toEqual([]);
    const r1 = runOperations(base, operationsOptions(base, 7, 5));
    const r2 = runOperations(base, operationsOptions(base, 7, 5));
    expect(r2).toEqual(r1);
  });
});
