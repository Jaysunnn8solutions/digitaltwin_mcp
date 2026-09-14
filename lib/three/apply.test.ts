/**
 * A hand-built Playback (typed arrays per lib/trace/types.ts) drives the
 * scene: actors hidden at t = 0, a worker at the route origin at jobStart,
 * face fill following the faces timeline, doors and loose pallets following
 * their timelines, the hot pulse a function of sim time, and every geometry
 * disposed.
 */
import { describe, expect, it } from "vitest";
import { Color, Matrix4, MeshBasicMaterial, Vector3 } from "three";
import catalogJson from "../../data/catalog.json";
import sitesJson from "../../data/sites.json";
import { ActorState, DirtyKind, LANE_SLOTS, PalletAt, SegKind, SYNTH_JOB, type CsrTimeline, type DirtyList, type EntityDef, type PalletTimeline, type Playback, type SkuInfo, type Track, type WorldPayload } from "../trace/types";
import { buildLayout, siteToSpec } from "../twin/layout";
import { PROCESSES, type Catalog, type Site } from "../twin/types";
import { ActorPool, LoosePallets, MaterialCache } from "./actors";
import { applyFrame, bindScene, PlaybackSampler, POSE, POSE_STRIDE, rowAt, upperBound, type SceneRefs } from "./apply";
import { buildBuilding, worldFromLayout } from "./building";
import { ResourceTracker, toWorld } from "./geometry";
import { queueChipEntity } from "./labels";
import { DOOR_COLORS, darken } from "./palette";
import { buildRacks } from "./racks";

const site = (sitesJson as Site[]).find((s) => s.id === "dc-west")!;
const catalog = catalogJson as Catalog;

/** A CSR timeline from per-item row lists. */
function csr<V extends Uint8Array | Uint16Array | Int32Array | Uint32Array>(items: Array<Array<[t: number, v: number]>>, make: (n: number) => V): CsrTimeline<V> {
  const offsets = new Int32Array(items.length + 1);
  let n = 0;
  items.forEach((rows, i) => {
    offsets[i] = n;
    n += rows.length;
  });
  offsets[items.length] = n;
  const t = new Float64Array(n);
  const v = make(n);
  const ev = new Int32Array(n).fill(-1);
  let k = 0;
  for (const rows of items) for (const [rt, rv] of rows) {
    t[k] = rt;
    v[k] = rv;
    k++;
  }
  return { offsets, t, v, ev };
}

interface Key {
  t: number;
  x: number;
  y: number;
  z?: number;
  h?: number;
  s: number;
  seg?: number;
  job?: number;
  carry?: number;
}

function track(entity: number, keys: Key[]): Track {
  const n = keys.length;
  const tr: Track = { entity, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), h: new Float32Array(n), s: new Uint8Array(n), seg: new Uint8Array(n), job: new Int32Array(n), carry: new Int32Array(n) };
  keys.forEach((k, i) => {
    tr.t[i] = k.t;
    tr.x[i] = k.x;
    tr.y[i] = k.y;
    tr.z[i] = k.z ?? 0;
    tr.h[i] = k.h ?? 0;
    tr.s[i] = k.s;
    tr.seg[i] = k.seg ?? SegKind.Hold;
    tr.job[i] = k.job ?? SYNTH_JOB.none;
    tr.carry[i] = k.carry ?? -1;
  });
  return tr;
}

