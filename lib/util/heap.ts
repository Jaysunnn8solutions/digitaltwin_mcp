/**
 * Binary min-heap keyed by a number, with a monotonically increasing
 * insertion counter as the tie-break so equal keys pop first-in first-out.
 * The event calendar depends on that: two events at the same minute must run
 * in the order they were scheduled, or a run stops being reproducible.
 */
export class MinHeap<T> {
  private items: Array<{ key: number; seq: number; value: T }> = [];
  private seq = 0;

  get size(): number {
    return this.items.length;
  }

  push(key: number, value: T): void {
    const node = { key, seq: this.seq++, value };
    const a = this.items;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[p], a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  peekKey(): number | undefined {
    return this.items[0]?.key;
  }

  pop(): { key: number; value: T } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return { key: top.key, value: top.value };
  }

  private less(x: { key: number; seq: number }, y: { key: number; seq: number }): boolean {
    return x.key < y.key || (x.key === y.key && x.seq < y.seq);
  }
}
