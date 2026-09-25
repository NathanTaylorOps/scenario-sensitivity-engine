import type { Decision, Driver } from "../engine/types.ts";
import type { Distribution } from "../engine/distributions.ts";
import { afterTaxCashFlows } from "../engine/tax.ts";

/**
 * Decision-template library — the fixed set of cash-flow archetypes a
 * custom, browser-created decision can be built from.
 *
 * A `Decision.cashFlows` is a function, not data, so it can't be authored
 * from a browser form the way a driver's number or distribution can.
 * "Customizing" a decision here means picking one of these small, reviewed
 * formulas and editing the assumption DATA that feeds it — not writing a new
 * formula from scratch. That's a deliberate, stated scope line: a real
 * formula-authoring DSL is a different, much bigger project than a
 * portfolio-piece driver editor should take on.
 *
 * This module deliberately has ZERO dependency on src/web/* — templates are
 * pure engine content, same as src/personas/*.ts. The browser-storage layer
 * (src/web/storage.ts) stores a `templateId` plus driver data; this module
 * is what turns that data back into a runnable Decision.
 *
 * Only one archetype ("capex") is built out for the first vertical slice —
 * see docs/METHODOLOGY.md or the project's task list for the other four
 * planned archetypes (hiring, lease-vs-buy, bid/no-bid, new-contract).
 * Shipping one archetype fully proven, rather than five half-built ones, was
 * a deliberate call from the review pass before this was built.
 */

export interface DriverTemplate {
  id: string;
  label: string;
  unit: string;
  category: Driver["category"];
  defaultDistribution: Distribution;
  /** Deliberately NOT a real sourced rationale — it's placeholder guidance
   * text, prefixed so it's obviously unfinished in the UI until the person
   * replaces it with their own reasoning for their own numbers. */
  rationalePrompt: string;
}

export const PLACEHOLDER_RATIONALE_PREFIX = "REPLACE WITH YOUR OWN REASONING:";

export interface DecisionTemplate {
  id: string;
  name: string;
  descriptionPrompt: string;
  defaultHorizonYears: number;
  discountRateTemplate: DriverTemplate;
  driverTemplates: DriverTemplate[];
  /** Builds this archetype's cash-flow function for a specific horizon.
   * Horizon is baked in at build time (a Decision's own cashFlows only takes
   * (inputs, macroFactor)) rather than re-read from a captured object each
   * call, so a decision's horizon can't drift out of sync with the closure
   * that was built for it. */
  buildCashFlows: (horizonYears: number) => Decision["cashFlows"];
}

/** Same constant the built-in manufacturer/mine-site personas use for their
 * own demand-linked drivers — kept in sync deliberately so a custom capex
 * decision behaves consistently with the built-in ones in a portfolio run,
 * not a smaller or larger macro tilt just because it came from a template. */
const MACRO_DEMAND_SENSITIVITY = 0.15;

