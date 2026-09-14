"use client";

import { fieldHelp, type DoorOutageRow, type ForkliftOutageRow, type WmsOutageRow } from "@/lib/twin-ui/form";
import { RowList, type Column, type TabProps } from "../ScenarioPanel";

export default function Disruptions({ form, update, errors }: TabProps) {
  const doorCols: Array<Column<DoorOutageRow>> = [
    { key: "fromDay", label: "From day", type: "number", placeholder: "0", min: 0, max: 364 },
    { key: "toDay", label: "To day", type: "number", placeholder: "1", min: 0, max: 364 },
    {
      key: "kind",
      label: "Doors",
      type: "select",
      options: [
        { value: "inbound", label: "inbound" },
        { value: "outbound", label: "outbound" },
      ],
      placeholder: "kind",
    },
    { key: "count", label: "Count", type: "number", placeholder: "1", min: 1, max: 10 },
  ];
  const forkliftCols: Array<Column<ForkliftOutageRow>> = [
    { key: "fromDay", label: "From day", type: "number", placeholder: "0", min: 0, max: 364 },
    { key: "toDay", label: "To day", type: "number", placeholder: "1", min: 0, max: 364 },
    { key: "count", label: "Forklifts out", type: "number", placeholder: "1", min: 1, max: 10 },
  ];
  const wmsCols: Array<Column<WmsOutageRow>> = [
    { key: "day", label: "Day", type: "number", placeholder: "1", min: 0, max: 364 },
    { key: "start", label: "From", type: "time", placeholder: "09:00" },
    { key: "hours", label: "Hours", type: "number", placeholder: "2", min: 0.25, max: 24 },
  ];
  return (
    <div>
      <p className="help sub" style={{ fontSize: 11 }}>
        Days count from 0, the Monday the run starts. Absenteeism and leave are on the Labor tab; supplier delays on Supply.
      </p>
      <RowList title="Door outages" help={fieldHelp("doorOutages")} rows={form.doorOutages} onChange={(rows) => update((f) => ({ ...f, doorOutages: rows }))} blank={{ fromDay: "0", toDay: "1", kind: "inbound", count: "1" }} columns={doorCols} errors={errors} prefix="doorOutages" addLabel="Add a door outage" max={20} />
      <RowList title="Forklift outages" help={fieldHelp("forkliftOutages")} rows={form.forkliftOutages} onChange={(rows) => update((f) => ({ ...f, forkliftOutages: rows }))} blank={{ fromDay: "0", toDay: "1", count: "1" }} columns={forkliftCols} errors={errors} prefix="forkliftOutages" addLabel="Add a forklift outage" max={20} />
      <RowList title="WMS outages" help={fieldHelp("wmsOutages")} rows={form.wmsOutages} onChange={(rows) => update((f) => ({ ...f, wmsOutages: rows }))} blank={{ day: "1", start: "09:00", hours: "2" }} columns={wmsCols} errors={errors} prefix="wmsOutages" addLabel="Add a WMS outage" max={20} />
    </div>
  );
}
