"use client";

import { useState } from "react";
import { ROLE_KEYS, ROLES } from "@/lib/twin/roles";
import { SKILLS } from "@/lib/twin/types";
import { extensionHelp, fieldHelp, SHIFTS_CAVEAT, STANDARD_KEYS, type AddWorkersRow, type CrossTrainRow, type ShiftRow, type WorkerLeaveRow, type WorkerOverrideRow } from "@/lib/twin-ui/form";
import { Field, NumField, RowList, SelectField, WeekdayPicker, type Column, type TabProps } from "../ScenarioPanel";

const STANDARD_HELP: Partial<Record<(typeof STANDARD_KEYS)[number], string>> = {
  unloadPerPallet: "min per pallet off the trailer",
  unloadPerTruck: "min per truck (paperwork, seal)",
  receivePerPallet: "min per pallet checked in",
  receivePerCase: "min per case counted",
  labelPerImportCase: "min per imported case labelled",
  putawayHandling: "min per pallet lifted into reserve",
  replenHandling: "min per replenishment move",
  pickPerLine: "min per pick line",
  pickPerInner: "min per inner picked",
  pickPerTour: "min per tour (cart, labels, drop-off)",
  pickBendReachSec: "s extra per line off the golden levels",
  packPerPallet: "min per pallet packed",
  loadPerPallet: "min per pallet loaded",
  loadPerTruck: "min per truck loaded",
  walkFtPerMin: "ft per min walking",
  forkliftFtPerMin: "ft per min driving",
  liftMinPerLevel: "min per rack level lifted",
  cartCubeFt: "cart capacity, ft³",
  palletCubeFt: "pallet capacity, ft³",
};

const dayCols = (): Array<Column<WorkerLeaveRow>> => [
  { key: "fromDay", label: "From day", type: "number", placeholder: "0", min: 0, max: 364 },
  { key: "toDay", label: "To day", type: "number", placeholder: "4", min: 0, max: 364 },
  { key: "worker", label: "Worker id", type: "text", placeholder: "W-E-004", list: "twin-workers" },
  { key: "role", label: "or role", type: "text", placeholder: "Forklift operator", list: "twin-roles" },
  { key: "count", label: "Count", type: "number", placeholder: "1", min: 1, max: 20 },
];

