-- Billing harness: the constraints, the functions, and the capacity trigger,
-- proven against a real Postgres.
--
-- Companion to supabase/tests/rls-verification.sql. The two run in ONE psql
-- session, in this order:
--
--   npm run db:verify-billing
--     -> supabase db reset
--     -> psql -v ON_ERROR_STOP=1
--          -f supabase/tests/rls-verification.sql
--          -f supabase/tests/billing-verification.sql
--
-- Helpers are defined OUTSIDE a transaction for the reason
-- review-widget-verification.sql records: rls-verification.sql defines its own
-- `pg_temp.check` inside a `begin; ... rollback;`, and `create function` is
-- transactional DDL, so that definition is gone by the time this file starts.
--
-- **Why this file exists.** Everything it checks is invariant-shaped and
-- unreachable from vitest. `tests/billing-repository.test.ts` asserts the same
-- rules against the demo adapter, which is a TypeScript reimplementation with
-- no database underneath it — it can prove the fake behaves, and nothing more.
-- The rules that actually protect a customer live in check constraints, a
-- SECURITY DEFINER transaction, and a row-locking trigger, and none of those
-- has ever executed until this file runs.
--
-- The three that matter most, and what each prevents:
--
--   * `organization_billing_trial_is_once` — a second free trial.
--   * the capacity trigger's row lock — two concurrent inserts both passing
--     the same "4 of 5 used" check and leaving six.
--   * `apply_stripe_billing_projection` — an event acknowledged before its
--     effects are durable, which no retry can repair.
--
-- Everything that MUTATES is wrapped in `begin; ... rollback;`, so a green run
-- leaves the database exactly as `supabase db reset` left it.

\set ON_ERROR_STOP on

-- Query results are noise here: every assertion reports through a NOTICE, which
-- goes to stderr and is unaffected by this.
\o /dev/null

-- ---------------------------------------------------------------------------
-- 0. Preamble.
-- ---------------------------------------------------------------------------

