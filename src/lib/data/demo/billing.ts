import { emptyBilling, type OrganizationBilling, type StripeWebhookEvent } from "@/domain";
import { conflict, DataError, notFound } from "@/lib/data/errors";
import { demoRuntimeStore, scoped } from "@/lib/data/demo/store";
import { demoStore } from "@/lib/data/demo/store";
import type {
  ApplyBillingProjectionInput,
  BillingRepository,
  ClaimWebhookEventInput,
  OrganizationScope,
  RecordBillingPaymentInput,
  StripeWebhookEventRepository,
  WebhookClaim,
} from "@/lib/data/types";
import { REFERENCE_NOW } from "@/lib/seed/clock";

/**
 * The demo adapter for billing.
 *
 * Nothing is seeded, and that is the point rather than an omission. A seeded
 * billing row would carry a Stripe customer id for an account that does not
 * exist, and every screen reading it would claim the demo tenant was paying
 * somebody. The same reasoning that keeps fixture credentials and seeded
 * widgets out of the dataset.
 *
 * So `get()` returns null for an organization nothing has written, exactly as
 * the Supabase adapter does for one with no row. **Demo mode still works with
 * no Stripe configuration at all**, and it works through the real mechanism
 * rather than a special case: `BILLING_ENFORCEMENT_MODE` is unset, which means
 * `off`, which means `resolveEntitlement` grants full access to an unbilled
 * organization. Nothing here has to pretend anything has been paid for.
 *
 * The invariants the database enforces with constraints are restated in this
 * file — the trial one-way door, the single live subscription, the coalesced
 * trial stamps. That duplication is forced rather than chosen: the demo
 * adapter has no Postgres to lean on, and a fake that permitted what the real
 * one refuses would make every test passing against it worthless. Capacity is
 * the one exception, and it needs none: with nothing purchased, the trigger in
 * `20260821000300` fails open too.
 */

function nowIso(): string {
  // The seed clock, so demo timestamps stay reproducible across renders.
  return REFERENCE_NOW;
}

/** The runtime tables, declared here because only this adapter uses them. */
interface BillingRuntime {
  billing: Map<string, OrganizationBilling>;
  webhookEvents: Map<string, StripeWebhookEvent>;
}

const runtimes = new WeakMap<object, BillingRuntime>();

function runtime(): BillingRuntime {
  const key = demoRuntimeStore() as unknown as object;
  let found = runtimes.get(key);
  if (!found) {
    found = { billing: new Map(), webhookEvents: new Map() };
    runtimes.set(key, found);
  }
  return found;
}

/** The stored row, or a fresh unwritten one. Never persisted by reading. */
function current(organizationId: string): OrganizationBilling {
  return runtime().billing.get(organizationId) ?? emptyBilling(organizationId, nowIso());
}

function put(row: OrganizationBilling): OrganizationBilling {
  const next = { ...row, updatedAt: nowIso() };
  runtime().billing.set(row.organizationId, next);
  return next;
}

/**
 * Close out the event that caused this write, in the same breath as the write.
 *
 * The Supabase adapter gets this from `apply_stripe_billing_projection`, which
 * marks the event processed inside the same transaction as the projection —
 * the whole reason those functions exist (D17). Nothing here is transactional,
 * but the *sequence* has to match, because a demo run that left an event in
 * `processing` after a successful projection would report `in_progress` on the
 * next delivery and make a duplicate look like a race. That is precisely what
 * `tests/billing-webhook.test.ts` caught when this was missing.
 */
function closeEvent(stripeEventId: string | null): void {
  if (!stripeEventId) return;
  const events = runtime().webhookEvents;
  const existing = events.get(stripeEventId);
  if (!existing) return;

  events.set(stripeEventId, {
    ...existing,
    status: "processed",
    errorCategory: null,
    processedAt: nowIso(),
    updatedAt: nowIso(),
  });
}

const LIVE_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "incomplete",
  "paused",
]);

