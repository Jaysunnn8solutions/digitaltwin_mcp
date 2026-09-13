/**
 * The floor plan as an SVG string, from a layout spec: outline, walls and
 * zones from the drawing, rack runs (pick, reserve, mixed), dock doors, and,
 * when a built layout is given, the aisles, the pick depot and pick faces
 * shaded by a per-location value such as lines per week. Pure and free of
 * Node APIs, so the browser renders import previews with the same code.
 * Colors come from CSS custom properties with fallbacks.
 */

import type { Layout } from "../twin/layout";
import type { LayoutSpec } from "../layout/spec";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Sequential ramp from pale to deep, t in [0, 1]. */
function heat(t: number): string {
  const stops = [
    [237, 244, 250],
    [158, 202, 225],
    [66, 146, 198],
    [8, 81, 156],
    [8, 48, 107],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const f1 = (x: number) => Math.round(x * 10) / 10;

export interface FloorOptions {
  width?: number;
  layout?: Layout;
  /** Location id → value, shaded on pick faces summed per bay. */
  heat?: Map<string, number>;
  heatLabel?: string;
}

export function floorSvg(spec: LayoutSpec, opts: FloorOptions = {}): string {
  const W = spec.widthFt;
  const D = spec.depthFt;
  const pad = Math.max(14, Math.max(W, D) * 0.03);
  const scale = (opts.width ?? 640) / (W + 2 * pad);
  const X = (x: number) => f1((x + pad) * scale);
  // Dock wall at the bottom of the drawing.
  const Y = (y: number) => f1((D - y + pad) * scale);
  const parts: string[] = [];
  const poly = (pts: Array<[number, number]>, attrs: string, close: boolean) =>
    `<${close ? "polygon" : "polyline"} points="${pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")}" ${attrs}/>`;

  if (spec.outline.length >= 3) parts.push(poly(spec.outline, `fill="var(--floor-bg, #fafaf7)" stroke="var(--floor-line, #444)" stroke-width="1.5"`, true));
  else parts.push(`<rect x="${X(0)}" y="${Y(D)}" width="${f1(W * scale)}" height="${f1(D * scale)}" fill="var(--floor-bg, #fafaf7)" stroke="var(--floor-line, #444)" stroke-width="1.5"/>`);
  for (const z of spec.zones) {
    if (z.ring.length < 3) continue;
    const fill = z.kind === "staging" ? "var(--staging, rgba(217,72,15,0.06))" : "var(--zone, rgba(120,120,110,0.08))";
    parts.push(`<polygon points="${z.ring.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")}" fill="${fill}" stroke="none"><title>${esc(z.name)}</title></polygon>`);
  }
  for (const w of spec.walls) {
    if (w.length >= 2) parts.push(poly(w, `fill="none" stroke="var(--floor-line, #444)" stroke-width="1"`, false));
  }

  // Aisles, faintly, so imported buildings show how the twin read the racks.
  if (opts.layout) {
    for (const a of [...opts.layout.reserveAisles, ...opts.layout.pickAisles]) {
      parts.push(`<line x1="${X(a.x)}" y1="${Y(a.y0)}" x2="${X(a.x)}" y2="${Y(a.y1)}" stroke="var(--aisle, #9aa5b1)" stroke-width="0.6" stroke-dasharray="3 3"/>`);
    }
  }

  // Rack runs.
  const runFill = { reserve: "var(--rack, #c9c3b6)", pick: "var(--pick, #b7c9d6)", mixed: "var(--mixed, #c8c0d8)" };
  for (const r of spec.racks) {
    parts.push(
      `<rect x="${X(r.x - r.depthFt / 2)}" y="${Y(r.y1)}" width="${f1(Math.max(0.8, r.depthFt * scale))}" height="${f1((r.y1 - r.y0) * scale)}" fill="${runFill[r.use]}"><title>${esc(`${r.id}: ${r.use}, ${r.bays} bays × ${r.levels} levels${r.slotsPerBay > 1 ? ` × ${r.slotsPerBay} slots` : ""}`)}</title></rect>`
    );
  }

  // Heat on pick faces, summed per bay across levels.
  if (opts.layout && opts.heat && opts.heat.size) {
    const L = opts.layout;
    const bays = new Map<string, { loc: (typeof L.pick)[number]; v: number }>();
    for (const loc of L.pick) {
      const key = `${loc.aisle}-${loc.side}-${loc.bay}`;
      const b = bays.get(key) ?? { loc, v: 0 };
      b.v += opts.heat.get(loc.id) ?? 0;
      bays.set(key, b);
    }
    const maxV = Math.max(1e-9, ...[...bays.values()].map((b) => b.v));
    for (const { loc, v } of bays.values()) {
      const aisle = L.pickAisles[loc.aisle];
      const run = loc.side === "L" ? aisle.left : aisle.right;
      if (!run) continue;
      const bayLen = (run.y1 - run.y0) / run.bays;
      const y0 = run.y0 + loc.bay * bayLen;
      parts.push(
        `<rect x="${X(run.x - run.depthFt / 2)}" y="${Y(y0 + bayLen)}" width="${f1(Math.max(0.8, run.depthFt * scale))}" height="${f1(Math.max(0.5, bayLen * scale - 0.6))}" fill="${heat(Math.sqrt(v / maxV))}"><title>${esc(`${loc.id.replace(/-\d+[A-Z]?$/, "")}: ${v.toFixed(1)} ${opts.heatLabel ?? ""}`)}</title></rect>`
      );
    }
  }

  if (opts.layout) {
    const d = opts.layout.depot;
    parts.push(`<circle cx="${X(d.x)}" cy="${Y(d.y)}" r="${Math.max(3, 3 * scale)}" fill="var(--accent, #d9480f)"><title>Pick depot</title></circle>`);
  }
  for (const door of spec.doors) {
    const w = Math.max(6, door.widthFt);
    parts.push(
      `<rect x="${X(door.x - w / 2)}" y="${f1(Y(door.y) - 3)}" width="${f1(w * scale)}" height="6" fill="${door.kind === "inbound" ? "var(--inbound, #2f9e44)" : "var(--outbound, #d9480f)"}"><title>${esc(`${door.id} (${door.kind})`)}</title></rect>`
    );
  }
  const doorLabels = spec.doors.length <= 16;
  if (doorLabels) for (const door of spec.doors) parts.push(`<text x="${X(door.x)}" y="${f1(Y(door.y) + 16)}" text-anchor="middle" class="lbl sm">${esc(door.id)}</text>`);

  const width = f1((W + 2 * pad) * scale);
  const height = f1((D + 2 * pad) * scale + 26);
  const legend = `Green inbound doors, orange outbound · blue-grey pick racks, tan reserve, lilac mixed${opts.heat ? ` · shade = ${esc(opts.heatLabel ?? "value")}` : ""} · ${Math.round(W)}×${Math.round(D)} ft`;
  parts.push(`<text x="${X(0)}" y="${f1(height - 6)}" class="lbl sm">${legend}</text>`);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(`Floor plan of ${spec.name}`)}" xmlns="http://www.w3.org/2000/svg"><style>.lbl{font:12px system-ui,sans-serif;fill:var(--floor-text,#333)}.sm{font-size:10px}</style>${parts.join("")}</svg>`;
}

/** Lines per week per pick location, for the heat layer. */
export function pickHeat(slotting: Map<string, { id: string }>, linesPerWeek: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [sku, loc] of slotting) out.set(loc.id, (out.get(loc.id) ?? 0) + (linesPerWeek.get(sku) ?? 0));
  return out;
}
