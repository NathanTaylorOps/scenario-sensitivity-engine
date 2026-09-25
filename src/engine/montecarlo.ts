import { createRng } from "./rng.ts";
import { sample, baseCase } from "./distributions.ts";
import type { Decision, Driver } from "./types.ts";
import { npv, paybackPeriod } from "./financial.ts";
import { guardInputs } from "./guardedInputs.ts";

export interface RunOptions {
  iterations: number;
  seed: number;
  /**
   * When true, retains every trial's full cash-flow array so a caller can
   * extract representative scenarios (see src/engine/scenarios.ts). Off by
   * default: for large iteration counts this is a meaningful amount of
   * memory (iterations x horizonYears numbers), so callers opt in only when
   * they actually need year-by-year visibility, not just the NPV summary.
   */
  captureCashFlows?: boolean;
  /**
   * When true, retains every trial's full sampled-inputs record, so a
   * caller can filter trials by driver value (src/engine/stress.ts) or
   * measure each driver's share of the NPV variance (src/engine/variance.ts).
   * Off by default for the same memory-cost reason as captureCashFlows.
   */
  captureInputs?: boolean;
}

export interface RunOutput {
  npvSamples: number[];
  paybackSamples: (number | null)[];
  /** Present only when RunOptions.captureCashFlows was true. cashFlowSamples[i] is trial i's full cash-flow array. */
  cashFlowSamples?: number[][];
  /**
   * Present only when RunOptions.captureInputs was true. inputsSamples[i] is
   * trial i's full sampled record: every driver plus the sampled discount
   * rate under `decision.discountRate.id`, so the hurdle rate can be
   * analysed alongside the operating drivers rather than hidden from them.
   */
  inputsSamples?: Record<string, number>[];
}

/**
 * Draws one full input set for a decision: every driver, plus its discount
 * rate unless the caller supplies one (a portfolio run draws the firm's
 * hurdle rate once per trial and shares it across every decision).
 */
function sampleInputs(decision: Decision, rng: () => number, sharedDiscountRate?: number): { inputs: Record<string, number>; discountRate: number } {
  const inputs: Record<string, number> = {};
  for (const driver of decision.drivers) {
    inputs[driver.id] = sample(driver.distribution, rng);
  }
  const discountRate = sharedDiscountRate ?? sample(decision.discountRate.distribution, rng);
  inputs[decision.discountRate.id] = discountRate;
  return { inputs, discountRate };
}

/**
 * One trial: sample inputs, compute cash flows, and return NPV alongside
 * them. Shared by every caller that runs trials, so the sampling logic
 * can't drift between them. Exported (not just used internally) because
 * src/engine/portfolio.ts needs to run trials across several decisions per
 * iteration against one shared macroFactor draw and one shared hurdle rate.
 */
export function runTrial(
  decision: Decision,
  rng: () => number,
  macroFactor = 0,
  sharedDiscountRate?: number,
): { npv: number; cashFlows: number[]; inputs: Record<string, number>; discountRate: number } {
  const { inputs, discountRate } = sampleInputs(decision, rng, sharedDiscountRate);
  const cashFlows = decision.cashFlows(guardInputs(inputs, decision.id), macroFactor);
  return { npv: npv(discountRate, cashFlows), cashFlows, inputs, discountRate };
}

/** Runs N Monte Carlo iterations for a decision and returns the raw NPV/payback samples. A standalone run passes macroFactor=0 — see the doc comment on Decision.cashFlows. */
export function runMonteCarlo(decision: Decision, options: RunOptions): RunOutput {
  const rng = createRng(options.seed);
  const npvSamples: number[] = new Array(options.iterations);
  const paybackSamples: (number | null)[] = new Array(options.iterations);
  const cashFlowSamples: number[][] | undefined = options.captureCashFlows ? new Array(options.iterations) : undefined;
  const inputsSamples: Record<string, number>[] | undefined = options.captureInputs ? new Array(options.iterations) : undefined;

  for (let i = 0; i < options.iterations; i++) {
    const trial = runTrial(decision, rng, 0);
    npvSamples[i] = trial.npv;
    paybackSamples[i] = paybackPeriod(trial.cashFlows);
    if (cashFlowSamples) cashFlowSamples[i] = trial.cashFlows;
    if (inputsSamples) inputsSamples[i] = trial.inputs;
  }

  const output: RunOutput = { npvSamples, paybackSamples };
  if (cashFlowSamples) output.cashFlowSamples = cashFlowSamples;
  if (inputsSamples) output.inputsSamples = inputsSamples;
  return output;
}

/**
 * The one hurdle-rate driver a set of decisions evaluated together shares.
 * A discount rate is a property of the firm, not of the project: when
 * several decisions are simulated jointly (portfolio, sequence) the rate is
 * drawn once per trial and applied to all of them, so a trial with a high
 * cost of capital is high for every decision at once. That only makes sense
 * when the decisions actually declare the same hurdle-rate distribution,
 * which every persona's decisions do; mixing decisions that disagree on it
 * is rejected rather than silently resolved in favour of the first one.
 */
export function sharedDiscountRateDriver(decisions: Decision[]): Driver {
  if (decisions.length === 0) throw new Error("sharedDiscountRateDriver: no decisions supplied");
  const first = decisions[0].discountRate;
  const reference = JSON.stringify(first.distribution);
  for (const decision of decisions.slice(1)) {
    if (JSON.stringify(decision.discountRate.distribution) !== reference) {
      throw new Error(
        `Decisions "${decisions[0].id}" and "${decision.id}" declare different discount-rate distributions. A joint run shares one hurdle rate per trial, so every decision in it must use the same distribution.`,
      );
    }
  }
  return first;
}

/** Every driver plus the discount rate at its base-case value — the deterministic starting point for the base case, tornado and goal-seek. */
export function baseCaseInputs(decision: Decision): Record<string, number> {
  const inputs: Record<string, number> = {};
  for (const driver of decision.drivers) {
    inputs[driver.id] = baseCase(driver.distribution);
  }
  inputs[decision.discountRate.id] = baseCase(decision.discountRate.distribution);
  return inputs;
}

/** NPV of the decision at one specific input set (drivers plus discount rate under `decision.discountRate.id`), with no randomness. */
export function npvAtInputs(decision: Decision, inputs: Record<string, number>, macroFactor = 0): number {
  return npv(inputs[decision.discountRate.id], decision.cashFlows(guardInputs(inputs, decision.id), macroFactor));
}

/** Runs the decision once at every driver's base-case (mean) value — no randomness. */
export function runBaseCase(decision: Decision): { npv: number; payback: number | null; cashFlows: number[] } {
  const inputs = baseCaseInputs(decision);
  const cashFlows = decision.cashFlows(guardInputs(inputs, decision.id));
  return { npv: npv(inputs[decision.discountRate.id], cashFlows), payback: paybackPeriod(cashFlows), cashFlows };
}

/**
 * Running-mean convergence check: returns the running mean of NPV every
 * `checkpointEvery` iterations, so a caller (or a test) can confirm the
 * estimate stabilizes as sample size grows (law of large numbers sanity
 * check), rather than trusting a single fixed iteration count blindly.
 */
export function convergenceTrace(decision: Decision, options: RunOptions, checkpointEvery: number): number[] {
  const rng = createRng(options.seed);
  const trace: number[] = [];
  let runningSum = 0;
  for (let i = 1; i <= options.iterations; i++) {
    runningSum += runTrial(decision, rng, 0).npv;
    if (i % checkpointEvery === 0) {
      trace.push(runningSum / i);
    }
  }
  return trace;
}
