"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TwinRequest, TwinResponse } from "@/lib/trace/types";
import { DEFAULT_LEVERS, LEVERS, OBJECTIVES, OPTIMIZE_LIMITS, type LeverKey, type Objective, type OptimizeProgress, type OptimizeResult } from "@/lib/twin/optimize";
import type { TwinScenario } from "@/lib/twin/twin";
import { money, num, pct } from "@/lib/twin-ui/format";
import { ASSUMPTION_META, assumptionsLegend, BUDGET_KEYS, BUDGETS, buildSpec, costRows, defaultInputs, estimateFor, estimateText, kpiRows, leverRange, leversByArea, remainingMs, resetPenalties, searchLegend, type OptimizeBase, type OptimizeInputs } from "@/lib/twin-ui/optimize-ui";
import { keepFocus } from "./focus";
import { NumField, SelectField } from "./ScenarioPanel";

export interface Props {
  /** The operation as the Scenario tab and the run row describe it now; null with `baseError` when it cannot be built. */
  base: OptimizeBase | null;
  baseError: string | null;
  /** The building's display name, for the result's header. */
  building: string;
  /** Load a plan's scenario into the form, and run it when asked. */
  onApply: (scenario: TwinScenario, run: boolean) => void;
}

type Phase = { kind: "idle" } | { kind: "running"; runId: string; progress: OptimizeProgress | null; estimateMs: number } | { kind: "error"; name: string; message: string };

interface Done {
  result: OptimizeResult;
  label: string;
  /** The base scenario as it was searched, to notice edits since. */
  baseJson: string;
}

const INTRO = "Searches crew, cross-training, overtime, slotting, face sizes, equipment, doors, service level and departure time for the cheapest weekly plan, with late trucks and cut orders priced as costs. Nothing leaves your browser.";
const STORE_NETWORK = "Store-network scenarios run through the MCP tools; the 3D page optimizes the committed network.";
const OBJECTIVE_OPTIONS = (Object.keys(OBJECTIVES) as Objective[]).map((k) => ({ value: k, label: OBJECTIVES[k].label }));
const GROUPS = leversByArea();

/**
 * The Optimize tab: the genetic optimizer (lib/twin/optimize.ts) over the
 * scenario the form describes, run in a second twin worker of its own so the
 * playback's worker stays free, with the best plan against the base and the
 * buttons that load a plan into the Scenario tab.
 */
