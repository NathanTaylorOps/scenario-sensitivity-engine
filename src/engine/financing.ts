import { runMonteCarlo, type RunOptions } from "./montecarlo.ts";
import { percentiles } from "./percentiles.ts";
import type { Decision, Percentiles } from "./types.ts";

/**
 * Debt financing was entirely absent before this: every decision was
 * implicitly all-equity, with no loan, no interest expense, and no interest
 * tax shield — a real omission for a $250K capex decision, which most shops
 * would actually finance rather than pay cash for. This module adds it as
 * an optional layer on top of an existing Decision, rather than baking debt
 * into every persona, so a fully-equity-funded run stays available for
 * comparison.
 */
export interface LoanTerms {
  /** Fraction of the decision's year-0 outlay financed with debt (0 = all-equity, 1 = fully debt-funded). */
  loanToValuePct: number;
  annualInterestRate: number;
  termYears: number;
}

export interface DebtServiceScheduleEntry {
  year: number;
  interestPayment: number;
  principalPayment: number;
  totalDebtService: number;
  remainingBalance: number;
}

/** Thrown by `validateLoanTerms` — distinct from a generic Error so callers (like the
 * UI) can catch it specifically and show a validation message instead of a stack trace. */
export class LoanTermsError extends Error {}

/**
 * Rejects loan terms that would otherwise silently produce a nonsensical or
 * misleading result rather than an error. Caught in review: with the old
 * unvalidated code, a 0-year term or a 0% loan-to-value both fell through to
 * `amortizationSchedule`'s empty-schedule branch, which `runDscrAnalysis`
 * then read as "no debt service was ever due" and reported as **100% probability
 * of meeting the covenant** — technically true in a vacuous sense, but
 * indistinguishable in the UI from "we checked, and this loan is genuinely
 * safe." A 0-year term with a nonzero loan-to-value is worse: `financeDecision`
 * would add the loan proceeds to year 0 and then never charge any repayment
 * at all, silently modeling free money. This function makes all of those
 * invalid states fail loudly instead of producing a plausible-looking number.
 */
export function validateLoanTerms(loan: LoanTerms): void {
  const issues: string[] = [];
  if (!Number.isFinite(loan.loanToValuePct) || loan.loanToValuePct < 0 || loan.loanToValuePct > 1) {
    issues.push(`loanToValuePct must be between 0 and 1 (0%-100% of the decision's year-0 outlay); got ${loan.loanToValuePct}.`);
  }
  if (!Number.isFinite(loan.annualInterestRate) || loan.annualInterestRate < 0) {
    issues.push(`annualInterestRate cannot be negative; got ${loan.annualInterestRate}.`);
  }
  if (!Number.isFinite(loan.termYears) || loan.termYears < 0) {
    issues.push(`termYears cannot be negative; got ${loan.termYears}.`);
  } else if (loan.loanToValuePct > 0 && loan.termYears === 0) {
    issues.push(`termYears must be at least 1 to finance any portion of this decision — a nonzero loan-to-value with a 0-year term would mean debt that is never repaid.`);
  }
  if (issues.length > 0) {
    throw new LoanTermsError(`Invalid loan terms:\n- ${issues.join("\n- ")}`);
  }
}

/** Standard equal-total-payment (annuity) amortization schedule for a loan. */
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
    schedule.push({ year, interestPayment, principalPayment, totalDebtService: payment, remainingBalance: balance });
  }
  return schedule;
}

/** Recomputes the loan's principal and schedule for one specific sampled input set (capex — and so loan size — varies trial to trial). */
export function amortizationForInputs(decision: Decision, inputs: Record<string, number>, loan: LoanTerms): DebtServiceScheduleEntry[] {
  validateLoanTerms(loan);
  const unfinancedYear0 = decision.cashFlows(inputs, 0)[0];
  const principal = -unfinancedYear0 * loan.loanToValuePct; // year-0 cash flow is a negative outlay; principal borrowed is the positive amount financed
  return amortizationSchedule(principal, loan.annualInterestRate, loan.termYears);
}

/**
 * Wraps a decision so a stated fraction of its year-0 outlay is
 * debt-financed instead of paid in cash, and every later year reflects the
 * debt service (principal + interest) in place of the unfinanced cost.
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
    label: `${decision.label} (debt-financed)`,
    cashFlows(inputs, macroFactor = 0) {
      const unfinanced = decision.cashFlows(inputs, macroFactor);
      const principal = -unfinanced[0] * loan.loanToValuePct;
      const schedule = amortizationSchedule(principal, loan.annualInterestRate, loan.termYears);
      const taxRate = inputs[taxRateDriverId] ?? 0;

      const financed = unfinanced.slice();
      financed[0] = unfinanced[0] + principal; // loan proceeds offset the equity outlay

      for (const entry of schedule) {
        if (entry.year < financed.length) {
          const interestTaxShield = entry.interestPayment * taxRate;
          financed[entry.year] = financed[entry.year] - entry.totalDebtService + interestTaxShield;
        }
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
  /** Percentiles of each trial's WORST (lowest) DSCR year over the loan term — the figure a lender's covenant actually bites on. */
  minimumDscrPercentiles: Percentiles;
  /** Share of trials whose minimum DSCR never drops below the stated covenant. */
  probabilityAboveCovenant: number;
  covenantMinDscr: number;
  note: string;
}

/**
 * Answers the question debt financing actually raises: not just "is NPV
 * positive," but "does this decision's own after-tax operating cash flow
 * cover its debt service, in every year of the loan, under simulated
 * uncertainty." Runs the UNFINANCED decision's Monte Carlo (its cash flows
 * are the "cash available to service debt" a lender looks at) and, for each
 * trial, recomputes the loan schedule from that trial's own sampled outlay
 * — a bigger simulated capex draw means a bigger loan and bigger debt
 * service, not a fixed number applied uniformly across trials.
 */
export function runDscrAnalysis(decision: Decision, loan: LoanTerms, covenantMinDscr: number, options: RunOptions): DscrAnalysisResult {
  validateLoanTerms(loan);
  const result = runMonteCarlo(decision, { ...options, captureCashFlows: true, captureInputs: true });
  const minDscrSamples: number[] = new Array(options.iterations);

  for (let i = 0; i < options.iterations; i++) {
    const inputs = result.inputsSamples![i];
    const cashFlows = result.cashFlowSamples![i];
    const schedule = amortizationForInputs(decision, inputs, loan);

    let minDscr = Infinity;
    for (const entry of schedule) {
      if (entry.year < cashFlows.length) {
        const dscr = debtServiceCoverageRatio(cashFlows[entry.year], entry.totalDebtService);
        if (dscr < minDscr) minDscr = dscr;
      }
    }
    minDscrSamples[i] = minDscr;
  }

  const finiteSamples = minDscrSamples.filter((d) => Number.isFinite(d));
  return {
    minimumDscrPercentiles: percentiles(finiteSamples.length > 0 ? finiteSamples : [Infinity]),
    probabilityAboveCovenant: minDscrSamples.filter((d) => d >= covenantMinDscr).length / minDscrSamples.length,
    covenantMinDscr,
    note:
      finiteSamples.length === 0
        ? "This loan has no term (0 years) or zero principal — there is no debt service to cover."
        : "minimumDscrPercentiles describes each trial's WORST single year of coverage over the loan term, not an average — a covenant is breached by the worst year, not the typical one.",
  };
}
