import test from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/engine/rng.ts";
import { sample, baseCase, sensitivityBounds, quantile, inverseStandardNormalCdf, betaCdf, type Distribution } from "../src/engine/distributions.ts";
import { npv, paybackPeriod, discountedPaybackPeriod, breakevenVolume } from "../src/engine/financial.ts";
import { percentiles, probabilityExceeds } from "../src/engine/percentiles.ts";
import { runMonteCarlo, runBaseCase, convergenceTrace, baseCaseInputs, sharedDiscountRateDriver } from "../src/engine/montecarlo.ts";
import { tornadoAnalysis } from "../src/engine/tornado.ts";
import { afterTaxCashFlows } from "../src/engine/tax.ts";
import { solveForZeroNpv, feasibleDomain } from "../src/engine/goalseek.ts";
import { decisionVerdict } from "../src/engine/verdict.ts";
import { nearestScenario, representativeCashFlows } from "../src/engine/scenarios.ts";
import { compareDecisions, runPortfolioMonteCarlo, portfolioAffordability } from "../src/engine/portfolio.ts";
import { guardInputs } from "../src/engine/guardedInputs.ts";
import { varianceContribution } from "../src/engine/variance.ts";
import { runStressScenario } from "../src/engine/stress.ts";
import { runSequencedPortfolio, covenantCheck } from "../src/engine/sequence.ts";
import { operationalBrief, financialDetailView, riskBriefView } from "../src/engine/views.ts";
import { validatePersona, PersonaValidationError } from "../src/engine/validation.ts";
import { amortizationSchedule, debtScheduleForHorizon, financeDecision, debtServiceCoverageRatio, runDscrAnalysis, runFinancingAnalysis, validateLoanTerms, LoanTermsError } from "../src/engine/financing.ts";
import type { Decision, Persona } from "../src/engine/types.ts";
import { manufacturerPersona } from "../src/personas/manufacturer.ts";
import { personas, findPersona, mineSiteServicesPersona, shortStayAccommodationPersona, softwareConsultancyPersona } from "../src/personas/index.ts";

// --- RNG: determinism ---

test("createRng is deterministic for a fixed seed", () => {
  const a = createRng(42);
  const b = createRng(42);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test("createRng produces values in [0, 1)", () => {
  const rng = createRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `sample ${v} out of range`);
  }
});

// --- Distributions: statistical property tests (not exact-value asserts) ---

test("triangular sample mean is within tolerance of (min+mode+max)/3 over many draws", () => {
  const dist: Distribution = { kind: "triangular", min: 10, mode: 20, max: 50 };
  const rng = createRng(1);
  const n = 50000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sample(dist, rng);
  const empiricalMean = sum / n;
  const theoreticalMean = (10 + 20 + 50) / 3;
  assert.ok(
    Math.abs(empiricalMean - theoreticalMean) < theoreticalMean * 0.02,
    `empirical mean ${empiricalMean} too far from theoretical ${theoreticalMean}`,
  );
});

test("triangular samples stay within [min, max]", () => {
  const dist: Distribution = { kind: "triangular", min: 5, mode: 8, max: 12 };
  const rng = createRng(2);
  for (let i = 0; i < 20000; i++) {
    const v = sample(dist, rng);
    assert.ok(v >= 5 && v <= 12, `sample ${v} out of [5, 12]`);
  }
});

test("pert samples stay within [min, max] and cluster near mode", () => {
  const dist: Distribution = { kind: "pert", min: 100, mode: 150, max: 400 };
  const rng = createRng(3);
  const n = 30000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = sample(dist, rng);
    assert.ok(v >= 100 && v <= 400, `sample ${v} out of [100, 400]`);
    sum += v;
  }
  const empiricalMean = sum / n;
  const theoreticalMean = (100 + 4 * 150 + 400) / 6;
  assert.ok(
    Math.abs(empiricalMean - theoreticalMean) < theoreticalMean * 0.05,
    `empirical mean ${empiricalMean} too far from theoretical ${theoreticalMean}`,
  );
});

test("pert with mode exactly at the midpoint of [min, max] still weights toward the mode (regression: was silently uniform)", () => {
  const dist: Distribution = { kind: "pert", min: 250000, mode: 600000, max: 950000 };
  const rng = createRng(6);
  const n = 40000;
  const values = Array.from({ length: n }, () => sample(dist, rng));
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const range = 950000 - 250000;
  const uniformVariance = (range * range) / 12; // what a Beta(1,1) i.e. uniform would give
  assert.ok(
    variance < uniformVariance * 0.7,
    `variance ${variance} is too close to the uniform-distribution variance ${uniformVariance} — PERT should concentrate mass near the mode, not spread it uniformly`,
  );
  for (const v of values) assert.ok(v >= 250000 && v <= 950000);
});

test("lognormal samples are always positive", () => {
  const dist: Distribution = { kind: "lognormal", median: 1.05, sigma: 0.3 };
  const rng = createRng(4);
  for (let i = 0; i < 10000; i++) {
    assert.ok(sample(dist, rng) > 0);
  }
});

test("normal sample mean/stdDev converge to parameters over many draws", () => {
  const dist: Distribution = { kind: "normal", mean: 50, stdDev: 10 };
  const rng = createRng(5);
  const n = 50000;
  const values = Array.from({ length: n }, () => sample(dist, rng));
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  assert.ok(Math.abs(mean - 50) < 0.5, `mean ${mean} too far from 50`);
  assert.ok(Math.abs(Math.sqrt(variance) - 10) < 0.5, `stdDev ${Math.sqrt(variance)} too far from 10`);
});

test("baseCase matches each distribution's analytical mean", () => {
  assert.equal(baseCase({ kind: "constant", value: 7 }), 7);
  assert.equal(baseCase({ kind: "triangular", min: 0, mode: 6, max: 12 }), 6);
  assert.equal(baseCase({ kind: "pert", min: 0, mode: 6, max: 12 }), 6);
  assert.equal(baseCase({ kind: "normal", mean: 3, stdDev: 1 }), 3);
  assert.equal(baseCase({ kind: "lognormal", median: 2, sigma: 1 }), 2);
});

test("baseCase honours a custom PERT lambda", () => {
  assert.equal(baseCase({ kind: "pert", min: 0, mode: 6, max: 12, lambda: 2 }), (0 + 2 * 6 + 12) / 4);
});

// --- Analytical quantiles (the basis for every tornado bound) ---

test("inverseStandardNormalCdf matches known z-scores", () => {
  assert.ok(Math.abs(inverseStandardNormalCdf(0.9) - 1.2815515655446004) < 1e-7);
  assert.ok(Math.abs(inverseStandardNormalCdf(0.1) + 1.2815515655446004) < 1e-7);
  assert.ok(Math.abs(inverseStandardNormalCdf(0.5)) < 1e-12);
  assert.ok(Math.abs(inverseStandardNormalCdf(0.975) - 1.959963984540054) < 1e-7);
});

test("betaCdf matches closed-form special cases", () => {
  // Beta(1,1) is uniform: CDF(x) = x.
  assert.ok(Math.abs(betaCdf(0.3, 1, 1) - 0.3) < 1e-12);
  // Beta(2,1): CDF(x) = x^2.
  assert.ok(Math.abs(betaCdf(0.5, 2, 1) - 0.25) < 1e-12);
  // Beta(1,2): CDF(x) = 1 - (1-x)^2.
  assert.ok(Math.abs(betaCdf(0.5, 1, 2) - 0.75) < 1e-12);
  // Symmetric Beta(3,3): median is 0.5.
  assert.ok(Math.abs(betaCdf(0.5, 3, 3) - 0.5) < 1e-12);
});

test("quantile of a triangular distribution inverts its CDF exactly", () => {
  const dist: Distribution = { kind: "triangular", min: 10, mode: 20, max: 50 };
  const cdf = (x: number) => (x < 20 ? ((x - 10) * (x - 10)) / ((50 - 10) * (20 - 10)) : 1 - ((50 - x) * (50 - x)) / ((50 - 10) * (50 - 20)));
  for (const p of [0.05, 0.1, 0.25, 0.5, 0.9, 0.99]) {
    assert.ok(Math.abs(cdf(quantile(dist, p)) - p) < 1e-12, `CDF(quantile(${p})) should equal ${p}`);
  }
  assert.equal(quantile(dist, 0), 10);
  assert.equal(quantile(dist, 1), 50);
});

test("quantile of a PERT distribution agrees with the empirical quantile of its own samples", () => {
  const dist: Distribution = { kind: "pert", min: 100, mode: 150, max: 400 };
  const rng = createRng(31);
  const n = 60000;
  const values = Array.from({ length: n }, () => sample(dist, rng)).sort((a, b) => a - b);
  for (const p of [0.1, 0.5, 0.9]) {
    const empirical = values[Math.floor(p * n)];
    const analytical = quantile(dist, p);
    assert.ok(Math.abs(empirical - analytical) < (400 - 100) * 0.01, `p=${p}: empirical ${empirical} vs analytical ${analytical}`);
  }
});

