import { baseCaseInputs, runMonteCarlo, type RunOptions } from "./montecarlo.ts";
import { percentiles, probabilityExceeds } from "./percentiles.ts";
import type { Decision, Percentiles } from "./types.ts";

/**
 * Debt financing as an optional layer on top of an existing Decision, rather
 * than baked into every persona, so the all-equity run stays available for
 * comparison. Most shops would finance a capex decision of this size rather
 * than pay cash, and a lender's first question is not "is NPV positive" but
 * "does operating cash flow cover the debt service every year".
 *
 * Valuation follows the adjusted-present-value (APV) convention: the
 * decision's unlevered NPV (operating cash flows at the firm's hurdle rate)
 * plus the present value of the interest tax shield, discounted at the loan
 * rate because the shield is only as certain as the debt itself. Discounting
 * the levered equity cash flows at the unlevered hurdle rate would let any
 * loan cheaper than the hurdle rate manufacture value out of nothing; APV
 * keeps the financing benefit separate and honestly sized.
 */
export interface LoanTerms {
  /** Fraction of the decision's year-0 outlay financed with debt (0 < LTV <= 1). */
  loanToValuePct: number;
  annualInterestRate: number;
  termYears: number;
}

export interface DebtServiceScheduleEntry {
  year: number;
  interestPayment: number;
  /** Scheduled principal repayment under the annuity. */
  principalPayment: number;
  /** Outstanding balance repaid in this year because the model horizon ends before the loan term does. 0 in every other year. */
  balloonPayment: number;
  /** Interest + scheduled principal + balloon: the total cash leaving the business for debt this year. */
  totalDebtService: number;
  remainingBalance: number;
}

/** Thrown by `validateLoanTerms` — distinct from a generic Error so callers (like the
 * UI) can catch it specifically and show a validation message instead of a stack trace. */
export class LoanTermsError extends Error {}

/**
 * Rejects loan terms that would otherwise produce a nonsensical or
 * misleading result. A 0-year term with a nonzero loan-to-value is debt that
 * is never repaid; a 0% loan-to-value is no loan at all, and an empty
 * schedule would read as "the covenant is met in 100% of trials" — true only
 * in the vacuous sense, and indistinguishable in a UI from a real answer.
 * The all-equity case is the unfinanced decision itself, so a caller wanting
 * it should run that rather than a zero-sized loan.
 */
export function validateLoanTerms(loan: LoanTerms): void {
  const issues: string[] = [];
  if (!Number.isFinite(loan.loanToValuePct) || loan.loanToValuePct <= 0 || loan.loanToValuePct > 1) {
    issues.push(
      loan.loanToValuePct === 0
        ? "loanToValuePct is 0: there is no loan to analyse. The all-equity case is the unfinanced decision itself."
        : `loanToValuePct must be above 0 and at most 1 (up to 100% of the decision's year-0 outlay); got ${loan.loanToValuePct}.`,
    );
  }
  if (!Number.isFinite(loan.annualInterestRate) || loan.annualInterestRate < 0) {
    issues.push(`annualInterestRate cannot be negative; got ${loan.annualInterestRate}.`);
  }
  if (!Number.isFinite(loan.termYears) || loan.termYears < 1) {
    issues.push(`termYears must be at least 1 — debt with no repayment term is never repaid; got ${loan.termYears}.`);
  }
  if (issues.length > 0) {
    throw new LoanTermsError(`Invalid loan terms:\n- ${issues.join("\n- ")}`);
  }
}

/** Standard equal-total-payment (annuity) amortization schedule over the full loan term. */
export function amortizationSchedule(principal: number, annualInterestRate: number, termYears: number): DebtServiceScheduleEntry[] {
  if (principal <= 0 || termYears <= 0) return [];
  const rate = annualInterestRate;
  const payment = rate === 0 ? principal / termYears : (principal * rate) / (1 - Math.pow(1 + rate, -termYears));
  const schedule: DebtServiceScheduleEntry[] = [];
  let balance = principal;
  for (let year = 1; year <= termYears; year++) {
    const interestPayment = balance * rate;
    const principalPayment = payment - interestPayment;
    balance = Math.max(0, balance - principalPayment);
    schedule.push({ year, interestPayment, principalPayment, balloonPayment: 0, totalDebtService: payment, remainingBalance: balance });
  }
  return schedule;
}

/**
 * The schedule as the model actually sees it: truncated to the decision's
 * horizon, with any balance still outstanding at the horizon repaid as a
 * balloon in the final modelled year. Without this, a term longer than the
 * horizon would leave principal unpaid outside the model and the financed
 * cash flows would be incomplete — a 10-year loan on a 5-year decision would
 * look far better than the same loan on a 5-year term purely because half
 * the repayments fell off the end of the calendar.
 */
