import type { Persona, Driver, Decision } from "../engine/types.ts";
import { afterTaxCashFlows } from "../engine/tax.ts";
import { validatePersona } from "../engine/validation.ts";

/**
 * Persona D: an independent software/IT consultancy delivering client
 * engagements and retainers. Same shared engine as the other three personas
 * (src/personas/manufacturer.ts, src/personas/mineSiteServices.ts,
 * src/personas/shortStayAccommodation.ts) — a knowledge-work business with
 * near-zero physical capex, deliberately included so a portfolio visitor
 * sees the engine isn't just a capex/equipment calculator.
 *
 * Figures grounded where a clean Australian data point exists (see
 * docs/BENCHMARKS.md); the platform-build cost and billable-rate margin
 * figures are reasoned estimates built from typical small-team software
 * build budgets and consulting industry margin norms, stated as such rather
 * than presented as more precise than they are. Dollar figures are in AUD.
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
 * Enterprise IT/software spend is deferred, not usually cancelled outright,
 * in a downturn — client budgets tighten but multi-year retainers are
 * sticky compared to discretionary capex. Set below the manufacturer
 * persona's 0.15 for that reason, a stated design choice rather than a
 * sourced statistic.
 */
const MACRO_DEMAND_SENSITIVITY = 0.12;

const discountRate: Driver = {
  id: "discountRate",
  label: "Discount rate (hurdle rate)",
  unit: "%/yr",
  category: "financing",
  distribution: { kind: "pert", min: 0.1, mode: 0.15, max: 0.22 },
  rationale:
    "Higher than the manufacturer persona's 8-18%: a services business has no hard asset to secure debt against, and revenue concentration in a handful of client relationships carries more downside risk per dollar of hurdle rate than an asset-backed capex decision.",
};

