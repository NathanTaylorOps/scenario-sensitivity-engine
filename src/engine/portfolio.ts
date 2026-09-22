import { createRng } from "./rng.ts";
import { sampleStandardNormal } from "./distributions.ts";
import { percentiles, probabilityExceeds } from "./percentiles.ts";
import { runMonteCarlo, runTrial, type RunOptions } from "./montecarlo.ts";
import { decisionVerdict, type VerdictResult } from "./verdict.ts";
import type { Decision, Percentiles as PercentilesType } from "./types.ts";

/**
 * Cross-decision comparison: a GM rarely evaluates one decision in
 * isolation — the real question is usually "which of these three is the
 * better bet, and by how much." Each decision is still run as its own
 * independent Monte Carlo (no shared macro factor here — see
 * runPortfolioMonteCarlo below for the version that couples them), and the
 * rows are ranked by P50 NPV so the strongest case sorts to the top without
 * hiding how it compares on downside risk or verdict.
 */
export interface ComparisonRow {
  decisionId: string;
  label: string;
  percentiles: PercentilesType;
  probabilityPositive: number;
  verdict: VerdictResult;
}

export function compareDecisions(decisions: Decision[], options: RunOptions): ComparisonRow[] {
  const rows: ComparisonRow[] = decisions.map((decision) => {
    const result = runMonteCarlo(decision, options);
    const npvPercentiles = percentiles(result.npvSamples);
    const probabilityPositive = probabilityExceeds(result.npvSamples, 0);
    return {
      decisionId: decision.id,
      label: decision.label,
      percentiles: npvPercentiles,
      probabilityPositive,
      verdict: decisionVerdict(probabilityPositive),
    };
  });
  return rows.sort((a, b) => b.percentiles.p50 - a.percentiles.p50);
}

export interface PortfolioRunOutput {
  /** Combined NPV across every decision, per trial. */
  npvSamples: number[];
  /** Combined year-0 capital outlay across every decision, per trial (positive = capital required). */
  outlaySamples: number[];
}

/**
 * Runs every decision's trials together, sharing ONE macro-conditions draw
 * per iteration across all of them (see the doc comment on
 * Decision.cashFlows in types.ts for why: a downturn should hit demand-linked
 * drivers across decisions together, not independently, when they're being
 * evaluated as a combined bet). This is a deliberately simplified stand-in
 * for full covariance-matrix / Cholesky-decomposition correlation modeling —
 * documented as a stated simplification in docs/METHODOLOGY.md, not silently
 * assumed to be the same thing.
 */
export function runPortfolioMonteCarlo(decisions: Decision[], options: RunOptions): PortfolioRunOutput {
  const rng = createRng(options.seed);
  const npvSamples: number[] = new Array(options.iterations);
  const outlaySamples: number[] = new Array(options.iterations);

  for (let i = 0; i < options.iterations; i++) {
    const macroFactor = sampleStandardNormal(rng);
    let combinedNpv = 0;
    let combinedOutlay = 0;
    for (const decision of decisions) {
      const trial = runTrial(decision, rng, macroFactor);
      combinedNpv += trial.npv;
      combinedOutlay += -trial.cashFlows[0]; // year-0 flow is negative for an outlay; flip sign to a positive capital-required figure
    }
    npvSamples[i] = combinedNpv;
    outlaySamples[i] = combinedOutlay;
  }

  return { npvSamples, outlaySamples };
}

export interface AffordabilityResult {
  availableCapital: number;
  /** Share of simulated trials where the combined year-0 outlay across every listed decision fits within availableCapital. */
  probabilityAffordable: number;
  combinedNpvPercentiles: PercentilesType;
  probabilityCombinedPositive: number;
  note: string;
}

/**
 * Answers the question a GM actually faces when several decisions compete
 * for the same budget: "if we fund all of these together, what's the
 * combined outlay likely to be, can we actually afford it, and is the
 * combined bet still worth it?" This treats every listed decision as
 * committed together in year 0 — it does not model staggering financing
 * across years, which is stated in the result rather than left implicit.
 */
export function portfolioAffordability(decisions: Decision[], availableCapital: number, options: RunOptions): AffordabilityResult {
  const { npvSamples, outlaySamples } = runPortfolioMonteCarlo(decisions, options);
  const affordableCount = outlaySamples.filter((outlay) => outlay <= availableCapital).length;
  return {
    availableCapital,
    probabilityAffordable: affordableCount / outlaySamples.length,
    combinedNpvPercentiles: percentiles(npvSamples),
    probabilityCombinedPositive: probabilityExceeds(npvSamples, 0),
    note: "Combined outlay assumes every listed decision is funded together in year 0 — this model does not stagger financing timing across decisions.",
  };
}
