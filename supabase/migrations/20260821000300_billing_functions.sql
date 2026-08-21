-- The write surface for billing.
--
-- Every one of these is `security definer`, and together they are the *only*
-- way a row in `organization_billing` or `stripe_webhook_events` ever changes:
-- 20260821000200 revoked the grants that would let a session write either.
--
-- The reason they are functions rather than repository methods is the one D17
-- recorded: a function body is a transaction, and it is the only place this
-- codebase has that guarantee. The Supabase client cannot express "write the
-- projection, mark the event processed, and record the audit entry, or do none
-- of them", and that is exactly the guarantee a webhook needs. An event marked
-- processed before its effects are durable is an event Stripe will never send
-- again and Lia will never have acted on — a silent, permanent divergence that
-- no retry can repair.

-- ---------------------------------------------------------------------------
-- Billable locations.
--
-- One definition, used by the capacity trigger and by the application. Every
-- status except `inactive` counts: a location Lia is monitoring is a location
-- Lia bills for, and `setup` is where every location starts and where most of
-- them stay, since nothing in the product requires moving them on. Counting
-- only `active` would bill almost every real customer for nothing.
-- ---------------------------------------------------------------------------

create or replace function public.count_billable_locations(target_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.locations l
  where l.organization_id = target_organization_id
    and l.status <> 'inactive';
$$;

comment on function public.count_billable_locations is
  'How many locations in an organization consume purchased capacity. Everything except inactive counts — a location Lia monitors is a location Lia bills for.';

-- ---------------------------------------------------------------------------
-- Capacity enforcement.
--
-- A trigger rather than a check in the server action, and the difference is
-- the whole point. There are three paths that can consume a seat —
-- `createLocationAction`, `createAndMapFromIntegration`, and
-- `updateLocationAction` moving a location off `inactive` — and a check in
-- each is three chances to forget. More importantly, none of them can be made
-- safe against concurrency from application code: two requests that both read
-- "4 of 5 used" both proceed, and the organization ends up with 6.
--
-- `for update` on the billing row is what makes it real. Concurrent writers
-- serialise on that one row, so the count each of them reads already includes
-- the other's committed insert.
--
-- Fails **open** wherever capacity is not a settled question: no billing row,
-- no purchased quantity, or a non-standard disposition. Existing organizations
-- and complimentary accounts are therefore unaffected by construction, and the
-- trigger only ever bites after somebody has actually bought something.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_location_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  purchased integer;
  disposition text;
  billable integer;
begin
  -- Only a transition *into* a billable status consumes a seat. Editing the
  -- address of a location that was already active must never be refused
  -- because the organization is at its limit.
  if new.status = 'inactive' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'inactive' then
    return new;
  end if;

  select ob.purchased_location_quantity, ob.access_disposition
    into purchased, disposition
  from public.organization_billing ob
  where ob.organization_id = new.organization_id
  for update;

  if not found or purchased is null or disposition <> 'standard' then
    return new;
  end if;

  billable := public.count_billable_locations(new.organization_id);

  -- The row being inserted is not yet in the count; the row being reactivated
  -- is in it as `inactive`, so it is not either. Both cases add exactly one.
  if billable + 1 > purchased then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'Location capacity reached: %s of %s purchased locations are in use.',
        billable, purchased
      ),
      hint = 'billing_capacity_exhausted';
  end if;

  return new;
end;
$$;

create trigger locations_enforce_capacity
  before insert or update of status on public.locations
  for each row execute function public.enforce_location_capacity();

comment on function public.enforce_location_capacity is
  'Refuses a location that would exceed purchased capacity. Takes a row lock on organization_billing so concurrent creation cannot both pass the same check. Fails open where no capacity has been purchased, so pre-billing organizations are untouched.';

-- ---------------------------------------------------------------------------
-- Webhook event claiming.
--
-- Insert-or-claim in one statement pair, safe under concurrent delivery.
-- Returns a word the route acts on rather than a boolean, because the three
-- outcomes need three different HTTP responses: process it, acknowledge a
-- duplicate with 200 so Stripe stops retrying, or refuse with 409 so Stripe
-- retries *later* — after whichever worker currently holds it has finished.
-- ---------------------------------------------------------------------------

create or replace function public.claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_object_id text,
  p_livemode boolean,
  p_created_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed integer;
  existing_status text;