test("quantile of a symmetric PERT is symmetric about the mode", () => {
  const dist: Distribution = { kind: "pert", min: 0, mode: 50, max: 100 };
  assert.ok(Math.abs(quantile(dist, 0.5) - 50) < 1e-9);
  assert.ok(Math.abs(quantile(dist, 0.1) + quantile(dist, 0.9) - 100) < 1e-9);
});

test("quantile of normal and lognormal distributions match their closed forms", () => {
  const z90 = 1.2815515655446004;
  assert.ok(Math.abs(quantile({ kind: "normal", mean: 10, stdDev: 2 }, 0.9) - (10 + 2 * z90)) < 1e-6);
  assert.ok(Math.abs(quantile({ kind: "lognormal", median: 0.03, sigma: 0.5 }, 0.1) - Math.exp(Math.log(0.03) - 0.5 * z90)) < 1e-9);
});

test("sensitivityBounds is the P10-P90 pair for every distribution family, not min/max for the bounded ones", () => {
  const tri: Distribution = { kind: "triangular", min: 1, mode: 2, max: 9 };
  const triBounds = sensitivityBounds(tri);
  assert.ok(triBounds.low > 1 && triBounds.high < 9, "a bounded distribution's tornado swing must sit strictly inside its min/max");
  assert.deepEqual(triBounds, { low: quantile(tri, 0.1), high: quantile(tri, 0.9) });

  const pert: Distribution = { kind: "pert", min: 150000, mode: 250000, max: 500000 };
  const pertBounds = sensitivityBounds(pert);
  assert.ok(pertBounds.low > 150000 && pertBounds.high < 500000);

  const normalBounds = sensitivityBounds({ kind: "normal", mean: 10, stdDev: 2 });
  assert.ok(Math.abs(10 - normalBounds.low - (normalBounds.high - 10)) < 1e-9, "bounds should be symmetric around the mean");

  assert.deepEqual(sensitivityBounds({ kind: "constant", value: 3 }), { low: 3, high: 3 });
});

// --- Floored normal (non-negative demand) ---

test("a normal distribution with min: 0 never samples below zero, and its quantiles respect the floor", () => {
  const dist: Distribution = { kind: "normal", mean: 100, stdDev: 80, min: 0 };
  const rng = createRng(77);
  let clamped = 0;
  for (let i = 0; i < 20000; i++) {
    const v = sample(dist, rng);
    assert.ok(v >= 0, `sample ${v} below the floor`);
    if (v === 0) clamped++;
  }
  assert.ok(clamped > 0, "with mean 1.25 sd above zero, some draws should have hit the floor");
  assert.equal(quantile(dist, 0.01), 0);
  assert.ok(quantile(dist, 0.9) > 100);
});

test("the personas' demand drivers are floored at zero", () => {
  for (const persona of personas) {
    for (const decision of persona.decisions) {
      for (const driver of decision.drivers) {
        if (driver.distribution.kind === "normal") {
          assert.equal(driver.distribution.min, 0, `${persona.id}/${decision.id}/${driver.id} should be floored at 0`);
        }
      }
    }
  }
});

test("validatePersona rejects a normal floor that sits above the mean", () => {
  const bad: Persona = {
    id: "bad-floor",
    name: "Bad floor",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [{ id: "x", label: "X", unit: "units/yr", category: "revenue", distribution: { kind: "normal", mean: 10, stdDev: 2, min: 50 }, rationale: "test" }],
      }),
    ],
  };
  assert.throws(() => validatePersona(bad), PersonaValidationError);
});

// --- Financial math: edge cases and known values ---

test("npv of a simple two-year even cash flow matches hand calculation", () => {
  const result = npv(0.1, [-100, 60, 60]);
  const expected = -100 + 60 / 1.1 + 60 / 1.21;
  assert.ok(Math.abs(result - expected) < 1e-9);
});

test("npv with zero cash flows after year 0 equals the initial outlay", () => {
  assert.equal(npv(0.1, [-500, 0, 0, 0]), -500);
});

test("paybackPeriod finds the correct fractional year", () => {
  const years = paybackPeriod([-100, 40, 40, 40]);
  assert.ok(years !== null && years > 2 && years < 3);
});

test("paybackPeriod returns null when never recovered", () => {
  assert.equal(paybackPeriod([-1000, 10, 10, 10]), null);
});

test("paybackPeriod returns 0 only when the cumulative position never goes negative", () => {
  assert.equal(paybackPeriod([50, 10, 10]), 0);
  assert.equal(paybackPeriod([0, 10, 10]), 0);
});

test("paybackPeriod measures a deferred outlay (zero year 0, loss in year 1) from t=0, not as instant recovery", () => {
  // A hiring decision: no capex, wages exceed revenue in year 1, recovered during year 4.
  // Cumulative: 0, -32000, -17000, -2000, +13000 -> recovery 2000/15000 into year 4.
  const years = paybackPeriod([0, -32000, 15000, 15000, 15000]);
  assert.ok(years !== null);
  assert.ok(Math.abs(years! - (3 + 2000 / 15000)) < 1e-9, `expected ~3.13 years, got ${years}`);
});

test("paybackPeriod returns null for a deferred outlay that is never recovered, never 0", () => {
  assert.equal(paybackPeriod([0, -32000, 15000]), null);
  assert.equal(paybackPeriod([0, -155320, -116603]), null);
});

test("discountedPaybackPeriod is never shorter than simple payback for a positive discount rate", () => {
  const flows = [-1000, 400, 400, 400, 400];
  const simple = paybackPeriod(flows)!;
  const discounted = discountedPaybackPeriod(0.1, flows)!;
  assert.ok(discounted >= simple);
});

test("breakevenVolume matches fixed costs / contribution margin", () => {
  assert.equal(breakevenVolume(10000, 25, 15), 1000);
});

test("breakevenVolume returns Infinity when contribution margin is non-positive", () => {
  assert.equal(breakevenVolume(10000, 10, 10), Infinity);
});

// --- Percentiles: exceedance convention ---

test("percentiles: P90 is the low value, P10 is the high value (exceedance convention)", () => {
  const values = Array.from({ length: 1000 }, (_, i) => i); // 0..999
  const p = percentiles(values);
  assert.ok(p.p90 < p.p50 && p.p50 < p.p10, "expected p90 < p50 < p10 under exceedance convention");
});

test("probabilityExceeds counts correctly against a known threshold", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(probabilityExceeds(values, 6), 0.5);
});

// --- Monte Carlo runner: determinism, convergence, sanity ---

test("runMonteCarlo is fully reproducible for a fixed seed", () => {
  const decision = manufacturerPersona.decisions[0];
  const a = runMonteCarlo(decision, { iterations: 2000, seed: 123 });
  const b = runMonteCarlo(decision, { iterations: 2000, seed: 123 });
  assert.deepEqual(a.npvSamples, b.npvSamples);
});

test("runMonteCarlo with a different seed produces a different sample path", () => {
  const decision = manufacturerPersona.decisions[0];
  const a = runMonteCarlo(decision, { iterations: 500, seed: 1 });
  const b = runMonteCarlo(decision, { iterations: 500, seed: 2 });
  assert.notDeepEqual(a.npvSamples, b.npvSamples);
});

test("convergenceTrace running mean stabilizes as iteration count grows", () => {
  const decision = manufacturerPersona.decisions[0];
  const trace = convergenceTrace(decision, { iterations: 20000, seed: 99 }, 1000);
  const early = trace[0];
  const late = trace[trace.length - 1];
  const veryLate = trace[trace.length - 2];
  // The running mean should move much less between the last two checkpoints
  // than it did in the first 1000 iterations vs. the true late estimate.
  const earlyDelta = Math.abs(early - late);
  const lateDelta = Math.abs(veryLate - late);
  assert.ok(lateDelta < earlyDelta, "running mean should stabilize (law of large numbers)");
});

test("runBaseCase is deterministic (no randomness) and internally consistent with cashFlows", () => {
  const decision = manufacturerPersona.decisions[0];
  const a = runBaseCase(decision);
  const b = runBaseCase(decision);
  assert.deepEqual(a, b);
  assert.equal(a.cashFlows[0] < 0, true, "capex decision should have a negative year-0 outlay");
});

test("all three manufacturer decisions run without throwing and produce finite NPV samples", () => {
  for (const decision of manufacturerPersona.decisions) {
    const result = runMonteCarlo(decision, { iterations: 1000, seed: 555 });
    assert.equal(result.npvSamples.length, 1000);
    for (const v of result.npvSamples) {
      assert.ok(Number.isFinite(v), `decision ${decision.id} produced a non-finite NPV sample`);
    }
  }
});

// --- Tornado / sensitivity analysis ---

test("tornadoAnalysis ranks drivers by descending swing", () => {
  const decision = manufacturerPersona.decisions[0];
  const rows = tornadoAnalysis(decision);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].swing >= rows[i].swing, "tornado rows should be sorted by descending swing");
  }
});

