"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { hhmm, shiftPaidHours, WEEKDAYS } from "@/lib/twin/standards";
import { PROCESSES } from "@/lib/twin/types";
import type { Playback, TraceInit } from "@/lib/trace/types";
import { clockOf, dayClock, minutes, SPEEDS, speedLabel } from "@/lib/twin-ui/format";

interface Props {
  playback: Playback | null;
  /** The previous run (compare A): its strips are drawn under B's. */
  compare: Playback | null;
  t: number;
  playing: boolean;
  speed: number;
  skipQuiet: boolean;
  onSeek: (t: number) => void;
  onTogglePlay: () => void;
  onSpeed: (speed: number) => void;
  onSkipQuiet: (on: boolean) => void;
  onStep: (dMin: number) => void;
  /** The legend popover; the workbench owns it so Escape closes it with the other overlays. */
  legendOpen: boolean;
  onLegend: (open: boolean) => void;
}

const H_DAYS = 16;
const H_STRIP = 24;
const H_MARK = 16;
const H_CMP = 14;

interface StripData {
  /** Per pixel column: max total queue in the column's bins, 0..1 of the run's max. */
  queue: Float32Array;
  lates: Array<{ x: number; h: number }>;
}

function stripFor(pb: Playback, v0: number, v1: number, width: number): StripData {
  const bins = pb.queueBins;
  const n = PROCESSES.length;
  const totals = new Float32Array(bins.count);
  let max = 1;
  for (let b = 0; b < bins.count; b++) {
    let s = 0;
    for (let p = 0; p < n; p++) s += bins.queues[b * n + p];
    totals[b] = s;
    if (s > max) max = s;
  }
  const w = Math.max(1, Math.floor(width));
  const queue = new Float32Array(w);
  const span = Math.max(1e-6, v1 - v0);
  for (let c = 0; c < w; c++) {
    const b0 = Math.max(0, Math.floor((v0 + (c / w) * span) / bins.binMin));
    const b1 = Math.min(bins.count, Math.max(b0 + 1, Math.ceil((v0 + ((c + 1) / w) * span) / bins.binMin)));
    let m = 0;
    for (let b = b0; b < b1; b++) if (totals[b] > m) m = totals[b];
    queue[c] = m / max;
  }
  const lates: Array<{ x: number; h: number }> = [];
  for (const e of pb.events) {
    if (e.k !== "truckLoaded" || e.lateMin <= 0) continue;
    if (e.t < v0 || e.t > v1) continue;
    lates.push({ x: ((e.t - v0) / span) * w, h: Math.min(1, e.lateMin / 240) });
  }
  return { queue, lates };
}

