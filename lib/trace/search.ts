/**
 * Binary searches over sorted numeric arrays (keyframe times, dirty-list
 * times, CSR rows). Both return an index in [lo, hi]; the caller subtracts one
 * to land on the row in effect at a time.
 */

/** First index i in [lo, hi) with a[i] >= t, or hi. */
export function lowerBound(a: ArrayLike<number>, t: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i in [lo, hi) with a[i] > t, or hi. */
export function upperBound(a: ArrayLike<number>, t: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
