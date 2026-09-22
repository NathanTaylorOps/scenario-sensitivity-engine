import type { RNG } from "./rng.ts";

/**
 * Distribution sampling functions.
 *
 * Choice of distribution family is a stated design decision, not a default:
 * see docs/METHODOLOGY.md for the rationale per variable type. In short:
 *   - triangular: bounded, expert min/likely/max judgment, no historical data
 *   - pert:       same three-point input, weights "likely" more heavily
 *                 (mean ~= (min + 4*likely + max) / 6) — smoother than triangular
 *   - normal:     aggregated/averaged effects (CLT applies)
 *   - lognormal:  strictly positive, multiplicative/compounding, right-skewed
 */

export type Distribution =
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "pert"; min: number; mode: number; max: number; lambda?: number }
  | { kind: "normal"; mean: number; stdDev: number }
  | { kind: "lognormal"; median: number; sigma: number }
  | { kind: "constant"; value: number };

function sampleTriangular(rng: RNG, min: number, mode: number, max: number): number {
  const u = rng();
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/**
 * Standard normal sample via Box-Muller. Exported (not just used
 * internally) because the portfolio module reuses it to draw a single
 * shared macro-conditions factor per trial — see src/engine/portfolio.ts.
 */
export function sampleStandardNormal(rng: RNG): number {
  let u1 = 0;
  let u2 = 0;
  // avoid log(0)
  while (u1 === 0) u1 = rng();
  u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Beta-PERT via a Beta(alpha, beta) transform, sampled by the
 * Cheng (1978) BB algorithm-free ratio method for two Gamma variates,
 * built from repeated uniform draws (no external dependency).
 */
function sampleGammaShape1Plus(rng: RNG, shape: number): number {
  // Marsaglia-Tsang method, valid for shape >= 1.
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleGamma(rng: RNG, shape: number): number {
  if (shape >= 1) return sampleGammaShape1Plus(rng, shape);
  // Boost shape by 1 and correct (Ahrens-Dieter).
  const u = rng();
  return sampleGammaShape1Plus(rng, shape + 1) * Math.pow(u, 1 / shape);
}

function sampleBeta(rng: RNG, alpha: number, beta: number): number {
  const x = sampleGamma(rng, alpha);
  const y = sampleGamma(rng, beta);
  return x / (x + y);
}

/**
 * Standard beta-PERT-to-Beta(alpha, beta) parameterization:
 *   alpha = 1 + lambda * (mode - min) / (max - min)
 *   beta  = 1 + lambda * (max - mode) / (max - min)
 * This is provably exact — not approximate — for both the PERT mean
 * (min + lambda*mode + max) / (lambda+2) and the PERT mode itself, and it
 * has no singularity: an earlier mean-matching formula here divided by
 * (mode - mean), which is exactly zero whenever mode sits at the midpoint
 * of [min, max], silently collapsing to alpha=beta=1 (a uniform
 * distribution) via a `|| 1` fallback. That bug shipped in this repo's own
 * first persona config (a driver whose mode was exactly centered) before
 * being caught by review — see the regression test for this case.
 */
function samplePert(rng: RNG, min: number, mode: number, max: number, lambda = 4): number {
  if (max === min) return min;
  const alpha = 1 + (lambda * (mode - min)) / (max - min);
  const beta = 1 + (lambda * (max - mode)) / (max - min);
  const s = sampleBeta(rng, alpha, beta);
  return min + s * (max - min);
}

export function sample(dist: Distribution, rng: RNG): number {
  switch (dist.kind) {
    case "constant":
      return dist.value;
    case "triangular":
      return sampleTriangular(rng, dist.min, dist.mode, dist.max);
    case "pert":
      return samplePert(rng, dist.min, dist.mode, dist.max, dist.lambda ?? 4);
    case "normal":
      return dist.mean + dist.stdDev * sampleStandardNormal(rng);
    case "lognormal": {
      const mu = Math.log(dist.median);
      return Math.exp(mu + dist.sigma * sampleStandardNormal(rng));
    }
  }
}

/**
 * The [low, high] bound used for tornado/sensitivity analysis — the
 * 10th/90th percentile for unbounded distributions, the stated min/max for
 * bounded ones. This is a deliberate choice (not necessarily the same as the
 * simulation's full range) so one outlier trial can't distort the ranking of
 * which drivers matter most; see docs/METHODOLOGY.md.
 */
const Z_90 = 1.2815515655446004; // inverse standard normal CDF at 0.9

export function sensitivityBounds(dist: Distribution): { low: number; high: number } {
  switch (dist.kind) {
    case "constant":
      return { low: dist.value, high: dist.value };
    case "triangular":
    case "pert":
      return { low: dist.min, high: dist.max };
    case "normal":
      return { low: dist.mean - Z_90 * dist.stdDev, high: dist.mean + Z_90 * dist.stdDev };
    case "lognormal": {
      const mu = Math.log(dist.median);
      return { low: Math.exp(mu - Z_90 * dist.sigma), high: Math.exp(mu + Z_90 * dist.sigma) };
    }
  }
}

/** The mean of a distribution, used for the deterministic base case (no randomness). */
export function baseCase(dist: Distribution): number {
  switch (dist.kind) {
    case "constant":
      return dist.value;
    case "triangular":
      return (dist.min + dist.mode + dist.max) / 3;
    case "pert":
      return (dist.min + 4 * dist.mode + dist.max) / 6;
    case "normal":
      return dist.mean;
    case "lognormal":
      return dist.median;
  }
}
