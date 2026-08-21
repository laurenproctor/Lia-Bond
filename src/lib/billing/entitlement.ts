import type {
  EntitlementAccess,
  EntitlementReason,
  OrganizationBilling,
} from "@/domain";

/**
 * What an organization may do, given what Stripe says about it.
 *
 * One pure function. No I/O, no framework imports, no clock of its own — the
 * same posture `src/lib/auth/permissions.ts` takes for roles, and for the same
 * reason: this is the rule that decides whether a paying customer can work,
 * and a rule like that should be readable in one screen and testable without a
 * database.
 *
 * The separation it maintains is the whole architecture of this feature.
 * Stripe owns what a subscription *is* — Lia does not rename, collapse, or
 * second-guess a single one of its statuses. Lia owns what an organization may
 * *do*. This function is the only place the first becomes the second, which is
 * why the entitlement question has one answer everywhere in the product
 * instead of one answer per screen that remembered to ask.
 *
 * ## What it will never return
 *
 * There is no value here that means "suspend the memberships", "delete the
 * organization", or "remove the locations". The worst outcome this function
 * can produce is `read_only`, and read-only means every record the customer
 * ever made is still there, still readable, and still exportable. A billing
 * failure is a commercial event, not a data event.
 *
 * ## Enforcement is applied last, on purpose
 *
 * The natural entitlement is computed first, from Stripe's state alone, and
 * only then does the rollout mode get to soften it. Two consequences, both
 * deliberate:
 *
 * - While enforcement is off, `reason` is still the *true* reason. The banner
 *   tells a `past_due` customer their payment failed even though nothing is
 *   blocked, so the rollout does not also suppress the warnings.
 * - Turning enforcement on changes one branch at the very end. It cannot
 *   change what Lia believes about a subscription, which is what makes the
 *   kill switch trustworthy: flipping it back restores access without
 *   touching Stripe or rewriting a single projected value.
 */

/** How much of the rollout is switched on. Mirrors `BILLING_ENFORCEMENT_MODE`. */
export type BillingEnforcementMode = "off" | "allowlist" | "on";

export interface EntitlementInput {
  billing: OrganizationBilling;
  enforcement: BillingEnforcementMode;
  /** Organizations enforcement applies to while `enforcement` is `allowlist`. */
  allowlist: readonly string[];
  /** ISO-8601. Passed in rather than read, so every state is reachable in a test. */
  now: string;
}

