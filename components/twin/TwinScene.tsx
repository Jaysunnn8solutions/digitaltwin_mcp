"use client";

import { useEffect, useImperativeHandle, useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type Ref } from "react";
import type { Playback, WorldPayload } from "@/lib/trace/types";
import type { CameraMode, CameraPreset, PickResult, ViewerOptions, ViewerStats } from "@/lib/three/api";
import { isQueueChip, MAX_LABELS, reserveBadgeIndex } from "@/lib/three/labels";
import { createTwinViewer, type TwinViewerImpl } from "@/lib/three/viewer";
import { PROCESSES } from "@/lib/twin/types";
import { PlaybackClock } from "@/lib/twin-ui/clock";
import { SPEEDS } from "@/lib/twin-ui/format";

export interface ClockView {
  t: number;
  playing: boolean;
  speed: number;
  skipQuiet: boolean;
}

/** Keys the scene does not act on itself; the workbench owns that state. */
export type KeyAction = "toggleHeat" | "toggleLabels" | "cycleQuality" | "toggleNight" | "toggleHud" | "toggleMinimap" | "toggleHelp" | "run" | "compare" | "escape" | "tickerPrev" | "tickerNext";

/** Screenshot / performance harness modes from the URL hash. */
export interface ShotMode {
  kind: "shot" | "perf";
  t: number;
  cam?: CameraPreset;
}

export interface TwinSceneHandle {
  seek(t: number): void;
  setPlaying(on: boolean): void;
  togglePlay(): void;
  setSpeed(speed: number): void;
  setSkipQuiet(on: boolean): void;
  step(dMin: number): void;
  preset(p: CameraPreset): void;
  setCamera(mode: CameraMode, target?: number): void;
  /** Point the orbit camera at an engine position on the floor. */
  lookAt(x: number, y: number): void;
  clock(): ClockView;
  stats(): ViewerStats | null;
}

interface Props {
  world: WorldPayload | null;
  playback: Playback | null;
  options: ViewerOptions;
  selection: PickResult | null;
  /** Playback minute to start at when the first playback arrives (from the link). */
  initialT: number;
  shot: ShotMode | null;
  onClock: (c: ClockView) => void;
  onPick: (sel: PickResult | null) => void;
  onSkipped: (gap: [number, number]) => void;
  onAction: (a: KeyAction) => void;
  onCameraMode: (mode: CameraMode) => void;
  ref: Ref<TwinSceneHandle>;
}

const CLOCK_REPORT_MS = 80;
const PERF_FRAMES = 600;

function clockView(c: PlaybackClock): ClockView {
  return { t: c.t, playing: c.playing, speed: c.speed, skipQuiet: c.skipQuiet };
}

/**
 * The canvas, the TwinViewer, the requestAnimationFrame loop driven by a
 * PlaybackClock, the DOM label overlay, pointer picking and the keyboard map.
 * three.js objects live only in refs here; React state lives in the
 * workbench, which receives clock ticks at a throttled rate.
 */
