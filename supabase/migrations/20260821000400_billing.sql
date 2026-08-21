-- Stripe subscription billing: the projection, and the event log behind it.
--
-- The argument for the shape is in docs/billing.md; what belongs next to the
-- DDL is the reasoning somebody will want when they are looking at a column
-- and wondering why it is not something else.
--
-- 1. **Stripe owns money; this schema owns a projection of it.** Not one
--    column here is authoritative. Every value is copied from a Stripe object
--    that was re-retrieved from Stripe's API after a signed webhook said
--    something had changed. That is why there is no `amount_due`, no
--    `card_last4`, no invoice table and no payment-method table: Lia does not
--    need them to decide what an organization may do, and each one would be a
--    second copy of a fact Stripe already holds and would eventually disagree
--    with. The reconciliation job exists because even this much can drift.
--
-- 2. **One row per organization, keyed on the organization.** The same shape
--    as `organization_onboarding`, for the same reason: "one subscription per
--    organization" stops being a rule the application has to remember and
--    becomes something the schema cannot express otherwise. There is no
--    surrogate id for a second row to occupy.
--
-- 3. **Billing state is not membership state.** Nothing in this migration
--    touches `memberships`, `locations`, `mentions`, or anything a customer
--    made. A failed payment moves a word in one column of one row; what that
--    word *means* is decided by `resolveEntitlement` in application code, and
--    the worst it can decide is read-only. Deleting customer data is not a
--    state this schema can reach.
--
-- 4. **The trial is a one-way door, enforced here rather than above.**
--    `organization_billing_trial_is_once` makes "a started trial leaves the
--    organization ineligible" a property of the table. No repository method,
--    no replayed webhook, no mistaken operator, and no future author who has
--    not read this file can hand out a second self-service trial, because the
--    database will refuse the row. Application checks protect the paths that
--    run them; this protects all of them.
--
-- 5. **No card data, ever.** Not a number, not a fingerprint, not a brand, not
--    an expiry, not a payment-method id. Lia has no use for any of it and
--    holding it would put this schema in scope for obligations it is nowhere
--    near ready for. The hosted portal is the only surface where a card is
--    touched, and it is Stripe's.
--
-- 6. **New vocabularies are check-constrained text, not Postgres enums**,
--    following the Reddit and Yelp precedent — an enum value cannot be
--    dropped, and `subscription_status` is somebody else's API.

-- ---------------------------------------------------------------------------
-- Audit subject.
--
-- `audit_entity_type` is a Postgres enum, so this is an `add value` rather
-- than part of the vocabulary migration that restates the event names.
-- Billing gets its own subject rather than reusing `organization`: "what
-- happened to this company" and "what happened to what this company pays" are
-- different questions, and the second is the one somebody asks with a lawyer
-- in the room.
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value if not exists 'organization_billing';

-- ---------------------------------------------------------------------------
-- organization_billing
-- ---------------------------------------------------------------------------

