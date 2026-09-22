import type { Decision } from "./types.ts";

/**
 * Variance-contribution breakdown: "what share of the simulated NPV spread
 * does each driver actually account for" — a different question from the
 * tornado chart, which swings one driver at a time in isolation and can't
 * say how much of the *combined* variance, with everything moving at once,
 * traces back to it.
 *
 * Method: Pearson correlation between each driver's sampled value and the
 * resulting NPV across the same trials, squared (r²) and normalized so the
 * shares sum to 1. This is a stated approximation, not a full Sobol
 * variance decomposition — but it's a defensible one here specifically
 * because every driver in this engine is sampled independently (see
 * docs/METHODOLOGY.md's "known limitations" section): with no correlation
 * between drivers, r² shares are a much more literal variance decomposition
 * than they would be if drivers moved together, where shared variance would
 * get double-counted across correlated drivers.
 */
export interface VarianceContributionRow {
  driverId: string;
  label: string;
  /** Pearson correlation between this driver's sampled value and NPV across trials. Sign shows direction, not just magnitude. */
  correlation: number;
  /** This driver's r², normalized against the sum of every driver's r² so all shares sum to 1. */
  varianceShare: number;
}

export function varianceContribution(
  decision: Decision,
  npvSamples: number[],
  inputsSamples: Record<string, number>[],
): VarianceContributionRow[] {
  if (npvSamples.length !== inputsSamples.length) {
    throw new Error("varianceContribution: npvSamples and inputsSamples must come from the same trial run (same length)");
  }

  const raw = decision.drivers.map((driver) => {
    const xs = inputsSamples.map((inputs) => inputs[driver.id]);
    const correlation = pearsonCorrelation(xs, npvSamples);
    return { driverId: driver.id, label: driver.label, correlation, rSquared: correlation * correlation };
  });

  const totalRSquared = raw.reduce((sum, row) => sum + row.rSquared, 0) || 1; // guard against an all-zero-variance edge case

  return raw
    .map((row) => ({
      driverId: row.driverId,
      label: row.label,
      correlation: row.correlation,
      varianceShare: row.rSquared / totalRSquared,
    }))
    .sort((a, b) => b.varianceShare - a.varianceShare);
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  const meanX = xs.reduce((sum, v) => sum + v, 0) / n;
  const meanY = ys.reduce((sum, v) => sum + v, 0) / n;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return 0; // a constant driver (e.g. a "constant" distribution) has no variance to correlate
  return numerator / Math.sqrt(denomX * denomY);
}