export function debtScheduleForHorizon(principal: number, annualInterestRate: number, termYears: number, horizonYears: number): DebtServiceScheduleEntry[] {
  const full = amortizationSchedule(principal, annualInterestRate, termYears);
  if (full.length <= horizonYears) return full;
  const truncated = full.slice(0, horizonYears);
  const last = truncated[truncated.length - 1];
  truncated[truncated.length - 1] = {
    ...last,
    balloonPayment: last.remainingBalance,
    totalDebtService: last.totalDebtService + last.remainingBalance,
    remainingBalance: 0,
  };
  return truncated;
}

/** Loan principal for one specific sampled input set: capex — and so loan size — varies trial to trial. */
export function principalForInputs(decision: Decision, inputs: Record<string, number>, loan: LoanTerms): number {
  const unfinancedYear0 = decision.cashFlows(inputs, 0)[0];
  return -unfinancedYear0 * loan.loanToValuePct; // year-0 cash flow is a negative outlay; principal borrowed is the positive amount financed
}

/** Recomputes the in-horizon loan schedule for one specific sampled input set. */
export function amortizationForInputs(decision: Decision, inputs: Record<string, number>, loan: LoanTerms): DebtServiceScheduleEntry[] {
  validateLoanTerms(loan);
  return debtScheduleForHorizon(principalForInputs(decision, inputs, loan), loan.annualInterestRate, loan.termYears, decision.horizonYears);
}

/**
 * Wraps a decision so a stated fraction of its year-0 outlay is
 * debt-financed instead of paid in cash, and every later year reflects the
 * debt service (interest, scheduled principal, and any balloon at the
 * horizon) in place of the unfinanced cost. The result is the EQUITY cash
 * flow series: what actually leaves and returns to the owner's pocket. It
 * is the right series for a liquidity or cash-floor question. It is not a
 * valuation input — discounting equity cash flows at the unlevered hurdle
 * rate overstates value whenever the loan is cheaper than that rate; use
 * `runFinancingAnalysis` (APV) for value.
 *
 * The interest portion is tax-deductible. Since the wrapped decision's own
 * `cashFlows` already computed after-tax operating cash flow with no
 * knowledge of this financing, the interest tax shield is added back as a
 * separate linear correction (`interestPayment * taxRate`) rather than by
 * re-deriving taxable income from scratch. This is exact when there's
 * enough other taxable income to fully use the deduction, and approximate
 * otherwise — the same "no loss carryforward" simplification already
 * stated for src/engine/tax.ts, extended here rather than contradicted.
 *
 * Returns a NEW Decision (id suffixed "-financed") — it does not mutate the
 * original, so the all-equity version stays available for comparison.
 */
export function financeDecision(decision: Decision, loan: LoanTerms, taxRateDriverId = "taxRate"): Decision {
  validateLoanTerms(loan);
  return {
    ...decision,
    id: `${decision.id}-financed`,
    label: `${decision.label} (equity cash flows after debt service)`,
    cashFlows(inputs, macroFactor = 0) {
      const unfinanced = decision.cashFlows(inputs, macroFactor);
      const principal = -unfinanced[0] * loan.loanToValuePct;
      const schedule = debtScheduleForHorizon(principal, loan.annualInterestRate, loan.termYears, unfinanced.length - 1);
      const taxRate = inputs[taxRateDriverId] ?? 0;

      const financed = unfinanced.slice();
      financed[0] = unfinanced[0] + principal; // loan proceeds offset the equity outlay

      for (const entry of schedule) {
        const interestTaxShield = entry.interestPayment * taxRate;
        financed[entry.year] = financed[entry.year] - entry.totalDebtService + interestTaxShield;
      }

      return financed;
    },
  };
}

/** Debt service coverage ratio for one period. Infinity when no debt service is due that period (not a covenant risk). */
export function debtServiceCoverageRatio(operatingCashFlow: number, totalDebtService: number): number {
  if (totalDebtService <= 0) return Infinity;
  return operatingCashFlow / totalDebtService;
}

export interface DscrAnalysisResult {
  /** Percentiles of each trial's WORST (lowest) DSCR year across the loan years inside the model horizon — the figure a lender's covenant actually bites on. */
  minimumDscrPercentiles: Percentiles;
  /** Share of trials whose minimum DSCR never drops below the stated covenant. */
  probabilityAboveCovenant: number;
  covenantMinDscr: number;
  note: string;
}

export interface FinancingAnalysisResult {
  loan: LoanTerms;
  /** Loan principal at the base-case capex. */
  baseCasePrincipal: number;
  /** Balance repaid at the horizon under base-case capex when the term outlasts the horizon; 0 when the loan amortises fully inside it. */
  baseCaseBalloonAtHorizon: number;
  /** The decision's own NPV distribution: operating cash flows at the firm's hurdle rate, no financing. */
  unleveredNpvPercentiles: Percentiles;
  /** PV of the interest tax shield per trial, discounted at the loan rate. */
  taxShieldPvPercentiles: Percentiles;
  /** Adjusted present value = unlevered NPV + PV of the interest tax shield, per trial. */
  apvPercentiles: Percentiles;
  probabilityApvPositive: number;
  dscr: DscrAnalysisResult;
  note: string;
}

