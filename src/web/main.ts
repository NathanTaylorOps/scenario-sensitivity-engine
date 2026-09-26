import { personas } from "../personas/index.ts";
import type { Decision, Driver, Persona } from "../engine/types.ts";
import type { Distribution } from "../engine/distributions.ts";
import { runMonteCarlo, runBaseCase } from "../engine/montecarlo.ts";
import { percentiles, probabilityExceeds } from "../engine/percentiles.ts";
import { tornadoAnalysis, analysedDrivers } from "../engine/tornado.ts";
import { solveForZeroNpv } from "../engine/goalseek.ts";
import { decisionVerdict, type VerdictResult } from "../engine/verdict.ts";
import { varianceContribution } from "../engine/variance.ts";
import { representativeCashFlows } from "../engine/scenarios.ts";
import { compareDecisions, portfolioAffordability } from "../engine/portfolio.ts";
import { operationalBrief, financialDetailView, riskBriefView } from "../engine/views.ts";
import { runFinancingAnalysis, LoanTermsError } from "../engine/financing.ts";
import { validatePersona, PersonaValidationError } from "../engine/validation.ts";
import { compareDriverToBaseline, compareDecisionToBaseline } from "../engine/guardrails.ts";
import { listTemplates, starterDriversForTemplate, hydrateDecision } from "../personas/templates.ts";
import {
  loadDriverOverride,
  saveDriverOverride,
  clearDriverOverride,
  loadScenarios,
  saveScenarioRecord,
  deleteScenario,
  exportScenarioToJson,
  importScenarioFromJson,
  generateId,
  hasPrefix,
  loadCustomPersonas,
  upsertCustomPersona,
  deleteCustomPersona,
  SCHEMA_VERSION,
  SCENARIO_PREFIX,
  CUSTOM_PERSONA_PREFIX,
  CUSTOM_DECISION_PREFIX,
  type StoredScenario,
  type StoredCustomPersona,
  type StoredCustomDecision,
} from "./storage.ts";
import { renderTornadoChart, renderRangeChart, formatCompactAud } from "./charts.ts";

const ITERATIONS = 20000;
const SEED = 42;

const state: { persona: Persona; decision: Decision } = {
  persona: personas[0],
  decision: personas[0].decisions[0],
};

/**
 * Turns every saved custom persona back into a runnable Persona by hydrating
 * each of its stored decisions against its template's cashFlows formula. A
 * decision whose templateId this build doesn't recognize (saved by a newer
 * version of the app) is skipped rather than crashing the whole persona; a
 * persona left with zero runnable decisions is skipped entirely.
 */
function customPersonasAsRuntime(): Persona[] {
  return loadCustomPersonas()
    .map((cp) => ({
      id: cp.id,
      name: cp.name,
      tagline: cp.tagline,
      decisions: cp.decisions.flatMap((d) => {
        try {
          return [hydrateDecision(d)];
        } catch {
          return [];
        }
      }),
    }))
    .filter((p) => p.decisions.length > 0);
}

/** The built-in personas plus every custom persona currently saved on this
 * device — the full set the persona picker, scenario loader and portfolio
 * views all draw from. Recomputed on demand (never cached) so a persona
 * created or deleted this session is reflected immediately. */
function allPersonas(): Persona[] {
  return [...personas, ...customPersonasAsRuntime()];
}

/** Locates the stored custom persona/decision pair backing a given decision
 * id, or undefined if that id isn't a custom decision this device knows. */
function findOwningCustomPersona(decisionId: string): { persona: StoredCustomPersona; decision: StoredCustomDecision } | undefined {
  for (const persona of loadCustomPersonas()) {
    const decision = persona.decisions.find((d) => d.id === decisionId);
    if (decision) return { persona, decision };
  }
  return undefined;
}

/**
 * Merges any saved driver override onto a clone of the built-in decision.
 * `decision` itself (imported from src/personas/) is never mutated — it
 * stays the immutable baseline the editor diffs against and resets to. Only
 * driver data is ever substituted; the decision's own `cashFlows` function
 * reference is untouched, so an edited decision still runs the exact same,
 * already-reviewed formula against different numbers.
 */
function applyOverride(decision: Decision): Decision {
  const override = loadDriverOverride(decision.id);
  if (!override) return decision;
  const driverMap = new Map(override.drivers.map((d) => [d.id, d]));
  return {
    ...decision,
    discountRate: override.discountRate ?? decision.discountRate,
    drivers: decision.drivers.map((d) => driverMap.get(d.id) ?? d),
  };
}

/** Delays calling `fn` until `wait` ms after the last call — used for inputs that
 * trigger a real Monte Carlo re-run on every keystroke, so typing a multi-digit
 * value doesn't fire several 20,000-iteration simulations back to back. */
function debounce<Args extends unknown[]>(fn: (...args: Args) => void, wait: number): (...args: Args) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

