"use client";

import { useMemo, useState } from "react";
import type { Kpis } from "@/lib/twin/replicate";
import { minutes, money, num, pct } from "@/lib/twin-ui/format";
import { buildReport, reportCsv, reportFileStem, reportJson, reportMarkdown, type Report, type ReportRun } from "@/lib/twin-ui/report";
import { keepFocus } from "./focus";

interface Props {
  /** The run on screen, or null before the first run. */
  run: ReportRun | null;
  /** The previous run, for the delta section. */
  previous: { label: string; kpis: Kpis } | null;
}

type Format = "md" | "csv" | "json";

const MIME: Record<Format, string> = { md: "text/markdown", csv: "text/csv", json: "application/json" };

function render(r: Report, f: Format): string {
  return f === "md" ? reportMarkdown(r) : f === "csv" ? reportCsv(r) : reportJson(r);
}

/** Hand the browser a file: a Blob URL on a temporary anchor, revoked after the click. */
function download(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fill = (f: number | null) => (f === null ? "—" : pct(f, 1));

/**
 * The scenario report: what to change, the headline, the day-by-day table
 * and the export buttons. The full report (processes, crew, late trucks, the
 * delta against the previous run) is in the Markdown download; the panel
 * shows the parts a reader acts on.
 */
export default function ReportPanel({ run, previous }: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  const report = useMemo(() => (run ? buildReport(run, previous) : null), [run, previous]);
  if (!run || !report) return <p className="sub">Run a scenario first. The report reads the run on screen: fill rate, cost, late trucks and the bottleneck for every day, and what to change.</p>;

  const save = (f: Format) => {
    try {
      download(`${reportFileStem(report)}.${f}`, MIME[f], render(report, f));
      setMsg(`Saved ${reportFileStem(report)}.${f}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportMarkdown(report));
      setMsg("Markdown copied");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };
  const k = report.kpis;
  const late = k.lateTrucks + k.notLoaded;

  return (
    <div className="twin-report">
      <div className="head">
        <b>{report.title}</b>
        <span className="sub">{report.run.changes.length ? report.run.changes.join("; ") : "baseline scenario"}</span>
      </div>
      <div className="row" onMouseDown={keepFocus}>
        <button type="button" onClick={() => save("md")} title="The full report: headline, recommendations, days, processes, crew, late trucks">
          Download .md
        </button>
        <button type="button" onClick={() => save("csv")} title="The day-by-day table with unformatted numbers, for a spreadsheet">
          Days .csv
        </button>
        <button type="button" onClick={() => save("json")} title="Everything in the report as data">
          .json
        </button>
        <button type="button" onClick={() => void copy()}>
          Copy Markdown
        </button>
        {msg && (
          <span className="sub" role="status">
            {msg}
          </span>
        )}
      </div>

      <h3>Headline</h3>
      <div className="tiles">
        <div>
          <b className={late > 0 ? "bad" : "good"}>{late > 0 ? `${late} late` : "all on time"}</b>
          <span>{k.trucks + k.notLoaded} store trucks</span>
        </div>
        <div>
          <b className={k.fillRate < 0.99 ? "bad" : ""}>{pct(k.fillRate, 1)}</b>
          <span>fill rate</span>
        </div>
        <div>
          <b>{money(k.laborCost)}</b>
          <span>labor, ${k.costPerThousand.toFixed(2)} per $1k</span>
        </div>
        <div>
          <b>{pct(k.utilization)}</b>
          <span>{num(k.overtimeHours, 1)} h overtime</span>
        </div>
      </div>
      <p className="sub">
        Bottleneck: {report.bottleneck.process ? `${report.bottleneck.process}, ${num(report.bottleneck.waitHours, 1)} job-hours waiting; ${report.bottleneck.constraint}` : report.bottleneck.constraint}.
        {report.reserve.needed > report.reserve.positions ? ` Reserve overflow: ${report.reserve.needed} of ${report.reserve.positions} pallet positions.` : ""}
      </p>

      <h3>What to change</h3>
      <ul className="recs">
        {report.recommendations.map((rec, i) => (
          <li key={i}>
            <span className={`sev ${rec.severity}`}>{rec.severity}</span> <span className="area">{rec.area}</span>
            <p>{rec.finding}</p>
            <p className="action">{rec.action}</p>
          </li>
        ))}
      </ul>

      <h3>Day by day</h3>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>day</th>
              <th>fill</th>
              <th>trucks</th>
              <th>late</th>
              <th>cost</th>
              <th>OT h</th>
              <th>busy</th>
              <th>bottleneck</th>
            </tr>
          </thead>
          <tbody>
            {report.days.map((d) => (
              <tr key={d.day} className={d.trucksLate > 0 ? "bad" : ""}>
                <td>
                  {d.day + 1} · {d.weekday}
                </td>
                <td>{fill(d.fillRate)}</td>
                <td>{d.trucks}</td>
                <td>{d.trucksLate > 0 ? `${d.trucksLate} (${minutes(d.lateMin)})` : "—"}</td>
                <td>{money(d.laborCost)}</td>
                <td>{num(d.overtimeHours, 1)}</td>
                <td>{d.utilization === null ? "—" : pct(d.utilization)}</td>
                <td>{d.bottleneck ? `${d.bottleneck.process} ↑${d.bottleneck.peak}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="twin-legend">
        Cost is that day&apos;s paid and overtime hours at each worker&apos;s rate. The bottleneck is the process that queued the most job-minutes that day, with its peak queue. The Markdown download adds shipped dollars, inbound volume, processes,
        crew and the late trucks{report.previous ? `, and every KPI against ${report.previous.label}` : ""}.
      </p>
    </div>
  );
}
