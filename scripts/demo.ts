import { runMonteCarlo, runBaseCase } from "../src/engine/montecarlo.ts";
import { percentiles, probabilityExceeds } from "../src/engine/percentiles.ts";
import { tornadoAnalysis } from "../src/engine/tornado.ts";
import { solveForZeroNpv } from "../src/engine/goalseek.ts";
import { decisionVerdict } from "../src/engine/verdict.ts";
import { representativeCashFlows } from "../src/engine/scenarios.ts";
import { compareDecisions, portfolioAffordability } from "../src/engine/portfolio.ts";
import { varianceContribution } from "../src/engine/variance.ts";
import { runStressScenario } from "../src/engine/stress.ts";
import { runSequencedPortfolio, covenantCheck } from "../src/engine/sequence.ts";
import { operationalBrief, financialDetailView, riskBriefView } from "../src/engine/views.ts";
import { manufacturerPersona } from "../src/personas/manufacturer.ts";

const ITERATIONS = 20000;
const SEED = 42;

for (const decision of manufacturerPersona.decisions) {
  console.log(`\n=== ${decision.label} ===`);
  const base = runBaseCase(decision);
  console.log(`Base case NPV: $${base.npv.toFixed(0)}  |  payback: ${base.payback?.toFixed(2) ?? "never"} yrs`);

  const { npvSamples, cashFlowSamples } = runMonteCarlo(decision, { iterations: ITERATIONS, seed: SEED, captureCashFlows: true });
  const p = percentiles(npvSamples);
  console.log(
    `NPV  P90: $${p.p90.toFixed(0)}   P50: $${p.p50.toFixed(0)}   P10: $${p.p10.toFixed(0)}   mean: $${p.mean.toFixed(0)}`,
  );
  const probabilityPositive = probabilityExceeds(npvSamples, 0);
  console.log(`Probability NPV > 0: ${(probabilityPositive * 100).toFixed(1)}%`);

  const verdict = decisionVerdict(probabilityPositive);
  console.log(`Verdict: ${verdict.verdict} — ${verdict.rationale}`);

  const tornado = tornadoAnalysis(decision);
  console.log("Tornado (ranked by NPV swing):");
  for (const row of tornado) {
    console.log(`  ${row.label.padEnd(35)} swing: $${row.swing.toFixed(0)}`);
  }

  const topDriverId = tornado[0].driverId;
  const goalSeek = solveForZeroNpv(decision, topDriverId);
  if (goalSeek.solvedValue !== null) {
    console.log(
      `Goal-seek: "${tornado[0].label}" would need to be ~${goalSeek.solvedValue.toFixed(2)} (base case: ${goalSeek.baseCaseValue.toFixed(2)}) for NPV to hit breakeven.`,
    );
  } else {
    console.log(`Goal-seek: ${goalSeek.note}`);
  }

  const rep = representativeCashFlows(npvSamples, cashFlowSamples!, p);
  console.log("Representative year-by-year cash flow (an actual simulated trial nearest each percentile, not a synthesized composite):");
  console.log(`  P90 scenario: ${rep.p90.map((v) => `$${v.toFixed(0)}`).join(", ")}`);
  console.log(`  P50 scenario: ${rep.p50.map((v) => `$${v.toFixed(0)}`).join(", ")}`);
  console.log(`  P10 scenario: ${rep.p10.map((v) => `$${v.toFixed(0)}`).join(", ")}`);

  const { inputsSamples } = runMonteCarlo(decision, { iterations: ITERATIONS, seed: SEED, captureInputs: true });
  const varianceRows = varianceContribution(decision, npvSamples, inputsSamples!);
  console.log("Variance contribution (share of simulated NPV spread explained by each driver, correlation-based approximation):");
  for (const row of varianceRows.slice(0, 4)) {
    console.log(`  ${row.label.padEnd(35)} ${(row.varianceShare * 100).toFixed(1)}%  (r=${row.correlation.toFixed(2)})`);
  }

  console.log("\n-- Audience-specific views --");
  console.log(`[Executor]  ${operationalBrief(decision, verdict)}`);
  const financial = financialDetailView(decision, p, varianceRows);
  console.log(
    `[CFO]       Tax rate (base case): ${financial.taxRateBaseCase !== null ? (financial.taxRateBaseCase * 100).toFixed(1) + "%" : "n/a"}  |  top variance driver: ${financial.topVarianceDrivers[0]?.label ?? "n/a"}`,
  );
  const risk = riskBriefView(decision, p, rep.p90);
  console.log(`[Lender]    Downside (P90) NPV: $${risk.downsideNpv.toFixed(0)}  |  ${risk.note}`);
}

