"use client";

import type { PickResult } from "@/lib/three/api";
import type { DescribeSection } from "@/lib/twin-ui/describe";

interface Props {
  title: string;
  selection: PickResult | null;
  sections: DescribeSection[];
  /** The selection is an actor with a track: it can be followed. */
  canFollow: boolean;
  following: boolean;
  onFollow: () => void;
  onClear: () => void;
}

/** The inspector tab: sections of label/value rows; rows the playback synthesized carry a "shown" tag. */
export default function Inspector({ title, selection, sections, canFollow, following, onFollow, onClear }: Props) {
  return (
    <div className="twin-inspect">
      <h3>
        <span style={{ flex: "1 1 auto" }}>{title}</span>
        {canFollow && (
          <button type="button" className={`chip${following ? " primary" : ""}`} onClick={onFollow}>
            {following ? "Following" : "Follow"}
          </button>
        )}
        {selection && (
          <button type="button" className="chip" onClick={onClear}>
            Clear
          </button>
        )}
      </h3>
      {!selection && <p className="sub">Click a person, a truck, a pallet, a rack face, a door, a lane spot, a pack station or a queue chip in the building. In walk mode, look at it and press E.</p>}
      {sections.map((s, i) => (
        <div className="sec" key={`${s.title}-${i}`}>
          <h4>{s.title}</h4>
          <dl>
            {s.rows.map((r, j) => (
              <RowPair key={`${r.label}-${j}`} label={r.label} value={r.value} shown={r.shown === true} />
            ))}
          </dl>
        </div>
      ))}
      {selection && (
        <p className="twin-legend">
          Plain rows are engine facts from the run&apos;s event trace. Rows tagged <em>shown</em> are what the playback adds to draw it (which door, which forklift, the route on the floor, the fit
          of the animation into the engine&apos;s minutes); they never feed back into the numbers.
        </p>
      )}
    </div>
  );
}

function RowPair({ label, value, shown }: { label: string; value: string; shown: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={shown ? "shown" : undefined}>{value}</dd>
    </>
  );
}