// ---- DOM handles ----
const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const personaSelect = $<HTMLSelectElement>("persona-select");
const decisionTabs = $<HTMLDivElement>("decision-tabs");
const decisionDescription = $<HTMLParagraphElement>("decision-description");
const verdictBadge = $<HTMLDivElement>("verdict-badge");
const statTiles = $<HTMLDivElement>("stat-tiles");
const rangeChartEl = $<HTMLDivElement>("range-chart");
const tornadoChartEl = $<HTMLDivElement>("tornado-chart");
const varianceListEl = $<HTMLDivElement>("variance-list");
const audienceExecutorEl = $<HTMLDivElement>("audience-executor");
const audienceCfoEl = $<HTMLDivElement>("audience-cfo");
const audienceLenderEl = $<HTMLDivElement>("audience-lender");
const financingSection = $<HTMLDivElement>("financing-section");
const financingResult = $<HTMLDivElement>("financing-result");
const ltvInput = $<HTMLInputElement>("ltv-input");
const rateInput = $<HTMLInputElement>("rate-input");
const termInput = $<HTMLInputElement>("term-input");
const sectionBandDecisionLabel = $<HTMLSpanElement>("section-band-decision-label");
const comparisonTableBody = $<HTMLTableSectionElement>("comparison-table-body");
const affordabilityInput = $<HTMLInputElement>("affordability-capital");
const affordabilityResult = $<HTMLDivElement>("affordability-result");
const editAssumptionsBtn = $<HTMLButtonElement>("edit-assumptions-btn");
const resetAssumptionsBtn = $<HTMLButtonElement>("reset-assumptions-btn");
const editorPanel = $<HTMLElement>("editor-panel");
const editorDecisionLabel = $<HTMLSpanElement>("editor-decision-label");
const editorBody = $<HTMLDivElement>("editor-body");
const editorErrorsEl = $<HTMLDivElement>("editor-validation-errors");
const editorWarningsEl = $<HTMLDivElement>("editor-warnings");
const editorSaveBtn = $<HTMLButtonElement>("editor-save-btn");
const editorCancelBtn = $<HTMLButtonElement>("editor-cancel-btn");
const scenarioNameInput = $<HTMLInputElement>("scenario-name-input");
const scenarioSaveBtn = $<HTMLButtonElement>("scenario-save-btn");
const scenarioExportBtn = $<HTMLButtonElement>("scenario-export-btn");
const scenarioImportBtn = $<HTMLButtonElement>("scenario-import-btn");
const scenarioImportInput = $<HTMLInputElement>("scenario-import-input");
const scenarioMessageEl = $<HTMLDivElement>("scenario-message");
const scenarioSelect = $<HTMLSelectElement>("scenario-select");
const scenarioLoadBtn = $<HTMLButtonElement>("scenario-load-btn");
const scenarioDeleteBtn = $<HTMLButtonElement>("scenario-delete-btn");
const goalSeekDriverSelect = $<HTMLSelectElement>("goal-seek-driver-select");
const goalSeekResultEl = $<HTMLDivElement>("goal-seek-result");
const newDecisionBtn = $<HTMLButtonElement>("new-decision-btn");
const deleteCustomBtn = $<HTMLButtonElement>("delete-custom-btn");
const newDecisionForm = $<HTMLElement>("new-decision-form");
const newDecisionTemplateSelect = $<HTMLSelectElement>("new-decision-template");
const newDecisionPersonaModeSelect = $<HTMLSelectElement>("new-decision-persona-mode");
const newPersonaNameField = $<HTMLDivElement>("new-persona-name-field");
const newPersonaNameInput = $<HTMLInputElement>("new-persona-name");
const newDecisionLabelInput = $<HTMLInputElement>("new-decision-label");
const newDecisionDescriptionInput = $<HTMLTextAreaElement>("new-decision-description");
const newDecisionHorizonInput = $<HTMLInputElement>("new-decision-horizon");
const newDecisionErrorsEl = $<HTMLDivElement>("new-decision-errors");
const newDecisionCreateBtn = $<HTMLButtonElement>("new-decision-create-btn");
const newDecisionCancelBtn = $<HTMLButtonElement>("new-decision-cancel-btn");

// ---- Persona / decision selection ----

function populatePersonaSelect(): void {
  personaSelect.innerHTML = "";
  for (const persona of allPersonas()) {
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = persona.name;
    personaSelect.appendChild(option);
  }
  personaSelect.value = state.persona.id;
}

function renderDecisionTabs(): void {
  decisionTabs.innerHTML = "";
  decisionTabs.setAttribute("role", "tablist");
  for (const decision of state.persona.decisions) {
    const isActive = decision.id === state.decision.id;
    const button = document.createElement("button");
    button.className = "tab" + (isActive ? " tab-active" : "");
    button.textContent = decision.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(isActive));
    button.addEventListener("click", () => {
      state.decision = decision;
      closeEditor();
      resetFinancingDefaults(decision);
      renderDecisionTabs();
      renderAll();
    });
    decisionTabs.appendChild(button);
  }
}

personaSelect.addEventListener("change", () => {
  const persona = allPersonas().find((p) => p.id === personaSelect.value);
  if (!persona) return;
  state.persona = persona;
  state.decision = persona.decisions[0];
  closeEditor();
  resetFinancingDefaults(state.decision);
  renderDecisionTabs();
  renderAll();
  renderComparisonAndPortfolio();
});

// ---- Verdict + stat tiles ----

/** Shared so the verdict badge, the tied stat tile, and the comparison-table pill
 * all agree on which status color a verdict maps to. */
function verdictStatusClass(verdict: VerdictResult["verdict"]): "status-good" | "status-warning" | "status-critical" {
  return verdict === "Proceed" ? "status-good" : verdict === "Marginal" ? "status-warning" : "status-critical";
}

function renderVerdict(verdict: VerdictResult): string {
  const statusClass = verdictStatusClass(verdict.verdict);
  const icon = verdict.verdict === "Proceed" ? "✓" : verdict.verdict === "Marginal" ? "▲" : "✕";
  verdictBadge.innerHTML = "";
  verdictBadge.className = `verdict-badge ${statusClass}`;
  const iconSpan = document.createElement("span");
  iconSpan.className = "verdict-icon";
  iconSpan.textContent = icon;
  iconSpan.setAttribute("aria-hidden", "true");
  const textWrap = document.createElement("div");
  const label = document.createElement("div");
  label.className = "verdict-label";
  label.textContent = verdict.verdict;
  const rationale = document.createElement("div");
  rationale.className = "verdict-rationale";
  rationale.textContent = verdict.rationale;
  textWrap.appendChild(label);
  textWrap.appendChild(rationale);
  verdictBadge.appendChild(iconSpan);
  verdictBadge.appendChild(textWrap);
  return statusClass;
}

function renderStatTiles(probabilityPositive: number, baseNpv: number, basePayback: number | null, statusClass: string): void {
  statTiles.innerHTML = "";
  const tiles = [
    // The headline probability tile is the one figure the verdict badge is actually
    // computed from, so its value is colored to match the verdict — a reader
    // scanning the tiles alone (without reading the badge text) still sees at a
    // glance whether this leans good, marginal, or critical.
    { label: "Probability NPV > 0", value: `${(probabilityPositive * 100).toFixed(0)}%`, tied: true },
    { label: "Base-case NPV", value: formatCompactAud(baseNpv), tied: false },
    { label: "Base-case payback", value: basePayback === null ? "Not recovered" : `${basePayback.toFixed(1)} yrs`, tied: false },
  ];
  for (const tile of tiles) {
    const el = document.createElement("div");
    el.className = "stat-tile";
    const valueEl = document.createElement("div");
    valueEl.className = "stat-value" + (tile.tied ? ` stat-value-${statusClass}` : "");
    valueEl.textContent = tile.value;
    const labelEl = document.createElement("div");
    labelEl.className = "stat-label";
    labelEl.textContent = tile.label;
    el.appendChild(valueEl);
    el.appendChild(labelEl);
    statTiles.appendChild(el);
  }
}

// ---- Main per-decision render ----

