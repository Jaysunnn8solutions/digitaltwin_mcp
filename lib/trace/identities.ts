/**
 * Identities the engine does not have (design C): which forklift, pallet
 * jack, door, station or lane spot a job uses, and where a SKU's reserve
 * pallets physically stack. Every allocation is a deterministic function of
 * the ordered event stream, so the same seed always plays back the same way.
 */

import type { Location } from "../twin/layout";

export interface Acquired {
  index: number;
  /** True when every real unit was taken and the index is a synthesized n + k. Never happens when the engine's counters are respected. */
  overflow: boolean;
}

/**
 * A pool of n identical units. acquire(prefer) hands back the preferred unit
 * when it is free, else the lowest free one, else an overflow index n + k so
 * playback never blocks: the engine's counters are the truth and the
 * free-list only names what the counters already granted.
 */
export class FreeList {
  private readonly held: Set<number> = new Set();
  private readonly overflowHeld: Set<number> = new Set();

  constructor(readonly n: number) {}

  get busy(): number {
    return this.held.size + this.overflowHeld.size;
  }

  isFree(i: number): boolean {
    return i < this.n ? !this.held.has(i) : !this.overflowHeld.has(i);
  }

  acquire(prefer?: number): Acquired {
    if (prefer !== undefined && prefer >= 0 && prefer < this.n && !this.held.has(prefer)) {
      this.held.add(prefer);
      return { index: prefer, overflow: false };
    }
    for (let i = 0; i < this.n; i++) {
      if (!this.held.has(i)) {
        this.held.add(i);
        return { index: i, overflow: false };
      }
    }
    let k = this.n;
    while (this.overflowHeld.has(k)) k++;
    this.overflowHeld.add(k);
    return { index: k, overflow: true };
  }

  release(i: number): void {
    if (i < this.n) this.held.delete(i);
    else this.overflowHeld.delete(i);
  }
}

export interface ReserveChange {
  /** layout.reserve index. */
  pos: number;
  /** Pallets stacked there now. */
  slots: number;
  /** SKU index occupying it, -1 when empty. */
  sku: number;
}

/**
 * Where a SKU's reserve pallets sit. The engine keeps one fixed home position
 * per SKU and a count of inners; the scene shows pallets(sku) =
 * ceil(inners / (casesPerPallet · innersPerCase)) pallets: the first at home,
 * extras at the nearest free positions that are nobody's home (by index
 * distance), released last-in first-out; when nothing is free they stack at
 * home and the renderer shows a ×n badge.
 */
export class ReserveAllocator {
  private readonly homeOf = new Map<number, number>();
  private readonly isHome: Uint8Array;
  private readonly slots: Int32Array;
  private readonly skuAt: Int32Array;
  private readonly stacks = new Map<number, Array<{ pos: number; home: boolean }>>();

  constructor(
    readonly positions: Location[],
    homes: Array<[sku: number, pos: number]>
  ) {
    this.isHome = new Uint8Array(positions.length);
    this.slots = new Int32Array(positions.length);
    this.skuAt = new Int32Array(positions.length).fill(-1);
    for (const [sku, pos] of homes) {
      this.homeOf.set(sku, pos);
      this.isHome[pos] = 1;
    }
  }

  slotsAt(pos: number): number {
    return this.slots[pos];
  }

  skuAtPos(pos: number): number {
    return this.skuAt[pos];
  }

  home(sku: number): number {
    return this.homeOf.get(sku) ?? 0;
  }

  /** Positions holding pallets of `sku`, home first. */
  placed(sku: number): number[] {
    const out: number[] = [];
    for (const s of this.stacks.get(sku) ?? []) if (!out.includes(s.pos)) out.push(s.pos);
    return out;
  }

  private nearestFree(home: number): number {
    const n = this.positions.length;
    for (let k = 1; k < n; k++) {
      const lo = home - k;
      const hi = home + k;
      if (lo >= 0 && !this.isHome[lo] && this.slots[lo] === 0) return lo;
      if (hi < n && !this.isHome[hi] && this.slots[hi] === 0) return hi;
    }
    return -1;
  }

  /** Bring the SKU's pallet count to `want`; returns the position changes in order. */
  set(sku: number, want: number): ReserveChange[] {
    const changes: ReserveChange[] = [];
    const stack = this.stacks.get(sku) ?? [];
    this.stacks.set(sku, stack);
    const home = this.home(sku);
    while (stack.length < want) {
      // First pallet at home; extras at the nearest free non-home position;
      // stacked at home (×n) when nothing is free.
      let pos = home;
      if (this.slots[home] > 0) {
        const free = this.nearestFree(home);
        if (free >= 0) pos = free;
      }
      stack.push({ pos, home: pos === home });
      this.slots[pos]++;
      if (this.skuAt[pos] === -1) this.skuAt[pos] = sku;
      changes.push({ pos, slots: this.slots[pos], sku: this.skuAt[pos] });
    }
    while (stack.length > want) {
      const top = stack.pop()!;
      this.slots[top.pos] = Math.max(0, this.slots[top.pos] - 1);
      if (this.slots[top.pos] === 0) this.skuAt[top.pos] = -1;
      changes.push({ pos: top.pos, slots: this.slots[top.pos], sku: this.skuAt[top.pos] });
    }
    return changes;
  }
}
