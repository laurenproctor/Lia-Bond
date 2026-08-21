import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AccessDisposition,
  OrganizationBilling,
  StripeWebhookEvent,
  TrialGrantSource,
} from "@/domain";
import { stripeWebhookEventSchema } from "@/domain";
import { conflict, DataError, notFound } from "@/lib/data/errors";
import { toOrganizationBilling } from "@/lib/data/supabase/mappers";
import type {
  ApplyBillingProjectionInput,
  BillingRepository,
  ClaimWebhookEventInput,
  OrganizationScope,
  RecordBillingPaymentInput,
  StripeWebhookEventRepository,
  WebhookClaim,
} from "@/lib/data/types";

/**
 * The Supabase adapter for billing.
 *
 * Almost every method here is an RPC rather than a table write, and that is
 * the design rather than a quirk. `20260821000200` revokes every write grant
 * on both tables, so a session cannot write them at all and this adapter has
 * nothing to write with. What it calls instead are the `SECURITY DEFINER`
 * functions in `20260821000300`, each of which does the whole job — projection,
 * audit, and the originating event's terminal status — in one transaction.
 *
 * The Supabase client cannot express a multi-statement transaction, and a
 * webhook that marked an event processed before its effects were durable would
 * be a silent, permanent divergence no retry could repair. So the transaction
 * boundary lives in Postgres, and this file is a thin translation layer over
 * it (D17).
 *
 * `get` is the exception and is an ordinary select: reading is what the RLS
 * policy permits, and every member holds it.
 *
 * NOTE: like the rest of this adapter, these paths have been exercised against
 * a local Postgres through the SQL harness rather than through PostgREST. See
 * the note at the top of `index.ts`.
 */

type Row = Record<string, unknown>;

/**
 * Duplicated from `index.ts` rather than imported, for the reason
 * `supabase/monitoring.ts`, `supabase/yelp.ts`, and `supabase/review-widgets.ts`
 * all record: `index.ts` imports this module to wire it in, so importing back
 * would be circular.
 */
function fail(error: { message: string; code?: string; hint?: string | null }, action: string): never {
  // The functions raise with a `hint` naming the invariant that was broken,
  // so the adapter can turn a Postgres error into a sentence about the
  // product rather than about the database.
  if (error.hint === "billing_capacity_exhausted") {
    throw conflict(
      "That would exceed the number of locations this organization has paid for.",
    );
  }
  if (error.hint === "duplicate_subscription") {
    throw conflict("This organization already has a live subscription.");
  }
  if (error.hint === "billing_customer_conflict") {
    throw conflict("This organization is already linked to a different Stripe customer.");
  }
  if (error.hint === "unmatched_customer") {
    throw notFound("Billing record");
  }
  if (error.code === "23505") {
    throw conflict("That record already exists.");
  }
  if (error.code === "23514") {
    // A check constraint refused the row — most likely the trial invariant.
    throw new DataError("invalid_input", "That billing change is not allowed.");
  }
  if (error.code === "42501" || error.code === "PGRST301") {
    throw new DataError("forbidden", "You don't have permission to do that.");
  }
  // No driver message: it can quote a connection string.
  throw new DataError("unavailable", `Could not ${action}. Please try again.`);
}

/** A composite-returning function gives back a single object, or null. */
function single(data: unknown): Row {
  if (Array.isArray(data)) {
    const first = data[0] as Row | undefined;
    if (!first) throw new DataError("unavailable", "Billing returned no record.");
    return first;
  }
  if (data === null || data === undefined) {
    throw new DataError("unavailable", "Billing returned no record.");
  }
  return data as Row;
}