export default function Labor({ form, update, errors, ctx }: TabProps) {
  const [newWorker, setNewWorker] = useState("");
  const [showStandards, setShowStandards] = useState(false);
  const addRemove = () => {
    const id = newWorker.trim();
    if (!id) return;
    update((f) => (f.removeWorkers.includes(id) ? f : { ...f, removeWorkers: [...f.removeWorkers, id] }));
    setNewWorker("");
  };
  const crossCols: Array<Column<CrossTrainRow>> = [
    { key: "worker", label: "Worker id", type: "text", placeholder: "W-E-003", list: "twin-workers" },
    { key: "role", label: "or role", type: "text", placeholder: "Order selector", list: "twin-roles" },
    { key: "skill", label: "Skill", type: "select", options: SKILLS.map((s) => ({ value: s, label: s })), placeholder: "skill" },
  ];
  const addCols: Array<Column<AddWorkersRow>> = [
    { key: "role", label: "Role", type: "select", options: ROLE_KEYS.map((k) => ({ value: k, label: `${ROLES[k].role} ($${ROLES[k].wage}/h)` })), placeholder: "role" },
    { key: "shift", label: "Shift", type: "text", placeholder: ctx.shiftIds[0] ?? "day", list: "twin-shifts" },
    {
      key: "type",
      label: "Type",
      type: "select",
      options: [
        { value: "full-time", label: "full-time" },
        { value: "part-time", label: "part-time" },
        { value: "temp", label: "temp" },
      ],
      placeholder: "type",
    },
    { key: "count", label: "Count", type: "number", placeholder: "1", min: 1, max: 20 },
  ];
  const shiftCols: Array<Column<ShiftRow>> = [
    { key: "id", label: "Id", type: "text", placeholder: "day" },
    { key: "start", label: "Start", type: "time", placeholder: "06:00" },
    { key: "end", label: "End", type: "time", placeholder: "14:30" },
    { key: "breakMin", label: "Break min", type: "number", placeholder: "30", min: 0, max: 120 },
    { key: "indirectMin", label: "Indirect min", type: "number", placeholder: "30", min: 0, max: 120 },
  ];
  const overrideCols: Array<Column<WorkerOverrideRow>> = [
    { key: "worker", label: "Worker id", type: "text", placeholder: "W-E-003", list: "twin-workers" },
    { key: "productivity", label: "Productivity", type: "number", placeholder: "1.1", min: 0.5, max: 1.5 },
    { key: "maxWeeklyHours", label: "Hours / week", type: "number", placeholder: "40", min: 8, max: 60 },
    { key: "hourlyRate", label: "$ / hour", type: "number", placeholder: "20", min: 10, max: 80 },
  ];

  return (
    <div>
      <h3>Crew</h3>
      <Field label="Remove workers" help={fieldHelp("removeWorkers")} error={errors.removeWorkers}>
        <div className="twin-days">
          {form.removeWorkers.map((id) => (
            <button type="button" key={id} className="on" onClick={() => update((f) => ({ ...f, removeWorkers: f.removeWorkers.filter((x) => x !== id) }))} title="Click to keep">
              {id} ×
            </button>
          ))}
          <input
            type="text"
            list="twin-workers"
            value={newWorker}
            placeholder={ctx.workerIds[0] ?? "W-E-004"}
            style={{ maxWidth: 120 }}
            onChange={(e) => setNewWorker(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRemove();
              }
            }}
          />
          <button type="button" className="chip" onClick={addRemove}>
            Remove
          </button>
        </div>
      </Field>
      <RowList title="Add workers" help={fieldHelp("addWorkers")} rows={form.addWorkers} onChange={(rows) => update((f) => ({ ...f, addWorkers: rows }))} blank={{ role: "selector", shift: ctx.shiftIds[0] ?? "day", type: "full-time", count: "1" }} columns={addCols} errors={errors} prefix="addWorkers" addLabel="Add people" max={10} />
      <RowList title="Cross-train" help={fieldHelp("crossTrain")} rows={form.crossTrain} onChange={(rows) => update((f) => ({ ...f, crossTrain: rows }))} blank={{ worker: "", role: "", skill: "forklift" }} columns={crossCols} errors={errors} prefix="crossTrain" addLabel="Add a skill" max={20} />
      <RowList title="Leave" help={fieldHelp("workerLeave")} rows={form.workerLeave} onChange={(rows) => update((f) => ({ ...f, workerLeave: rows }))} blank={{ fromDay: "0", toDay: "4", worker: "", role: "", count: "" }} columns={dayCols()} errors={errors} prefix="workerLeave" addLabel="Add leave" max={20} />
      <RowList
        title="Worker overrides"
        help={extensionHelp("workerOverrides")}
        rows={form.workerOverrides}
        onChange={(rows) => update((f) => ({ ...f, workerOverrides: rows }))}
        blank={{ worker: ctx.workerIds[0] ?? "", productivity: "", maxWeeklyHours: "", hourlyRate: "" }}
        columns={overrideCols}
        errors={errors}
        prefix="workerOverrides"
        addLabel="Override a worker"
        max={40}
      />

      <h3>Attendance and flexing</h3>
      <div className="twin-fields">
        <NumField label="Absenteeism" help={fieldHelp("absenteeism")} error={errors.absenteeism} value={form.absenteeism} onChange={(v) => update((f) => ({ ...f, absenteeism: v }))} placeholder="0.04" min={0} max={0.5} step={0.01} />
        <SelectField
          label="Flex across skills"
          help={fieldHelp("flex")}
          error={errors.flex}
          value={form.flex}
          onChange={(v) => update((f) => ({ ...f, flex: v }))}
          options={[
            { value: "", label: "default (yes)" },
            { value: "true", label: "yes" },
            { value: "false", label: "no" },
          ]}
        />
        <NumField label="Overtime cap, h/day" help={fieldHelp("overtimeMaxHours")} error={errors.overtimeMaxHours} value={form.overtimeMaxHours} onChange={(v) => update((f) => ({ ...f, overtimeMaxHours: v }))} placeholder="2" min={0} max={6} step={0.5} />
        <NumField label="Target utilization" help={fieldHelp("targetUtilization")} error={errors.targetUtilization} value={form.targetUtilization} onChange={(v) => update((f) => ({ ...f, targetUtilization: v }))} placeholder="0.85" min={0.5} max={1} step={0.05} />
      </div>

      <h3>Shifts and days</h3>
      <RowList title="Shifts" help={extensionHelp("shifts")} rows={form.shifts} onChange={(rows) => update((f) => ({ ...f, shifts: rows }))} blank={{ id: form.shifts.length ? "evening" : "day", start: form.shifts.length ? "14:30" : "06:00", end: form.shifts.length ? "23:00" : "14:30", breakMin: "30", indirectMin: "30" }} columns={shiftCols} errors={errors} prefix="shifts" addLabel="Add a shift" max={3}>
        {form.shifts.length > 1 && <div className="twin-caveat">{SHIFTS_CAVEAT}</div>}
        {form.shifts.length === 1 && <div className="help sub" style={{ margin: "0 0 4px", fontSize: 11 }}>Keep the roster&apos;s shift id (day) so its people still have a home shift.</div>}
      </RowList>
      <WeekdayPicker label="Operating days" help={extensionHelp("operatingDays")} error={errors.operatingDays} value={form.operatingDays} onChange={(days) => update((f) => ({ ...f, operatingDays: days }))} />

      <h3>
        Labor standards{" "}
        <button type="button" className="chip" onClick={() => setShowStandards((s) => !s)}>
          {showStandards ? "hide" : `show ${STANDARD_KEYS.length}`}
        </button>
      </h3>
      <p className="help sub" style={{ fontSize: 11 }}>
        {extensionHelp("standards")} Blank keeps the engine&apos;s default, shown as the placeholder.
      </p>
      {errors.standards && <p className="twin-err">{errors.standards}</p>}
      {showStandards && (
        <div className="twin-fields">
          {STANDARD_KEYS.map((k) => (
            <NumField key={k} label={k} help={STANDARD_HELP[k]} error={errors[`standards.${k}`]} value={form.standards[k]} onChange={(v) => update((f) => ({ ...f, standards: { ...f.standards, [k]: v } }))} placeholder={String(ctx.std[k])} min={0} />
          ))}
        </div>
      )}
    </div>
  );
}