function renderAll(): void {
  const baseDecision = state.decision;
  const decision = applyOverride(baseDecision);
  decisionDescription.textContent = baseDecision.description;
  sectionBandDecisionLabel.textContent = baseDecision.label;
  const isCustomDecision = hasPrefix(baseDecision.id, CUSTOM_DECISION_PREFIX);
  resetAssumptionsBtn.hidden = isCustomDecision || loadDriverOverride(baseDecision.id) === undefined;
  deleteCustomBtn.hidden = !isCustomDecision;

  const base = runBaseCase(decision);
  const result = runMonteCarlo(decision, { iterations: ITERATIONS, seed: SEED, captureInputs: true, captureCashFlows: true });
  const npvPct = percentiles(result.npvSamples);
  const probabilityPositive = probabilityExceeds(result.npvSamples, 0);
  const verdict = decisionVerdict(probabilityPositive);

  const statusClass = renderVerdict(verdict);
  renderStatTiles(probabilityPositive, base.npv, base.payback, statusClass);
  renderRangeChart(rangeChartEl, { label: decision.label, p90: npvPct.p90, p50: npvPct.p50, p10: npvPct.p10 });

  const tornado = tornadoAnalysis(decision);
  renderTornadoChart(
    tornadoChartEl,
    tornado.map((row) => ({ label: row.label, swing: row.swing })),
  );

  renderGoalSeekPanel(decision, tornado[0]?.driverId);

  const varianceRows = varianceContribution(decision, result.npvSamples, result.inputsSamples!);
  varianceListEl.innerHTML = "";
  for (const row of varianceRows.slice(0, 4)) {
    const item = document.createElement("div");
    item.className = "variance-row";
    const barTrack = document.createElement("div");
    barTrack.className = "variance-track";
    const bar = document.createElement("div");
    bar.className = "variance-bar";
    bar.style.width = `${Math.max(row.varianceShare * 100, 2)}%`;
    barTrack.appendChild(bar);
    const label = document.createElement("div");
    label.className = "variance-label";
    label.textContent = `${row.label} — ${(row.varianceShare * 100).toFixed(0)}%`;
    item.appendChild(label);
    item.appendChild(barTrack);
    varianceListEl.appendChild(item);
  }

  const rep = representativeCashFlows(result.npvSamples, result.cashFlowSamples!, npvPct);

  // All three audience views render together, always — the point of this section is
  // that one result reads differently to each of them, which a tab-switcher hides
  // rather than shows. See docs/METHODOLOGY.md for why these three views exist.
  audienceExecutorEl.innerHTML = "";
  const executorP = document.createElement("p");
  executorP.className = "audience-text";
  executorP.textContent = operationalBrief(decision, verdict, tornado[0]?.label);
  audienceExecutorEl.appendChild(executorP);

  audienceCfoEl.innerHTML = "";
  const financial = financialDetailView(decision, npvPct, varianceRows);
  const cfoSummary = document.createElement("p");
  cfoSummary.className = "audience-text";
  cfoSummary.textContent = `Effective tax rate (base case): ${financial.taxRateBaseCase !== null ? (financial.taxRateBaseCase * 100).toFixed(1) + "%" : "n/a"}. Top variance driver: ${financial.topVarianceDrivers[0]?.label ?? "n/a"}.`;
  audienceCfoEl.appendChild(cfoSummary);
  const assumptionList = document.createElement("ul");
  assumptionList.className = "assumption-list";
  for (const line of financial.assumptionLines) {
    const li = document.createElement("li");
    const heading = document.createElement("span");
    heading.className = "assumption-heading";
    heading.textContent = line.heading;
    const detail = document.createElement("span");
    detail.className = "assumption-detail";
    detail.textContent = line.detail;
    li.appendChild(heading);
    li.appendChild(detail);
    assumptionList.appendChild(li);
  }
  audienceCfoEl.appendChild(assumptionList);

  audienceLenderEl.innerHTML = "";
  const risk = riskBriefView(decision, npvPct, rep.p90);
  const lenderSummary = document.createElement("p");
  lenderSummary.className = "audience-text";
  lenderSummary.textContent = `Downside (P90) NPV: ${formatCompactAud(risk.downsideNpv)}. ${risk.note}`;
  audienceLenderEl.appendChild(lenderSummary);
  if (risk.downsideRepresentativeCashFlows) {
    const cashLine = document.createElement("p");
    cashLine.className = "audience-text audience-muted";
    cashLine.textContent = `Representative P90 cash flow: ${risk.downsideRepresentativeCashFlows.map((v) => formatCompactAud(v)).join(", ")}`;
    audienceLenderEl.appendChild(cashLine);
  }

  renderFinancingSection(decision);
}

// ---- Debt financing / DSCR ----

/** The loan term defaults to the decision's horizon so the loan amortises inside the
 * model by default; a longer term is allowed and leaves a balloon at the horizon. */
function resetFinancingDefaults(decision: Decision): void {
  termInput.value = String(decision.horizonYears);
}

function financingLine(text: string, muted = false): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "audience-text" + (muted ? " audience-muted" : "");
  p.textContent = text;
  return p;
}

