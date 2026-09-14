/**
 * The twin worker's request loop, written against a `post` callback instead
 * of the worker globals so it runs unchanged under vitest on Node;
 * components/twin.worker.ts is the thin shell that wires self.onmessage to it.
 *
 * One `run` request answers with progress messages (`context`, then one
 * `simulate` per horizon day as the engine starts it, then `compile`) and a
 * single `done` or `error`. Progress `day` is 0 for the context phase, the
 * 1-based day being simulated during `simulate` (so (day − 1) / days is the
 * share finished) and `days` for compile. Nothing is kept between requests
 * except buildTwin's own context cache. Every typed array of the playback is
 * handed to postMessage as a transferable, so the keyframes move instead of
 * being copied; the caller must not touch the playback after posting.
 *
 * Errors cross postMessage as `{ name, message }` because Error subclasses
 * lose their class: the names the page branches on are pinned by instanceof
 * checks here rather than read off the constructor, which a minifier may
 * rename.
 */

import { ZodError } from "zod";
import { DataNotLoadedError, UnknownIdError } from "../data/store";
import { LimitError } from "../layout/limits";
import { collectBuffers, compilePlayback } from "../trace/compile";
import { RecordingTracer, type RunSpec, type TraceEvent, type TwinRequest, type TwinResponse } from "../trace/types";
import { buildWorld } from "../trace/world";
import { runOperations } from "../twin/operations";
import { kpis } from "../twin/replicate";
import { buildTwin, operationsOptions, scenarioSchema, type TwinScenario } from "../twin/twin";
import { buildWorldPayload, workerInfos } from "./payload";

/** The page's horizon cap (the tools allow 56): keeps run → first frame inside its budget. */
export const PAGE_MAX_DAYS = 28;

/** Posted as error name "Unsupported": candystore-mcp allows no cross-origin fetch, so live store scenarios stay on the server. */
export const CANDYSTORE_UNSUPPORTED = "Store-network scenarios run through the MCP tools; the 3D page uses the committed network.";

export type PostMessageFn = (m: TwinResponse, transfer?: ArrayBuffer[]) => void;

/** A request the page should never send: rejected before any work starts. */
export class UnsupportedError extends Error {}

/** Records the events and reports each simulated day as the engine reaches it. */
class ProgressTracer extends RecordingTracer {
  constructor(
    private readonly days: number,
    private readonly post: PostMessageFn,
    private readonly runId: string
  ) {
    super();
  }

  override emit(e: TraceEvent): void {
    super.emit(e);
    if (e.k === "day") this.post({ type: "progress", runId: this.runId, phase: "simulate", day: e.day + 1, days: this.days });
  }
}

function validate(spec: RunSpec): TwinScenario {
  const scenario = scenarioSchema.parse(spec.scenario);
  if (scenario.candystore) throw new UnsupportedError(CANDYSTORE_UNSUPPORTED);
  if (!Number.isInteger(spec.days) || spec.days < 1 || spec.days > PAGE_MAX_DAYS) throw new RangeError(`days must be a whole number from 1 to ${PAGE_MAX_DAYS} on the 3D page (got ${spec.days}).`);
  if (!Number.isInteger(spec.seed) || spec.seed < 1) throw new RangeError(`seed must be a whole number of at least 1 (got ${spec.seed}).`);
  if (!Number.isInteger(spec.startWeek) || spec.startWeek < 1 || spec.startWeek > 52) throw new RangeError(`startWeek must be a whole number from 1 to 52 (got ${spec.startWeek}).`);
  return scenario;
}

function errorName(err: unknown): string {
  if (err instanceof UnsupportedError) return "Unsupported";
  if (err instanceof UnknownIdError) return "UnknownIdError";
  if (err instanceof LimitError) return "LimitError";
  if (err instanceof DataNotLoadedError) return "DataNotLoadedError";
  if (err instanceof Error) return err.constructor.name || err.name || "Error";
  return "Error";
}

/** Issues named in the banner; one edit on an imported building can fail every rack run, and the page shows the rest per field. */
export const BANNER_ISSUES = 5;

function errorResponse(runId: string, err: unknown): TwinResponse {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
    const shown = issues.slice(0, BANNER_ISSUES).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
    const more = issues.length - shown.length;
    const message = `Invalid scenario: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
    return { type: "error", runId, name: "ZodError", message, issues };
  }
  return { type: "error", runId, name: errorName(err), message: err instanceof Error ? err.message : String(err) };
}

/** Answer one worker request through `post`; never throws. */
export async function runInWorker(req: TwinRequest, post: PostMessageFn): Promise<void> {
  if (req.type === "ping") {
    post({ type: "pong" });
    return;
  }
  const { runId, spec, keepEvents } = req;
  try {
    const scenario = validate(spec);
    const { dc, startWeek, days, seed } = spec;
    post({ type: "progress", runId, phase: "context", day: 0, days });
    const t0 = performance.now();
    const ctx = await buildTwin(dc, startWeek, scenario);
    // operationsOptions applies the run-time scenario fields (inboundLatenessSdMin)
    // and stays inside the same try as buildTwin, so any future rejection there
    // is posted as an error too.
    const opts = operationsOptions(ctx, days, seed);
    const t1 = performance.now();
    const tracer = new ProgressTracer(days, post, runId);
    const result = runOperations(ctx, opts, tracer);
    const t2 = performance.now();
    post({ type: "progress", runId, phase: "compile", day: days, days });
    const world = buildWorld(ctx.layout, workerInfos(ctx.workers, ctx.costs));
    const payload = buildWorldPayload(ctx, world);
    const playback = compilePlayback({ events: tracer.events, layout: ctx.layout, world, skus: payload.skus, slotting: payload.slotting, suppliers: payload.suppliers, opts: { keepEvents } });
    const t3 = performance.now();
    post({ type: "done", runId, result, kpis: kpis(result), playback, world: payload, ms: { context: t1 - t0, simulate: t2 - t1, compile: t3 - t2 } }, collectBuffers(playback));
  } catch (err) {
    post(errorResponse(runId, err));
  }
}
