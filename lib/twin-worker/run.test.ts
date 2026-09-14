/**
 * The worker's request loop under Node: the message sequence, the engine
 * numbers matching a direct run, the transfer list, every rejection the page
 * can trigger, and the payload's plain data. The fs data provider comes from
 * vitest.setup.ts, so this is the same data the bundled worker inlines.
 */

import { describe, expect, it } from "vitest";
import { importLayout } from "../layout/import";
import { sampleCsv } from "../layout/samples";
import { workerInfos as fixtureWorkerInfos } from "../trace/fixtures";
import type { RunSpec, TraceInit, TwinRequest, TwinResponse } from "../trace/types";
import { buildWorld } from "../trace/world";
import { runOperations } from "../twin/operations";
import { kpis } from "../twin/replicate";
import { buildTwin, operationsOptions, type TwinScenario } from "../twin/twin";
import { buildWorldPayload, workerInfos } from "./payload";
import { CANDYSTORE_UNSUPPORTED, PAGE_MAX_DAYS, runInWorker } from "./run";

type Msg<T extends TwinResponse["type"]> = Extract<TwinResponse, { type: T }>;

interface Posted {
  messages: TwinResponse[];
  /** The transfer list of each message, parallel to messages. */
  transfers: ArrayBuffer[][];
}

async function send(req: TwinRequest): Promise<Posted> {
  const out: Posted = { messages: [], transfers: [] };
  await runInWorker(req, (m, transfer) => {
    out.messages.push(m);
    out.transfers.push(transfer ?? []);
  });
  return out;
}

function runRequest(spec: Partial<RunSpec>, keepEvents = true, runId = "r1"): TwinRequest {
  return { type: "run", runId, keepEvents, spec: { dc: "dc-east", startWeek: 36, days: 3, seed: 5, scenario: {}, ...spec } };
}

function last<T extends TwinResponse["type"]>(p: Posted, type: T): Msg<T> {
  const m = p.messages[p.messages.length - 1];
  expect(m.type).toBe(type);
  return m as Msg<T>;
}

/** Every typed array reachable from a value (no cycles in a message, but guard anyway). */
function viewsIn(value: unknown, out: ArrayBufferView[] = [], seen = new Set<object>()): ArrayBufferView[] {
  if (typeof value !== "object" || value === null || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    out.push(value);
    return out;
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) viewsIn(v, out, seen);
  return out;
}

