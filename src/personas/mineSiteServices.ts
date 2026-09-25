import type { Persona, Driver, Decision } from "../engine/types.ts";
import { afterTaxCashFlows } from "../engine/tax.ts";
import { validatePersona } from "../engine/validation.ts";

/**
 * Persona B: a heavy-machinery repair and logistics workshop serving
 * remote mine sites hours away. Same shared engine as the manufacturer
 * persona (src/personas/manufacturer.ts) — swapping personas swaps this
 * config file, not the simulation code, which was the whole point of
 * building the engine driver-based in the first place.
 *
 * Figures grounded in real, checkable sources (see docs/BENCHMARKS.md):
 * Australian FIFO heavy-vehicle/mobile-equipment mechanic wage data,
 * heavy-equipment dealer/auction listings for a fitted-out field-service
 * truck, and trucking/logistics industry margin benchmarks. Dollar figures
 * are in AUD.
 */

function taxRateDriver(): Driver {
  return {
    id: "taxRate",
    label: "Effective combined tax rate",
    unit: "%",
    category: "financing",
    distribution: { kind: "pert", min: 0.25, mode: 0.27, max: 0.3 },
    rationale:
      "Australian company tax: 25% for a base-rate entity (aggregated turnover under A$50m and no more than 80% passive income, ATO), 30% otherwise. Modeled as uncertain rather than fixed at 25% since payroll tax and a bad year tipping the business over the passive-income test can push the effective rate up.",
  };
}

/**
 * This persona's demand-linked drivers get a LARGER macro-conditions tilt
 * than the manufacturer persona's 0.15 (see src/personas/manufacturer.ts) —
 * a stated, persona-specific choice, not a shared constant: mine-site
 * service demand is more directly commodity-cycle-exposed than general
 * discrete-parts manufacturing, since mine operators cut maintenance and
 * haulage spend hard and fast when commodity prices fall.
 */
const MACRO_DEMAND_SENSITIVITY = 0.25;

const discountRate: Driver = {
  id: "discountRate",
  label: "Discount rate (hurdle rate)",
  unit: "%/yr",
  category: "financing",
  distribution: { kind: "pert", min: 0.1, mode: 0.15, max: 0.22 },
  rationale:
    "Set above the manufacturer persona's 8-18% Australian small-business range: remote/mine-services businesses carry a risk premium over general small-business hurdle rates, given commodity-cycle exposure and single-site-access dependency.",
};