begin
  insert into public.stripe_webhook_events (
    stripe_event_id, event_type, stripe_object_id, livemode, stripe_created_at
  )
  values (p_event_id, p_event_type, p_object_id, p_livemode, p_created_at)
  on conflict (stripe_event_id) do nothing;

  -- The claim. Atomic: whichever transaction's UPDATE lands first moves the
  -- row out of a claimable status, and the other updates zero rows.
  update public.stripe_webhook_events
     set status = 'processing',
         attempt_count = attempt_count + 1,
         error_category = null,
         updated_at = now()
   where stripe_event_id = p_event_id
     and status in ('received', 'failed');

  get diagnostics claimed = row_count;
  if claimed = 1 then
    return 'claimed';
  end if;

  select status into existing_status
  from public.stripe_webhook_events
  where stripe_event_id = p_event_id;

  if existing_status in ('processed', 'ignored') then
    return 'already_processed';
  end if;

  return 'in_progress';
end;
$$;

comment on function public.claim_stripe_webhook_event is
  'Records a Stripe event and claims it for processing. Returns claimed, already_processed, or in_progress. Deduplication is the primary key; the claim is a conditional update, so concurrent deliveries cannot both proceed.';

-- ---------------------------------------------------------------------------
-- Terminal transitions for an event that produced no projection write.
-- ---------------------------------------------------------------------------