test("tornadoAnalysis covers every driver plus the discount rate exactly once", () => {
  const decision = manufacturerPersona.decisions[0];
  const rows = tornadoAnalysis(decision);
  assert.equal(rows.length, decision.drivers.length + 1);
  const ids = new Set(rows.map((r) => r.driverId));
  assert.equal(ids.size, decision.drivers.length + 1);
  assert.ok(ids.has(decision.discountRate.id), "the hurdle rate must appear in the tornado ranking");
});

test("tornadoAnalysis: the discount-rate row swings NPV between the rate's P10 and P90, everything else at base case", () => {
  const decision = manufacturerPersona.decisions[0];
  const row = tornadoAnalysis(decision).find((r) => r.driverId === decision.discountRate.id)!;
  const bounds = sensitivityBounds(decision.discountRate.distribution);
  const inputs = baseCaseInputs(decision);
  const atLow = npv(bounds.low, decision.cashFlows(inputs, 0));
  const atHigh = npv(bounds.high, decision.cashFlows(inputs, 0));
  assert.ok(Math.abs(row.swing - Math.abs(atHigh - atLow)) < 1e-6);
  assert.ok(row.swing > 0, "a sampled hurdle rate must show a non-zero NPV swing");
});

// --- Edge cases: degenerate / zero-variance inputs ---

test("engine handles a zero-variance (constant) distribution without error", () => {
  const rng = createRng(1);
  const dist: Distribution = { kind: "constant", value: 42 };
  for (let i = 0; i < 100; i++) assert.equal(sample(dist, rng), 42);
});

test("engine handles a degenerate triangular distribution (min == mode == max)", () => {
  const rng = createRng(1);
  const dist: Distribution = { kind: "triangular", min: 5, mode: 5, max: 5 };
  for (let i = 0; i < 100; i++) assert.equal(sample(dist, rng), 5);
});

// --- Tax/depreciation ---

test("afterTaxCashFlows: year-0 outlay passes through unchanged (not a taxable event)", () => {
  const result = afterTaxCashFlows([-100000, 40000, 40000], { capex: 100000, usefulLifeYears: 5, taxRate: 0.25 });
  assert.equal(result[0], -100000);
});

test("afterTaxCashFlows: known-value depreciation tax shield matches hand calculation", () => {
  // $100k capex, 5yr straight-line => $20k/yr depreciation. Year 1 pretax
  // operating cash flow of $40k => taxable income = 40000 - 20000 = 20000,
  // tax = 0.25 * 20000 = 5000, after-tax cash flow = 40000 - 5000 = 35000.
  const result = afterTaxCashFlows([-100000, 40000], { capex: 100000, usefulLifeYears: 5, taxRate: 0.25 });
  assert.ok(Math.abs(result[1] - 35000) < 1e-9, `expected 35000, got ${result[1]}`);
});

test("afterTaxCashFlows: no tax charged on negative taxable income (no loss carryforward modeled)", () => {
  const result = afterTaxCashFlows([-100000, -5000], { capex: 100000, usefulLifeYears: 5, taxRate: 0.25 });
  assert.equal(result[1], -5000, "a loss year should pass through untaxed, not generate a tax credit");
});

test("afterTaxCashFlows: salvage value is taxed only on the gain over remaining book value", () => {
  // $100k capex, 2yr life, fully depreciated by year 2 (book value = 0).
  // Salvage of $30000 in the final year is entirely a taxable gain.
  const result = afterTaxCashFlows([-100000, 10000, 10000], {
    capex: 100000,
    usefulLifeYears: 2,
    taxRate: 0.25,
    salvageValue: 30000,
  });
  // Year 2: taxable income = (10000 - 50000 depreciation) + (30000 - 0 bookvalue gain) = -20000, no tax; cash = 10000 + 30000 = 40000
  assert.ok(Math.abs(result[2] - 40000) < 1e-9, `expected 40000, got ${result[2]}`);
});

test("afterTaxCashFlows: a decision with no capex (capex=0) applies tax with no depreciation shield", () => {
  const result = afterTaxCashFlows([0, 50000], { capex: 0, usefulLifeYears: 0, taxRate: 0.25 });
  assert.ok(Math.abs(result[1] - 37500) < 1e-9, "no depreciation to shield $50000 of taxable income at 25%");
});

// --- Goal-seek ---

test("solveForZeroNpv finds a value that actually yields ~0 NPV, holding other drivers at base case", () => {
  const decision = manufacturerPersona.decisions[0]; // capex decision
  const result = solveForZeroNpv(decision, "incrementalUnitsPerYear");
  assert.ok(result.solvedValue !== null, "expected a solved value for a driver known to swing NPV through zero");
  const baseInputs: Record<string, number> = {};
  for (const d of decision.drivers) baseInputs[d.id] = d.id === "incrementalUnitsPerYear" ? result.solvedValue! : baseCase(d.distribution);
  const solvedNpv = npv(baseCase(decision.discountRate.distribution), decision.cashFlows(baseInputs, 0));
  assert.ok(Math.abs(solvedNpv) < 1, `expected NPV ~0 at the solved value, got ${solvedNpv}`);
});

test("solveForZeroNpv throws for an unknown driver id", () => {
  const decision = manufacturerPersona.decisions[0];
  assert.throws(() => solveForZeroNpv(decision, "not-a-real-driver"));
});

test("solveForZeroNpv can solve for the discount rate itself (the IRR, holding drivers at base case)", () => {
  const decision = manufacturerPersona.decisions[0];
  const result = solveForZeroNpv(decision, decision.discountRate.id);
  assert.ok(result.feasible && result.solvedValue !== null, `expected a feasible IRR, got ${result.note}`);
  const irr = result.solvedValue!;
  assert.ok(irr > 0 && irr < 5, `IRR ${irr} outside the financing-rate domain`);
  const inputs = baseCaseInputs(decision);
  assert.ok(Math.abs(npv(irr, decision.cashFlows(inputs, 0))) < 1, "NPV at the solved rate should be ~0");
});

test("solveForZeroNpv confines the search to the driver's feasible domain and reports infeasibility rather than a nonsense value", () => {
  // A decision whose NPV is negative at every non-negative tax rate: the only
  // algebraic root is a negative rate, which is not a real tax rate.
  const decision: Decision = {
    id: "always-negative",
    label: "Always negative",
    description: "for goal-seek domain tests",
    horizonYears: 1,
    discountRate: { id: "discountRate", label: "rate", unit: "%/yr", category: "financing", distribution: { kind: "constant", value: 0.1 }, rationale: "test" },
    drivers: [
      { id: "taxRate", label: "Tax rate", unit: "%", category: "financing", distribution: { kind: "pert", min: 0.25, mode: 0.3, max: 0.3 }, rationale: "test" },
      { id: "profit", label: "Profit", unit: "AUD", category: "revenue", distribution: { kind: "constant", value: 1000 }, rationale: "test" },
    ],
    cashFlows(inputs) {
      return [-2000, inputs.profit * (1 - inputs.taxRate)];
    },
  };
  const result = solveForZeroNpv(decision, "taxRate");
  assert.equal(result.feasible, false);
  assert.equal(result.solvedValue, null);
  assert.deepEqual(result.domain, { low: 0, high: 1 });
  assert.match(result.note, /No feasible breakeven/);
});

test("solveForZeroNpv: an explicit domain override is honoured", () => {
  const decision = manufacturerPersona.decisions[0];
  const unconstrained = solveForZeroNpv(decision, "capex");
  assert.ok(unconstrained.feasible && unconstrained.solvedValue! > 0);
  const tooTight = solveForZeroNpv(decision, "capex", { domain: { low: 0, high: unconstrained.solvedValue! * 0.5 } });
  assert.equal(tooTight.feasible, false);
});

test("feasibleDomain: shares are [0, 1], rates can't fall below -100%, financing rates can't be negative, magnitudes are non-negative", () => {
  const base = { id: "x", label: "x", rationale: "t", distribution: { kind: "constant", value: 1 } as const };
  assert.deepEqual(feasibleDomain({ ...base, unit: "%", category: "financing" }), { low: 0, high: 1 });
  assert.deepEqual(feasibleDomain({ ...base, unit: "%/yr", category: "cost" }), { low: -1, high: 5 });
  assert.deepEqual(feasibleDomain({ ...base, unit: "%/yr", category: "financing" }), { low: 0, high: 5 });
  assert.deepEqual(feasibleDomain({ ...base, unit: "AUD", category: "capex" }), { low: 0, high: Infinity });
  assert.deepEqual(feasibleDomain({ ...base, unit: "workers", category: "cost" }), { low: 0, high: Infinity });
});

// --- Verdict synthesis ---

test("decisionVerdict: thresholds are boundary-correct at 70% and 40%", () => {
  assert.equal(decisionVerdict(0.7).verdict, "Proceed");
  assert.equal(decisionVerdict(0.699).verdict, "Marginal");
  assert.equal(decisionVerdict(0.4).verdict, "Marginal");
  assert.equal(decisionVerdict(0.399).verdict, "Reconsider");
  assert.equal(decisionVerdict(1).verdict, "Proceed");
  assert.equal(decisionVerdict(0).verdict, "Reconsider");
});