describe("runInWorker", () => {
  it("answers ping with pong", async () => {
    const p = await send({ type: "ping" });
    expect(p.messages).toEqual([{ type: "pong" }]);
    expect(p.transfers).toEqual([[]]);
  });

  it("posts context → one simulate per day → compile → done, with the engine's own numbers", async () => {
    const days = 3;
    const seed = 5;
    const p = await send(runRequest({ dc: "dc-east", days, seed }, true, "run-a"));
    expect(p.messages.map((m) => m.type)).toEqual(["progress", ...Array.from({ length: days }, () => "progress"), "progress", "done"]);
    const progress = p.messages.filter((m): m is Msg<"progress"> => m.type === "progress");
    expect(progress.map((m) => [m.phase, m.day, m.days])).toEqual([["context", 0, days], ...Array.from({ length: days }, (_, i) => ["simulate", i + 1, days]), ["compile", days, days]]);
    for (const m of p.messages) expect((m as { runId?: string }).runId).toBe("run-a");

    const done = last(p, "done");
    const ctx = await buildTwin("dc-east", 36, {});
    const direct = runOperations(ctx, operationsOptions(ctx, days, seed));
    expect(done.result).toEqual(direct);
    expect(done.kpis).toEqual(kpis(direct));
    expect(done.ms.context).toBeGreaterThanOrEqual(0);
    expect(done.ms.simulate).toBeGreaterThanOrEqual(0);
    expect(done.ms.compile).toBeGreaterThanOrEqual(0);

    // The playback carries the recorded stream and its meta names the run.
    expect(done.playback.meta).toMatchObject({ dc: "dc-east", startWeek: 36, days, seed, horizonEnd: days * 1440 });
    const init = done.playback.events[0] as TraceInit;
    expect(init.k).toBe("init");
    expect(done.playback.events[done.playback.events.length - 1]).toEqual({ k: "end", t: days * 1440 });
    expect(done.playback.events.filter((e) => e.k === "day")).toHaveLength(days);

    // The world was built from the same effective workers the engine traced (and P3's helper agrees).
    expect(done.world.workers).toEqual(init.workers);
    expect(done.world.workers).toEqual(fixtureWorkerInfos(ctx.workers, ctx.costs));
    expect(done.world.changes).toEqual([]);
  });

  it("transfers every buffer of the playback exactly once, and the message survives the transfer", async () => {
    const p = await send(runRequest({ dc: "dc-west", days: 2, seed: 3 }));
    const done = last(p, "done");
    const transfer = p.transfers[p.transfers.length - 1];
    expect(transfer.length).toBeGreaterThan(0);
    expect(new Set(transfer).size).toBe(transfer.length);
    const views = viewsIn(done.playback);
    const buffers = new Set(views.map((v) => v.buffer as ArrayBuffer));
    expect(buffers.size).toBe(transfer.length);
    for (const b of transfer) expect(buffers.has(b)).toBe(true);
    // Nothing outside the playback owns a buffer (result, kpis and the payload are plain data).
    expect(viewsIn(done.result)).toEqual([]);
    expect(viewsIn(done.world)).toEqual([]);

    const lengths = views.map((v) => v.byteLength);
    const clone = structuredClone(done, { transfer });
    expect(viewsIn(clone.playback).map((v) => v.byteLength)).toEqual(lengths);
    expect(views.every((v) => v.byteLength === 0)).toBe(true);
    expect(clone.playback.tracks.length).toBe(done.playback.tracks.length);
    expect(clone.playback.jobs.length).toBe(done.playback.jobs.length);
    expect(clone.world.layout.pick.length).toBe(done.world.layout.pick.length);
  });

  it("drops the raw events when keepEvents is false", async () => {
    const p = await send(runRequest({ dc: "dc-west", days: 1, seed: 1 }, false));
    const done = last(p, "done");
    expect(done.playback.events).toEqual([]);
    expect(done.playback.jobs.length).toBeGreaterThan(0);
  });

  it("rejects a candystore scenario as Unsupported before doing any work", async () => {
    const scenario: TwinScenario = { candystore: { add: [{ type: "general", lon: -84.4, lat: 33.8 }] } };
    const p = await send(runRequest({ scenario }));
    expect(p.messages).toEqual([{ type: "error", runId: "r1", name: "Unsupported", message: CANDYSTORE_UNSUPPORTED }]);
    // Even an empty candystore block: the page never carries the field.
    const empty = await send(runRequest({ scenario: { candystore: {} } }));
    expect(last(empty, "error").name).toBe("Unsupported");
  });

  it("posts UnknownIdError for an unknown center, after the context progress", async () => {
    const p = await send(runRequest({ dc: "dc-north" }));
    expect(p.messages.map((m) => m.type)).toEqual(["progress", "error"]);
    const err = last(p, "error");
    expect(err.name).toBe("UnknownIdError");
    expect(err.message).toContain("dc-north");
    expect(err.issues).toBeUndefined();
  });

  it("rejects a horizon outside 1..28 days, a bad seed and a bad week without starting", async () => {
    const long = await send(runRequest({ days: 40 }));
    expect(long.messages).toHaveLength(1);
    const err = last(long, "error");
    expect(err.name).toBe("RangeError");
    expect(err.message).toContain(String(PAGE_MAX_DAYS));
    expect(last(await send(runRequest({ days: 0 })), "error").name).toBe("RangeError");
    expect(last(await send(runRequest({ days: 2.5 })), "error").name).toBe("RangeError");
    expect(last(await send(runRequest({ seed: 0 })), "error").name).toBe("RangeError");
    expect(last(await send(runRequest({ startWeek: 53 })), "error").name).toBe("RangeError");
    expect(last(await send(runRequest({ days: PAGE_MAX_DAYS, seed: 1 })), "done").playback.meta.days).toBe(PAGE_MAX_DAYS);
  });

  it("posts a ZodError with issue paths for a scenario the schema refuses", async () => {
    const scenario = { demandScale: 99, bogus: true } as unknown as TwinScenario;
    const p = await send(runRequest({ scenario }));
    expect(p.messages).toHaveLength(1);
    const err = last(p, "error");
    expect(err.name).toBe("ZodError");
    expect(err.issues?.map((i) => i.path).sort()).toEqual(["", "demandScale"]);
    expect(err.message).toContain("demandScale");
  });

  it("applies a run-time scenario field (inboundLatenessSdMin) like the tools do", async () => {
    const scenario: TwinScenario = { inboundLatenessSdMin: 15 };
    const p = await send(runRequest({ scenario }));
    const done = last(p, "done");
    const ctx = await buildTwin("dc-east", 36, scenario);
    const opts = operationsOptions(ctx, 3, 5);
    expect(opts.disruptions.inboundLatenessSdMin).toBe(15);
    expect(done.result).toEqual(runOperations(ctx, opts));
  });

  it("runs an imported layout (the CSV sample) like the tools do", async () => {
    const csv = await importLayout({ fileName: "locations.csv", text: sampleCsv() }, {}, "inline");
    const scenario: TwinScenario = { layout: csv.spec };
    const p = await send(runRequest({ dc: "dc-east", days: 2, seed: 7, scenario }));
    const done = last(p, "done");
    const ctx = await buildTwin("dc-east", 36, scenario);
    expect(done.result).toEqual(runOperations(ctx, operationsOptions(ctx, 2, 7)));
    expect(done.playback.meta.layoutName).toBe(csv.spec.name);
    expect(done.world.spec).toEqual(csv.spec);
    expect(done.world.layout.pick).toHaveLength(480);
    expect(done.world.changes[0]).toContain("imported layout");
  });
});

