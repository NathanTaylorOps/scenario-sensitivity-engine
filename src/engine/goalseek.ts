import { baseCase } from "./distributions.ts";
import { npv } from "./financial.ts";
import { guardInputs } from "./guardedInputs.ts";
import type { Decision } from "./types.ts";

/**
 * Answers the question a CEO actually asks more often than "what's the
 * NPV": "what does this one driver need to hit for the decision to break
 * even?" Holds every other driver at its base case, varies the named
 * driver, and solves for the value at which NPV = 0.
 *
 * Approach: expand a search bracket outward from the driver's base case
 * until NPV changes sign, then bisect. This makes no assumption about the
 * driver's own distribution bounds — the true breakeven value is often
 * informative precisely because it sits outside the "plausible" range
 * (e.g. "we'd need double the assumed price," which is itself a finding).
 */
export interface GoalSeekResult {
  driverId: string;
  /** The driver value at which NPV = 0, or null if none was found within the search budget. */
  solvedValue: number | null;
  /** The driver's base-case value, for comparison ("solved value vs. what we assumed"). */
  baseCaseValue: number;
  note: string;
}

export function solveForZeroNpv(decision: Decision, driverId: string, maxExpansions = 60): GoalSeekResult {
  const driver = decision.drivers.find((d) => d.id === driverId);
  if (!driver) {
    throw new Error(`solveForZeroNpv: decision "${decision.id}" has no driver "${driverId}"`);
  }

  const baseInputs: Record<string, number> = {};
  for (const d of decision.drivers) baseInputs[d.id] = baseCase(d.distribution);
  const baseDiscountRate = baseCase(decision.discountRate.distribution);

  const npvAt = (value: number): number => {
    const inputs = { ...baseInputs, [driverId]: value };
    return npv(baseDiscountRate, decision.cashFlows(guardInputs(inputs, decision.id), 0));
  };

  const baseCaseValue = baseCase(driver.distribution);

  let lo = baseCaseValue;
  let hi = baseCaseValue;
  let loVal = npvAt(lo);
  let hiVal = npvAt(hi);
  let step = Math.max(Math.abs(baseCaseValue) * 0.25, 1);

  let expansions = 0;
  while (sameSign(loVal, hiVal) && expansions < maxExpansions) {
    lo -= step;
    hi += step;
    loVal = npvAt(lo);
    hiVal = npvAt(hi);
    step *= 1.4;
    expansions++;
  }

  if (sameSign(loVal, hiVal)) {
    return {
      driverId,
      solvedValue: null,
      baseCaseValue,
      note: "No breakeven value found within a wide search range — NPV does not appear to cross zero for this driver at any plausible value, holding everything else at base case.",
    };
  }

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const midVal = npvAt(mid);
    if (Math.abs(midVal) < 1e-6 || hi - lo < Math.max(Math.abs(baseCaseValue), 1) * 1e-9) {
      return { driverId, solvedValue: mid, baseCaseValue, note: "" };
    }
    if (sameSign(midVal, loVal)) {
      lo = mid;
      loVal = midVal;
    } else {
      hi = mid;
    }
  }

  return { driverId, solvedValue: (lo + hi) / 2, baseCaseValue, note: "" };
}

function sameSign(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return a > 0 === b > 0;
}
