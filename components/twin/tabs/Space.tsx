"use client";

import { applyImportEdits, builtinPickFaces, checkFaces, extensionHelp, fieldHelp, importPickFaces, PICK_ZONE_KEYS, RESERVE_ZONE_KEYS } from "@/lib/twin-ui/form";
import { NumField, SelectField, type TabProps } from "../ScenarioPanel";

const ZONE_LABELS: Record<string, string> = {
  aisles: "Aisles",
  baysPerSide: "Bays per side",
  levels: "Levels",
  slotsPerBay: "Slots per bay",
  bayWidthFt: "Bay width, ft",
  aisleWidthFt: "Aisle width, ft",
  rackDepthFt: "Rack depth, ft",
};

/** Pick faces the run will have with the form as it stands, and the message when the catalog would not fit. */
export function spaceCheck(form: TabProps["form"], ctx: TabProps["ctx"]): { faces: number; error: string | null } {
  if (ctx.imported) {
    const faces = importPickFaces(applyImportEdits(ctx.imported, ctx.importEdits));
    return { faces, error: checkFaces(faces, ctx.skuCount) };
  }
  if (!ctx.pickZone) return { faces: 0, error: null };
  const faces = builtinPickFaces(form, ctx.pickZone);
  return { faces, error: checkFaces(faces, ctx.skuCount) };
}

export default function Space({ form, update, errors, ctx }: TabProps) {
  const check = spaceCheck(form, ctx);
  const pickBase = ctx.pickZone;
  return (
    <div>
      <h3>Slotting and faces</h3>
      <div className="twin-fields">
        <SelectField
          label="Slotting"
          help={fieldHelp("slotting")}
          error={errors.slotting}
          value={form.slotting}
          onChange={(v) => update((f) => ({ ...f, slotting: v }))}
          options={[
            { value: "", label: "default (current)" },
            { value: "current", label: "current" },
            { value: "optimized", label: "optimized" },
          ]}
        />
        <NumField label="Face cases" help={fieldHelp("faceCases")} error={errors.faceCases} value={form.faceCases} onChange={(v) => update((f) => ({ ...f, faceCases: v }))} placeholder="3" min={1} max={8} step={1} />
      </div>

      <h3>Doors and equipment</h3>
      <div className="twin-fields">
        <NumField label="Inbound doors" help={fieldHelp("inboundDoors")} error={errors.inboundDoors} value={form.inboundDoors} onChange={(v) => update((f) => ({ ...f, inboundDoors: v }))} placeholder="site" min={1} max={20} step={1} />
        <NumField label="Outbound doors" help={fieldHelp("outboundDoors")} error={errors.outboundDoors} value={form.outboundDoors} onChange={(v) => update((f) => ({ ...f, outboundDoors: v }))} placeholder="site" min={1} max={20} step={1} />
        <NumField label="Forklifts" help={fieldHelp("forklifts")} error={errors.forklifts} value={form.forklifts} onChange={(v) => update((f) => ({ ...f, forklifts: v }))} placeholder="site" min={0} max={20} step={1} />
        <NumField label="Pallet jacks" help={fieldHelp("palletJacks")} error={errors.palletJacks} value={form.palletJacks} onChange={(v) => update((f) => ({ ...f, palletJacks: v }))} placeholder="site" min={0} max={20} step={1} />
      </div>

      {ctx.imported ? (
        <>
          <h3>Imported racks</h3>
          <p className="help sub" style={{ fontSize: 11 }}>
            The drawing fixes where the racks stand; these edit every run&apos;s levels and pick slots per bay, and the aisle width assumed beside a run with open floor on one side. rackZones
            does not apply to an imported building.
          </p>
          <div className="twin-fields">
            <NumField label="Levels" value={ctx.importEdits.levels} onChange={(v) => ctx.setImportEdits({ ...ctx.importEdits, levels: v })} placeholder="drawing" min={1} max={12} step={1} />
            <NumField label="Pick slots per bay" value={ctx.importEdits.slotsPerBay} onChange={(v) => ctx.setImportEdits({ ...ctx.importEdits, slotsPerBay: v })} placeholder="drawing" min={1} max={10} step={1} />
            <NumField label="Single-sided aisle, ft" value={ctx.importEdits.aisleWidthFt} onChange={(v) => ctx.setImportEdits({ ...ctx.importEdits, aisleWidthFt: v })} placeholder={String(ctx.imported.aisleWidthFt)} min={3} max={20} />
          </div>
        </>
      ) : (
        <>
          <h3>Rack zones</h3>
          <p className="help sub" style={{ fontSize: 11 }}>
            {extensionHelp("rackZones")} Blank keeps the site&apos;s value, shown as the placeholder.
          </p>
          {errors.rackPick && <p className="twin-err">{errors.rackPick}</p>}
          <b style={{ fontSize: 12 }}>Pick zone</b>
          <div className="twin-fields">
            {PICK_ZONE_KEYS.map((k) => (
              <NumField key={k} label={ZONE_LABELS[k]} error={errors[`rackPick.${k}`]} value={form.rackPick[k]} onChange={(v) => update((f) => ({ ...f, rackPick: { ...f.rackPick, [k]: v } }))} placeholder={pickBase && k in pickBase ? String(pickBase[k as keyof typeof pickBase]) : "site"} min={1} />
            ))}
          </div>
          {errors.rackReserve && <p className="twin-err">{errors.rackReserve}</p>}
          <b style={{ fontSize: 12 }}>Reserve zone</b>
          <div className="twin-fields">
            {RESERVE_ZONE_KEYS.map((k) => (
              <NumField key={k} label={ZONE_LABELS[k]} error={errors[`rackReserve.${k}`]} value={form.rackReserve[k]} onChange={(v) => update((f) => ({ ...f, rackReserve: { ...f.rackReserve, [k]: v } }))} placeholder="site" min={1} />
            ))}
          </div>
        </>
      )}
      <p className={check.error ? "twin-err" : "sub"} style={{ fontSize: 12 }}>
        {check.error ?? (check.faces > 0 ? `${check.faces.toLocaleString("en-US")} pick faces for ${ctx.skuCount} SKUs.` : "")}
      </p>
    </div>
  );
}
