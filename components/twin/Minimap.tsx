"use client";

import { useMemo, type MouseEvent } from "react";
import { floorSvg, floorTransform } from "@/lib/render/floor";
import type { Playback, WorldPayload } from "@/lib/trace/types";
import type { PickResult } from "@/lib/three/api";
import { actorsAt } from "@/lib/twin-ui/describe";

const WIDTH = 320;

const DOT_COLORS: Record<string, string> = {
  worker: "#1c7ed6",
  forklift: "#f08c00",
  jack: "#0ca678",
  truckIn: "#2f9e44",
  truckOut: "#d9480f",
  pallet: "#8b5e3c",
};

interface Props {
  world: WorldPayload;
  playback: Playback | null;
  t: number;
  selection: PickResult | null;
  /** A click on the floor: engine feet. */
  onLookAt: (x: number, y: number) => void;
  onSelect: (entity: number) => void;
}

/** The 2D floor plan (lib/render/floor.ts) with live actor dots drawn through the same transform; click = orbit target. */
export default function Minimap({ world, playback, t, selection, onLookAt, onSelect }: Props) {
  const svg = useMemo(() => floorSvg(world.spec, { width: WIDTH, layout: world.layout }), [world]);
  const tf = useMemo(() => floorTransform(world.spec, WIDTH), [world]);
  const dots = useMemo(() => (playback ? actorsAt(playback, t) : []), [playback, t]);
  const selected = selection?.kind === "entity" ? selection.entity : -1;

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const px = ((e.clientX - box.left) / box.width) * tf.width;
    const py = ((e.clientY - box.top) / box.height) * tf.height;
    // A dot within a few pixels wins over the floor.
    let best = -1;
    let bestD = 7 * (tf.width / box.width);
    for (const d of dots) {
      const dx = tf.X(d.x) - px;
      const dy = tf.Y(d.y) - py;
      const dist = Math.hypot(dx, dy);
      if (dist < bestD) {
        bestD = dist;
        best = d.entity;
      }
    }
    if (best >= 0) onSelect(best);
    else {
      const [x, y] = tf.toFeet(px, py);
      onLookAt(x, y);
    }
  };

  return (
    <div className="twin-overlay twin-minimap" title="Click to look there; click a dot to select it">
      <div className="wrap" onClick={onClick}>
        <div dangerouslySetInnerHTML={{ __html: svg }} />
        <svg className="dots" viewBox={`0 0 ${tf.width} ${tf.height}`} aria-hidden="true">
          {dots.map((d) => {
            const r = d.kind === "truckIn" || d.kind === "truckOut" ? 4.5 : 3;
            return <circle key={d.entity} cx={tf.X(d.x)} cy={tf.Y(d.y)} r={r} fill={DOT_COLORS[d.kind] ?? "#888"} stroke={d.entity === selected ? "#ffd43b" : "#fff"} strokeWidth={d.entity === selected ? 2 : 0.8} />;
          })}
        </svg>
      </div>
    </div>
  );
}
