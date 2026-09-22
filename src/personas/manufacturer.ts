import type { Persona, Driver, Decision } from "../engine/types.ts";
import { afterTaxCashFlows } from "../engine/tax.ts";
import { validatePersona } from "../engine/validation.ts";

/**
 * Shared tax-rate driver, one instance per decision (Driver objects aren't
 * shared by reference across decisions elsewhere in this file either — each
 * decision gets its own so a per-decision override is a one-line change
 * later, not a refactor).
 */
function taxRateDriver(): Driver {
  return {
    id: "taxRate",
    label: "Effective combined tax rate",
    unit: "%",
    category: "financing",
    distribution: { kind: "pert", min: 0.21, mode: 0.26, max: 0.3 },
    rationale:
      "Combined federal + state effective rate for a small/mid-size manufacturer; modeled as uncertain rather than fixed since state apportionment, credits, and entity structure vary.",
  };
}

/** Demand-linked drivers get a modest macro-conditions tilt in a portfolio run (see Decision.cashFlows doc comment); this is the size of that tilt, applied identically wherever it's used so a reviewer can find it once. */
const MACRO_DEMAND_SENSITIVITY = 0.15;

/**
 * Persona A: a mid-size specialty manufacturer / production workshop.
 * Figures grounded in the benchmark data reference (BLS OES 51-9161,
 * equipment dealer listings, small-business capital budgeting norms) —
 * not round, arbitrary numbers. See docs/BENCHMARKS.md for sources.
 */

const discountRate: Driver = {
  id: "discountRate",
  label: "Discount rate (hurdle rate)",
  unit: "%/yr",
  category: "financing",
  distribution: { kind: "pert", min: 0.08, mode: 0.12, max: 0.18 },
  rationale:
    "Small-business hurdle rates commonly run 10-15%, with 8% a conservative floor and 15-20% for riskier capex. Treated as an uncertain input, not fixed, since it's often a top sensitivity driver on its own.",
};

