import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateId,
  hasPrefix,
  isStorageAvailable,
  loadCustomPersonas,
  saveCustomPersonas,
  upsertCustomPersona,
  deleteCustomPersona,
  loadScenarios,
  saveScenarioRecord,
  deleteScenario,
  exportScenarioToJson,
  importScenarioFromJson,
  loadDriverOverride,
  saveDriverOverride,
  clearDriverOverride,
  SCHEMA_VERSION,
  CUSTOM_PERSONA_PREFIX,
  SCENARIO_PREFIX,
  type StoredCustomPersona,
  type StoredScenario,
} from "../src/web/storage.ts";
import type { Driver } from "../src/engine/types.ts";

/**
 * Node has no built-in `localStorage`, so these tests provide a minimal
 * in-memory stand-in — this exercises exactly the same code path a real
 * browser would, since storage.ts only ever calls the standard
 * getItem/setItem/removeItem methods.
 */
class FakeStorage {
  private map = new Map<string, string>();
  private throwOnWrite = false;

  setThrowOnWrite(value: boolean): void {
    this.throwOnWrite = value;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error("simulated storage failure");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const fakeStorage = new FakeStorage();
(globalThis as unknown as { localStorage: FakeStorage }).localStorage = fakeStorage;

beforeEach(() => {
  fakeStorage.clear();
  fakeStorage.setThrowOnWrite(false);
});

test("generateId produces namespaced, unique ids", () => {
  const a = generateId(CUSTOM_PERSONA_PREFIX);
  const b = generateId(CUSTOM_PERSONA_PREFIX);
  assert.ok(hasPrefix(a, CUSTOM_PERSONA_PREFIX));
  assert.ok(hasPrefix(b, CUSTOM_PERSONA_PREFIX));
  assert.notEqual(a, b, "two generated ids should not collide");
  assert.equal(hasPrefix(a, "scenario"), false, "an id namespaced for one kind must not match another kind's prefix check");
});

test("isStorageAvailable reflects whether localStorage actually accepts writes", () => {
  assert.equal(isStorageAvailable(), true);
  fakeStorage.setThrowOnWrite(true);
  assert.equal(isStorageAvailable(), false);
});

function samplePersona(): StoredCustomPersona {
  return {
    id: generateId(CUSTOM_PERSONA_PREFIX),
    name: "Test Persona",
    tagline: "A persona created for a test",
    decisions: [
      {
        id: generateId("custom-decision"),
        templateId: "capex",
        label: "Buy a widget press",
        description: "test decision",
        horizonYears: 5,
        discountRate: { id: "discountRate", label: "Discount rate", unit: "%", category: "financing", distribution: { kind: "constant", value: 0.1 }, rationale: "test" },
        drivers: [],
      },
    ],
  };
}

test("custom personas round-trip through save/load, and upsert both creates and updates", () => {
  assert.deepEqual(loadCustomPersonas(), []);

  const persona = samplePersona();
  assert.equal(upsertCustomPersona(persona), true);
  assert.deepEqual(loadCustomPersonas(), [persona]);

  const renamed = { ...persona, name: "Renamed Persona" };
  assert.equal(upsertCustomPersona(renamed), true);
  const all = loadCustomPersonas();
  assert.equal(all.length, 1, "upserting an existing id should replace, not duplicate");
  assert.equal(all[0].name, "Renamed Persona");
});

test("deleteCustomPersona removes only the targeted persona", () => {
  const a = samplePersona();
  const b = samplePersona();
  saveCustomPersonas([a, b]);
  deleteCustomPersona(a.id);
  const remaining = loadCustomPersonas();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, b.id);
});

test("corrupted storage content falls back to an empty list instead of throwing", () => {
  fakeStorage.setItem("sse.customPersonas", "{ this is not valid JSON");
  assert.deepEqual(loadCustomPersonas(), []);

  fakeStorage.setItem("sse.customPersonas", JSON.stringify({ not: "an array" }));
  assert.deepEqual(loadCustomPersonas(), []);
});

function sampleScenario(): StoredScenario {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: generateId(SCENARIO_PREFIX),
    name: "Test scenario",
    savedAt: new Date().toISOString(),
    personaId: "manufacturer",
    decisionId: "second-cnc-machine",
    inputs: { loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: 7 },
    warnings: [],
  };
}

test("scenarios round-trip through save/load/delete", () => {
  const scenario = sampleScenario();
  saveScenarioRecord(scenario);
  assert.deepEqual(loadScenarios(), [scenario]);

  deleteScenario(scenario.id);
  assert.deepEqual(loadScenarios(), []);
});