function renderFinancingSection(decision: Decision): void {
  const hasCapex = decision.drivers.some((d) => d.id === "capex");
  financingSection.style.display = hasCapex ? "" : "none";
  if (!hasCapex) return;

  const compute = () => {
    financingResult.innerHTML = "";
    const loanToValuePct = Number(ltvInput.value) / 100;
    const annualInterestRate = Number(rateInput.value) / 100;
    const termYears = Number(termInput.value);
    const covenantMinDscr = 1.25;

    if (loanToValuePct === 0) {
      financingResult.appendChild(
        financingLine("0% loan-to-value is an all-equity purchase: there is no debt to service, and the unlevered figures above are already that case."),
      );
      return;
    }

    let analysis;
    try {
      analysis = runFinancingAnalysis(decision, { loanToValuePct, annualInterestRate, termYears }, covenantMinDscr, { iterations: ITERATIONS, seed: SEED });
    } catch (err) {
      // Invalid loan terms (a 0-year term, an out-of-range loan-to-value, a negative rate)
      // are rejected by the engine; show the rejection rather than a plausible-looking number.
      if (err instanceof LoanTermsError) {
        const errorEl = document.createElement("p");
        errorEl.className = "audience-text financing-error";
        errorEl.textContent = err.message;
        financingResult.appendChild(errorEl);
        return;
      }
      throw err;
    }

    const fmtDscr = (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)}x` : "n/a");
    const { unleveredNpvPercentiles: unlevered, taxShieldPvPercentiles: shield, apvPercentiles: apv, dscr } = analysis;

    const valueHeading = document.createElement("h4");
    valueHeading.className = "financing-subheading";
    valueHeading.textContent = "Value: adjusted present value (APV)";
    financingResult.appendChild(valueHeading);
    financingResult.appendChild(
      financingLine(
        `Loan of ${formatCompactAud(analysis.baseCasePrincipal)} at base-case capex. Unlevered NPV (P50): ${formatCompactAud(unlevered.p50)}  +  PV of interest tax shield at the ${(annualInterestRate * 100).toFixed(1)}% loan rate (P50): ${formatCompactAud(shield.p50)}  =  APV (P50): ${formatCompactAud(apv.p50)}.`,
      ),
    );
    financingResult.appendChild(
      financingLine(`APV — P90: ${formatCompactAud(apv.p90)}  P50: ${formatCompactAud(apv.p50)}  P10: ${formatCompactAud(apv.p10)}.  Probability APV > 0: ${(analysis.probabilityApvPositive * 100).toFixed(0)}%.`, true),
    );
    financingResult.appendChild(financingLine(analysis.note, true));

    const covenantHeading = document.createElement("h4");
    covenantHeading.className = "financing-subheading";
    covenantHeading.textContent = `Covenant: debt-service coverage (lender minimum ${covenantMinDscr}x)`;
    financingResult.appendChild(covenantHeading);
    financingResult.appendChild(financingLine(`Probability the worst year's coverage stays above ${covenantMinDscr}x: ${(dscr.probabilityAboveCovenant * 100).toFixed(0)}%.`));
    financingResult.appendChild(
      financingLine(`Worst-year coverage across trials — P90: ${fmtDscr(dscr.minimumDscrPercentiles.p90)}  P50: ${fmtDscr(dscr.minimumDscrPercentiles.p50)}  P10: ${fmtDscr(dscr.minimumDscrPercentiles.p10)}`, true),
    );
    financingResult.appendChild(financingLine(dscr.note, true));
  };

  const debouncedCompute = debounce(compute, 300);
  ltvInput.oninput = debouncedCompute;
  rateInput.oninput = debouncedCompute;
  termInput.oninput = debouncedCompute;
  compute();
}

// ---- Goal-seek ----
//
// Surfaces src/engine/goalseek.ts (previously CLI-only, via scripts/demo.ts)
// in the browser UI: the question a GM asks more often than "what's the
// NPV" — what does one driver need to hit, alone, for this decision to
// break even. NPV = 0 is the only target the engine solves for today
// (solveForZeroNpv); the driver to solve for is the only thing the person
// picks. Remembers the last-picked driver per decision so switching tabs and
// coming back doesn't reset the choice, but defaults a decision that hasn't
// been visited yet to its top tornado driver — the one most worth asking about.

const goalSeekSelectionByDecision = new Map<string, string>();
let goalSeekDecision: Decision | undefined;

/** Renders a driver's value in the same units it's entered in the editor —
 * a bare fraction as a percentage, an AUD figure compacted like the rest of
 * the app's currency output, anything else as a plain number with its unit. */
function formatDriverValue(driver: Driver, value: number): string {
  const unit = driver.unit.trim();
  if (unit === "%") return `${(value * 100).toFixed(1)}%`;
  if (unit.startsWith("%/")) return `${(value * 100).toFixed(1)}%${unit.slice(1)}`;
  if (unit.startsWith("AUD")) return `${formatCompactAud(value)}${unit.slice(3)}`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}

function computeGoalSeek(): void {
  const decision = goalSeekDecision;
  if (!decision) return;
  const driverId = goalSeekDriverSelect.value;
  const driver = analysedDrivers(decision).find((d) => d.id === driverId);
  goalSeekResultEl.innerHTML = "";
  if (!driver) return;

  goalSeekSelectionByDecision.set(decision.id, driverId);
  const result = solveForZeroNpv(decision, driverId);
  const p = document.createElement("p");
  p.className = "audience-text";
  if (result.feasible && result.solvedValue !== null) {
    p.textContent = `"${driver.label}" would need to be ${formatDriverValue(driver, result.solvedValue)} (base case: ${formatDriverValue(driver, result.baseCaseValue)}) for NPV to reach breakeven, holding every other driver at its base case.`;
  } else {
    p.textContent = result.note;
  }
  goalSeekResultEl.appendChild(p);
}

/** Repopulates the driver picker for the decision now on screen and runs the
 * solve. `defaultDriverId` (the top tornado driver) is used the first time a
 * decision is seen; after that, the person's own last pick for that decision
 * wins as long as it's still one of its drivers. */
function renderGoalSeekPanel(decision: Decision, defaultDriverId: string | undefined): void {
  goalSeekDecision = decision;
  const drivers = analysedDrivers(decision);
  const remembered = goalSeekSelectionByDecision.get(decision.id);
  const selection = drivers.some((d) => d.id === remembered) ? remembered! : (defaultDriverId ?? drivers[0]?.id);

  goalSeekDriverSelect.innerHTML = "";
  for (const driver of drivers) {
    const option = document.createElement("option");
    option.value = driver.id;
    option.textContent = driver.label;
    goalSeekDriverSelect.appendChild(option);
  }
  if (selection) goalSeekDriverSelect.value = selection;
  computeGoalSeek();
}

goalSeekDriverSelect.addEventListener("change", computeGoalSeek);

// ---- Assumption editor ----
//
// Lets someone edit an existing (built-in) decision's driver numbers for
// their own situation. Two things this deliberately does NOT do, both
// stated scope lines from the brainstorm this was built against:
//   - It never lets someone author a new cashFlows formula — only the
//     driver DATA feeding the decision's own existing, already-reviewed
//     formula. See src/personas/templates.ts for the (separate) mechanism
//     for building a brand-new decision from a fixed archetype.
//   - Saving is hard-blocked by the engine's own validatePersona check
//     (the same one built-in personas run at load time) — an editor can
//     never persist a config that decision wouldn't itself pass. Guardrail
//     warnings (guardrails.ts) are shown but never block a save, since an
//     edit outside the sourced range can be a legitimate business reason,
//     not a mistake.

/** Reads the currently-edited value out of each driver row, populated while
 * the editor is open. Cleared and rebuilt every time the editor opens. */
const editorFieldReaders = new Map<string, () => Driver>();

function closeEditor(): void {
  editorPanel.hidden = true;
  editAssumptionsBtn.hidden = false;
  editorFieldReaders.clear();
}

