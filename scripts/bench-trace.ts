/**
 * What the tracer hooks cost: 20 × 28-day dc-east runs, untraced and traced,
 * interleaved seed by seed so both paths see the same machine state.
 *   npx tsx scripts/bench-trace.ts
 *
 * Informational, not CI: timings depend on the machine. BASELINE_MS is the
 * untraced median measured with this same script on the code before the
 * hooks went in (same machine, same command); BENCH_BASELINE_MS overrides it
 * with a fresh number. The untraced median must stay within 3% of the
 * baseline, which is the budget the design gives the disabled-tracer path
 * (one null check per hook, no argument objects built).
 */
import { performance } from "node:perf_hooks";
import "../lib/data/load";
import { RecordingTracer } from "../lib/trace/types";
import { runOperations } from "../lib/twin/operations";
import { buildTwin, operationsOptions } from "../lib/twin/twin";

const RUNS = 20;
const DAYS = 28;
const DC = "dc-east";
const START_WEEK = 36;
const WARMUP = 5;
const MAX_OVERHEAD = 0.03;
/**
 * Untraced median before instrumentation, ms per run, on the machine this was
 * last committed from (two runs: 44.9 and 43.6, so run-to-run noise is itself
 * about 3%). 0 = not recorded.
 */
const BASELINE_MS = 44.2;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const ms = (x: number): string => `${x.toFixed(1)} ms`;
const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

const ctx = await buildTwin(DC, START_WEEK, {});
const opts = (seed: number) => operationsOptions(ctx, DAYS, seed);

// Both paths warm, so neither is measured with a cold JIT.
for (let i = 1; i <= WARMUP; i++) {
  runOperations(ctx, opts(i));
  runOperations(ctx, opts(i), new RecordingTracer());
}

const untraced: number[] = [];
const traced: number[] = [];
let events = 0;
let jobs = 0;
for (let seed = 1; seed <= RUNS; seed++) {
  let t0 = performance.now();
  runOperations(ctx, opts(seed));
  untraced.push(performance.now() - t0);

  const tracer = new RecordingTracer();
  t0 = performance.now();
  runOperations(ctx, opts(seed), tracer);
  traced.push(performance.now() - t0);
  events += tracer.events.length;
  jobs += tracer.events.filter((e) => e.k === "jobQueued").length;
}

const baseline = Number(process.env.BENCH_BASELINE_MS) || BASELINE_MS;
const uMed = median(untraced);
const tMed = median(traced);
console.log(`bench-trace: ${DC}, ${DAYS} days, ${RUNS} runs (seeds 1-${RUNS}), node ${process.version}`);
console.log(`untraced  median ${ms(uMed)}  mean ${ms(mean(untraced))}  min ${ms(Math.min(...untraced))}`);
console.log(
  `traced    median ${ms(tMed)}  mean ${ms(mean(traced))}  min ${ms(Math.min(...traced))}  ${pct(tMed / uMed - 1)} vs untraced  ` +
    `events/run ${Math.round(events / RUNS).toLocaleString("en-US")} (${jobs ? (events / jobs).toFixed(2) : "n/a"} per job, ${Math.round(jobs / RUNS).toLocaleString("en-US")} jobs/run)`
);
if (baseline > 0) {
  const overhead = uMed / baseline - 1;
  const ok = overhead < MAX_OVERHEAD;
  console.log(`baseline  ${ms(baseline)} untraced before instrumentation  ->  untraced now ${pct(overhead)}  ${ok ? "PASS" : "FAIL"} (limit ${pct(MAX_OVERHEAD)})`);
  if (!ok) process.exitCode = 1;
} else {
  console.log(`baseline  none recorded: put ${uMed.toFixed(1)} in BASELINE_MS before instrumenting, or pass BENCH_BASELINE_MS.`);
}
