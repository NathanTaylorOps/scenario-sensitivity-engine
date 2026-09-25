import { baseCase } from "./distributions.ts";
import { baseCaseInputs, npvAtInputs } from "./montecarlo.ts";
import { analysedDrivers } from "./tornado.ts";
import type { Decision, Driver } from "./types.ts";

/**
 * Answers the question a CEO asks more often than "what's the NPV": "what
 * does this one driver need to hit for the decision to break even?" Holds
 * every other driver at its base case, varies the named driver (an
 * operating driver or the discount rate), and solves for the value at which
 * NPV = 0.
 *
 * Approach: expand a search bracket outward from the driver's base case
 * until NPV changes sign, then bisect. The search is not limited to the
 * driver's own distribution range — a breakeven that sits outside the
 * plausible range is itself a finding ("we'd need double the assumed
 * price") — but it IS limited to the driver's feasible domain: a tax rate
 * cannot be negative, a margin cannot exceed 100%, a cost cannot be below
 * zero. If NPV never crosses zero anywhere in that domain, there is no
 * feasible breakeven and the result says so instead of reporting a value
 * that could never occur.
 */
export interface GoalSeekResult {
  driverId: string;
  label: string;
  /** The driver value at which NPV = 0, or null if no feasible value exists. */
  solvedValue: number | null;
  /** The driver's base-case value, for comparison ("solved value vs. what we assumed"). */
  baseCaseValue: number;
  /** The range of values the search was confined to — the driver's physical domain, not its distribution. */
  domain: FeasibleDomain;
  /** True when a breakeven value exists inside the feasible domain. */
  feasible: boolean;
  note: string;
}

export interface FeasibleDomain {
  low: number;
  high: number;
}

/**
 * The physically meaningful range of a driver, derived from its unit and
 * category rather than its distribution:
 *   - a bare "%" is a share or fraction: 0% to 100%
 *   - a "%/period" rate is unbounded above but can't fall below -100%; a
 *     financing rate (discount rate) can't be negative at all
 *   - everything else (money, units, headcount, months) is a non-negative
 *     magnitude — the same convention validation.ts enforces on cost and
 *     capex drivers
 * Callers can override this per call when a decision has a driver whose
 * physical limits are tighter or looser than these defaults.
 */
export function feasibleDomain(driver: Driver): FeasibleDomain {
  const unit = driver.unit.trim();
  if (unit === "%") return { low: 0, high: 1 };
  if (unit.startsWith("%/")) return driver.category === "financing" ? { low: 0, high: 5 } : { low: -1, high: 5 };
  return { low: 0, high: Infinity };
}

export interface GoalSeekOptions {
  /** Overrides the default feasible domain for this driver. */
  domain?: FeasibleDomain;
  /** How many times the bracket may expand before giving up on an unbounded domain. */
  maxExpansions?: number;
}

export function solveForZeroNpv(decision: Decision, driverId: string, options: GoalSeekOptions = {}): GoalSeekResult {
  const driver = analysedDrivers(decision).find((d) => d.id === driverId);
  if (!driver) {
    throw new Error(`solveForZeroNpv: decision "${decision.id}" has no driver "${driverId}"`);
  }
  const domain = options.domain ?? feasibleDomain(driver);
  if (!(domain.low < domain.high)) {
    throw new Error(`solveForZeroNpv: feasible domain for "${driverId}" must have low < high, got [${domain.low}, ${domain.high}]`);
  }
  const maxExpansions = options.maxExpansions ?? 60;

  const baseInputs = baseCaseInputs(decision);
  const npvAt = (value: number): number => npvAtInputs(decision, { ...baseInputs, [driverId]: value });

  const baseCaseValue = baseCase(driver.distribution);
  const start = clamp(baseCaseValue, domain);
  const domainWidth = Number.isFinite(domain.high - domain.low) ? domain.high - domain.low : Infinity;
  let step = Math.max(Math.abs(start) * 0.25, Number.isFinite(domainWidth) ? domainWidth * 0.05 : 1);

  let lo = start;
  let hi = start;
  let loVal = npvAt(lo);
  let hiVal = npvAt(hi);

  let expansions = 0;
  while (sameSign(loVal, hiVal) && expansions < maxExpansions) {
    const coveredWholeDomain = lo <= domain.low && hi >= domain.high;
    if (coveredWholeDomain) break;
    if (lo > domain.low) {
      lo = Math.max(domain.low, lo - step);
      loVal = npvAt(lo);
    }
    if (hi < domain.high) {
      hi = Math.min(domain.high, hi + step);
      hiVal = npvAt(hi);
    }
    step *= 1.4;
    expansions++;
  }

  if (sameSign(loVal, hiVal)) {
    const direction = loVal > 0 ? "stays positive" : "stays negative";
    return {
      driverId,
      label: driver.label,
      solvedValue: null,
      baseCaseValue,
      domain,
      feasible: false,
      note: `No feasible breakeven: NPV ${direction} for every value of "${driver.label}" between ${formatBound(domain.low)} and ${formatBound(domain.high)}, holding everything else at base case. This driver alone cannot move the decision across zero.`,
    };
  }

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const midVal = npvAt(mid);
    if (Math.abs(midVal) < 1e-6 || hi - lo < Math.max(Math.abs(start), 1) * 1e-9) {
      return { driverId, label: driver.label, solvedValue: mid, baseCaseValue, domain, feasible: true, note: "" };
    }
    if (sameSign(midVal, loVal)) {
      lo = mid;
      loVal = midVal;
    } else {
      hi = mid;
    }
  }

  return { driverId, label: driver.label, solvedValue: (lo + hi) / 2, baseCaseValue, domain, feasible: true, note: "" };
}

function clamp(value: number, domain: FeasibleDomain): number {
  return Math.min(Math.max(value, domain.low), domain.high);
}

function formatBound(value: number): string {
  if (value === Infinity) return "+infinity";
  if (value === -Infinity) return "-infinity";
  return Number.isInteger(value) ? String(value) : value.toPrecision(3);
}

function sameSign(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return a > 0 === b > 0;
}