// --- Representative scenario extraction ---

test("nearestScenario returns the cash-flow array of the trial closest to the target NPV, not an interpolation", () => {
  const npvSamples = [10, 50, 100];
  const cashFlowSamples = [
    [-1, 10],
    [-1, 50],
    [-1, 100],
  ];
  assert.deepEqual(nearestScenario(npvSamples, cashFlowSamples, 48), [-1, 50]);
});

test("representativeCashFlows returns a real trial's cash flows for each of P90/P50/P10", () => {
  const decision = manufacturerPersona.decisions[0];
  const result = runMonteCarlo(decision, { iterations: 5000, seed: 11, captureCashFlows: true });
  assert.ok(result.cashFlowSamples, "expected cashFlowSamples to be populated when captureCashFlows is true");
  const p = percentiles(result.npvSamples);
  const rep = representativeCashFlows(result.npvSamples, result.cashFlowSamples!, p);
  for (const series of [rep.p90, rep.p50, rep.p10]) {
    assert.ok(result.cashFlowSamples!.some((cf) => cf === series), "each representative series should be an actual sampled trial, not a synthesized one");
  }
});

test("runMonteCarlo omits cashFlowSamples when captureCashFlows is not set (memory-conscious default)", () => {
  const decision = manufacturerPersona.decisions[0];
  const result = runMonteCarlo(decision, { iterations: 100, seed: 1 });
  assert.equal(result.cashFlowSamples, undefined);
});

// --- Cross-decision comparison and portfolio ---

test("compareDecisions ranks decisions by descending P50 NPV", () => {
  const rows = compareDecisions(manufacturerPersona.decisions, { iterations: 3000, seed: 7 });
  assert.equal(rows.length, manufacturerPersona.decisions.length);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].percentiles.p50 >= rows[i].percentiles.p50, "rows should be sorted by descending P50 NPV");
  }
});

test("compareDecisions attaches a verdict consistent with each row's probabilityPositive", () => {
  const rows = compareDecisions(manufacturerPersona.decisions, { iterations: 3000, seed: 7 });
  for (const row of rows) {
    assert.equal(row.verdict.verdict, decisionVerdict(row.probabilityPositive).verdict);
  }
});

test("runPortfolioMonteCarlo combined outlay is at least as large as any single decision's outlay (all funded together)", () => {
  const result = runPortfolioMonteCarlo(manufacturerPersona.decisions, { iterations: 2000, seed: 3 });
  const capexOnly = runMonteCarlo(manufacturerPersona.decisions[0], { iterations: 2000, seed: 3, captureCashFlows: true });
  const maxSingleOutlay = Math.max(...capexOnly.cashFlowSamples!.map((cf) => -cf[0]));
  assert.ok(Math.max(...result.outlaySamples) >= maxSingleOutlay - 1, "combined outlay across all decisions should be at least the largest single decision's outlay");
});

test("a joint run draws one hurdle rate per trial and shares it across every decision", () => {
  // Two decisions with identical, rate-only NPV: if each drew its own rate, their
  // per-trial NPVs would differ; with one shared draw they are identical every trial.
  const makeRateOnly = (id: string): Decision => ({
    id,
    label: id,
    description: "for shared-rate tests",
    horizonYears: 1,
    discountRate: { id: "discountRate", label: "rate", unit: "%/yr", category: "financing", distribution: { kind: "pert", min: 0.05, mode: 0.1, max: 0.2 }, rationale: "test" },
    drivers: [{ id: "flow", label: "Flow", unit: "AUD", category: "revenue", distribution: { kind: "constant", value: 100 }, rationale: "test" }],
    cashFlows(inputs) {
      return [-50, inputs.flow];
    },
  });
  const a = makeRateOnly("a");
  const b = makeRateOnly("b");
  const portfolio = runPortfolioMonteCarlo([a, b], { iterations: 300, seed: 5 });
  const soloA = runMonteCarlo(a, { iterations: 300, seed: 5 });
  // Combined NPV must be exactly twice one decision's NPV at the shared rate in every trial —
  // i.e. each trial's combined value is 2 * (-50 + 100/(1+r)) for a single r.
  for (const combined of portfolio.npvSamples) {
    const perDecision = combined / 2;
    const impliedRate = 100 / (perDecision + 50) - 1;
    assert.ok(impliedRate >= 0.05 && impliedRate <= 0.2, `implied shared rate ${impliedRate} outside the hurdle-rate range`);
    // With independent draws the two halves would generally differ and no single r would reproduce the sum exactly.
    assert.ok(Math.abs(2 * (-50 + 100 / (1 + impliedRate)) - combined) < 1e-9);
  }
  assert.equal(soloA.npvSamples.length, 300);

  const sequenced = runSequencedPortfolio(
    [
      { decision: a, startYear: 0 },
      { decision: b, startYear: 0 },
    ],
    { iterations: 300, seed: 5 },
  );
  for (const combined of sequenced.combinedNpvSamples) {
    const impliedRate = 100 / (combined / 2 + 50) - 1;
    assert.ok(impliedRate >= 0.05 && impliedRate <= 0.2, `sequenced implied shared rate ${impliedRate} outside the hurdle-rate range`);
  }
});

test("a joint run rejects decisions that disagree on the hurdle-rate distribution", () => {
  const [capexDecision] = manufacturerPersona.decisions;
  const differentRate: Decision = {
    ...capexDecision,
    id: "different-rate",
    discountRate: { ...capexDecision.discountRate, distribution: { kind: "constant", value: 0.5 } },
  };
  assert.throws(() => runPortfolioMonteCarlo([capexDecision, differentRate], { iterations: 10, seed: 1 }), /different discount-rate distributions/);
  assert.throws(
    () =>
      runSequencedPortfolio(
        [
          { decision: capexDecision, startYear: 0 },
          { decision: differentRate, startYear: 1 },
        ],
        { iterations: 10, seed: 1 },
      ),
    /different discount-rate distributions/,
  );
  assert.equal(sharedDiscountRateDriver(manufacturerPersona.decisions).id, "discountRate");
});

test("runPortfolioMonteCarlo is reproducible for a fixed seed", () => {
  const a = runPortfolioMonteCarlo(manufacturerPersona.decisions, { iterations: 1000, seed: 21 });
  const b = runPortfolioMonteCarlo(manufacturerPersona.decisions, { iterations: 1000, seed: 21 });
  assert.deepEqual(a.npvSamples, b.npvSamples);
  assert.deepEqual(a.outlaySamples, b.outlaySamples);
});

test("portfolioAffordability: probabilityAffordable is 1 when available capital exceeds every simulated outlay", () => {
  const result = portfolioAffordability(manufacturerPersona.decisions, 1e12, { iterations: 1000, seed: 4 });
  assert.equal(result.probabilityAffordable, 1);
});

test("portfolioAffordability: probabilityAffordable is 0 when available capital is far below every simulated outlay", () => {
  const result = portfolioAffordability(manufacturerPersona.decisions, -1e12, { iterations: 1000, seed: 4 });
  assert.equal(result.probabilityAffordable, 0);
});

// --- Typo guard (guardInputs) ---

test("guardInputs allows normal reads of known driver ids", () => {
  const guarded = guardInputs({ capex: 100 }, "test-decision");
  assert.equal(guarded.capex, 100);
});

test("guardInputs throws a clear error when cashFlows reads a driver id that doesn't exist (typo protection)", () => {
  const guarded = guardInputs({ capex: 100 }, "test-decision");
  assert.throws(() => (guarded as any).capexx, /test-decision.*capexx.*typo/s);
});

test("a decision whose cashFlows references a typo'd driver id fails loudly instead of producing a silent NaN", () => {
  const brokenDecision: Decision = {
    id: "broken-decision",
    label: "Broken decision",
    description: "for testing the typo guard",
    horizonYears: 1,
    discountRate: manufacturerPersona.decisions[0].discountRate,
    drivers: [
      { id: "capex", label: "Capex", unit: "USD", category: "capex", distribution: { kind: "constant", value: 100 }, rationale: "test" },
    ],
    cashFlows(inputs) {
      // deliberate typo: "capexx" instead of "capex"
      return [-(inputs as any).capexx, 0];
    },
  };
  assert.throws(() => runBaseCase(brokenDecision), /capexx/);
});

// --- Variance contribution ---

