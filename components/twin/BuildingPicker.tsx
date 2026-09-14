"use client";

import { useEffect, useRef, useState } from "react";
import type { ImportResult } from "@/lib/layout/import";
import { formatBytes, LIMITS } from "@/lib/layout/limits";
import { compactSpec, layoutSpecSchema, type LayoutSpec } from "@/lib/layout/spec";
import type { WorkerRequest, WorkerResponse } from "../import.worker";

export type BuildingKind = "builtin" | "session" | "sample" | "drop";

export interface BuildingChoice {
  kind: BuildingKind;
  /** The imported spec for session/sample/drop; null for a built-in or while loading. */
  spec: LayoutSpec | null;
  name: string;
  error: string | null;
}

/** Where /import's "Open in 3D" leaves the compact spec. */
export const SESSION_KEY = "twin.layout.v1";

export const DC_NAMES: Record<string, string> = { "dc-east": "Norcross DC", "dc-west": "Fulton Industrial DC" };

export const BUILTIN: BuildingChoice = { kind: "builtin", spec: null, name: "", error: null };

/** The spec /import stored in this tab, validated; an error explains a missing or broken one. Never throws. */
export function readSessionSpec(): BuildingChoice {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return { kind: "session", spec: null, name: "", error: "No imported building in this tab yet. Open /import, read a drawing and press “Open in 3D”." };
    const parsed = layoutSpecSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { kind: "session", spec: null, name: "", error: "The stored building could not be read; import it again." };
    const spec = parsed.data as LayoutSpec;
    return { kind: "session", spec, name: spec.name, error: null };
  } catch {
    return { kind: "session", spec: null, name: "", error: "This browser blocks session storage; drop the drawing here instead." };
  }
}

/** Parse drawing files with components/import.worker.ts and return the layout, terminating the worker afterwards. */
export function importSpecInWorker(files: Array<{ name: string; bytes: ArrayBuffer }>): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../import.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "The import worker failed."));
    };
    const payload: WorkerRequest = { files: files.map((f) => ({ name: f.name, bytes: f.bytes })), options: {} };
    w.postMessage(payload, payload.files.map((f) => f.bytes));
  });
}

export async function fetchSampleFiles(names: string[]): Promise<Array<{ name: string; bytes: ArrayBuffer }>> {
  return Promise.all(
    names.map(async (name) => {
      const res = await fetch(`/samples/${name}`);
      if (!res.ok) throw new Error(`Could not load sample ${name} (${res.status}).`);
      return { name, bytes: await res.arrayBuffer() };
    })
  );
}

/** The message for a compact spec whose JSON is over the twin's limit (lib/twin/twin.ts refuses it), or null when it fits. */
export function specOverLimit(spec: LayoutSpec): string | null {
  const bytes = JSON.stringify(spec).length;
  return bytes > LIMITS.specJson ? `The layout is ${formatBytes(bytes)}, over the ${formatBytes(LIMITS.specJson)} limit; re-import with fewer walls and zones (they are drawing-only), or split the building.` : null;
}

function browserLimit(name: string): number {
  const n = name.toLowerCase();
  if (n.endsWith(".csv") || n.endsWith(".txt")) return LIMITS.browser.csv;
  if (n.endsWith(".zip") || n.endsWith(".imdf")) return LIMITS.browser.imdfZip;
  if (n.endsWith(".ifc")) return LIMITS.browser.ifc;
  if (n.endsWith(".json") || n.endsWith(".geojson")) return LIMITS.browser.geojson;
  return LIMITS.browser.dxf;
}

interface Props {
  dc: string;
  dcs: string[];
  value: BuildingChoice;
  disabled: boolean;
  onDc: (dc: string) => void;
  onChange: (choice: BuildingChoice) => void;
}