create table public.organization_billing (
  organization_id uuid primary key
    references public.organizations (id) on delete cascade,

  -- Stripe identity. The customer is created once and outlives every
  -- subscription the organization ever has, which is why it is separate from
  -- the subscription columns and why it is the join the webhook resolves a
  -- tenant through. Unique across the table: one Stripe customer belongs to
  -- exactly one organization, and the database refusing a second mapping is
  -- what stops a mis-set metadata field turning into a cross-tenant read.
  stripe_customer_id text unique,

  -- The current subscription, or none. All six of these move together — see
  -- the pairing constraint below.
  stripe_subscription_id text unique,
  -- The item, not just the subscription. From API version 2025-03-31.basil
  -- onward a subscription has no `current_period_start`/`_end` of its own;
  -- both live on the item, and so does `quantity`. Storing the item id is
  -- what lets a capacity change be one API call rather than a retrieve
  -- followed by a guess about which item is the right one.
  stripe_subscription_item_id text,
  stripe_price_id text,
  billing_interval text check (billing_interval in ('month', 'year')),
  subscription_status text check (
    subscription_status in (
      'trialing', 'active', 'past_due', 'incomplete',
      'incomplete_expired', 'unpaid', 'canceled', 'paused'
    )
  ),
  -- Purchased location capacity. Stripe's word for it is `quantity`; Lia's
  -- word says what the number counts, because a bare `quantity` on a billing
  -- table invites somebody to read it as a number of subscriptions.
  purchased_location_quantity integer check (
    purchased_location_quantity between 1 and 100
  ),

  current_period_start timestamptz,
  current_period_end timestamptz,
  -- Not derivable from `subscription_status`: a subscription cancelling at
  -- period end stays `active` until it does, so this is the only column that
  -- distinguishes "renewing" from "running out".
  cancel_at_period_end boolean not null default false,

  -- Trial lifecycle.
  trial_eligible boolean not null default true,
  trial_started_at timestamptz,
  trial_end timestamptz,
  trial_converted_at timestamptz,
  trial_canceled_at timestamptz,
  trial_grant_source text check (
    trial_grant_source in ('self_service', 'operator', 'sales')
  ),

  -- Payment health. Three timestamps rather than a status word, because each
  -- answers a question the others cannot: whether the *first* charge after a
  -- trial ever succeeded (the conversion question), when money last arrived,
  -- and when a payment last failed. A single `payment_status` column would
  -- collapse all three into whichever happened most recently.
  first_payment_failed_at timestamptz,
  last_payment_failure_at timestamptz,
  last_paid_at timestamptz,

  -- Why this organization has access it is not paying for.
  --
  -- The brief's requirement that complimentary access be explicit, auditable,
  -- explainable, and optionally time-limited is these three columns. The
  -- alternative — free access as the *absence* of a subscription row — is
  -- indistinguishable from a customer who never paid, which is exactly the
  -- silent permanent grant this is arranged to prevent.
  access_disposition text not null default 'standard' check (
    access_disposition in (
      'standard', 'internal', 'complimentary', 'grandfathered', 'sales_managed'
    )
  ),
  access_disposition_expires_at timestamptz,
  access_disposition_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A started trial can never leave the organization eligible for another.
  --
  -- The single most important line in this file. Cancelling a trial, deleting
  -- and recreating a Checkout Session, replaying a webhook, and restoring a
  -- backup all leave `trial_started_at` set, and none of them can therefore
  -- restore eligibility. Re-granting is possible, but only by clearing the
  -- start date through `grant_billing_trial()`, which is service-role only and
  -- writes an audit event naming the operator.
  constraint organization_billing_trial_is_once check (
    trial_started_at is null or trial_eligible = false
  ),

  -- A trial has a start, an end, and a grantor, or it has none of them. A row
  -- carrying one without the others is a trial nobody can date or attribute.
  constraint organization_billing_trial_pairing check (
    (trial_started_at is null) = (trial_end is null)
    and (trial_started_at is null) = (trial_grant_source is null)
  ),

  -- The six subscription columns are all set or all null.
  --
  -- Without this, a partially applied projection is a state every reader has
  -- to handle and none would handle the same way — a status with no period, a
  -- price with no quantity. `num_nulls` rather than six `is null` clauses
  -- because the failure being prevented is "some of them", not any particular
  -- one.
  constraint organization_billing_subscription_pairing check (
    num_nulls(
      stripe_subscription_id, stripe_subscription_item_id, stripe_price_id,
      billing_interval, subscription_status, purchased_location_quantity
    ) in (0, 6)
  ),

  -- A subscription requires a customer to have been created first. The
  -- reverse is ordinary: a customer with no subscription is somebody who
  -- reached Checkout and did not finish.
  constraint organization_billing_subscription_needs_customer check (
    stripe_subscription_id is null or stripe_customer_id is not null
  ),

  -- Only a non-standard disposition may carry an expiry. An expiry on
  -- `standard` would read as paid access running out, which is what
  -- `current_period_end` already says.
  constraint organization_billing_disposition_expiry check (
    access_disposition <> 'standard' or access_disposition_expires_at is null
  )
);

comment on table public.organization_billing is
  'One organization''s billing relationship with Stripe. A projection, never a source of truth: every Stripe column is copied from an object re-retrieved after a signed webhook. Holds no card, bank, or payment-method data of any kind.';
comment on column public.organization_billing.stripe_customer_id is
  'The Stripe customer for this organization. Unique: the webhook resolves a tenant through this column, so a second organization claiming the same customer must be impossible rather than merely unexpected.';
comment on column public.organization_billing.stripe_subscription_item_id is
  'The subscription item. Since 2025-03-31.basil the billing period and the quantity live here rather than on the subscription, so this is the id every capacity change and period read needs.';
comment on column public.organization_billing.purchased_location_quantity is
  'Purchased location capacity. Enforced against the billable location count by enforce_location_capacity() on public.locations, and bounded at 100 because self-service stops there — a tiered Stripe price must end in an unbounded tier, so Stripe would bill a 101st location happily and Lia is what refuses it.';
comment on column public.organization_billing.trial_eligible is
  'Whether a self-service trial may still be granted. Constrained so that a row with trial_started_at can never be eligible; only grant_billing_trial() can re-open it, and it audits who did.';