test("varianceContribution: a driver linearly dominating NPV gets the largest variance share", () => {
  const dominantDecision: Decision = {
    id: "dominant-driver-test",
    label: "Dominant driver test",
    description: "for testing variance contribution",
    horizonYears: 1,
    discountRate: { id: "discountRate", label: "rate", unit: "%", category: "financing", distribution: { kind: "constant", value: 0.1 }, rationale: "test" },
    drivers: [
      { id: "big", label: "Big driver", unit: "USD", category: "revenue", distribution: { kind: "normal", mean: 1000, stdDev: 500 }, rationale: "test" },
      { id: "tiny", label: "Tiny driver", unit: "USD", category: "revenue", distribution: { kind: "normal", mean: 10, stdDev: 0.5 }, rationale: "test" },
    ],
    cashFlows(inputs) {
      return [0, inputs.big + inputs.tiny];
    },
  };
  const result = runMonteCarlo(dominantDecision, { iterations: 5000, seed: 1, captureInputs: true });
  const rows = varianceContribution(dominantDecision, result.npvSamples, result.inputsSamples!);
  assert.equal(rows[0].driverId, "big", "the driver with far larger variance should dominate the NPV variance share");
  assert.ok(rows[0].varianceShare > 0.9, `expected "big" to explain >90% of variance, got ${rows[0].varianceShare}`);
});

test("varianceContribution: shares sum to 1", () => {
  const decision = manufacturerPersona.decisions[0];
  const result = runMonteCarlo(decision, { iterations: 3000, seed: 2, captureInputs: true });
  const rows = varianceContribution(decision, result.npvSamples, result.inputsSamples!);
  const total = rows.reduce((sum, r) => sum + r.varianceShare, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `expected shares to sum to 1, got ${total}`);
});

test("varianceContribution includes the discount rate as a driver, so its share is not handed to the others", () => {
  // NPV = -100 + 100/(1+r): the ONLY uncertainty is the discount rate, so it must own ~all the variance.
  const decision: Decision = {
    id: "rate-only",
    label: "Rate only",
    description: "for variance tests",
    horizonYears: 1,
    discountRate: { id: "discountRate", label: "rate", unit: "%/yr", category: "financing", distribution: { kind: "normal", mean: 0.1, stdDev: 0.02 }, rationale: "test" },
    drivers: [{ id: "flow", label: "Flow", unit: "AUD", category: "revenue", distribution: { kind: "constant", value: 100 }, rationale: "test" }],
    cashFlows(inputs) {
      return [-100, inputs.flow];
    },
  };
  const result = runMonteCarlo(decision, { iterations: 3000, seed: 8, captureInputs: true });
  assert.ok(result.inputsSamples![0].discountRate !== undefined, "captured inputs must carry the sampled discount rate");
  const rows = varianceContribution(decision, result.npvSamples, result.inputsSamples!);
  assert.equal(rows[0].driverId, "discountRate");
  assert.ok(rows[0].varianceShare > 0.99, `expected the rate to own the variance, got ${rows[0].varianceShare}`);
  assert.ok(rows[0].rSquared > 0.99, "raw r² should be exposed alongside the normalised share");
});

test("varianceContribution on a real decision gives the discount rate a non-zero share", () => {
  const decision = manufacturerPersona.decisions[0];
  const result = runMonteCarlo(decision, { iterations: 5000, seed: 2, captureInputs: true });
  const rows = varianceContribution(decision, result.npvSamples, result.inputsSamples!);
  const rateRow = rows.find((r) => r.driverId === decision.discountRate.id);
  assert.ok(rateRow && rateRow.varianceShare > 0.001, "a sampled hurdle rate must carry some of the NPV variance");
});

// --- Named compound stress scenarios ---

test("runStressScenario finds matching trials for an achievable compound condition and returns a real representative scenario", () => {
  const decision = manufacturerPersona.decisions[1]; // contract decision
  const result = runStressScenario(decision, { iterations: 20000, seed: 5 }, {
    label: "Weak margin and high inflation",
    matches: (inputs) => inputs.grossMarginPct < 0.2 && inputs.inputCostInflationPct > 0.05,
  });
  assert.ok(result.matchedTrials > 0, "expected at least some trials to match an achievable (if uncommon) compound condition");
  assert.ok(result.representativeCashFlows !== null);
  assert.ok(result.npvPercentiles !== null);
});

test("runStressScenario reports zero matches (not a crash) for an impossible compound condition", () => {
  const decision = manufacturerPersona.decisions[1];
  const result = runStressScenario(decision, { iterations: 2000, seed: 5 }, {
    label: "Impossible condition",
    matches: (inputs) => inputs.grossMarginPct > 10, // gross margin never exceeds 1
  });
  assert.equal(result.matchedTrials, 0);
  assert.equal(result.representativeCashFlows, null);
  assert.equal(result.npvPercentiles, null);
});

// --- Sequenced/dependent decisions and cash-calendar covenant check ---

test("runSequencedPortfolio rejects a dependency on a decision not listed earlier in the sequence", () => {
  const [capexDecision, , headcountDecision] = manufacturerPersona.decisions;
  assert.throws(() =>
    runSequencedPortfolio(
      [
        {
          decision: headcountDecision,
          startYear: 0,
          dependsOn: { decisionId: capexDecision.id, adjust: (inputs) => inputs },
        },
      ],
      { iterations: 100, seed: 1 },
    ),
  );
});

test("runSequencedPortfolio: a dependent decision's capacity cap actually constrains its sampled demand", () => {
  const [capexDecision, , headcountDecision] = manufacturerPersona.decisions;
  const result = runSequencedPortfolio(
    [
      { decision: capexDecision, startYear: 0 },
      {
        decision: headcountDecision,
        startYear: 1,
        dependsOn: {
          decisionId: capexDecision.id,
          adjust: (inputs, upstream) => ({
            ...inputs,
            demandRampUnitsPerYear: Math.min(inputs.demandRampUnitsPerYear, upstream.incrementalUnitsPerYear),
          }),
        },
      },
    ],
    { iterations: 3000, seed: 9 },
  );
  assert.equal(result.combinedNpvSamples.length, 3000);
  assert.equal(result.minimumCumulativeCashSamples.length, 3000);
});

test("runSequencedPortfolio is reproducible for a fixed seed", () => {
  const [capexDecision, , headcountDecision] = manufacturerPersona.decisions;
  const sequence = [
    { decision: capexDecision, startYear: 0 },
    { decision: headcountDecision, startYear: 1 },
  ];
  const a = runSequencedPortfolio(sequence, { iterations: 500, seed: 17 });
  const b = runSequencedPortfolio(sequence, { iterations: 500, seed: 17 });
  assert.deepEqual(a.combinedNpvSamples, b.combinedNpvSamples);
  assert.deepEqual(a.minimumCumulativeCashSamples, b.minimumCumulativeCashSamples);
});

test("covenantCheck: probabilityWithinFloor is 1 when the floor is far below every simulated trough", () => {
  const result = covenantCheck([-1000, -2000, -500], -1_000_000);
  assert.equal(result.probabilityWithinFloor, 1);
});

test("covenantCheck: probabilityWithinFloor correctly counts trials breaching the floor", () => {
  const result = covenantCheck([-1000, -2000, -500, -3000], -1500);
  assert.equal(result.probabilityWithinFloor, 0.5); // -1000 and -500 are within floor; -2000 and -3000 breach it
});

// --- Audience-specific views ---

test("operationalBrief mentions the modeled ramp-up delay for decisions that have one, and omits financial detail", () => {
  const decision = manufacturerPersona.decisions[0]; // has commissioningDelayMonths
  const verdict = decisionVerdict(0.8); // Proceed
  const brief = operationalBrief(decision, verdict);
  assert.match(brief, /ramp-up/);
  assert.doesNotMatch(brief, /NPV/i);
});

test("operationalBrief states non-approval plainly when the verdict is Reconsider", () => {
  const decision = manufacturerPersona.decisions[0];
  const verdict = decisionVerdict(0.1); // Reconsider
  const brief = operationalBrief(decision, verdict);
  assert.match(brief, /NOT approved/);
});

test("operationalBrief never tells the executor to begin ordering or hiring on a Marginal verdict", () => {
  const decision = manufacturerPersona.decisions[0];
  const verdict = decisionVerdict(0.55); // Marginal
  const brief = operationalBrief(decision, verdict, "Machine/line capex");
  assert.match(brief, /NOT YET approved/);
  assert.match(brief, /Machine\/line capex/, "should name the driver to resolve first");
  assert.doesNotMatch(brief, /begin hiring\/ordering/);
  assert.doesNotMatch(brief, /: approved/);
  assert.match(brief, /55%/);
});

test("operationalBrief approves only on Proceed", () => {
  const decision = manufacturerPersona.decisions[0];
  assert.match(operationalBrief(decision, decisionVerdict(0.8)), /: approved \(proceed case\)/);
  assert.doesNotMatch(operationalBrief(decision, decisionVerdict(0.5)), /: approved/);
  assert.doesNotMatch(operationalBrief(decision, decisionVerdict(0.2)), /: approved/);
});

test("financialDetailView surfaces the tax-rate base case and top variance drivers", () => {
  const decision = manufacturerPersona.decisions[0];
  const result = runMonteCarlo(decision, { iterations: 3000, seed: 6, captureInputs: true });
  const npvPct = percentiles(result.npvSamples);
  const varianceRows = varianceContribution(decision, result.npvSamples, result.inputsSamples!);
  const view = financialDetailView(decision, npvPct, varianceRows);
  assert.ok(view.taxRateBaseCase !== null);
  assert.ok(view.topVarianceDrivers.length <= 3 && view.topVarianceDrivers.length > 0);
});

