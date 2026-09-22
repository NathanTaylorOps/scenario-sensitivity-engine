/**
 * Tax and depreciation treatment, isolated in its own auditable module
 * (per the CFO-audience review: pre-tax cash flows are the first thing a
 * finance-literate reviewer would flag as unrealistic).
 *
 * Model: straight-line depreciation over `usefulLifeYears`, a tax shield
 * from that depreciation, and — for decisions with a residual asset — a
 * taxable gain on any salvage value above remaining book value in the
 * final modeled year. Tax is applied only to POSITIVE taxable income (no
 * loss carryforward / other-income offset modeled) — a deliberately
 * conservative simplification, stated here rather than hidden.
 */
export interface CapexTaxParams {
  /** Depreciable capex base. 0 for decisions with no capital asset (e.g. a headcount or contract decision). */
  capex: number;
  /** Straight-line depreciation period. Ignored (no depreciation) if capex is 0. */
  usefulLifeYears: number;
  /** Effective combined tax rate (0-1). */
  taxRate: number;
  /** Pretax salvage/resale proceeds received in the FINAL year of the cash flow array, if any. */
  salvageValue?: number;
}

/**
 * Converts a pretax operating cash flow series into an after-tax series.
 * `pretaxCashFlows[0]` (the year-0 outlay) passes through unchanged — an
 * initial outlay is a balance-sheet event, not a taxable one, in this model.
 */
export function afterTaxCashFlows(pretaxCashFlows: number[], params: CapexTaxParams): number[] {
  const { capex, usefulLifeYears, taxRate, salvageValue = 0 } = params;
  const horizon = pretaxCashFlows.length - 1;
  const annualDepreciation = capex > 0 && usefulLifeYears > 0 ? capex / usefulLifeYears : 0;

  const result = pretaxCashFlows.slice();
  let accumulatedDepreciation = 0;

  for (let year = 1; year <= horizon; year++) {
    const depreciationThisYear = year <= usefulLifeYears ? annualDepreciation : 0;
    accumulatedDepreciation += depreciationThisYear;

    let taxableIncome = pretaxCashFlows[year] - depreciationThisYear;

    let cashFlow = pretaxCashFlows[year];

    if (year === horizon && salvageValue > 0) {
      const bookValue = Math.max(capex - accumulatedDepreciation, 0);
      const taxableGainOnSalvage = salvageValue - bookValue;
      taxableIncome += taxableGainOnSalvage;
      cashFlow += salvageValue; // the full proceeds are cash; only the gain over book value is taxed
    }

    const tax = taxRate * Math.max(taxableIncome, 0);
    result[year] = cashFlow - tax;
  }

  return result;
}