create or replace function public.finish_stripe_webhook_event(
  p_event_id text,
  p_status text,
  p_error_category text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('processed', 'ignored', 'failed') then
    raise exception 'finish_stripe_webhook_event: % is not a terminal status', p_status;
  end if;

  update public.stripe_webhook_events
     set status = p_status,
         error_category = case when p_status = 'failed' then p_error_category else null end,
         processed_at = case when p_status = 'failed' then processed_at else now() end,
         updated_at = now()
   where stripe_event_id = p_event_id;
end;
$$;

comment on function public.finish_stripe_webhook_event is
  'Marks an event ignored, processed, or failed. Only ever carries a Lia-authored error category from the closed list — never a Stripe or driver message.';

-- ---------------------------------------------------------------------------
-- Binding a Stripe customer to an organization.
--
-- Idempotent, and refuses to rebind. An organization whose customer id already
-- differs from the one being written is either a duplicate customer created by
-- a race or an attempt to point one organization at another's billing, and
-- neither should resolve itself quietly.
-- ---------------------------------------------------------------------------

create or replace function public.bind_billing_customer(
  p_organization_id uuid,
  p_customer_id text
)
returns public.organization_billing
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  row_out public.organization_billing;
begin
  insert into public.organization_billing (organization_id, stripe_customer_id)
  values (p_organization_id, p_customer_id)
  on conflict (organization_id) do update
    set stripe_customer_id = coalesce(
          public.organization_billing.stripe_customer_id, excluded.stripe_customer_id
        ),
        updated_at = now()
  returning * into row_out;

  if row_out.stripe_customer_id is distinct from p_customer_id then
    raise exception using
      errcode = 'unique_violation',
      message = 'This organization is already bound to a different Stripe customer.',
      hint = 'billing_customer_conflict';
  end if;

  return row_out;
end;
$$;

comment on function public.bind_billing_customer is
  'Attaches a Stripe customer to an organization, once. A second, different customer id raises rather than overwriting: that is either a duplicate customer or a misdirected write, and both need a person.';

-- ---------------------------------------------------------------------------
-- The projection.
--
-- The one function the webhook calls, and the reason the whole feature is
-- trustworthy: the billing row, the event's terminal status, and the audit
-- entries are one transaction. Either all of it happened or none of it did.
--
-- Three properties worth naming:
--
-- * **One-way stamps are coalesced.** `trial_started_at`, `trial_end`, and
--   `trial_grant_source` keep whatever they already had. A replayed or
--   out-of-order event therefore cannot move a trial's dates, which is what
--   makes "preserve the original trial start and end" true against Stripe's
--   at-least-once delivery rather than merely intended.
--
-- * **A second subscription raises.** An organization has exactly one. If a
--   different live subscription id arrives, the event fails and alerts rather
--   than overwriting — a silent overwrite would double an organization's
--   access and leave no evidence of which subscription it is actually paying.
--
-- * **The audit entries are derived from the transition, not supplied.** The
--   caller passes what Stripe currently says; this function has the previous
--   row, and the previous row is the only place the *change* exists.
-- ---------------------------------------------------------------------------

create or replace function public.apply_stripe_billing_projection(
  p_organization_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_item_id text,
  p_price_id text,
  p_interval text,
  p_status text,
  p_quantity integer,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_trial_start timestamptz,
  p_trial_end timestamptz,
  p_trial_grant_source text default 'self_service',
  p_event_id text default null,
  p_actor_type actor_type default 'integration'
)
returns public.organization_billing
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_row public.organization_billing;
  after_row public.organization_billing;
  resolved_trial_start timestamptz;
  resolved_trial_end timestamptz;
begin
  select * into before_row
  from public.organization_billing
  where organization_id = p_organization_id
  for update;

  if not found then
    insert into public.organization_billing (organization_id, stripe_customer_id)
    values (p_organization_id, p_customer_id)
    returning * into before_row;
  end if;

  if before_row.stripe_subscription_id is not null
     and p_subscription_id is not null
     and before_row.stripe_subscription_id <> p_subscription_id
     and before_row.subscription_status in
         ('trialing', 'active', 'past_due', 'incomplete', 'paused')
  then
    raise exception using
      errcode = 'unique_violation',
      message = 'This organization already has a live subscription.',
      hint = 'duplicate_subscription';
  end if;

  resolved_trial_start := coalesce(before_row.trial_started_at, p_trial_start);
  resolved_trial_end := coalesce(before_row.trial_end, p_trial_end);

  update public.organization_billing
     set stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
         stripe_subscription_id = p_subscription_id,
         stripe_subscription_item_id = p_item_id,
         stripe_price_id = p_price_id,
         billing_interval = p_interval,
         subscription_status = p_status,
         purchased_location_quantity = p_quantity,
         current_period_start = p_period_start,
         current_period_end = p_period_end,
         cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
         trial_started_at = resolved_trial_start,
         trial_end = resolved_trial_end,
         trial_grant_source = case
           when resolved_trial_start is null then null
           else coalesce(before_row.trial_grant_source, p_trial_grant_source)
         end,
         -- A trial that has ever started leaves the organization ineligible,
         -- for good. The check constraint on the table would refuse anything
         -- else; this is the line that keeps it satisfied.
         trial_eligible = case
           when resolved_trial_start is not null then false
           else trial_eligible
         end,
         -- Cancelled while trialing and never converted: the trial ended
         -- without a charge, and that is a different fact from a paid
         -- subscription ending.
         trial_canceled_at = case
           when p_status = 'canceled'
                and resolved_trial_start is not null
                and trial_converted_at is null
             then coalesce(trial_canceled_at, now())
           else trial_canceled_at
         end,
         updated_at = now()
   where organization_id = p_organization_id
  returning * into after_row;

  -- Audit. Derived by comparing the two rows, because the caller knows what
  -- Stripe says and only this function knows what changed.
  if before_row.subscription_status is distinct from after_row.subscription_status then
    insert into public.audit_events (
      organization_id, actor_type, event_type, entity_type, entity_id,
      previous_state, new_state, metadata
    )
    values (
      p_organization_id,
      p_actor_type,
      case
        when after_row.subscription_status = 'trialing' then 'billing.trial_started'
        when after_row.subscription_status = 'active'
             and before_row.subscription_status is null then 'billing.subscription_activated'
        when after_row.subscription_status = 'active'
             and before_row.subscription_status = 'trialing' then 'billing.trial_converted'
        when after_row.subscription_status = 'canceled'
             and after_row.trial_canceled_at is not null
             and after_row.trial_converted_at is null then 'billing.trial_canceled'
        when after_row.subscription_status = 'canceled' then 'billing.subscription_ended'
        when after_row.subscription_status in ('past_due', 'unpaid') then 'billing.payment_failed'
        when after_row.subscription_status = 'active' then 'billing.payment_recovered'
        else 'billing.subscription_updated'
      end,
      'organization_billing',
      p_organization_id,
      jsonb_build_object('subscriptionStatus', before_row.subscription_status),
      jsonb_build_object('subscriptionStatus', after_row.subscription_status),
      jsonb_strip_nulls(jsonb_build_object(
        'stripeSubscriptionId', after_row.stripe_subscription_id,
        'billingInterval', after_row.billing_interval,
        'trialEnd', after_row.trial_end,
        'stripeEventId', p_event_id
      ))
    );
  end if;

  if before_row.purchased_location_quantity is distinct from after_row.purchased_location_quantity
     and before_row.purchased_location_quantity is not null then
    insert into public.audit_events (
      organization_id, actor_type, event_type, entity_type, entity_id,
      previous_state, new_state, metadata
    )
    values (
      p_organization_id, p_actor_type, 'billing.capacity_changed',
      'organization_billing', p_organization_id,
      jsonb_build_object('purchasedLocationQuantity', before_row.purchased_location_quantity),
      jsonb_build_object('purchasedLocationQuantity', after_row.purchased_location_quantity),
      jsonb_strip_nulls(jsonb_build_object('stripeEventId', p_event_id))
    );
  end if;

  if before_row.cancel_at_period_end is distinct from after_row.cancel_at_period_end
     and after_row.cancel_at_period_end then
    insert into public.audit_events (
      organization_id, actor_type, event_type, entity_type, entity_id,
      previous_state, new_state, metadata
    )
    values (
      p_organization_id, p_actor_type, 'billing.cancellation_scheduled',
      'organization_billing', p_organization_id,
      jsonb_build_object('cancelAtPeriodEnd', false),
      jsonb_build_object('cancelAtPeriodEnd', true),
      jsonb_strip_nulls(jsonb_build_object(
        'effectiveAt', after_row.current_period_end,
        'stripeEventId', p_event_id
      ))
    );
  end if;

  -- Last, and inside the same transaction. An event is never acknowledged
  -- before the rows above are durable.
  if p_event_id is not null then
    update public.stripe_webhook_events
       set status = 'processed', processed_at = now(), error_category = null, updated_at = now()
     where stripe_event_id = p_event_id;
  end if;

  return after_row;
end;
$$;

comment on function public.apply_stripe_billing_projection is
  'Writes the billing projection, derives and records the audit entries, and marks the originating Stripe event processed — all in one transaction, so an event is never acknowledged before its effects are durable. Trial stamps are coalesced, so a replayed or out-of-order event cannot move a trial''s dates.';

-- ---------------------------------------------------------------------------
-- Invoice-driven facts.
--
-- Separate from the projection because an invoice says something a
-- subscription does not: that money moved, or did not. The subscription's
-- status is re-read from Stripe either way.
-- ---------------------------------------------------------------------------

create or replace function public.record_billing_payment(
  p_organization_id uuid,
  p_paid boolean,
  p_occurred_at timestamptz,
  p_is_first_charge boolean default false,
  p_event_id text default null
)
returns public.organization_billing
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  after_row public.organization_billing;
begin
  update public.organization_billing
     set last_paid_at = case when p_paid then p_occurred_at else last_paid_at end,
         last_payment_failure_at =
           case when p_paid then last_payment_failure_at else p_occurred_at end,
         -- Only ever stamped once, and only for the charge that follows a
         -- trial. "Never successfully converted" and "lapsed after a year of
         -- paying" are different customers.
         first_payment_failed_at = case
           when not p_paid and p_is_first_charge
             then coalesce(first_payment_failed_at, p_occurred_at)
           else first_payment_failed_at
         end,
         trial_converted_at = case
           when p_paid and trial_started_at is not null
             then coalesce(trial_converted_at, p_occurred_at)
           else trial_converted_at
         end,
         updated_at = now()
   where organization_id = p_organization_id
  returning * into after_row;

  if not found then
    raise exception using
      errcode = 'no_data_found',
      message = 'No billing record for that organization.',
      hint = 'unmatched_customer';
  end if;

  insert into public.audit_events (
    organization_id, actor_type, event_type, entity_type, entity_id,
    previous_state, new_state, metadata
  )
  values (
    p_organization_id, 'integration',
    case when p_paid then 'billing.payment_recovered' else 'billing.payment_failed' end,
    'organization_billing', p_organization_id, null, null,
    jsonb_strip_nulls(jsonb_build_object(
      'firstCharge', p_is_first_charge,
      'stripeEventId', p_event_id
    ))
  );

  if p_event_id is not null then
    update public.stripe_webhook_events
       set status = 'processed', processed_at = now(), error_category = null, updated_at = now()
     where stripe_event_id = p_event_id;
  end if;

  return after_row;
end;
$$;

comment on function public.record_billing_payment is
  'Records that an invoice was paid or failed, stamps trial conversion or first-charge failure, and marks the event processed in the same transaction. Carries no amount, no card detail, and no provider message.';

-- ---------------------------------------------------------------------------
-- Operator paths.
--
-- Both are service-role only and both audit. They exist because "at most one
-- self-service trial per organization" is a rule about self-service, and a
-- product with no authorised way to make an exception grows an unauthorised
-- one — somebody editing the table by hand, which is precisely what the RLS in
-- 20260821000200 is arranged to prevent.
-- ---------------------------------------------------------------------------

create or replace function public.grant_billing_trial(
  p_organization_id uuid,
  p_grant_source text,
  p_actor_user_id uuid default null,
  p_note text default null
)
returns public.organization_billing
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  after_row public.organization_billing;
begin
  if p_grant_source not in ('operator', 'sales') then
    raise exception 'grant_billing_trial: % is not an operator grant source', p_grant_source;
  end if;

  insert into public.organization_billing (organization_id, trial_eligible)
  values (p_organization_id, true)
  on conflict (organization_id) do update
     -- Clearing the start date is what re-opens eligibility; the table's own
     -- check constraint refuses `trial_eligible = true` alongside a start
     -- date, so this is the only shape that can be written.
     set trial_eligible = true,
         trial_started_at = null,
         trial_end = null,
         trial_grant_source = null,
         updated_at = now()
  returning * into after_row;

  insert into public.audit_events (
    organization_id, actor_user_id, actor_type, event_type, entity_type, entity_id,
    previous_state, new_state, metadata
  )
  values (
    p_organization_id, p_actor_user_id,
    case when p_actor_user_id is null then 'system' else 'user' end,
    'billing.trial_granted', 'organization_billing', p_organization_id,
    jsonb_build_object('trialEligible', false),
    jsonb_build_object('trialEligible', true),
    jsonb_strip_nulls(jsonb_build_object('grantSource', p_grant_source, 'note', p_note))
  );

  return after_row;
end;
$$;

comment on function public.grant_billing_trial is
  'The only path that can restore trial eligibility. Service-role only, and always writes billing.trial_granted naming who did it — an exception to "one trial per organization" that leaves evidence.';

create or replace function public.set_billing_access_disposition(
  p_organization_id uuid,
  p_disposition text,
  p_expires_at timestamptz default null,
  p_note text default null,
  p_actor_user_id uuid default null
)
returns public.organization_billing
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_disposition text;
  after_row public.organization_billing;
begin
  select access_disposition into before_disposition
  from public.organization_billing
  where organization_id = p_organization_id;

  insert into public.organization_billing (
    organization_id, access_disposition, access_disposition_expires_at, access_disposition_note
  )
  values (
    p_organization_id, p_disposition,
    case when p_disposition = 'standard' then null else p_expires_at end,
    p_note
  )
  on conflict (organization_id) do update
    set access_disposition = excluded.access_disposition,
        access_disposition_expires_at = excluded.access_disposition_expires_at,
        access_disposition_note = excluded.access_disposition_note,
        updated_at = now()
  returning * into after_row;

  insert into public.audit_events (
    organization_id, actor_user_id, actor_type, event_type, entity_type, entity_id,
    previous_state, new_state, metadata
  )
  values (
    p_organization_id, p_actor_user_id,
    case when p_actor_user_id is null then 'system' else 'user' end,
    'billing.access_disposition_set', 'organization_billing', p_organization_id,
    jsonb_build_object('accessDisposition', before_disposition),
    jsonb_build_object('accessDisposition', after_row.access_disposition),
    jsonb_strip_nulls(jsonb_build_object(
      'expiresAt', after_row.access_disposition_expires_at,
      'note', p_note
    ))
  );

  return after_row;
end;
$$;

comment on function public.set_billing_access_disposition is
  'Grants or clears complimentary, grandfathered, internal, or sales-managed access. Always audited, and an expiry is only ever stored for a non-standard disposition, so free access is explicit and datable rather than a silent absence.';

-- ---------------------------------------------------------------------------
-- Nothing above is reachable from a session.
--
-- `security definer` means these run as the owner, so the revoke is what stops
-- an authenticated caller invoking them directly through PostgREST and writing
-- rows the RLS in 20260821000200 refuses. The same posture
-- 20260807000600 took for the OAuth helpers.
-- ---------------------------------------------------------------------------

-- `count_billable_locations` is revoked too, even though it only counts rows.
-- It is `security definer`, so leaving it callable would let any authenticated
-- session count the locations of any organization by passing an id — a small
-- leak, but a leak of exactly the kind RLS exists to prevent. The trigger calls
-- it as the owner; the application counts through an ordinary RLS-protected
-- select instead.
revoke execute on function public.count_billable_locations(uuid) from authenticated, anon;
revoke execute on function public.claim_stripe_webhook_event(text, text, text, boolean, timestamptz) from authenticated, anon;
revoke execute on function public.finish_stripe_webhook_event(text, text, text) from authenticated, anon;
revoke execute on function public.bind_billing_customer(uuid, text) from authenticated, anon;
revoke execute on function public.apply_stripe_billing_projection(uuid, text, text, text, text, text, text, integer, timestamptz, timestamptz, boolean, timestamptz, timestamptz, text, text, actor_type) from authenticated, anon;
revoke execute on function public.record_billing_payment(uuid, boolean, timestamptz, boolean, text) from authenticated, anon;
revoke execute on function public.grant_billing_trial(uuid, text, uuid, text) from authenticated, anon;
revoke execute on function public.set_billing_access_disposition(uuid, text, timestamptz, text, uuid) from authenticated, anon;