test("riskBriefView flags residual value only for the decision that actually has a salvage driver", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  const contractDecision = manufacturerPersona.decisions[1];
  const capexPct = percentiles(runMonteCarlo(capexDecision, { iterations: 500, seed: 8 }).npvSamples);
  const contractPct = percentiles(runMonteCarlo(contractDecision, { iterations: 500, seed: 8 }).npvSamples);
  assert.equal(riskBriefView(capexDecision, capexPct, null).hasResidualValue, true);
  assert.equal(riskBriefView(contractDecision, contractPct, null).hasResidualValue, false);
});

// --- Persona/driver validation ---

function makeMinimalDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "test-decision",
    label: "Test decision",
    description: "for validation tests",
    horizonYears: 1,
    discountRate: { id: "discountRate", label: "rate", unit: "%/yr", category: "financing", distribution: { kind: "constant", value: 0.1 }, rationale: "test" },
    drivers: [
      { id: "x", label: "X", unit: "USD", category: "revenue", distribution: { kind: "constant", value: 100 }, rationale: "test" },
    ],
    cashFlows(inputs) {
      return [0, inputs.x];
    },
    ...overrides,
  };
}

test("validatePersona accepts a well-formed persona (the shipped manufacturer persona already passed on import)", () => {
  assert.doesNotThrow(() => validatePersona(manufacturerPersona));
});

test("validatePersona rejects a PERT/triangular distribution with an inverted range (min > max)", () => {
  const bad: Persona = {
    id: "bad-persona",
    name: "Bad persona",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [{ id: "x", label: "X", unit: "USD", category: "revenue", distribution: { kind: "pert", min: 100, mode: 50, max: 10 }, rationale: "test" }],
      }),
    ],
  };
  assert.throws(() => validatePersona(bad), PersonaValidationError);
});

test("validatePersona rejects a negative capex/cost driver", () => {
  const bad: Persona = {
    id: "bad-persona-2",
    name: "Bad persona 2",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [{ id: "capex", label: "Capex", unit: "USD", category: "capex", distribution: { kind: "constant", value: -500 }, rationale: "test" }],
      }),
    ],
  };
  assert.throws(() => validatePersona(bad), PersonaValidationError);
});

test("validatePersona rejects a percent-unit driver whose range implies a units mistake (e.g. 26 instead of 0.26)", () => {
  const bad: Persona = {
    id: "bad-persona-3",
    name: "Bad persona 3",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [{ id: "marginPct", label: "Margin", unit: "%", category: "revenue", distribution: { kind: "constant", value: 26 }, rationale: "test" }],
      }),
    ],
  };
  assert.throws(() => validatePersona(bad), PersonaValidationError);
});

test("validatePersona does not flag a dollar-per-unit driver whose name happens to contain the word 'margin'", () => {
  // Regression: an earlier version of this validator matched on driver id/label text
  // (e.g. "contributionMarginPerUnit") instead of the driver's declared unit, and
  // incorrectly rejected the manufacturer persona's own real driver.
  const ok: Persona = {
    id: "ok-persona",
    name: "OK persona",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [{ id: "contributionMarginPerUnit", label: "Contribution margin per unit", unit: "USD/unit", category: "revenue", distribution: { kind: "constant", value: 14 }, rationale: "test" }],
      }),
    ],
  };
  assert.doesNotThrow(() => validatePersona(ok));
});

test("validatePersona rejects a driver with an empty rationale", () => {
  const bad: Persona = {
    id: "bad-persona-4",
    name: "Bad persona 4",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [{ id: "x", label: "X", unit: "USD", category: "revenue", distribution: { kind: "constant", value: 1 }, rationale: "" }],
      }),
    ],
  };
  assert.throws(() => validatePersona(bad), PersonaValidationError);
});

test("validatePersona rejects duplicate driver ids within one decision", () => {
  const bad: Persona = {
    id: "bad-persona-5",
    name: "Bad persona 5",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [
          { id: "x", label: "X", unit: "USD", category: "revenue", distribution: { kind: "constant", value: 1 }, rationale: "test" },
          { id: "x", label: "X again", unit: "USD", category: "revenue", distribution: { kind: "constant", value: 2 }, rationale: "test" },
        ],
      }),
    ],
  };
  assert.throws(() => validatePersona(bad), PersonaValidationError);
});

// --- Debt/interest financing ---

test("amortizationSchedule: total payment is constant and balance reaches zero at term end", () => {
  const schedule = amortizationSchedule(100000, 0.08, 5);
  assert.equal(schedule.length, 5);
  const firstPayment = schedule[0].totalDebtService;
  for (const entry of schedule) {
    assert.ok(Math.abs(entry.totalDebtService - firstPayment) < 1e-6, "annuity payment should be constant across years");
  }
  assert.ok(Math.abs(schedule[4].remainingBalance) < 1e-6, `expected the loan fully repaid by year 5, remaining balance was ${schedule[4].remainingBalance}`);
});

test("amortizationSchedule: interest declines and principal portion grows each year (standard amortization)", () => {
  const schedule = amortizationSchedule(100000, 0.08, 5);
  for (let i = 1; i < schedule.length; i++) {
    assert.ok(schedule[i].interestPayment < schedule[i - 1].interestPayment, "interest should decline as balance amortizes");
    assert.ok(schedule[i].principalPayment > schedule[i - 1].principalPayment, "principal portion should grow as interest shrinks");
  }
});

test("amortizationSchedule: zero-interest loan splits principal evenly", () => {
  const schedule = amortizationSchedule(100000, 0, 4);
  for (const entry of schedule) {
    assert.ok(Math.abs(entry.principalPayment - 25000) < 1e-6);
    assert.equal(entry.interestPayment, 0);
  }
});

test("amortizationSchedule: zero principal or zero term returns an empty schedule", () => {
  assert.deepEqual(amortizationSchedule(0, 0.08, 5), []);
  assert.deepEqual(amortizationSchedule(100000, 0.08, 0), []);
});

test("financeDecision: financing reduces the year-0 outlay by the financed fraction", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  const financed = financeDecision(capexDecision, { loanToValuePct: 0.7, annualInterestRate: 0.08, termYears: 5 });
  const baseInputs: Record<string, number> = {};
  for (const d of capexDecision.drivers) baseInputs[d.id] = baseCase(d.distribution);
  const unfinancedFlows = capexDecision.cashFlows(baseInputs, 0);
  const financedFlows = financed.cashFlows(baseInputs, 0);
  const expectedYear0 = unfinancedFlows[0] * 0.3; // 70% financed leaves 30% of the outlay as equity
  assert.ok(Math.abs(financedFlows[0] - expectedYear0) < 1e-6, `expected year-0 outlay ~${expectedYear0}, got ${financedFlows[0]}`);
});

test("financeDecision: does not mutate the original decision", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  const originalId = capexDecision.id;
  financeDecision(capexDecision, { loanToValuePct: 0.5, annualInterestRate: 0.08, termYears: 5 });
  assert.equal(capexDecision.id, originalId, "financeDecision should not mutate the decision it wraps");
});

test("debtServiceCoverageRatio: returns Infinity when there's no debt service due", () => {
  assert.equal(debtServiceCoverageRatio(50000, 0), Infinity);
});

test("debtServiceCoverageRatio: matches hand calculation", () => {
  assert.equal(debtServiceCoverageRatio(120000, 100000), 1.2);
});

test("runDscrAnalysis: a much smaller loan clears the covenant far more often than a much larger one, all else equal", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  const smallLoan = runDscrAnalysis(capexDecision, { loanToValuePct: 0.1, annualInterestRate: 0.08, termYears: 5 }, 1.25, { iterations: 3000, seed: 30 });
  const bigLoan = runDscrAnalysis(capexDecision, { loanToValuePct: 0.9, annualInterestRate: 0.08, termYears: 5 }, 1.25, { iterations: 3000, seed: 30 });
  assert.ok(
    smallLoan.probabilityAboveCovenant >= bigLoan.probabilityAboveCovenant,
    `expected a smaller loan to clear a 1.25x DSCR covenant at least as often as a much larger one (small: ${smallLoan.probabilityAboveCovenant}, big: ${bigLoan.probabilityAboveCovenant})`,
  );
});

// Loan-terms validation: a 0-year term, a 0% or out-of-range loan-to-value, or a
// negative rate would otherwise fall through to an empty schedule and read as a
// vacuous "100% probability of meeting the covenant". Every LoanTerms-consuming
// entry point validates first.

test("validateLoanTerms: accepts an ordinary, fully-specified loan", () => {
  assert.doesNotThrow(() => validateLoanTerms({ loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: 7 }));
});