console.log("\n=== Cross-decision comparison ===");
const comparison = compareDecisions(manufacturerPersona.decisions, { iterations: ITERATIONS, seed: SEED });
for (const row of comparison) {
  console.log(
    `${row.label.padEnd(40)} P50: $${row.percentiles.p50.toFixed(0).padStart(10)}   Prob>0: ${(row.probabilityPositive * 100).toFixed(0).padStart(3)}%   Verdict: ${row.verdict.verdict}`,
  );
}

console.log("\n=== Portfolio affordability (fund all three decisions together) ===");
const AVAILABLE_CAPITAL = 350000; // illustrative available capital budget
const affordability = portfolioAffordability(manufacturerPersona.decisions, AVAILABLE_CAPITAL, { iterations: ITERATIONS, seed: SEED });
console.log(`Available capital: $${AVAILABLE_CAPITAL.toLocaleString()}`);
console.log(`Probability the combined year-0 outlay fits within budget: ${(affordability.probabilityAffordable * 100).toFixed(1)}%`);
console.log(
  `Combined NPV  P90: $${affordability.combinedNpvPercentiles.p90.toFixed(0)}   P50: $${affordability.combinedNpvPercentiles.p50.toFixed(0)}   P10: $${affordability.combinedNpvPercentiles.p10.toFixed(0)}`,
);
console.log(`Probability combined NPV > 0: ${(affordability.probabilityCombinedPositive * 100).toFixed(1)}%`);
console.log(affordability.note);

console.log("\n=== Named compound stress scenario ===");
const [capexDecision, contractDecision] = manufacturerPersona.decisions;
const stress = runStressScenario(contractDecision, { iterations: ITERATIONS, seed: SEED }, {
  label: "Margin compression AND above-median cost inflation",
  matches: (inputs) => inputs.grossMarginPct < 0.2 && inputs.inputCostInflationPct > 0.04,
});
console.log(`Scenario: "${stress.label}"`);
console.log(stress.note);
if (stress.npvPercentiles) {
  console.log(
    `NPV under this specific compound condition — P90: $${stress.npvPercentiles.p90.toFixed(0)}   P50: $${stress.npvPercentiles.p50.toFixed(0)}   P10: $${stress.npvPercentiles.p10.toFixed(0)}`,
  );
  console.log(`Representative cash flow under this scenario: ${stress.representativeCashFlows!.map((v) => `$${v.toFixed(0)}`).join(", ")}`);
}

console.log("\n=== Sequenced/dependent decisions: CNC line feeds second-shift capacity ===");
const headcountDecision = manufacturerPersona.decisions[2];
const sequenced = runSequencedPortfolio(
  [
    { decision: capexDecision, startYear: 0 },
    {
      decision: headcountDecision,
      startYear: 1, // hire the second shift a year after the new line comes online
      dependsOn: {
        decisionId: capexDecision.id,
        adjust: (inputs, upstream) => ({
          ...inputs,
          // the second shift can't sell more than the new line actually produces in this trial
          demandRampUnitsPerYear: Math.min(inputs.demandRampUnitsPerYear, upstream.incrementalUnitsPerYear),
        }),
      },
    },
  ],
  { iterations: ITERATIONS, seed: SEED },
);
const sequencedNpvPct = percentiles(sequenced.combinedNpvSamples);
console.log("CNC line (year 0) -> second-shift headcount (year 1), demand capped by the line's actual sampled capacity per trial:");
console.log(
  `Combined NPV  P90: $${sequencedNpvPct.p90.toFixed(0)}   P50: $${sequencedNpvPct.p50.toFixed(0)}   P10: $${sequencedNpvPct.p10.toFixed(0)}`,
);

const COVENANT_FLOOR = -300000; // illustrative minimum cash balance the business must not breach
const covenant = covenantCheck(sequenced.minimumCumulativeCashSamples, COVENANT_FLOOR);
console.log(`Covenant/cash-floor check: can the combined cash balance stay above $${COVENANT_FLOOR.toLocaleString()} at every point on the calendar?`);
console.log(`Probability within floor: ${(covenant.probabilityWithinFloor * 100).toFixed(1)}%`);
console.log(
  `Worst-point cash balance across trials — P90: $${covenant.minimumCashPercentiles.p90.toFixed(0)}   P50: $${covenant.minimumCashPercentiles.p50.toFixed(0)}   P10: $${covenant.minimumCashPercentiles.p10.toFixed(0)}`,
);
console.log(covenant.note);
