"use client";

import { WEEKDAYS } from "@/lib/twin/standards";
import { extensionHelp, fieldHelp, type SupplierDelayRow, type SupplierOverrideRow } from "@/lib/twin-ui/form";
import { NumField, RowList, SelectField, TextField, type Column, type TabProps } from "../ScenarioPanel";

export default function Supply({ form, update, errors, ctx }: TabProps) {
  const delayCols: Array<Column<SupplierDelayRow>> = [
    { key: "fromDay", label: "Orders placed from day", type: "number", placeholder: "0", min: 0, max: 364 },
    { key: "toDay", label: "to day", type: "number", placeholder: "20", min: 0, max: 364 },
    { key: "supplier", label: "Supplier id", type: "text", placeholder: ctx.supplierIds[0] ?? "SUP-CHOC", list: "twin-suppliers" },
    { key: "category", label: "or category", type: "text", placeholder: "specialty:latam", list: "twin-categories" },
    { key: "extraDays", label: "Extra days", type: "number", placeholder: "14", min: 1, max: 60 },
  ];
  const overrideCols: Array<Column<SupplierOverrideRow>> = [
    { key: "supplier", label: "Supplier id", type: "text", placeholder: ctx.supplierIds[0] ?? "SUP-CHOC", list: "twin-suppliers" },
    { key: "leadDays", label: "Lead days", type: "number", placeholder: "5", min: 1, max: 90 },
    { key: "leadSdDays", label: "Lead sd", type: "number", placeholder: "1", min: 0, max: 30 },
    { key: "orderDay", label: "Order day", type: "select", options: WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d })), placeholder: "keep" },
  ];
  return (
    <div>
      <h3>Buying policy</h3>
      <div className="twin-fields">
        <SelectField
          label="Forecast"
          help={fieldHelp("forecast")}
          error={errors.forecast}
          value={form.forecast}
          onChange={(v) => update((f) => ({ ...f, forecast: v }))}
          options={[
            { value: "", label: "default (seasonal)" },
            { value: "seasonal", label: "seasonal" },
            { value: "trailing", label: "trailing" },
          ]}
        />
        <NumField label="Service level" help={fieldHelp("serviceLevel")} error={errors.serviceLevel} value={form.serviceLevel} onChange={(v) => update((f) => ({ ...f, serviceLevel: v }))} placeholder="0.97" min={0.5} max={0.999} step={0.005} />
      </div>

      <h3>Suppliers</h3>
      <RowList title="Supplier delays" help={fieldHelp("supplierDelays")} rows={form.supplierDelays} onChange={(rows) => update((f) => ({ ...f, supplierDelays: rows }))} blank={{ fromDay: "0", toDay: "20", supplier: "", category: "", extraDays: "7" }} columns={delayCols} errors={errors} prefix="supplierDelays" addLabel="Add a delay" max={20} />
      <RowList title="Supplier overrides" help={extensionHelp("supplierOverrides")} rows={form.supplierOverrides} onChange={(rows) => update((f) => ({ ...f, supplierOverrides: rows }))} blank={{ supplier: ctx.supplierIds[0] ?? "", leadDays: "", leadSdDays: "", orderDay: "" }} columns={overrideCols} errors={errors} prefix="supplierOverrides" addLabel="Override a supplier" max={20} />

      <h3>Inbound</h3>
      <p className="help sub" style={{ fontSize: 11 }}>
        {extensionHelp("times")}
      </p>
      <div className="twin-fields">
        <TextField label="Appointment window from" type="time" error={errors.inboundWindowStart} value={form.inboundWindowStart} onChange={(v) => update((f) => ({ ...f, inboundWindowStart: v }))} placeholder="07:00" />
        <TextField label="to" type="time" error={errors.inboundWindowEnd} value={form.inboundWindowEnd} onChange={(v) => update((f) => ({ ...f, inboundWindowEnd: v }))} placeholder="12:00" />
        <NumField label="Arrival lateness sd, min" help={extensionHelp("inboundLatenessSdMin")} error={errors.inboundLatenessSdMin} value={form.inboundLatenessSdMin} onChange={(v) => update((f) => ({ ...f, inboundLatenessSdMin: v }))} placeholder="30" min={0} max={180} step={5} />
      </div>
    </div>
  );
}
