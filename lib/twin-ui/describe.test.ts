/**
 * The inspector text on the hand-scripted fixture playback: every kind of
 * selection yields engine facts (rows not flagged `shown`), job cards carry
 * the fit, speed ratio and transfer distance, and a putaway measured from
 * one door but drawn at another says so.
 */
import { describe, expect, it } from "vitest";
import { loadCatalog, loadRoster } from "../data/store";
import { compilePlayback } from "../trace/compile";
import { buildFixture } from "../trace/fixtures";
import { type JobRow, type Playback, type WorldPayload } from "../trace/types";
import { buildWorld } from "../trace/world";
import type { PickResult } from "../three/api";
import { buildWorldPayload } from "../twin-worker/payload";
import { DEFAULT_STANDARDS } from "../twin/standards";
import { buildTwin } from "../twin/twin";
import { actorsAt, describeJob, describeSelection, indexEvents, selectionTitle, trackPoseAt } from "./describe";

async function fixturePlayback(): Promise<{ pb: Playback; world: WorldPayload }> {
  const ctx = await buildTwin("dc-west", 36, {});
  const f = buildFixture(ctx.layout, loadCatalog(), loadRoster().workers, DEFAULT_STANDARDS);
  const w = buildWorld(ctx.layout, f.workers);
  const pb = compilePlayback({ events: f.events, layout: ctx.layout, world: w, skus: f.skus, slotting: f.slotting });
  return { pb, world: buildWorldPayload(ctx, w) };
}

const engineRows = (sections: ReturnType<typeof describeSelection>) => sections.flatMap((s) => s.rows).filter((r) => !r.shown);
const shownRows = (sections: ReturnType<typeof describeSelection>) => sections.flatMap((s) => s.rows).filter((r) => r.shown);