const capexTemplate: DecisionTemplate = {
  id: "capex",
  name: "Capital expenditure",
  descriptionPrompt: "Describe what's being bought and why, and over what period it's being evaluated.",
  defaultHorizonYears: 5,
  discountRateTemplate: {
    id: "discountRate",
    label: "Discount rate (hurdle rate)",
    unit: "%/yr",
    category: "financing",
    defaultDistribution: { kind: "pert", min: 0.08, mode: 0.12, max: 0.18 },
    rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} small-business hurdle rates commonly run 10-15% — adjust to your own cost of capital.`,
  },
  driverTemplates: [
    {
      id: "capex",
      label: "Capital expenditure",
      unit: "AUD",
      category: "capex",
      defaultDistribution: { kind: "pert", min: 50_000, mode: 100_000, max: 200_000 },
      rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} where did this range come from — a quote, a dealer listing, a rough estimate?`,
    },
    {
      id: "unitsPerYear",
      label: "Incremental units/output per year",
      unit: "units/yr",
      category: "revenue",
      defaultDistribution: { kind: "triangular", min: 1000, mode: 2000, max: 4000 },
      rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} how confident are you in this volume, and why?`,
    },
    {
      id: "marginPerUnit",
      label: "Net margin per unit",
      unit: "AUD/unit",
      category: "revenue",
      defaultDistribution: { kind: "pert", min: 5, mode: 10, max: 20 },
      rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} what's this margin based on — your own pricing/cost data?`,
    },
    {
      id: "annualFixedCost",
      label: "Annual added fixed cost (maintenance, service, etc.)",
      unit: "AUD/yr",
      category: "cost",
      defaultDistribution: { kind: "pert", min: 2000, mode: 5000, max: 10_000 },
      rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} service contracts, consumables, anything recurring this adds.`,
    },
    {
      id: "salvageValuePct",
      label: "Resale/salvage value at end of horizon (% of capex)",
      unit: "%",
      category: "capex",
      defaultDistribution: { kind: "triangular", min: 0.05, mode: 0.15, max: 0.3 },
      rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} secondary-market value for this kind of asset after the horizon.`,
    },
    {
      id: "rampDelayMonths",
      label: "Ramp-up delay before full output",
      unit: "months",
      category: "cost",
      defaultDistribution: { kind: "pert", min: 0, mode: 2, max: 6 },
      rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} installation, training, or commissioning time before this runs at full rate.`,
    },
    {
      id: "taxRate",
      label: "Effective combined tax rate",
      unit: "%",
      category: "financing",
      defaultDistribution: { kind: "pert", min: 0.21, mode: 0.26, max: 0.3 },
      rationalePrompt: `${PLACEHOLDER_RATIONALE_PREFIX} your own effective combined tax rate, as a range not a fixed figure.`,
    },
  ],
  buildCashFlows(horizonYears: number) {
    return (inputs: Record<string, number>, macroFactor = 0) => {
      const demandTilt = 1 + MACRO_DEMAND_SENSITIVITY * macroFactor;
      const effectiveUnits = inputs.unitsPerYear * demandTilt;
      const steadyStateNet = effectiveUnits * inputs.marginPerUnit - inputs.annualFixedCost;
      const year1RampFraction = Math.max(0, 1 - inputs.rampDelayMonths / 12);
      const pretax: number[] = [-inputs.capex, steadyStateNet * year1RampFraction];
      for (let year = 2; year <= horizonYears; year++) pretax.push(steadyStateNet);
      return afterTaxCashFlows(pretax, {
        capex: inputs.capex,
        usefulLifeYears: horizonYears,
        taxRate: inputs.taxRate,
        salvageValue: inputs.capex * inputs.salvageValuePct,
      });
    };
  },
};

const TEMPLATE_REGISTRY: Record<string, DecisionTemplate> = {
  capex: capexTemplate,
};

export function listTemplates(): DecisionTemplate[] {
  return Object.values(TEMPLATE_REGISTRY);
}

export function getTemplate(templateId: string): DecisionTemplate | undefined {
  return TEMPLATE_REGISTRY[templateId];
}

function driverFromTemplate(t: DriverTemplate): Driver {
  return { id: t.id, label: t.label, unit: t.unit, category: t.category, distribution: t.defaultDistribution, rationale: t.rationalePrompt };
}

/** Produces a fresh set of starter drivers (with placeholder rationale text
 * and default distributions) for a new decision built from this template —
 * the "start from a template" path in the editor. */
export function starterDriversForTemplate(templateId: string): { discountRate: Driver; drivers: Driver[] } | undefined {
  const template = TEMPLATE_REGISTRY[templateId];
  if (!template) return undefined;
  return {
    discountRate: driverFromTemplate(template.discountRateTemplate),
    drivers: template.driverTemplates.map(driverFromTemplate),
  };
}

/** The minimal structural shape a stored custom decision must have to be
 * hydrated back into a runnable Decision — deliberately duck-typed rather
 * than importing StoredCustomDecision from src/web/storage.ts, so this
 * engine-adjacent module has no dependency on the browser-storage layer. */
export interface HydratableDecision {
  id: string;
  templateId: string;
  label: string;
  description: string;
  horizonYears: number;
  discountRate: Driver;
  drivers: Driver[];
}

export class UnknownTemplateError extends Error {
  constructor(templateId: string) {
    super(`Unknown decision template id "${templateId}" — this decision was likely saved by a newer version of the app.`);
    this.name = "UnknownTemplateError";
  }
}

/** Turns stored driver data plus a templateId back into a runnable Decision
 * by attaching the matching archetype's cashFlows formula. Throws
 * UnknownTemplateError (loudly, not a silent no-op) if the templateId isn't
 * one this build of the app knows — the same "fail loud" principle as the
 * rest of this codebase's validation, applied to forward-compatibility. */
export function hydrateDecision(input: HydratableDecision): Decision {
  const template = TEMPLATE_REGISTRY[input.templateId];
  if (!template) throw new UnknownTemplateError(input.templateId);
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    horizonYears: input.horizonYears,
    discountRate: input.discountRate,
    drivers: input.drivers,
    cashFlows: template.buildCashFlows(input.horizonYears),
  };
}
