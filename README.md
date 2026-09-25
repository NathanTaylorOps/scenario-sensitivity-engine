# Scenario Sensitivity Engine

[![CI](https://github.com/NathanTaylorOps/scenario-sensitivity-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/NathanTaylorOps/scenario-sensitivity-engine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Monte Carlo scenario and sensitivity modeling tool for GM/COO-level
business decisions — breakeven, NPV, payback, and tornado-ranked sensitivity,
reported as ranges (P90/P50/P10), not false-precision point estimates.

**Live demo:** [scenario-sensitivity-engine.onrender.com](https://scenario-sensitivity-engine.onrender.com/)

![Screenshot of the Scenario Sensitivity Engine UI, showing a verdict badge, NPV range and tornado charts for a mid-size manufacturer's second-CNC-line decision](docs/images/screenshot.png)

> All company names, financial figures, and datasets in this project are
> synthetic and illustrative only — no real business or financial data is
> used or required.

The engine is covered by a 152-test unit suite, and the UI by an automated
26-check smoke test that drives a real browser — both run in CI on every
push. See `docs/METHODOLOGY.md` for how the engine works and
`docs/BENCHMARKS.md` for where the input ranges come from.

## Try it

Requires **Node 22.18+, 23.6+, or 24.3+** — the engine and tests run as plain
`.ts` files with zero build step, which depends on Node's native TypeScript
type-stripping being enabled without a flag. Pinned in `package.json`'s
`engines` field.

```
node scripts/demo.ts
```

Runs all three decisions for the manufacturer persona and prints, per
decision: base-case NPV, the P90/P50/P10 range, probability of a positive
NPV, a Proceed/Marginal/Reconsider verdict, the tornado sensitivity ranking,
a goal-seek breakeven value for the top driver, a representative year-by-year
cash-flow scenario for each of P90/P50/P10, a variance-contribution
breakdown, and the three audience-specific views (executor/CFO/lender). It
then prints a cross-decision comparison table, a portfolio-affordability
check, a named compound stress scenario, and a sequenced-decision run (the
CNC line feeding the second shift's capacity) with a cash-floor/covenant
check across the combined calendar.

## Use the UI

```
npm run build:web
```

Compiles `src/web/`, `src/engine/`, and `src/personas/` to plain browser ES
modules with `tsc` (no bundler) and copies `web/index.html`/`web/styles.css`
into `dist/web/`. Open `dist/web/index.html` in a browser: pick a persona and
decision, see the verdict, NPV range and tornado chart, the
variance-contribution breakdown, the three audience views, a live
debt-financing/DSCR panel for capex decisions, and the persona-level
comparison and portfolio-affordability panels. Charts are inline SVG built to
a validated, colorblind-safe palette and mark spec, with no charting library
dependency. Breakeven and goal-seek are engine-level features exercised by
`node scripts/demo.ts` and the test suite; the browser UI doesn't expose
either as its own panel yet.

## Customize it

Every driver's assumptions are editable in the browser — click **Edit
assumptions** on any decision. Plain-language Pessimistic/Likely/Optimistic
fields are the default entry point; an "Advanced" toggle underneath exposes
the raw distribution shape (triangular, PERT, normal, lognormal, constant)
for anyone who wants it. Two things stay true no matter how far an edit
strays from the built-in defaults:

- **Saving an invalid config is impossible, not just discouraged.** The
  editor runs every edit through the same `validatePersona` check the
  built-in personas themselves have to pass at load time — an inverted
  min/max, a negative capex, a percentage entered as `26` instead of `0.26`,
  is rejected outright, with the specific reason shown.
- **An edit far outside the originally sourced range is flagged, never
  silently accepted or silently blocked.** A real business reason to move
  outside a sourced range is entirely possible — the point is making sure
  that's a deliberate choice, not a typo. See `src/engine/guardrails.ts`.

Edited assumptions save to the browser's local storage — this device only,
no account, no server. **Save & load scenarios** turns a persona + decision +
its edited assumptions into a named, reloadable snapshot, and **Export
current to file** writes it to a portable `.json` file that reproduces the
identical result when imported anywhere else — the seeded, deterministic
Monte Carlo engine guarantees the numbers match exactly.

A decision's underlying formula (its `cashFlows` function) isn't something
the browser editor can author from scratch. What ships instead is
`src/personas/templates.ts`: a small, fixed set of reviewed cash-flow
archetypes that a new custom decision can be built from, with its own driver
data on top — `test/templates.test.ts` proves the generalized capex template
reproduces the built-in "second CNC machine" decision's own formula
bit-for-bit.

## Deploy it

`render.yaml` is a [Render](https://render.com) Blueprint for exactly this: a
free static site, no server, built with `npm ci && npm run build:web` and
served from `dist/web/`. In the Render dashboard: **New → Blueprint**, point
it at this repo, and it reads `render.yaml` automatically. `.node-version`
pins the Node version Render builds with. Any other static host (Netlify,
Vercel, GitHub Pages) works the same way: run `npm run build:web` and publish
`dist/web/`.

## Run the tests

```
npm run verify
```

Runs, in order: `tsc --noEmit` against every `.ts` file including the UI
layer; the 152-test engine/storage/guardrail/template suite (`node --test`);
the browser build (`npm run build:web`), which type-checks `src/web/` a
second time under its own browser-targeting `tsconfig.web.json`; and an
automated UI smoke test (`npm run test:web`) — 26 checks against the actual
built page, including opening the assumption editor, saving an edit outside
the sourced range and confirming it's flagged not blocked, hard-rejecting a
structurally invalid edit, persisting an override across a reload, and
exporting/re-importing a scenario and confirming the result matches
bit-for-bit. All four steps run in CI on every push/PR
(`.github/workflows/ci.yml`).

**First-time setup for the UI smoke test:** it drives a real headless browser
via [Playwright](https://playwright.dev), which needs its browser binary
installed once: `npx playwright install chromium`.

The engine suite covers RNG determinism, statistical property tests on each
distribution, convergence testing, financial-math edge cases (including a
regression test for the PERT mean-matching singularity this repo's own first
persona config hit), the P90/P10 exceedance convention, tornado-ranking
correctness, tax/depreciation known-value correctness, goal-seek correctness
(the solved value is verified to actually yield ~0 NPV), verdict threshold
boundaries, representative-scenario extraction, cross-decision comparison
ordering, portfolio affordability sanity bounds, variance-contribution
correctness, compound stress-scenario matching, sequenced/dependent decision
correctness, covenant/cash-floor threshold counting, the typo guard, the
audience-specific views, the persona validation layer, debt amortization and
DSCR correctness (including a regression test for an invalid loan-term edge
case that used to silently report a misleadingly confident covenant pass
instead of rejecting the input), and the second persona — proving the engine
is genuinely persona-agnostic, since every cross-decision and portfolio
function runs against it with zero engine changes.

## What's modeled beyond the base case

- **After-tax cash flows** — every decision routes through straight-line
  depreciation and a sampled effective tax rate, not a pretax figure.
- **Terminal/salvage value** — the capex decision models resale value at the
  end of its horizon, taxed only on the gain over remaining book value.
- **Goal-seek** — for any driver, solve for the value at which NPV hits
  exactly zero, holding everything else at base case.
- **Verdict synthesis** — a Proceed/Marginal/Reconsider label with the
  probability behind it, stated thresholds included.
- **Representative scenarios** — the actual simulated trial nearest each of
  P90/P50/P10, not a statistically incoherent composite of independent
  per-year percentiles.
- **Cross-decision comparison** — every decision run and ranked side by side
  by P50 NPV, verdict included.
- **Shared macro-factor correlation** — a portfolio run couples decisions'
  demand-linked drivers through one shared economic-conditions factor per
  trial, rather than treating every decision as independent when they
  compete for the same budget.
- **Portfolio affordability** — the probability that funding several
  decisions together fits within a stated capital budget.
- **Sequenced/dependent decisions** — one decision's real-world output can
  cap another's inputs in the *same* simulated trial, on a shared calendar
  with its own combined cash-flow timeline.
- **Cash-floor / covenant check** — the lowest cumulative combined cash
  balance reached at any point on that calendar, per trial, and the
  probability it stays above a stated floor.
- **Named compound stress scenarios** — filter simulated trials to a named
  combination of pessimistic drivers and see the NPV distribution and a
  representative cash flow within that specific subset.
- **Variance-contribution breakdown** — what share of the simulated NPV
  spread each driver actually explains once everything is moving at once, as
  distinct from its isolated tornado swing.
- **Ramp-up / commissioning delay** — capex and headcount decisions model a
  delay before full-rate output, reducing year-1 cash flow rather than
  assuming day-one productivity.
- **Audience-specific views** — the same result rendered as one operational
  line for the person executing the decision, an assumptions-and-variance
  view for a CFO, or a downside/residual-value view for a lender.
- **Debt financing and a DSCR covenant check** — any capex decision can be
  wrapped with a standard amortizing loan; `runDscrAnalysis` recomputes the
  loan per trial from that trial's own sampled capex and reports the
  probability the worst-year debt-service coverage ratio stays above a
  stated covenant threshold, alongside an APV valuation that separates the
  project's unlevered value from the value of cheap debt.
- **A second, independently calibrated persona** — mine-site heavy-equipment
  repair and logistics, built on the same shared engine with zero engine
  changes, proving the driver-based design is genuinely swappable rather
  than tailored to one industry.

See `docs/METHODOLOGY.md` for the reasoning and stated simplifications behind
each of these — particularly the macro-factor approach, which is explicitly
*not* full covariance-matrix correlation modeling, and the
variance-contribution breakdown, which is a correlation-based approximation
rather than a full Sobol decomposition.

## Structure

- `src/engine/` — pure simulation logic: distributions, RNG, Monte Carlo
  runner, financial math, tornado analysis, tax/depreciation, goal-seek,
  verdict synthesis, representative-scenario extraction, portfolio-level
  comparison/correlation/affordability, decision sequencing, named compound
  stress scenarios, variance-contribution analysis, audience-specific views,
  persona validation (`validation.ts`, hard-reject), soft guardrail warnings
  (`guardrails.ts`, non-blocking), and debt financing/DSCR analysis. Zero UI
  dependencies, fully unit-testable in isolation.
- `src/personas/` — typed persona/scenario configs consumed by the shared
  engine above, registered in `src/personas/index.ts`. Swapping personas
  swaps this config, not the engine code. `templates.ts` holds the
  decision-template library a custom decision can be built from.
- `src/web/` — the UI layer: `main.ts` (app orchestration and DOM wiring),
  `charts.ts` (inline SVG tornado/range charts), and `storage.ts` (the only
  module that touches `localStorage`).
- `web/` — the static `index.html`/`styles.css` the compiled UI loads;
  `scripts/build-web.mjs` compiles and assembles them into `dist/web/`.
  `scripts/test-web.mjs` is the automated Playwright smoke test.
- `docs/METHODOLOGY.md` — why each distribution was chosen, the sensitivity
  approach, and the output convention.
- `docs/BENCHMARKS.md` — where the input ranges come from, for both
  personas, in AUD.
- `docs/AI_ASSISTED_AUTHORING.md` — how an AI coding assistant was used to
  build this, and what stayed a human decision.
- `.github/workflows/ci.yml` — runs typecheck, tests, the browser build, and
  the UI smoke test on every push and pull request.

## No backend, no bundler

Everything runs entirely client-side — engine, personas, and UI are all
plain TypeScript with zero runtime dependencies. The UI is a dependency-free
static page: no React, no build tool beyond `tsc` itself, deployable as
static files with no server.

## About

Built by **Nathan Taylor** — operations and construction leader (GM/COO
background) building out a portfolio of decision-support tools alongside a
job search in South-East Queensland, Australia.
[LinkedIn](https://www.linkedin.com/in/nathan-taylor02)