describe("describeSelection on the fixture", () => {
  it("yields engine facts for every selection kind, at a busy minute and at the horizon", async () => {
    const { pb, world } = await fixturePlayback();
    const index = indexEvents(pb);
    const kinds = ["worker", "forklift", "jack", "pallet", "truckIn", "truckOut"] as const;
    const selections: Array<[string, PickResult]> = [];
    for (const kind of kinds) {
      const entity = pb.entities.findIndex((e) => e.kind === kind);
      expect(entity, `fixture has a ${kind}`).toBeGreaterThanOrEqual(0);
      selections.push([kind, { kind: "entity", entity }]);
    }
    selections.push(["face", { kind: "face", index: 0 }]);
    selections.push(["reserve", { kind: "reserve", index: 0 }]);
    selections.push(["door", { kind: "door", index: 0 }]);
    selections.push(["station", { kind: "station", index: 0 }]);
    selections.push(["lane", { kind: "lane", door: 0, slot: 0 }]);
    selections.push(["queue", { kind: "queue", process: "pick" }]);
    // A minute with tours, trucks and a forklift job under way, and the end of the day.
    const init = pb.events[0];
    const horizonEnd = init.k === "init" ? init.horizonEnd : 1440;
    for (const t of [7 * 60 + 40, 11 * 60, horizonEnd]) {
      for (const [name, sel] of selections) {
        const sections = describeSelection(sel, pb, world, t, index);
        expect(sections.length, `${name} at ${t}`).toBeGreaterThan(0);
        expect(engineRows(sections).length, `${name} at ${t} has engine facts`).toBeGreaterThan(0);
        for (const s of sections) {
          expect(s.title.length).toBeGreaterThan(0);
          for (const r of s.rows) {
            expect(r.label.length).toBeGreaterThan(0);
            expect(r.value.length).toBeGreaterThan(0);
          }
        }
        expect(selectionTitle(sel, pb, world).length).toBeGreaterThan(0);
      }
    }
    // Without an index the function builds one itself; the selection-less card is the clock.
    expect(describeSelection(null, pb, world, 500)[0].rows[0].value).toContain("Day 1");
    expect(describeSelection({ kind: "face", index: 0 }, pb, world, 500)).toEqual(describeSelection({ kind: "face", index: 0 }, pb, world, 500, index));
  });

  it("job cards carry fit, speed ratio and transfer distance, and the worker's card includes the job under way", async () => {
    const { pb, world } = await fixturePlayback();
    const started = pb.jobs.filter((j) => j.startAt >= 0);
    expect(started.length).toBeGreaterThan(5);
    for (const job of started) {
      const card = describeJob(job, world, job.startAt + 0.5);
      const labels = card.rows.map((r) => r.label);
      expect(labels).toContain("Fit");
      expect(labels).toContain("Speed ratio");
      const fit = card.rows.find((r) => r.label === "Fit")!;
      expect(fit.shown).toBe(true);
      expect(fit.value).toContain(job.fit);
      if (job.transferFeet > 0) expect(card.rows.find((r) => r.label === "Drawn route")!.value).toContain(`${Math.round(job.transferFeet)} ft to get there`);
      expect(card.rows.find((r) => r.label === "What")!.shown).toBeUndefined();
    }
    // A worker's card at a minute inside a tour names that job.
    const tour = started.find((j) => j.info.kind === "pick")!;
    const worker = pb.entities.findIndex((e) => e.kind === "worker" && e.id === tour.worker);
    const sections = describeSelection({ kind: "entity", entity: worker }, pb, world, tour.startAt + tour.dur / 2);
    expect(sections.some((s) => s.title === `Job ${tour.id} · pick`)).toBe(true);
    expect(engineRows(sections).some((r) => r.label === "Today" && /^\S+ shift \d\d:\d\d–\d\d:\d\d as /.test(r.value))).toBe(true);
  });

  it("notes when the engine measured a putaway from one door but the playback drew it at another", async () => {
    const { pb, world } = await fixturePlayback();
    const putaway = pb.jobs.find((j) => j.info.kind === "putaway" && j.startAt >= 0)!;
    expect(putaway).toBeDefined();
    const engineDoor = putaway.info.kind === "putaway" ? putaway.info.engineDoor : null;
    expect(engineDoor).not.toBeNull();
    const other = world.layout.doors.findIndex((d) => d.kind === "inbound" && d.id !== engineDoor);
    const mismatched: JobRow = { ...putaway, inDoor: other };
    const card = describeJob(mismatched, world, putaway.startAt + 0.1);
    const door = card.rows.find((r) => r.label === "Door")!;
    expect(door.shown).toBe(true);
    expect(door.value).toContain(`measured from ${engineDoor}, shown at ${world.layout.doors[other].id}`);
    // The same door: an engine fact, no note.
    const same = world.layout.doors.findIndex((d) => d.id === engineDoor);
    const plain = describeJob({ ...putaway, inDoor: same }, world, putaway.startAt + 0.1).rows.find((r) => r.label === "Door")!;
    expect(plain.shown).toBeUndefined();
    expect(plain.value).toBe(engineDoor);
    // Engine facts and shown rows are both present on a job card.
    expect(shownRows([card]).length).toBeGreaterThan(0);
    expect(engineRows([card]).length).toBeGreaterThan(0);
  });

  it("samples tracks for the minimap: nobody before clock-in, people on the floor mid-morning", async () => {
    const { pb } = await fixturePlayback();
    expect(actorsAt(pb, 60).filter((a) => a.kind === "worker")).toHaveLength(0);
    const mid = actorsAt(pb, 10 * 60);
    expect(mid.filter((a) => a.kind === "worker").length).toBeGreaterThan(0);
    for (const a of mid) {
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.y)).toBe(true);
    }
    const track = pb.tracks.find((tr) => tr && pb.entities[tr.entity].kind === "worker")!;
    expect(trackPoseAt(track, -1)).toBeNull();
    const p = trackPoseAt(track, track.t[track.t.length - 1] + 100)!;
    expect(p.x).toBe(track.x[track.t.length - 1]);
  });
});
