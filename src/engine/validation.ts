import type { Distribution } from "./distributions.ts";
import type { Decision, Persona } from "./types.ts";

/**
 * Validates a persona's decisions and drivers at definition time, so a
 * malformed config (a PERT with `min > max`, a negative capex, a discount
 * rate of 300%) fails loudly and specifically the moment the persona is
 * loaded — not silently, three layers downstream, as a `NaN` NPV sample or
 * a `guardInputs` error that only names a symptom, not the actual mistake.
 *
 * This was added specifically because nothing previously stopped an invalid
 * distribution from being defined at all: `guardInputs` catches a typo'd
 * driver ID, but a driver that exists with nonsensical bounds sailed
 * straight through. It matters more as more personas get authored — by
 * Nathan by hand, or via the AI-assisted drafting workflow in
 * docs/AI_ASSISTED_AUTHORING.md — since neither a human skimming a diff nor
 * an LLM drafting a first pass is guaranteed to catch an inverted range.
 */
export interface ValidationIssue {
  decisionId: string;
  driverId: string | null; // null for a decision-level issue (e.g. horizonYears)
  message: string;
}

export class PersonaValidationError extends Error {
  issues: ValidationIssue[];
  constructor(personaId: string, issues: ValidationIssue[]) {
    const lines = issues.map((i) => `  - [${i.decisionId}${i.driverId ? `.${i.driverId}` : ""}] ${i.message}`);
    super(`Persona "${personaId}" failed validation with ${issues.length} issue(s):\n${lines.join("\n")}`);
    this.name = "PersonaValidationError";
    this.issues = issues;
  }
}

function validateDistribution(dist: Distribution): string[] {
  const problems: string[] = [];
  switch (dist.kind) {
    case "constant":
      if (!Number.isFinite(dist.value)) problems.push(`constant value ${dist.value} is not finite`);
      break;
    case "triangular":
    case "pert": {
      const { min, mode, max } = dist;
      if (!(min <= mode && mode <= max)) {
        problems.push(`${dist.kind} requires min <= mode <= max, got min=${min}, mode=${mode}, max=${max}`);
      }
      if (dist.kind === "pert" && dist.lambda !== undefined && dist.lambda <= 0) {
        problems.push(`pert lambda must be positive, got ${dist.lambda}`);
      }
      break;
    }
    case "normal":
      if (dist.stdDev < 0) problems.push(`normal stdDev must be >= 0, got ${dist.stdDev}`);
      break;
    case "lognormal":
      if (dist.median <= 0) problems.push(`lognormal median must be > 0 (lognormal is strictly positive), got ${dist.median}`);
      if (dist.sigma < 0) problems.push(`lognormal sigma must be >= 0, got ${dist.sigma}`);
      break;
  }
  return problems;
}

/**
 * Category/unit-specific sanity bounds — loose enough not to reject an
 * unusual but real input, tight enough to catch an obvious authoring
 * mistake (a rate entered as a whole-number percent, a swapped sign).
 * Driven off the driver's own declared `unit` field rather than pattern-
 * matching its id/label — a driver named "contributionMarginPerUnit" reads
 * like a percentage by name but is a USD/unit figure by its actual `unit`,
 * so the unit field is the reliable signal, not the name.
 */
function validateDriverSanity(driverId: string, unit: string, category: string, dist: Distribution): string[] {
  const problems: string[] = [];
  const isPercentUnit = unit.trim() === "%" || unit.trim().startsWith("%/");
  if (isPercentUnit) {
    const bounds = distributionRange(dist);
    if (bounds && (bounds.low < -1 || bounds.high > 5)) {
      problems.push(
        `"${driverId}" has unit "${unit}" but its range (${bounds.low} to ${bounds.high}) falls outside a plausible [-100%, 500%] window as a fraction (e.g. use 0.26 for 26%, not 26) — check for a units mistake`,
      );
    }
  }
  if (category === "capex" || category === "cost") {
    const bounds = distributionRange(dist);
    if (bounds && bounds.low < 0) {
      problems.push(`"${driverId}" is a ${category} driver but its range includes negative values (${bounds.low}) — costs and capex should be modeled as positive magnitudes here`);
    }
  }
  return problems;
}

/** Exported so src/engine/guardrails.ts's soft "this looks unusual compared to
 * the sourced default" check reuses the exact same range logic as this
 * module's hard validation, rather than a second copy that could drift out
 * of sync with it. */
export function distributionRange(dist: Distribution): { low: number; high: number } | null {
  switch (dist.kind) {
    case "constant":
      return { low: dist.value, high: dist.value };
    case "triangular":
    case "pert":
      return { low: dist.min, high: dist.max };
    case "normal":
      return { low: dist.mean - 4 * dist.stdDev, high: dist.mean + 4 * dist.stdDev };
    case "lognormal":
      return { low: 0, high: dist.median * Math.exp(4 * dist.sigma) };
  }
}

function validateDecision(decision: Decision): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Number.isInteger(decision.horizonYears) || decision.horizonYears < 1) {
    issues.push({ decisionId: decision.id, driverId: null, message: `horizonYears must be a positive integer, got ${decision.horizonYears}` });
  }
  if (decision.drivers.length === 0) {
    issues.push({ decisionId: decision.id, driverId: null, message: "decision has no drivers" });
  }

  const seenIds = new Set<string>();
  for (const driver of [...decision.drivers, decision.discountRate]) {
    if (seenIds.has(driver.id)) {
      issues.push({ decisionId: decision.id, driverId: driver.id, message: `duplicate driver id "${driver.id}" within this decision` });
    }
    seenIds.add(driver.id);

    for (const problem of validateDistribution(driver.distribution)) {
      issues.push({ decisionId: decision.id, driverId: driver.id, message: problem });
    }
    for (const problem of validateDriverSanity(driver.id, driver.unit, driver.category, driver.distribution)) {
      issues.push({ decisionId: decision.id, driverId: driver.id, message: problem });
    }
    if (!driver.rationale || driver.rationale.trim().length === 0) {
      issues.push({ decisionId: decision.id, driverId: driver.id, message: "driver has no rationale — every driver must state why its range was chosen" });
    }
  }

  return issues;
}

/** Validates every decision in a persona. Throws PersonaValidationError (listing every issue found, not just the first) if any decision is invalid. */
export function validatePersona(persona: Persona): void {
  const issues = persona.decisions.flatMap(validateDecision);
  if (issues.length > 0) {
    throw new PersonaValidationError(persona.id, issues);
  }
}
