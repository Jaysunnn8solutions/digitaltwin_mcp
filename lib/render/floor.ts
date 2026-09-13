/**
 * The floor plan as an SVG string: building, reserve racks, pick faces shaded
 * by pick frequency (all levels of a bay summed), the depot and the dock doors.
 * Shared by the web page and the local render_floor tool. Colors come from
 * CSS custom properties with fallbacks, so the page can theme it.
 */

import type { TwinContext } from "../twin/twin";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

export function floorSvg(ctx: TwinContext, opts: { width?: number } = {}): string {
  const { site, layout, slotting, frequencies } = ctx;
  const W = site.building.widthFt;
  const D = site.building.depthFt;
  const pad = 14;
  const scale = (opts.width ?? 640) / (W + 2 * pad);
  const X = (x: number) => (x + pad) * scale;
  // Dock wall at the bottom of the drawing.
  const Y = (y: number) => (D - y + pad) * scale;
  const parts: string[] = [];

  parts.push(`<rect x="${X(0)}" y="${Y(D)}" width="${W * scale}" height="${D * scale}" fill="var(--floor-bg, #fafaf7)" stroke="var(--floor-line, #444)" stroke-width="1.5"/>`);

  // Reserve racks: one rectangle per rack face along each aisle.
  const r = site.reserve;
  const rPitch = r.aisleWidthFt + 2 * r.rackDepthFt;
  const rLen = r.baysPerSide * r.bayWidthFt;
  for (let a = 0; a < r.aisles; a++) {
    const x0 = r.originX + a * rPitch;
    for (const dx of [0, r.rackDepthFt + r.aisleWidthFt]) {
      parts.push(`<rect x="${X(x0 + dx)}" y="${Y(r.originY + rLen)}" width="${r.rackDepthFt * scale}" height="${rLen * scale}" fill="var(--rack, #c9c3b6)"/>`);
    }
  }
  parts.push(`<text x="${X(r.originX)}" y="${Y(r.originY + rLen) - 6}" class="lbl">Reserve · ${layout.reserve.length} pallet positions</text>`);

  // Pick faces: sum lines/week per aisle-side-bay across levels.
  const lines = new Map(frequencies.map((f) => [f.sku.id, f.linesPerWeek]));
  const bays = new Map<string, { x: number; y: number; side: "L" | "R"; v: number }>();
  for (const [sku, loc] of slotting) {
    const key = `${loc.aisle}-${loc.side}-${loc.bay}`;
    const b = bays.get(key) ?? { x: loc.x, y: loc.y, side: loc.side, v: 0 };
    b.v += lines.get(sku) ?? 0;
    bays.set(key, b);
  }
  const p = site.pick;
  const maxV = Math.max(1, ...[...bays.values()].map((b) => b.v));
  for (const a of layout.pick.filter((l) => l.level === 1 && l.slot === 0)) {
    const b = bays.get(`${a.aisle}-${a.side}-${a.bay}`);
    const rx = a.side === "L" ? a.x - p.aisleWidthFt / 2 - p.rackDepthFt : a.x + p.aisleWidthFt / 2;
    const y0 = p.originY + a.bay * p.bayWidthFt;
    parts.push(
      `<rect x="${X(rx)}" y="${Y(y0 + p.bayWidthFt)}" width="${p.rackDepthFt * scale}" height="${p.bayWidthFt * scale - 0.6}" fill="${heat(Math.sqrt((b?.v ?? 0) / maxV))}"><title>${esc(`Bay ${a.aisle + 1}${a.side}${a.bay + 1}: ${(b?.v ?? 0).toFixed(1)} lines/week`)}</title></rect>`
    );
  }
  parts.push(`<text x="${X(p.originX)}" y="${Y(p.originY + p.baysPerSide * p.bayWidthFt) - 6}" class="lbl">Pick faces · ${layout.pick.length} slots · shade = lines/week</text>`);

  // Depot and doors.
  parts.push(`<circle cx="${X(layout.depot.x)}" cy="${Y(layout.depot.y)}" r="${Math.max(3, 3 * scale)}" fill="var(--accent, #d9480f)"><title>Pick depot</title></circle>`);
  for (const d of layout.doors) {
    const w = 9;
    parts.push(
      `<rect x="${X(d.x - w / 2)}" y="${Y(0) - 3}" width="${w * scale}" height="6" fill="${d.kind === "inbound" ? "var(--inbound, #2f9e44)" : "var(--outbound, #d9480f)"}"><title>${d.id}</title></rect>`,
      `<text x="${X(d.x)}" y="${Y(0) + 16}" text-anchor="middle" class="lbl sm">${d.id}</text>`
    );
  }
  parts.push(`<text x="${X(0)}" y="${Y(0) + 30}" class="lbl sm">Dock wall · green inbound, orange outbound · ${W}×${D} ft</text>`);

  const width = (W + 2 * pad) * scale;
  const height = (D + 2 * pad) * scale + 26;
  return `<svg viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" width="100%" role="img" aria-label="${esc(`Floor plan of ${site.id}`)}" xmlns="http://www.w3.org/2000/svg"><style>.lbl{font:12px system-ui,sans-serif;fill:var(--floor-text,#333)}.sm{font-size:10px}</style>${parts.join("")}</svg>`;
}
