/** NPV given a discount rate and a series of period cash flows (index 0 = year 0). */
export function npv(discountRate: number, cashFlows: number[]): number {
  return cashFlows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + discountRate, t), 0);
}

/** Simple (undiscounted) payback period in years, or null if never recovered within the series. */
export function paybackPeriod(cashFlows: number[]): number | null {
  let cumulative = cashFlows[0] ?? 0;
  if (cumulative >= 0) return 0;
  for (let t = 1; t < cashFlows.length; t++) {
    const prev = cumulative;
    cumulative += cashFlows[t];
    if (cumulative >= 0) {
      // linear interpolation within the year that recovery happens
      const fraction = -prev / (cumulative - prev);
      return t - 1 + fraction;
    }
  }
  return null;
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