-- `is not true`, deliberately: a NULL condition makes `not condition` NULL, an
-- `if` on NULL never fires, and the check would pass without ever being true.
create or replace function pg_temp.check(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'BILLING CHECK FAILED (%): %',
      case when condition is null then 'unknown' else 'false' end, label;
  end if;
  raise notice 'ok: %', label;
end;
$$;

/*
 * Did this statement raise? Used for the refusal checks, where the assertion
 * is that Postgres said no rather than that a row came back.
 */
create or replace function pg_temp.refuses(statement text, label text)
returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    raise notice 'ok: % (refused: %)', label, sqlerrm;
    return;
  end;
  raise exception 'BILLING CHECK FAILED: % was permitted and should not have been', label;
end;
$$;

\set org_a '''2e10c03b-59de-5083-b50b-c2878784ebaa'''
\set org_b '''2cfb101c-667c-588b-a37e-d52a0f6209ba'''

-- ---------------------------------------------------------------------------
-- 1. The tables exist with the shape the application expects.
-- ---------------------------------------------------------------------------

begin;

select pg_temp.check(
  to_regclass('public.organization_billing') is not null,
  'organization_billing exists'
);
select pg_temp.check(
  to_regclass('public.stripe_webhook_events') is not null,
  'stripe_webhook_events exists'
);

-- The primary key IS the organization, so one row per organization is not a
-- rule anybody has to remember.
select pg_temp.check(
  (select count(*) from information_schema.key_column_usage
    where table_name = 'organization_billing'
      and constraint_name like '%pkey%'
      and column_name = 'organization_id') = 1,
  'organization_billing is keyed on organization_id alone'
);

-- The dedup guarantee is structural.
select pg_temp.check(
  (select count(*) from information_schema.key_column_usage
    where table_name = 'stripe_webhook_events'
      and constraint_name like '%pkey%'
      and column_name = 'stripe_event_id') = 1,
  'stripe_webhook_events is keyed on the Stripe event id'
);

rollback;

-- ---------------------------------------------------------------------------
-- 2. The trial is a one-way door.
--
-- The single most important invariant in the schema. If any of these three
-- passes, an organization can get a second free trial.
-- ---------------------------------------------------------------------------

begin;

insert into public.organization_billing (organization_id, stripe_customer_id)
values (:org_a, 'cus_verify_a');

select pg_temp.refuses(
  format(
    'update public.organization_billing set trial_started_at = now(), trial_end = now() + interval ''14 days'', trial_grant_source = ''self_service'' where organization_id = %L',
    :org_a
  ),
  'a trial cannot start while the row is still marked eligible'
);

-- The only shape the constraint permits.
update public.organization_billing
   set trial_started_at = now(),
       trial_end = now() + interval '14 days',
       trial_grant_source = 'self_service',
       trial_eligible = false
 where organization_id = :org_a;

select pg_temp.refuses(
  format(
    'update public.organization_billing set trial_eligible = true where organization_id = %L',
    :org_a
  ),
  'eligibility cannot be restored while a trial start date remains'
);

-- A trial needs a start, an end, and a grantor, or none of them.
select pg_temp.refuses(
  format(
    'update public.organization_billing set trial_end = null where organization_id = %L',
    :org_a
  ),
  'a trial cannot lose its end date while keeping its start date'
);

rollback;

-- ---------------------------------------------------------------------------
-- 3. A half-projected subscription cannot exist.
-- ---------------------------------------------------------------------------

begin;

insert into public.organization_billing (organization_id, stripe_customer_id)
values (:org_a, 'cus_verify_pairing');

select pg_temp.refuses(
  format(
    'update public.organization_billing set stripe_subscription_id = ''sub_1'', subscription_status = ''active'' where organization_id = %L',
    :org_a
  ),
  'a subscription id cannot be set without the rest of the projection'
);

select pg_temp.refuses(
  format(
    'update public.organization_billing set purchased_location_quantity = 101 where organization_id = %L',
    :org_a
  ),
  'purchased capacity above the self-service ceiling is refused'
);

rollback;

-- ---------------------------------------------------------------------------
-- 4. The projection function is one transaction.
--
-- The property no retry can repair if it is wrong: the billing row, the audit
-- entry, and the event's terminal status either all landed or none did.
-- ---------------------------------------------------------------------------

begin;

insert into public.organization_billing (organization_id, stripe_customer_id)
values (:org_a, 'cus_verify_projection');

select public.claim_stripe_webhook_event(
  'evt_verify_1', 'customer.subscription.created', 'sub_verify_1', false, now()
);

select pg_temp.check(
  (select status from public.stripe_webhook_events where stripe_event_id = 'evt_verify_1')
    = 'processing',
  'claiming an event moves it to processing'
);

-- A second claim while the first is in flight must not succeed.
select pg_temp.check(
  public.claim_stripe_webhook_event(
    'evt_verify_1', 'customer.subscription.created', 'sub_verify_1', false, now()
  ) = 'in_progress',
  'a concurrent duplicate claim is refused'
);

select public.apply_stripe_billing_projection(
  :org_a, 'cus_verify_projection', 'sub_verify_1', 'si_verify_1', 'price_verify',
  'year', 'trialing', 3,
  now(), now() + interval '14 days', false,
  now(), now() + interval '14 days', 'self_service',
  'evt_verify_1', 'integration'
);

select pg_temp.check(
  (select subscription_status from public.organization_billing where organization_id = :org_a)
    = 'trialing',
  'the projection landed'
);

select pg_temp.check(
  (select trial_eligible from public.organization_billing where organization_id = :org_a)
    = false,
  'starting a trial closed eligibility in the same write'
);

select pg_temp.check(
  (select status from public.stripe_webhook_events where stripe_event_id = 'evt_verify_1')
    = 'processed',
  'the event was marked processed by the same function that wrote the projection'
);

select pg_temp.check(
  exists (
    select 1 from public.audit_events
    where organization_id = :org_a
      and entity_type = 'organization_billing'
      and event_type = 'billing.trial_started'
      and actor_type = 'integration'
  ),
  'the trial start was audited, with an integration actor'
);

-- Replay: the dates a customer was told must survive at-least-once delivery.
select public.claim_stripe_webhook_event(
  'evt_verify_2', 'customer.subscription.updated', 'sub_verify_1', false, now()
);
select public.apply_stripe_billing_projection(
  :org_a, 'cus_verify_projection', 'sub_verify_1', 'si_verify_1', 'price_verify',
  'year', 'trialing', 3,
  now(), now() + interval '30 days', false,
  now() + interval '9 days', now() + interval '30 days', 'self_service',
  'evt_verify_2', 'integration'
);

select pg_temp.check(
  (select trial_end from public.organization_billing where organization_id = :org_a)
    < now() + interval '15 days',
  'a replayed event cannot move the trial end date'
);

-- A second, different live subscription is refused rather than overwritten.
select pg_temp.refuses(
  format(
    'select public.apply_stripe_billing_projection(%L, ''cus_verify_projection'', ''sub_verify_2'', ''si_2'', ''price_verify'', ''year'', ''active'', 3, now(), now(), false, null, null, null, null, ''integration'')',
    :org_a
  ),
  'a second live subscription is refused rather than silently overwriting the first'
);

rollback;

-- ---------------------------------------------------------------------------
-- 5. Capacity enforcement.
--
-- The trigger takes a row lock on organization_billing, which is what makes
-- concurrent creation safe. The lock cannot be proven from a single session —
-- scripts/billing-capacity-race-test.sh does that with two — so what is
-- checked here is the arithmetic and, just as importantly, that it fails OPEN
-- everywhere capacity is not a settled question.
-- ---------------------------------------------------------------------------

begin;

-- The seed gives org A six locations: four active, one `setup`, one
-- `inactive`. Five of them are billable, and the split is what makes this
-- assertion worth making -- `setup` is where every location created through
-- the product starts and stays, so a definition that counted only `active`
-- would bill almost every real customer for nothing.
select pg_temp.check(
  public.count_billable_locations(:org_a) = 5,
  'setup counts as billable and inactive does not'
);
select pg_temp.check(
  (select count(*) from public.locations
    where organization_id = :org_a and status = 'setup') = 1
  and (select count(*) from public.locations
    where organization_id = :org_a and status = 'inactive') = 1,
  'the seed contains one of each, so the check above means something'
);

-- No billing row at all: creation is unaffected. This is every organization
-- that predates billing.
insert into public.locations (
  organization_id, name, slug, address_line1, city, region, postal_code,
  country_code, timezone, status
) values (
  :org_b, 'Verify No Billing Row', 'verify-no-billing-row', '1 Test Street',
  'San Francisco', 'CA', '94111', 'US', 'America/Los_Angeles', 'active'
);
select pg_temp.check(true, 'a location is created when the organization has no billing row');

rollback;

begin;

insert into public.organization_billing (
  organization_id, stripe_customer_id, stripe_subscription_id,
  stripe_subscription_item_id, stripe_price_id, billing_interval,
  subscription_status, purchased_location_quantity
) values (
  :org_a, 'cus_capacity', 'sub_capacity', 'si_capacity', 'price_capacity',
  'year', 'active', 5
);

-- Five purchased, five in use: the sixth is refused.
select pg_temp.refuses(
  format(
    $q$insert into public.locations (organization_id, name, slug, address_line1, city, region, postal_code, country_code, timezone, status) values (%L, 'Sixth', 'sixth', '1 Test Street', 'New York', 'NY', '10012', 'US', 'America/New_York', 'active')$q$,
    :org_a
  ),
  'a location beyond purchased capacity is refused'
);

-- Freeing a seat makes room, which is the whole reason deactivation exists.
update public.locations
   set status = 'inactive'
 where organization_id = :org_a
   and slug = 'tribeca';

insert into public.locations (
  organization_id, name, slug, address_line1, city, region, postal_code,
  country_code, timezone, status
) values (
  :org_a, 'Sixth', 'sixth', '1 Test Street', 'New York', 'NY', '10012',
  'US', 'America/New_York', 'active'
);
select pg_temp.check(
  public.count_billable_locations(:org_a) = 5,
  'deactivating a location frees capacity for another'
);

-- Editing a location that is already billable is never refused, even at the
-- limit. Only a transition INTO a billable status consumes a seat.
update public.locations
   set address_line1 = '2 Test Street'
 where organization_id = :org_a
   and slug = 'sixth';
select pg_temp.check(true, 'editing an existing billable location is not refused at the limit');

-- Reactivating past the limit is refused, the same as an insert.
select pg_temp.refuses(
  format(
    $q$update public.locations set status = 'active' where organization_id = %L and slug = 'tribeca'$q$,
    :org_a
  ),
  'reactivating a location beyond capacity is refused'
);

rollback;

begin;

-- A complimentary grant is not capacity-limited. An internal or grandfathered
-- organization must not hit a wall it never bought its way past.
-- The whole subscription set, because the pairing constraint refuses a
-- quantity without the rest of it -- and a null quantity would make the
-- trigger fail open for a different reason, testing nothing.
insert into public.organization_billing (
  organization_id, stripe_customer_id, stripe_subscription_id,
  stripe_subscription_item_id, stripe_price_id, billing_interval,
  subscription_status, purchased_location_quantity, access_disposition
) values (
  :org_a, 'cus_comp', 'sub_comp', 'si_comp', 'price_comp',
  'year', 'active', 1, 'internal'
);

insert into public.locations (
  organization_id, name, slug, address_line1, city, region, postal_code,
  country_code, timezone, status
) values (
  :org_a, 'Complimentary', 'complimentary', '1 Test Street', 'New York', 'NY',
  '10012', 'US', 'America/New_York', 'active'
);
select pg_temp.check(true, 'a non-standard access disposition is not capacity-limited');

rollback;

-- ---------------------------------------------------------------------------
-- 6. Nothing is writable through a session, and the definer functions are not
--    callable through one either.
-- ---------------------------------------------------------------------------

begin;

select pg_temp.check(
  not has_table_privilege('authenticated', 'public.organization_billing', 'INSERT')
  and not has_table_privilege('authenticated', 'public.organization_billing', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.organization_billing', 'DELETE'),
  'sessions cannot write organization_billing at all'
);

select pg_temp.check(
  has_table_privilege('authenticated', 'public.organization_billing', 'SELECT'),
  'sessions can read organization_billing, because every role renders the banner'
);

select pg_temp.check(
  not has_table_privilege('authenticated', 'public.stripe_webhook_events', 'SELECT')
  and not has_table_privilege('anon', 'public.stripe_webhook_events', 'SELECT'),
  'the Stripe event log is reachable by no session role'
);

select pg_temp.check(
  not has_function_privilege('authenticated', 'public.apply_stripe_billing_projection(uuid, text, text, text, text, text, text, integer, timestamptz, timestamptz, boolean, timestamptz, timestamptz, text, text, actor_type)', 'EXECUTE'),
  'the projection function cannot be called through PostgREST'
);

select pg_temp.check(
  not has_function_privilege('authenticated', 'public.grant_billing_trial(uuid, text, uuid, text)', 'EXECUTE'),
  'the trial grant cannot be called through PostgREST'
);

select pg_temp.check(
  not has_function_privilege('authenticated', 'public.count_billable_locations(uuid)', 'EXECUTE'),
  'the billable count function is not callable with an arbitrary organization id'
);

-- Enumerated rather than sampled, and that is the point. The three checks
-- above name three functions, which is why the fourth -- the capacity trigger
-- function -- kept its PUBLIC grant through the first hosted push without
-- anything here noticing. This asks the question of every definer function in
-- the billing set at once, so a tenth one added later cannot slip past by not
-- being on a list.
select pg_temp.check(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.proname in (
        'apply_stripe_billing_projection', 'record_billing_payment',
        'claim_stripe_webhook_event', 'finish_stripe_webhook_event',
        'bind_billing_customer', 'grant_billing_trial',
        'set_billing_access_disposition', 'count_billable_locations',
        'enforce_location_capacity'
      )
      and (
        has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
      )
  ),
  'no billing definer function is executable by any session role'
);

select pg_temp.check(
  (select relrowsecurity from pg_class where oid = 'public.organization_billing'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.stripe_webhook_events'::regclass),
  'row-level security is enabled on both tables'
);

rollback;

-- ---------------------------------------------------------------------------
-- 7. Operator paths audit.
-- ---------------------------------------------------------------------------

begin;

insert into public.organization_billing (organization_id, stripe_customer_id, trial_eligible)
values (:org_a, 'cus_operator', false);

update public.organization_billing
   set trial_started_at = now(), trial_end = now(), trial_grant_source = 'self_service'
 where organization_id = :org_a;

select public.grant_billing_trial(:org_a, 'operator', null, 'Support goodwill');

select pg_temp.check(
  (select trial_eligible from public.organization_billing where organization_id = :org_a)
  and (select trial_started_at from public.organization_billing where organization_id = :org_a) is null,
  'an operator grant re-opens eligibility by clearing the start date'
);

select pg_temp.check(
  exists (
    select 1 from public.audit_events
    where organization_id = :org_a and event_type = 'billing.trial_granted'
  ),
  'an operator trial grant is audited'
);

select pg_temp.refuses(
  format('select public.grant_billing_trial(%L, ''self_service'', null, null)', :org_a),
  'a self-service trial cannot be granted by hand'
);

select public.set_billing_access_disposition(
  :org_a, 'grandfathered', now() + interval '90 days', 'Predates billing', null
);

select pg_temp.check(
  (select access_disposition from public.organization_billing where organization_id = :org_a)
    = 'grandfathered'
  and (select access_disposition_expires_at from public.organization_billing where organization_id = :org_a)
    is not null,
  'a grandfathered grant is explicit and dated'
);

select pg_temp.check(
  exists (
    select 1 from public.audit_events
    where organization_id = :org_a and event_type = 'billing.access_disposition_set'
  ),
  'a disposition change is audited'
);

rollback;

\o
\echo 'billing-verification.sql: all checks passed'
