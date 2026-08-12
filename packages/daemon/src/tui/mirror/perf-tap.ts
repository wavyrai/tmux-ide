/** Pure reporting helpers retained for benchmark result processing. */

/** A percentile of an ASCENDING-sorted array, linearly interpolated. Empty → 0. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

/** Distribution summary of `values` (order-independent — sorts a copy). */
export function summarize(values: number[]): Summary {
  const n = values.length;
  if (n === 0) return { count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean: sum / n,
  };
}