export function createBillingRepository(
  client: SupabaseClient,
): BillingRepository {
  return {
    async get(scope: OrganizationScope): Promise<OrganizationBilling | null> {
      const { data, error } = await client
        .from("organization_billing")
        .select("*")
        .eq("organization_id", scope.organizationId)
        .maybeSingle();

      if (error) fail(error, "load billing");
      return data ? toOrganizationBilling(data as Row) : null;
    },

    async findByCustomerId(customerId: string): Promise<OrganizationBilling | null> {
      const { data, error } = await client
        .from("organization_billing")
        .select("*")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      if (error) fail(error, "resolve the organization for that customer");
      return data ? toOrganizationBilling(data as Row) : null;
    },

    async bindCustomer(organizationId: string, customerId: string) {
      const { data, error } = await client.rpc("bind_billing_customer", {
        p_organization_id: organizationId,
        p_customer_id: customerId,
      });

      if (error) fail(error, "link the Stripe customer");
      return toOrganizationBilling(single(data));
    },

    async applyProjection(input: ApplyBillingProjectionInput) {
      const { data, error } = await client.rpc("apply_stripe_billing_projection", {
        p_organization_id: input.organizationId,
        p_customer_id: input.customerId,
        p_subscription_id: input.subscriptionId,
        p_item_id: input.itemId,
        p_price_id: input.priceId,
        p_interval: input.interval,
        p_status: input.status,
        p_quantity: input.quantity,
        p_period_start: input.currentPeriodStart,
        p_period_end: input.currentPeriodEnd,
        p_cancel_at_period_end: input.cancelAtPeriodEnd,
        p_trial_start: input.trialStart,
        p_trial_end: input.trialEnd,
        p_trial_grant_source: input.trialGrantSource,
        p_event_id: input.stripeEventId,
        p_actor_type: "integration",
      });

      if (error) fail(error, "record the subscription change");
      return toOrganizationBilling(single(data));
    },

    async recordPayment(input: RecordBillingPaymentInput) {
      const { data, error } = await client.rpc("record_billing_payment", {
        p_organization_id: input.organizationId,
        p_paid: input.paid,
        p_occurred_at: input.occurredAt,
        p_is_first_charge: input.isFirstCharge,
        p_event_id: input.stripeEventId,
      });

      if (error) fail(error, "record the payment");
      return toOrganizationBilling(single(data));
    },

    async countBillableLocations(scope: OrganizationScope): Promise<number> {
      // An ordinary, RLS-protected count rather than the SECURITY DEFINER
      // function the capacity trigger uses. Same definition, but reached
      // through a policy: the function is revoked from sessions precisely so
      // that passing somebody else's organization id counts nothing.
      const { count, error } = await client
        .from("locations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", scope.organizationId)
        .neq("status", "inactive");

      if (error) fail(error, "count billable locations");
      return count ?? 0;
    },

    async listForReconciliation(limit: number) {
      const { data, error } = await client
        .from("organization_billing")
        .select("*")
        .not("stripe_customer_id", "is", null)
        .order("updated_at", { ascending: true })
        .limit(limit);

      if (error) fail(error, "list billing records");
      return (data ?? []).map((row) => toOrganizationBilling(row as Row));
    },

    async grantTrial(input) {
      const { data, error } = await client.rpc("grant_billing_trial", {
        p_organization_id: input.organizationId,
        p_grant_source: input.grantSource satisfies TrialGrantSource,
        p_actor_user_id: input.actorUserId,
        p_note: input.note,
      });

      if (error) fail(error, "grant the trial");
      return toOrganizationBilling(single(data));
    },

    async setAccessDisposition(input) {
      const { data, error } = await client.rpc("set_billing_access_disposition", {
        p_organization_id: input.organizationId,
        p_disposition: input.disposition satisfies AccessDisposition,
        p_expires_at: input.expiresAt,
        p_note: input.note,
        p_actor_user_id: input.actorUserId,
      });

      if (error) fail(error, "change billing access");
      return toOrganizationBilling(single(data));
    },
  };
}

export function createStripeWebhookEventRepository(
  client: SupabaseClient,
): StripeWebhookEventRepository {
  return {
    async claim(input: ClaimWebhookEventInput): Promise<WebhookClaim> {
      const { data, error } = await client.rpc("claim_stripe_webhook_event", {
        p_event_id: input.stripeEventId,
        p_event_type: input.eventType,
        p_object_id: input.stripeObjectId,
        p_livemode: input.livemode,
        p_created_at: input.stripeCreatedAt,
      });

      if (error) fail(error, "record the Stripe event");

      const claim = String(data);
      if (claim !== "claimed" && claim !== "already_processed" && claim !== "in_progress") {
        throw new DataError("unavailable", "Billing returned an unknown claim result.");
      }
      return claim;
    },

    async finish(stripeEventId, status, errorCategory = null) {
      const { error } = await client.rpc("finish_stripe_webhook_event", {
        p_event_id: stripeEventId,
        p_status: status,
        p_error_category: errorCategory,
      });

      if (error) fail(error, "close out the Stripe event");
    },

    async get(stripeEventId: string): Promise<StripeWebhookEvent | null> {
      const { data, error } = await client
        .from("stripe_webhook_events")
        .select("*")
        .eq("stripe_event_id", stripeEventId)
        .maybeSingle();

      if (error) fail(error, "load the Stripe event");
      if (!data) return null;

      const row = data as Row;
      return stripeWebhookEventSchema.parse({
        stripeEventId: row.stripe_event_id,
        eventType: row.event_type,
        stripeObjectId: row.stripe_object_id ?? null,
        livemode: row.livemode,
        stripeCreatedAt: new Date(String(row.stripe_created_at)).toISOString(),
        status: row.status,
        attemptCount: row.attempt_count,
        errorCategory: row.error_category ?? null,
        receivedAt: new Date(String(row.received_at)).toISOString(),
        processedAt: row.processed_at
          ? new Date(String(row.processed_at)).toISOString()
          : null,
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      });
    },
  };
}