function fixture() {
  const layout = buildLayout(siteToSpec(site), site);
  const world = worldFromLayout(layout);
  const skus: SkuInfo[] = catalog.skus.map((s) => ({ id: s.id, name: s.name, category: s.category, supplier: s.supplier, innersPerCase: s.innersPerCase, casesPerPallet: s.casesPerPallet, innerCubeFt: s.innerCubeFt, innerRetail: s.innerRetail }));
  const nFaces = layout.pick.length;
  const nRes = layout.reserve.length;
  const cap = (i: number) => site.pick.faceCases * skus[i].innersPerCase;
  const entities: EntityDef[] = [
    { kind: "worker", id: "W-W-001", label: "W-W-001", colorIdx: 0, meta: { role: "Shift lead" } },
    { kind: "forklift", id: "F0", label: "F0", colorIdx: 0, meta: {} },
    { kind: "truckIn", id: "PO-dc-west-1", label: "PO-dc-west-1", colorIdx: 0, meta: { importer: true } },
    { kind: "pallet", id: "PO-dc-west-1#0", label: "pallet", colorIdx: 1, meta: {} },
  ];
  const depot = layout.depot;
  const face0 = layout.pick[0];
  const tracks: Array<Track | null> = [
    track(0, [
      { t: 0, x: world.entrance[0], y: world.entrance[1], s: ActorState.Off },
      { t: 10, x: depot.x, y: depot.y, h: Math.PI / 2, s: ActorState.Work, seg: SegKind.Handle, job: 1 },
      { t: 12, x: depot.x, y: depot.y, h: Math.PI / 2, s: ActorState.Walk, seg: SegKind.WalkCart, job: 1 },
      { t: 14, x: face0.x, y: face0.y, h: Math.PI / 2, s: ActorState.Work, seg: SegKind.Handle, job: 1 },
      { t: 20, x: depot.x, y: depot.y, h: -Math.PI / 2, s: ActorState.Idle },
      { t: 30, x: depot.x, y: depot.y, h: -Math.PI / 2, s: ActorState.Overtime },
      { t: 50, x: world.entrance[0], y: world.entrance[1], s: ActorState.Off },
    ]),
    track(1, [
      { t: 0, x: 0, y: 0, s: ActorState.Off },
      { t: 5, x: world.parks.forklifts[0][0], y: world.parks.forklifts[0][1], s: ActorState.Idle },
      { t: 35, x: world.parks.forklifts[0][0], y: world.parks.forklifts[0][1], z: 4, s: ActorState.Lift, seg: SegKind.Lift, job: 2, carry: 3 },
      { t: 50, x: 0, y: 0, z: 4, s: ActorState.Off },
    ]),
    track(2, [
      { t: 0, x: -80, y: -60, s: ActorState.Off },
      { t: 38, x: -80, y: -60, h: 0, s: ActorState.Drive, seg: SegKind.Yard, job: SYNTH_JOB.yard },
      { t: 40, x: 24, y: 0, h: -Math.PI / 2, s: ActorState.Docked },
      { t: 45, x: 24, y: 0, h: -Math.PI / 2, s: ActorState.Depart, seg: SegKind.Yard },
      { t: 46, x: -80, y: -60, s: ActorState.Off },
    ]),
  ];
  const faces = csr(
    Array.from({ length: nFaces }, (_, i) => (i === 0 ? [[0, cap(0)], [30, 10]] : [[0, i < skus.length ? cap(i) : 0]])),
    (n) => new Uint16Array(n)
  );
  const faceHot = csr(
    Array.from({ length: nFaces }, (_, i) => (i === 1 ? [[0, 0], [30, 1]] : [[0, 0]])),
    (n) => new Uint8Array(n)
  );
  const faceSku = Int32Array.from({ length: nFaces }, (_, i) => (i < skus.length ? i : -1));
  const reserveSlots = csr(
    Array.from({ length: nRes }, (_, i) => [[0, i < skus.length ? 1 : 0]]),
    (n) => new Uint8Array(n)
  );
  const reserveSku = csr(
    Array.from({ length: nRes }, (_, i) => [[0, i < skus.length ? i : -1]]),
    (n) => new Int32Array(n)
  );
  const reserveInners = csr(
    skus.map(() => [[0, 100]]),
    (n) => new Uint32Array(n)
  );
  const doors = csr(
    layout.doors.map((_, i) => (i === 0 ? [[0, -1], [40, 2], [45, -1]] : [[0, -1]])),
    (n) => new Int32Array(n)
  );
  const laneSlots = csr(
    Array.from({ length: layout.doors.length * LANE_SLOTS }, (_, i) => (i === 0 ? [[0, -1], [42, 3], [44, -1]] : [[0, -1]])),
    (n) => new Int32Array(n)
  );
  const stations = csr(
    world.stations.map((_, i) => (i === 0 ? [[0, -1], [12, 1], [20, -1]] : [[0, -1]])),
    (n) => new Int32Array(n)
  );
  const pallets: PalletTimeline = {
    offsets: Int32Array.from([0, 4]),
    t: Float64Array.from([0, 40, 42, 44]),
    at: Uint8Array.from([PalletAt.Unborn, PalletAt.TrailerIn, PalletAt.DockLane, PalletAt.Gone]),
    ref: Int32Array.from([-1, 2, 0, -1]),
    slot: Int32Array.from([-1, 0, 0, -1]),
    ev: Int32Array.from([-1, -1, -1, -1]),
  };
  const dirtyRows: Array<[t: number, kind: number, idx: number, row: number]> = [
    [12, DirtyKind.Station, 0, 1],
    [20, DirtyKind.Station, 0, 2],
    [30, DirtyKind.Face, 0, 1],
    // Rows index the whole timeline: face 0 owns rows 0-1, so face 1's second row is row 2.
    [30, DirtyKind.FaceHot, 1, 2],
    [40, DirtyKind.Door, 0, 1],
    [40, DirtyKind.Pallet, 0, 1],
    [42, DirtyKind.LaneSlot, 0, 1],
    [42, DirtyKind.Pallet, 0, 2],
    [44, DirtyKind.LaneSlot, 0, 2],
    [44, DirtyKind.Pallet, 0, 3],
    [45, DirtyKind.Door, 0, 2],
  ];
  const dirty: DirtyList = { t: Float64Array.from(dirtyRows.map((r) => r[0])), kind: Uint8Array.from(dirtyRows.map((r) => r[1])), idx: Int32Array.from(dirtyRows.map((r) => r[2])), row: Int32Array.from(dirtyRows.map((r) => r[3])) };
  const queues = new Uint16Array(60 * PROCESSES.length);
  for (let b = 5; b < 10; b++) queues[b * PROCESSES.length + PROCESSES.indexOf("pick")] = 2;
  const pb: Playback = {
    meta: { dc: site.id, startWeek: 36, days: 1, seed: 1, horizonEnd: 1440, layoutName: site.id, compiler: "test", offsets: true, checkpointMin: 60 },
    entities,
    tracks,
    faces,
    faceHot,
    faceSku,
    reserveSlots,
    reserveSku,
    reserveInners,
    doors,
    laneSlots,
    stations,
    pallets,
    dirty,
    jobs: [
      {
        id: 1,
        process: "pick",
        info: { kind: "pick", order: "s1-d0", tour: 0, tours: 1, lines: [{ sku: skus[0].id, inners: 4, loc: face0.id }], feet: 50, walkMin: 0.28, handleMin: 2, bends: 1 },
        priority: 3,
        queuedAt: 5,
        startAt: 10,
        endAt: 20,
        truncated: false,
        worker: "W-W-001",
        productivity: 1,
        dur: 10,
        waitMin: 5,
        equipWaitMin: 0,
        forklift: -1,
        palletJack: -1,
        inDoor: -1,
        outDoor: -1,
        station: -1,
        engineFeet: 50,
        routeFeet: 50,
        transferFeet: 0,
        visualFeet: 50,
        stopMin: 5,
        moveMin: 5,
        speedRatio: 1,
        fit: "exact",
        ev: 0,
      },
      {
        id: 2,
        process: "putaway",
        info: { kind: "putaway", po: "PO-dc-west-1", pallet: 0, engineDoor: "IN-1", items: [{ sku: skus[0].id, cases: 10, loc: layout.reserve[0].id }], farFt: 80, liftMin: 0 },
        priority: 2,
        queuedAt: 30,
        startAt: 35,
        endAt: 50,
        truncated: false,
        worker: "W-W-002",
        productivity: 1,
        dur: 15,
        waitMin: 5,
        equipWaitMin: 0,
        forklift: 0,
        palletJack: -1,
        inDoor: 0,
        outDoor: -1,
        station: -1,
        engineFeet: 160,
        routeFeet: 160,
        transferFeet: 40,
        visualFeet: 200,
        stopMin: 5,
        moveMin: 10,
        speedRatio: 1.8,
        fit: "borrowed",
        ev: 1,
      },
    ],
    queueBins: { binMin: 1, count: 60, queues, series: new Float32Array(0) },
    kpiBins: { binMin: 5, count: 12, queues: new Uint16Array(0), series: new Float32Array(12 * 18) },
    checkpoints: [],
    samples: { dockToStock: new Float32Array(0), doorWaits: new Float32Array(0), cycleMin: new Float32Array(0) },
    ticker: [],
    quiet: { t0: new Float64Array(0), t1: new Float64Array(0) },
    events: [],
    world,
  };
  const payload: WorldPayload = { layout, spec: layout.spec, world, slotting: [], skus, suppliers: [], stores: [], dc: { id: site.id, name: "Fulton Industrial DC", lon: -84.55, lat: 33.78 }, workers: [], changes: [] };
  return { layout, world, pb, payload, skus, cap };
}

