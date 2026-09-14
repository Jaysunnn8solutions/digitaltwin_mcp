"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ROLES, type Role } from "@/lib/layout/assemble";
import { describeImport, type ImportOptions, type ImportResult } from "@/lib/layout/import";
import { formatBytes, LIMITS } from "@/lib/layout/limits";
import { compactSpec } from "@/lib/layout/spec";
import { floorSvg } from "@/lib/render/floor";
import { buildLayout } from "@/lib/twin/layout";
import type { Site } from "@/lib/twin/types";
import type { WorkerRequest, WorkerResponse } from "./import.worker";

type RunResult = {
  kpis: Record<string, number>;
  worst: Record<string, number>;
  bottleneck: { process: string | null; constraint: string };
  svg: string;
  layout: { pickFaces: number; reservePositions: number; pickAisles: number; feetPerLine: number; bendReachShare: number };
  crew: number;
  changes: string[];
};

const SAMPLES: Array<{ label: string; files: string[] }> = [
  { label: "DXF (CAD, mm, rotated)", files: ["sample-dc.dxf"] },
  { label: "WMS location CSV", files: ["sample-dc-locations.csv"] },
  { label: "IMDF archive", files: ["sample-dc-imdf.zip"] },
  { label: "ArcGIS Indoors GeoJSON", files: ["Units.geojson", "Details.geojson", "Levels.geojson"] },
  { label: "IFC (BIM)", files: ["sample-dc.ifc"] },
];

function browserLimit(name: string): number {
  const n = name.toLowerCase();
  if (n.endsWith(".csv") || n.endsWith(".txt")) return LIMITS.browser.csv;
  if (n.endsWith(".zip") || n.endsWith(".imdf")) return LIMITS.browser.imdfZip;
  if (n.endsWith(".ifc")) return LIMITS.browser.ifc;
  if (n.endsWith(".json") || n.endsWith(".geojson")) return LIMITS.browser.geojson;
  return LIMITS.browser.dxf;
}

const PREVIEW_SITE = { id: "preview" } as unknown as Site;

/** Where the /twin page reads an imported building from: sessionStorage, never the URL (a spec can be up to 1 MB). */
const TWIN_SESSION_KEY = "twin.layout.v1";