export function createDemoBillingRepository(): BillingRepository {
  return {
    async get(scope: OrganizationScope) {
      return runtime().billing.get(scope.organizationId) ?? null;
    },

    async findByCustomerId(customerId: string) {
      for (const row of runtime().billing.values()) {
        if (row.stripeCustomerId === customerId) return row;
      }
      return null;
    },

    async bindCustomer(organizationId: string, customerId: string) {
      const existing = current(organizationId);
      if (existing.stripeCustomerId && existing.stripeCustomerId !== customerId) {
        throw conflict("This organization is already linked to a different Stripe customer.");
      }
      return put({ ...existing, stripeCustomerId: existing.stripeCustomerId ?? customerId });
    },

    async applyProjection(input: ApplyBillingProjectionInput) {
      const existing = current(input.organizationId);

      // The same refusal `apply_stripe_billing_projection` raises. An
      // organization has exactly one subscription, and a second one arriving
      // is either a race or a mistake — never something to overwrite quietly.
      if (
        existing.stripeSubscriptionId &&
        input.subscriptionId &&
        existing.stripeSubscriptionId !== input.subscriptionId &&
        existing.subscriptionStatus &&
        LIVE_STATUSES.has(existing.subscriptionStatus)
      ) {
        throw conflict("This organization already has a live subscription.");
      }

      // Coalesced, so a replayed or out-of-order event cannot move the dates a
      // customer was told.
      const trialStartedAt = existing.trialStartedAt ?? input.trialStart;
      const trialEnd = existing.trialEnd ?? input.trialEnd;

      const canceledInTrial =
        input.status === "canceled" &&
        trialStartedAt !== null &&
        existing.trialConvertedAt === null;

      const projected = put({
        ...existing,
        stripeCustomerId: input.customerId ?? existing.stripeCustomerId,
        stripeSubscriptionId: input.subscriptionId,
        stripeSubscriptionItemId: input.itemId,
        stripePriceId: input.priceId,
        billingInterval: input.interval,
        subscriptionStatus: input.status,
        purchasedLocationQuantity: input.quantity,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        trialStartedAt,
        trialEnd,
        trialGrantSource:
          trialStartedAt === null
            ? null
            : (existing.trialGrantSource ?? input.trialGrantSource),
        // The one-way door, restated. The check constraint in the schema
        // refuses any row where a started trial is still eligible.
        trialEligible: trialStartedAt !== null ? false : existing.trialEligible,
        trialCanceledAt: canceledInTrial
          ? (existing.trialCanceledAt ?? nowIso())
          : existing.trialCanceledAt,
      });

      closeEvent(input.stripeEventId);
      return projected;
    },

    async recordPayment(input: RecordBillingPaymentInput) {
      const existing = runtime().billing.get(input.organizationId);
      if (!existing) throw notFound("Billing record");

      const recorded = put({
        ...existing,
        lastPaidAt: input.paid ? input.occurredAt : existing.lastPaidAt,
        lastPaymentFailureAt: input.paid
          ? existing.lastPaymentFailureAt
          : input.occurredAt,
        firstPaymentFailedAt:
          !input.paid && input.isFirstCharge
            ? (existing.firstPaymentFailedAt ?? input.occurredAt)
            : existing.firstPaymentFailedAt,
        trialConvertedAt:
          input.paid && existing.trialStartedAt !== null
            ? (existing.trialConvertedAt ?? input.occurredAt)
            : existing.trialConvertedAt,
      });

      closeEvent(input.stripeEventId);
      return recorded;
    },

    async countBillableLocations(scope: OrganizationScope) {
      return scoped(demoStore().locations, scope.organizationId).filter(
        (location) => location.status !== "inactive",
      ).length;
    },

    async listForReconciliation(limit: number) {
      return [...runtime().billing.values()]
        .filter((row) => row.stripeCustomerId !== null)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, limit);
    },

    async grantTrial(input) {
      const existing = current(input.organizationId);
      if (input.grantSource === "self_service") {
        throw new DataError(
          "invalid_input",
          "A self-service trial is granted by Checkout, not by an operator.",
        );
      }
      // Clearing the start date is what re-opens eligibility — the same shape
      // the SQL function writes, because the check constraint permits no other.
      return put({
        ...existing,
        trialEligible: true,
        trialStartedAt: null,
        trialEnd: null,
        trialGrantSource: null,
      });
    },

    async setAccessDisposition(input) {
      const existing = current(input.organizationId);
      return put({
        ...existing,
        accessDisposition: input.disposition,
        accessDispositionExpiresAt:
          input.disposition === "standard" ? null : input.expiresAt,
        accessDispositionNote: input.note,
      });
    },
  };
}

export function createDemoStripeWebhookEventRepository(): StripeWebhookEventRepository {
  return {
    async claim(input: ClaimWebhookEventInput): Promise<WebhookClaim> {
      const events = runtime().webhookEvents;
      const existing = events.get(input.stripeEventId);

      if (!existing) {
        events.set(input.stripeEventId, {
          stripeEventId: input.stripeEventId,
          eventType: input.eventType,
          stripeObjectId: input.stripeObjectId,
          livemode: input.livemode,
          stripeCreatedAt: input.stripeCreatedAt,
          status: "processing",
          attemptCount: 1,
          errorCategory: null,
          receivedAt: nowIso(),
          processedAt: null,
          updatedAt: nowIso(),
        });
        return "claimed";
      }

      if (existing.status === "processed" || existing.status === "ignored") {
        return "already_processed";
      }
      if (existing.status === "processing") return "in_progress";

      // received or failed: claimable, and the attempt count moves.
      events.set(input.stripeEventId, {
        ...existing,
        status: "processing",
        attemptCount: existing.attemptCount + 1,
        errorCategory: null,
        updatedAt: nowIso(),
      });
      return "claimed";
    },

    async finish(stripeEventId, status, errorCategory = null) {
      const events = runtime().webhookEvents;
      const existing = events.get(stripeEventId);
      if (!existing) return;

      events.set(stripeEventId, {
        ...existing,
        status,
        errorCategory: status === "failed" ? errorCategory : null,
        processedAt: status === "failed" ? existing.processedAt : nowIso(),
        updatedAt: nowIso(),
      });
    },

    async get(stripeEventId: string) {
      return runtime().webhookEvents.get(stripeEventId) ?? null;
    },
  };
}
