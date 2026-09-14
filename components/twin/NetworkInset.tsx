"use client";

import { useMemo } from "react";
import type { Playback, WorldPayload } from "@/lib/trace/types";
import { WEEKDAYS } from "@/lib/twin/standards";
import type { EventIndex, OrderRecord } from "@/lib/twin-ui/describe";
import { clockOf, dayOf, minutes } from "@/lib/twin-ui/format";

interface Props {
  world: WorldPayload;
  playback: Playback;
  index: EventIndex;
  t: number;
  onSelect: (entity: number) => void;
}

const W = 360;
const H = 250;
const MAP_W = 200;

type StoreStatus = { text: string; cls: string };

/** Today's status of a store's order from the events at or before t. */
export function storeStatusAt(index: EventIndex, storeId: string, t: number): StoreStatus {
  const day = dayOf(t);
  let rec: OrderRecord | null = null;
  let orderId = "";
  for (const [id, r] of index.order) {
    if (r.release && r.release.store === storeId && r.release.day === day) {
      rec = r;
      orderId = id;
      break;
    }
  }
  if (!rec || !rec.release || rec.release.t > t) return { text: "no truck today", cls: "" };
  if (rec.depart && rec.depart.t <= t) return { text: "departed", cls: "good" };
  if (rec.loaded && rec.loaded.t <= t) return rec.loaded.lateMin > 0 ? { text: `loaded ${minutes(rec.loaded.lateMin)} late`, cls: "bad" } : { text: "loaded", cls: "good" };
  if (rec.cut && rec.cut.t <= t) return { text: "cut: nothing to ship", cls: "bad" };
  const late = t > rec.release.departAt;
  const jobs = index.orderJobs.get(orderId) ?? [];
  const loading = jobs.some((j) => j.process === "load" && j.startAt >= 0 && j.startAt <= t);
  if (loading) return { text: late ? "loading, late" : "loading", cls: late ? "bad" : "on" };
  const packedAll = rec.packed.some((p) => p.left === 0 && p.t <= t);
  if (packedAll) return { text: late ? "packed, late" : "packed", cls: late ? "bad" : "on" };
  if (rec.picked && rec.picked.t <= t) return { text: late ? "picked, late" : "picked", cls: late ? "bad" : "on" };
  const picking = jobs.some((j) => j.process === "pick" && j.startAt >= 0 && j.startAt <= t);
  if (picking) return { text: late ? "picking, late" : "picking", cls: late ? "bad" : "on" };
  return { text: late ? "released, late" : "released", cls: late ? "bad" : "" };
}

/** Where a PO stands at t, 0..5: placed, scheduled, arrived, docked, unloaded, put away. */
export function poStageAt(index: EventIndex, po: string, t: number): { stage: number; label: string } {
  const r = index.po.get(po);
  if (!r) return { stage: 0, label: "" };
  const pallets = r.arrive?.pallets.length ?? r.scheduled?.pallets ?? r.placed?.pallets ?? 0;
  const put = r.putaways.filter((p) => p.t <= t).length;
  if (pallets > 0 && put >= pallets) return { stage: 5, label: "put away" };
  if (r.undock && r.undock.t <= t) return { stage: 4, label: put ? `${put}/${pallets} put away` : "unloaded" };
  if (r.dock && r.dock.t <= t) return { stage: 3, label: "docked" };
  if (r.arrive && r.arrive.t <= t) return { stage: 2, label: "waiting for a door" };
  if (r.scheduled && r.scheduled.t <= t) return { stage: 1, label: `due ${clockOf(r.scheduled.eta)}` };
  if (r.placed && r.placed.t <= t) return { stage: 0, label: `placed, due day ${r.placed.arriveDay + 1}` };
  return { stage: -1, label: "" };
}

