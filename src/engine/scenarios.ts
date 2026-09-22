import type { Percentiles } from "./types.ts";

/**
 * Representative-scenario extraction: answers "what does the P50 (or P90,
 * or P10) year actually look like?" by returning a REAL simulated trial's
 * full cash-flow array, rather than computing each year's percentile
 * independently across trials.
 *
 * Independent per-year percentiles would be statistically incoherent: year
 * 3's P90 value and year 1's P90 value can come from two entirely different
 * trials, so stitching them into one series describes a cash-flow path no
 * single simulated outcome ever produced. Picking the actual trial whose
 * overall NPV lands nearest the target percentile keeps every year internally
 * consistent — it's a real, achievable scenario, not a statistical composite.
 */
export function nearestScenario(npvSamples: number[], cashFlowSamples: number[][], targetNpv: number): number[] {
  if (npvSamples.length !== cashFlowSamples.length) {
    throw new Error("nearestScenario: npvSamples and cashFlowSamples must be the same length (same trial run)");
  }
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < npvSamples.length; i++) {
    const distance = Math.abs(npvSamples[i] - targetNpv);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return cashFlowSamples[bestIndex];
}

export interface RepresentativeCashFlows {
  p90: number[];
  p50: number[];
  p10: number[];
}

/** Convenience wrapper: the representative cash-flow series for all three headline percentiles at once. */
export function representativeCashFlows(
  npvSamples: number[],
  cashFlowSamples: number[][],
  npvPercentiles: Percentiles,
): RepresentativeCashFlows {
  return {
    p90: nearestScenario(npvSamples, cashFlowSamples, npvPercentiles.p90),
    p50: nearestScenario(npvSamples, cashFlowSamples, npvPercentiles.p50),
    p10: nearestScenario(npvSamples, cashFlowSamples, npvPercentiles.p10),
  };
}