function scene(quality: "high" | "low" = "high") {
  const f = fixture();
  const tracker = new ResourceTracker();
  const materials = new MaterialCache(tracker);
  const building = buildBuilding(f.layout.spec, f.layout, f.world, { tracker });
  const racks = buildRacks(f.layout, f.world, { tracker, quality });
  const pool = new ActorPool(tracker, materials, quality);
  const loose = new LoosePallets(tracker, quality);
  const refs: SceneRefs = { racks, building, actors: pool, loose };
  const twin = bindScene(refs, f.payload, f.pb, { heat: false, debugSpeed: false });
  const sampler = new PlaybackSampler(f.pb);
  const at = (t: number, dt = 0) => applyFrame(twin, sampler.sample(t), f.pb, dt);
  const dispose = () => {
    building.dispose();
    racks.dispose();
    pool.dispose();
    loose.dispose();
    tracker.disposeAll();
  };
  return { ...f, tracker, building, racks, pool, loose, twin, sampler, at, dispose };
}

const yScale = (racks: ReturnType<typeof scene>["racks"], i: number) => {
  const m = new Matrix4();
  racks.faces.getMatrixAt(i, m);
  return m.elements[5];
};

describe("PlaybackSampler", () => {
  it("binary search helpers", () => {
    expect(upperBound([0, 10, 20], 3, 10)).toBe(2);
    expect(upperBound([0, 10, 20], 3, -1)).toBe(0);
    expect(upperBound([0, 10, 20], 3, 99)).toBe(3);
    const tl = { offsets: Int32Array.from([0, 3, 3]), t: Float64Array.from([0, 10, 20]) };
    expect(rowAt(tl, 0, 5)).toBe(0);
    expect(rowAt(tl, 0, 10)).toBe(1);
    expect(rowAt(tl, 0, 50)).toBe(2);
    expect(rowAt(tl, 1, 50)).toBe(-1);
  });

  it("interpolates poses and reports the dirty rows crossed, resetting on a seek", () => {
    const { pb } = fixture();
    const s = new PlaybackSampler(pb);
    const first = s.sample(0);
    expect(first.reset).toBe(true);
    expect(first.poses.length).toBe(pb.tracks.length * POSE_STRIDE);
    expect(first.poses[POSE.s]).toBe(ActorState.Off);
    const mid = s.sample(13);
    expect(mid.reset).toBe(false);
    expect(mid.dirtyFrom).toBe(0);
    expect(mid.dirtyTo).toBe(1);
    // Halfway between the depot and the first face.
    expect(mid.poses[POSE.x]).toBeCloseTo((pb.tracks[0]!.x[2] + pb.tracks[0]!.x[3]) / 2, 4);
    expect(mid.poses[POSE.seg]).toBe(SegKind.WalkCart);
    const later = s.sample(41);
    expect(later.dirtyFrom).toBe(1);
    expect(later.dirtyTo).toBe(6);
    const back = s.sample(20);
    expect(back.reset).toBe(true);
    s.seek();
    expect(s.sample(20.5).reset).toBe(true);
    expect(s.sample(21).reset).toBe(false);
  });
});