/** The DC, its stores by longitude and latitude with today's truck status, and the suppliers with their open POs. */
export default function NetworkInset({ world, playback, index, t, onSelect }: Props) {
  const geo = useMemo(() => {
    const pts = [world.dc, ...world.stores];
    const lons = pts.map((p) => p.lon);
    const lats = pts.map((p) => p.lat);
    const lon0 = Math.min(...lons);
    const lon1 = Math.max(...lons);
    const lat0 = Math.min(...lats);
    const lat1 = Math.max(...lats);
    const span = Math.max(lon1 - lon0, lat1 - lat0, 0.05);
    const pad = 18;
    const size = MAP_W - 2 * pad;
    const cx = (lon0 + lon1) / 2;
    const cy = (lat0 + lat1) / 2;
    const X = (lon: number) => pad + ((lon - cx) / span + 0.5) * size;
    const Y = (lat: number) => pad + 20 + (0.5 - (lat - cy) / span) * size;
    return { X, Y };
  }, [world]);

  const day = dayOf(t);
  const openPos = useMemo(() => {
    const list: Array<{ po: string; supplier: string; stage: number; label: string }> = [];
    for (const [po, r] of index.po) {
      const placedT = r.placed?.t ?? r.scheduled?.t ?? r.arrive?.t ?? Infinity;
      if (placedT > t) continue;
      const s = poStageAt(index, po, t);
      if (s.stage === 5 && (r.putaways[r.putaways.length - 1]?.t ?? 0) < t - 240) continue;
      list.push({ po, supplier: r.placed?.supplier ?? r.scheduled?.supplier ?? r.arrive?.supplier ?? "", stage: s.stage, label: s.label });
    }
    return list;
  }, [index, t]);

  const truckEntity = (po: string) => playback.entities.findIndex((e) => e.kind === "truckIn" && e.id === po);
  const suppliers = world.suppliers;
  const rowH = Math.min(18, (H - 30) / Math.max(1, suppliers.length));

  return (
    <div className="twin-network">
      <p className="sub" style={{ marginBottom: 6 }}>
        {world.dc.name} · day {day + 1}, {WEEKDAYS[day % 7]}. Stores by location with today&apos;s truck; suppliers with their purchase orders on the way.
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Store network and supplier purchase orders">
        <text x={8} y={12} className="muted">
          STORES
        </text>
        {world.stores.map((s) => {
          const st = storeStatusAt(index, s.id, t);
          const color = st.cls === "bad" ? "#e03131" : st.cls === "good" ? "#2f9e44" : st.cls === "on" ? "#1c7ed6" : "#9aa5b1";
          const x = geo.X(s.lon);
          const y = geo.Y(s.lat);
          return (
            <g key={s.id}>
              <line x1={geo.X(world.dc.lon)} y1={geo.Y(world.dc.lat)} x2={x} y2={y} stroke="#9aa5b1" strokeWidth={0.6} strokeDasharray="2 2" />
              <circle cx={x} cy={y} r={s.type === "specialty" ? 4 : 5} fill={color} stroke="#fff" strokeWidth={1} />
              <text x={x + 7} y={y - 2}>
                {s.name}
              </text>
              <text x={x + 7} y={y + 8} className="muted">
                {st.text} · {s.deliveryDays.map((d) => WEEKDAYS[d - 1]).join(" ")}
              </text>
            </g>
          );
        })}
        <rect x={geo.X(world.dc.lon) - 6} y={geo.Y(world.dc.lat) - 6} width={12} height={12} fill="#d9480f" stroke="#fff" />
        <text x={geo.X(world.dc.lon) + 9} y={geo.Y(world.dc.lat) + 4}>
          {world.dc.name}
        </text>

        <text x={MAP_W + 8} y={12} className="muted">
          SUPPLIERS · PO PROGRESS
        </text>
        {suppliers.map((sp, i) => {
          const y = 22 + i * rowH;
          const pos = openPos.filter((p) => p.supplier === sp.id);
          const barX = MAP_W + 8;
          const barW = W - barX - 8;
          return (
            <g key={sp.id}>
              <text x={barX} y={y + 8} className={pos.length ? undefined : "muted"}>
                {sp.name.length > 22 ? `${sp.name.slice(0, 21)}…` : sp.name}
                {sp.kind === "importer" ? " ✈" : ""}
              </text>
              {pos.slice(0, 2).map((p, k) => {
                const yy = y + 10 + k * 4;
                const entity = truckEntity(p.po);
                return (
                  <g key={p.po} onClick={entity >= 0 ? () => onSelect(entity) : undefined} style={{ cursor: entity >= 0 ? "pointer" : "default" }}>
                    <title>{`${p.po}: ${p.label}`}</title>
                    <rect x={barX} y={yy} width={barW} height={3} fill="var(--line)" />
                    <rect x={barX} y={yy} width={(barW * Math.max(0, p.stage + 1)) / 6} height={3} fill={p.stage >= 5 ? "#2f9e44" : p.stage >= 2 ? "#1c7ed6" : "#f08c00"} />
                  </g>
                );
              })}
              {pos.length > 2 && (
                <text x={W - 8} y={y + 8} textAnchor="end" className="muted">
                  +{pos.length - 2}
                </text>
              )}
            </g>
          );
        })}
        <text x={MAP_W + 8} y={H - 4} className="muted">
          placed · scheduled · arrived · docked · unloaded · put away
        </text>
      </svg>
    </div>
  );
}
