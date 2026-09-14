"use client";

import { useMemo } from "react";
import type { Playback, RunningKpis, WorldPayload } from "@/lib/trace/types";
import type { Kpis } from "@/lib/twin/replicate";
import { PROCESSES, type Process } from "@/lib/twin/types";
import type { EventIndex } from "@/lib/twin-ui/describe";
import { clockOf, dayOf, minutes, money, num, pct } from "@/lib/twin-ui/format";
import { poStageAt, storeStatusAt } from "./NetworkInset";

export interface HudSnapshot {
  kpis: Kpis;
  running: RunningKpis;
  /** At the horizon: the posted kpis(result), open orders counted as late trucks. */
  final: boolean;
  /** Per process: queued jobs a free worker cannot start because equipment or a door is taken. */
  held: number[];
}

interface Props {
  world: WorldPayload;
  playback: Playback;
  index: EventIndex;
  snapshot: HudSnapshot;
  t: number;
  /** The full grid, queues and today's trucks; collapsed, only the headline tiles show. */
  expanded: boolean;
  onToggle: () => void;
  onSelectQueue: (p: Process) => void;
  onSelectEntity: (entity: number) => void;
}

interface TileSpec {
  v: string;
  l: string;
  cls?: string;
}

/** The tiles in display order; the first HEADLINE ones make the compact strip. Values are the engine's, unchanged by the layout. */
function tiles(kpis: Kpis, running: RunningKpis): TileSpec[] {
  return [
    { v: num(kpis.innersShipped), l: "inners picked" },
    { v: `${kpis.trucks - kpis.lateTrucks} / ${kpis.trucks}`, l: "trucks on time", cls: kpis.lateTrucks > 0 ? "bad" : "" },
    { v: kpis.lateMinTotal > 0 ? minutes(kpis.lateMinTotal) : "0", l: "late minutes", cls: kpis.lateMinTotal > 0 ? "bad" : "" },
    { v: pct(kpis.fillRate, 1), l: "fill rate", cls: kpis.fillRate < 0.98 ? "warn" : "" },
    { v: num(kpis.notLoaded), l: "orders open" },
    { v: `${running.presentWorkers} / ${running.busyWorkers}`, l: "present / busy" },
    { v: num(running.innersLoaded), l: "inners loaded" },
    { v: money(kpis.shippedDollars), l: "shipped" },
    { v: num(kpis.paidHours, 1), l: "paid hours" },
    { v: pct(kpis.utilization), l: "utilization" },
    { v: num(kpis.overtimeHours, 1), l: "overtime h", cls: kpis.overtimeHours > 0 ? "warn" : "" },
    { v: money(kpis.laborCost), l: "labor cost" },
    { v: running.dockToStockN ? minutes(kpis.dockToStockAvgMin) : "–", l: "dock to stock" },
    { v: `${kpis.replenishments}${kpis.hotReplenishments ? ` (${kpis.hotReplenishments} hot)` : ""}`, l: "replenishments", cls: kpis.hotReplenishments ? "warn" : "" },
    { v: num(kpis.palletsNotPutAway), l: "pallets in flight" },
    { v: pct(kpis.forkliftUtilization), l: "forklift util." },
  ];
}

const HEADLINE = 6;

/**
 * KPI tiles at t (checkpoint + replay, exact), queue bars and the "Today"
 * strip. Docked over the stage under the camera toolbar: the compact strip is
 * the six headline tiles plus a queue sparkline; "More" opens everything.
 * Below 1000 px the workbench renders it as a block under the stage instead.
 */
