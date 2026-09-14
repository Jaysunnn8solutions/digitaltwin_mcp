"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import manifest from "@/data/manifest.json";
import sites from "@/data/sites.json";
import { compactSpec, type LayoutSpec } from "@/lib/layout/spec";
import { applyEvent, cloneState, finalize, kpiContext, projectKpis, type KpiContext } from "@/lib/trace/kpis";
import { upperBound } from "@/lib/trace/search";
import type { Playback, RunSpec, TraceInit, TwinRequest, TwinResponse, WorldPayload } from "@/lib/trace/types";
import type { CameraMode, CameraPreset, PickResult, ViewerOptions } from "@/lib/three/api";
import type { OperationsResult } from "@/lib/twin/operations";
import type { Kpis } from "@/lib/twin/replicate";
import { DEFAULT_STANDARDS } from "@/lib/twin/standards";
import type { TwinScenario } from "@/lib/twin/twin";
import { PROCESSES, type Process, type Site } from "@/lib/twin/types";
import { describeSelection, indexEvents, selectionTitle, type EventIndex } from "@/lib/twin-ui/describe";
import { DEFAULT_SPEED } from "@/lib/twin-ui/clock";
import { applyImportEdits, EMPTY_IMPORT_EDITS, formToScenario, issuesToErrors, scenarioToForm, type FormErrors, type ImportRackEdits, type ScenarioForm } from "@/lib/twin-ui/form";
import { dayClock, minutes, num } from "@/lib/twin-ui/format";
import { decodeHash, encodeHash, HASH_DEFAULTS, HASH_MAX_DAYS, HashError, type HashSource } from "@/lib/twin-ui/hash";
import BuildingPicker, { BUILTIN, DC_NAMES, fetchSampleFiles, importSpecInWorker, readSessionSpec, type BuildingChoice } from "./BuildingPicker";
import ComparePanel from "./ComparePanel";
import { keepFocus } from "./focus";
import HelpOverlay, { FirstRunHint } from "./HelpOverlay";
import Hud, { type HudSnapshot } from "./Hud";
import Inspector from "./Inspector";
import Minimap from "./Minimap";
import NetworkInset from "./NetworkInset";
import OptimizePanel from "./OptimizePanel";
import ReportPanel from "./ReportPanel";
import ScenarioPanel, { Datalists, type FormContext, type ScenarioTab } from "./ScenarioPanel";
import Deliveries from "./tabs/Deliveries";
import Disruptions from "./tabs/Disruptions";
import Labor from "./tabs/Labor";
import Space, { spaceCheck } from "./tabs/Space";
import Supply from "./tabs/Supply";
import Ticker, { notableFrom } from "./Ticker";
import Timeline from "./Timeline";
import TwinScene, { type ClockView, type KeyAction, type ShotMode, type TwinSceneHandle } from "./TwinScene";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  label: string;
  /** The request that produced this run, its scenario without the layout: what the header chips, the URL and Copy link describe. */
  spec: RunSpec;
  /** Where the building came from, for the link. */
  src?: HashSource;
  /** The building's display name at the time of the run. */
  building: string;
  playback: Playback;
  world: WorldPayload;
  result: OperationsResult;
  kpis: Kpis;
  ms: { context: number; simulate: number; compile: number };
  index: EventIndex;
  kctx: KpiContext;
  init: TraceInit;
}

type Status = { kind: "idle" } | { kind: "running"; phase: string; day: number; days: number } | { kind: "error"; name: string; message: string };

type SideTab = "scenario" | "inspector" | "network" | "compare" | "optimize" | "report" | "help";

interface ViewFlags {
  heat: boolean;
  labels: boolean;
  dayNight: boolean;
  quality: ViewerOptions["quality"];
  hud: boolean;
  /** The HUD's full grid, queues and today's trucks, behind "More". */
  hudMore: boolean;
  minimap: boolean;
  help: boolean;
  /** The View dropdown on the camera toolbar. */
  menu: boolean;
  /** The timeline's legend popover. */
  legend: boolean;
}

/** The run row's fields as typed: clamped into RunNumbers on read, so a field can be cleared and retyped. */
interface RunText {
  dc: string;
  week: string;
  days: string;
  seed: string;
}

interface RunNumbers {
  dc: string;
  week: number;
  days: number;
  seed: number;
}

/** Everything a run needs besides the worker; the hashchange path passes the decoded link's values without waiting for state to commit. */
interface RunInputs {
  run: RunNumbers;
  form: ScenarioForm;
  building: BuildingChoice;
}

const SITES = sites as unknown as Site[];
const SKU_COUNT = manifest.counts.skus;
const HINT_KEY = "twin.hint.v1";
const SAMPLE_FILES = ["sample-dc-locations.csv"];
const PRESETS: Array<[CameraPreset, string]> = [
  ["overview", "1 Overview"],
  ["dock", "2 Dock"],
  ["pick", "3 Pick"],
  ["reserve", "4 Reserve"],
  ["yard", "5 Yard"],
];

