import { createRng } from "./rng.ts";
import { sample } from "./distributions.ts";
import { sampleStandardNormal } from "./distributions.ts";
import { guardInputs } from "./guardedInputs.ts";
import { percentiles } from "./percentiles.ts";
import type { Decision, Percentiles } from "./types.ts";

/**
 * One decision placed on a shared calendar, optionally depending on another
 * decision already placed earlier in the same sequence.
 *
 * This is the piece the standalone and portfolio runners don't have: those
 * treat decisions as either fully independent (compareDecisions) or
 * independent-but-sharing-macro-conditions (runPortfolioMonteCarlo) — never
 * genuinely sequential, where one decision's real-world output (e.g. the
 * CNC line's added capacity) caps what another decision (the second shift)
 * can actually sell. Two decisions "competing for the same budget" and two
 * decisions "the second one only exists because of the first" are different
 * situations, and conflating them was flagged directly as a gap.
 */
export interface SequencedDecision {
  decision: Decision;
  /** Year, relative to a shared calendar t=0, at which this decision's OWN year-0 cash flow lands. 0 = starts immediately; 1 = starts a year after the calendar begins. */
  startYear: number;
  /**
   * Optional dependency on a decision earlier in the same sequence array.
   * `adjust` runs after both decisions' own inputs are sampled for this
   * trial, before this decision's cashFlows runs, and can tighten this
   * decision's inputs using the upstream decision's sampled inputs from the
   * SAME trial (e.g. capping achievable demand at the capacity the earlier
   * decision actually produced in this particular simulated draw, not its
   * base case).
   */
  dependsOn?: {
    decisionId: string;
    adjust(inputs: Record<string, number>, upstreamInputs: Record<string, number>): Record<string, number>;
  };
}

export interface SequenceRunOptions {
  iterations: number;
  seed: number;
  /** Retains each trial's full calendar-aligned combined cash-flow array. Off by default for the same memory reason as elsewhere. */
  captureCalendar?: boolean;
}

export interface SequenceRunOutput {
  /** Combined NPV per trial: each decision's own cash flows, discounted at its own hurdle rate but timed against the shared calendar (a cash flow starting in calendar year `startYear + t` is discounted over `startYear + t` periods, not just `t`). */
  combinedNpvSamples: number[];
  /**
   * The lowest cumulative combined cash balance reached at any point on the
   * calendar, per trial — undiscounted actual dollars, because the question
   * this answers ("can we make payroll in the bad scenario") is about
   * liquidity, not present value. A large negative trough means the
   * combined outlay timing draws the business further into the red than
   * its NPV alone would suggest.
   */
  minimumCumulativeCashSamples: number[];
  /** Present only when captureCalendar was true. calendarCashFlowSamples[i] is trial i's combined cash flow at each calendar year, aligned across every decision's startYear offset. */
  calendarCashFlowSamples?: number[][];
}

/** Validates that every `dependsOn` reference points at a decision listed earlier in the sequence — a dependency on a not-yet-run decision, or a later one, would silently use stale or wrong data. */
function validateSequence(sequence: SequencedDecision[]): void {
  const seenIds = new Set<string>();
  for (const entry of sequence) {
    if (entry.dependsOn && !seenIds.has(entry.dependsOn.decisionId)) {
      throw new Error(
        `runSequencedPortfolio: "${entry.decision.id}" depends on "${entry.dependsOn.decisionId}", which must appear earlier in the sequence array (it either isn't in the sequence at all, or comes after this decision).`,
      );
    }
    seenIds.add(entry.decision.id);
  }
}

export function runSequencedPortfolio(sequence: SequencedDecision[], options: SequenceRunOptions): SequenceRunOutput {
  validateSequence(sequence);

  const rng = createRng(options.seed);
  const calendarLength = Math.max(...sequence.map((entry) => entry.startYear + entry.decision.horizonYears)) + 1;

  const combinedNpvSamples: number[] = new Array(options.iterations);
  const minimumCumulativeCashSamples: number[] = new Array(options.iterations);
  const calendarCashFlowSamples: number[][] | undefined = options.captureCalendar ? new Array(options.iterations) : undefined;

  for (let trial = 0; trial < options.iterations; trial++) {
    const macroFactor = sampleStandardNormal(rng);
    const calendar: number[] = new Array(calendarLength).fill(0);
    const upstreamInputsById = new Map<string, Record<string, number>>();
    let combinedNpv = 0;

    for (const entry of sequence) {
      const { decision, startYear, dependsOn } = entry;

      let inputs: Record<string, number> = {};
      for (const driver of decision.drivers) inputs[driver.id] = sample(driver.distribution, rng);
      const discountRate = sample(decision.discountRate.distribution, rng);

      if (dependsOn) {
        const upstreamInputs = upstreamInputsById.get(dependsOn.decisionId);
        if (!upstreamInputs) {
          throw new Error(`runSequencedPortfolio: no recorded inputs for upstream decision "${dependsOn.decisionId}" (this should have been caught by validateSequence)`);
        }
        inputs = dependsOn.adjust(inputs, upstreamInputs);
      }

      upstreamInputsById.set(decision.id, inputs);

      const cashFlows = decision.cashFlows(guardInputs(inputs, decision.id), macroFactor);

      for (let t = 0; t < cashFlows.length; t++) {
        const calendarYear = startYear + t;
        calendar[calendarYear] += cashFlows[t];
        combinedNpv += cashFlows[t] / Math.pow(1 + discountRate, calendarYear);
      }
    }

    let cumulative = 0;
    let minimumCumulative = 0;
    for (const yearFlow of calendar) {
      cumulative += yearFlow;
      if (cumulative < minimumCumulative) minimumCumulative = cumulative;
    }

    combinedNpvSamples[trial] = combinedNpv;
    minimumCumulativeCashSamples[trial] = minimumCumulative;
    if (calendarCashFlowSamples) calendarCashFlowSamples[trial] = calendar;
  }

  const output: SequenceRunOutput = { combinedNpvSamples, minimumCumulativeCashSamples };
  if (calendarCashFlowSamples) output.calendarCashFlowSamples = calendarCashFlowSamples;
  return output;
}

export interface CovenantCheckResult {
  cashFloor: number;
  /** Share of simulated trials whose minimum cumulative cash balance never dropped below the stated floor. */
  probabilityWithinFloor: number;
  minimumCashPercentiles: Percentiles;
  note: string;
}

/**
 * Answers "can we make payroll (or stay above a lender's covenant) in the
 * bad scenario" directly: what share of simulated trials keep the combined
 * cash balance above a stated floor at every point on the calendar, not
 * just at the end.
 */
export function covenantCheck(minimumCumulativeCashSamples: number[], cashFloor: number): CovenantCheckResult {
  const withinFloorCount = minimumCumulativeCashSamples.filter((minCash) => minCash >= cashFloor).length;
  return {
    cashFloor,
    probabilityWithinFloor: withinFloorCount / minimumCumulativeCashSamples.length,
    minimumCashPercentiles: percentiles(minimumCumulativeCashSamples),
    note: "minimumCashPercentiles describes how low the combined cash balance gets at its worst point on the calendar, per trial — not the ending balance.",
  };
}