export default function TwinScene({ world, playback, options, selection, initialT, shot, onClock, onPick, onSkipped, onAction, onCameraMode, ref }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<TwinViewerImpl | null>(null);
  const clockRef = useRef<PlaybackClock | null>(null);
  if (clockRef.current === null) clockRef.current = new PlaybackClock(0);
  const modeRef = useRef<CameraMode>("orbit");
  const dprOverride = useRef<number | null>(null);
  const stopped = useRef(false);
  const initialApplied = useRef(false);
  const perf = useRef<{ frames: number; ms: number; active: boolean }>({ frames: 0, ms: 0, active: false });
  const pointer = useRef<{ x: number; y: number; at: number } | null>(null);
  const labelPool = useRef<HTMLDivElement[]>([]);
  const renderLabelsRef = useRef<() => void>(() => {});
  const latest = useRef({ world, playback, options, selection, initialT, shot, onClock, onPick, onSkipped, onAction, onCameraMode });
  useEffect(() => {
    latest.current = { world, playback, options, selection, initialT, shot, onClock, onPick, onSkipped, onAction, onCameraMode };
  });

  // Mount: renderer, resize, animation loop, keyboard. Strict Mode runs this twice; dispose() and the cleanup make that harmless.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const clock = clockRef.current;
    if (!canvas || !stage || !clock) return;
    const viewer = createTwinViewer(latest.current.options);
    viewer.mount(canvas);
    viewer.onInspect = (r) => latest.current.onPick(r);
    viewerRef.current = viewer;
    stopped.current = false;

    const size = () => {
      const r = stage.getBoundingClientRect();
      viewer.resize(r.width, r.height, dprOverride.current ?? window.devicePixelRatio ?? 1);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(stage);

    let reported: ClockView = { t: -1, playing: false, speed: 0, skipQuiet: true };
    let lastReport = 0;
    // Transport changes reach the workbench at once; a moving playhead at most every CLOCK_REPORT_MS.
    const report = (now: number, force = false) => {
      const v = clockView(clock);
      const transportChanged = v.playing !== reported.playing || v.speed !== reported.speed || v.skipQuiet !== reported.skipQuiet;
      if (!force && !transportChanged && (now - lastReport < CLOCK_REPORT_MS || v.t === reported.t)) return;
      reported = v;
      lastReport = now;
      latest.current.onClock(v);
    };

    const renderLabels = () => {
      const host = labelsRef.current;
      if (!host) return;
      const list = viewer.labels();
      const pool = labelPool.current;
      const sel = latest.current.selection;
      const selEntity = sel?.kind === "entity" ? sel.entity : sel?.kind === "queue" ? -1 - PROCESSES.indexOf(sel.process) : null;
      for (let i = 0; i < list.length && i < MAX_LABELS; i++) {
        let el = pool[i];
        if (!el) {
          el = document.createElement("div");
          host.appendChild(el);
          pool[i] = el;
        }
        const l = list[i];
        const kind = isQueueChip(l.entity) ? "queue" : l.entity < 0 ? "badge" : "actor";
        el.className = `twin-label ${kind}${selEntity !== null && l.entity === selEntity ? " selected" : ""}`;
        el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px) translate(-50%, -100%)`;
        el.style.opacity = l.depth > 400 ? "0.6" : "1";
        if (el.textContent !== l.text) el.textContent = l.text;
        el.dataset.entity = String(l.entity);
        el.hidden = false;
      }
      for (let i = list.length; i < pool.length; i++) pool[i].hidden = true;
    };
    renderLabelsRef.current = renderLabels;

    let last = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      if (stopped.current) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      const L = latest.current;
      const tick = clock.tick(dt, L.playback?.quiet ?? null);
      if (tick.skipped) {
        viewer.seek(clock.t);
        L.onSkipped(tick.skipped);
      }
      viewer.frame(clock.t, dt);
      renderLabels();
      const p = perf.current;
      if (p.active && L.playback) {
        p.frames++;
        p.ms += viewer.stats().frameMs;
        if (p.frames >= PERF_FRAMES) {
          const s = viewer.stats();
          p.active = false;
          clock.playing = false;
          (window as unknown as { __twinPerf?: unknown }).__twinPerf = { frameMs: p.ms / p.frames, drawCalls: s.drawCalls, triangles: s.triangles };
          document.title = "twin:perf";
        }
      }
      report(now);
    };
    raf = requestAnimationFrame(loop);

    const setMode = (mode: CameraMode, target?: number) => {
      viewer.setCamera(mode, target);
      modeRef.current = mode;
      latest.current.onCameraMode(mode);
      stage.classList.toggle("walking", mode === "walk");
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      // A button reached by Tab activates on Space/Enter itself; toggling play on top of that would fire both.
      // (Mouse clicks on the toolbars never leave focus there: they prevent default on mousedown.)
      if (target && target.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
      if (e.metaKey || e.ctrlKey) return;
      const L = latest.current;
      const horizon = clock.horizonEnd;
      let handled = true;
      const stepMin = e.altKey ? 1440 : e.shiftKey ? 60 : 1;
      switch (e.key) {
        case " ":
          if (L.playback) {
            if (!clock.playing && clock.t >= horizon) {
              clock.seek(0);
              viewer.seek(0);
            }
            clock.playing = !clock.playing;
          }
          break;
        case "ArrowLeft":
          clock.step(-stepMin);
          viewer.seek(clock.t);
          break;
        case "ArrowRight":
          clock.step(stepMin);
          viewer.seek(clock.t);
          break;
        case "Home":
          clock.seek(0);
          viewer.seek(0);
          break;
        case "End":
          clock.seek(horizon);
          viewer.seek(horizon);
          break;
        case ",": {
          const i = Math.max(0, SPEEDS.indexOf(clock.speed as (typeof SPEEDS)[number]) - 1);
          clock.speed = SPEEDS[i];
          break;
        }
        case ".": {
          const i = Math.min(SPEEDS.length - 1, SPEEDS.indexOf(clock.speed as (typeof SPEEDS)[number]) + 1);
          clock.speed = SPEEDS[i];
          break;
        }
        case "0":
          clock.skipQuiet = !clock.skipQuiet;
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          const presets: CameraPreset[] = ["overview", "dock", "pick", "reserve", "yard"];
          viewer.preset(presets[Number(e.key) - 1]);
          modeRef.current = "orbit";
          L.onCameraMode("orbit");
          stage.classList.remove("walking");
          break;
        }
        case "o":
        case "O":
          setMode("orbit");
          break;
        case "f":
        case "F": {
          const sel = L.selection;
          if (sel?.kind === "entity" && L.playback?.tracks[sel.entity]) setMode("follow", sel.entity);
          else handled = false;
          break;
        }
        case "t":
        case "T":
          setMode("walk");
          break;
        case "Escape":
          if (modeRef.current === "walk") setMode("orbit");
          L.onAction("escape");
          break;
        case "[":
          L.onAction("tickerPrev");
          break;
        case "]":
          L.onAction("tickerNext");
          break;
        case "g":
        case "G":
          L.onAction("toggleHeat");
          break;
        case "l":
        case "L":
          L.onAction("toggleLabels");
          break;
        case "q":
        case "Q":
          L.onAction("cycleQuality");
          break;
        case "n":
        case "N":
          L.onAction("toggleNight");
          break;
        case "h":
        case "H":
          L.onAction("toggleHud");
          break;
        case "m":
        case "M":
          L.onAction("toggleMinimap");
          break;
        case "?":
          L.onAction("toggleHelp");
          break;
        case "r":
        case "R":
          L.onAction("run");
          break;
        case "c":
        case "C":
          L.onAction("compare");
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        report(performance.now(), true);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      stopped.current = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      ro.disconnect();
      viewer.dispose();
      viewerRef.current = null;
      renderLabelsRef.current = () => {};
      for (const el of labelPool.current) el.remove();
      labelPool.current = [];
      stage.classList.remove("walking");
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !world) return;
    // Unbind the old playback first: the new one is bound by the effect below in the same commit.
    viewer.setPlayback(null);
    viewer.setWorld(world);
  }, [world]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const clock = clockRef.current;
    const stage = stageRef.current;
    if (!viewer || !clock) return;
    viewer.setPlayback(playback);
    const L = latest.current;
    if (!playback) {
      clock.horizonEnd = 0;
      clock.seek(0);
      clock.playing = false;
      L.onClock(clockView(clock));
      return;
    }
    clock.horizonEnd = playback.meta.horizonEnd;
    if (!initialApplied.current) {
      initialApplied.current = true;
      clock.seek(L.initialT);
    } else clock.seek(clock.t);
    viewer.seek(clock.t);
    const shotMode = L.shot;
    if (shotMode?.kind === "shot") {
      // One deterministic frame: DPR 1, no sun or shadows, at the requested minute and preset, then stop.
      viewer.setOptions({ dayNight: false, shadows: false });
      dprOverride.current = 1;
      if (stage) {
        const r = stage.getBoundingClientRect();
        viewer.resize(r.width, r.height, 1);
      }
      clock.seek(shotMode.t);
      clock.playing = false;
      viewer.seek(clock.t);
      if (shotMode.cam) viewer.preset(shotMode.cam);
      viewer.frame(clock.t, 0);
      viewer.frame(clock.t, 0);
      renderLabelsRef.current();
      stopped.current = true;
      L.onClock(clockView(clock));
      document.title = "twin:ready";
      return;
    }
    if (shotMode?.kind === "perf") {
      clock.seek(shotMode.t);
      clock.speed = 300;
      perf.current = { frames: 0, ms: 0, active: true };
    }
    clock.playing = true;
    L.onClock(clockView(clock));
  }, [playback]);

  useEffect(() => {
    viewerRef.current?.setOptions(options);
  }, [options]);

  useEffect(() => {
    viewerRef.current?.setSelection(selection);
  }, [selection]);

  useImperativeHandle(
    ref,
    (): TwinSceneHandle => {
      const clock = clockRef.current!;
      const push = () => latest.current.onClock(clockView(clock));
      const setPlaying = (on: boolean) => {
        // Play at the end restarts from the beginning.
        if (on && clock.horizonEnd > 0 && clock.t >= clock.horizonEnd) {
          clock.seek(0);
          viewerRef.current?.seek(0);
        }
        clock.playing = on && clock.horizonEnd > 0;
        push();
      };
      return {
        seek(t) {
          clock.seek(t);
          viewerRef.current?.seek(clock.t);
          push();
        },
        setPlaying,
        togglePlay() {
          setPlaying(!clock.playing);
        },
        setSpeed(speed) {
          clock.speed = speed;
          push();
        },
        setSkipQuiet(on) {
          clock.skipQuiet = on;
          push();
        },
        step(dMin) {
          clock.step(dMin);
          viewerRef.current?.seek(clock.t);
          push();
        },
        preset(p) {
          viewerRef.current?.preset(p);
          modeRef.current = "orbit";
          stageRef.current?.classList.remove("walking");
          latest.current.onCameraMode("orbit");
        },
        setCamera(mode, target) {
          viewerRef.current?.setCamera(mode, target);
          modeRef.current = mode;
          stageRef.current?.classList.toggle("walking", mode === "walk");
          latest.current.onCameraMode(mode);
        },
        lookAt(x, y) {
          const viewer = viewerRef.current;
          if (!viewer) return;
          if (modeRef.current !== "orbit") {
            viewer.setCamera("orbit");
            modeRef.current = "orbit";
            stageRef.current?.classList.remove("walking");
            latest.current.onCameraMode("orbit");
          }
          viewer.lookAt(x, y);
        },
        clock: () => clockView(clock),
        stats: () => viewerRef.current?.stats() ?? null,
      };
    },
    []
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointer.current = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p || modeRef.current === "walk") return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6 || performance.now() - p.at > 600) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -((e.clientY - r.top) / r.height) * 2 + 1;
    onPick(viewer.pick(ndcX, ndcY));
  };
  const onLabelClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".twin-label");
    if (!el) return;
    const entity = Number(el.dataset.entity);
    if (!Number.isFinite(entity)) return;
    if (isQueueChip(entity)) onPick({ kind: "queue", process: PROCESSES[-1 - entity] });
    else if (entity < 0) onPick({ kind: "reserve", index: reserveBadgeIndex(entity) });
    else onPick({ kind: "entity", entity });
  };

  return (
    <div ref={stageRef} className="twin-stage-inner" style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onContextMenu={(e) => e.preventDefault()} tabIndex={0} aria-label="3D view of the distribution center" />
      <div ref={labelsRef} className="twin-labels" onClick={onLabelClick} />
    </div>
  );
}