describe("applyFrame", () => {
  it("hides every actor at t = 0 and shows full faces", () => {
    const s = scene();
    s.at(0);
    expect(s.pool.activeCount).toBe(0);
    expect(s.twin.visibleActors).toBe(0);
    expect(yScale(s.racks, 0)).toBeGreaterThan(0.5);
    // An unslotted face is hidden.
    expect(yScale(s.racks, s.layout.pick.length - 1)).toBe(0);
    s.dispose();
  });

  it("places the worker within 1 ft of the route origin at jobStart", () => {
    const s = scene();
    s.at(0);
    s.at(10);
    const actor = s.pool.active.get(0)!;
    expect(actor).toBeDefined();
    expect(actor.group.visible).toBe(true);
    const origin = toWorld(s.layout.depot.x, s.layout.depot.y, 0, new Vector3());
    expect(actor.group.position.distanceTo(origin)).toBeLessThan(1);
    expect(actor.group.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    expect(actor.cart!.visible).toBe(false);
    s.at(13, 0.016);
    expect(actor.cart!.visible).toBe(true);
    expect(s.twin.labels.some((l) => l.entity === 0 && l.text === "W-W-001")).toBe(true);
    s.at(31);
    expect(actor.ring.visible).toBe(true);
    s.dispose();
  });

  it("scales a face with its timeline and re-reads after a seek", () => {
    const s = scene();
    s.at(0);
    const full = yScale(s.racks, 0);
    s.at(29);
    expect(yScale(s.racks, 0)).toBeCloseTo(full, 6);
    s.at(31);
    expect(yScale(s.racks, 0) / full).toBeCloseTo(10 / s.cap(0), 4);
    s.sampler.seek();
    s.at(5);
    expect(yScale(s.racks, 0)).toBeCloseTo(full, 6);
    s.at(31);
    expect(yScale(s.racks, 0) / full).toBeCloseTo(10 / s.cap(0), 4);
    s.dispose();
  });

  it("pulses a hot face as a function of sim time only", () => {
    const s = scene();
    const c = new Color();
    s.at(0);
    s.racks.faces.getColorAt(1, c);
    const plain = c.getHex();
    s.at(31);
    s.racks.faces.getColorAt(1, c);
    const a = c.getHex();
    s.at(31.25);
    s.racks.faces.getColorAt(1, c);
    const b = c.getHex();
    expect(a).not.toBe(plain);
    expect(a).not.toBe(b);
    // Same t → same colour, whatever frames ran in between.
    s.at(31);
    s.racks.faces.getColorAt(1, c);
    expect(c.getHex()).toBe(a);
    s.dispose();
  });

  it("follows doors, stations, lanes and pallets through the dirty list", () => {
    const s = scene();
    s.at(0);
    const lamp = s.building.doorLamps[0].material as MeshBasicMaterial;
    expect(lamp.color.getHex()).toBe(darken(DOOR_COLORS.inbound, 0.45));
    s.at(13);
    expect(s.twin.stationJob[0]).toBe(1);
    s.at(41);
    expect(lamp.color.getHex()).toBe(DOOR_COLORS.inbound);
    const truck = s.pool.active.get(2)!;
    expect(truck.kind).toBe("truck");
    expect(truck.sticker!.visible).toBe(true);
    expect(s.loose.count).toBe(0);
    s.at(43);
    expect(s.loose.count).toBe(1);
    expect(s.twin.laneOccupant[0]).toBe(3);
    const m = new Matrix4();
    s.loose.mesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(s.world.lanes[0].slots[0][0], 4);
    expect(m.elements[14]).toBeCloseTo(-s.world.lanes[0].slots[0][1], 4);
    const fork = s.pool.active.get(1)!;
    expect(fork.carried!.visible).toBe(true);
    expect(fork.carriage!.position.y).toBeCloseTo(4, 4);
    s.at(46.5);
    expect(lamp.color.getHex()).toBe(darken(DOOR_COLORS.inbound, 0.45));
    expect(s.loose.count).toBe(0);
    expect(s.pool.active.has(2)).toBe(false);
    s.at(0);
    expect(s.pool.activeCount).toBe(0);
    s.dispose();
  });

  it("shows queue chips over process homes and tints fast actors in debug mode", () => {
    const s = scene();
    s.at(7);
    const chip = s.twin.labels.find((l) => l.entity === queueChipEntity(PROCESSES.indexOf("pick")));
    expect(chip?.text).toBe("pick 2");
    expect(chip?.x).toBe(s.world.homes.pick[0]);
    s.at(20);
    expect(s.twin.labels.some((l) => l.entity === queueChipEntity(PROCESSES.indexOf("pick")))).toBe(false);
    s.twin.flags.debugSpeed = true;
    s.at(36);
    const fork = s.pool.active.get(1)!;
    expect(fork.baseTint).toBe(0xf03e9e);
    s.dispose();
  });

  it("disposes every geometry it created, at either quality", () => {
    for (const q of ["high", "low"] as const) {
      const s = scene(q);
      s.at(0);
      s.at(43);
      expect(s.tracker.created).toBeGreaterThan(10);
      s.dispose();
      expect(s.tracker.disposed).toBe(s.tracker.created);
      expect(s.tracker.materialsDisposed).toBe(s.tracker.materialsCreated);
    }
  });
});

describe("TwinViewerImpl without a renderer", () => {
  it("builds, samples, follows, walks, rebuilds on a quality change and disposes twice", async () => {
    const { createTwinViewer } = await import("./viewer");
    const f = fixture();
    const v = createTwinViewer({ shadows: true });
    v.resize(800, 600, 3);
    v.setWorld(f.payload);
    v.setPlayback(f.pb);
    v.frame(10, 0.016);
    // The worker at its job start and the forklift idling at its park.
    expect(v.stats().actors).toBe(2);
    expect(v.labels().some((l) => l.entity === 0 && l.text === "W-W-001")).toBe(true);
    v.setCamera("follow", 0);
    v.frame(11, 0.016);
    v.frame(12, 0.016);
    v.setCamera("walk");
    v.frame(13, 0.016);
    v.preset("dock");
    v.frame(41, 0.016);
    expect(v.stats().actors).toBe(3);
    v.setSelection({ kind: "face", index: 0 });
    v.frame(42, 0.016);
    v.setOptions({ heat: true, theme: "dark", shadows: false });
    v.frame(43, 0.016);
    v.setOptions({ quality: "low" });
    v.frame(44, 0.016);
    expect(v.stats().actors).toBe(3);
    v.seek(0);
    v.frame(0, 0.016);
    expect(v.stats().actors).toBe(0);
    expect(() => v.pick(0, 0)).not.toThrow();
    v.dispose();
    v.dispose();
    expect(v.labels()).toEqual([]);
  });
});
