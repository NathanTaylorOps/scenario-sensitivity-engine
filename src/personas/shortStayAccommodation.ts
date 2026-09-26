import type { Persona, Driver, Decision } from "../engine/types.ts";
import { afterTaxCashFlows } from "../engine/tax.ts";
import { validatePersona } from "../engine/validation.ts";

/**
 * Persona C: a boutique short-stay accommodation operator (a handful of
 * managed holiday-let / serviced-apartment properties in a regional tourist
 * or FIFO-adjacent market). Same shared engine as the manufacturer and
 * mine-site-services personas (src/personas/manufacturer.ts,
 * src/personas/mineSiteServices.ts) — swapping personas swaps this config
 * file, not the simulation code.
 *
 * Figures grounded where a clean Australian data point exists (see
 * docs/BENCHMARKS.md); the property purchase-plus-fit-out and per-night
 * margin figures are reasoned estimates built from typical regional
 * Australian established-house prices and short-stay industry margin norms,
 * stated as such rather than presented as more precise than they are.
 * Dollar figures are in AUD.
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
 * Short-stay/tourism demand is directly exposed to discretionary-travel
 * cycles — more so than general manufacturing, less abruptly than a
 * single-commodity mine-site service business that lives or dies on one
 * sector's capex cycle. Set between the manufacturer persona's 0.15 and the
 * mine-site-services persona's 0.25 for that reason, a stated design choice
 * rather than a sourced statistic.
 */
const MACRO_DEMAND_SENSITIVITY = 0.2;

const discountRate: Driver = {
  id: "discountRate",
  label: "Discount rate (hurdle rate)",
  unit: "%/yr",
  category: "financing",
  distribution: { kind: "pert", min: 0.07, mode: 0.1, max: 0.16 },
  rationale:
    "Lower than the manufacturer persona's 8-18%: a physical, insurable, resaleable property is a lower-risk asset to underwrite a hurdle rate against than general small-business capex, even before the separate debt-financing view below adds real leverage. Still above a pure risk-free/mortgage rate to price in operating risk (occupancy shortfall, corporate-client concentration).",
};

