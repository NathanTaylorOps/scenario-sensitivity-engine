/**
 * Synthesizes the Monte Carlo output into a single call, because a GM using
 * this tool wants an at-a-glance answer with the numbers behind it
 * available on demand — not the numbers alone, left for them to interpret
 * every time. Thresholds are a stated design choice (documented here and in
 * docs/METHODOLOGY.md), not a hidden magic number: 70%/40% is a common
 * capital-budgeting rule of thumb, not a statistically derived cutoff, and
 * a reviewer is free to disagree with it — that's the point of stating it.
 */
export type Verdict = "Proceed" | "Marginal" | "Reconsider";

export interface VerdictResult {
  verdict: Verdict;
  probabilityPositive: number;
  rationale: string;
}

const PROCEED_THRESHOLD = 0.7;
const MARGINAL_THRESHOLD = 0.4;

export function decisionVerdict(probabilityPositive: number): VerdictResult {
  const pct = (probabilityPositive * 100).toFixed(0);
  if (probabilityPositive >= PROCEED_THRESHOLD) {
    return {
      verdict: "Proceed",
      probabilityPositive,
      rationale: `NPV is positive in ${pct}% of simulated outcomes — comfortably favorable. Still worth reading the downside case and the tornado ranking before committing.`,
    };
  }
  if (probabilityPositive >= MARGINAL_THRESHOLD) {
    return {
      verdict: "Marginal",
      probabilityPositive,
      rationale: `NPV is positive in only ${pct}% of simulated outcomes — close to a coin flip. Check the tornado ranking for what has to go right, and consider what would need to change before committing.`,
    };
  }
  return {
    verdict: "Reconsider",
    probabilityPositive,
    rationale: `NPV is positive in just ${pct}% of simulated outcomes — the base assumptions would need to improve materially before this clears the bar.`,
  };
}
