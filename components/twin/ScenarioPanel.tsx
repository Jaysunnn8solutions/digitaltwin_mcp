"use client";

import type { ReactNode } from "react";
import type { LayoutSpec } from "@/lib/layout/spec";
import type { LaborStandards } from "@/lib/twin/types";
import { WEEKDAYS } from "@/lib/twin/standards";
import type { FormErrors, ImportRackEdits, PickZoneBase, ScenarioForm } from "@/lib/twin-ui/form";

// ---------------------------------------------------------------------------
// What every tab receives
// ---------------------------------------------------------------------------

/** Ids and facts the tabs offer as suggestions; from the last run's world when there is one. */
export interface FormContext {
  workerIds: string[];
  roles: string[];
  shiftIds: string[];
  supplierIds: string[];
  categories: string[];
  skuCount: number;
  /** The built-in pick zone the Space tab pre-validates against; null for an imported building. */
  pickZone: PickZoneBase | null;
  std: LaborStandards;
  imported: LayoutSpec | null;
  importEdits: ImportRackEdits;
  setImportEdits: (e: ImportRackEdits) => void;
}

export interface TabProps {
  form: ScenarioForm;
  update: (fn: (f: ScenarioForm) => ScenarioForm) => void;
  errors: FormErrors;
  ctx: FormContext;
}

export type ScenarioTab = "labor" | "supply" | "deliveries" | "space" | "disruptions";
export const SCENARIO_TABS: Array<[ScenarioTab, string]> = [
  ["labor", "Labor"],
  ["supply", "Supply"],
  ["deliveries", "Deliveries"],
  ["space", "Space"],
  ["disruptions", "Disruptions"],
];

