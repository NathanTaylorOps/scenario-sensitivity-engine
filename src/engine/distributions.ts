import type { RNG } from "./rng.ts";

/**
 * Distribution sampling functions.
 *
 * Choice of distribution family is a stated design decision, not a default:
 * see docs/METHODOLOGY.md for the rationale per variable type. In short:
 *   - triangular: bounded, expert min/likely/max judgment, no historical data
 *   - pert:       same three-point input, weights "likely" more heavily
 *                 (mean ~= (min + 4*likely + max) / 6) — smoother than triangular
 *   - normal:     aggregated/averaged effects (CLT applies); an optional `min`
 *                 floors the draw (a demand figure can't be negative)
 *   - lognormal:  strictly positive, multiplicative/compounding, right-skewed
 */

export type Distribution =
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "pert"; min: number; mode: number; max: number; lambda?: number }
  | {
      kind: "normal";
      mean: number;
      stdDev: number;
      /**
       * Optional floor: any draw below it is clamped to it. Used for
       * quantities that are physically non-negative (demand, volumes) where
       * the normal's left tail would otherwise produce a sign-flipped value.
       * The floor is meant to sit far out in the tail (validation requires it
       * to be below the mean); the base case still uses the untruncated mean,
       * since clamping a tail that carries well under 1% of the mass moves
       * the mean by a negligible amount.
       */
      min?: number;
    }
  | { kind: "lognormal"; median: number; sigma: number }
  | { kind: "constant"; value: number };

function triangularQuantile(u: number, min: number, mode: number, max: number): number {
  if (max === min) return min;
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

function sampleTriangular(rng: RNG, min: number, mode: number, max: number): number {
  return triangularQuantile(rng(), min, mode, max);
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
 * Inverse standard normal CDF (Acklam's rational approximation, relative
 * error below 1.2e-9 across (0, 1)). Used for analytical quantiles of the
 * normal and lognormal families.
 */
export function inverseStandardNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`inverseStandardNormalCdf: p must be in (0, 1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Beta-PERT via a Beta(alpha, beta) transform, sampled as the ratio of two
 * Gamma variates built from repeated uniform draws (no external dependency).
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
 * This is exact for both the PERT mean (min + lambda*mode + max) / (lambda+2)
 * and the PERT mode, and it has no singularity anywhere in the parameter
 * space. A mean-matching formula that divides by (mode - mean) is exactly
 * zero whenever the mode sits at the midpoint of [min, max] and would
 * collapse to a uniform distribution there; the regression test for a
 * centred mode guards against reintroducing that.
 */
function pertShape(min: number, mode: number, max: number, lambda: number): { alpha: number; beta: number } {
  return {
    alpha: 1 + (lambda * (mode - min)) / (max - min),
    beta: 1 + (lambda * (max - mode)) / (max - min),
  };
}

function samplePert(rng: RNG, min: number, mode: number, max: number, lambda = 4): number {
  if (max === min) return min;
  const { alpha, beta } = pertShape(min, mode, max, lambda);
  const s = sampleBeta(rng, alpha, beta);
  return min + s * (max - min);
}

// ---- Regularised incomplete beta function, for the PERT quantile ----

/** Lanczos approximation of ln(Gamma(x)), accurate to ~1e-15 for x > 0. */
function logGamma(x: number): number {
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = coefficients[0];
  const t = shifted + g + 0.5;
  for (let i = 1; i < coefficients.length; i++) sum += coefficients[i] / (shifted + i);
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued-fraction evaluation of the incomplete beta function (Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const maxIterations = 300;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let coefficient = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + coefficient / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    coefficient = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + coefficient * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + coefficient / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

/** CDF of Beta(a, b) at x, i.e. the regularised incomplete beta function I_x(a, b). */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Quantile of Beta(a, b) by bisection on the CDF (monotone on [0, 1]; 60 halvings gives ~1e-18 resolution). */
function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function sample(dist: Distribution, rng: RNG): number {
  switch (dist.kind) {
    case "constant":
      return dist.value;
    case "triangular":
      return sampleTriangular(rng, dist.min, dist.mode, dist.max);
    case "pert":
      return samplePert(rng, dist.min, dist.mode, dist.max, dist.lambda ?? 4);
    case "normal": {
      const draw = dist.mean + dist.stdDev * sampleStandardNormal(rng);
      return dist.min === undefined ? draw : Math.max(dist.min, draw);
    }
    case "lognormal": {
      const mu = Math.log(dist.median);
      return Math.exp(mu + dist.sigma * sampleStandardNormal(rng));
    }
  }
}

/**
 * The value below which a fraction `p` of the distribution's mass lies —
 * computed analytically (closed form for triangular/normal/lognormal, a
 * numerically inverted Beta CDF for PERT), never by sampling.
 */
export function quantile(dist: Distribution, p: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`quantile: p must be in [0, 1], got ${p}`);
  switch (dist.kind) {
    case "constant":
      return dist.value;
    case "triangular":
      return triangularQuantile(p, dist.min, dist.mode, dist.max);
    case "pert": {
      if (dist.max === dist.min) return dist.min;
      const { alpha, beta } = pertShape(dist.min, dist.mode, dist.max, dist.lambda ?? 4);
      return dist.min + betaQuantile(p, alpha, beta) * (dist.max - dist.min);
    }
    case "normal": {
      if (p === 0) return dist.min ?? -Infinity;
      if (p === 1) return Infinity;
      const value = dist.mean + dist.stdDev * inverseStandardNormalCdf(p);
      return dist.min === undefined ? value : Math.max(dist.min, value);
    }
    case "lognormal": {
      if (p === 0) return 0;
      if (p === 1) return Infinity;
      return Math.exp(Math.log(dist.median) + dist.sigma * inverseStandardNormalCdf(p));
    }
  }
}

/**
 * The [low, high] bound used for tornado/sensitivity analysis: the 10th and
 * 90th percentile of the driver's distribution, for every family alike. Using
 * the same percentile pair everywhere keeps the tornado ranking comparable
 * across drivers — a bounded PERT swung across its full min–max would be
 * measured over ~100% of its mass while a normal swung P10–P90 covers 80%,
 * which would systematically overstate the bounded drivers' swings relative
 * to the unbounded ones. See docs/METHODOLOGY.md.
 */
export function sensitivityBounds(dist: Distribution): { low: number; high: number } {
  return { low: quantile(dist, 0.1), high: quantile(dist, 0.9) };
}

/** The mean of a distribution (median for lognormal), used for the deterministic base case (no randomness). */
export function baseCase(dist: Distribution): number {
  switch (dist.kind) {
    case "constant":
      return dist.value;
    case "triangular":
      return (dist.min + dist.mode + dist.max) / 3;
    case "pert": {
      const lambda = dist.lambda ?? 4;
      return (dist.min + lambda * dist.mode + dist.max) / (lambda + 2);
    }
    case "normal":
      return dist.mean;
    case "lognormal":
      return dist.median;
  }
}