describe("buildWorldPayload", () => {
  it("lifts the plain data the page needs out of the context", async () => {
    const ctx = await buildTwin("dc-west", 36, { forklifts: 3 });
    const world = buildWorld(ctx.layout, workerInfos(ctx.workers, ctx.costs));
    const payload = buildWorldPayload(ctx, world);

    expect(payload.layout).toBe(ctx.layout);
    expect(payload.spec).toBe(ctx.layout.spec);
    expect(payload.world).toBe(world);
    expect(payload.changes).toEqual(["forklifts 1 → 3"]);
    expect(payload.changes).not.toBe(ctx.changes);

    expect(payload.slotting).toEqual([...ctx.slotting].map(([sku, loc]) => [sku, loc.id]));
    expect(payload.skus.map((s) => s.id)).toEqual(ctx.catalog.skus.map((s) => s.id));
    expect(payload.skus[0]).toEqual({
      id: ctx.catalog.skus[0].id,
      name: ctx.catalog.skus[0].name,
      category: ctx.catalog.skus[0].category,
      supplier: ctx.catalog.skus[0].supplier,
      innersPerCase: ctx.catalog.skus[0].innersPerCase,
      casesPerPallet: ctx.catalog.skus[0].casesPerPallet,
      innerCubeFt: ctx.catalog.skus[0].innerCubeFt,
      innerRetail: ctx.catalog.skus[0].innerRetail,
    });
    expect(payload.suppliers).toEqual(ctx.catalog.suppliers.map((s) => ({ id: s.id, name: s.name, kind: s.kind, leadDays: s.leadDays, leadSdDays: s.leadSdDays, orderDay: s.orderDay })));

    const dc = ctx.network.dcs.find((d) => d.id === "dc-west")!;
    expect(payload.dc).toEqual({ id: dc.id, name: dc.name, lon: dc.lon, lat: dc.lat });

    // The stores this center serves, with the site's delivery days for their type.
    expect(payload.stores.map((s) => s.id)).toEqual(ctx.network.stores.filter((s) => s.dc === "dc-west").map((s) => s.id));
    expect(payload.stores.length).toBeGreaterThan(0);
    for (const s of payload.stores) {
      expect(s.deliveryDays).toEqual(s.type === "specialty" ? ctx.site.deliveryDays.specialty : ctx.site.deliveryDays.general);
      expect(s.deliveryDays).not.toBe(ctx.site.deliveryDays[s.type]);
    }

    expect(payload.workers).toEqual(fixtureWorkerInfos(ctx.workers, ctx.costs));

    // Plain data only: a structured clone round-trips it.
    expect(structuredClone(payload)).toEqual(payload);
  });

  it("reports temps at their effective productivity and rate, as the init event does", async () => {
    const ctx = await buildTwin("dc-east", 36, { addWorkers: [{ role: "selector", shift: "day", type: "temp", count: 1 }] });
    const temp = workerInfos(ctx.workers, ctx.costs).find((w) => w.type === "temp")!;
    expect(temp.productivity).toBeCloseTo(ctx.costs.tempProductivity, 12);
    expect(temp.hourlyRate).toBe(ctx.costs.tempHourly);
    expect(temp.overtimeMultiplier).toBe(1);
    const regular = workerInfos(ctx.workers, ctx.costs).find((w) => w.type === "full-time")!;
    expect(regular.overtimeMultiplier).toBe(ctx.costs.overtimeMultiplier);
  });
});
