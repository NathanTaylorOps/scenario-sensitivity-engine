import { personas } from "../personas/index.ts";
import type { Decision, Persona } from "../engine/types.ts";
import { runMonteCarlo, runBaseCase } from "../engine/montecarlo.ts";
import { percentiles, probabilityExceeds } from "../engine/percentiles.ts";
import { tornadoAnalysis } from "../engine/tornado.ts";
import { decisionVerdict, type VerdictResult } from "../engine/verdict.ts";
import { varianceContribution } from "../engine/variance.ts";
import { representativeCashFlows } from "../engine/scenarios.ts";
import { compareDecisions, portfolioAffordability } from "../engine/portfolio.ts";
import { operationalBrief, financialDetailView, riskBriefView } from "../engine/views.ts";
import { runDscrAnalysis, LoanTermsError } from "../engine/financing.ts";
import { renderTornadoChart, renderRangeChart, formatCompactUsd } from "./charts.ts";

const ITERATIONS = 20000;
const SEED = 42;

const state: { persona: Persona; decision: Decision } = {
  persona: personas[0],
  decision: personas[0].decisions[0],
};

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

// ---- Persona / decision selection ----

function populatePersonaSelect(): void {
  personaSelect.innerHTML = "";
  for (const persona of personas) {
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = persona.name;
    personaSelect.appendChild(option);
  }
  personaSelect.value = state.persona.id;
}

function renderDecisionTabs(): void {
  decisionTabs.innerHTML = "";
  for (const decision of state.persona.decisions) {
    const button = document.createElement("button");
    button.className = "tab" + (decision.id === state.decision.id ? " tab-active" : "");
    button.textContent = decision.label;
    button.addEventListener("click", () => {
      state.decision = decision;
      renderDecisionTabs();
      renderAll();
    });
    decisionTabs.appendChild(button);
  }
}

personaSelect.addEventListener("change", () => {
  const persona = personas.find((p) => p.id === personaSelect.value);
  if (!persona) return;
  state.persona = persona;
  state.decision = persona.decisions[0];
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
    { label: "Base-case NPV", value: formatCompactUsd(baseNpv), tied: false },
    { label: "Base-case payback", value: basePayback === null ? "Never" : `${basePayback.toFixed(1)} yrs`, tied: false },
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
  const decision = state.decision;
  decisionDescription.textContent = decision.description;
  sectionBandDecisionLabel.textContent = decision.label;

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
  executorP.textContent = operationalBrief(decision, verdict);
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
  lenderSummary.textContent = `Downside (P90) NPV: ${formatCompactUsd(risk.downsideNpv)}. ${risk.note}`;
  audienceLenderEl.appendChild(lenderSummary);
  if (risk.downsideRepresentativeCashFlows) {
    const cashLine = document.createElement("p");
    cashLine.className = "audience-text audience-muted";
    cashLine.textContent = `Representative P90 cash flow: ${risk.downsideRepresentativeCashFlows.map((v) => formatCompactUsd(v)).join(", ")}`;
    audienceLenderEl.appendChild(cashLine);
  }

  renderFinancingSection(decision);
}

// ---- Debt financing / DSCR ----

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

    let dscr;
    try {
      dscr = runDscrAnalysis(decision, { loanToValuePct, annualInterestRate, termYears }, covenantMinDscr, { iterations: ITERATIONS, seed: SEED });
    } catch (err) {
      // Caught in review: invalid loan terms (a 0-year term, an out-of-range loan-to-value,
      // a negative rate) used to fall through to the engine's empty-schedule case and get
      // reported as a misleading "100% probability of meeting the covenant." Now they're
      // rejected explicitly, and the UI shows the rejection instead of a plausible-looking
      // number.
      if (err instanceof LoanTermsError) {
        const errorEl = document.createElement("p");
        errorEl.className = "audience-text financing-error";
        errorEl.textContent = err.message;
        financingResult.appendChild(errorEl);
        return;
      }
      throw err;
    }

    const line1 = document.createElement("p");
    line1.className = "audience-text";
    line1.textContent = `Probability the worst year's DSCR stays above ${covenantMinDscr}x: ${(dscr.probabilityAboveCovenant * 100).toFixed(0)}%.`;
    const line2 = document.createElement("p");
    line2.className = "audience-text audience-muted";
    const p90 = Number.isFinite(dscr.minimumDscrPercentiles.p90) ? dscr.minimumDscrPercentiles.p90.toFixed(2) : "n/a";
    const p50 = Number.isFinite(dscr.minimumDscrPercentiles.p50) ? dscr.minimumDscrPercentiles.p50.toFixed(2) : "n/a";
    const p10 = Number.isFinite(dscr.minimumDscrPercentiles.p10) ? dscr.minimumDscrPercentiles.p10.toFixed(2) : "n/a";
    line2.textContent = `Worst-year DSCR across trials — P90: ${p90}x  P50: ${p50}x  P10: ${p10}x`;
    const noteEl = document.createElement("p");
    noteEl.className = "audience-text audience-muted";
    noteEl.textContent = dscr.note;
    financingResult.appendChild(line1);
    financingResult.appendChild(line2);
    financingResult.appendChild(noteEl);
  };

  const debouncedCompute = debounce(compute, 300);
  ltvInput.oninput = debouncedCompute;
  rateInput.oninput = debouncedCompute;
  termInput.oninput = debouncedCompute;
  compute();
}

// ---- Comparison + portfolio affordability (persona-level, not per-decision) ----

function renderComparisonAndPortfolio(): void {
  const rows = compareDecisions(state.persona.decisions, { iterations: ITERATIONS, seed: SEED });
  comparisonTableBody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const statusClass = verdictStatusClass(row.verdict.verdict);
    tr.innerHTML = `
      <td>${row.label}</td>
      <td class="num">${formatCompactUsd(row.percentiles.p50)}</td>
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
  line1.textContent = `Probability the combined year-0 outlay fits within ${formatCompactUsd(availableCapital)}: ${(result.probabilityAffordable * 100).toFixed(0)}%.`;
  const line2 = document.createElement("p");
  line2.className = "audience-text audience-muted";
  line2.textContent = `Combined NPV — P90: ${formatCompactUsd(result.combinedNpvPercentiles.p90)}  P50: ${formatCompactUsd(result.combinedNpvPercentiles.p50)}  P10: ${formatCompactUsd(result.combinedNpvPercentiles.p10)}`;
  affordabilityResult.appendChild(line1);
  affordabilityResult.appendChild(line2);
}

affordabilityInput.addEventListener("input", debounce(computeAffordability, 300));

// ---- Boot ----

populatePersonaSelect();
renderDecisionTabs();
renderAll();
renderComparisonAndPortfolio();
