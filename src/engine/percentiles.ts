import type { Percentiles } from "./types.ts";

/**
 * Percentile convention: probability of exceedance.
 * P90 = the value 90% of trials meet or exceed (conservative/low case).
 * P10 = the value only 10% of trials meet or exceed (optimistic/high case).
 * Note P90 < P10 under this convention — a deliberate, documented choice
 * (see docs/METHODOLOGY.md), not a bug.
 */
export function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const quantile = (q: number): number => {
    const idx = q * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  return {
    // Exceedance convention: P90 is the LOW value (90% of outcomes are >= it).
    p90: quantile(0.1),
    p50: quantile(0.5),
    p10: quantile(0.9),
    mean,
  };
}

/** Probability that values exceed (or meet) a threshold. */
export function probabilityExceeds(values: number[], threshold: number): number {
  const count = values.filter((v) => v >= threshold).length;
  return count / values.length;
}
