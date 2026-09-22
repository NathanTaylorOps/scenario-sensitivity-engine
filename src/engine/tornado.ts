import { baseCase, sensitivityBounds } from "./distributions.ts";
import { npv } from "./financial.ts";
import { guardInputs } from "./guardedInputs.ts";
import type { Decision, TornadoRow } from "./types.ts";

/**
 * One-at-a-time sensitivity: hold every driver at its base case except one,
 * swing that one between its low and high bound, and record the resulting
 * swing in NPV. Ranked by absolute swing, this is the tornado chart — and
 * per the build plan, it runs BEFORE Monte Carlo to decide which 3-5 drivers
 * are worth full distributional treatment.
 */
export function tornadoAnalysis(decision: Decision): TornadoRow[] {
  const baseInputs: Record<string, number> = {};
  for (const driver of decision.drivers) {
    baseInputs[driver.id] = baseCase(driver.distribution);
  }
  const baseDiscountRate = baseCase(decision.discountRate.distribution);

  const rows: TornadoRow[] = decision.drivers.map((driver) => {
    const { low, high } = sensitivityBounds(driver.distribution);

    const lowInputs = { ...baseInputs, [driver.id]: low };
    const highInputs = { ...baseInputs, [driver.id]: high };

    const lowNpv = npv(baseDiscountRate, decision.cashFlows(guardInputs(lowInputs, decision.id)));
    const highNpv = npv(baseDiscountRate, decision.cashFlows(guardInputs(highInputs, decision.id)));

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