/** Decision B1: add a second mobile field-service truck (crane, welder, generator) for mine-site call-outs. */
const truckDecision: Decision = {
  id: "second-field-service-truck",
  label: "Add a second mobile field-service truck",
  description:
    "A fully equipped crane/welder/generator mobile mechanic truck for on-site heavy-equipment repair at remote mine sites. Evaluated as a 5-year capex investment against incremental service call-out capacity.",
  horizonYears: 5,
  discountRate,
  drivers: [
    {
      id: "capex",
      label: "Truck/crane/tooling capex",
      unit: "AUD",
      category: "capex",
      distribution: { kind: "pert", min: 252000, mode: 392000, max: 630000 },
      rationale: "Fully equipped mobile mechanic/field-service truck (crane, welder, generator, tooling) for remote heavy-equipment repair, in AUD, per heavy-equipment dealer and auction listings — higher than the US market given freight, duty, and a thinner secondary market for fitted-out service trucks in Australia.",
    },
    {
      id: "incrementalCallOutsPerYear",
      label: "Incremental service call-outs per year",
      unit: "call-outs/yr",
      category: "revenue",
      distribution: { kind: "triangular", min: 60, mode: 120, max: 220 },
      rationale:
        "Deliberately much lower than the manufacturer persona's on-site incremental-units driver: multi-hour travel each way to a remote mine site sharply caps how many call-outs one truck can complete per year, unlike a machine running continuously on a factory floor. Triangular fits an expert three-point estimate bounded by realistic travel-time-constrained throughput.",
    },
    {
      id: "contributionMarginPerCallOut",
      label: "Contribution margin per call-out",
      unit: "AUD/call-out",
      category: "revenue",
      distribution: { kind: "pert", min: 840, mode: 1540, max: 2520 },
      rationale:
        "Higher per-job margin than a factory job precisely because it prices in the remote/hours-away day-rate premium — fewer jobs per year at a materially higher margin each, not a favorable assumption stacked on top of high volume. Implied by day-rate field-service billing practices for remote heavy-equipment repair, in AUD.",
    },
    {
      id: "annualMaintenanceCost",
      label: "Annual truck/crane/tooling maintenance & service cost",
      unit: "AUD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 21000, mode: 39000, max: 63000 },
      rationale:
        "Machine-only cost: truck, crane, and tooling service contracts, parts, and consumables, roughly 6-9% of capex/yr for a heavier-duty fitted vehicle than the manufacturer persona's CNC line. Deliberately excludes operator labor — see the second-crew headcount decision's own rationale for why these two decisions can be run together without double-counting a shared mechanic's wage.",
    },
    {
      id: "salvageValuePct",
      label: "Resale value at end of horizon (% of original capex)",
      unit: "%",
      category: "capex",
      distribution: { kind: "triangular", min: 0.1, mode: 0.2, max: 0.35 },
      rationale: "Fitted mine-service trucks retain stronger resale value than general shop equipment given continued secondary-market demand, per dealer/auction listings.",
    },
    {
      id: "commissioningDelayMonths",
      label: "Procurement/fit-out delay before full call-out capacity",
      unit: "months",
      category: "cost",
      distribution: { kind: "pert", min: 2, mode: 5, max: 9 },
      rationale:
        "Longer than the manufacturer persona's CNC commissioning delay: chassis order, crane/welder/generator upfit, and DOT/site safety certification all have to clear before the truck is road- and site-ready — modeled as reducing year-1 output rather than assumed away.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const effectiveCallOuts = inputs.incrementalCallOutsPerYear * demandTilt;
    const steadyStateNet = effectiveCallOuts * inputs.contributionMarginPerCallOut - inputs.annualMaintenanceCost;
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

/** Decision B2: take on a multi-year mine-site logistics/parts-haulage contract. */
const logisticsContractDecision: Decision = {
  id: "mine-site-logistics-contract",
  label: "Take on a mine-site logistics & parts-haulage contract",
  description:
    "A multi-year contract hauling parts, equipment, and crews to a remote mine site. Margin is sensitive to fuel-cost volatility over the contract term, evaluated over 3 years.",
  horizonYears: 3,
  discountRate,
  drivers: [
    {
      id: "annualRevenue",
      label: "Contract annual revenue",
      unit: "AUD/yr",
      category: "revenue",
      distribution: { kind: "pert", min: 560000, mode: 1190000, max: 1960000 },
      rationale: "Scaled to a mid-size heavy-equipment service business's typical large mine-site account, in AUD; downside widened to reflect real volume/renewal risk over a multi-year single-site contract.",
    },
    {
      id: "grossMarginPct",
      label: "Gross margin",
      unit: "%",
      category: "revenue",
      distribution: { kind: "pert", min: 0.08, mode: 0.32, max: 0.45 },
      rationale: "30-45% typical trucking/logistics gross margin range; floor lowered to reflect the thin margin a haulier often accepts to win a large single-site contract, on top of fuel-price and renewal risk.",
    },
    {
      id: "fuelCostInflationPct",
      label: "Annual fuel-cost inflation",
      unit: "%/yr",
      category: "cost",
      distribution: { kind: "lognormal", median: 0.04, sigma: 0.8 },
      rationale: "Diesel/fuel cost inflation is right-skewed (occasional price shocks) and erodes haulage margin more directly than a general input-cost driver, given fuel's outsized share of logistics cost. Lognormal avoids a symmetric downside that doesn't exist in practice; sigma widened so the tail can represent a real diesel-price shock (comparable to 2022 fuel spikes), not just routine inflation.",
    },
    {
      id: "onboardingCost",
      label: "Site-access qualification & route setup cost",
      unit: "AUD",
      category: "capex",
      distribution: { kind: "pert", min: 49000, mode: 98000, max: 182000 },
      rationale: "Safety induction/certification for remote mine-site access, plus route and equipment prep, in AUD — higher than a factory-floor onboarding given mine-site safety and access requirements.",
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
      // Contract price is fixed, so inflation lands on the cost base alone: cost = (1 - margin) x revenue,
      // and after a year of inflation the margin is 1 - (1 - margin)(1 + i) = margin - (1 - margin) x i.
      margin = margin - (1 - margin) * inputs.fuelCostInflationPct;
    }
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

/** Decision B3: add a second remote-response mechanic crew ahead of demand. */
const crewDecision: Decision = {
  id: "second-remote-response-crew",
  label: "Add a second remote-response crew ahead of demand",
  description:
    "Hiring ahead of demand to run a second remote-response crew for mine-site call-outs. Evaluated over 2 years against uncertain demand ramp-up. This is the ONLY new labor cost modeled anywhere in this persona — the truck decision's maintenance cost is deliberately machine-only (see its rationale) precisely so the two decisions can be run together (see src/engine/sequence.ts) without double-counting a shared mechanic's wage.",
  horizonYears: 2,
  discountRate,
  drivers: [
    {
      id: "crewSize",
      label: "Additional crew size",
      unit: "workers",
      category: "cost",
      distribution: { kind: "triangular", min: 2, mode: 4, max: 6 },
      rationale: "Remote-response crew size, expert judgment bounded by realistic mobilization logistics for hours-away call-outs.",
    },
    {
      id: "annualWagePerWorker",
      label: "Annual wage per worker",
      unit: "AUD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 130000, mode: 160000, max: 200000 },
      rationale: "FIFO heavy diesel / mobile plant mechanic total package on a remote Australian mine site — trades roles on-site commonly run A$130k-A$200k+/yr depending on roster, site enterprise agreement, and penalty/loading rates for night and weekend swings.",
    },
    {
      id: "demandRampCallOutsPerYear",
      label: "Additional call-out demand captured per year",
      unit: "call-outs/yr",
      category: "revenue",
      distribution: { kind: "normal", mean: 260, stdDev: 90, min: 0 },
      rationale: "A second crew roughly doubles response capacity relative to the truck decision's own incremental-call-out driver (mean ~133/yr) — sized to real second-crew throughput, not an independent guess. Aggregated demand across many mine-site accounts — normal fits a CLT-driven aggregate variable, floored at zero since demand cannot be negative; the same basis as the manufacturer persona's demand-ramp driver.",
    },
    {
      id: "contributionMarginPerCallOut",
      label: "Contribution margin per call-out",
      unit: "AUD/call-out",
      category: "revenue",
      distribution: { kind: "pert", min: 630, mode: 1190, max: 1960 },
      rationale: "Same basis as the truck decision's margin driver, in AUD.",
    },
    {
      id: "hiringRampMonths",
      label: "Hiring/mobilization ramp before full crew output",
      unit: "months",
      category: "cost",
      distribution: { kind: "triangular", min: 2, mode: 4, max: 7 },
      rationale: "Longer than the manufacturer persona's second-shift ramp: recruiting and mobilizing a remote-response crew requires site inductions, certifications, and vehicle assignment before they're at full call-out capacity.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const laborCost = inputs.crewSize * inputs.annualWagePerWorker;
    const steadyStateRevenue = inputs.demandRampCallOutsPerYear * demandTilt * inputs.contributionMarginPerCallOut;
    const year1RampFraction = Math.max(0, 1 - inputs.hiringRampMonths / 12);
    const pretax: number[] = [0, steadyStateRevenue * year1RampFraction - laborCost, steadyStateRevenue - laborCost];
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

export const mineSiteServicesPersona: Persona = {
  id: "mine-site-services",
  name: "Heavy-machinery repair & mine-site logistics workshop",
  tagline: "Should we add a truck, take the haulage contract, or crew up first?",
  decisions: [truckDecision, logisticsContractDecision, crewDecision],
};

validatePersona(mineSiteServicesPersona);
