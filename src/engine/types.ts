import type { Distribution } from "./distributions.ts";

/**
 * A named, independently-adjustable model input. This is the concrete
 * difference between a driver-based model and a hardcoded formula: every
 * number that feeds an output is a Driver with a name, a unit, and an
 * explicit distribution — never a magic constant buried in a calculation.
 */
export interface Driver {
  id: string;
  label: string;
  unit: string;
  category: "revenue" | "cost" | "capex" | "financing";
  distribution: Distribution;
  /** One-line note on why this distribution/range was chosen (methodology transparency). */
  rationale: string;
}

/** A decision is a named bundle of drivers plus the formula that turns them into outputs. */
export interface Decision {
  id: string;
  label: string;
  description: string;
  drivers: Driver[];
  /** Time horizon in years, for NPV/payback. */
  horizonYears: number;
  discountRate: Driver;
  /**
   * Computes AFTER-TAX period cash flows (year 0 = initial outlay, negative)
   * from a sampled input set. Implementations apply tax/depreciation
   * themselves via src/engine/tax.ts — this keeps that logic auditable in
   * one small module rather than hidden inside a generic runner.
   *
   * `macroFactor` is an optional shared economic-conditions z-score
   * (mean 0, std dev 1), sampled ONCE per trial and passed identically to
   * every decision in a portfolio run (see src/engine/portfolio.ts) so that
   * a downturn affects demand-linked drivers across decisions together
   * rather than independently. A standalone single-decision run always
   * passes 0 (no shared macro tilt) — deliberately, since the driver's own
   * distribution already carries its full uncertainty on its own; the
   * factor only matters when decisions are evaluated jointly.
   */
  cashFlows(inputs: Record<string, number>, macroFactor?: number): number[];
}

/** A persona bundles a fictional company context with the decisions it exposes. */
export interface Persona {
  id: string;
  name: string;
  tagline: string;
  decisions: Decision[];
}

export interface SimulationResult {
  npv: number[];
  paybackYears: (number | null)[];
  breakeven: number[];
}

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
  mean: number;
}

export interface TornadoRow {
  driverId: string;
  label: string;
  low: number;
  high: number;
  swing: number;
}