test("validateLoanTerms: rejects a 0% loan-to-value (no loan to analyse) instead of reporting a vacuous 100% covenant pass", () => {
  assert.throws(() => validateLoanTerms({ loanToValuePct: 0, annualInterestRate: 0.085, termYears: 7 }), /no loan to analyse/);
  const capexDecision = manufacturerPersona.decisions[0];
  assert.throws(() => runDscrAnalysis(capexDecision, { loanToValuePct: 0, annualInterestRate: 0.085, termYears: 7 }, 1.25, { iterations: 100, seed: 1 }), LoanTermsError);
});

test("validateLoanTerms: rejects a nonzero loan-to-value with a 0-year term (debt that is never repaid)", () => {
  assert.throws(() => validateLoanTerms({ loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: 0 }), LoanTermsError);
});

test("validateLoanTerms: rejects a negative term", () => {
  assert.throws(() => validateLoanTerms({ loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: -5 }), LoanTermsError);
});

test("validateLoanTerms: rejects loan-to-value outside [0, 1]", () => {
  assert.throws(() => validateLoanTerms({ loanToValuePct: 1.5, annualInterestRate: 0.085, termYears: 7 }), LoanTermsError);
  assert.throws(() => validateLoanTerms({ loanToValuePct: -0.2, annualInterestRate: 0.085, termYears: 7 }), LoanTermsError);
});

test("validateLoanTerms: rejects a negative interest rate", () => {
  assert.throws(() => validateLoanTerms({ loanToValuePct: 0.7, annualInterestRate: -0.01, termYears: 7 }), LoanTermsError);
});

test("validateLoanTerms: rejects non-finite values (NaN from a cleared or invalid form field)", () => {
  assert.throws(() => validateLoanTerms({ loanToValuePct: NaN, annualInterestRate: 0.085, termYears: 7 }), LoanTermsError);
});

test("runDscrAnalysis: rejects invalid loan terms instead of silently reporting 100% covenant coverage", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  assert.throws(
    () => runDscrAnalysis(capexDecision, { loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: 0 }, 1.25, { iterations: 500, seed: 1 }),
    LoanTermsError,
  );
  assert.throws(
    () => runDscrAnalysis(capexDecision, { loanToValuePct: 1.5, annualInterestRate: 0.085, termYears: 7 }, 1.25, { iterations: 500, seed: 1 }),
    LoanTermsError,
  );
});

test("financeDecision: rejects invalid loan terms instead of silently modeling debt that is never repaid", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  assert.throws(() => financeDecision(capexDecision, { loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: 0 }), LoanTermsError);
});

// --- Balloon at the horizon, and APV ---

test("debtScheduleForHorizon: a term longer than the horizon repays the outstanding balance as a balloon in the final modelled year", () => {
  const full = amortizationSchedule(100000, 0.08, 10);
  const horizon = debtScheduleForHorizon(100000, 0.08, 10, 5);
  assert.equal(horizon.length, 5);
  const balloon = horizon[4].balloonPayment;
  assert.ok(Math.abs(balloon - full[4].remainingBalance) < 1e-6, "the balloon must equal the balance still owing after the year-5 payment");
  assert.ok(balloon > 0);
  assert.equal(horizon[4].remainingBalance, 0);
  assert.ok(Math.abs(horizon[4].totalDebtService - (full[4].totalDebtService + balloon)) < 1e-6);
  const totalPrincipalRepaid = horizon.reduce((sum, e) => sum + e.principalPayment + e.balloonPayment, 0);
  assert.ok(Math.abs(totalPrincipalRepaid - 100000) < 1e-6, "every dollar borrowed must be repaid inside the horizon");
});

test("debtScheduleForHorizon: a term inside the horizon is unchanged and carries no balloon", () => {
  const schedule = debtScheduleForHorizon(100000, 0.08, 5, 5);
  assert.deepEqual(schedule, amortizationSchedule(100000, 0.08, 5));
  assert.ok(schedule.every((e) => e.balloonPayment === 0));
  const shorter = debtScheduleForHorizon(100000, 0.08, 3, 5);
  assert.equal(shorter.length, 3);
});

test("financeDecision: a longer loan term cannot lift value by pushing repayments past the horizon", () => {
  // Equity cash flows across the horizon must repay the full principal whatever the term,
  // so the undiscounted sum of debt service over the horizon is identical for 5, 7 and 10 years
  // apart from the interest actually paid.
  const capexDecision = manufacturerPersona.decisions[0];
  const inputs = baseCaseInputs(capexDecision);
  const unfinanced = capexDecision.cashFlows(inputs, 0);
  const principal = -unfinanced[0] * 0.7;
  const taxRate = inputs.taxRate;
  for (const termYears of [5, 7, 10]) {
    const financed = financeDecision(capexDecision, { loanToValuePct: 0.7, annualInterestRate: 0.085, termYears }).cashFlows(inputs, 0);
    const schedule = debtScheduleForHorizon(principal, 0.085, termYears, capexDecision.horizonYears);
    const interestPaid = schedule.reduce((sum, e) => sum + e.interestPayment, 0);
    const equityTotal = financed.reduce((sum, v) => sum + v, 0);
    const unfinancedTotal = unfinanced.reduce((sum, v) => sum + v, 0);
    // Sum of equity flows = sum of unfinanced flows - after-tax interest (principal nets to zero: borrowed at t0, repaid within the horizon).
    assert.ok(Math.abs(equityTotal - (unfinancedTotal - interestPaid * (1 - taxRate))) < 1e-6, `term ${termYears}: principal was not fully repaid inside the horizon`);
  }
});

test("runFinancingAnalysis: APV = unlevered NPV + PV of interest tax shield, and cheap debt does not inflate the operating case", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  const options = { iterations: 2000, seed: 40 };
  const analysis = runFinancingAnalysis(capexDecision, { loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: 5 }, 1.25, options);
  const unlevered = percentiles(runMonteCarlo(capexDecision, options).npvSamples);
  assert.ok(Math.abs(analysis.unleveredNpvPercentiles.p50 - unlevered.p50) < 1e-6, "the unlevered NPV must be the decision's own NPV, untouched by financing");
  assert.ok(analysis.taxShieldPvPercentiles.p50 > 0, "an interest-bearing loan with a positive tax rate has a positive tax shield");
  assert.ok(Math.abs(analysis.apvPercentiles.mean - (analysis.unleveredNpvPercentiles.mean + analysis.taxShieldPvPercentiles.mean)) < 1e-6);

  // A near-free loan (0.1%) has almost no interest and so almost no tax shield: it must not add value.
  const cheap = runFinancingAnalysis(capexDecision, { loanToValuePct: 1, annualInterestRate: 0.001, termYears: 5 }, 1.25, options);
  assert.ok(cheap.taxShieldPvPercentiles.p50 < analysis.taxShieldPvPercentiles.p50);
  assert.ok(Math.abs(cheap.apvPercentiles.p50 - cheap.unleveredNpvPercentiles.p50) < 2000, "near-zero interest means near-zero financing value, not a windfall");
});

test("runFinancingAnalysis: the tax shield PV matches a hand calculation at base case for a constant-capex decision", () => {
  const decision: Decision = {
    id: "fixed-capex",
    label: "Fixed capex",
    description: "for APV tests",
    horizonYears: 2,
    discountRate: { id: "discountRate", label: "rate", unit: "%/yr", category: "financing", distribution: { kind: "constant", value: 0.1 }, rationale: "test" },
    drivers: [
      { id: "capex", label: "Capex", unit: "AUD", category: "capex", distribution: { kind: "constant", value: 100000 }, rationale: "test" },
      { id: "taxRate", label: "Tax", unit: "%", category: "financing", distribution: { kind: "constant", value: 0.25 }, rationale: "test" },
    ],
    cashFlows(inputs) {
      return [-inputs.capex, 60000, 60000];
    },
  };
  const analysis = runFinancingAnalysis(decision, { loanToValuePct: 0.5, annualInterestRate: 0.1, termYears: 2 }, 1.25, { iterations: 50, seed: 1 });
  // Principal 50,000 at 10% over 2 years: payment 28,809.52; interest y1 5,000, y2 2,619.05.
  const expectedShield = (5000 * 0.25) / 1.1 + (2619.047619 * 0.25) / 1.21;
  assert.ok(Math.abs(analysis.taxShieldPvPercentiles.p50 - expectedShield) < 1, `expected ~${expectedShield}, got ${analysis.taxShieldPvPercentiles.p50}`);
  assert.equal(analysis.baseCasePrincipal, 50000);
  assert.equal(analysis.baseCaseBalloonAtHorizon, 0);
  // Worst-year DSCR: 60,000 / 28,809.52 in both years.
  assert.ok(Math.abs(analysis.dscr.minimumDscrPercentiles.p50 - 60000 / 28809.52) < 1e-3);
});

