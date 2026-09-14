"use client";

import { useMemo } from "react";
import type { Playback, TickerEvent } from "@/lib/trace/types";
import { upperBound } from "@/lib/trace/search";
import { clockOf, dayOf } from "@/lib/twin-ui/format";

interface Props {
  playback: Playback;
  t: number;
  lines?: number;
  onSelect: (entity: number) => void;
  onSeek: (t: number) => void;
}

/** The last few ticker lines at or before t; clicking one selects its entity and seeks to it. */
export default function Ticker({ playback, t, lines = 5, onSelect, onSeek }: Props) {
  const times = useMemo(() => Float64Array.from(playback.ticker, (e) => e.t), [playback]);
  const end = upperBound(times, t);
  const shown: TickerEvent[] = [];
  for (let i = end - 1; i >= 0 && shown.length < lines; i--) shown.push(playback.ticker[i]);
  if (shown.length === 0) return null;
  const day = dayOf(t);
  return (
    <div className="twin-overlay twin-ticker" aria-live="polite">
      <ol>
        {shown.map((e, i) => (
          <li
            key={e.ev}
            className={`s${e.severity}${i === 0 ? " latest" : ""}`}
            onClick={() => {
              if (e.entity >= 0) onSelect(e.entity);
              else onSeek(e.t);
            }}
            title={e.entity >= 0 ? "Select" : "Seek to this event"}
          >
            <time>{dayOf(e.t) === day ? clockOf(e.t) : `d${dayOf(e.t) + 1} ${clockOf(e.t)}`}</time>
            <span>{e.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Index of the next (dir > 0) or previous notable (severity ≥ 1) ticker event from t, or -1. */
export function notableFrom(playback: Playback, t: number, dir: 1 | -1): number {
  const ticker = playback.ticker;
  if (dir > 0) {
    for (let i = 0; i < ticker.length; i++) if (ticker[i].t > t + 1e-6 && ticker[i].severity >= 1) return i;
  } else {
    for (let i = ticker.length - 1; i >= 0; i--) if (ticker[i].t < t - 1e-6 && ticker[i].severity >= 1) return i;
  }
  return -1;
}