// ---------------------------------------------------------------------------
// Widgets shared by the tabs (function declarations: hoisted, no init order)
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, help, error, children }: FieldProps) {
  return (
    <div className={`twin-field${error ? " invalid" : ""}`}>
      <label>{label}</label>
      {children}
      {help && <span className="help">{help}</span>}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

interface NumFieldProps {
  label: string;
  help?: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

export function NumField({ label, help, error, value, onChange, placeholder, min, max, step }: NumFieldProps) {
  return (
    <Field label={label} help={help} error={error}>
      <input type="number" inputMode="decimal" value={value} placeholder={placeholder} min={min} max={max} step={step ?? "any"} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

interface TextFieldProps {
  label: string;
  help?: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  list?: string;
  type?: "text" | "time";
}

export function TextField({ label, help, error, value, onChange, placeholder, list, type = "text" }: TextFieldProps) {
  return (
    <Field label={label} help={help} error={error}>
      <input type={type} value={value} placeholder={placeholder} list={list} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

interface SelectFieldProps {
  label: string;
  help?: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}

export function SelectField({ label, help, error, value, onChange, options }: SelectFieldProps) {
  return (
    <Field label={label} help={help} error={error}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

interface WeekdayProps {
  label: string;
  help?: string;
  error?: string;
  value: number[];
  onChange: (days: number[]) => void;
}

export function WeekdayPicker({ label, help, error, value, onChange }: WeekdayProps) {
  const toggle = (d: number) => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b));
  return (
    <Field label={label} help={help} error={error}>
      <div className="twin-days">
        {WEEKDAYS.map((name, i) => (
          <button type="button" key={name} className={value.includes(i + 1) ? "on" : ""} onClick={() => toggle(i + 1)} aria-pressed={value.includes(i + 1)}>
            {name}
          </button>
        ))}
        {value.length > 0 && (
          <button type="button" className="chip" onClick={() => onChange([])} title="Leave the site's own days">
            default
          </button>
        )}
      </div>
    </Field>
  );
}

export interface Column<R> {
  key: keyof R & string;
  label: string;
  type: "number" | "text" | "time" | "select";
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  list?: string;
  min?: number;
  max?: number;
}

interface RowListProps<R> {
  title: string;
  help?: string;
  rows: R[];
  onChange: (rows: R[]) => void;
  blank: R;
  columns: Array<Column<R>>;
  errors: FormErrors;
  prefix: string;
  addLabel?: string;
  max?: number;
  children?: ReactNode;
}

export function RowList<R extends { [K in keyof R]: string }>({ title, help, rows, onChange, blank, columns, errors, prefix, addLabel, max, children }: RowListProps<R>) {
  const set = (i: number, key: keyof R & string, v: string) => onChange(rows.map((r, k) => (k === i ? { ...r, [key]: v } : r)));
  const rowError = (i: number) => errors[`${prefix}.${i}`];
  return (
    <div className="twin-rows">
      <div className="row" style={{ marginTop: 0, justifyContent: "space-between" }}>
        <b style={{ fontSize: 12 }}>{title}</b>
        <span className="sub" style={{ margin: 0 }}>
          {rows.length ? `${rows.length} row${rows.length === 1 ? "" : "s"}` : "none"}
        </span>
      </div>
      {help && (
        <div className="help sub" style={{ margin: "2px 0 4px", fontSize: 11 }}>
          {help}
        </div>
      )}
      {children}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const err = errors[`${prefix}.${i}.${c.key}`];
                  const value = r[c.key] as string;
                  return (
                    <td key={c.key} title={err}>
                      {c.type === "select" ? (
                        <select className={err ? "invalid" : ""} value={value} onChange={(e) => set(i, c.key, e.target.value)}>
                          <option value="">{c.placeholder ?? "–"}</option>
                          {(c.options ?? []).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={err ? "invalid" : ""}
                          type={c.type === "number" ? "number" : c.type}
                          inputMode={c.type === "number" ? "decimal" : undefined}
                          step={c.type === "number" ? "any" : undefined}
                          min={c.min}
                          max={c.max}
                          value={value}
                          placeholder={c.placeholder}
                          list={c.list}
                          onChange={(e) => set(i, c.key, e.target.value)}
                        />
                      )}
                    </td>
                  );
                })}
                <td>
                  <button type="button" className="del" onClick={() => onChange(rows.filter((_, k) => k !== i))} title="Remove">
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.map((_, i) => rowError(i) && <div key={i} className="twin-err">{`Row ${i + 1}: ${rowError(i)}`}</div>)}
      <div className="foot">
        <button type="button" className="chip" onClick={() => onChange([...rows, { ...blank }])} disabled={max !== undefined && rows.length >= max}>
          {addLabel ?? "Add"}
        </button>
        {errors[prefix] && <span className="twin-err">{errors[prefix]}</span>}
      </div>
    </div>
  );
}

/** Suggestion lists the text inputs reference by id. Values are de-duplicated: two shift rows with the same id (the state the engine's own error describes) must not become two options with one key. */
export function Datalists({ ctx }: { ctx: FormContext }) {
  const list = (id: string, values: string[]) => (
    <datalist id={id}>
      {[...new Set(values)].map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
  return (
    <>
      {list("twin-workers", ctx.workerIds)}
      {list("twin-roles", ctx.roles)}
      {list("twin-shifts", ctx.shiftIds)}
      {list("twin-suppliers", ctx.supplierIds)}
      {list("twin-categories", ctx.categories)}
    </>
  );
}

// ---------------------------------------------------------------------------
// The panel shell: run controls above, one tab below
// ---------------------------------------------------------------------------

interface PanelProps {
  tab: ScenarioTab;
  onTab: (t: ScenarioTab) => void;
  /** Fields set per tab, for the badges. */
  counts: Record<ScenarioTab, number>;
  errorCount: number;
  /** The side tab's panel id and the id of the tab button that labels it. */
  panelId: string;
  labelledBy: string;
  runControls: ReactNode;
  children: ReactNode;
}

export default function ScenarioPanel({ tab, onTab, counts, errorCount, panelId, labelledBy, runControls, children }: PanelProps) {
  return (
    <>
      <div className="twin-runrow">{runControls}</div>
      <div className="twin-tabbody" role="tabpanel" id={panelId} aria-labelledby={labelledBy}>
        <div className="twin-subtabs" role="tablist">
          {SCENARIO_TABS.map(([id, label]) => (
            <button type="button" key={id} id={`twin-subtab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`twin-subpanel-${id}`} className={tab === id ? "on" : ""} onClick={() => onTab(id)}>
              {label}
              {counts[id] > 0 ? ` · ${counts[id]}` : ""}
            </button>
          ))}
        </div>
        {errorCount > 0 && <p className="twin-err">{errorCount === 1 ? "One field needs attention before the run." : `${errorCount} fields need attention before the run.`}</p>}
        <div role="tabpanel" id={`twin-subpanel-${tab}`} aria-labelledby={`twin-subtab-${tab}`}>
          {children}
        </div>
      </div>
    </>
  );
}