comment on column public.organization_billing.first_payment_failed_at is
  'When the first charge after a trial failed. Distinct from last_payment_failure_at because "never successfully converted" and "lapsed after months of paying" are different customers needing different conversations.';
comment on column public.organization_billing.access_disposition is
  'Why this organization has access it is not paying for. standard means entitlement comes from the subscription or from nowhere. Every other value is a deliberate, audited grant — free access is never the absence of a row.';

create trigger organization_billing_set_updated_at
  before update on public.organization_billing
  for each row execute function public.set_updated_at();

-- Reconciliation and the trial sweep both scan by these. Partial, because the
-- overwhelming majority of rows are null on both once billing is widespread.
create index organization_billing_trial_end_idx
  on public.organization_billing (trial_end)
  where trial_end is not null;

create index organization_billing_status_idx
  on public.organization_billing (subscription_status)
  where subscription_status is not null;

-- The disposition sweep: which grandfathered or complimentary grants are
-- about to lapse, and therefore who needs telling before they do.
create index organization_billing_disposition_expiry_idx
  on public.organization_billing (access_disposition_expires_at)
  where access_disposition_expires_at is not null;

-- ---------------------------------------------------------------------------
-- stripe_webhook_events
--
-- Operational, not tenant data — which is why it has no `organization_id`.
-- An event arrives before the organization is known (that is the whole job of
-- resolving one), and giving the table a tenant column would mean either
-- writing it null on every row or delaying the insert until after the lookup
-- that the insert is supposed to make idempotent. `oauth_states` is not
-- organization-scoped for the same reason.
--
-- The primary key *is* the Stripe event id, so deduplication is not a check
-- somebody has to remember to perform. Two concurrent deliveries of one event
-- race on a unique index and exactly one wins.
-- ---------------------------------------------------------------------------

create table public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  -- The subscription, invoice, or session the event was about. Correlation
  -- for a human reading the table; nothing joins on it.
  stripe_object_id text,
  -- The tripwire. A sandbox key must never process a live event and a live
  -- key must never process a sandbox one; both are stored so that a mismatch
  -- is visible after the fact rather than only refused in the moment.
  livemode boolean not null,
  stripe_created_at timestamptz not null,

  status text not null default 'received' check (
    status in ('received', 'processing', 'processed', 'failed', 'ignored')
  ),
  attempt_count integer not null default 0,

  -- Lia's word for what went wrong, from a closed list, or null.
  --
  -- **Never a provider message.** A Stripe error can quote a request URL and a
  -- driver error can quote a connection string; neither is written here,
  -- logged, or returned. The same rule news_poll_runs.error_message and the
  -- Anthropic client already keep, applied where breaking it would be a
  -- compliance incident rather than an embarrassment.
  error_category text check (
    error_category in (
      'signature', 'mode_mismatch', 'unmatched_customer',
      'unmatched_subscription', 'organization_mismatch',
      'duplicate_subscription', 'stripe_api_error', 'database_error',
      'unhandled'
    )
  ),

  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),

  -- A processed or ignored event is finished and says when. A failed one
  -- carries a category. Both halves matter: an event marked processed with no
  -- timestamp cannot be aged out, and one marked failed with no category
  -- tells an operator nothing they can act on.
  constraint stripe_webhook_events_terminal_shape check (
    case
      when status in ('processed', 'ignored') then processed_at is not null
      when status = 'failed' then error_category is not null
      else true
    end
  )
);

comment on table public.stripe_webhook_events is
  'One row per Stripe event Lia has seen. The primary key is the Stripe event id, so deduplication is structural rather than a check somebody remembers. Stores no request body, no payment data, and no provider error text — error_category is a Lia-authored word from a closed list.';
comment on column public.stripe_webhook_events.livemode is
  'Whether Stripe sent this from live mode. Compared against the configured key on every delivery: a sandbox key processing a live event, or the reverse, is refused and alerted rather than applied.';
comment on column public.stripe_webhook_events.status is
  'Where processing got to. ignored is a success, not a failure: a verified event of a type Lia does not handle is a correct outcome, and recording it as such keeps the failure count meaningful.';

-- The operator's two questions: what is stuck, and what has this event done
-- before. Partial on the first, because the healthy state of this table is
-- almost entirely `processed`.
create index stripe_webhook_events_unfinished_idx
  on public.stripe_webhook_events (received_at)
  where status in ('received', 'processing', 'failed');

create index stripe_webhook_events_object_idx
  on public.stripe_webhook_events (stripe_object_id, stripe_created_at desc)
  where stripe_object_id is not null;