export default function Hud({ world, playback, index, snapshot, t, expanded, onToggle, onSelectQueue, onSelectEntity }: Props) {
  const { kpis, running, final, held } = snapshot;
  const day = dayOf(t);
  const maxQueue = Math.max(4, ...running.queues);
  const waiting = running.queues.reduce((a, b) => a + b, 0);
  const all = tiles(kpis, running);

  const today = useMemo(() => {
    const stores = world.stores
      .filter((s) => s.deliveryDays.includes((day % 7) + 1))
      .map((s) => {
        const status = storeStatusAt(index, s.id, t);
        let entity = -1;
        for (const [id, r] of index.order) {
          if (r.release?.store === s.id && r.release.day === day) {
            entity = playback.entities.findIndex((e) => e.kind === "truckOut" && e.id === id);
            break;
          }
        }
        return { id: s.id, name: s.name, status, entity };
      });
    const trucks: Array<{ po: string; supplier: string; eta: number; label: string; stage: number; entity: number }> = [];
    for (const [po, r] of index.po) {
      if (!r.scheduled || dayOf(r.scheduled.eta) !== day || r.scheduled.t > t) continue;
      const stage = poStageAt(index, po, t);
      trucks.push({ po, supplier: r.scheduled.supplier, eta: r.scheduled.eta, label: stage.label, stage: stage.stage, entity: playback.entities.findIndex((e) => e.kind === "truckIn" && e.id === po) });
    }
    trucks.sort((a, b) => a.eta - b.eta);
    return { stores, trucks };
  }, [world, index, playback, day, t]);

  const heading = `${final ? "Run totals" : "So far"} · ${kpis.trucks} store truck${kpis.trucks === 1 ? "" : "s"}`;

  if (!expanded) {
    return (
      <div className="twin-overlay twin-hud compact" role="region" aria-label="Key figures">
        <div className="twin-tiles">
          {all.slice(0, HEADLINE).map((s) => (
            <Tile key={s.l} v={s.v} l={s.l} cls={s.cls} />
          ))}
          <button type="button" className="twin-qmini" onClick={onToggle} title={`${waiting} job${waiting === 1 ? "" : "s"} waiting: ${PROCESSES.map((p, i) => `${running.queues[i] ?? 0} ${p}`).join(", ")}`}>
            <span className="bars" aria-hidden="true">
              {PROCESSES.map((p, i) => (
                <i key={p} style={{ height: `${Math.max(2, (14 * (running.queues[i] ?? 0)) / maxQueue)}px` }} />
              ))}
            </span>
            <b>{waiting}</b>
            <span>waiting</span>
          </button>
        </div>
        <button type="button" className="twin-hud-more" onClick={onToggle} title={`${heading}: every figure, the queues and today's trucks`} aria-expanded={false}>
          More ▾
        </button>
      </div>
    );
  }

  return (
    <div className="twin-overlay twin-hud expanded" role="region" aria-label="Key figures">
      <div className="twin-hud-head">
        <h4>{heading}</h4>
        <button type="button" className="twin-hud-more" onClick={onToggle} aria-expanded={true} title="Back to the headline tiles (Esc)">
          Less ▴
        </button>
      </div>
      <div className="twin-tiles">
        {all.map((s) => (
          <Tile key={s.l} v={s.v} l={s.l} cls={s.cls} />
        ))}
      </div>
      <div className="twin-hud-cols">
        <div>
          <h4>Queues</h4>
          <div className="twin-queues">
            {PROCESSES.map((p, i) => {
              const n = running.queues[i] ?? 0;
              const h = Math.min(n, held[i] ?? 0);
              return (
                <button type="button" className="twin-queue" key={p} onClick={() => onSelectQueue(p)} title={`${n} ${p} job${n === 1 ? "" : "s"} waiting${h ? `, ${h} held by equipment or a door` : ""}`}>
                  <span>{p}</span>
                  <span className="bar">
                    <i style={{ width: `${(100 * n) / maxQueue}%` }} />
                    {h > 0 && <i className="held" style={{ width: `${(100 * h) / maxQueue}%` }} />}
                  </span>
                  <em>{n}</em>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <h4>Today · day {day + 1}</h4>
          <div className="twin-today">
            {today.stores.length === 0 && <span className="sub">No store trucks due today.</span>}
            {today.stores.map((s) => (
              <div className="row" key={s.id} onClick={s.entity >= 0 ? () => onSelectEntity(s.entity) : undefined} style={{ cursor: s.entity >= 0 ? "pointer" : "default" }}>
                <span className="name" title={s.name}>
                  {s.name}
                </span>
                <span className={`twin-status ${s.status.cls}`}>{s.status.text}</span>
              </div>
            ))}
            {today.trucks.map((tr) => (
              <div className="row" key={tr.po} onClick={tr.entity >= 0 ? () => onSelectEntity(tr.entity) : undefined} style={{ cursor: tr.entity >= 0 ? "pointer" : "default" }}>
                <span className="name" title={`${tr.po} from ${tr.supplier}`}>
                  ▲ {tr.supplier}
                </span>
                <span className={`twin-status ${tr.stage >= 5 ? "good" : tr.stage >= 2 ? "on" : ""}`}>{tr.stage >= 2 ? tr.label : `ETA ${clockOf(tr.eta)}`}</span>
              </div>
            ))}
            {today.stores.length > 0 && today.trucks.length === 0 && <span className="sub">No supplier trucks today.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ v, l, cls = "" }: { v: string; l: string; cls?: string }) {
  return (
    <div className={`twin-tile ${cls}`}>
      <b>{v}</b>
      <span>{l}</span>
    </div>
  );
}
