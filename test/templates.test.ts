import { test } from "node:test";
import assert from "node:assert/strict";
import { listTemplates, getTemplate, starterDriversForTemplate, hydrateDecision, UnknownTemplateError, PLACEHOLDER_RATIONALE_PREFIX } from "../src/personas/templates.ts";
import { manufacturerPersona } from "../src/personas/index.ts";
import { validatePersona } from "../src/engine/validation.ts";
import type { Persona } from "../src/engine/types.ts";

test("listTemplates/getTemplate expose the capex archetype", () => {
  const templates = listTemplates();
  assert.ok(templates.some((t) => t.id === "capex"));
  assert.ok(getTemplate("capex"));
  assert.equal(getTemplate("not-a-real-template"), undefined);
});

test("starterDriversForTemplate returns placeholder-flagged drivers for a known template", () => {
  const starters = starterDriversForTemplate("capex");
  assert.ok(starters);
  assert.ok(starters!.drivers.length > 0);
  assert.ok(starters!.drivers.every((d) => d.rationale.startsWith(PLACEHOLDER_RATIONALE_PREFIX)), "every starter driver's rationale should be an obvious, unfinished placeholder until the person replaces it");
  assert.equal(starterDriversForTemplate("not-a-real-template"), undefined);
});

test("hydrateDecision throws UnknownTemplateError (loudly) for an unrecognized templateId", () => {
  assert.throws(
    () =>
      hydrateDecision({
        id: "x",
        templateId: "not-a-real-template",
        label: "x",
        description: "x",
        horizonYears: 5,
        discountRate: { id: "discountRate", label: "d", unit: "%", category: "financing", distribution: { kind: "constant", value: 0.1 }, rationale: "r" },
        drivers: [],
      }),
    UnknownTemplateError,
  );
});

/**
 * The strongest possible proof that generalizing the manufacturer persona's
 * hand-written "second CNC machine" decision into a reusable template didn't
 * subtly change its behavior: hydrate the SAME driver values that decision
 * already uses through the new template's formula, and assert the result
 * matches the original, already-reviewed decision's own cashFlows exactly —
 * not approximately, bit for bit, across several macro-factor conditions.
 */
test("the capex template's cashFlows formula exactly reproduces the built-in CNC decision's own formula for the same inputs", () => {
  const original = manufacturerPersona.decisions.find((d) => d.id === "second-cnc-line");
  assert.ok(original, "this test assumes the manufacturer persona still has its second-cnc-line decision");

  const hydrated = hydrateDecision({
    id: "test-hydrated-capex",
    templateId: "capex",
    label: "test",
    description: "test",
    horizonYears: original!.horizonYears,
    discountRate: original!.discountRate,
    drivers: original!.drivers,
  });

  // The original decision's driver ids (capex, incrementalUnitsPerYear, ...)
  // differ from the template's generic ids (capex, unitsPerYear, ...), so the
  // same numeric sample set is fed to both under each formula's own naming.
  const sample = { capex: 275_000, incrementalUnitsPerYear: 7500, contributionMarginPerUnit: 15, annualMaintenanceCost: 16_000, salvageValuePct: 0.18, commissioningDelayMonths: 2.5, taxRate: 0.258 };
  const templateSample = {
    capex: sample.capex,
    unitsPerYear: sample.incrementalUnitsPerYear,
    marginPerUnit: sample.contributionMarginPerUnit,
    annualFixedCost: sample.annualMaintenanceCost,
    salvageValuePct: sample.salvageValuePct,
    rampDelayMonths: sample.commissioningDelayMonths,
    taxRate: sample.taxRate,
  };

  for (const macroFactor of [0, 1, -1.5]) {
    const originalResult = original!.cashFlows(sample, macroFactor);
    const templateResult = hydrated.cashFlows(templateSample, macroFactor);
    assert.deepEqual(templateResult, originalResult, `mismatch at macroFactor=${macroFactor}`);
  }
});

test("a decision hydrated from the capex template still passes the engine's own persona validation once real rationale replaces the placeholder", () => {
  const starters = starterDriversForTemplate("capex")!;
  const customized = {
    ...starters,
    drivers: starters.drivers.map((d) => ({ ...d, rationale: "A real, non-placeholder rationale for this test." })),
    discountRate: { ...starters.discountRate, rationale: "A real, non-placeholder rationale for this test." },
  };
  const decision = hydrateDecision({
    id: "test-custom-decision",
    templateId: "capex",
    label: "Test custom decision",
    description: "A decision built from the capex template for this test.",
    horizonYears: 5,
    discountRate: customized.discountRate,
    drivers: customized.drivers,
  });

  const fakePersona: Persona = { id: "test-custom-persona", name: "Test Persona", tagline: "test", decisions: [decision] };
  assert.doesNotThrow(() => validatePersona(fakePersona));
});