/** A representative single value for a distribution, used only to seed a
 * sensible starting point when someone switches which distribution shape a
 * driver uses in the editor's advanced mode — never used by the engine. */
function distributionAnchor(dist: Distribution): number {
  switch (dist.kind) {
    case "constant":
      return dist.value;
    case "triangular":
    case "pert":
      return dist.mode;
    case "normal":
      return dist.mean;
    case "lognormal":
      return dist.median;
  }
}

function defaultDistributionForKind(kind: Distribution["kind"], current: Distribution): Distribution {
  const anchor = distributionAnchor(current);
  switch (kind) {
    case "constant":
      return { kind, value: anchor };
    case "triangular":
      return { kind, min: anchor * 0.8, mode: anchor, max: anchor * 1.2 };
    case "pert":
      return { kind, min: anchor * 0.8, mode: anchor, max: anchor * 1.2 };
    case "normal":
      return { kind, mean: anchor, stdDev: Math.abs(anchor) * 0.15 || 1 };
    case "lognormal":
      return { kind, median: Math.max(anchor, 0.01), sigma: 0.25 };
  }
}

/** Builds one plain-language numeric field (a label + number input) wired to
 * call `onChange` with the parsed value on every edit. */
function numberField(labelText: string, value: number, onChange: (value: number) => void): HTMLElement {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = labelText;
  const input = document.createElement("input");
  input.className = "input";
  input.type = "number";
  input.step = "any";
  input.value = String(value);
  input.addEventListener("input", () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  field.appendChild(label);
  field.appendChild(input);
  return field;
}

/** Builds one driver's editable row (plain-language fields, an "advanced"
 * distribution-shape switcher, and a rationale textarea), and registers a
 * reader for it in `editorFieldReaders` keyed by the driver's id. */
function buildDriverRow(driver: Driver): void {
  const row = document.createElement("div");
  row.className = "editor-row";

  const header = document.createElement("div");
  header.className = "editor-row-header";
  const labelSpan = document.createElement("span");
  labelSpan.className = "editor-row-label";
  labelSpan.textContent = driver.label;
  const unitSpan = document.createElement("span");
  unitSpan.className = "editor-row-unit";
  unitSpan.textContent = driver.unit;
  header.appendChild(labelSpan);
  header.appendChild(unitSpan);
  row.appendChild(header);

  const plainWrap = document.createElement("div");
  plainWrap.className = "editor-plain-fields";
  row.appendChild(plainWrap);

  let currentDist: Distribution = driver.distribution;

  function renderPlainFields(): void {
    plainWrap.innerHTML = "";
    if (currentDist.kind === "constant") {
      plainWrap.appendChild(
        numberField("Value", currentDist.value, (v) => {
          currentDist = { kind: "constant", value: v };
        }),
      );
    } else if (currentDist.kind === "triangular" || currentDist.kind === "pert") {
      const kind = currentDist.kind;
      plainWrap.appendChild(
        numberField("Pessimistic", currentDist.min, (v) => {
          if (currentDist.kind === kind) currentDist = { ...currentDist, min: v };
        }),
      );
      plainWrap.appendChild(
        numberField("Likely", currentDist.mode, (v) => {
          if (currentDist.kind === kind) currentDist = { ...currentDist, mode: v };
        }),
      );
      plainWrap.appendChild(
        numberField("Optimistic", currentDist.max, (v) => {
          if (currentDist.kind === kind) currentDist = { ...currentDist, max: v };
        }),
      );
    } else if (currentDist.kind === "normal") {
      plainWrap.appendChild(
        numberField("Mean", currentDist.mean, (v) => {
          if (currentDist.kind === "normal") currentDist = { ...currentDist, mean: v };
        }),
      );
      plainWrap.appendChild(
        numberField("Std deviation", currentDist.stdDev, (v) => {
          if (currentDist.kind === "normal") currentDist = { ...currentDist, stdDev: v };
        }),
      );
    } else if (currentDist.kind === "lognormal") {
      plainWrap.appendChild(
        numberField("Median", currentDist.median, (v) => {
          if (currentDist.kind === "lognormal") currentDist = { ...currentDist, median: v };
        }),
      );
      plainWrap.appendChild(
        numberField("Sigma (spread)", currentDist.sigma, (v) => {
          if (currentDist.kind === "lognormal") currentDist = { ...currentDist, sigma: v };
        }),
      );
    }
  }
  renderPlainFields();

  const details = document.createElement("details");
  details.className = "editor-advanced";
  const summary = document.createElement("summary");
  summary.textContent = "Advanced: change distribution shape";
  details.appendChild(summary);
  const kindSelect = document.createElement("select");
  kindSelect.className = "select";
  for (const kind of ["constant", "triangular", "pert", "normal", "lognormal"] as const) {
    const opt = document.createElement("option");
    opt.value = kind;
    opt.textContent = kind;
    kindSelect.appendChild(opt);
  }
  kindSelect.value = currentDist.kind;
  kindSelect.addEventListener("change", () => {
    currentDist = defaultDistributionForKind(kindSelect.value as Distribution["kind"], currentDist);
    renderPlainFields();
  });
  details.appendChild(kindSelect);
  row.appendChild(details);

  const rationaleLabel = document.createElement("label");
  rationaleLabel.className = "field-label";
  rationaleLabel.textContent = "Rationale";
  row.appendChild(rationaleLabel);
  const rationaleField = document.createElement("textarea");
  rationaleField.className = "input editor-rationale";
  rationaleField.value = driver.rationale;
  rationaleField.rows = 2;
  row.appendChild(rationaleField);

  editorFieldReaders.set(driver.id, () => ({ ...driver, distribution: currentDist, rationale: rationaleField.value }));
  editorBody.appendChild(row);
}

function openEditor(): void {
  const baseDecision = state.decision;
  const overridden = applyOverride(baseDecision);

  editorFieldReaders.clear();
  editorBody.innerHTML = "";
  editorErrorsEl.hidden = true;
  editorWarningsEl.hidden = true;
  editorDecisionLabel.textContent = baseDecision.label;

  buildDriverRow(overridden.discountRate);
  for (const driver of overridden.drivers) buildDriverRow(driver);

  editorPanel.hidden = false;
  editAssumptionsBtn.hidden = true;
}

editAssumptionsBtn.addEventListener("click", openEditor);
editorCancelBtn.addEventListener("click", closeEditor);

editorSaveBtn.addEventListener("click", () => {
  const baseDecision = state.decision;
  const editedDiscountRate = editorFieldReaders.get(baseDecision.discountRate.id)?.();
  const editedDrivers = baseDecision.drivers.map((d) => editorFieldReaders.get(d.id)?.() ?? d);
  if (!editedDiscountRate) return; // editor wasn't actually open with a built row for this decision

  const candidateDecision: Decision = { ...baseDecision, discountRate: editedDiscountRate, drivers: editedDrivers };
  const checkPersona: Persona = { id: "__editor_check__", name: "editor check", tagline: "", decisions: [candidateDecision] };

  try {
    validatePersona(checkPersona);
  } catch (err) {
    if (err instanceof PersonaValidationError) {
      editorWarningsEl.hidden = true;
      editorErrorsEl.hidden = false;
      editorErrorsEl.innerHTML = "";
      const title = document.createElement("p");
      title.textContent = "These assumptions can't be saved as-is:";
      editorErrorsEl.appendChild(title);
      const list = document.createElement("ul");
      for (const issue of err.issues) {
        const li = document.createElement("li");
        li.textContent = issue.message;
        list.appendChild(li);
      }
      editorErrorsEl.appendChild(list);
      return; // hard block — the engine's own validation, not just a UI opinion, rejected this
    }
    throw err;
  }

  const warnings = compareDecisionToBaseline(candidateDecision, baseDecision).map((w) => w.message);
  const discountWarning = compareDriverToBaseline(editedDiscountRate, baseDecision.discountRate);
  if (discountWarning) warnings.unshift(discountWarning.message);

  const owningCustom = findOwningCustomPersona(baseDecision.id);
  if (owningCustom) {
    // A custom decision has no separate "built-in default" to override — the
    // edited driver data IS the decision, persisted directly onto its
    // custom persona (upsertCustomPersona), not through the driver-override
    // layer that only makes sense for a built-in decision with a fixed
    // baseline to diff against and reset to.
    const updatedDecision: StoredCustomDecision = { ...owningCustom.decision, discountRate: editedDiscountRate, drivers: editedDrivers };
    const updatedPersona: StoredCustomPersona = {
      ...owningCustom.persona,
      decisions: owningCustom.persona.decisions.map((d) => (d.id === updatedDecision.id ? updatedDecision : d)),
    };
    upsertCustomPersona(updatedPersona);
    // Refresh state from the freshly-hydrated persona so decision tabs and
    // any later edit start from the just-saved numbers, not the stale
    // in-memory object from before this save.
    const refreshedPersona = allPersonas().find((p) => p.id === updatedPersona.id);
    const refreshedDecision = refreshedPersona?.decisions.find((d) => d.id === updatedDecision.id);
    if (refreshedPersona && refreshedDecision) {
      state.persona = refreshedPersona;
      state.decision = refreshedDecision;
    }
    renderDecisionTabs();
  } else {
    saveDriverOverride(baseDecision.id, { discountRate: editedDiscountRate, drivers: editedDrivers, warnings });
  }

  editorErrorsEl.hidden = true;
  editorWarningsEl.hidden = warnings.length === 0;
  editorWarningsEl.innerHTML = "";
  if (warnings.length > 0) {
    const title = document.createElement("p");
    title.textContent = `Saved — ${warnings.length} assumption(s) flagged for a second look (not blocked):`;
    editorWarningsEl.appendChild(title);
    const list = document.createElement("ul");
    for (const w of warnings) {
      const li = document.createElement("li");
      li.textContent = w;
      list.appendChild(li);
    }
    editorWarningsEl.appendChild(list);
  }

  renderAll();
  renderComparisonAndPortfolio();
  if (warnings.length === 0) closeEditor();
});

resetAssumptionsBtn.addEventListener("click", () => {
  clearDriverOverride(state.decision.id);
  closeEditor();
  renderAll();
  renderComparisonAndPortfolio();
});

deleteCustomBtn.addEventListener("click", () => {
  const owning = findOwningCustomPersona(state.decision.id);
  if (!owning) return;
  const remainingDecisions = owning.persona.decisions.filter((d) => d.id !== state.decision.id);
  if (remainingDecisions.length === 0) {
    // Deleting a custom persona's last decision leaves an empty, useless
    // persona behind — remove the whole persona rather than leave a
    // decision-less entry sitting in the picker.
    deleteCustomPersona(owning.persona.id);
  } else {
    upsertCustomPersona({ ...owning.persona, decisions: remainingDecisions });
  }
  closeEditor();
  state.persona = personas[0];
  state.decision = personas[0].decisions[0];
  resetFinancingDefaults(state.decision);
  populatePersonaSelect();
  renderDecisionTabs();
  renderAll();
  renderComparisonAndPortfolio();
});

// ---- Build your own decision from scratch ----
//
// Wires the engine's decision-template mechanism (src/personas/templates.ts)
// and the browser-storage custom-persona/decision layer (src/web/storage.ts)
// into the UI. Both already existed and were fully unit-tested, but neither
// was ever reachable from a browser: the assumption editor above only lets
// someone edit an EXISTING decision's numbers, never author a brand-new one
// with its own persona name, its own drivers, and its own capital amounts
// from a blank slate. This is that missing path.

function populateNewDecisionForm(): void {
  newDecisionTemplateSelect.innerHTML = "";
  for (const template of listTemplates()) {
    const opt = document.createElement("option");
    opt.value = template.id;
    opt.textContent = template.name;
    newDecisionTemplateSelect.appendChild(opt);
  }

  newDecisionPersonaModeSelect.innerHTML = "";
  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "A new persona";
  newDecisionPersonaModeSelect.appendChild(newOpt);
  for (const persona of loadCustomPersonas()) {
    const opt = document.createElement("option");
    opt.value = persona.id;
    opt.textContent = `Add to "${persona.name}"`;
    newDecisionPersonaModeSelect.appendChild(opt);
  }
  newDecisionPersonaModeSelect.value = "__new__";
  newPersonaNameField.hidden = false;

  newDecisionLabelInput.value = "";
  newDecisionDescriptionInput.value = "";
  newPersonaNameInput.value = "";
  newDecisionHorizonInput.value = String(listTemplates()[0]?.defaultHorizonYears ?? 5);
  newDecisionErrorsEl.hidden = true;
}

newDecisionPersonaModeSelect.addEventListener("change", () => {
  newPersonaNameField.hidden = newDecisionPersonaModeSelect.value !== "__new__";
});

function showNewDecisionError(message: string): void {
  newDecisionErrorsEl.hidden = false;
  newDecisionErrorsEl.textContent = message;
}

newDecisionBtn.addEventListener("click", () => {
  populateNewDecisionForm();
  newDecisionForm.hidden = false;
  newDecisionBtn.hidden = true;
});

newDecisionCancelBtn.addEventListener("click", () => {
  newDecisionForm.hidden = true;
  newDecisionBtn.hidden = false;
});

newDecisionCreateBtn.addEventListener("click", () => {
  const templateId = newDecisionTemplateSelect.value;
  const starters = starterDriversForTemplate(templateId);
  const template = listTemplates().find((t) => t.id === templateId);
  if (!starters || !template) {
    showNewDecisionError("No cash-flow template is selected.");
    return;
  }

  const label = newDecisionLabelInput.value.trim();
  if (label.length === 0) {
    showNewDecisionError("Give this decision a name.");
    return;
  }
  const horizonYears = Number(newDecisionHorizonInput.value);
  if (!Number.isInteger(horizonYears) || horizonYears < 1) {
    showNewDecisionError("Horizon must be a whole number of years, 1 or more.");
    return;
  }

  const personaMode = newDecisionPersonaModeSelect.value;
  let targetPersona: StoredCustomPersona;
  if (personaMode === "__new__") {
    const personaName = newPersonaNameInput.value.trim();
    if (personaName.length === 0) {
      showNewDecisionError("Give the new persona a name.");
      return;
    }
    targetPersona = { id: generateId(CUSTOM_PERSONA_PREFIX), name: personaName, tagline: "Custom persona", decisions: [] };
  } else {
    const existing = loadCustomPersonas().find((p) => p.id === personaMode);
    if (!existing) {
      showNewDecisionError("That persona no longer exists — pick another, or start a new one.");
      return;
    }
    targetPersona = existing;
  }

  const newDecision: StoredCustomDecision = {
    id: generateId(CUSTOM_DECISION_PREFIX),
    templateId,
    label,
    description: newDecisionDescriptionInput.value.trim() || template.descriptionPrompt,
    horizonYears,
    discountRate: starters.discountRate,
    drivers: starters.drivers,
  };
  const updatedPersona: StoredCustomPersona = { ...targetPersona, decisions: [...targetPersona.decisions, newDecision] };

  try {
    const hydrated = hydrateDecision(newDecision);
    validatePersona({ id: "__new_decision_check__", name: "new decision check", tagline: "", decisions: [hydrated] });
  } catch (err) {
    showNewDecisionError(err instanceof PersonaValidationError ? err.message : String(err));
    return;
  }

  upsertCustomPersona(updatedPersona);

  const runtimePersona = allPersonas().find((p) => p.id === updatedPersona.id);
  const runtimeDecision = runtimePersona?.decisions.find((d) => d.id === newDecision.id);
  if (!runtimePersona || !runtimeDecision) {
    showNewDecisionError("The decision was saved but couldn't be loaded back — try reloading the page.");
    return;
  }

  state.persona = runtimePersona;
  state.decision = runtimeDecision;
  closeEditor();
  resetFinancingDefaults(runtimeDecision);
  populatePersonaSelect();
  personaSelect.value = runtimePersona.id;
  renderDecisionTabs();
  renderAll();
  renderComparisonAndPortfolio();

  newDecisionForm.hidden = true;
  newDecisionBtn.hidden = false;

  // The new decision starts with the template's default numbers and
  // obviously-a-placeholder rationale text — open the editor immediately so
  // the person's very next step is replacing them with their own real
  // drivers, assumptions and capital amounts, not stumbling on a "Buy a
  // second delivery van" that quietly still runs on someone else's numbers.
  openEditor();
});

// ---- Scenarios: save/load/export/import ----
//
// A "scenario" is a snapshot of which persona+decision is selected, the
// financing/affordability input values, and — if the current decision has
// edited assumptions — that override, bundled together. Saved scenarios
// live in localStorage (this device only, stated plainly in the UI, not
// implied to be more than that); exporting one to a file and importing it
// elsewhere is the closest a dependency-free static site can honestly get
// to a real audit trail: not automatic, not multi-user, but a real file
// someone can hand to a manager or business partner and get back the exact
// same numbers.

function showScenarioMessage(text: string, isError: boolean): void {
  scenarioMessageEl.hidden = false;
  scenarioMessageEl.className = "editor-messages " + (isError ? "editor-errors" : "editor-warnings-box");
  scenarioMessageEl.textContent = text;
}

function populateScenarioSelect(): void {
  const scenarios = loadScenarios();
  scenarioSelect.innerHTML = "";
  if (scenarios.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No saved scenarios yet";
    opt.disabled = true;
    scenarioSelect.appendChild(opt);
    return;
  }
  for (const scenario of scenarios) {
    const opt = document.createElement("option");
    opt.value = scenario.id;
    const when = new Date(scenario.savedAt).toLocaleDateString();
    opt.textContent = `${scenario.name} — ${scenario.personaId} / ${scenario.decisionId} (${when})`;
    scenarioSelect.appendChild(opt);
  }
}

/** Builds a scenario snapshot of exactly what's currently on screen: the
 * selected persona/decision, the financing and affordability inputs, and
 * the active decision's driver override, if any. */
function buildCurrentScenario(name: string): StoredScenario {
  const decisionId = state.decision.id;
  const override = loadDriverOverride(decisionId);
  const hasFinancing = state.decision.drivers.some((d) => d.id === "capex");
  // A scenario built on a custom persona embeds that persona in full, so
  // exporting it to a file and importing it on another device is fully
  // self-contained rather than silently pointing at a persona that device
  // has never heard of.
  const customPersona = hasPrefix(state.persona.id, CUSTOM_PERSONA_PREFIX) ? loadCustomPersonas().find((p) => p.id === state.persona.id) : undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: generateId(SCENARIO_PREFIX),
    name: name.trim().length > 0 ? name.trim() : "Untitled scenario",
    savedAt: new Date().toISOString(),
    personaId: state.persona.id,
    customPersona,
    decisionId,
    inputs: {
      ...(hasFinancing
        ? { loanToValuePct: Number(ltvInput.value) / 100, annualInterestRate: Number(rateInput.value) / 100, termYears: Number(termInput.value) }
        : {}),
      availableCapital: Number(affordabilityInput.value),
    },
    driverOverride: override,
    warnings: override?.warnings ?? [],
  };
}

