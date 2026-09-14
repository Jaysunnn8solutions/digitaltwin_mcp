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
import { decodeHash, encodeHash, HashError, type HashSource } from "@/lib/twin-ui/hash";
import BuildingPicker, { BUILTIN, DC_NAMES, fetchSampleFiles, importSpecInWorker, readSessionSpec, type BuildingChoice } from "./BuildingPicker";
import ComparePanel from "./ComparePanel";
import HelpOverlay, { FirstRunHint } from "./HelpOverlay";
import Hud, { type HudSnapshot } from "./Hud";
import Inspector from "./Inspector";
import Minimap from "./Minimap";
import NetworkInset from "./NetworkInset";
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
  spec: RunSpec;
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

type SideTab = "scenario" | "inspector" | "network" | "compare" | "help";

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

/** Overlay buttons keep focus off themselves on mouse clicks, so Space afterwards still plays instead of re-firing the button. */
function keepFocus(e: { preventDefault(): void }) {
  e.preventDefault();
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
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

// ---------------------------------------------------------------------------
// The workbench
// ---------------------------------------------------------------------------

export default function TwinWorkbench() {
  const [hash] = useState(() => decodeHash(window.location.hash));
  const [run, setRun] = useState({ dc: hash.dc, week: hash.week, days: hash.days, seed: hash.seed });
  const [building, setBuilding] = useState<BuildingChoice>(() => (hash.src === "session" ? readSessionSpec() : hash.src === "sample" ? { kind: "sample", spec: null, name: "", error: null } : BUILTIN));
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
      shiftIds: form.shifts.length ? form.shifts.map((s) => s.id).filter(Boolean) : init ? init.shifts.map((s) => s.id) : site.shifts.map((s) => s.id),
      supplierIds: world ? world.suppliers.map((s) => s.id) : [],
      categories: world ? [...new Set(world.skus.map((s) => s.category))] : ["traditional"],
      skuCount: world ? world.skus.length : SKU_COUNT,
      pickZone: imported ? null : { aisles: site.pick.aisles, baysPerSide: site.pick.baysPerSide, levels: site.pick.levels, slotsPerBay: site.pick.slotsPerBay },
      std: DEFAULT_STANDARDS,
      imported,
      importEdits,
      setImportEdits,
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

  const options: ViewerOptions = useMemo(() => ({ shadows: true, heat: view.heat, labels: view.labels, dayNight: view.dayNight, quality: view.quality, theme, debugSpeed: false }), [view.heat, view.labels, view.dayNight, view.quality, theme]);

  const hud = useMemo(() => (current ? snapshotAt(current, clock.t) : null), [current, clock.t]);
  const sections = useMemo(() => (current ? describeSelection(selection, current.playback, current.world, clock.t, current.index) : []), [current, selection, clock.t]);
  const canFollow = !!(current && selection?.kind === "entity" && current.playback.tracks[selection.entity]);

  // --- Worker ---
  const latest = useRef<{ onMessage: (m: TwinResponse) => void; onWorkerError: (msg: string) => void }>({ onMessage: () => {}, onWorkerError: () => {} });

  const spawn = () => {
    const w = new Worker(new URL("../twin.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<TwinResponse>) => latest.current.onMessage(e.data);
    w.onerror = (e) => latest.current.onWorkerError(e.message || "The simulation worker failed.");
    workerRef.current = w;
    return w;
  };

  useEffect(() => {
    const w = spawn();
    return () => {
      w.terminate();
      if (workerRef.current === w) workerRef.current = null;
    };
  }, []);

  const startRun = (overrideSpec?: LayoutSpec | null) => {
    const w = workerRef.current;
    if (!w) return;
    setWorkerErrors({});
    const res = formToScenario(form);
    if (!res.scenario) {
      setTab("scenario");
      setSheetOpen(true);
      setStatus({ kind: "error", name: "Form", message: "Fix the highlighted fields first." });
      return;
    }
    const spec = overrideSpec !== undefined ? overrideSpec : building.kind === "builtin" ? null : building.spec;
    if (building.kind !== "builtin" && !spec) {
      setStatus({ kind: "error", name: "Building", message: building.error ?? "The imported building has not loaded yet." });
      return;
    }
    const check = spaceCheck(form, { ...formCtx, imported: spec });
    if (check.error) {
      setTab("scenario");
      setScenarioTab("space");
      setSheetOpen(true);
      setStatus({ kind: "error", name: "LimitError", message: check.error });
      return;
    }
    const scenario: TwinScenario = spec ? { ...res.scenario, layout: applyImportEdits(spec, importEdits) } : res.scenario;
    const runId = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    runIdRef.current = runId;
    const runSpec: RunSpec = { dc: run.dc, startWeek: run.week, days: run.days, seed: run.seed, scenario };
    const req: TwinRequest = { type: "run", runId, spec: runSpec, keepEvents: true };
    setStatus({ kind: "running", phase: "context", day: 0, days: run.days });
    w.postMessage(req);
    try {
      const src: HashSource | undefined = building.kind === "session" ? "session" : building.kind === "sample" ? "sample" : undefined;
      window.history.replaceState(null, "", encodeHash({ dc: run.dc, week: run.week, days: run.days, seed: run.seed, src, scenario: res.scenario }));
      setLinkMsg(null);
    } catch (err) {
      setLinkMsg(err instanceof HashError ? err.message : String(err));
    }
  };

  const cancelRun = () => {
    workerRef.current?.terminate();
    runIdRef.current = "";
    spawn();
    setStatus({ kind: "idle" });
  };

  const loadSample = async (): Promise<LayoutSpec | null> => {
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
    }
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
          startRun(null);
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
        const buildingName = m.world.spec.source.format === "builtin" ? (DC_NAMES[m.world.dc.id] ?? m.world.dc.id) : m.world.spec.name;
        const rec: RunRecord = {
          id: m.runId,
          label: runLabel({ dc: m.world.dc.id, startWeek: init.startWeek, days: init.days, seed: init.seed, scenario: {} }, buildingName),
          spec: { dc: m.world.dc.id, startWeek: init.startWeek, days: init.days, seed: init.seed, scenario: {} },
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
  const onWorkerError = (msg: string) => {
    runIdRef.current = "";
    setStatus({ kind: "error", name: "Worker", message: msg });
  };
  useEffect(() => {
    latest.current = { onMessage, onWorkerError };
  });

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
  const copyLink = async () => {
    try {
      const src: HashSource | undefined = building.kind === "session" ? "session" : building.kind === "sample" ? "sample" : undefined;
      const h = encodeHash({ dc: run.dc, week: run.week, days: run.days, seed: run.seed, t: Math.round(clock.t), src, scenario: parsed.scenario ?? undefined });
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
  };
  const updateForm = (fn: (f: ScenarioForm) => ScenarioForm) => {
    setForm(fn);
    setWorkerErrors({});
  };

  const running = status.kind === "running";
  const progressShare = status.kind === "running" ? (status.phase === "context" ? 0.05 : status.phase === "compile" ? 0.95 : 0.05 + (0.9 * Math.max(0, status.day - 1)) / Math.max(1, status.days)) : 0;
  const buildingName = building.kind === "builtin" ? (DC_NAMES[run.dc] ?? run.dc) : building.name || "imported building";
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
          <span className="twin-chip">{buildingName}</span>
          <span className="twin-chip">week {run.week}</span>
          <span className="twin-chip">
            {run.days} day{run.days === 1 ? "" : "s"}
          </span>
          <span className="twin-chip">seed {run.seed}</span>
          {current && (
            <span className="sub twin-ranin" title={`Context, simulation and playback compile: ${num(current.ms.context)} + ${num(current.ms.simulate)} + ${num(current.ms.compile)} ms`}>
              ran in {num(current.ms.context + current.ms.simulate + current.ms.compile)} ms · {current.playback.jobs.length.toLocaleString("en-US")} jobs · {current.playback.events.length.toLocaleString("en-US")} events
            </span>
          )}
        </span>
        <div className="twin-actions">
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
          <div className="twin-ovl twin-ovl-top">
            <div className="twin-ovl-row">
              <div className="twin-ovl-col left" onMouseDown={keepFocus}>
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
          <div className="twin-ovl twin-ovl-bottom">
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
                ["help", "Help"],
              ] as Array<[SideTab, string]>
            ).map(([id, label]) => (
              <button type="button" key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => showSide(id)}>
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
              runControls={
                <>
                  <BuildingPicker dc={run.dc} dcs={dcs} value={building} disabled={running} onDc={(dc) => setRun((r) => ({ ...r, dc }))} onChange={setBuilding} />
                  <div className="row">
                    <label>
                      Week{" "}
                      <input type="number" min={1} max={52} value={run.week} onChange={(e) => setRun((r) => ({ ...r, week: Math.max(1, Math.min(52, Math.round(Number(e.target.value) || 1))) }))} title="Calendar week the run starts on its Monday (44 is Halloween week)" />
                    </label>
                    <label>
                      Days{" "}
                      <input type="number" min={1} max={28} value={run.days} onChange={(e) => setRun((r) => ({ ...r, days: Math.max(1, Math.min(28, Math.round(Number(e.target.value) || 1))) }))} title="1 to 28 days" />
                    </label>
                    <label>
                      Seed{" "}
                      <input type="number" min={1} value={run.seed} onChange={(e) => setRun((r) => ({ ...r, seed: Math.max(1, Math.round(Number(e.target.value) || 1)) }))} title="Seed 1 replays a tool's first run exactly" />
                    </label>
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
            <div className="twin-tabbody">
              <Inspector title={current ? selectionTitle(selection, current.playback, current.world) : "Nothing selected"} selection={selection} sections={sections} canFollow={canFollow} following={cameraMode === "follow"} onFollow={() => selection?.kind === "entity" && sceneRef.current?.setCamera("follow", selection.entity)} onClear={() => setSelection(null)} />
            </div>
          )}
          {tab === "network" && <div className="twin-tabbody">{current ? <NetworkInset world={current.world} playback={current.playback} index={current.index} t={clock.t} onSelect={selectEntity} /> : <p className="sub">Run a scenario first.</p>}</div>}
          {tab === "compare" && (
            <div className="twin-tabbody">
              <ComparePanel a={previous ? { label: previous.label, kpis: previous.kpis, changes: previous.world.changes } : null} b={current ? { label: current.label, kpis: current.kpis, changes: current.world.changes } : null} onSwap={swapRuns} />
            </div>
          )}
          {tab === "help" && (
            <div className="twin-tabbody">
              <h3>What you are looking at</h3>
              <p>
                A discrete-event simulation of one distribution center runs in a web worker in your browser, records every event, and the playback compiles them into the animation: supplier
                trucks at the inbound doors, forklifts putting pallets away, pickers walking S-shaped tours through the pick module, packing, staging, store trucks leaving at their departure time.
              </p>
              <p>The numbers on the HUD are the engine&apos;s own accounting at the current minute. What the engine never decides (which door, which forklift, where a pallet sits in a lane) the playback picks deterministically and the inspector labels as shown.</p>
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
