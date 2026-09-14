/**
 * Ticker lines: one short sentence per notable event, with a severity the
 * page colours (0 info, 1 notable, 2 problem). Job and face events are too
 * frequent to list; trucks, orders, people and the system are. Trucks and
 * orders are named the way the floor knows them (the supplier, the store),
 * with the PO in parentheses so the id is still there to search for.
 */

import { clock } from "../twin/standards";
import type { TraceEvent } from "./types";

export interface TickerNames {
  sku: (id: string) => string;
  /** Supplier id → name (the id when unknown). */
  supplier: (id: string) => string;
  /** PO id → its supplier's name (the PO id when the PO is unknown). */
  po: (po: string) => string;
  /** Order id → the store's name (the order id when the order has not been released). */
  order: (id: string) => string;
}

const dayClock = (t: number) => `day ${Math.floor(t / 1440) + 1} ${clock(t)}`;

/** Text and severity for an event, or null when the event is not worth a line. */
export function tickerLine(e: TraceEvent, names: TickerNames): { text: string; severity: 0 | 1 | 2 } | null {
  switch (e.k) {
    case "init":
      return { text: `Run starts: ${e.dc}, week ${e.startWeek}, ${e.days} day${e.days === 1 ? "" : "s"}, seed ${e.seed}.`, severity: 0 };
    case "day":
      return { text: `Day ${e.day + 1} (calendar week ${e.calendarWeek}${e.operating ? "" : ", closed"}).`, severity: 0 };
    case "poPlaced":
      return { text: `${names.supplier(e.supplier)}: PO ${e.po} placed, ${e.pallets} pallet${e.pallets === 1 ? "" : "s"}, due day ${e.arriveDay + 1}.`, severity: 0 };
    case "truckScheduled":
      return { text: `${names.supplier(e.supplier)} truck (${e.po}) appointed ${clock(e.appointment)}, expected ${clock(e.eta)}.`, severity: 0 };
    case "truckArrive":
      return { text: `${names.supplier(e.supplier)} ${e.importer ? "import " : ""}truck (${e.po}) arrives with ${e.pallets.length} pallet${e.pallets.length === 1 ? "" : "s"}.`, severity: 1 };
    case "truckDock":
      return { text: `${names.po(e.po)} truck (${e.po}) docks${e.waitMin > 0.5 ? ` after waiting ${Math.round(e.waitMin)} min for a door` : ""}.`, severity: e.waitMin > 30 ? 2 : 0 };
    case "truckUndock":
      return { text: `${names.po(e.po)} truck (${e.po}) is unloaded and leaves the door.`, severity: 0 };
    case "short":
      // A hot replenishment is the normal answer to a small face running dry: notable, not a fault.
      return { text: `Face short: ${names.sku(e.sku)} for ${names.order(e.order)}, ${e.inners} inner${e.inners === 1 ? "" : "s"} missing${e.hot ? ", hot replenishment requested" : ""}.`, severity: e.hot ? 1 : 2 };
    case "shortShip":
      return { text: `${names.order(e.order)} ships short ${e.inners} inner${e.inners === 1 ? "" : "s"} of ${names.sku(e.sku)}: nothing left anywhere.`, severity: 2 };
    case "orderRelease": {
      const cut = e.lines.reduce((a, l) => a + l.cut, 0);
      return { text: `${e.storeName} order released: ${e.lines.length} lines, ${e.inners} inners, ${e.tours} tour${e.tours === 1 ? "" : "s"}${cut ? `, ${cut} inners cut` : ""}; truck at ${clock(e.departAt)} day ${e.day + 1}.`, severity: cut ? 2 : 1 };
    }
    case "orderPicked":
      return { text: `${names.order(e.order)} order fully picked: ${e.inners} inners on ${e.pallets} pallet${e.pallets === 1 ? "" : "s"}.`, severity: 0 };
    case "orderCut":
      return { text: `${names.order(e.order)} order cut entirely: no truck.`, severity: 2 };
    case "truckLoaded":
      return e.lateMin > 0
        ? { text: `${e.store} truck loaded ${Math.round(e.lateMin)} min late (${e.pallets} pallets, ${e.inners} inners).`, severity: 2 }
        : { text: `${e.store} truck loaded on time: ${e.pallets} pallets, ${e.inners} inners.`, severity: 1 };
    case "truckDepart":
      return { text: `${names.order(e.order)} truck departs.`, severity: 0 };
    case "worker":
      switch (e.state) {
        case "in":
          return { text: `${e.id} clocks in${e.shift ? ` for the ${e.shift} shift` : ""} as ${e.primary ?? "crew"}.`, severity: 0 };
        case "absent":
          return { text: `${e.id} is absent today.`, severity: 2 };
        case "break":
          return { text: `${e.id} takes a ${e.breakMin ?? 0} min break.`, severity: 0 };
        case "out":
          return (e.overtimeMin ?? 0) > 0.5 ? { text: `${e.id} clocks out after ${Math.round(e.overtimeMin ?? 0)} min of overtime.`, severity: 1 } : { text: `${e.id} clocks out.`, severity: 0 };
        default:
          return null;
      }
    case "wms":
      return e.down ? { text: `WMS down until ${dayClock(e.until ?? e.t)}: nothing releases, no task starts.`, severity: 2 } : { text: "WMS back up.", severity: 1 };
    case "end":
      return { text: "Horizon reached.", severity: 0 };
    default:
      return null;
  }
}