/** Day bands, shift shading, hour ticks, queue-pressure and late strips, event markers; wheel zooms, drag scrubs. */
export default function Timeline({ playback, compare, t, playing, speed, skipQuiet, onSeek, onTogglePlay, onSpeed, onSkipQuiet, onStep, legendOpen, onLegend }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(800);
  const [win, setWin] = useState<[number, number] | null>(null);
  const dragging = useRef(false);
  // The wheel handler must be non-passive to keep the page from scrolling while zooming; React's own wheel listener is passive.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});

  useEffect(() => {
    const el = boxRef.current;
    const svg = svgRef.current;
    if (!el || !svg) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.floor(w));
    });
    ro.observe(el);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelRef.current(e);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      svg.removeEventListener("wheel", onWheel);
    };
  }, []);

  const horizon = playback?.meta.horizonEnd ?? 1440;
  const init = playback?.events[0]?.k === "init" ? (playback.events[0] as TraceInit) : null;
  // Keep the playhead in view while playing by sliding the zoomed window.
  let [v0, v1] = win ?? [0, horizon];
  if (v1 > horizon || win === null) [v0, v1] = [0, horizon];
  if (t > v1 || t < v0) {
    const span = v1 - v0;
    v0 = Math.max(0, Math.min(horizon - span, t - span * 0.2));
    v1 = v0 + span;
  }
  const span = Math.max(1, v1 - v0);
  const X = (m: number) => ((m - v0) / span) * width;
  const M = (x: number) => v0 + (x / width) * span;

  const stripB = useMemo(() => (playback ? stripFor(playback, v0, v1, width) : null), [playback, v0, v1, width]);
  const stripA = useMemo(() => (compare ? stripFor(compare, v0, v1, width) : null), [compare, v0, v1, width]);

  const days = Math.ceil(horizon / 1440);
  const hourStep = span > 5 * 1440 ? 0 : span > 2 * 1440 ? 6 : span > 600 ? 3 : 1;
  const totalH = H_DAYS + H_STRIP + H_MARK + (compare ? H_CMP : 0);

  const seekAt = (e: ReactPointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width, e.clientX - box.left));
    onSeek(Math.max(0, Math.min(horizon, M((x / box.width) * width))));
  };
  const onWheel = (e: WheelEvent) => {
    const svg = svgRef.current;
    if (!playback || !svg) return;
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * width;
    const at = M(x);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = ((e.deltaX || e.deltaY) / width) * span;
      const n0 = Math.max(0, Math.min(horizon - span, v0 + d));
      setWin([n0, n0 + span]);
      return;
    }
    const factor = Math.exp(e.deltaY * 0.0015);
    const next = Math.min(horizon, Math.max(120, span * factor));
    let n0 = at - ((at - v0) / span) * next;
    n0 = Math.max(0, Math.min(horizon - next, n0));
    setWin(next >= horizon ? null : [n0, n0 + next]);
  };
  useEffect(() => {
    wheelRef.current = onWheel;
  });

  const markers = useMemo(() => {
    if (!playback) return [];
    const X = (m: number) => ((m - v0) / span) * width;
    const out: Array<{ key: string; x: number; cls: string; title: string; w?: number }> = [];
    for (const e of playback.ticker) {
      if (e.t < v0 || e.t > v1) continue;
      if (e.kind === "truckArrive") out.push({ key: `a${e.ev}`, x: X(e.t), cls: "arrive", title: e.text });
      else if (e.kind === "truckLoaded") out.push({ key: `l${e.ev}`, x: X(e.t), cls: e.severity === 2 ? "late" : "depart", title: e.text });
      else if (e.kind === "worker" && e.severity === 2) out.push({ key: `w${e.ev}`, x: X(e.t), cls: "absent", title: e.text });
    }
    for (const e of playback.events) {
      if (e.k !== "wms" || !e.down) continue;
      const until = e.until ?? e.t;
      if (until < v0 || e.t > v1) continue;
      out.push({ key: `wms${e.t}`, x: X(Math.max(v0, e.t)), w: Math.max(2, X(Math.min(v1, until)) - X(Math.max(v0, e.t))), cls: "wms", title: `WMS down ${clockOf(e.t)}–${clockOf(until)}` });
    }
    if (init) {
      const bands = [...init.outages.forklifts.map((o) => ({ ...o, what: "forklift" })), ...init.outages.inDoors.map((o) => ({ ...o, what: "inbound door" })), ...init.outages.outDoors.map((o) => ({ ...o, what: "outbound door" }))];
      for (const o of bands) {
        const a = o.fromDay * 1440;
        const b = (o.toDay + 1) * 1440;
        if (b < v0 || a > v1) continue;
        out.push({ key: `o${o.what}${a}`, x: X(Math.max(v0, a)), w: Math.max(2, X(Math.min(v1, b)) - X(Math.max(v0, a))), cls: "outage", title: `${o.count} ${o.what}${o.count === 1 ? "" : "s"} out, days ${o.fromDay + 1}–${o.toDay + 1}` });
      }
    }
    return out;
  }, [playback, init, v0, v1, span, width]);

  const shifts = useMemo(() => {
    if (!init) return [];
    const X = (m: number) => ((m - v0) / span) * width;
    const out: Array<{ x: number; w: number; key: string }> = [];
    const operating = new Set(init.operatingDays);
    for (let d = 0; d < days; d++) {
      if (!operating.has((d % 7) + 1)) continue;
      for (const sh of init.shifts) {
        const a = d * 1440 + hhmm(sh.start);
        const b = a + shiftPaidHours(sh.start, sh.end) * 60;
        if (b < v0 || a > v1) continue;
        out.push({ key: `${d}-${sh.id}`, x: X(Math.max(v0, a)), w: X(Math.min(v1, b)) - X(Math.max(v0, a)) });
      }
    }
    return out;
  }, [init, days, v0, v1, span, width]);

  const quiet = useMemo(() => {
    if (!playback) return [];
    const X = (m: number) => ((m - v0) / span) * width;
    const out: Array<{ x: number; w: number; key: number }> = [];
    const q = playback.quiet;
    for (let i = 0; i < q.t0.length; i++) {
      if (q.t1[i] < v0 || q.t0[i] > v1) continue;
      out.push({ key: i, x: X(Math.max(v0, q.t0[i])), w: X(Math.min(v1, q.t1[i])) - X(Math.max(v0, q.t0[i])) });
    }
    return out;
  }, [playback, v0, v1, span, width]);

  const yStrip = H_DAYS;
  const yMark = H_DAYS + H_STRIP;
  const yCmp = yMark + H_MARK;

  return (
    <div className="twin-timeline">
      {/* A mouse click on a transport button leaves focus where it was, so Space still plays afterwards instead of re-firing "+1 min"; Tab focus and the checkbox's click are unaffected. */}
      <div className="twin-transport" onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className="play primary" onClick={onTogglePlay} disabled={!playback} title="Space">
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button type="button" onClick={() => onStep(-60)} disabled={!playback} title="Shift+←: an hour back">
          −1 h
        </button>
        <button type="button" onClick={() => onStep(-1)} disabled={!playback} title="←">
          −1 min
        </button>
        <button type="button" onClick={() => onStep(1)} disabled={!playback} title="→">
          +1 min
        </button>
        <button type="button" onClick={() => onStep(60)} disabled={!playback} title="Shift+→: an hour forward">
          +1 h
        </button>
        <span className="speeds" title=", and . change speed">
          {SPEEDS.map((s) => (
            <button type="button" key={s} className={s === speed ? "on" : ""} onClick={() => onSpeed(s)}>
              {speedLabel(s)}
            </button>
          ))}
        </span>
        <label title="0 toggles">
          <input type="checkbox" checked={skipQuiet} onChange={(e) => onSkipQuiet(e.target.checked)} /> skip quiet hours
        </label>
        <span className="spacer" />
        <span className="time">{playback ? dayClock(t) : "No run yet"}</span>
        {win && (
          <button type="button" className="chip" onClick={() => setWin(null)}>
            Zoom out
          </button>
        )}
        <span className="twin-legendwrap">
          <button type="button" className="chip" onClick={() => onLegend(!legendOpen)} aria-expanded={legendOpen} title="What the strips and marks mean">
            ?
          </button>
          {legendOpen && playback && (
            <div className="twin-overlay twin-legendpop" role="note">
              Drag to scrub, wheel to zoom, Shift+wheel to pan. Blue: jobs waiting; red bars: a truck loaded late (height = minutes late up to 4 h); ▲ supplier truck arrives, ▼ store truck loaded, ○
              absence, red band WMS down, amber band equipment out. Grey: quiet hours ({playback.quiet.t0.length} gaps{skipQuiet ? ", skipped" : ""}). Horizon {minutes(horizon)}.
              {compare ? " The A row is the previous run's queue and late strips." : ""}
            </div>
          )}
        </span>
      </div>
      <div ref={boxRef}>
        <svg
          ref={svgRef}
          className="twin-strip"
          width={width}
          height={totalH}
          viewBox={`0 0 ${width} ${totalH}`}
          onPointerDown={(e) => {
            if (!playback) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekAt(e);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekAt(e);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          role="slider"
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={horizon}
          aria-valuenow={Math.round(t)}
          aria-valuetext={dayClock(t)}
        >
          {Array.from({ length: days }, (_, d) => {
            const a = d * 1440;
            const b = Math.min(horizon, a + 1440);
            if (b < v0 || a > v1) return null;
            const x = X(Math.max(v0, a));
            const w = X(Math.min(v1, b)) - x;
            return (
              <g key={d}>
                <rect x={x} y={0} width={w} height={totalH} className={d % 2 ? "day-b" : "day-a"} />
                {w > 34 && (
                  <text x={x + 4} y={11}>
                    {w > 90 ? `Day ${d + 1} · ${WEEKDAYS[d % 7]}` : WEEKDAYS[d % 7]}
                  </text>
                )}
              </g>
            );
          })}
          {quiet.map((q) => (
            <rect key={q.key} x={q.x} y={yStrip} width={q.w} height={H_STRIP} className="quiet" />
          ))}
          {shifts.map((s) => (
            <rect key={s.key} x={s.x} y={yStrip} width={s.w} height={H_STRIP} className="shift" />
          ))}
          {hourStep > 0 &&
            Array.from({ length: Math.ceil(span / 60) + 2 }, (_, i) => {
              const h = Math.floor(v0 / 60) + i;
              if (h % hourStep !== 0) return null;
              const m = h * 60;
              if (m < v0 || m > v1) return null;
              return (
                <g key={h}>
                  <line x1={X(m)} y1={H_DAYS} x2={X(m)} y2={H_DAYS + 4} className="hour" />
                  {span < 1440 * 1.5 && h % (hourStep * 2) === 0 && (
                    <text x={X(m) + 2} y={H_DAYS + 10}>
                      {String(h % 24).padStart(2, "0")}
                    </text>
                  )}
                </g>
              );
            })}
          {stripA &&
            Array.from(stripA.queue, (v, c) => (v > 0.02 ? <rect key={`qa${c}`} x={c} y={yCmp + H_CMP - Math.max(1, v * (H_CMP - 2))} width={1} height={Math.max(1, v * (H_CMP - 2))} fill="#9aa5b1" opacity={0.7} /> : null))}
          {stripA?.lates.map((l, i) => <rect key={`la${i}`} x={l.x - 1} y={yCmp} width={2} height={H_CMP} className="late" opacity={0.5} />)}
          {stripB && Array.from(stripB.queue, (v, c) => (v > 0.02 ? <rect key={`q${c}`} x={c} y={yStrip + H_STRIP - Math.max(1, v * (H_STRIP - 2))} width={1} height={Math.max(1, v * (H_STRIP - 2))} fill="#1c7ed6" opacity={0.75} /> : null))}
          {markers.map((m) =>
            m.w !== undefined ? (
              <rect key={m.key} x={m.x} y={yMark} width={m.w} height={H_MARK} className={m.cls}>
                <title>{m.title}</title>
              </rect>
            ) : m.cls === "arrive" ? (
              <polygon key={m.key} points={`${m.x - 4},${yMark + 12} ${m.x + 4},${yMark + 12} ${m.x},${yMark + 3}`} className="arrive">
                <title>{m.title}</title>
              </polygon>
            ) : m.cls === "absent" ? (
              <circle key={m.key} cx={m.x} cy={yMark + 8} r={3.5} className="absent">
                <title>{m.title}</title>
              </circle>
            ) : (
              <polygon key={m.key} points={`${m.x - 4},${yMark + 3} ${m.x + 4},${yMark + 3} ${m.x},${yMark + 12}`} className={m.cls}>
                <title>{m.title}</title>
              </polygon>
            )
          )}
          {stripB?.lates.map((l, i) => <rect key={`lb${i}`} x={l.x - 1} y={yStrip + H_STRIP - Math.max(3, l.h * H_STRIP)} width={2} height={Math.max(3, l.h * H_STRIP)} className="late" />)}
          <text x={4} y={yStrip + 9} className="rowlabel">
            queue
          </text>
          <text x={4} y={yMark + 11} className="rowlabel">
            events
          </text>
          {compare && (
            <text x={4} y={yCmp + 10} className="rowlabel">
              A
            </text>
          )}
          {playback && <line x1={X(t)} y1={0} x2={X(t)} y2={totalH} className="playhead" />}
          {playback && (
            <text x={Math.min(width - 60, X(t) + 4)} y={totalH - 3}>
              {clockOf(t)}
              {playing ? "" : " ⏸"}
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
