/**
 * Runs the digital twin off the main thread for the /twin page: the engine,
 * the trace compiler and the committed data all live in this worker chunk,
 * so a run never touches the server (the page spawns it with
 * `new Worker(new URL("./twin.worker.ts", import.meta.url), { type: "module" })`
 * like components/ImportWorkbench.tsx does for the import worker). The data
 * comes from lib/data/bundle.ts, never from lib/data/load.ts, which is what
 * keeps node:fs out of this chunk (scripts/assert-no-node-builtins.mjs
 * guards it after every build). The request loop is lib/twin-worker/run.ts,
 * which is where the tests run it.
 */

import { installBundledData } from "../lib/data/bundle";
import { dcIds } from "../lib/data/store";
import type { TwinRequest, TwinResponse } from "../lib/trace/types";
import { setContextCacheLimit } from "../lib/twin/twin";
import { runInWorker } from "../lib/twin-worker/run";

installBundledData();
// Two contexts: a seed re-run of the same scenario stays instant, and a user
// editing a field per run does not accumulate a context (with its layout and
// demand model) for every run of the session.
setContextCacheLimit(2);

const post = (m: TwinResponse, transfer?: ArrayBuffer[]) => (self as unknown as Worker).postMessage(m, transfer ?? []);

self.onmessage = (e: MessageEvent<TwinRequest>) => void runInWorker(e.data, post);

post({ type: "ready", dcs: dcIds() });