/** Selects a persona+decision by id (used by both "load a saved scenario"
 * and "import a scenario file"). Returns false without changing state if
 * either isn't found in this build's known personas — a scenario pointing
 * at a custom persona built on a different device, for instance, which this
 * version's UI has nothing to load it into yet. That's a stated, honest
 * limitation rather than a silent failure. */
function selectPersonaAndDecision(personaId: string, decisionId: string): boolean {
  const persona = allPersonas().find((p) => p.id === personaId);
  if (!persona) return false;
  const decision = persona.decisions.find((d) => d.id === decisionId);
  if (!decision) return false;

  closeEditor();
  state.persona = persona;
  state.decision = decision;
  personaSelect.value = persona.id;
  resetFinancingDefaults(decision);
  renderDecisionTabs();
  return true;
}

function applyScenario(scenario: StoredScenario, sourceLabel: string): void {
  if (!selectPersonaAndDecision(scenario.personaId, scenario.decisionId)) {
    // Not found among what's already on this device — but a scenario built
    // on another device embeds its custom persona in full (see
    // StoredScenario.customPersona), so importing it can still work: install
    // that persona locally (after re-validating it, never trusting an
    // imported file's content as already-safe) and try again.
    const embedded = scenario.customPersona;
    if (embedded && embedded.id === scenario.personaId) {
      try {
        const decisions = embedded.decisions.map(hydrateDecision);
        validatePersona({ id: "__import_check__", name: "import check", tagline: "", decisions });
      } catch {
        showScenarioMessage(`${sourceLabel} embeds a custom persona that fails this app's own validation, so it can't be installed.`, true);
        return;
      }
      upsertCustomPersona(embedded);
      populatePersonaSelect();
    }
    if (!selectPersonaAndDecision(scenario.personaId, scenario.decisionId)) {
      showScenarioMessage(`${sourceLabel} points at "${scenario.personaId} / ${scenario.decisionId}", which this version of the app doesn't have.`, true);
      return;
    }
  }

  if (scenario.driverOverride) {
    saveDriverOverride(scenario.decisionId, scenario.driverOverride);
  } else {
    clearDriverOverride(scenario.decisionId);
  }

  if (scenario.inputs.loanToValuePct !== undefined) ltvInput.value = String(scenario.inputs.loanToValuePct * 100);
  if (scenario.inputs.annualInterestRate !== undefined) rateInput.value = String(scenario.inputs.annualInterestRate * 100);
  if (scenario.inputs.termYears !== undefined) termInput.value = String(scenario.inputs.termYears);
  if (scenario.inputs.availableCapital !== undefined) affordabilityInput.value = String(scenario.inputs.availableCapital);

  renderAll();
  renderComparisonAndPortfolio();

  const warningNote = scenario.warnings.length > 0 ? ` (${scenario.warnings.length} assumption warning(s) carried over — see Edit assumptions.)` : "";
  showScenarioMessage(`Loaded "${scenario.name}".${warningNote}`, false);
}

