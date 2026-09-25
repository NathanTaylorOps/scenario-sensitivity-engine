# Methodology

This model runs Monte Carlo simulation over named, independently-adjustable
drivers to produce a distribution of outcomes for a business decision —
never a single-point forecast.

## Distribution choice by variable type

- **Triangular** — bounded, expert min/likely/max judgment with no historical
  data behind it (e.g. incremental production capacity for a machine not yet
  bought, second-shift crew size).
- **PERT (beta-PERT)** — same three-point input as triangular, but weights the
  "likely" value about 4x more heavily (`mean ≈ (min + 4·mode + max) / 6`),
  giving a smoother, more realistic curve. Used for the majority of cost and
  capex drivers here, since it's the standard in project cost/schedule
  estimating.
- **Normal** — aggregated or averaged effects across many small independent
  factors, where the Central Limit Theorem applies (e.g. demand aggregated
  across many customers). A normal can carry an optional floor (`min`): the
  demand drivers are floored at zero, because a volume cannot be negative
  and the left tail of a normal would otherwise occasionally produce one.
  The floor sits far enough out (over 2.5 standard deviations below the
  mean for both personas' demand drivers, under 0.2% of the mass) that the
  base case keeps using the untruncated mean.
- **Lognormal** — strictly positive, multiplicative or right-skewed variables
  (e.g. input-cost inflation, which has occasional upside shocks but can't go
  meaningfully negative).

## Sensitivity before Monte Carlo

Every decision runs a one-at-a-time tornado analysis first: each driver is
swung between its **10th and 90th percentile** while every other driver
sits at its base case, and the resulting NPV swing is ranked. The same
percentile pair is used for every distribution family (see
`sensitivityBounds` and `quantile` in `src/engine/distributions.ts`, which
compute the quantiles analytically — a closed form for triangular, normal and
lognormal, a numerically inverted Beta CDF for PERT). Swinging a bounded PERT
across its full min–max while a normal swings P10–P90 would measure one
driver over ~100% of its mass and the other over 80%, and systematically
overstate the bounded drivers' importance; using P10–P90 everywhere keeps
the ranking comparable across drivers and stops one extreme corner of a
range from dominating it. This decides which drivers actually matter before
the full simulation runs, rather than treating every input as equally worth
modelling in detail.

## Output convention: ranges, not points

Results are reported as **P90 / P50 / P10** under the probability-of-exceedance
convention:

- **P90** = the value 90% of simulated outcomes meet or exceed (the
  conservative / low case).
- **P50** = the median.
- **P10** = the value only 10% of outcomes exceed (the optimistic / high
  case).

Note that P90 is the *low* number and P10 is the *high* number — a common
labeling trap. A single headline number (like base-case NPV) is always shown
alongside its range, never alone, because a point estimate on a Monte Carlo
output is false precision: the input assumptions carry far more uncertainty
than any two-decimal-place answer implies.

## Driver independence and the discount rate

Distribution *shape* generally matters less to the outcome than getting the
central estimate and range right — the input assumptions do more work than
the choice of triangular vs. normal vs. lognormal. Drivers in this model are
treated as **independent** unless noted otherwise; where two drivers would
realistically move together (e.g. demand and price in a downturn), that
correlation is captured only through the shared macro factor described
below, which understates tail risk that runs through any other channel.

The discount rate is sampled as an uncertain input like every other driver,
and it is treated as a driver everywhere: it has its own row in the tornado
ranking, its own share in the variance-contribution breakdown, and can be
the target of a goal-seek. It is the firm's hurdle rate, not the project's,
so any run that evaluates several decisions together (portfolio, sequence)
draws it **once per trial** and applies that one rate to every decision in
the trial (`sharedDiscountRateDriver` in `src/engine/montecarlo.ts`); a set
of decisions that disagree on the hurdle-rate distribution is rejected
rather than silently resolved.

## Base-case vs. simulated

`runBaseCase` runs every driver at its distribution's analytical mean with no
randomness at all — a deterministic sanity check, not a decision input on its
own. It exists so a reviewer (or a test) can confirm the simulation's mean
converges toward it, not so a GM should read the base case as "the answer."

## Tax and depreciation (`src/engine/tax.ts`)

Every decision's cash flows are **after-tax**, not pretax. `Decision.cashFlows`
implementations compute pretax operating cash flow and then route it through
`afterTaxCashFlows`, which applies:

- **Straight-line depreciation** over a stated useful life, sized off the
  decision's capex driver (0 for decisions with no depreciable asset, e.g. the
  contract and headcount decisions).
