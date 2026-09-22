/**
 * Wraps a sampled inputs record so that a typo'd driver id inside a
 * `Decision.cashFlows` implementation (e.g. `inputs.contributionMargin`
 * instead of `inputs.contributionMarginPerUnit`) throws immediately with a
 * clear message, instead of silently reading `undefined`, propagating a
 * `NaN` through every downstream calculation, and surfacing — if at all —
 * as a confusing "non-finite NPV sample" failure several layers away from
 * the actual mistake.
 *
 * This isn't full compile-time safety (that would need a Decision type
 * parameterized by a union of its own driver ids, a bigger refactor than
 * this codebase's return-on-effort currently justifies), but it converts a
 * silent data bug into a loud, precisely-located one at essentially zero
 * runtime cost.
 */
export function guardInputs(inputs: Record<string, number>, decisionId: string): Record<string, number> {
  return new Proxy(inputs, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        throw new Error(
          `Decision "${decisionId}": cashFlows() read driver id "${prop}", which has no matching entry in this decision's drivers[] — almost certainly a typo. Known driver ids: ${Object.keys(target).join(", ")}`,
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