scenarioSaveBtn.addEventListener("click", () => {
  const scenario = buildCurrentScenario(scenarioNameInput.value);
  saveScenarioRecord(scenario);
  populateScenarioSelect();
  scenarioSelect.value = scenario.id;
  showScenarioMessage(`Saved "${scenario.name}".`, false);
});

scenarioExportBtn.addEventListener("click", () => {
  const scenario = buildCurrentScenario(scenarioNameInput.value || `${state.persona.name} — ${state.decision.label}`);
  const json = exportScenarioToJson(scenario);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${scenario.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "scenario"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// The file input itself stays hidden and out of the tab order (a hidden
// <input type="file"> can't receive keyboard focus at all); a real, focusable
// button triggers it, so importing works the same from a keyboard as a mouse.
scenarioImportBtn.addEventListener("click", () => scenarioImportInput.click());

scenarioImportInput.addEventListener("change", () => {
  const file = scenarioImportInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = typeof reader.result === "string" ? reader.result : "";
    const result = importScenarioFromJson(text);
    if (!result.ok) {
      showScenarioMessage(result.error, true);
      return;
    }
    saveScenarioRecord(result.scenario);
    populateScenarioSelect();
    scenarioSelect.value = result.scenario.id;
    applyScenario(result.scenario, "This file");
  };
  reader.readAsText(file);
  scenarioImportInput.value = ""; // allow importing the same file again later
});

scenarioLoadBtn.addEventListener("click", () => {
  const scenario = loadScenarios().find((s) => s.id === scenarioSelect.value);
  if (!scenario) return;
  applyScenario(scenario, `"${scenario.name}"`);
});

scenarioDeleteBtn.addEventListener("click", () => {
  const scenario = loadScenarios().find((s) => s.id === scenarioSelect.value);
  if (!scenario) return;
  deleteScenario(scenario.id);
  populateScenarioSelect();
  showScenarioMessage(`Deleted "${scenario.name}".`, false);
});

// ---- Comparison + portfolio affordability (persona-level, not per-decision) ----

function renderComparisonAndPortfolio(): void {
  const rows = compareDecisions(state.persona.decisions, { iterations: ITERATIONS, seed: SEED });
  comparisonTableBody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const statusClass = verdictStatusClass(row.verdict.verdict);
    tr.innerHTML = `
      <td>${row.label}</td>
      <td class="num">${formatCompactAud(row.percentiles.p50)}</td>
      <td class="num">${(row.probabilityPositive * 100).toFixed(0)}%</td>
      <td><span class="pill ${statusClass}">${row.verdict.verdict}</span></td>
    `;
    comparisonTableBody.appendChild(tr);
  }
  computeAffordability();
}

function computeAffordability(): void {
  const availableCapital = Number(affordabilityInput.value);
  const result = portfolioAffordability(state.persona.decisions, availableCapital, { iterations: ITERATIONS, seed: SEED });
  affordabilityResult.innerHTML = "";
  const line1 = document.createElement("p");
  line1.className = "audience-text";
  line1.textContent = `Probability the combined year-0 outlay fits within ${formatCompactAud(availableCapital)}: ${(result.probabilityAffordable * 100).toFixed(0)}%.`;
  const line2 = document.createElement("p");
  line2.className = "audience-text audience-muted";
  line2.textContent = `Combined NPV — P90: ${formatCompactAud(result.combinedNpvPercentiles.p90)}  P50: ${formatCompactAud(result.combinedNpvPercentiles.p50)}  P10: ${formatCompactAud(result.combinedNpvPercentiles.p10)}`;
  affordabilityResult.appendChild(line1);
  affordabilityResult.appendChild(line2);
}

affordabilityInput.addEventListener("input", debounce(computeAffordability, 300));

// ---- Boot ----

populatePersonaSelect();
resetFinancingDefaults(state.decision);
renderDecisionTabs();
renderAll();
renderComparisonAndPortfolio();
populateScenarioSelect();
