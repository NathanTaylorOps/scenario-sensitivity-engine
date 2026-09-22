import { test } from "node:test";
import assert from "node:assert/strict";
import { compareDriverToBaseline, compareDecisionToBaseline } from "../src/engine/guardrails.ts";
import type { Decision, Driver } from "../src/engine/types.ts";

function driver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: "capex",
    label: "Capex",
    unit: "USD",
    category: "capex",
    distribution: { kind: "triangular", min: 100_000, mode: 150_000, max: 200_000 },
    rationale: "test",
    ...overrides,
  };
}

test("compareDriverToBaseline returns null when the edit is unremarkable", () => {
  const baseline = driver();
  const edited = driver({ distribution: { kind: "triangular", min: 105_000, mode: 150_000, max: 195_000 } });
  assert.equal(compareDriverToBaseline(edited, baseline), null);
});

test("compareDriverToBaseline flags a range with zero overlap with the sourced default", () => {
  const baseline = driver(); // 100k-200k
  const edited = driver({ distribution: { kind: "triangular", min: 500_000, mode: 550_000, max: 600_000 } });
  const warning = compareDriverToBaseline(edited, baseline);
  assert.ok(warning, "a completely non-overlapping range should be flagged");
  assert.match(warning!.message, /no longer overlaps/);
  assert.equal(warning!.driverId, "capex");
});

test("compareDriverToBaseline flags a range that overlaps but is much wider than the sourced default", () => {
  const baseline = driver(); // width 100,000
  const edited = driver({ distribution: { kind: "triangular", min: 50_000, mode: 150_000, max: 550_000 } }); // width 500,000, still overlaps
  const warning = compareDriverToBaseline(edited, baseline);
  assert.ok(warning, "a 5x-wider overlapping range should still be flagged");
  assert.match(warning!.message, /much wider/);
});

test("compareDriverToBaseline flags a range that's collapsed to near-constant compared to the sourced default", () => {
  const baseline = driver(); // width 100,000
  const edited = driver({ distribution: { kind: "constant", value: 150_000 } }); // width 0
  const warning = compareDriverToBaseline(edited, baseline);
  assert.ok(warning, "collapsing a sourced range to a single value should be flagged");
  assert.match(warning!.message, /much narrower/);
});

test("compareDriverToBaseline does not flag a driver whose baseline was already a single constant", () => {
  const baseline = driver({ distribution: { kind: "constant", value: 150_000 } });
  const edited = driver({ distribution: { kind: "constant", value: 150_000 } });
  assert.equal(compareDriverToBaseline(edited, baseline), null, "a zero-width baseline shouldn't divide-by-zero into a false positive");
});

function decisionWith(drivers: Driver[]): Decision {
  return {
    id: "test-decision",
    label: "Test decision",
    description: "test",
    drivers,
    horizonYears: 5,
    discountRate: driver({ id: "discountRate", unit: "%", category: "financing", distribution: { kind: "constant", value: 0.1 } }),
    cashFlows: () => [0],
  };
}

test("compareDecisionToBaseline collects warnings across multiple drivers", () => {
  const baseline = decisionWith([
    driver({ id: "capex" }),
    driver({ id: "margin", unit: "%", distribution: { kind: "triangular", min: 0.25, mode: 0.3, max: 0.4 } }),
  ]);
  const edited = decisionWith([
    driver({ id: "capex", distribution: { kind: "triangular", min: 500_000, mode: 550_000, max: 600_000 } }), // flagged: no overlap
    driver({ id: "margin", unit: "%", distribution: { kind: "triangular", min: 0.26, mode: 0.3, max: 0.39 } }), // unremarkable
  ]);
  const warnings = compareDecisionToBaseline(edited, baseline);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].driverId, "capex");
});

test("compareDecisionToBaseline skips a driver newly added by the person with nothing to compare against", () => {
  const baseline = decisionWith([driver({ id: "capex" })]);
  const edited = decisionWith([driver({ id: "capex" }), driver({ id: "newDriver", label: "New driver" })]);
  const warnings = compareDecisionToBaseline(edited, baseline);
  assert.deepEqual(warnings, [], "a driver the person added themselves has no baseline to compare against and must not crash or false-positive");
});