/** dc-west, dc-east, the building /import handed over, or a drawing dropped here (parsed in the import worker). */
export default function BuildingPicker({ dc, dcs, value, disabled, onDc, onChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const selectValue = value.kind === "builtin" ? dc : value.kind;

  const choose = (v: string) => {
    if (v === "session") onChange(readSessionSpec());
    else if (v === "drop") onChange({ kind: "drop", spec: null, name: "", error: null });
    else if (v === "sample") onChange({ kind: "sample", spec: value.kind === "sample" ? value.spec : null, name: value.kind === "sample" ? value.name : "", error: null });
    else {
      onDc(v);
      onChange(BUILTIN);
    }
  };

  const accept = async (picked: File[]) => {
    if (!picked.length) return;
    for (const f of picked) {
      if (f.name.toLowerCase().endsWith(".dwg")) {
        onChange({ kind: "drop", spec: null, name: f.name, error: "DWG files are not read directly. Export the drawing to DXF and drop the DXF." });
        return;
      }
      const cap = browserLimit(f.name);
      if (f.size > cap) {
        onChange({ kind: "drop", spec: null, name: f.name, error: `${f.name} is ${formatBytes(f.size)}, over the ${formatBytes(cap)} limit for that format in the browser.` });
        return;
      }
    }
    setParsing(true);
    try {
      const files = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
      const result = await importSpecInWorker(files);
      if (!alive.current) return;
      if (!result.stats) onChange({ kind: "drop", spec: null, name: result.spec.name, error: result.buildError ?? "The drawing has no racks the twin can simulate." });
      else {
        const spec = compactSpec(result.spec);
        // The worker's buildTwin refuses a spec over the limit; saying so here keeps the failure at the picker, not at Run.
        const over = specOverLimit(spec);
        if (over) onChange({ kind: "drop", spec: null, name: result.spec.name, error: over });
        else onChange({ kind: "drop", spec, name: result.spec.name, error: null });
      }
    } catch (err) {
      if (alive.current) onChange({ kind: "drop", spec: null, name: "", error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (alive.current) setParsing(false);
    }
  };

  return (
    <>
      <label className="row" style={{ marginTop: 0 }}>
        <span>Building</span>
        <select value={selectValue} onChange={(e) => choose(e.target.value)} disabled={disabled || parsing}>
          {dcs.map((id) => (
            <option key={id} value={id}>
              {DC_NAMES[id] ?? id}
            </option>
          ))}
          <option value="session">Imported on /import (this tab)</option>
          <option value="sample">Sample warehouse (CSV drawing)</option>
          <option value="drop">Drop a drawing…</option>
        </select>
      </label>
      {value.kind !== "builtin" && (
        <>
          <label className="row" style={{ marginTop: 0 }}>
            <span>Crew, demand and equipment from</span>
            <select value={dc} onChange={(e) => onDc(e.target.value)} disabled={disabled}>
              {dcs.map((id) => (
                <option key={id} value={id}>
                  {DC_NAMES[id] ?? id}
                </option>
              ))}
            </select>
          </label>
          {value.kind === "drop" && (
            <label
              className={`twin-drop${dragging ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void accept([...e.dataTransfer.files]);
              }}
            >
              <input type="file" multiple accept=".dxf,.csv,.txt,.geojson,.json,.zip,.imdf,.ifc,.dwg" onChange={(e) => void accept([...(e.target.files ?? [])])} disabled={parsing} />
              {parsing ? "Reading the drawing…" : value.spec ? `${value.name} · ${value.spec.racks.length} rack runs, ${value.spec.doors.length} doors` : "Drop a DXF, WMS CSV, GeoJSON, IMDF zip or IFC here, or click to choose. It never leaves your browser."}
            </label>
          )}
          {value.kind !== "drop" && value.spec && (
            <span className="sub" style={{ margin: 0 }}>
              {value.name} · {value.spec.widthFt} × {value.spec.depthFt} ft, {value.spec.racks.length} rack runs, {value.spec.doors.length} doors
            </span>
          )}
          {value.kind !== "drop" && !value.spec && !value.error && (
            <span className="sub" style={{ margin: 0 }}>
              Loading the drawing…
            </span>
          )}
          {value.error && <span className="twin-err">{value.error}</span>}
        </>
      )}
    </>
  );
}
