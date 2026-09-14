"use client";

import { useEffect, useRef } from "react";

/** The keyboard map (design F), also the source of the first-run hint. */
export const KEY_MAP: ReadonlyArray<[keys: string, what: string]> = [
  ["Space", "play / pause"],
  ["← →", "one minute back / forward (Shift: an hour, Alt: a day)"],
  ["Home / End", "start / end of the run"],
  [", .", "slower / faster (1× 10× 60× 300× 1800×)"],
  ["0", "skip quiet hours (nights, weekends) on / off"],
  ["1 2 3 4 5", "camera presets: overview, dock, pick module, reserve, yard"],
  ["O F T", "orbit · follow the selected actor · walk (WASD, mouse to look, E to inspect, Esc to leave)"],
  ["Esc", "clear the selection, leave walk mode, close this help"],
  ["[ ]", "jump to the previous / next notable event in the ticker"],
  ["G", "heat view: pick faces shaded by lines per week"],
  ["L", "labels on / off"],
  ["Q", "quality: auto / high / low"],
  ["N", "day-night lighting on / off"],
  ["H", "HUD on / off"],
  ["M", "minimap on / off"],
  ["R", "run the scenario"],
  ["C", "compare panel"],
  ["?", "this help"],
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function HelpOverlay({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // A dialog takes focus when it opens (its Close button) and gives it back where it was when it closes.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      before?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="twin-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="row" style={{ marginTop: 0, justifyContent: "space-between" }}>
        <h3>How to drive the twin</h3>
        <button type="button" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="sub">
        Run a scenario, press Space, and watch: supplier trucks back into the inbound doors, forklifts put pallets away, pickers walk S-shaped tours through the pick module, packed pallets
        stage at the outbound doors and store trucks leave at their departure time. Click anything (a person, a truck, a rack face, a door, a queue chip) to open it in the inspector. Drag on the
        canvas to orbit, wheel to zoom, right-drag to pan. Numbers on the HUD are the engine&apos;s own accounting; the inspector says which rows are engine facts and which the picture adds.
      </p>
      <table>
        <tbody>
          {KEY_MAP.map(([k, what]) => (
            <tr key={k}>
              <td>
                {k.split(" ").map((key) => (
                  <kbd key={key} style={{ marginRight: 4 }}>
                    {key}
                  </kbd>
                ))}
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface HintProps {
  /** A full-width block in the page flow (narrow layouts) instead of a box floating over the stage. */
  block?: boolean;
  onDismiss: () => void;
  onHelp: () => void;
}

/** Shown once per browser until dismissed ("Got it" remembers in localStorage). */
export function FirstRunHint({ block = false, onDismiss, onHelp }: HintProps) {
  return (
    <div className={`twin-overlay twin-hint${block ? " block" : ""}`} role="status">
      <span>
        <b>Space</b> plays, <b>drag the timeline</b> to scrub, <b>click anything</b> in the building to inspect it, <b>1–5</b> jump between camera views.{" "}
        <button type="button" className="chip" onClick={onHelp}>
          All keys
        </button>
      </span>
      <button type="button" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
