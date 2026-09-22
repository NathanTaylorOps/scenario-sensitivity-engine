# AI-assisted, human-verified persona authoring

Every driver range in this repo has so far been authored the same way: research
a real benchmark, draft a plausible three-point or distribution estimate
grounded in it, write down *why* in the driver's `rationale` field, then run
it through the engine and sanity-check the output isn't degenerate (100%
positive, or a coin-flip that's actually a units bug). That process — not
just its output — is the actual workflow this document formalizes, because
it's a genuinely useful capability on its own: an LLM can do the research-and-draft
step from a plain-English company description, as long as a human reviews
every number before it's trusted and a validation layer catches the mistakes
a reviewer might miss.

This is **not** a live API integration wired into the codebase. There's no
`OPENAI_API_KEY`, no network call from `src/`. Faking one — hardcoding
heuristics dressed up as "AI-drafted" — would be dishonest in a portfolio
project whose entire pitch is that the numbers are real. What's here instead
is the actual prompt template and the actual review checklist, because the
process is the differentiated thing, not a specific vendor's API call.

## Why this is worth doing at all

Hand-authoring the manufacturer persona and the mine-site-services persona
both took real research time — finding a BLS occupation code, checking a
dealer-listing price range, reasoning through what an unfamiliar driver like
"resale value net of book value" should look like. An LLM can produce a
strong first draft of that research-and-numbers step in seconds. It should
never be trusted to produce a *final* driver range unsupervised — it can
hallucinate a benchmark, misjudge a unit, or silently assume a mode that's
actually the mean. The validation layer (`src/engine/validation.ts`) and a
human review pass exist specifically to catch that, and both are mandatory
steps in this workflow, not optional ones.

## The workflow

1. **Describe the business in plain English** — what it does, its rough
   scale (revenue, headcount, equipment), and the 2-3 decisions it's actually
   weighing. This is the only input a human has to supply.

2. **Draft with the prompt template below.** Paste the business description
   into it and run it against any capable LLM (this is exactly the exercise
   just performed by hand for the mine-site-services persona: a plain-English
   brief — "heavy-machinery repair and logistics to mine sites hours away" —
   became researched benchmarks, then driver ranges, then rationale strings).

3. **Validate mechanically before reading a single number.** Paste the
   drafted config into the codebase and call `validatePersona()` on it. This
   catches an inverted range, a percentage entered as a whole number, a
   negative cost, or a missing rationale — the class of mistake a reviewer
   skimming a wall of numbers is most likely to miss, and exactly the kind of
   mistake this validator was added to catch (see `docs/METHODOLOGY.md`).

4. **A human reviews every number, not just the shape.** The validator
   proves the config is *well-formed*; it says nothing about whether $850,000
   is a plausible contract size for this business, or whether an LLM invented
   a benchmark rather than citing a real one. Every rationale string must
   name a checkable source or say plainly that it's a reasoned estimate (the
   same bar `docs/BENCHMARKS.md` holds itself to) — an LLM-drafted rationale
   that just asserts a number with no basis is a rejected draft, not an
   edge case to wave through.

5. **Run it and sanity-check the output isn't degenerate.** The same check
   applied by hand to both personas in this repo: does probability-positive
   sit at a suspicious 100% or 0%? Does the tornado ranking make sense? A
   plausible-looking config can still produce nonsense output if two drivers
   interact in a way neither the LLM nor a quick read caught — this is why
   step 5 exists as its own step, separate from validation.

## The prompt template

```
You are drafting a Monte Carlo business-decision model config for a
[TYPE OF BUSINESS], described as follows:

[PLAIN-ENGLISH BUSINESS DESCRIPTION — what it does, rough scale, location/market]

Produce 2-3 decisions this business is realistically weighing. For each
decision, produce 4-6 drivers. For EVERY driver, you must:

- Choose the narrowest distribution family that fits how the number is
  actually known (see docs/METHODOLOGY.md's "Distribution choice by variable
  type" section: triangular for an expert 3-point guess with no data behind
  it, PERT for the same but weighting the likely value more heavily, normal
  for an aggregated/averaged effect, lognormal for a strictly-positive
  right-skewed cost).
- Ground the range in a checkable, named source (a government wage/price
  statistic, an industry benchmark report, a dealer/auction listing) OR
  state plainly that it's a reasoned estimate and say what reasoning
  produced it. Never state a number without one of these two.
- Write the rationale as a complete sentence a skeptical reviewer could
  fact-check, not a label.
- Use a `unit` field that makes a percentage driver identifiable as a
  fraction (e.g. "%/yr"), not a bare number — this is enforced mechanically
  by validatePersona().

Do not invent a level of precision the underlying research doesn't support
(a range like "23.4%-31.7%" is a red flag, not diligence). State each
decision's cashFlows formula in plain arithmetic before writing any code.
```

## What this workflow deliberately does NOT claim

- It does not claim an LLM's first draft is trustworthy without the
  validation + human-review steps — both are load-bearing, not optional.
- It does not claim to eliminate the research time, only to compress the
  first-draft step of it.
- It is not a live feature of this codebase, and nothing here should be
  read as "the app calls an AI model" — it's a documented process a person
  (or Claude, or any other assistant) follows when authoring a new persona,
  the same way a person would follow a style guide.