/**
 * The two things debt financing actually changes, kept separate: value
 * (APV) and covenant risk (DSCR).
 *
 * Runs the UNFINANCED decision's Monte Carlo once — its after-tax operating
 * cash flows are the "cash available to service debt" a lender looks at —
 * and, for each trial, recomputes the loan from that trial's own sampled
 * outlay: a bigger simulated capex draw means a bigger loan and bigger debt
 * service, not one fixed number applied uniformly across trials. From the
 * same trials it computes the PV of that trial's interest tax shield at the
 * loan rate, and adds it to the trial's unlevered NPV to give the APV.
 *
 * DSCR is evaluated for every loan year inside the model horizon against
 * scheduled interest plus principal. The balloon that closes the loan at
 * the horizon is part of the equity cash flows, not of the covenant test —
 * in practice that balance is refinanced or settled from the asset's sale,
 * and no lender sizes an annual coverage covenant on it.
 */
export function runFinancingAnalysis(
  decision: Decision,
  loan: LoanTerms,
  covenantMinDscr: number,
  options: RunOptions,
  taxRateDriverId = "taxRate",
): FinancingAnalysisResult {
  validateLoanTerms(loan);
  const result = runMonteCarlo(decision, { ...options, captureCashFlows: true, captureInputs: true });
  const minDscrSamples: number[] = new Array(options.iterations);
  const taxShieldPvSamples: number[] = new Array(options.iterations);
  const apvSamples: number[] = new Array(options.iterations);

  for (let i = 0; i < options.iterations; i++) {
    const inputs = result.inputsSamples![i];
    const cashFlows = result.cashFlowSamples![i];
    const principal = -cashFlows[0] * loan.loanToValuePct;
    const schedule = debtScheduleForHorizon(principal, loan.annualInterestRate, loan.termYears, decision.horizonYears);
    const taxRate = inputs[taxRateDriverId] ?? 0;

    let minDscr = Infinity;
    let taxShieldPv = 0;
    for (const entry of schedule) {
      const scheduledService = entry.interestPayment + entry.principalPayment;
      const dscr = debtServiceCoverageRatio(cashFlows[entry.year], scheduledService);
      if (dscr < minDscr) minDscr = dscr;
      taxShieldPv += (entry.interestPayment * taxRate) / Math.pow(1 + loan.annualInterestRate, entry.year);
    }
    minDscrSamples[i] = minDscr;
    taxShieldPvSamples[i] = taxShieldPv;
    apvSamples[i] = result.npvSamples[i] + taxShieldPv;
  }

  const finiteDscr = minDscrSamples.filter((d) => Number.isFinite(d));
  const dscr: DscrAnalysisResult = {
    minimumDscrPercentiles: percentiles(finiteDscr.length > 0 ? finiteDscr : [Infinity]),
    probabilityAboveCovenant: minDscrSamples.filter((d) => d >= covenantMinDscr).length / minDscrSamples.length,
    covenantMinDscr,
    note: "Worst-year coverage: for each simulated trial, the lowest ratio of after-tax operating cash flow to scheduled interest plus principal across the loan years inside the model horizon. A covenant is breached by the worst year, not the typical one.",
  };

  const baseCasePrincipal = principalForInputs(decision, baseCaseInputs(decision), loan);
  const baseSchedule = debtScheduleForHorizon(baseCasePrincipal, loan.annualInterestRate, loan.termYears, decision.horizonYears);
  const baseCaseBalloonAtHorizon = baseSchedule.reduce((sum, entry) => sum + entry.balloonPayment, 0);

  return {
    loan,
    baseCasePrincipal,
    baseCaseBalloonAtHorizon,
    unleveredNpvPercentiles: percentiles(result.npvSamples),
    taxShieldPvPercentiles: percentiles(taxShieldPvSamples),
    apvPercentiles: percentiles(apvSamples),
    probabilityApvPositive: probabilityExceeds(apvSamples, 0),
    dscr,
    note:
      "Adjusted present value = unlevered NPV (operating cash flows at the hurdle rate) + PV of the interest tax shield, discounted at the loan rate. Financing changes the value of a decision only through the tax deductibility of interest; it does not change the operating case." +
      (baseCaseBalloonAtHorizon > 0
        ? ` The loan term outlasts the ${decision.horizonYears}-year horizon, so the balance still owing at year ${decision.horizonYears} is treated as repaid then.`
        : ""),
  };
}

/** The covenant half of `runFinancingAnalysis` on its own. */
export function runDscrAnalysis(decision: Decision, loan: LoanTerms, covenantMinDscr: number, options: RunOptions): DscrAnalysisResult {
  return runFinancingAnalysis(decision, loan, covenantMinDscr, options).dscr;
}
