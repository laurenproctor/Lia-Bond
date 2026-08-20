/**
 * Whether "Powered by Lia" appears on an embedded widget.
 *
 * The product brief asks for this to be "controlled by the customer's plan or
 * existing product rules". Lia has neither: there is no billing model, no
 * subscription record, and no entitlement anywhere in the schema —
 * `src/lib/site/content/pricing.ts` publishes a price list and nothing reads
 * it. So the honest implementation of "controlled by the plan" today is a
 * single decision point that answers *always shown*, plus the seam for the
 * answer to change.
 *
 * The alternative was a checkbox anyone could clear, and that would not be an
 * implementation of the brief — it would be giving the paid feature away and
 * calling it configuration.
 *
 * `attributionSuppressed` on the widget row is the seam. Nothing writes it;
 * this function is its only reader; and the day plans exist, the plan lookup
 * goes here and the column is already there to hold the answer. That is the
 * same posture `monitoring_queries.postal_code` takes toward the provider
 * upgrade it is waiting on.
 */

export interface WidgetAttributionDecision {
  /** Whether the widget draws the attribution line. */
  visible: boolean;
  /**
   * Why, in Lia's own vocabulary rather than a sentence.
   *
   * `no_plan_model` is the only value today, and naming it that — rather than
   * `free_plan` — keeps the interface from claiming a plan the customer was
   * never sold.
   */
  reason: "no_plan_model" | "suppressed_by_plan";
}

export function resolveWidgetAttribution(input: {
  attributionSuppressed: boolean;
}): WidgetAttributionDecision {
  // Deliberately reads the column and then ignores nothing: when a plan gate
  // eventually sets it, this branch is already the whole implementation.
  if (input.attributionSuppressed) {
    return { visible: false, reason: "suppressed_by_plan" };
  }
  return { visible: true, reason: "no_plan_model" };
}

/**
 * What the configuration screen tells somebody about the line they can see in
 * the preview and cannot switch off.
 *
 * Stated plainly rather than as a disabled toggle. A control that can never be
 * enabled is worse than a sentence: it invites clicking, and it implies the
 * capability is one permission away rather than one product away.
 */
export const ATTRIBUTION_EXPLANATION =
  "Every widget carries a small “Powered by Lia” line. Removing it will become available with paid plans — Lia does not bill for anything yet, so there is nothing to switch off today.";