test("exporting then importing a scenario preserves its content but assigns a fresh id", () => {
  const scenario = sampleScenario();
  const json = exportScenarioToJson(scenario);
  const result = importScenarioFromJson(json);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scenario.name, scenario.name);
  assert.equal(result.scenario.personaId, scenario.personaId);
  assert.equal(result.scenario.decisionId, scenario.decisionId);
  assert.deepEqual(result.scenario.inputs, scenario.inputs);
  assert.notEqual(
    result.scenario.id,
    scenario.id,
    "importing must always assign a fresh id, so importing the same file twice (or a file whose id happens to match a local one) can never silently overwrite an existing saved scenario",
  );
});

test("exporting then importing a scenario carries its driver override through intact", () => {
  const scenario: StoredScenario = { ...sampleScenario(), driverOverride: { drivers: [sampleDriver()], warnings: ["a warning"], savedAt: new Date().toISOString() } };
  const result = importScenarioFromJson(exportScenarioToJson(scenario));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.scenario.driverOverride, "the driver override should survive the export/import round trip");
  assert.equal(result.scenario.driverOverride!.drivers[0].id, "capex");
  assert.deepEqual(result.scenario.driverOverride!.warnings, ["a warning"]);
});

test("importScenarioFromJson rejects invalid JSON without throwing", () => {
  const result = importScenarioFromJson("{ not valid json");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /valid JSON/);
});

test("importScenarioFromJson rejects a file with no schemaVersion", () => {
  const result = importScenarioFromJson(JSON.stringify({ personaId: "x", decisionId: "y" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /schemaVersion/);
});

test("importScenarioFromJson rejects a file from a newer, unsupported schema version", () => {
  const future = { ...sampleScenario(), schemaVersion: SCHEMA_VERSION + 1 };
  const result = importScenarioFromJson(JSON.stringify(future));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /newer version/);
});

test("importScenarioFromJson rejects a file missing its persona or decision reference", () => {
  const result = importScenarioFromJson(JSON.stringify({ schemaVersion: SCHEMA_VERSION, name: "broken" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /persona or decision/);
});

function sampleDriver(overrides: Partial<Driver> = {}): Driver {
  return { id: "capex", label: "Capex", unit: "USD", category: "capex", distribution: { kind: "constant", value: 100_000 }, rationale: "test", ...overrides };
}

test("driver overrides round-trip through save/load/clear, scoped per decision id", () => {
  assert.equal(loadDriverOverride("second-cnc-line"), undefined);

  saveDriverOverride("second-cnc-line", { drivers: [sampleDriver()], warnings: [] });
  const loaded = loadDriverOverride("second-cnc-line");
  assert.ok(loaded);
  assert.equal(loaded!.drivers[0].id, "capex");
  assert.ok(loaded!.savedAt, "saveDriverOverride should stamp its own savedAt, not require the caller to supply one");

  assert.equal(loadDriverOverride("some-other-decision"), undefined, "an override for one decision must not leak onto another");

  clearDriverOverride("second-cnc-line");
  assert.equal(loadDriverOverride("second-cnc-line"), undefined);
});

test("saving an override for a second decision doesn't clobber the first", () => {
  saveDriverOverride("decision-a", { drivers: [sampleDriver({ id: "a-driver" })], warnings: [] });
  saveDriverOverride("decision-b", { drivers: [sampleDriver({ id: "b-driver" })], warnings: ["a warning"] });
  assert.equal(loadDriverOverride("decision-a")!.drivers[0].id, "a-driver");
  assert.equal(loadDriverOverride("decision-b")!.drivers[0].id, "b-driver");
  assert.deepEqual(loadDriverOverride("decision-b")!.warnings, ["a warning"]);
});

test("corrupted driver-override storage falls back to no overrides instead of throwing", () => {
  fakeStorage.setItem("sse.driverOverrides", "not json at all {{{");
  assert.equal(loadDriverOverride("second-cnc-line"), undefined);
});

test("when storage is unavailable, writes still succeed for the current session via an in-memory fallback", () => {
  fakeStorage.setThrowOnWrite(true);
  assert.equal(isStorageAvailable(), false);

  const persona = samplePersona();
  const succeeded = upsertCustomPersona(persona);
  assert.equal(succeeded, true, "an in-page fallback should still let this session work even though nothing will survive a reload");
  assert.deepEqual(loadCustomPersonas(), [persona]);
});
