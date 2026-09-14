"use client";

import { extensionHelp, fieldHelp, type DemandShockRow } from "@/lib/twin-ui/form";
import { NumField, RowList, TextField, WeekdayPicker, type Column, type TabProps } from "../ScenarioPanel";

export default function Deliveries({ form, update, errors, ctx }: TabProps) {
  const shockCols: Array<Column<DemandShockRow>> = [
    { key: "fromDay", label: "From day", type: "number", placeholder: "0", min: 0, max: 364 },
    { key: "toDay", label: "To day", type: "number", placeholder: "6", min: 0, max: 364 },
    { key: "factor", label: "× demand", type: "number", placeholder: "1.5", min: 0, max: 10 },
    { key: "category", label: "Category (optional)", type: "text", placeholder: ctx.categories[0] ?? "traditional", list: "twin-categories" },
  ];
  return (
    <div>
      <h3>Store demand</h3>
      <p className="help sub" style={{ fontSize: 11 }}>
        The 3D page plays the committed candystore network: store additions and closures run through the MCP tools.
      </p>
      <div className="twin-fields">
        <NumField label="Demand scale" help={fieldHelp("demandScale")} error={errors.demandScale} value={form.demandScale} onChange={(v) => update((f) => ({ ...f, demandScale: v }))} placeholder="1" min={0.1} max={5} step={0.1} />
      </div>
      <RowList title="Demand shocks" help={fieldHelp("demandShocks")} rows={form.demandShocks} onChange={(rows) => update((f) => ({ ...f, demandShocks: rows }))} blank={{ fromDay: "0", toDay: "6", factor: "1.5", category: "" }} columns={shockCols} errors={errors} prefix="demandShocks" addLabel="Add a shock" max={20} />

      <h3>Delivery days</h3>
      <p className="help sub" style={{ fontSize: 11 }}>
        {extensionHelp("deliveryDays")} Blank keeps the site&apos;s days (general Mon Wed Fri, specialty Tue Fri); delivery days must be operating days (Labor tab).
      </p>
      <WeekdayPicker label="General stores" error={errors.deliveryGeneral} value={form.deliveryGeneral} onChange={(days) => update((f) => ({ ...f, deliveryGeneral: days }))} />
      <WeekdayPicker label="Specialty stores" error={errors.deliverySpecialty} value={form.deliverySpecialty} onChange={(days) => update((f) => ({ ...f, deliverySpecialty: days }))} />

      <h3>The clock</h3>
      <p className="help sub" style={{ fontSize: 11 }}>
        {extensionHelp("times")}
      </p>
      <div className="twin-fields">
        <TextField label="Order release" help="Store orders drop into the WMS at this time the evening before the truck." type="time" error={errors.orderRelease} value={form.orderRelease} onChange={(v) => update((f) => ({ ...f, orderRelease: v }))} placeholder="17:00" />
        <TextField label="Truck departure" help="Store trucks leave at this time on the delivery day; a load after it is late." type="time" error={errors.truckDeparture} value={form.truckDeparture} onChange={(v) => update((f) => ({ ...f, truckDeparture: v }))} placeholder="14:00" />
      </div>
    </div>
  );
}