/** Decision D1: build a new managed-service/tooling platform. */
const platformDecision: Decision = {
  id: "new-managed-service-platform",
  label: "Build a new managed-service tooling platform",
  description:
    "Invests in an internal platform (automation, monitoring, client-facing tooling) to sell a new recurring managed-service line rather than one-off project work. Evaluated as a 5-year investment against incremental billable capacity the platform unlocks.",
  horizonYears: 5,
  discountRate,
  drivers: [
    {
      id: "capex",
      label: "Platform build cost (dev time, licensing, infrastructure)",
      unit: "AUD",
      category: "capex",
      distribution: { kind: "pert", min: 110000, mode: 180000, max: 320000 },
      rationale:
        "Reasoned estimate: a small internal team's fully-loaded build cost (2-4 engineers over 3-6 months) plus first-year licensing/infrastructure for a monitoring/automation platform, in AUD — not tied to one vendor quote, since scope varies, but the order of magnitude matches typical small-team platform builds.",
    },
    {
      id: "incrementalBillableHoursPerYear",
      label: "Incremental billable hours enabled per year",
      unit: "hours/yr",
      category: "revenue",
      distribution: { kind: "triangular", min: 700, mode: 1200, max: 2000 },
      rationale: "Additional managed-service capacity the platform lets the team sell without proportional headcount growth is judgment-based (no historical data for a platform not yet built) — triangular fits an expert three-point estimate.",
    },
    {
      id: "contributionMarginPerHour",
      label: "Contribution margin per billed hour",
      unit: "AUD/hour",
      category: "revenue",
      distribution: { kind: "pert", min: 45, mode: 70, max: 110 },
      rationale: "Implied by typical Australian managed-service/consulting billable-rate margins after direct delivery cost — a reasoned estimate against industry billable-rate benchmarks, not a round figure.",
    },
    {
      id: "annualMaintenanceCost",
      label: "Annual platform hosting, licensing & upkeep cost",
      unit: "AUD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 10000, mode: 19000, max: 30000 },
      rationale:
        "Platform-only cost: cloud hosting, third-party licensing, and minor upkeep — roughly 6-10% of build cost/yr, a common SaaS-style ongoing-cost rule of thumb. Deliberately excludes delivery-engineer labor — that's the second-delivery-team decision's own new headcount cost, kept separate for the same reason the other personas' equipment-maintenance costs exclude operator labor (see those decisions' rationale): so the two decisions can be run together without double-counting a shared engineer's wage.",
    },
    {
      id: "salvageValuePct",
      label: "Residual value at end of horizon (% of original build cost)",
      unit: "%",
      category: "capex",
      distribution: { kind: "triangular", min: 0, mode: 0.05, max: 0.15 },
      rationale: "Software platforms have little to no resale value — unlike physical equipment, the model captures this as a small residual reflecting any component code/IP that could be repurposed or sold, not a real secondary market.",
    },
    {
      id: "commissioningDelayMonths",
      label: "Build/rollout delay before full billable capacity",
      unit: "months",
      category: "cost",
      distribution: { kind: "pert", min: 2, mode: 4, max: 7 },
      rationale:
        "Time from project kickoff to a platform stable enough to sell as a client-facing managed service — modeled as reducing year-1 billable hours rather than assumed away, the same treatment as the other personas' commissioning delays.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const effectiveHours = inputs.incrementalBillableHoursPerYear * demandTilt;
    const steadyStateNet = effectiveHours * inputs.contributionMarginPerHour - inputs.annualMaintenanceCost;
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

/** Decision D2: take on a multi-year enterprise retainer contract. */
const retainerContractDecision: Decision = {
  id: "enterprise-retainer-contract",
  label: "Take on a multi-year enterprise retainer contract",
  description:
    "A multi-year support/delivery retainer with a large enterprise client. Margin is sensitive to senior-engineer contractor-rate inflation over the contract term, evaluated over 3 years.",
  horizonYears: 3,
  discountRate,
  drivers: [
    {
      id: "annualRevenue",
      label: "Contract annual revenue",
      unit: "AUD/yr",
      category: "revenue",
      distribution: { kind: "pert", min: 170000, mode: 700000, max: 1150000 },
      rationale: "Scaled to a small consultancy's typical single-enterprise-account retainer size in AUD; downside widened well below the mode to reflect real scope-cut/renewal risk over a multi-year single-client contract — an enterprise client trimming its retainer scope mid-term is a real, not remote, possibility.",
    },
    {
      id: "grossMarginPct",
      label: "Gross margin",
      unit: "%",
      category: "revenue",
      distribution: { kind: "pert", min: 0.0, mode: 0.34, max: 0.48 },
      rationale: "25-45% typical IT-services/consulting gross margin range; floor lowered well below that to reflect the discounted rate a consultancy often accepts to win a large single-client retainer over ad hoc project billing, plus real scope-cut risk mid-contract.",
    },
    {
      id: "contractorRateInflationPct",
      label: "Annual senior-contractor rate inflation",
      unit: "%/yr",
      category: "cost",
      distribution: { kind: "lognormal", median: 0.04, sigma: 0.65 },
      rationale: "Senior engineer/contractor day-rate inflation is right-skewed (a tight talent market produces occasional sharp rate jumps, not smooth symmetric drift) — lognormal avoids a symmetric downside that doesn't exist in practice; sigma sized to allow a real skills-shortage rate spike, not just routine inflation.",
    },
    {
      id: "onboardingCost",
      label: "One-time transition & knowledge-transfer cost",
      unit: "AUD",
      category: "capex",
      distribution: { kind: "pert", min: 18000, mode: 40000, max: 78000 },
      rationale: "Client environment onboarding, security/compliance review, and knowledge-transfer time before billable delivery starts, in AUD, expert three-point estimate.",
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
      margin = margin - (1 - margin) * inputs.contractorRateInflationPct;
    }
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

/** Decision D3: hire a second delivery team ahead of pipeline. */
const deliveryTeamDecision: Decision = {
  id: "second-delivery-team",
  label: "Hire a second delivery team ahead of pipeline",
  description:
    "Hiring ahead of sales pipeline to stand up a second delivery team. Evaluated over 2 years against uncertain pipeline conversion. This is the ONLY new labor cost modeled anywhere in this persona — the platform decision's upkeep cost is deliberately platform-only (see its rationale) precisely so the two decisions can be run together without double-counting a shared engineer's wage.",
  horizonYears: 2,
  discountRate,
  drivers: [
    {
      id: "headcount",
      label: "Additional delivery-team headcount",
      unit: "workers",
      category: "cost",
      distribution: { kind: "triangular", min: 2, mode: 3, max: 5 },
      rationale: "Second delivery-team size, expert judgment bounded by realistic hiring capacity for a small consultancy in one year.",
    },
    {
      id: "annualWagePerWorker",
      label: "Annual wage per worker",
      unit: "AUD/yr",
      category: "cost",
      distribution: { kind: "pert", min: 74240, mode: 107020, max: 154273 },
      rationale: "Australian software developer/engineer wage range, per [Indeed](https://au.indeed.com/career/software-developer/salaries) (average A$107,020/yr, typical range A$74,240-A$154,273/yr) — independently sourced Australian wage data, not an FX conversion.",
    },
    {
      id: "demandRampBillableHoursPerYear",
      label: "Additional billable hours captured per year",
      unit: "hours/yr",
      category: "revenue",
      distribution: { kind: "normal", mean: 4200, stdDev: 1300, min: 0 },
      rationale: "A second delivery team roughly doubles sellable delivery capacity relative to the platform decision's own incremental-hours driver — aggregated demand across many client engagements, so normal fits a CLT-driven aggregate variable, floored at zero since demand cannot be negative; the same basis as the other personas' demand-ramp drivers.",
    },
    {
      id: "contributionMarginPerHour",
      label: "Contribution margin per billed hour",
      unit: "AUD/hour",
      category: "revenue",
      distribution: { kind: "pert", min: 55, mode: 90, max: 140 },
      rationale: "Same basis as the platform decision's margin driver.",
    },
    {
      id: "hiringRampMonths",
      label: "Hiring/onboarding ramp before full billable output",
      unit: "months",
      category: "cost",
      distribution: { kind: "triangular", min: 1, mode: 3, max: 5 },
      rationale:
        "Time to recruit and onboard a second delivery team to full billable utilization — wages are paid in full during this period, but utilization ramps gradually as engineers land on client work. Modeled as reducing year-1 billable hours rather than assumed instantaneous, for the same reason as the other personas' ramp drivers.",
    },
    taxRateDriver(),
  ],
  cashFlows(inputs, macroFactor = 0) {
    const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
    const laborCost = inputs.headcount * inputs.annualWagePerWorker;
    const steadyStateRevenue = inputs.demandRampBillableHoursPerYear * demandTilt * inputs.contributionMarginPerHour;
    const year1RampFraction = Math.max(0, 1 - inputs.hiringRampMonths / 12);
    const pretax: number[] = [0, steadyStateRevenue * year1RampFraction - laborCost, steadyStateRevenue - laborCost];
    return afterTaxCashFlows(pretax, { capex: 0, usefulLifeYears: 0, taxRate: inputs.taxRate });
  },
};

export const softwareConsultancyPersona: Persona = {
  id: "software-consultancy",
  name: "Independent software & IT consultancy",
  tagline: "Should we build the new service line, take the enterprise retainer, or hire delivery engineers ahead of pipeline?",
  decisions: [platformDecision, retainerContractDecision, deliveryTeamDecision],
};

validatePersona(softwareConsultancyPersona);
