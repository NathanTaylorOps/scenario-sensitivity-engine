import { baseCase } from "./distributions.ts";
import type { Decision, Percentiles } from "./types.ts";
import type { VerdictResult } from "./verdict.ts";
import type { VarianceContributionRow } from "./variance.ts";

/**
 * The same simulation output means different things to different readers —
 * a GM wants a verdict, a CFO wants the assumptions behind the number, an
 * executor wants one operational instruction, and none of them want the
 * other two views cluttering theirs. This module defines the three views as
 * plain data/text derived from the same result, so the UI has a tested
 * place to pull each one from.
 */

/** Finds the driver in this decision whose id represents its ramp/commissioning delay, if it has one — personas name this differently per decision. */
function findRampDriver(decision: Decision) {
  return decision.drivers.find((d) => d.id === "commissioningDelayMonths" || d.id === "hiringRampMonths");
}

/**
 * The Decision-Executor's view: one instruction, not a financial model.
 * Deliberately omits NPV/percentiles entirely — the one actionable fact
 * should not be buried inside a P90/P50/P10 table.
 *
 * Only a Proceed verdict is an approval. A Marginal verdict is a coin flip,
 * and telling the person who would place the equipment order or start
 * hiring to "begin now" on a coin flip is exactly the instruction this view
 * exists to avoid; it says what has to be resolved first instead.
 */
export function operationalBrief(decision: Decision, verdict: VerdictResult, topDriverLabel?: string): string {
  if (verdict.verdict === "Reconsider") {
    return `${decision.label}: NOT approved as modelled. ${verdict.rationale}`;
  }
  const rampDriver = findRampDriver(decision);
  const rampMonths = rampDriver ? baseCase(rampDriver.distribution) : null;

  if (verdict.verdict === "Marginal") {
    const resolveFirst = topDriverLabel
      ? `Firm up "${topDriverLabel}" (the largest swing in the tornado ranking) with a quote, a signed order or a trial before committing.`
      : "Firm up the top driver in the tornado ranking with a quote, a signed order or a trial before committing.";
    const rampNote = rampMonths !== null ? ` If it is then approved, plan for ~${rampMonths.toFixed(1)} month(s) of ramp-up before full output.` : "";
    return `${decision.label}: NOT YET approved — NPV is positive in only ${(verdict.probabilityPositive * 100).toFixed(0)}% of simulated outcomes. ${resolveFirst} Do not place orders or start hiring on this case as it stands.${rampNote}`;
  }

  if (rampMonths === null) {
    return `${decision.label}: approved (proceed case). No modelled ramp-up delay for this decision — plan to be at full output from day one.`;
  }
  return `${decision.label}: approved (proceed case). Plan for ~${rampMonths.toFixed(1)} month(s) of ramp-up before full output — begin hiring/ordering/scheduling now, not when the decision closes.`;
}

/**
 * The CFO/Controller's view: assumptions and after-tax numbers front and
 * center, plus which drivers actually explain the spread — the opposite
 * ordering from the executor's view above.
 */
export interface FinancialDetailView {
  decisionLabel: string;
  taxRateBaseCase: number | null;
  npvPercentiles: Percentiles;
  topVarianceDrivers: VarianceContributionRow[];
  /** One entry per driver — `heading` is short and scannable (label + unit),
   * `detail` is the full sourcing rationale. Kept as two fields rather than one
   * pre-joined string so the UI can style them as a two-line item (bold heading,
   * muted detail) instead of one long run-on sentence per driver. */
  assumptionLines: { heading: string; detail: string }[];
}

export function financialDetailView(
  decision: Decision,
  npvPercentiles: Percentiles,
  varianceRows: VarianceContributionRow[],
): FinancialDetailView {
  const taxDriver = decision.drivers.find((d) => d.id === "taxRate");
  return {
    decisionLabel: decision.label,
    taxRateBaseCase: taxDriver ? baseCase(taxDriver.distribution) : null,
    npvPercentiles,
    topVarianceDrivers: varianceRows.slice(0, 3),
    assumptionLines: decision.drivers.map((d) => ({ heading: `${d.label} (${d.unit})`, detail: d.rationale })),
  };
}

/**
 * The Lender/Investor's view: the downside case and any residual value,
 * not the headline verdict.
 */
export interface RiskBriefView {
  decisionLabel: string;
  downsideNpv: number;
  downsideRepresentativeCashFlows: number[] | null;
  hasResidualValue: boolean;
  note: string;
}

export function riskBriefView(decision: Decision, npvPercentiles: Percentiles, p90RepresentativeCashFlows: number[] | null): RiskBriefView {
  const hasResidualValue = decision.drivers.some((d) => d.id === "salvageValuePct");
  return {
    decisionLabel: decision.label,
    downsideNpv: npvPercentiles.p90, // exceedance convention: P90 is the low/conservative case
    downsideRepresentativeCashFlows: p90RepresentativeCashFlows,
    hasResidualValue,
    note: hasResidualValue
      ? "This decision has a modeled residual/salvage value in the downside case, which the P90 figure and cash-flow scenario already account for."
      : "This decision has no modeled residual asset value — the downside case does not include any recovery value.",
  };
}