export default function OptimizePanel({ base, baseError, building, onApply }: Props) {
  const [inputs, setInputs] = useState<OptimizeInputs>(() => ({ ...defaultInputs(), levers: [...DEFAULT_LEVERS] }));
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [done, setDone] = useState<Done | null>(null);
  /** Index into result.top of the plan the table and the buttons act on; 0 is the best. */
  const [chosen, setChosen] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef("");
  const pending = useRef<{ label: string; baseJson: string } | null>(null);

  const check = useMemo(() => (base ? buildSpec(inputs, base) : null), [inputs, base]);
  const errors = check?.errors ?? {};
  const storeNetwork = !!base?.scenario.candystore;
  const baseJson = useMemo(() => (base ? JSON.stringify(base.scenario) : ""), [base]);
  const running = phase.kind === "running";
  const canRun = !!check?.spec && !storeNetwork && !running;
  const estimate = estimateFor(inputs);

  // --- The optimizer's own worker: spawned on the first run, replaced on Cancel, gone with the panel ---
  const onMessage = (m: TwinResponse) => {
    switch (m.type) {
      case "optProgress":
        if (m.runId !== runIdRef.current) return;
        setPhase((p) => (p.kind === "running" && p.runId === m.runId ? { ...p, progress: m.progress } : p));
        break;
      case "optDone": {
        if (m.runId !== runIdRef.current) return;
        runIdRef.current = "";
        const p = pending.current;
        pending.current = null;
        setDone({ result: m.result, label: p?.label ?? "", baseJson: p?.baseJson ?? "" });
        setChosen(0);
        setPhase({ kind: "idle" });
        break;
      }
      case "error":
        if (m.runId !== runIdRef.current) return;
        runIdRef.current = "";
        pending.current = null;
        setPhase({ kind: "error", name: m.name, message: m.message });
        break;
      default:
        // ready, pong, progress, done: not this worker's job.
        break;
    }
  };
  const onWorkerError = (msg: string) => {
    workerRef.current?.terminate();
    workerRef.current = null;
    runIdRef.current = "";
    pending.current = null;
    setPhase({ kind: "error", name: "Worker", message: msg });
  };
  const spawn = () => {
    const w = new Worker(new URL("../twin.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<TwinResponse>) => onMessage(e.data);
    w.onerror = (e) => onWorkerError(e.message || "The optimizer worker failed.");
    workerRef.current = w;
    return w;
  };
  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      runIdRef.current = "";
    },
    []
  );

  const start = () => {
    if (!base || !check?.spec || storeNetwork) return;
    const spec = check.spec;
    const w = workerRef.current ?? spawn();
    const runId = `opt-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    runIdRef.current = runId;
    pending.current = { label: `${building} · week ${base.startWeek} · ${spec.days} days · ${spec.seeds} seed${spec.seeds === 1 ? "" : "s"} · ${BUDGETS[inputs.budget].label.toLowerCase()} budget`, baseJson };
    setPhase({ kind: "running", runId, progress: null, estimateMs: estimate });
    const req: TwinRequest = { type: "optimize", runId, spec };
    w.postMessage(req);
  };
  const cancel = () => {
    workerRef.current?.terminate();
    runIdRef.current = "";
    pending.current = null;
    spawn();
    setPhase({ kind: "idle" });
  };

  // --- Inputs ---
  const setObjective = (v: string) => {
    const objective = v as Objective;
    setInputs((i) => ({ ...i, objective, assumptions: resetPenalties(i.assumptions, objective) }));
  };
  const toggleLever = (key: LeverKey) => setInputs((i) => ({ ...i, levers: i.levers.includes(key) ? i.levers.filter((k) => k !== key) : [...i.levers, key] }));
  const setLevers = (levers: LeverKey[]) => setInputs((i) => ({ ...i, levers }));

  // --- Result ---
  const result = done?.result ?? null;
  const plan = result ? (result.top[chosen] ?? result.best) : null;
  const stale = !!done && done.baseJson !== baseJson;
  const costs = useMemo(() => (result && plan ? costRows(result.base, plan) : []), [result, plan]);
  const kpis = useMemo(() => (result && plan ? kpiRows(result.base, plan) : []), [result, plan]);
  const saving = result && plan && result.base.cost && plan.cost ? result.base.cost.total - plan.cost.total : null;
  const savingShare = saving !== null && result?.base.cost && result.base.cost.total > 0 ? Math.abs(saving) / result.base.cost.total : 0;
  const planName = chosen === 0 ? "best plan" : `plan #${chosen + 1}`;
  const lateOf = (c: { kpis: { lateTrucks: number; notLoaded: number } | null }) => (c.kpis ? c.kpis.lateTrucks + c.kpis.notLoaded : null);
  const lateText = (v: number) => num(v, Number.isInteger(v) ? 0 : 1);
  const planLate = plan ? lateOf(plan) : null;
  const baseLate = result ? lateOf(result.base) : null;
  const progressShare = phase.kind === "running" ? (phase.progress ? (phase.progress.generation + 1) / (phase.progress.generations + 1) : 0.02) : 0;

  return (
    <div className="twin-opt">
      {!done && !running && <p className="sub">{INTRO}</p>}
      {baseError && !running && <p className="twin-err">{baseError}</p>}

      <SelectField label="Objective" value={inputs.objective} onChange={setObjective} options={OBJECTIVE_OPTIONS} help="How dearly a late truck is priced: service first $2,500, balanced $800, cost first $200 per truck, plus a per-minute and an unloaded-truck penalty." />

      <h3>
        Levers{" "}
        <span className="chips" onMouseDown={keepFocus}>
          <button type="button" className="chip" onClick={() => setLevers(LEVERS.map((l) => l.key))} title="Every lever, the doors included">
            all
          </button>
          <button type="button" className="chip" onClick={() => setLevers([...DEFAULT_LEVERS])} title="Everything but the doors, which are a building change">
            defaults
          </button>
          <button type="button" className="chip" onClick={() => setLevers([])}>
            none
          </button>
        </span>
      </h3>
      {GROUPS.map((g) => (
        <div className="levers" key={g.area}>
          <b className="area">{g.area}</b>
          {g.levers.map((l) => (
            <label className="lever" key={l.key}>
              <input type="checkbox" checked={inputs.levers.includes(l.key)} onChange={() => toggleLever(l.key)} />
              <span>{l.label}</span>
              <small>{leverRange(l)}</small>
            </label>
          ))}
        </div>
      ))}
      {errors.levers && <p className="twin-err">{errors.levers}</p>}

      <h3>Budget</h3>
      <div className="budgets" onMouseDown={keepFocus}>
        {BUDGET_KEYS.map((b) => (
          <button type="button" key={b} className={inputs.budget === b ? "on" : ""} aria-pressed={inputs.budget === b} onClick={() => setInputs((i) => ({ ...i, budget: b }))} title={`Population ${BUDGETS[b].population}, ${BUDGETS[b].generations} generations`}>
            {BUDGETS[b].label}
            <small>
              {BUDGETS[b].population} × {BUDGETS[b].generations}
            </small>
          </button>
        ))}
      </div>
      <div className="twin-fields">
        <NumField label="Seeds" help={`Engine seeds ${OPTIMIZE_LIMITS.seeds.min}–${OPTIMIZE_LIMITS.seeds.max} averaged per plan; 1 is fast, more smooth the dice.`} error={errors.seeds} value={inputs.seeds} onChange={(v) => setInputs((i) => ({ ...i, seeds: v }))} min={OPTIMIZE_LIMITS.seeds.min} max={OPTIMIZE_LIMITS.seeds.max} step={1} />
        <NumField label="Days" help={`${OPTIMIZE_LIMITS.days.min}–${OPTIMIZE_LIMITS.days.max} per evaluation; 7 sees a whole delivery week.`} error={errors.days} value={inputs.days} onChange={(v) => setInputs((i) => ({ ...i, days: v }))} min={OPTIMIZE_LIMITS.days.min} max={OPTIMIZE_LIMITS.days.max} step={1} />
      </div>
      <p className="note">
        Estimated time {estimateText(estimate)}: {BUDGETS[inputs.budget].population} plans × {BUDGETS[inputs.budget].generations + 1} generations × seeds × days, about 45 ms per simulated week. Plans already seen cost nothing.
      </p>

      <h3>
        Cost assumptions{" "}
        <button type="button" className="chip" onClick={() => setShowAssumptions((s) => !s)} aria-expanded={showAssumptions}>
          {showAssumptions ? "hide" : `show ${ASSUMPTION_META.length}`}
        </button>
      </h3>
      {showAssumptions && (
        <>
          <p className="note">Every plan is priced with these, per week. Changing the objective resets the three penalty fields.</p>
          <div className="twin-fields">
            {ASSUMPTION_META.map((m) => (
              <NumField key={m.key} label={m.label} help={m.help} error={errors[m.key]} value={inputs.assumptions[m.key]} onChange={(v) => setInputs((i) => ({ ...i, assumptions: { ...i.assumptions, [m.key]: v } }))} min={0} max={m.max} step={m.max !== undefined ? 0.05 : 1} />
            ))}
          </div>
        </>
      )}

      <div className="row actions" onMouseDown={keepFocus}>
        {running ? (
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="primary" onClick={start} disabled={!canRun} title="Search the levers for the cheapest weekly plan">
            Run optimizer
          </button>
        )}
        {storeNetwork && <span className="twin-err">{STORE_NETWORK}</span>}
        {!storeNetwork && !base && !running && <span className="sub">Fix the run row or the Scenario tab first.</span>}
      </div>
      {phase.kind === "error" && (
        <p className="twin-err">
          <b>{phase.name === "ZodError" ? "Invalid scenario" : phase.name === "Unsupported" ? "Unsupported" : phase.name}:</b> {phase.message}
        </p>
      )}

      {phase.kind === "running" && (
        <div className="status" role="status">
          <span className="twin-chip busy">{phase.progress ? `generation ${phase.progress.generation} of ${phase.progress.generations} · ${phase.progress.evaluations} evaluations` : "building the twin and generation 0…"}</span>
          <span className="twin-progress">
            <i style={{ width: `${Math.round(progressShare * 100)}%` }} />
          </span>
          <span className="sub">
            {phase.progress?.best.cost
              ? `Best so far ${money(phase.progress.best.cost.total)}/week${phase.progress.base.cost ? ` against ${money(phase.progress.base.cost.total)} as it is` : ""}, ${phase.progress.best.changes.length === 0 ? "the operation as it is" : `${phase.progress.best.changes.length} change${phase.progress.best.changes.length === 1 ? "" : "s"}`}. `
              : ""}
            {phase.progress ? `${estimateText(remainingMs(phase.progress))} left` : `Estimated ${estimateText(phase.estimateMs)}`}; the playback keeps running meanwhile.
          </span>
        </div>
      )}

      {result && plan && (
        <>
          <h3>
            Result
            {stale && (
              <span className="twin-chip edited" title="The Scenario tab or the run row has changed since this search; run the optimizer again to search from it">
                edited since
              </span>
            )}
          </h3>
          <div className="head">
            <b>{done!.label}</b>
            <span className="sub">{plan.changes.length ? plan.changes.join("; ") : "the operation as it is"}</span>
          </div>
          <div className="tiles">
            <div>
              <b>{plan.cost ? money(plan.cost.total) : "—"}</b>
              <span>{planName}, per week</span>
            </div>
            <div>
              <b className={saving === null ? "" : saving > 0.5 ? "good" : saving < -0.5 ? "bad" : ""}>{saving === null ? "—" : `${saving < -0.5 ? "+" : saving > 0.5 ? "−" : "±"}${money(Math.abs(saving))}`}</b>
              <span>{saving === null ? "base not priced" : `vs base ${result.base.cost ? money(result.base.cost.total) : "—"} (${pct(savingShare)})`}</span>
            </div>
            <div>
              <b className={planLate === null ? "" : planLate === 0 ? "good" : baseLate !== null && planLate > baseLate ? "bad" : ""}>{planLate === null ? "—" : planLate === 0 ? "all on time" : `${lateText(planLate)} late`}</b>
              <span>store trucks late or unloaded{baseLate !== null ? `, base ${lateText(baseLate)}` : ""}</span>
            </div>
            <div>
              <b className={plan.kpis && plan.kpis.fillRate < 0.99 ? "bad" : ""}>{plan.kpis ? pct(plan.kpis.fillRate, 1) : "—"}</b>
              <span>fill rate{result.base.kpis ? `, base ${pct(result.base.kpis.fillRate, 1)}` : ""}</span>
            </div>
          </div>
          <div className="row" onMouseDown={keepFocus}>
            <button type="button" className="primary" onClick={() => onApply(plan.scenario, false)} title="Load the plan into the Scenario tab; the building stays as it is">
              Apply to Scenario
            </button>
            <button type="button" onClick={() => onApply(plan.scenario, true)} title="Load the plan and run it, so Compare and Report see it">
              Apply and run
            </button>
          </div>

          <h3>Base vs {planName}</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>per week</th>
                  <th>base</th>
                  <th>plan</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((r) => (
                  <tr key={r.key} className={r.key === "total" ? "total" : ""}>
                    <td>{r.label}</td>
                    <td>{r.base}</td>
                    <td>{r.plan}</td>
                    <td className={r.cls}>{r.delta}</td>
                  </tr>
                ))}
                <tr className="sep">
                  <td colSpan={4}>KPIs, mean over the evaluation seeds</td>
                </tr>
                {kpis.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td>{r.base}</td>
                    <td>{r.plan}</td>
                    <td className={r.cls}>{r.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>What the plan changes</h3>
          {plan.changes.length ? (
            <ul className="changes">
              {plan.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="sub">Nothing: the operation as it is was the cheapest plan found.</p>
          )}

          {result.top.length > 1 && (
            <>
              <h3>Alternatives</h3>
              <ul className="alts">
                {result.top.map((c, i) =>
                  i === chosen ? null : (
                    <li key={i}>
                      <div className="row">
                        <span>
                          <b>{c.cost ? money(c.cost.total) : "—"}</b> per week · #{i + 1}
                        </span>
                        <span onMouseDown={keepFocus}>
                          <button type="button" className="chip" onClick={() => setChosen(i)}>
                            Use this plan
                          </button>
                        </span>
                      </div>
                      <span className="sub">{c.changes.length ? c.changes.join("; ") : "the operation as it is"}</span>
                    </li>
                  )
                )}
              </ul>
            </>
          )}

          <p className="twin-legend">
            {searchLegend(result)}. Assumptions: {assumptionsLegend(result.assumptions)}. Green: the plan is better on that row; red: worse. The plan replays on the 3D page with seed 1.
          </p>
        </>
      )}
    </div>
  );
}