- A **depreciation tax shield**: taxable income = pretax cash flow minus that
  year's depreciation, taxed at the sampled `taxRate` driver.
- Tax is charged only on **positive** taxable income — a stated, conservative
  simplification. No loss-carryforward or other-income offset is modeled, so a
  loss year gets no tax benefit here, which understates after-tax cash in a
  bad year rather than overstating it.
- The year-0 outlay itself passes through untaxed (a balance-sheet event, not
  an income-statement one).

This was added specifically because a finance-literate reviewer (a CFO or
controller) would flag pretax cash flow as the first thing wrong with the
model — see the audience section below.

## Terminal / salvage value

The capex decision (`second-cnc-line`) carries a `salvageValuePct` driver: the
modeled resale value of the equipment, as a percentage of original capex, at
the end of the 5-year horizon. Only the **gain over remaining book value** is
taxable — full proceeds are cash, but tax applies solely to the amount above
what hasn't yet been depreciated, per `afterTaxCashFlows`. Decisions with no
residual asset (the contract and headcount decisions) don't carry this driver;
adding a fabricated salvage value to a decision with nothing physical to
resell would be worse than omitting it.

## Goal-seek / backward-solving (`src/engine/goalseek.ts`)

`solveForZeroNpv(decision, driverId)` answers "what would this one driver need
to be for NPV to hit exactly zero?", holding every other driver at its base
case. It expands a search bracket outward from the driver's base-case value
until NPV changes sign, then bisects to convergence. The driver can be any
operating driver or the discount rate itself (solving for the rate gives the
decision's IRR at base case).

The search is not limited to the driver's own distribution range — a solved
value that falls *outside* the range judged plausible is itself a finding
worth stating ("this only works if margin holds above a level nobody in the
tornado range expects"). It *is* limited to the driver's **feasible domain**
(`feasibleDomain` in `src/engine/goalseek.ts`): a share such as a tax rate
or margin is confined to 0–100%, a per-period rate cannot fall below −100%
(and a financing rate cannot be negative at all), and every other quantity —
money, units, headcount, months — is non-negative. If NPV never crosses zero
anywhere inside that domain the result is reported as infeasible ("this
driver alone cannot move the decision across zero") rather than as a value
that could never occur, such as a negative tax rate.

## Verdict synthesis (`src/engine/verdict.ts`)

`decisionVerdict(probabilityPositive)` reduces a full distribution down to one
of three labels — **Proceed** (≥70% of simulated outcomes have positive NPV),
**Marginal** (40-70%), or **Reconsider** (<40%) — plus one sentence of
rationale carrying the actual number. The 70%/40% cutoffs are a stated design
choice (a common capital-budgeting rule of thumb), not a statistically derived
optimum, and are named here specifically so a reviewer can disagree with them
rather than treat them as hidden or authoritative. The label is always shown
next to the number it came from, never standing alone.

## Representative scenario extraction (`src/engine/scenarios.ts`)

A GM asking "what does the P50 year actually look like?" wants a real,
internally-consistent cash-flow story, not year-by-year percentiles computed
independently across trials — that composite would mix year 3's optimistic
trial with year 1's pessimistic one into a path no single simulated outcome
ever produced. `representativeCashFlows` instead returns the **actual**
simulated trial whose overall NPV lands nearest each of P90/P50/P10. This
requires `runMonteCarlo` to be called with `captureCashFlows: true`, which is
off by default since retaining every trial's full cash-flow array has a real
memory cost at high iteration counts.

## Shared macro factor / decision correlation (`src/engine/portfolio.ts`)

`Decision.cashFlows` accepts an optional `macroFactor` — a standard normal
(mean 0, std dev 1) economic-conditions z-score. A standalone single-decision
run always passes 0, since each driver's own distribution already carries its
full independent uncertainty. `runPortfolioMonteCarlo` samples **one**
macro-factor draw per trial and passes it identically to every decision being
evaluated together, tilting each decision's demand-linked drivers by the same
`± MACRO_DEMAND_SENSITIVITY` (currently 15%) factor in the same direction —
so a shared downturn now depresses the CNC line's incremental volume, the
contract's revenue, and the second shift's demand ramp together, instead of
independently.

This is a **deliberate simplification**, stated plainly rather than presented
as more rigorous than it is: real driver correlation is a full covariance
structure (a covariance matrix, sampled via Cholesky decomposition), which
would let arbitrary driver pairs move together at arbitrary strengths. A
single shared macro factor only captures "decisions move together under
common economic conditions" — it will understate correlation that runs
through a channel other than aggregate demand (e.g. a shared supplier, a
single customer relationship spanning two decisions), and it applies the same
15% sensitivity to every demand driver regardless of how exposed that
particular driver actually is. It was chosen because it is auditable in one
place and defensible in an interview, where a hidden or overclaimed
correlation model would not be.

## Portfolio affordability / shared capital constraint

`portfolioAffordability(decisions, availableCapital, options)` runs the shared
macro-factor portfolio simulation and asks the question a GM facing several
competing decisions for one budget actually has: "if we fund all of these
together in year 0, what's the combined outlay likely to be, can we actually
afford it, and is the combined bet still worth taking?" It reports the share
of simulated trials where combined outlay fits within the stated available
capital, alongside the combined NPV distribution. It assumes every listed
decision is committed together in year 0 — it does not model staggering
financing across years, which is stated in the result rather than left
implicit.

## Cross-decision comparison

`compareDecisions(decisions, options)` runs each decision's own **independent**
Monte Carlo (no shared macro factor — that's what `runPortfolioMonteCarlo` is
for) and returns one row per decision — P90/P50/P10, probability of a
positive NPV, and the verdict — sorted by descending P50 NPV. This is the
"which of these is the better bet" view; it deliberately keeps each decision's
own full risk profile visible in the same row as its ranking, rather than
collapsing everything to a single sortable number.

## Sequenced / dependent decisions and the cash-flow calendar (`src/engine/sequence.ts`)

`compareDecisions` and `runPortfolioMonteCarlo` both treat decisions as
parallel bets — independent, or coupled only through a shared macro factor.
That's the wrong model when one decision's real-world output caps another's:
the second-shift decision can't sell more units than the CNC line actually
produces, and treating them as parallel bets hides that.

`runSequencedPortfolio(sequence, options)` places each decision on a shared
calendar at a stated `startYear`, and lets a decision declare `dependsOn` an
earlier decision in the same sequence — an `adjust` function that tightens
this decision's sampled inputs using the upstream decision's sampled inputs
from the **same trial** (not its base case, its actual simulated draw). The
manufacturer persona's demo sequence caps the second shift's demand at
whatever the CNC line actually produced that trial:

```ts
demandRampUnitsPerYear: Math.min(inputs.demandRampUnitsPerYear, upstream.incrementalUnitsPerYear)
```

This is a meaningfully different, and meaningfully worse, result than
evaluating the second shift on its own — which is the point: the standalone
version was quietly assuming demand it might not have the capacity to serve.

The same run also produces a **combined cash-flow calendar** — every
decision's cash flows placed at their actual calendar year and summed — and
tracks the **lowest cumulative cash balance reached at any point on that
calendar**, per trial. `covenantCheck(minimumCumulativeCashSamples, floor)`
turns that into the question a lender actually asks: not "is the NPV
positive" but "does the combined cash position ever breach a stated floor
along the way." A project can clear on NPV and still run out of cash in
month 14; this is aimed specifically at that gap. Combined NPV here discounts
each cash flow over its **actual calendar position** (`startYear + t`), not
each decision's own local year — sequencing changes when money moves, and the
discounting reflects that.

## Named compound stress scenarios (`src/engine/stress.ts`)

P90 is *an* unfavorable outcome, but it mixes many different single-driver
misses into one number — it may not resemble the specific bad scenario a
reader actually wants to picture ("margin compression *and* a cost spike
together," not just "a bad year in general"). `runStressScenario(decision,
options, stress)` takes a named predicate over a trial's sampled driver
inputs (e.g. `grossMarginPct < 0.2 && inputCostInflationPct > 0.04`), filters
the simulated trials down to the ones matching it, and reports the NPV
distribution and a representative cash-flow scenario **within that subset
only** — built on the same `nearestScenario` machinery as the P90/P50/P10
scenarios, just applied to a named subset of trials instead of the whole run.
A condition matching zero trials is reported plainly rather than silently
returning nothing, since "rare or unachievable given how these drivers are
distributed" is itself informative.

## Variance-contribution breakdown (`src/engine/variance.ts`)

The tornado chart swings one driver at a time and ranks by that isolated
swing — useful for deciding what to model carefully, but it can't say how
much of the **combined**, everything-moving-at-once variance actually traces
back to each driver. `varianceContribution(decision, npvSamples,
inputsSamples)` computes the Pearson correlation between each driver's
sampled value — the discount rate included — and the resulting NPV across
the same trials, squares it, and normalises so the shares sum to 1. The raw
r² is reported next to the normalised share, so a reader can see how much
of the spread a linear fit on each driver explains before normalisation.

This is a stated approximation — not a full Sobol variance decomposition —
but a more defensible one here than it would be generically: every driver in
this engine is sampled independently (see "Driver independence" above), so
there's no cross-driver correlation to double-count, which is exactly the
condition under which an r²-based decomposition is a reasonably literal
answer to "how much of the variance does this explain," not just a proxy for
it.

## Ramp-up / commissioning delay

The capex and headcount decisions each carry a delay driver
(`commissioningDelayMonths`, `hiringRampMonths`) representing the time
between the decision closing and full-rate output — installation and
calibration for a machine, hiring and training for a crew. The model reduces
year-1 operating cash flow by the fraction of the year lost to that delay;
costs (maintenance, wages) are still incurred at full rate during the ramp,
since in reality you pay for the asset or the crew before they're fully
productive. This was added specifically because the model previously assumed
day-one full output, which understated both the capital need and the time
before payback starts — a gap the person who'd actually have to execute the
decision would notice immediately.

## Audience-specific views (`src/engine/views.ts`)

The same simulation output serves different readers differently: a GM wants
a verdict, a CFO wants the assumptions and after-tax detail, a lender wants
the downside case, and the person executing the decision wants one
operational instruction with no financial detail in the way. Rather than one
screen everyone reads differently, `views.ts` derives three plain-data views
from the same result — `operationalBrief` (one line: approved or not, and
the ramp-up delay to plan around, nothing else), `financialDetailView`
(assumptions, after-tax figures, top variance drivers), and `riskBriefView`
(the P90 downside case and whether a residual/salvage value applies). This is
the engine-level foundation for that split, not a UI: which screen a person
actually sees is a Phase 3 (UI) concern, deliberately out of scope for a
dependency-free engine module, but the split needed a tested home in the data
layer before it could be a screen at all.

## Typo protection on driver ids (`src/engine/guardedInputs.ts`)

Every driver id is a plain string, matched by convention between a driver's
definition and the `inputs.someId` reads inside its decision's `cashFlows`.
A typo on either side previously read `undefined`, which silently became
`NaN` through every downstream calculation — a bug that, at the time it's
introduced, would only surface (if at all) as a confusing "non-finite NPV
sample" failure far from its actual cause. `guardInputs` wraps the sampled
inputs record in a `Proxy` that throws immediately, naming the exact typo'd
id and the decision it happened in, the moment a `cashFlows` implementation
reads a key that isn't one of its own declared drivers. It's used everywhere
an inputs record is built — the Monte Carlo runner, the base case, tornado
analysis, and goal-seek — so a mistake is caught wherever it's introduced,
not just in whichever caller happens to run first.

This isn't full compile-time type safety (that would require parameterizing
`Decision` by a union type of its own driver ids, a larger refactor than
this codebase's size currently justifies) — it's a small, contained fix for
the actual failure mode a developer extending this codebase would hit.