export default function ImportWorkbench() {
  const router = useRouter();
  const workerRef = useRef<Worker | null>(null);
  const [files, setFiles] = useState<Array<{ name: string; bytes: ArrayBuffer }>>([]);
  const [busy, setBusy] = useState<"" | "parsing" | "running">("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [roleMap, setRoleMap] = useState<Record<string, Role>>({});
  const [opts, setOpts] = useState<{ units: string; levels: string; rackUse: string }>({ units: "", levels: "", rackUse: "auto" });
  const [run, setRun] = useState<{ dc: string; startWeek: number; slotting: string; days: number }>({ dc: "dc-east", startWeek: 36, slotting: "current", days: 10 });
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const parse = (list: Array<{ name: string; bytes: ArrayBuffer }>, map: Record<string, Role>) => {
    const w = workerRef.current;
    if (!w || list.length === 0) return;
    setBusy("parsing");
    setError(null);
    setRunResult(null);
    const options: ImportOptions = {
      roleMap: Object.keys(map).length ? map : undefined,
      units: opts.units || undefined,
      levels: opts.levels ? Number(opts.levels) : undefined,
      rackUse: opts.rackUse as ImportOptions["rackUse"],
    };
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      setBusy("");
      if (e.data.ok) setResult(e.data.result);
      else {
        setResult(null);
        setError(e.data.error);
      }
    };
    // Copies, so the originals stay usable for a re-import with a new mapping.
    const payload: WorkerRequest = { files: list.map((f) => ({ name: f.name, bytes: f.bytes.slice(0) })), options };
    w.postMessage(payload, payload.files.map((f) => f.bytes));
  };

  const accept = async (picked: File[]) => {
    setError(null);
    for (const f of picked) {
      if (f.name.toLowerCase().endsWith(".dwg")) {
        setError("DWG files are not read directly. Export the drawing to DXF (Autodesk DWG TrueView or the ODA File Converter do it for free) and upload the DXF.");
        return;
      }
      const cap = browserLimit(f.name);
      if (f.size > cap) {
        setError(`${f.name} is ${formatBytes(f.size)}, over the ${formatBytes(cap)} limit for that format in the browser. The local MCP server accepts up to ${formatBytes(LIMITS.local.dxf)} for DXF and IFC.`);
        return;
      }
    }
    const list = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
    setFiles(list);
    setRoleMap({});
    parse(list, {});
  };

  const loadSample = async (names: string[]) => {
    const list = await Promise.all(
      names.map(async (name) => {
        const res = await fetch(`/samples/${name}`);
        if (!res.ok) throw new Error(`Could not load sample ${name}`);
        return { name, bytes: await res.arrayBuffer() };
      })
    ).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!list) return;
    setFiles(list);
    setRoleMap({});
    parse(list, {});
  };

  const preview = useMemo(() => {
    if (!result) return "";
    try {
      const layout = result.stats ? buildLayout(result.spec, PREVIEW_SITE) : undefined;
      return floorSvg(result.spec, { width: 900, layout });
    } catch {
      return floorSvg(result.spec, { width: 900 });
    }
  }, [result]);

  const runTwin = async () => {
    if (!result) return;
    setBusy("running");
    setError(null);
    try {
      const res = await fetch("/api/twin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: result.spec, ...run }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}`);
      setRunResult(body as RunResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const copySpec = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(JSON.stringify(result.spec));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The 3D page runs the twin in a worker in the browser; the building goes
  // through sessionStorage (same tab) and the run settings through the hash.
  const openIn3d = () => {
    if (!result) return;
    setOpenError(null);
    try {
      window.sessionStorage.setItem(TWIN_SESSION_KEY, JSON.stringify(compactSpec(result.spec)));
    } catch {
      setOpenError("This browser would not store the layout for the 3D page (storage full or blocked). On the 3D page, choose “Drop a drawing” and drop the file again.");
      return;
    }
    router.push(`/twin#dc=${encodeURIComponent(run.dc)}&week=${run.startWeek}&days=7&seed=1&src=session`);
  };

  const k = runResult?.kpis;
  const specBytes = result ? JSON.stringify(result.spec).length : 0;

  return (
    <div className="workbench">
      <section className="panel">
        <h2>1. Your building</h2>
        <p className="sub">
          DXF (export DWG to DXF first), a WMS location CSV, ArcGIS Indoors GeoJSON (several files at once), an IMDF zip, or IFC. The file is read in your browser
          and never uploaded; only the compact layout goes to the server when you run the twin. Limits here: DXF, IFC and GeoJSON {formatBytes(LIMITS.browser.dxf)}, IMDF zip{" "}
          {formatBytes(LIMITS.browser.imdfZip)}, CSV {formatBytes(LIMITS.browser.csv)}.
        </p>
        <label
          className={`drop${dragging ? " over" : ""}`}
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
          <input type="file" multiple accept=".dxf,.csv,.txt,.geojson,.json,.zip,.imdf,.ifc,.dwg" onChange={(e) => void accept([...(e.target.files ?? [])])} />
          <span>{files.length ? files.map((f) => `${f.name} (${formatBytes(f.bytes.byteLength)})`).join(", ") : "Drop a file here, or click to choose"}</span>
        </label>
        <div className="row">
          <span className="sub">Or try the sample warehouse as</span>
          {SAMPLES.map((s) => (
            <button key={s.label} type="button" className="chip" onClick={() => void loadSample(s.files)} disabled={busy !== ""}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="row">
          <label>
            Units{" "}
            <select value={opts.units} onChange={(e) => setOpts({ ...opts, units: e.target.value })}>
              <option value="">from the file</option>
              {["in", "ft", "mm", "cm", "m"].map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
          <label>
            Rack levels{" "}
            <input type="number" min={1} max={12} placeholder="4" value={opts.levels} onChange={(e) => setOpts({ ...opts, levels: e.target.value })} />
          </label>
          <label>
            Unlabelled racks{" "}
            <select value={opts.rackUse} onChange={(e) => setOpts({ ...opts, rackUse: e.target.value })}>
              <option value="auto">guess</option>
              <option value="pick">pick</option>
              <option value="reserve">reserve</option>
              <option value="mixed">mixed (pick level 1)</option>
            </select>
          </label>
          <button type="button" onClick={() => parse(files, roleMap)} disabled={!files.length || busy !== ""}>
            Re-import
          </button>
        </div>
        {busy === "parsing" && <p className="sub">Reading the file…</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <section className="panel">
          <h2>2. What the twin read</h2>
          <pre className="report">{describeImport(result)}</pre>
          <div dangerouslySetInnerHTML={{ __html: preview }} />
          {result.report.sources.length > 0 && (
            <details>
              <summary>Change how layers or categories are read ({result.report.sources.length})</summary>
              <table className="roles">
                <tbody>
                  {result.report.sources.slice(0, 60).map((s) => (
                    <tr key={s.source}>
                      <td>{s.source}</td>
                      <td>{s.features}</td>
                      <td>
                        <select
                          value={roleMap[s.source] ?? s.role}
                          onChange={(e) => setRoleMap({ ...roleMap, [s.source]: e.target.value as Role })}
                        >
                          {ROLES.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" onClick={() => parse(files, roleMap)} disabled={busy !== ""}>
                Re-import with these roles
              </button>
            </details>
          )}
          <div className="row">
            <button type="button" onClick={() => void copySpec()}>
              {copied ? "Copied" : `Copy layout spec (${formatBytes(specBytes)})`}
            </button>
            <span className="sub">Paste it into Claude as the layout argument of simulate_operations, what_if or find_capacity.</span>
          </div>
        </section>
      )}

      {result?.stats && (
        <section className="panel">
          <h2>3. Run the twin in it</h2>
          <div className="row">
            <label>
              Demand, crew and equipment from{" "}
              <select value={run.dc} onChange={(e) => setRun({ ...run, dc: e.target.value })}>
                <option value="dc-east">Norcross DC</option>
                <option value="dc-west">Fulton Industrial DC</option>
              </select>
            </label>
            <label>
              Week{" "}
              <input type="number" min={1} max={52} value={run.startWeek} onChange={(e) => setRun({ ...run, startWeek: Number(e.target.value) })} />
            </label>
            <label>
              Days{" "}
              <input type="number" min={1} max={28} value={run.days} onChange={(e) => setRun({ ...run, days: Number(e.target.value) })} />
            </label>
            <label>
              Slotting{" "}
              <select value={run.slotting} onChange={(e) => setRun({ ...run, slotting: e.target.value })}>
                <option value="current">current</option>
                <option value="optimized">optimized</option>
              </select>
            </label>
            <button type="button" className="primary" onClick={() => void runTwin()} disabled={busy !== ""}>
              {busy === "running" ? "Simulating…" : "Run the twin"}
            </button>
            <button type="button" onClick={openIn3d} disabled={busy !== ""} title="Watch a week run in this building, simulated and drawn in your browser">
              Open in 3D →
            </button>
          </div>
          {openError && <p className="error">{openError}</p>}
          {runResult && k && (
            <>
              <div className="tiles">
                <div className="tile">
                  <b>{(k.onTimeRate * 100).toFixed(0)}%</b>
                  <span>trucks on time</span>
                </div>
                <div className="tile">
                  <b>{(k.fillRate * 100).toFixed(1)}%</b>
                  <span>fill rate</span>
                </div>
                <div className="tile">
                  <b>{(k.utilization * 100).toFixed(0)}%</b>
                  <span>labor utilization</span>
                </div>
                <div className="tile">
                  <b>{k.overtimeHours.toFixed(1)}</b>
                  <span>overtime hours</span>
                </div>
                <div className="tile">
                  <b>{runResult.layout.feetPerLine.toFixed(1)} ft</b>
                  <span>walked per pick line</span>
                </div>
                <div className="tile">
                  <b>{(k.dockToStockAvgMin / 60).toFixed(1)} h</b>
                  <span>dock to stock</span>
                </div>
              </div>
              <p className="sub">
                {runResult.layout.pickFaces.toLocaleString("en-US")} pick faces in {runResult.layout.pickAisles} aisles, {runResult.layout.reservePositions.toLocaleString("en-US")} reserve
                positions, {runResult.crew} people. Busiest queue: {runResult.bottleneck.process ?? "none"} ({runResult.bottleneck.constraint}). Pick faces shaded by lines per week.
              </p>
              <div dangerouslySetInnerHTML={{ __html: runResult.svg }} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