export interface Entitlement {
  access: EntitlementAccess;
  reason: EntitlementReason;
  /** When paid access runs out, where that is a knowable date. */
  paidThrough: string | null;
  /** Whole days left of a trial, floored at zero. Null when not trialing. */
  trialDaysRemaining: number | null;
  /** When the first charge lands, for a trialing organization. */
  firstChargeAt: string | null;
  /**
   * Always true, and a constant rather than a computation so that no future
   * edit can make it false by accident. An organization that cannot reach its
   * own billing page cannot pay, and a product that locks people out of paying
   * has turned a declined card into a cancelled customer.
   */
  billingRoutesAvailable: true;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from `now` to `iso`, floored at zero. */
function daysUntil(iso: string, now: string): number {
  const remaining = Date.parse(iso) - Date.parse(now);
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.ceil(remaining / MILLISECONDS_PER_DAY);
}

function isFuture(iso: string | null, now: string): boolean {
  if (iso === null) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > Date.parse(now);
}

/** Whether the rollout is switched on for this organization. */
export function isEnforced(
  organizationId: string,
  enforcement: BillingEnforcementMode,
  allowlist: readonly string[],
): boolean {
  if (enforcement === "off") return false;
  if (enforcement === "on") return true;
  return allowlist.includes(organizationId);
}

export function resolveEntitlement(input: EntitlementInput): Entitlement {
  const natural = naturalEntitlement(input);

  const enforced = isEnforced(
    input.billing.organizationId,
    input.enforcement,
    input.allowlist,
  );

  if (enforced) return natural;

  // Softening, never hardening. A warning stays a warning — the rollout mode
  // decides what is blocked, not what the customer is told.
  //
  // The one reason that changes wording is "no subscription": while
  // enforcement is off that is an ordinary state shared by every organization
  // that predates billing, and calling it `no_subscription` would put a
  // "choose a plan" refusal in front of people nothing is refusing. The
  // distinct name is what lets the banner invite rather than warn.
  if (natural.reason === "no_subscription") {
    return { ...natural, access: "full", reason: "unbilled_not_enforced" };
  }

  if (natural.access === "read_only") {
    return { ...natural, access: "full" };
  }

  return natural;
}

function naturalEntitlement(input: EntitlementInput): Entitlement {
  const { billing, now } = input;

  const base = {
    paidThrough: billing.currentPeriodEnd,
    trialDaysRemaining: null,
    firstChargeAt: null,
    billingRoutesAvailable: true,
  } as const;

  // A deliberate, audited grant outruns whatever the subscription says. An
  // internal organization with a cancelled test subscription still works, and
  // a complimentary grant with an expiry stops meaning anything the moment it
  // lapses — which is what makes "optionally time-limited" true rather than
  // aspirational.
  const dispositionActive =
    billing.accessDisposition !== "standard" &&
    (billing.accessDispositionExpiresAt === null ||
      isFuture(billing.accessDispositionExpiresAt, now));

  if (dispositionActive) {
    return {
      ...base,
      access: "full",
      reason: "complimentary",
      paidThrough: billing.accessDispositionExpiresAt,
    };
  }

  if (billing.subscriptionStatus === null) {
    return { ...base, access: "read_only", reason: "no_subscription" };
  }

  switch (billing.subscriptionStatus) {
    case "trialing":
      return {
        ...base,
        access: "full",
        reason: "trialing",
        trialDaysRemaining: billing.trialEnd ? daysUntil(billing.trialEnd, now) : null,
        firstChargeAt: billing.trialEnd,
      };

    case "active":
      return { ...base, access: "full", reason: "active" };

    // Stripe is still retrying. The customer keeps working and gets told
    // loudly — Lia invents no deadline of its own here, because Stripe's Smart
    // Retries decide when recovery is over and a second clock would contradict
    // the first.
    case "past_due":
      return { ...base, access: "full_with_warning", reason: "payment_past_due" };

    // The very first payment has not completed. Recoverable, and usually
    // within the hour, so blocking would punish a 3-D Secure prompt.
    case "incomplete":
      return { ...base, access: "full_with_warning", reason: "billing_setup_incomplete" };

    case "incomplete_expired":
      return { ...base, access: "read_only", reason: "billing_setup_expired" };

    // Stripe has stopped trying. Access stops; recovery stays open.
    case "unpaid":
      return { ...base, access: "read_only", reason: "payment_unpaid" };

    case "paused":
      return { ...base, access: "read_only", reason: "subscription_paused" };

    case "canceled": {
      const trialledWithoutConverting =
        billing.trialStartedAt !== null && billing.trialConvertedAt === null;

      if (trialledWithoutConverting) {
        // Cancelled by the customer before the trial ran out, or left to
        // expire. Nothing was charged either way, but they are different
        // things to say to somebody, and only one of them is a decision they
        // made.
        const endedEarly =
          billing.trialCanceledAt !== null && isFuture(billing.trialEnd, now);
        return {
          ...base,
          access: "read_only",
          reason: endedEarly ? "trial_canceled" : "trial_expired",
          paidThrough: null,
        };
      }

      // Cancelled after paying. The period already bought does not evaporate.
      if (isFuture(billing.currentPeriodEnd, now)) {
        return { ...base, access: "full", reason: "canceled_paid_through" };
      }

      return { ...base, access: "read_only", reason: "subscription_canceled" };
    }
  }
}

/**
 * The capabilities read-only mode keeps.
 *
 * Written as an allowlist of what still works rather than a denylist of what
 * does not, because the failure mode worth engineering against is a *new*
 * write path shipping without anyone remembering it should be gated. A
 * denylist would let it through silently; an allowlist means a new mutation is
 * blocked until somebody makes a decision about it.
 */
export function isReadOnly(entitlement: Entitlement): boolean {
  return entitlement.access === "read_only";
}

/** Whether the product should be showing a billing problem, warning or worse. */
export function hasBillingProblem(entitlement: Entitlement): boolean {
  return entitlement.access !== "full";
}
