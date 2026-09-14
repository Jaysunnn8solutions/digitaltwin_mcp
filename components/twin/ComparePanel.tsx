"use client";

import type { Kpis } from "@/lib/twin/replicate";
import { deltaClass, deltaText, KPI_META } from "@/lib/twin-ui/format";
import { keepFocus } from "./focus";

export interface CompareRun {
  label: string;
  kpis: Kpis;
  changes: string[];
}

interface Props {
  /** The previous run. */
  a: CompareRun | null;
  /** The run on screen. */
  b: CompareRun | null;
  onSwap: () => void;
}

/** A (the previous run) against B (the current one): every tools' KPI with its delta coloured by whether a rise is worse. */
export default function ComparePanel({ a, b, onSwap }: Props) {
  if (!b) return <p className="sub">Run a scenario first. The run before it becomes A and the new one B.</p>;
  if (!a) return <p className="sub">One run so far. Change an input on the Scenario tab and run again: this run becomes A and the next one B, with every KPI side by side.</p>;
  return (
    <div className="twin-compare">
      <div className="runs">
        <div>
          <b>A</b> {a.label}
          {a.changes.length > 0 && <span className="sub"> · {a.changes.join("; ")}</span>}
        </div>
        <div>
          <b>B</b> {b.label}
          {b.changes.length > 0 && <span className="sub"> · {b.changes.join("; ")}</span>}
        </div>
        <div className="row" style={{ marginTop: 2 }}>
          <span onMouseDown={keepFocus}>
            <button type="button" onClick={onSwap}>
              Swap: play A
            </button>
          </span>
          <span className="sub">The timeline draws B&apos;s queue and late strips over A&apos;s.</span>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>KPI</th>
            <th>A</th>
            <th>B</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {KPI_META.map((m) => (
            <tr key={m.key}>
              <td>{m.label}</td>
              <td>{m.fmt(a.kpis[m.key])}</td>
              <td>{m.fmt(b.kpis[m.key])}</td>
              <td className={deltaClass(m.key, a.kpis[m.key], b.kpis[m.key])}>{deltaText(m.key, a.kpis[m.key], b.kpis[m.key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="twin-legend">Green: B is better on that KPI; red: worse. Same seed, so the difference is the scenario, not the dice.</p>
    </div>
  );
}
