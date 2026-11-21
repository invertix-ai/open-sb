// Small statistics helpers shared by the playground tests: percentiles, a summary and a histogram.

export interface Summary {
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

/** The p-th percentile (0 to 100) with linear interpolation between the closest ranks. NaN when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank), high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, min: NaN, max: NaN, mean: NaN, p50: NaN, p95: NaN };
  return {
    n: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

export interface Bin {
  from: number;
  to: number;
  count: number;
}

/** Equal-width bins from the smallest to the largest value; the last bin includes its upper edge. */
export function histogram(values: readonly number[], bins = 10): Bin[] {
  if (values.length === 0) return [];
  const min = Math.min(...values), max = Math.max(...values);
  const count = Math.max(1, Math.floor(bins));
  const width = max > min ? (max - min) / count : 1;
  const result: Bin[] = Array.from({ length: count }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
  for (const value of values) result[Math.min(count - 1, Math.floor((value - min) / width))]!.count++;
  return result;
}

/** Megabytes (10^6 bytes) per second. */
export const mbPerSecond = (bytes: number, ms: number): number => ms > 0 ? bytes / 1e6 / (ms / 1000) : Infinity;