test("runFinancingAnalysis: DSCR is evaluated for every loan year inside the horizon and reports the balloon separately", () => {
  const capexDecision = manufacturerPersona.decisions[0];
  const longTerm = runFinancingAnalysis(capexDecision, { loanToValuePct: 0.7, annualInterestRate: 0.085, termYears: 10 }, 1.25, { iterations: 500, seed: 3 });
  assert.ok(longTerm.baseCaseBalloonAtHorizon > 0, "a 10-year loan on a 5-year decision leaves a balance to repay at the horizon");
  assert.match(longTerm.note, /balance still owing at year 5/);
  assert.ok(Number.isFinite(longTerm.dscr.minimumDscrPercentiles.p50));
  assert.doesNotMatch(longTerm.dscr.note, /minimumDscrPercentiles/, "the note must be plain English, not a field name");
});

// --- Second persona (heavy-machinery repair / mine-site logistics) ---

test("mineSiteServicesPersona is registered and passes its own validation on import", () => {
  assert.ok(findPersona("mine-site-services"));
  assert.equal(personas.length, 4);
  assert.doesNotThrow(() => validatePersona(mineSiteServicesPersona));
});

test("shortStayAccommodationPersona and softwareConsultancyPersona are registered and pass their own validation on import", () => {
  assert.ok(findPersona("short-stay-accommodation"));
  assert.ok(findPersona("software-consultancy"));
  assert.doesNotThrow(() => validatePersona(shortStayAccommodationPersona));
  assert.doesNotThrow(() => validatePersona(softwareConsultancyPersona));
});

test("all decisions across the third and fourth personas run without throwing and produce finite NPV samples", () => {
  for (const persona of [shortStayAccommodationPersona, softwareConsultancyPersona]) {
    for (const decision of persona.decisions) {
      const result = runMonteCarlo(decision, { iterations: 2000, seed: 111 });
      assert.equal(result.npvSamples.length, 2000);
      for (const v of result.npvSamples) {
        assert.ok(Number.isFinite(v), `${persona.id}/${decision.id} produced a non-finite NPV sample`);
      }
    }
  }
});

test("compareDecisions and portfolioAffordability work against the third and fourth personas with no engine changes", () => {
  for (const persona of [shortStayAccommodationPersona, softwareConsultancyPersona]) {
    const rows = compareDecisions(persona.decisions, { iterations: 1000, seed: 12 });
    assert.equal(rows.length, 3);
    const affordability = portfolioAffordability(persona.decisions, 500000, { iterations: 1000, seed: 12 });
    assert.ok(Number.isFinite(affordability.probabilityAffordable));
  }
});

test("all three mine-site-services decisions run without throwing and produce finite NPV samples (proves the engine is genuinely persona-agnostic)", () => {
  for (const decision of mineSiteServicesPersona.decisions) {
    const result = runMonteCarlo(decision, { iterations: 2000, seed: 111 });
    assert.equal(result.npvSamples.length, 2000);
    for (const v of result.npvSamples) {
      assert.ok(Number.isFinite(v), `decision ${decision.id} produced a non-finite NPV sample`);
    }
  }
});

test("mineSiteServicesPersona's macro-demand sensitivity is stated as higher than the manufacturer persona's (commodity-cycle exposure), and actually behaves that way", () => {
  // Compare the relative swing in a STEADY-STATE year's cash flow (year 2, past
  // any ramp damping) under a +/-1 macro shock, rather than NPV — NPV mixes in
  // the year-0 outlay and can sit near zero at base case, making a
  // percentage-of-NPV comparison numerically unstable regardless of the
  // underlying macro sensitivity.
  const truckDecision = mineSiteServicesPersona.decisions[0];
  const cncDecision = manufacturerPersona.decisions[0];

  const baseInputsFor = (decision: Decision): Record<string, number> => {
    const inputs: Record<string, number> = {};
    for (const d of decision.drivers) inputs[d.id] = baseCase(d.distribution);
    return inputs;
  };

  const steadyStateYear2 = (decision: Decision, macroFactor: number): number => {
    const inputs = baseInputsFor(decision);
    return decision.cashFlows(inputs, macroFactor)[2];
  };

  const truckSwingPct = Math.abs(steadyStateYear2(truckDecision, 1) - steadyStateYear2(truckDecision, -1)) / Math.abs(steadyStateYear2(truckDecision, 0));
  const cncSwingPct = Math.abs(steadyStateYear2(cncDecision, 1) - steadyStateYear2(cncDecision, -1)) / Math.abs(steadyStateYear2(cncDecision, 0));
  assert.ok(
    truckSwingPct > cncSwingPct,
    `expected the mine-site truck decision's relative cash-flow swing under a +/-1 macro shock (${truckSwingPct}) to exceed the manufacturer CNC decision's (${cncSwingPct}), matching the stated higher commodity-cycle sensitivity`,
  );
});

test("compareDecisions, portfolioAffordability, and runSequencedPortfolio all work against the second persona with no engine changes", () => {
  const rows = compareDecisions(mineSiteServicesPersona.decisions, { iterations: 1000, seed: 12 });
  assert.equal(rows.length, 3);

  const affordability = portfolioAffordability(mineSiteServicesPersona.decisions, 500000, { iterations: 1000, seed: 12 });
  assert.ok(Number.isFinite(affordability.probabilityAffordable));

  const [truckDecision, , crewDecision] = mineSiteServicesPersona.decisions;
  const sequenced = runSequencedPortfolio(
    [
      { decision: truckDecision, startYear: 0 },
      {
        decision: crewDecision,
        startYear: 1,
        dependsOn: {
          decisionId: truckDecision.id,
          adjust: (inputs, upstream) => ({
            ...inputs,
            demandRampCallOutsPerYear: Math.min(inputs.demandRampCallOutsPerYear, upstream.incrementalCallOutsPerYear),
          }),
        },
      },
    ],
    { iterations: 1000, seed: 12 },
  );
  assert.equal(sequenced.combinedNpvSamples.length, 1000);
});

test("PersonaValidationError message lists every issue found, not just the first", () => {
  const bad: Persona = {
    id: "bad-persona-6",
    name: "Bad persona 6",
    tagline: "test",
    decisions: [
      makeMinimalDecision({
        drivers: [
          { id: "a", label: "A", unit: "USD", category: "capex", distribution: { kind: "constant", value: -1 }, rationale: "" },
          { id: "b", label: "B", unit: "%", category: "revenue", distribution: { kind: "constant", value: 50 }, rationale: "test" },
        ],
      }),
    ],
  };
  try {
    validatePersona(bad);
    assert.fail("expected validatePersona to throw");
  } catch (err) {
    assert.ok(err instanceof PersonaValidationError);
    assert.ok(err.issues.length >= 3, `expected at least 3 issues (negative capex, empty rationale, bad percent range), got ${err.issues.length}`);
  }
});

// --- Contract margin erosion ---

test("contract decisions erode margin by (1 - margin) x inflation: inflation lands on the cost base, not on the margin", () => {
  for (const [persona, inflationId] of [
    [manufacturerPersona, "inputCostInflationPct"],
    [mineSiteServicesPersona, "fuelCostInflationPct"],
    [shortStayAccommodationPersona, "utilityCostInflationPct"],
    [softwareConsultancyPersona, "contractorRateInflationPct"],
  ] as const) {
    const contract = persona.decisions[1];
    const inputs = baseCaseInputs(contract);
    inputs.taxRate = 0; // isolate the pretax margin path
    inputs.onboardingCost = 0;
    inputs[inflationId] = 0.1;
    inputs.grossMarginPct = 0.3;
    inputs.annualRevenue = 1_000_000;
    const flows = contract.cashFlows(inputs, 0);
    // Year 1 at the contracted margin; cost base 0.7 inflates 10% a year: margins 0.30, 0.23, 0.153.
    assert.ok(Math.abs(flows[1] - 300_000) < 1e-6, `${persona.id}: year 1 should be at the contracted margin`);
    assert.ok(Math.abs(flows[2] - 230_000) < 1e-6, `${persona.id}: year 2 margin should be 0.30 - 0.70 x 0.10 = 0.23, got ${flows[2] / 1e6}`);
    assert.ok(Math.abs(flows[3] - 153_000) < 1e-6, `${persona.id}: year 3 margin should be 0.23 - 0.77 x 0.10 = 0.153, got ${flows[3] / 1e6}`);
  }
});

test("a fixed-price contract can go loss-making under a sustained cost shock, and the model lets it", () => {
  const contract = manufacturerPersona.decisions[1];
  const inputs = baseCaseInputs(contract);
  inputs.taxRate = 0;
  inputs.grossMarginPct = 0.1;
  inputs.inputCostInflationPct = 0.2;
  const flows = contract.cashFlows(inputs, 0);
  assert.ok(flows[3] < 0, "a 10% margin with 20%/yr cost inflation on a fixed price is under water by year 3");
});

test("neither persona's contract decision is a certainty: P(NPV > 0) sits strictly below 100%", () => {
  for (const persona of personas) {
    const contract = persona.decisions[1];
    const result = runMonteCarlo(contract, { iterations: 20000, seed: 42 });
    const probability = probabilityExceeds(result.npvSamples, 0);
    assert.ok(probability < 0.995, `${persona.id}: a multi-year single-customer contract modelled as ${(probability * 100).toFixed(1)}% certain is not a realistic input set`);
  }
});
