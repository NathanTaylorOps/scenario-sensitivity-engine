import { sensitivityBounds } from "./distributions.ts";
import { baseCaseInputs, npvAtInputs } from "./montecarlo.ts";
import type { Decision, Driver, TornadoRow } from "./types.ts";

/**
 * Every input the tornado, variance breakdown and goal-seek treat as a
 * driver: the decision's operating drivers plus its discount rate. The
 * hurdle rate is sampled like any other uncertain input and is often one of
 * the larger single contributors to NPV spread, so excluding it would hand
 * its share of the variance to the other drivers and hide a lever a CFO
 * can actually pull.
 */
export function analysedDrivers(decision: Decision): Driver[] {
  return [...decision.drivers, decision.discountRate];
}

/**
 * One-at-a-time sensitivity: hold every driver at its base case except one,
 * swing that one between its P10 and P90, and record the resulting swing in
 * NPV. Ranked by absolute swing, this is the tornado chart — it runs BEFORE
 * Monte Carlo to decide which 3-5 drivers are worth full distributional
 * treatment.
 */
export function tornadoAnalysis(decision: Decision): TornadoRow[] {
  const baseInputs = baseCaseInputs(decision);

  const rows: TornadoRow[] = analysedDrivers(decision).map((driver) => {
    const { low, high } = sensitivityBounds(driver.distribution);

    const lowNpv = npvAtInputs(decision, { ...baseInputs, [driver.id]: low });
    const highNpv = npvAtInputs(decision, { ...baseInputs, [driver.id]: high });

    return {
      driverId: driver.id,
      label: driver.label,
      low: Math.min(lowNpv, highNpv),
      high: Math.max(lowNpv, highNpv),
      swing: Math.abs(highNpv - lowNpv),
    };
  });

  return rows.sort((a, b) => b.swing - a.swing);
}