/** Decision A1: buy a second CNC machine / production line. */
const capexDecision: Decision = {
  id: "second-cnc-line",
  label: "Buy a second CNC machine / production line",
  description:
    "Adds production capacity to take on more order volume. Evaluated as a 5-year capex investment against incremental contribution margin from the added capacity.",
  horizonYears: 5,
  discountRate,
  drivers: [
    {
      id: "capex",
      label: "Machine/line capex",
      unit: "USD",
      category: "capex",
      distribution: { kind: "pert", min: 150000, mode: 250000, max: 500000 },
      rationale: "Mid-size new CNC machining center typical range, per equipment dealer listings.",
    },
    {
      id: "incrementalUnitsPerYear",
      label: "Incremental units produced per year",
      unit: "units/yr",
      category: "revenue",
      distribution: { kind: "triangular", min: 4000, mode: 7000, max: 11000 },
      rationale: "Additional capacity utilization is judgment-based (no historical data for a machine not yet bought) — triangular fits an expert three-point estimate.",
    },
    {
      id: "contributionMarginPerUnit",
      label: "Contribution margin per unit",
      unit: "USD/unit",
      category: "revenue",
      distribution: { kind: "pert", min: 8, mode: 14, max: 22 },
      rationale: "Implied by a 25-40% gross margin range on typical custom/job-shop unit pricing.",
    },
    {
      id: "annualMaintenanceCost",
      label: "Annual maintenance & service cost",
      unit: "USD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 8000, mode: 15000, max: 28000 },
      rationale:
        "Machine-only cost: service contracts, parts, and consumables, roughly 5-8% of capex/yr per typical CNC service-contract benchmarks. Deliberately excludes any operator labor — the earlier version bundled an implied operator wage into this figure, which double-counted against the second-shift decision's headcount cost whenever both decisions are evaluated together (see src/engine/sequence.ts). Operator labor for running this line during EXISTING shift hours is assumed absorbed by current staff and isn't modeled as an incremental cost anywhere; only the second-shift decision's headcount is new labor.",
    },
    {
      id: "salvageValuePct",
      label: "Resale value at end of horizon (% of original capex)",
      unit: "%",
      category: "capex",
      distribution: { kind: "triangular", min: 0.05, mode: 0.15, max: 0.3 },
      rationale: "Used CNC equipment resale value after 5 years of service, per equipment dealer secondary-market listings.",
    },
    {
      id: "commissioningDelayMonths",
      label: "Commissioning/ramp-up delay before full production",
      unit: "months",
      category: "cost",
      distribution: { kind: "pert", min: 1, mode: 3, max: 6 },
      rationale:
        "Time from delivery to full-rate output (installation, calibration, operator training) — modeled as reducing year-1 output rather than assumed away. Added specifically because the model previously implied day-one full productivity, which the person who'd actually have to run this flagged as unrealistic.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const effectiveUnits = inputs.incrementalUnitsPerYear * demandTilt;
    const steadyStateNet = effectiveUnits * inputs.contributionMarginPerUnit - inputs.annualMaintenanceCost;
    const year1RampFraction = Math.max(0, 1 - inputs.commissioningDelayMonths / 12);
    const pretax: number[] = [-inputs.capex, steadyStateNet * year1RampFraction];
    for (let year = 2; year <= 5; year++) pretax.push(steadyStateNet);
    return afterTaxCashFlows(pretax, {
      capex: inputs.capex,
      usefulLifeYears: 5,
      taxRate: inputs.taxRate,
      salvageValue: inputs.capex * inputs.salvageValuePct,
    });
  },
};

/** Decision A2: take on a large new customer contract. */
const contractDecision: Decision = {
  id: "large-customer-contract",
  label: "Take on a large new customer contract",
  description:
    "A multi-year supply contract with a large customer. Margin is sensitive to input-cost volatility over the contract term, evaluated over 3 years.",
  horizonYears: 3,
  discountRate,
  drivers: [
    {
      id: "annualRevenue",
      label: "Contract annual revenue",
      unit: "USD/yr",
      category: "revenue",
      distribution: { kind: "pert", min: 250000, mode: 600000, max: 950000 },
      rationale: "Scaled to a mid-size shop's typical large-account size; downside widened to reflect real volume/renewal risk over a multi-year single-customer contract.",
    },
    {
      id: "grossMarginPct",
      label: "Gross margin",
      unit: "%",
      category: "revenue",
      distribution: { kind: "pert", min: 0.1, mode: 0.28, max: 0.4 },
      rationale: "25-40% typical gross margin range for small/mid manufacturers; wider downside to reflect commodity-pricing risk on a large single-customer contract.",
    },
    {
      id: "inputCostInflationPct",
      label: "Annual input-cost inflation",
      unit: "%/yr",
      category: "cost",
      distribution: { kind: "lognormal", median: 0.03, sigma: 0.5 },
      rationale: "Cost inflation is right-skewed (occasional cost shocks) — lognormal avoids symmetric downside that doesn't exist in practice.",
    },
    {
      id: "onboardingCost",
      label: "One-time onboarding/tooling cost",
      unit: "USD",
      category: "capex",
      distribution: { kind: "pert", min: 20000, mode: 45000, max: 90000 },
      rationale: "New-customer tooling and qualification costs, expert three-point estimate.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const effectiveAnnualRevenue = inputs.annualRevenue * demandTilt;
    const pretax: number[] = [-inputs.onboardingCost];
    let margin = inputs.grossMarginPct;
    for (let year = 1; year <= 3; year++) {
      pretax.push(effectiveAnnualRevenue * margin);
      margin = margin - inputs.inputCostInflationPct * margin * 0.5; // cost inflation erodes margin
    }
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

/** Decision A3: add a second shift / headcount ahead of order backlog. */
const headcountDecision: Decision = {
  id: "second-shift-headcount",
  label: "Add a second shift ahead of order backlog",
  description:
    "Hiring ahead of demand to run a second shift. Evaluated over 2 years against uncertain demand ramp-up. This is the ONLY new labor cost modeled anywhere in this persona — the capex decision's maintenance cost is deliberately machine-only (see its rationale) precisely so the two decisions can be run together (see src/engine/sequence.ts) without double-counting a shared operator's wage.",
  horizonYears: 2,
  discountRate,
  drivers: [
    {
      id: "headcount",
      label: "Additional headcount",
      unit: "workers",
      category: "cost",
      distribution: { kind: "triangular", min: 3, mode: 5, max: 8 },
      rationale: "Second-shift crew size, expert judgment bounded by shop floor capacity.",
    },
    {
      id: "annualWagePerWorker",
      label: "Annual wage per worker",
      unit: "USD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 37000, mode: 47000, max: 58000 },
      rationale: "BLS OES 51-9161 CNC operator wage range.",
    },
    {
      id: "demandRampUnitsPerYear",
      label: "Additional demand captured per year",
      unit: "units/yr",
      category: "revenue",
      distribution: { kind: "normal", mean: 19000, stdDev: 6000 },
      rationale: "A second shift roughly doubles floor capacity, not a marginal increment — sized to real second-shift throughput, not the first shift's incremental-unit range. Aggregated demand across many customers — normal fits a CLT-driven aggregate variable.",
    },
    {
      id: "contributionMarginPerUnit",
      label: "Contribution margin per unit",
      unit: "USD/unit",
      category: "revenue",
      distribution: { kind: "pert", min: 8, mode: 14, max: 22 },
      rationale: "Same basis as the capex decision's margin driver.",
    },
    {
      id: "hiringRampMonths",
      label: "Hiring/training ramp before full second-shift output",
      unit: "months",
      category: "cost",
      distribution: { kind: "triangular", min: 1, mode: 2, max: 4 },
      rationale:
        "Time to recruit, onboard, and train a second-shift crew to full productivity — wages are paid in full during this period, but output isn't. Modeled as reducing year-1 demand captured rather than assumed instantaneous, for the same reason as the capex decision's commissioning delay.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const laborCost = inputs.headcount * inputs.annualWagePerWorker;
    const steadyStateRevenue = inputs.demandRampUnitsPerYear * demandTilt * inputs.contributionMarginPerUnit;
    const year1RampFraction = Math.max(0, 1 - inputs.hiringRampMonths / 12);
    const pretax: number[] = [0, steadyStateRevenue * year1RampFraction - laborCost, steadyStateRevenue - laborCost];
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

export const manufacturerPersona: Persona = {
  id: "manufacturer",
  name: "Mid-size manufacturer / production workshop",
  tagline: "Should we add capacity, take the contract, or staff up first?",
  decisions: [capexDecision, contractDecision, headcountDecision],
};

// Fail fast on import if this config is ever malformed — a persona is only
// as trustworthy as its worst-defined driver, and this catches that at
// load time rather than as a downstream NaN.
validatePersona(manufacturerPersona);