function readHint(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) !== "1";
  } catch {
    return true;
  }
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/** An integer in [min, max] from a text field; the fallback for a blank or unreadable one. */
function clampInt(text: string, fallback: number, min: number, max: number): number {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function runFromText(t: RunText): RunNumbers {
  return { dc: t.dc, week: clampInt(t.week, HASH_DEFAULTS.week, 1, 52), days: clampInt(t.days, HASH_DEFAULTS.days, 1, HASH_MAX_DAYS), seed: clampInt(t.seed, HASH_DEFAULTS.seed, 1, 2 ** 31 - 1) };
}

function textFromRun(r: RunNumbers): RunText {
  return { dc: r.dc, week: String(r.week), days: String(r.days), seed: String(r.seed) };
}

function sourceOf(b: BuildingChoice): HashSource | undefined {
  return b.kind === "session" ? "session" : b.kind === "sample" ? "sample" : undefined;
}

function buildingFromHash(src: HashSource | undefined): BuildingChoice {
  return src === "session" ? readSessionSpec() : src === "sample" ? { kind: "sample", spec: null, name: "", error: null } : BUILTIN;
}

/** The scenario as a link carries it: the layout is handed over in-browser, never in a URL. */
function withoutLayout(s: TwinScenario): TwinScenario {
  const { layout, ...rest } = s;
  void layout;
  return rest;
}

type Composed =
  /** `scenario` is what the worker runs (an imported building's layout, with its Space edits, on top); `bare` is the same without the layout, what the link and the run record carry. */
  | { scenario: TwinScenario; bare: TwinScenario; error?: undefined }
  | { scenario?: undefined; bare?: undefined; error: { where: "form" | "building" | "space"; name: string; message: string } };

/** The scenario a run or an optimizer search starts from, or the first reason it cannot start: the form's errors, a building not loaded, SKUs that do not fit the pick faces. */
function composeScenario(form: ScenarioForm, building: BuildingChoice, overrideSpec: LayoutSpec | null | undefined, ctx: FormContext, edits: ImportRackEdits): Composed {
  const res = formToScenario(form);
  if (!res.scenario) return { error: { where: "form", name: "Form", message: "Fix the highlighted fields first." } };
  const spec = overrideSpec !== undefined ? overrideSpec : building.kind === "builtin" ? null : building.spec;
  if (building.kind !== "builtin" && !spec) return { error: { where: "building", name: "Building", message: building.error ?? "The imported building has not loaded yet." } };
  const check = spaceCheck(form, { ...ctx, imported: spec });
  if (check.error) return { error: { where: "space", name: "LimitError", message: check.error } };
  return { scenario: spec ? { ...res.scenario, layout: applyImportEdits(spec, edits) } : res.scenario, bare: res.scenario };
}

/** The HUD's exact figures at t: the last checkpoint plus a replay of the events since; kpis(result) at the horizon. */
function snapshotAt(rec: RunRecord, t: number): HudSnapshot {
  const pb = rec.playback;
  const horizon = pb.meta.horizonEnd;
  const atEnd = t >= horizon - 1e-9;
  const cpMin = Math.max(1, pb.meta.checkpointMin);
  let i = Math.min(pb.checkpoints.length - 1, Math.floor((atEnd ? horizon : t) / cpMin));
  while (i > 0 && pb.checkpoints[i].t > t) i--;
  const cp = pb.checkpoints[i];
  const running = cloneState(cp.kpis);
  const upTo = atEnd ? horizon : t;
  for (let k = upperBound(rec.index.times, cp.t); k < pb.events.length && rec.index.times[k] <= upTo; k++) applyEvent(running, pb.events[k], rec.kctx);
  let kpis: Kpis;
  if (atEnd) {
    finalize(running, horizon, rec.kctx);
    kpis = rec.kpis;
  } else kpis = projectKpis(running, t, rec.init, pb.samples, false);
  const held = PROCESSES.map(() => 0);
  for (const j of pb.jobs) {
    if (j.queuedAt <= t && j.startAt > t && j.equipWaitMin > 0 && t >= j.startAt - j.equipWaitMin) held[PROCESSES.indexOf(j.process)]++;
  }
  return { kpis, running, final: atEnd, held };
}

function runLabel(spec: RunSpec, building: string): string {
  return `${building} · week ${spec.startWeek} · ${spec.days} day${spec.days === 1 ? "" : "s"} · seed ${spec.seed}`;
}

/** The hash that replays a run (at minute t when given). */
function hashOfRecord(rec: RunRecord, t?: number): string {
  return encodeHash({ dc: rec.spec.dc, week: rec.spec.startWeek, days: rec.spec.days, seed: rec.spec.seed, t, src: rec.src, scenario: rec.spec.scenario });
}

// ---------------------------------------------------------------------------
// The workbench
// ---------------------------------------------------------------------------

export default function TwinWorkbench() {
  const [hash] = useState(() => decodeHash(window.location.hash));
  const [runText, setRunText] = useState<RunText>(() => textFromRun({ dc: hash.dc, week: hash.week, days: hash.days, seed: hash.seed }));
  const [building, setBuilding] = useState<BuildingChoice>(() => buildingFromHash(hash.src));
  const [form, setForm] = useState<ScenarioForm>(() => scenarioToForm(hash.scenario));
  const [importEdits, setImportEdits] = useState<ImportRackEdits>(EMPTY_IMPORT_EDITS);
  const [workerErrors, setWorkerErrors] = useState<FormErrors>({});
  const [dcs, setDcs] = useState<string[]>(() => SITES.map((s) => s.id));
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [current, setCurrent] = useState<RunRecord | null>(null);
  const [previous, setPrevious] = useState<RunRecord | null>(null);
  const [selection, setSelection] = useState<PickResult | null>(null);
  const [tab, setTab] = useState<SideTab>("scenario");
  const [scenarioTab, setScenarioTab] = useState<ScenarioTab>("labor");
  const [clock, setClock] = useState<ClockView>({ t: hash.t ?? 0, playing: false, speed: DEFAULT_SPEED, skipQuiet: true });
  const [view, setView] = useState<ViewFlags>({ heat: false, labels: true, dayNight: true, quality: "auto", hud: true, hudMore: false, minimap: true, help: false, menu: false, legend: false });
  const [theme, setTheme] = useState<"light" | "dark">(() => (prefersDark() ? "dark" : "light"));
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => (hash.layoutDropped ? "This link carried an imported building. Layouts never travel in a URL: open /import, read the drawing and press “Open in 3D”, or drop it on the Scenario tab. The rest of the scenario was kept." : null));
  // A frame-only screenshot hides the hint with the rest of the chrome; a layout capture (shot=1&chrome=1) shows it as a first visit would.
  const [hint, setHint] = useState<boolean>(() => (!hash.shot || !!hash.chrome) && !hash.perf && readHint());
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef<string>("");
  const sceneRef = useRef<TwinSceneHandle | null>(null);
  const toastTimer = useRef<number | null>(null);
  const autoRan = useRef(false);
  /** The request behind each run in flight, so the record keeps what was actually run (the form may be edited meanwhile). */
  const requests = useRef(new Map<string, { spec: RunSpec; src?: HashSource; building: string }>());
  /** The hash this page last wrote itself, so its own replaceState is never mistaken for a navigation. */
  const written = useRef<string>(window.location.hash);
  /** A minute to seek to once the next run's playback is on screen (a link navigated to in this tab). */
  const pendingSeek = useRef<number | null>(null);
  /** The sample drawing's load in flight, shared by whoever asks for it while it runs. */
  const sampleLoad = useRef<Promise<LayoutSpec | null> | null>(null);

  const run = useMemo(() => runFromText(runText), [runText]);
  const shot: ShotMode | null = useMemo(() => (hash.shot ? { kind: "shot", t: hash.t ?? 0, cam: hash.cam } : hash.perf ? { kind: "perf", t: hash.t ?? 0, cam: hash.cam } : null), [hash]);
  // shot=1 alone captures the frame; with chrome=1 the page keeps its chrome so a capture shows the layout.
  const frameOnly = shot?.kind === "shot" && !hash.chrome;

  // --- Derived scenario ---
  const parsed = useMemo(() => formToScenario(form), [form]);
  const errors = useMemo(() => ({ ...workerErrors, ...parsed.errors }), [workerErrors, parsed.errors]);
  const errorCount = Object.keys(errors).length;
  const site = useMemo(() => SITES.find((s) => s.id === run.dc) ?? SITES[0], [run.dc]);
  const formCtx: FormContext = useMemo(() => {
    const world = current?.world;
    const init = current?.init;
    const imported = building.kind !== "builtin" ? building.spec : null;
    return {
      workerIds: world ? world.workers.map((w) => w.id) : [],
      roles: world ? [...new Set(world.workers.map((w) => w.role))] : ["Shift lead", "Forklift operator", "Receiver", "Order selector", "Loader"],
      shiftIds: [...new Set(form.shifts.length ? form.shifts.map((s) => s.id).filter(Boolean) : init ? init.shifts.map((s) => s.id) : site.shifts.map((s) => s.id))],
      supplierIds: world ? world.suppliers.map((s) => s.id) : [],
      categories: world ? [...new Set(world.skus.map((s) => s.category))] : ["traditional"],
      skuCount: world ? world.skus.length : SKU_COUNT,
      pickZone: imported ? null : { aisles: site.pick.aisles, baysPerSide: site.pick.baysPerSide, levels: site.pick.levels, slotsPerBay: site.pick.slotsPerBay },
      std: DEFAULT_STANDARDS,
      imported,
      importEdits,
      setImportEdits: (e: ImportRackEdits) => {
        // Like updateForm: an edit invalidates the worker's last verdict on the form.
        setImportEdits(e);
        setWorkerErrors({});
      },
    };
  }, [current, building, form.shifts, site, importEdits]);
  const tabCounts = useMemo(() => {
    const s = parsed.scenario ?? {};
    const has = (...keys: Array<keyof TwinScenario>) => keys.filter((k) => s[k] !== undefined).length;
    return {
      labor: has("removeWorkers", "crossTrain", "workerLeave", "addWorkers", "absenteeism", "flex", "overtimeMaxHours", "targetUtilization", "shifts", "operatingDays", "workerOverrides", "standards"),
      supply: has("forecast", "serviceLevel", "supplierDelays", "supplierOverrides", "inboundLatenessSdMin") + (s.times?.inboundWindow ? 1 : 0),
      deliveries: has("demandScale", "demandShocks", "deliveryDays") + (s.times?.orderRelease ? 1 : 0) + (s.times?.truckDeparture ? 1 : 0),
      space: has("slotting", "faceCases", "inboundDoors", "outboundDoors", "forklifts", "palletJacks", "rackZones") + (formCtx.imported && (importEdits.levels || importEdits.slotsPerBay || importEdits.aisleWidthFt) ? 1 : 0),
      disruptions: has("doorOutages", "forkliftOutages", "wmsOutages"),
    };
  }, [parsed.scenario, formCtx.imported, importEdits]);
  /** The form or the run row no longer describes the run on screen. */
  const edited = useMemo(() => {
    if (!current) return false;
    const s = parsed.scenario;
    if (!s) return true;
    const spec = current.spec;
    return run.dc !== spec.dc || run.week !== spec.startWeek || run.days !== spec.days || run.seed !== spec.seed || sourceOf(building) !== current.src || JSON.stringify(s) !== JSON.stringify(spec.scenario);
  }, [current, parsed.scenario, run, building]);

  /** What the optimizer searches from: the scenario the form and the run row describe now, the imported building included. */
  const optBase = useMemo(() => {
    const c = composeScenario(form, building, undefined, formCtx, importEdits);
    return c.error ? { base: null, error: c.error.message } : { base: { dc: run.dc, startWeek: run.week, scenario: c.scenario }, error: null };
  }, [form, building, formCtx, importEdits, run.dc, run.week]);

  const options: ViewerOptions = useMemo(() => ({ shadows: true, heat: view.heat, labels: view.labels, dayNight: view.dayNight, quality: view.quality, theme, debugSpeed: false }), [view.heat, view.labels, view.dayNight, view.quality, theme]);

  const hud = useMemo(() => (current ? snapshotAt(current, clock.t) : null), [current, clock.t]);
  const sections = useMemo(() => (current ? describeSelection(selection, current.playback, current.world, clock.t, current.index) : []), [current, selection, clock.t]);
  const canFollow = !!(current && selection?.kind === "entity" && current.playback.tracks[selection.entity]);

  // --- Worker ---
  const latest = useRef<{ onMessage: (m: TwinResponse) => void; onWorkerError: (msg: string) => void; loadSample: () => Promise<LayoutSpec | null>; launch: (inputs: RunInputs) => void }>({
    onMessage: () => {},
    onWorkerError: () => {},
    loadSample: () => Promise.resolve(null),
    launch: () => {},
  });

  const spawn = () => {
    const w = new Worker(new URL("../twin.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<TwinResponse>) => latest.current.onMessage(e.data);
    w.onerror = (e) => latest.current.onWorkerError(e.message || "The simulation worker failed.");
    workerRef.current = w;
    return w;
  };

  // Whatever worker is current at unmount is the one to terminate: Cancel replaces it, so the first one is not enough.
  useEffect(() => {
    spawn();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      runIdRef.current = "";
      latest.current = { onMessage: () => {}, onWorkerError: () => {}, loadSample: () => Promise.resolve(null), launch: () => {} };
    };
  }, []);

  const writeHash = (h: string) => {
    window.history.replaceState(null, "", h);
    written.current = h;
  };

  const startRun = (overrideSpec?: LayoutSpec | null, inputs?: RunInputs) => {
    const w = workerRef.current;
    if (!w) return;
    const useRun = inputs?.run ?? run;
    const useForm = inputs?.form ?? form;
    const useBuilding = inputs?.building ?? building;
    setWorkerErrors({});
    const composed = composeScenario(useForm, useBuilding, overrideSpec, formCtx, importEdits);
    if (composed.error) {
      const e = composed.error;
      if (e.where !== "building") {
        setTab("scenario");
        setSheetOpen(true);
      }
      if (e.where === "space") setScenarioTab("space");
      setStatus({ kind: "error", name: e.name, message: e.message });
      return;
    }
    const { scenario, bare } = composed;
    const runId = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    runIdRef.current = runId;
    const runSpec: RunSpec = { dc: useRun.dc, startWeek: useRun.week, days: useRun.days, seed: useRun.seed, scenario };
    const src = sourceOf(useBuilding);
    const name = useBuilding.kind === "builtin" ? (DC_NAMES[useRun.dc] ?? useRun.dc) : useBuilding.name || "imported building";
    requests.current.set(runId, { spec: { ...runSpec, scenario: bare }, src, building: name });
    const req: TwinRequest = { type: "run", runId, spec: runSpec, keepEvents: true };
    setStatus({ kind: "running", phase: "context", day: 0, days: useRun.days });
    w.postMessage(req);
    try {
      writeHash(encodeHash({ dc: useRun.dc, week: useRun.week, days: useRun.days, seed: useRun.seed, src, scenario: bare }));
      setLinkMsg(null);
    } catch (err) {
      setLinkMsg(err instanceof HashError ? err.message : String(err));
    }
  };

  const cancelRun = () => {
    workerRef.current?.terminate();
    runIdRef.current = "";
    requests.current.clear();
    spawn();
    setStatus({ kind: "idle" });
  };

  const loadSample = (): Promise<LayoutSpec | null> => {
    if (sampleLoad.current) return sampleLoad.current;
    const p = (async () => {
      try {
        const files = await fetchSampleFiles(SAMPLE_FILES);
        const result = await importSpecInWorker(files);
        if (!result.stats) throw new Error(result.buildError ?? "The sample drawing has no racks.");
        const spec = compactSpec(result.spec);
        setBuilding({ kind: "sample", spec, name: result.spec.name, error: null });
        return spec;
      } catch (err) {
        setBuilding({ kind: "sample", spec: null, name: "", error: err instanceof Error ? err.message : String(err) });
        return null;
      } finally {
        sampleLoad.current = null;
      }
    })();
    sampleLoad.current = p;
    return p;
  };

  /** Start a run from explicit inputs, cancelling one in flight; the sample drawing is fetched first when the link asks for it. */
  const launch = (inputs: RunInputs) => {
    if (runIdRef.current) cancelRun();
    if (inputs.building.kind === "sample" && !inputs.building.spec) {
      void loadSample().then((spec) => {
        if (spec) startRun(spec, { ...inputs, building: { kind: "sample", spec, name: "", error: null } });
      });
    } else startRun(undefined, inputs);
  };

  const onMessage = (m: TwinResponse) => {
    switch (m.type) {
      case "ready": {
        if (m.dcs.length) setDcs(m.dcs);
        if (autoRan.current) return;
        autoRan.current = true;
        // Every load runs once: a tool's link plays without a click; the picker's building is resolved first.
        if (building.kind === "sample" && !building.spec) {
          void loadSample().then((spec) => {
            if (spec) startRun(spec);
          });
        } else if (building.kind !== "builtin" && !building.spec) {
          setNotice(building.error ?? "The imported building is missing.");
          setBuilding(BUILTIN);
          startRun(null, { run, form, building: BUILTIN });
        } else startRun();
        break;
      }
      case "progress":
        if (m.runId === runIdRef.current) setStatus({ kind: "running", phase: m.phase, day: m.day, days: m.days });
        break;
      case "done": {
        if (m.runId !== runIdRef.current) return;
        const init = m.playback.events[0]?.k === "init" ? (m.playback.events[0] as TraceInit) : null;
        if (!init) {
          setStatus({ kind: "error", name: "Playback", message: "The playback has no init event." });
          return;
        }
        const req = requests.current.get(m.runId);
        requests.current.delete(m.runId);
        const buildingName = req?.building ?? (m.world.spec.source.format === "builtin" ? (DC_NAMES[m.world.dc.id] ?? m.world.dc.id) : m.world.spec.name);
        const spec: RunSpec = req ? { ...req.spec, scenario: withoutLayout(req.spec.scenario) } : { dc: m.world.dc.id, startWeek: init.startWeek, days: init.days, seed: init.seed, scenario: {} };
        const rec: RunRecord = {
          id: m.runId,
          label: runLabel(spec, buildingName),
          spec,
          src: req?.src,
          building: buildingName,
          playback: m.playback,
          world: m.world,
          result: m.result,
          kpis: m.kpis,
          ms: m.ms,
          index: indexEvents(m.playback),
          kctx: kpiContext(init, m.playback.events, m.world.skus),
          init,
        };
        setPrevious(current);
        setCurrent(rec);
        setSelection(null);
        setStatus({ kind: "idle" });
        break;
      }
      case "error":
        if (m.runId !== runIdRef.current) return;
        runIdRef.current = "";
        requests.current.delete(m.runId);
        setStatus({ kind: "error", name: m.name, message: m.message });
        if (m.issues) {
          setWorkerErrors(issuesToErrors(m.issues.map((i) => ({ path: i.path ? i.path.split(".") : [], message: i.message }))));
          setTab("scenario");
        }
        break;
      case "pong":
        break;
    }
  };
  // A worker that fails to load stays dead: replace it, as Cancel does, so the next Run has somewhere to go.
  const onWorkerError = (msg: string) => {
    workerRef.current?.terminate();
    runIdRef.current = "";
    requests.current.clear();
    spawn();
    setStatus({ kind: "error", name: "Worker", message: msg });
  };
  useEffect(() => {
    latest.current = { onMessage, onWorkerError, loadSample, launch };
  });

  // The sample drawing loads whenever the choice needs it (the picker, a link), not only on the first page load.
  useEffect(() => {
    if (building.kind !== "sample" || building.spec || building.error) return;
    void latest.current.loadSample();
  }, [building]);

  // A link pasted into this tab's address bar is a fragment navigation: the document stays, so the page runs the new link itself.
  useEffect(() => {
    const onHashChange = () => {
      const h = window.location.hash;
      if (h === written.current) return;
      const decoded = decodeHash(h);
      const nextRun: RunNumbers = { dc: decoded.dc, week: decoded.week, days: decoded.days, seed: decoded.seed };
      const nextForm = scenarioToForm(decoded.scenario);
      const nextBuilding = buildingFromHash(decoded.src);
      setRunText(textFromRun(nextRun));
      setForm(nextForm);
      setBuilding(nextBuilding);
      setWorkerErrors({});
      setImportEdits(EMPTY_IMPORT_EDITS);
      setNotice(decoded.layoutDropped ? "This link carried an imported building. Layouts never travel in a URL; the rest of the scenario was kept." : null);
      pendingSeek.current = decoded.t ?? 0;
      written.current = h;
      latest.current.launch({ run: nextRun, form: nextForm, building: nextBuilding });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The scene binds a new playback in its own effect first (child effects run before the parent's); then the link's minute applies.
  useEffect(() => {
    if (!current || pendingSeek.current === null) return;
    const t = pendingSeek.current;
    pendingSeek.current = null;
    sceneRef.current?.seek(t);
  }, [current]);

  // --- Environment listeners ---
  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const small = window.matchMedia("(max-width: 999px)");
    const onDark = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    const onSmall = (e: MediaQueryListEvent) => setNarrow(e.matches);
    dark.addEventListener("change", onDark);
    small.addEventListener("change", onSmall);
    return () => {
      dark.removeEventListener("change", onDark);
      small.removeEventListener("change", onSmall);
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // The View menu and the timeline legend close on a click anywhere else, like any dropdown.
  useEffect(() => {
    if (!view.menu && !view.legend) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (view.menu && !el?.closest(".twin-menuwrap")) setView((v) => ({ ...v, menu: false }));
      if (view.legend && !el?.closest(".twin-legendwrap")) setView((v) => ({ ...v, legend: false }));
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [view.menu, view.legend]);

  // --- Handlers the scene calls ---
  const select = (sel: PickResult | null) => {
    setSelection(sel);
    if (sel) {
      setTab("inspector");
      if (narrow) setSheetOpen(true);
    }
  };
  const selectEntity = (entity: number) => select({ kind: "entity", entity });
  const seek = (t: number) => sceneRef.current?.seek(t);
  const showToast = (text: string) => {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };
  const onSkipped = (gap: [number, number]) => showToast(`Skipped ${minutes(gap[1] - gap[0])} of quiet time, ${dayClock(gap[0])} → ${dayClock(gap[1])}. Press 0 to keep quiet hours.`);
  const jumpNotable = (dir: 1 | -1) => {
    if (!current) return;
    const i = notableFrom(current.playback, clock.t, dir);
    if (i < 0) return;
    const e = current.playback.ticker[i];
    seek(e.t);
    if (e.entity >= 0) select({ kind: "entity", entity: e.entity });
  };
  const onAction = (a: KeyAction) => {
    switch (a) {
      case "toggleHeat":
        setView((v) => ({ ...v, heat: !v.heat }));
        break;
      case "toggleLabels":
        setView((v) => ({ ...v, labels: !v.labels }));
        break;
      case "cycleQuality":
        setView((v) => ({ ...v, quality: v.quality === "auto" ? "high" : v.quality === "high" ? "low" : "auto" }));
        break;
      case "toggleNight":
        setView((v) => ({ ...v, dayNight: !v.dayNight }));
        break;
      case "toggleHud":
        setView((v) => ({ ...v, hud: !v.hud }));
        break;
      case "toggleMinimap":
        setView((v) => ({ ...v, minimap: !v.minimap }));
        break;
      case "toggleHelp":
        setView((v) => ({ ...v, help: !v.help }));
        break;
      case "run":
        if (status.kind !== "running") startRun();
        break;
      case "compare":
        setTab("compare");
        if (narrow) setSheetOpen(true);
        break;
      case "escape":
        // Overlays close one at a time, the most recent kind first; the selection and the sheet come last.
        if (view.help) setView((v) => ({ ...v, help: false }));
        else if (view.menu) setView((v) => ({ ...v, menu: false }));
        else if (view.legend) setView((v) => ({ ...v, legend: false }));
        else if (view.hudMore) setView((v) => ({ ...v, hudMore: false }));
        else if (selection) setSelection(null);
        else if (narrow) setSheetOpen(false);
        break;
      case "tickerPrev":
        jumpNotable(-1);
        break;
      case "tickerNext":
        jumpNotable(1);
        break;
    }
  };
  const dismissHint = () => {
    setHint(false);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      // A blocked storage just means the hint returns next visit.
    }
  };
  // The link describes the run on screen at this minute, whatever the form says now.
  const copyLink = async () => {
    if (!current) return;
    try {
      const h = hashOfRecord(current, Math.round(clock.t));
      await navigator.clipboard.writeText(`${window.location.origin}/twin${h}`);
      setLinkMsg("Link copied");
    } catch (err) {
      setLinkMsg(err instanceof Error ? err.message : String(err));
    }
  };
  const swapRuns = () => {
    if (!previous || !current) return;
    setPrevious(current);
    setCurrent(previous);
    setSelection(null);
    // The URL tracks what plays.
    try {
      writeHash(hashOfRecord(previous));
    } catch {
      // A run whose scenario cannot be linked keeps the URL as it was.
    }
  };
  const updateForm = (fn: (f: ScenarioForm) => ScenarioForm) => {
    setForm(fn);
    setWorkerErrors({});
  };
  /** A plan from the Optimize tab into the form (the building stays what it is), and a run of it when asked, the way the Run button runs. */
  const applyPlan = (scenario: TwinScenario, andRun: boolean) => {
    const f = scenarioToForm(withoutLayout(scenario));
    updateForm(() => f);
    setTab("scenario");
    if (narrow) setSheetOpen(true);
    if (andRun) launch({ run, form: f, building });
  };
  const setRunField = (key: keyof RunText, value: string) => setRunText((r) => ({ ...r, [key]: value }));
  /** On blur the field shows the value the run will use (clamped, or the default for a blank). */
  const commitRunField = (key: "week" | "days" | "seed") => setRunText((r) => ({ ...r, [key]: String(runFromText(r)[key]) }));

  const running = status.kind === "running";
  const progressShare = status.kind === "running" ? (status.phase === "context" ? 0.05 : status.phase === "compile" ? 0.95 : 0.05 + (0.9 * Math.max(0, status.day - 1)) / Math.max(1, status.days)) : 0;
  const buildingName = building.kind === "builtin" ? (DC_NAMES[run.dc] ?? run.dc) : building.name || "imported building";
  // The header chips describe the run on screen; before the first run, the run row.
  const chips = current ? { building: current.building, week: current.spec.startWeek, days: current.spec.days, seed: current.spec.seed } : { building: buildingName, week: run.week, days: run.days, seed: run.seed };
  const showSide = (id: SideTab) => {
    setTab(id);
    if (narrow) setSheetOpen(id === tab ? !sheetOpen : true);
  };

  const viewMenu: Array<[label: string, key: string, on: boolean, action: KeyAction]> = [
    ["Heat: faces by lines per week", "G", view.heat, "toggleHeat"],
    ["Labels", "L", view.labels, "toggleLabels"],
    ["Day and night lighting", "N", view.dayNight, "toggleNight"],
    [`Quality: ${view.quality}`, "Q", view.quality !== "low", "cycleQuality"],
    ["Minimap", "M", view.minimap, "toggleMinimap"],
    ["Key figures (HUD)", "H", view.hud, "toggleHud"],
  ];

  const hudEl =
    view.hud && current && hud ? (
      <Hud world={current.world} playback={current.playback} index={current.index} snapshot={hud} t={clock.t} expanded={view.hudMore} onToggle={() => setView((v) => ({ ...v, hudMore: !v.hudMore }))} onSelectQueue={(p: Process) => select({ kind: "queue", process: p })} onSelectEntity={selectEntity} />
    ) : null;
  // Wide: the hint floats over the stage above the ticker. Narrow: the stage is short, so it is a block under the stage and never hides the building.
  const hintEl = hint && current && !view.help ? <FirstRunHint block={narrow} onDismiss={dismissHint} onHelp={() => setView((v) => ({ ...v, help: true }))} /> : null;

  return (
    <div className={`twin-app${narrow ? " sheeted" : ""}${frameOnly ? " shot" : ""}`}>
      <header className="twin-top">
        <span className="twin-crumb">
          <Link href="/" title="Distribution-center twin">
            ← DC twin
          </Link>
        </span>
        <h1>3D twin</h1>
        <span className="twin-runline">
          <span className="twin-chip">{chips.building}</span>
          <span className="twin-chip">week {chips.week}</span>
          <span className="twin-chip">
            {chips.days} day{chips.days === 1 ? "" : "s"}
          </span>
          <span className="twin-chip">seed {chips.seed}</span>
          {edited && (
            <span className="twin-chip edited" title="The scenario or the run row has changed since this run; Run again to see it">
              edited
            </span>
          )}
          {current && (
            <span className="sub twin-ranin" title={`Context, simulation and playback compile: ${num(current.ms.context)} + ${num(current.ms.simulate)} + ${num(current.ms.compile)} ms`}>
              ran in {num(current.ms.context + current.ms.simulate + current.ms.compile)} ms · {current.playback.jobs.length.toLocaleString("en-US")} jobs · {current.playback.events.length.toLocaleString("en-US")} events
            </span>
          )}
        </span>
        <div className="twin-actions" onMouseDown={keepFocus}>
          {running && (
            <>
              <span className="twin-chip busy">{status.phase === "context" ? "building the twin" : status.phase === "compile" ? "compiling the playback" : `simulating day ${status.day} of ${status.days}`}</span>
              <span className="twin-progress">
                <i style={{ width: `${Math.round(progressShare * 100)}%` }} />
              </span>
              <button type="button" onClick={cancelRun}>
                Cancel
              </button>
            </>
          )}
          {!running && (
            <button type="button" className="primary" onClick={() => startRun()} title="R">
              {current ? "Run again" : "Run"}
            </button>
          )}
          <button type="button" onClick={() => void copyLink()} disabled={!current} title="A link that replays this run at this minute">
            Copy link
          </button>
          {linkMsg && <span className="sub" style={{ margin: 0 }}>{linkMsg}</span>}
        </div>
      </header>

      {notice && (
        <div className="twin-notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {status.kind === "error" && (
        <div className="twin-notice error">
          <span>
            <b>{status.name === "ZodError" ? "Invalid scenario" : status.name === "LimitError" ? "Does not fit" : status.name === "UnknownIdError" ? "Unknown id" : status.name}:</b> {status.message}
          </span>
          <button type="button" onClick={() => setStatus({ kind: "idle" })}>
            Dismiss
          </button>
        </div>
      )}

      <div className="twin-body">
        <div className="twin-stage">
          <TwinScene ref={sceneRef} world={current?.world ?? null} playback={current?.playback ?? null} options={options} selection={selection} initialT={hash.t ?? 0} shot={shot} onClock={setClock} onPick={select} onSkipped={onSkipped} onAction={onAction} onCameraMode={setCameraMode} />
          {!current && (
            <div className="twin-empty">
              <div>
                <b>{running ? "Simulating…" : status.kind === "error" ? "The run did not start" : "Loading the twin…"}</b>
                {running ? `${status.phase === "simulate" ? `day ${status.day} of ${status.days}` : status.phase} — the engine runs in a web worker in your browser` : "Nothing leaves your browser: the engine and the 3D playback run here."}
              </div>
            </div>
          )}
          {/* Overlays are flex stacks, not free-floating boxes: the toolbar and the clock share the first row, the HUD strip gets the whole width under them however the toolbar wraps, and nothing covers anything else. */}
          <div className="twin-ovl twin-ovl-top" onMouseDown={keepFocus}>
            <div className="twin-ovl-row">
              <div className="twin-ovl-col left">
                <div className="twin-overlay twin-campill" role="toolbar" aria-label="Camera">
                  <button type="button" className={cameraMode === "orbit" ? "on" : ""} onClick={() => sceneRef.current?.setCamera("orbit")} title="O: orbit (drag to turn, wheel to zoom, right-drag to pan)">
                    Orbit
                  </button>
                  <button type="button" className={cameraMode === "follow" ? "on" : ""} disabled={!canFollow && cameraMode !== "follow"} onClick={() => selection?.kind === "entity" && sceneRef.current?.setCamera("follow", selection.entity)} title="F: follow the selected actor">
                    Follow
                  </button>
                  {!narrow && (
                    <button type="button" className={cameraMode === "walk" ? "on" : ""} onClick={() => sceneRef.current?.setCamera("walk")} title="T: walk the floor (WASD, mouse, E to inspect)">
                      Walk
                    </button>
                  )}
                  <span className="sep" />
                  {PRESETS.map(([p, label]) => (
                    <button type="button" key={p} className="narrow-hide" onClick={() => sceneRef.current?.preset(p)} title={`Preset ${label}`}>
                      {label.slice(2)}
                    </button>
                  ))}
                  <span className="sep" />
                  <span className="twin-menuwrap">
                    <button type="button" className={view.menu ? "on" : ""} onClick={() => setView((v) => ({ ...v, menu: !v.menu }))} aria-haspopup="menu" aria-expanded={view.menu} title="Heat, labels, lighting, quality, minimap, HUD">
                      View ▾
                    </button>
                    {view.menu && (
                      <div className="twin-overlay twin-menu" role="menu">
                        {viewMenu.map(([label, key, on, action]) => (
                          <button type="button" role="menuitemcheckbox" aria-checked={on} key={action} className={on ? "on" : ""} onClick={() => onAction(action)}>
                            <i aria-hidden="true">{on ? "✓" : ""}</i>
                            <span>{label}</span>
                            <kbd>{key}</kbd>
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                  <button type="button" className={view.help ? "on" : ""} onClick={() => onAction("toggleHelp")} title="?: keyboard map and how to drive the twin" aria-label="Help">
                    ?
                  </button>
                </div>
              </div>
              <div className="twin-ovl-col right">
                {current && (
                  <div className="twin-overlay twin-clockpill" title=", and . change the speed; 0 toggles skipping quiet hours">
                    <b>{dayClock(clock.t)}</b>
                    <span className="twin-speed">
                      {clock.playing ? "▶" : "❚❚"} {clock.speed}×{clock.playing ? "" : " · paused"}
                      {clock.skipQuiet ? " · skips quiet hours" : ""}
                    </span>
                    <span className="twin-sel">{selection ? selectionTitle(selection, current.playback, current.world) : "click anything to inspect"}</span>
                  </div>
                )}
                {toast && (
                  <div className="twin-overlay twin-toast" role="status">
                    {toast}
                  </div>
                )}
              </div>
            </div>
            {!narrow && hudEl}
          </div>
          <div className="twin-ovl twin-ovl-bottom" onMouseDown={keepFocus}>
            <div className="twin-ovl-col left">
              {!narrow && hintEl}
              {current && <Ticker playback={current.playback} t={clock.t} onSelect={selectEntity} onSeek={seek} />}
            </div>
            {current && view.minimap && !narrow && <Minimap world={current.world} playback={current.playback} t={clock.t} selection={selection} onLookAt={(x, y) => sceneRef.current?.lookAt(x, y)} onSelect={selectEntity} />}
          </div>
          <HelpOverlay open={view.help} onClose={() => setView((v) => ({ ...v, help: false }))} />
        </div>

        <aside className={`twin-side${narrow ? " sheet" : ""}${sheetOpen ? " open" : ""}`}>
          <div className="twin-tabs" role="tablist">
            {(
              [
                ["scenario", "Scenario"],
                ["inspector", "Inspector"],
                ["network", "Network"],
                ["compare", "Compare"],
                ["optimize", "Optimize"],
                ["report", "Report"],
                ["help", "Help"],
              ] as Array<[SideTab, string]>
            ).map(([id, label]) => (
              <button type="button" key={id} id={`twin-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`twin-panel-${id}`} className={tab === id ? "on" : ""} onClick={() => showSide(id)}>
                {label}
                {id === "scenario" && errorCount > 0 && <span className="n">{errorCount}</span>}
              </button>
            ))}
          </div>
          {tab === "scenario" && (
            <ScenarioPanel
              tab={scenarioTab}
              onTab={setScenarioTab}
              counts={tabCounts}
              errorCount={errorCount}
              panelId="twin-panel-scenario"
              labelledBy="twin-tab-scenario"
              runControls={
                <>
                  <BuildingPicker dc={run.dc} dcs={dcs} value={building} disabled={running} onDc={(dc) => setRunField("dc", dc)} onChange={setBuilding} />
                  <div className="row">
                    <label>
                      Week{" "}
                      <input type="number" min={1} max={52} value={runText.week} onChange={(e) => setRunField("week", e.target.value)} onBlur={() => commitRunField("week")} title="Calendar week the run starts on its Monday (44 is Halloween week)" />
                    </label>
                    <label>
                      Days{" "}
                      <input type="number" min={1} max={HASH_MAX_DAYS} value={runText.days} onChange={(e) => setRunField("days", e.target.value)} onBlur={() => commitRunField("days")} title={`1 to ${HASH_MAX_DAYS} days`} />
                    </label>
                    <label>
                      Seed{" "}
                      <input type="number" min={1} value={runText.seed} onChange={(e) => setRunField("seed", e.target.value)} onBlur={() => commitRunField("seed")} title="Seed 1 replays a tool's first run exactly" />
                    </label>
                    {/* The buttons alone keep focus off themselves (Space then plays, not re-runs); the inputs beside them still take the caret. */}
                    <span className="twin-runbtns" onMouseDown={keepFocus}>
                      {!running ? (
                        <button type="button" className="primary" onClick={() => startRun()}>
                          Run
                        </button>
                      ) : (
                        <button type="button" onClick={cancelRun}>
                          Cancel
                        </button>
                      )}
                      <button type="button" className="chip" onClick={() => updateForm(() => scenarioToForm({}))} title="Clear every scenario field">
                        Reset
                      </button>
                    </span>
                  </div>
                  {current && current.world.changes.length > 0 && (
                    <ul className="twin-changes">
                      {current.world.changes.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                  {errors[""] && <span className="twin-err">{errors[""]}</span>}
                </>
              }
            >
              <Datalists ctx={formCtx} />
              {scenarioTab === "labor" && <Labor form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "supply" && <Supply form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "deliveries" && <Deliveries form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "space" && <Space form={form} update={updateForm} errors={errors} ctx={formCtx} />}
              {scenarioTab === "disruptions" && <Disruptions form={form} update={updateForm} errors={errors} ctx={formCtx} />}
            </ScenarioPanel>
          )}
          {tab === "inspector" && (
            <div className="twin-tabbody" role="tabpanel" id="twin-panel-inspector" aria-labelledby="twin-tab-inspector">
              <Inspector title={current ? selectionTitle(selection, current.playback, current.world) : "Nothing selected"} selection={selection} sections={sections} canFollow={canFollow} following={cameraMode === "follow"} onFollow={() => selection?.kind === "entity" && sceneRef.current?.setCamera("follow", selection.entity)} onClear={() => setSelection(null)} />
            </div>
          )}
          {tab === "network" && (
            <div className="twin-tabbody" role="tabpanel" id="twin-panel-network" aria-labelledby="twin-tab-network">
              {current ? <NetworkInset world={current.world} playback={current.playback} index={current.index} t={clock.t} onSelect={selectEntity} /> : <p className="sub">Run a scenario first.</p>}
            </div>
          )}
          {tab === "compare" && (
            <div className="twin-tabbody" role="tabpanel" id="twin-panel-compare" aria-labelledby="twin-tab-compare">
              <ComparePanel a={previous ? { label: previous.label, kpis: previous.kpis, changes: previous.world.changes } : null} b={current ? { label: current.label, kpis: current.kpis, changes: current.world.changes } : null} onSwap={swapRuns} />
            </div>
          )}
          {/* Mounted once and hidden behind the other tabs: the search worker and its result outlive a visit to the Scenario tab (Apply switches there). */}
          <div className="twin-tabbody" role="tabpanel" id="twin-panel-optimize" aria-labelledby="twin-tab-optimize" hidden={tab !== "optimize"}>
            <OptimizePanel base={optBase.base} baseError={optBase.error} building={buildingName} onApply={applyPlan} />
          </div>
          {tab === "report" && (
            <div className="twin-tabbody" role="tabpanel" id="twin-panel-report" aria-labelledby="twin-tab-report">
              {/* The records themselves, not copies: their identity is stable between renders, so the report is built once per run. */}
              <ReportPanel run={current} previous={previous} />
            </div>
          )}
          {tab === "help" && (
            <div className="twin-tabbody" role="tabpanel" id="twin-panel-help" aria-labelledby="twin-tab-help">
              <h3>What you are looking at</h3>
              <p>
                A discrete-event simulation of one distribution center runs in a web worker in your browser, records every event, and the playback compiles them into the animation: supplier
                trucks at the inbound doors, forklifts putting pallets away, pickers walking S-shaped tours through the pick module, packing, staging, store trucks leaving at their departure time.
              </p>
              <p>The numbers on the HUD are the engine&apos;s own accounting at the current minute. What the engine never decides (which door, which forklift, where a pallet sits in a lane) the playback picks deterministically and the inspector labels as shown.</p>
              <p>The Optimize tab searches crew, training, overtime, slotting, equipment, doors, service level and departure time for the cheapest weekly plan against the scenario as it stands, in a second worker, and loads the plan into the Scenario tab.</p>
              <h3>Keys</h3>
              <button type="button" onClick={() => setView((v) => ({ ...v, help: true }))}>
                Show the keyboard map
              </button>
              <h3>Links</h3>
              <p>
                <Link href="/import">Import your own building</Link> and press Open in 3D, or ask the MCP tools for a scenario: every simulate_operations and what_if answer ends with a link that replays its first run here.
              </p>
            </div>
          )}
        </aside>
      </div>

      {narrow && hintEl}
      {narrow && hudEl}

      <Timeline
        playback={current?.playback ?? null}
        compare={previous?.playback ?? null}
        t={clock.t}
        playing={clock.playing}
        speed={clock.speed}
        skipQuiet={clock.skipQuiet}
        onSeek={seek}
        onTogglePlay={() => sceneRef.current?.togglePlay()}
        onSpeed={(s) => sceneRef.current?.setSpeed(s)}
        onSkipQuiet={(on) => sceneRef.current?.setSkipQuiet(on)}
        onStep={(d) => sceneRef.current?.step(d)}
        legendOpen={view.legend}
        onLegend={(open) => setView((v) => ({ ...v, legend: open }))}
      />
    </div>
  );
}
