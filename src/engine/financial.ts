/** NPV given a discount rate and a series of period cash flows (index 0 = year 0). */
export function npv(discountRate: number, cashFlows: number[]): number {
  return cashFlows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + discountRate, t), 0);
}

/**
 * Simple (undiscounted) payback period in years.
 *
 * Tracks the cumulative cash position from year 0 and reports the point at
 * which it first returns to zero or better AFTER having been negative,
 * interpolated linearly within the year recovery happens. The outlay does
 * not have to sit in year 0: a decision whose year-0 flow is zero and whose
 * first year is a loss (a hiring decision paying wages before revenue
 * arrives) still has an outlay to recover, and its payback is measured from
 * the point the cumulative position first dips below zero.
 *
 * Returns 0 only when the cumulative position never goes negative at all
 * (nothing to recover). Returns null when the position goes negative and
 * has not recovered by the end of the series.
 */
export function paybackPeriod(cashFlows: number[]): number | null {
  let cumulative = 0;
  let wentNegative = false;
  for (let t = 0; t < cashFlows.length; t++) {
    const prev = cumulative;
    cumulative += cashFlows[t];
    if (cumulative < 0) {
      wentNegative = true;
      continue;
    }
    if (wentNegative) {
      // Recovery happens during period t: interpolate from the end of period t-1.
      return t - 1 + -prev / cashFlows[t];
    }
  }
  return wentNegative ? null : 0;
}

/** Discounted payback period in years, or null if never recovered within the series. */
export function discountedPaybackPeriod(discountRate: number, cashFlows: number[]): number | null {
  const discounted = cashFlows.map((cf, t) => cf / Math.pow(1 + discountRate, t));
  return paybackPeriod(discounted);
}

/** Breakeven volume: fixed costs / contribution margin per unit. */
export function breakevenVolume(fixedCosts: number, pricePerUnit: number, variableCostPerUnit: number): number {
  const contributionMargin = pricePerUnit - variableCostPerUnit;
  if (contributionMargin <= 0) return Infinity;
  return fixedCosts / contributionMargin;
}