/** Decision C1: buy and fit out a second short-stay property. */
const capexDecision: Decision = {
  id: "second-short-stay-property",
  label: "Buy and fit out a second short-stay property",
  description:
    "Adds a second managed property to the portfolio. Evaluated as a 5-year capex investment (purchase plus furnishing/fit-out) against incremental booked-night income, net of the extra property's own running costs.",
  horizonYears: 5,
  discountRate,
  drivers: [
    {
      id: "capex",
      label: "Property purchase + furnishing/fit-out capex",
      unit: "AUD",
      category: "capex",
      distribution: { kind: "pert", min: 400000, mode: 470000, max: 650000 },
      rationale:
        "Reasoned estimate: a typical established house price in a regional Australian tourist or FIFO-adjacent market, plus a A$30K-A$80K furnishing/short-stay fit-out budget — not tied to one listing, since the exact figure is market-specific, but the order of magnitude is a real regional-property-plus-fitout budget, not a round guess.",
    },
    {
      id: "incrementalBookedNightsPerYear",
      label: "Incremental booked nights per year",
      unit: "nights/yr",
      category: "revenue",
      distribution: { kind: "triangular", min: 220, mode: 290, max: 340 },
      rationale:
        "60-93% occupancy on a 365-night year, the realistic band for a well-managed regional short-stay property in a strong tourist market once past its first ramp year — triangular fits an expert three-point estimate with no in-house historical data for a property not yet bought.",
    },
    {
      id: "contributionMarginPerNight",
      label: "Contribution margin per booked night",
      unit: "AUD/night",
      category: "revenue",
      distribution: { kind: "pert", min: 100, mode: 190, max: 260 },
      rationale:
        "Nightly rate net of platform commission, cleaning-consumables and utilities-per-stay, before the property's own fixed running costs (modeled separately below) — a reasoned estimate against typical regional short-stay nightly rates and the ~60-70% of rate that survives as contribution margin after variable per-stay costs.",
    },
    {
      id: "annualMaintenanceCost",
      label: "Annual property running cost (rates, insurance, platform/listing fees)",
      unit: "AUD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 10000, mode: 16000, max: 26000 },
      rationale:
        "Property-only fixed running cost: council rates, landlord/short-stay insurance, and platform/channel-manager subscription fees. Deliberately excludes turnover/cleaning LABOR — that's the second-turnover-team decision's own new headcount cost, kept separate for the same reason the manufacturer persona's maintenance cost excludes operator labor (see that decision's rationale): so the two decisions can be run together without double-counting a shared cleaner's wage.",
    },
    {
      id: "salvageValuePct",
      label: "Resale value at end of horizon (% of original purchase + fit-out cost)",
      unit: "%",
      category: "capex",
      distribution: { kind: "triangular", min: 0.95, mode: 1.12, max: 1.35 },
      rationale:
        "Unlike depreciating equipment, a well-located Australian property typically holds or gains value over a 5-year horizon even after the furnishing/fit-out component wears — modeled with a mode slightly above 100% of original cost (a conservative ~1%/yr real gain) and a wider upside than downside, reflecting real-estate appreciation rather than equipment depreciation. Even so, an all-cash property purchase evaluated against this persona's double-digit hurdle rate is a genuinely marginal case on operating income alone, not a stacked-favorable assumption set — the same treatment the other personas' decisions get.",
    },
    {
      id: "commissioningDelayMonths",
      label: "Renovation/listing setup delay before full occupancy",
      unit: "months",
      category: "cost",
      distribution: { kind: "pert", min: 1, mode: 2, max: 3 },
      rationale:
        "Time from settlement to a fully furnished, photographed, and listed property earning at its steady-state occupancy rate — modeled as reducing year-1 booked nights rather than assumed away, the same treatment as the other two personas' commissioning delays.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const effectiveNights = inputs.incrementalBookedNightsPerYear * demandTilt;
    const steadyStateNet = effectiveNights * inputs.contributionMarginPerNight - inputs.annualMaintenanceCost;
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

/** Decision C2: take on a corporate block-booking contract. */
const corporateContractDecision: Decision = {
  id: "corporate-block-booking-contract",
  label: "Take on a corporate block-booking contract",
  description:
    "A multi-year contract block-booking rooms for a corporate client (e.g. a resources or construction employer housing rotating crews). Margin is sensitive to utility-cost volatility over the contract term, evaluated over 3 years.",
  horizonYears: 3,
  discountRate,
  drivers: [
    {
      id: "annualRevenue",
      label: "Contract annual revenue",
      unit: "AUD/yr",
      category: "revenue",
      distribution: { kind: "pert", min: 150000, mode: 620000, max: 980000 },
      rationale: "Scaled to a mid-size operator's typical single-corporate-account block-booking size in AUD; downside widened well below the mode to reflect real volume/renewal risk over a multi-year single-client contract — a rotation cut or early contract exit is a real, not remote, possibility for a single-client block booking.",
    },
    {
      id: "grossMarginPct",
      label: "Gross margin",
      unit: "%",
      category: "revenue",
      distribution: { kind: "pert", min: 0.0, mode: 0.32, max: 0.42 },
      rationale: "20-40% typical short-stay/serviced-accommodation gross margin range; floor lowered well below that to reflect the discounted nightly rate an operator often accepts for guaranteed block-booking volume over ad hoc bookings, plus real occupancy-shortfall risk if the corporate client's rotation shrinks.",
    },
    {
      id: "utilityCostInflationPct",
      label: "Annual utility & consumables cost inflation",
      unit: "%/yr",
      category: "cost",
      distribution: { kind: "lognormal", median: 0.035, sigma: 0.7 },
      rationale: "Electricity and consumables cost inflation is right-skewed (occasional energy-price shocks) — lognormal avoids a symmetric downside that doesn't exist in practice; sigma sized to allow a real energy-price shock comparable to 2022-2023 Australian electricity price spikes, not just routine inflation.",
    },
    {
      id: "onboardingCost",
      label: "One-time compliance & corporate-client setup cost",
      unit: "AUD",
      category: "capex",
      distribution: { kind: "pert", min: 12000, mode: 28000, max: 55000 },
      rationale: "Corporate-account compliance (work-health-and-safety induction packs, billing-system integration, any additional furnishing standard the client requires), in AUD, expert three-point estimate.",
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
      margin = margin - (1 - margin) * inputs.utilityCostInflationPct;
    }
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

/** Decision C3: add a second housekeeping/turnover team ahead of portfolio growth. */
const turnoverTeamDecision: Decision = {
  id: "second-turnover-team",
  label: "Add a second turnover/housekeeping team ahead of portfolio growth",
  description:
    "Hiring ahead of growth to run a second cleaning/turnover team across the property portfolio. Evaluated over 2 years against uncertain booking-demand ramp-up. This is the ONLY new labor cost modeled anywhere in this persona — the property decision's running cost is deliberately property-only (see its rationale) precisely so the two decisions can be run together without double-counting a shared cleaner's wage.",
  horizonYears: 2,
  discountRate,
  drivers: [
    {
      id: "headcount",
      label: "Additional turnover-team headcount",
      unit: "workers",
      category: "cost",
      distribution: { kind: "triangular", min: 2, mode: 3, max: 5 },
      rationale: "Second turnover-team crew size, expert judgment bounded by realistic same-day changeover capacity across a small property portfolio.",
    },
    {
      id: "annualWagePerWorker",
      label: "Annual wage per worker",
      unit: "AUD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 52880, mode: 74205, max: 116654 },
      rationale: "Australian housekeeping supervisor wage range, per [Indeed](https://au.indeed.com/career/housekeeping-supervisor/salaries) (average A$74,205/yr, typical range A$52,880-A$116,654/yr) — independently sourced Australian wage data, not an FX conversion.",
    },
    {
      id: "demandRampNightsPerYear",
      label: "Additional booked nights captured per year (across the portfolio)",
      unit: "nights/yr",
      category: "revenue",
      distribution: { kind: "normal", mean: 1450, stdDev: 480, min: 0 },
      rationale: "A second turnover team lets the whole portfolio (not just the single property in the capex decision above) accept same-day-changeover bookings it previously had to decline — aggregated demand across many bookings on many properties, so normal fits a CLT-driven aggregate variable, floored at zero since demand cannot be negative; the same basis as the manufacturer and mine-site-services personas' demand-ramp drivers. Scaled well above one property's own booked-night range for that reason.",
    },
    {
      id: "contributionMarginPerNight",
      label: "Contribution margin per booked night",
      unit: "AUD/night",
      category: "revenue",
      distribution: { kind: "pert", min: 100, mode: 180, max: 260 },
      rationale: "Same basis as the property decision's margin driver.",
    },
    {
      id: "hiringRampMonths",
      label: "Hiring/training ramp before full turnover capacity",
      unit: "months",
      category: "cost",
      distribution: { kind: "triangular", min: 1, mode: 2, max: 3 },
      rationale:
        "Time to recruit and train a second turnover team to full same-day-changeover reliability — wages are paid in full during this period, but the extra booking capacity isn't yet usable. Modeled as reducing year-1 demand captured rather than assumed instantaneous, for the same reason as the other personas' ramp drivers.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const laborCost = inputs.headcount * inputs.annualWagePerWorker;
    const steadyStateRevenue = inputs.demandRampNightsPerYear * demandTilt * inputs.contributionMarginPerNight;
    const year1RampFraction = Math.max(0, 1 - inputs.hiringRampMonths / 12);
    const pretax: number[] = [0, steadyStateRevenue * year1RampFraction - laborCost, steadyStateRevenue - laborCost];
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

export const shortStayAccommodationPersona: Persona = {
  id: "short-stay-accommodation",
  name: "Boutique short-stay accommodation operator",
  tagline: "Should we buy the next property, take the corporate block-booking contract, or staff up the turnover team first?",
  decisions: [capexDecision, corporateContractDecision, turnoverTeamDecision],
};

validatePersona(shortStayAccommodationPersona);
