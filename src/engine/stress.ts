import { runMonteCarlo, type RunOptions } from "./montecarlo.ts";
import { nearestScenario } from "./scenarios.ts";
import { percentiles } from "./percentiles.ts";
import type { Decision, Percentiles } from "./types.ts";

/**
 * A named compound stress scenario: "what does it look like if two or three
 * specific pessimistic drivers land together" — a different question from
 * P90, which is the 10th-percentile *outcome* but mixes many different
 * single-driver misses into one number, none of which may resemble the
 * specific compound case a lender or CEO actually wants to picture (e.g.
 * "margin compression AND a slow ramp", not just "a bad year in general").
 *
 * `matches` is a predicate over one trial's sampled driver inputs. Building
 * a named scenario is then just deciding which drivers must land in which
 * range together — no new statistical machinery, just a filter on top of
 * the same trials the Monte Carlo run already produced.
 */
export interface StressDefinition {
  label: string;
  matches(inputs: Record<string, number>): boolean;
}

export interface StressScenarioResult {
  label: string;
  matchedTrials: number;
  totalTrials: number;
  shareOfTrials: number;
  npvPercentiles: Percentiles | null;
  /** A real simulated trial's cash-flow array, nearest the matched subset's median NPV. Null if no trial matched. */
  representativeCashFlows: number[] | null;
  note: string;
}

/**
 * Runs the decision's own Monte Carlo, then filters trials down to the ones
 * matching the named stress definition and reports the NPV distribution and
 * a representative cash-flow scenario *within that subset only*.
 */
export function runStressScenario(decision: Decision, options: RunOptions, stress: StressDefinition): StressScenarioResult {
  const result = runMonteCarlo(decision, { ...options, captureCashFlows: true, captureInputs: true });
  const inputsSamples = result.inputsSamples!;
  const cashFlowSamples = result.cashFlowSamples!;

  const matchedIndices: number[] = [];
  for (let i = 0; i < inputsSamples.length; i++) {
    if (stress.matches(inputsSamples[i])) matchedIndices.push(i);
  }

  if (matchedIndices.length === 0) {
    return {
      label: stress.label,
      matchedTrials: 0,
      totalTrials: options.iterations,
      shareOfTrials: 0,
      npvPercentiles: null,
      representativeCashFlows: null,
      note: "No simulated trial matched this scenario's criteria within the sampled range — the combination may be rarer than the iteration count captures, or may not be jointly achievable given how these drivers are distributed. Try more iterations or a looser match before concluding it can't happen.",
    };
  }

  const matchedNpv = matchedIndices.map((i) => result.npvSamples[i]);
  const matchedCashFlows = matchedIndices.map((i) => cashFlowSamples[i]);
  const npvPercentiles = percentiles(matchedNpv);
  const representativeCashFlows = nearestScenario(matchedNpv, matchedCashFlows, npvPercentiles.p50);

  return {
    label: stress.label,
    matchedTrials: matchedIndices.length,
    totalTrials: options.iterations,
    shareOfTrials: matchedIndices.length / options.iterations,
    npvPercentiles,
    representativeCashFlows,
    note: `${matchedIndices.length} of ${options.iterations} simulated trials matched this scenario's criteria.`,
  };
}
