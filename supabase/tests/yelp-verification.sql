-- Yelp Assisted harness: the constraints and policies that keep this feature
-- honest, proven against a real Postgres.
--
-- Companion to supabase/tests/rls-verification.sql (tenant isolation). The two
-- run in ONE psql session, in this order:
--
--   npm run db:verify-yelp
--     -> supabase db reset
--     -> psql -v ON_ERROR_STOP=1
--          -f supabase/tests/rls-verification.sql
--          -f supabase/tests/yelp-verification.sql
--
-- The helpers below are defined OUTSIDE a transaction for the reason
-- generation-verification.sql records: rls-verification.sql defines its own
-- `pg_temp.check` inside a `begin; ... rollback;`, and `create function` is
-- transactional DDL, so that definition is gone by the time this file starts.
--
-- Everything that MUTATES is wrapped in `begin; ... rollback;`, so a green run
-- leaves the database exactly as `supabase db reset` left it.
--
-- What this file proves, in one sentence: a typed review can never be stored as
-- a fetched one, a user-confirmed publication can never carry a provider's
-- identifier, one observed change produces at most one occurrence, and no
-- member can fabricate either half of the evidence.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. Preamble.
-- ---------------------------------------------------------------------------

-- `is not true`, deliberately: a NULL condition makes `not condition` NULL, an
-- `if` on NULL never fires, and the check would pass without ever being true.
create or replace function pg_temp.check(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'YELP CHECK FAILED (%): %',
      case when condition is null then 'unknown' else 'false' end, label;
  end if;
  raise notice 'ok: %', label;
end $$;

-- Assert that a statement violates a constraint. The SQLSTATE is checked
-- rather than merely "it threw", so a typo that fails for an unrelated reason
-- cannot masquerade as the constraint doing its job.
create or replace function pg_temp.refuses(
  p_sql text, p_sqlstate text, p_label text
) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_sqlstate then
      raise notice 'ok: %', p_label;
      return;
    end if;
    raise exception 'YELP CHECK FAILED (wrong sqlstate %, wanted %): %',
      sqlstate, p_sqlstate, p_label;
  end;
  raise exception 'YELP CHECK FAILED (accepted): %', p_label;
end $$;

create or replace function pg_temp.become(target_user uuid)
returns void language plpgsql as $$
begin
  execute format('set local role authenticated');
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', target_user, 'role', 'authenticated')::text
  );
end $$;

-- ---------------------------------------------------------------------------
-- 1. Capture provenance on mentions.
--
-- The invariant: a typed review has a typist, and a fetched one does not. The
-- failure this guards is not "a missing field" but "a row claiming one
-- provenance while carrying the evidence of the other".
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_org uuid;
  v_user uuid;
  v_mention uuid;
begin
  select id into v_org from public.organizations order by created_at limit 1;
  select id into v_user from public.users order by created_at limit 1;
  select id into v_mention from public.mentions
   where organization_id = v_org order by created_at limit 1;

  perform pg_temp.check(
    (select capture_method from public.mentions where id = v_mention) = 'provider_api',
    'every pre-existing mention reads as provider_api, which is true of all of them'
  );

  perform pg_temp.refuses(
    format(
      'update public.mentions set captured_by_user_id = %L, captured_at = now() where id = %L',
      v_user, v_mention
    ),
    '23514',
    'a provider_api mention cannot name a capturing person'
  );

  perform pg_temp.refuses(
    format('update public.mentions set capture_method = ''manual_entry'' where id = %L', v_mention),
    '23514',
    'a manual_entry mention must record when it was captured'
  );

  -- The legitimate shape.
  update public.mentions
     set capture_method = 'manual_entry',
         captured_by_user_id = v_user,
         captured_at = now()
   where id = v_mention;

  perform pg_temp.check(
    (select captured_at is not null from public.mentions where id = v_mention),
    'a manual_entry mention with an actor and a moment is accepted'
  );

  -- Offboarding must not break the constraint: the FK nulls the actor, and a
  -- constraint demanding it would turn deleting a user into a failed
  -- transaction on every row they ever touched.
  update public.mentions set captured_by_user_id = null where id = v_mention;
  perform pg_temp.check(
    (select capture_method = 'manual_entry' from public.mentions where id = v_mention),
    'a manual_entry mention survives its capturing user being nulled (offboarding)'
  );
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 2. Publication provenance on response_drafts.
--
-- The invariant that keeps "the customer said so" from ever reading as "Yelp
-- confirmed it".
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_org uuid;
  v_draft uuid;
begin
  select id into v_org from public.organizations order by created_at limit 1;
  select id into v_draft from public.response_drafts
   where organization_id = v_org and status <> 'published'
   order by created_at limit 1;

  perform pg_temp.check(
    not exists (
      select 1 from public.response_drafts
       where status = 'published' and publication_method is null
    ),
    'the backfill left no published draft without a stated publication method'
  );

  perform pg_temp.refuses(
    format(
      'update public.response_drafts set status = ''published'', published_at = now() where id = %L',
      v_draft
    ),
    '23514',
    'a published draft must say how it got there'
  );

  perform pg_temp.refuses(
    format(
      'update public.response_drafts set status = ''published'', published_at = now(),'
      || ' publication_method = ''manual_external'', external_response_id = ''yelp-999'''
      || ' where id = %L',
      v_draft
    ),
    '23514',
    'a manual_external publication cannot carry a provider-assigned identifier'
  );

  -- The legitimate shape: confirmed by a person, with no provider identifier.
  update public.response_drafts
     set status = 'published',
         published_at = now(),
         publication_method = 'manual_external'
   where id = v_draft;

  perform pg_temp.check(
    (select external_response_id is null from public.response_drafts where id = v_draft),
    'a user-confirmed publication holds no provider identifier, permanently'
  );
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 3. Snapshots and occurrences: idempotency and pairing.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_org uuid;
  v_profile uuid;
  v_mention uuid;
  v_a uuid;
  v_b uuid;
  v_occ uuid;
begin
  select id into v_org from public.organizations order by created_at limit 1;
  select id into v_profile from public.platform_profiles
   where organization_id = v_org order by created_at limit 1;
  select id into v_mention from public.mentions
   where organization_id = v_org order by created_at limit 1;

  insert into public.yelp_listing_snapshots
    (organization_id, platform_profile_id, observed_at, review_count, rating)
  values (v_org, v_profile, now() - interval '1 day', 128, 4.5)
  returning id into v_a;

  insert into public.yelp_listing_snapshots
    (organization_id, platform_profile_id, observed_at, review_count, rating)
  values (v_org, v_profile, now(), 129, 4.5)
  returning id into v_b;

  -- A null counter is storable: Yelp omitting one is Lia failing to observe,
  -- and refusing the row would lose the evidence that a check ran at all.
  insert into public.yelp_listing_snapshots
    (organization_id, platform_profile_id, observed_at, review_count, rating)
  values (v_org, v_profile, now() + interval '1 hour', null, null);

  perform pg_temp.check(true, 'a snapshot with no counters is storable');

  insert into public.yelp_activity_occurrences
    (organization_id, platform_profile_id, from_snapshot_id, to_snapshot_id,
     change_kind, previous_review_count, current_review_count,
     previous_rating, current_rating)
  values (v_org, v_profile, v_a, v_b, 'count_increased', 128, 129, 4.5, 4.5)
  returning id into v_occ;

  -- THE idempotency guarantee: two workers observing the same transition race
  -- to insert, and the index refuses the loser.
  perform pg_temp.refuses(
    format(
      'insert into public.yelp_activity_occurrences'
      || ' (organization_id, platform_profile_id, from_snapshot_id, to_snapshot_id, change_kind)'
      || ' values (%L, %L, %L, %L, ''count_increased'')',
      v_org, v_profile, v_a, v_b
    ),
    '23505',
    'the same observed transition cannot be recorded twice'
  );

  perform pg_temp.refuses(
    format(
      'insert into public.yelp_activity_occurrences'
      || ' (organization_id, platform_profile_id, from_snapshot_id, to_snapshot_id, change_kind)'
      || ' values (%L, %L, %L, %L, ''count_increased'')',
      v_org, v_profile, v_a, v_a
    ),
    '23514',
    'an occurrence cannot sit between a snapshot and itself'
  );

  perform pg_temp.refuses(
    format(
      'insert into public.yelp_activity_occurrences'
      || ' (organization_id, platform_profile_id, from_snapshot_id, to_snapshot_id, change_kind)'
      || ' values (%L, %L, %L, %L, ''reviews_arrived'')',
      v_org, v_profile, v_b, v_a
    ),
    '23514',
    'the change vocabulary is closed — no value describing reviews rather than counters'
  );

  perform pg_temp.refuses(
    format(
      'update public.yelp_activity_occurrences set captured_mention_id = %L where id = %L',
      v_mention, v_occ
    ),
    '23514',
    'an open occurrence cannot name a captured review'
  );

  perform pg_temp.refuses(
    format(
      'update public.mentions set yelp_activity_occurrence_id = %L where id = %L',
      v_occ, v_mention
    ),
    '23514',
    'a provider-fetched review cannot cite an activity occurrence'
  );

  -- The legitimate resolution.
  update public.mentions
     set capture_method = 'manual_entry',
         captured_by_user_id = (select id from public.users order by created_at limit 1),
         captured_at = now(),
         yelp_activity_occurrence_id = v_occ
   where id = v_mention;

  update public.yelp_activity_occurrences
     set status = 'captured', captured_mention_id = v_mention, resolved_at = now()
   where id = v_occ;

  perform pg_temp.check(
    (select status = 'captured' from public.yelp_activity_occurrences where id = v_occ),
    'a captured occurrence may name the review that answered it'
  );
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 4. The check lock.
--
-- `platform_sync_runs_one_active (platform_profile_id, resource)` — and the
-- `resource` column is what keeps a Yelp check from sharing a lock with a
-- Google review sync of the same profile.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_org uuid;
  v_profile uuid;
  v_connection uuid;
begin
  select id into v_org from public.organizations order by created_at limit 1;
  select id, platform_connection_id into v_profile, v_connection
    from public.platform_profiles
   where organization_id = v_org order by created_at limit 1;

  insert into public.platform_sync_runs
    (organization_id, platform_connection_id, platform_profile_id, resource, status)
  values (v_org, v_connection, v_profile, 'listing_activity', 'running');

  perform pg_temp.refuses(
    format(
      'insert into public.platform_sync_runs'
      || ' (organization_id, platform_connection_id, platform_profile_id, resource, status)'
      || ' values (%L, %L, %L, ''listing_activity'', ''running'')',
      v_org, v_connection, v_profile
    ),
    '23505',
    'two listing checks cannot run for one listing at once'
  );

  -- A review sync of the same profile is a different resource and must not be
  -- blocked: sharing the lock would silently stop checking whenever a sync ran.
  insert into public.platform_sync_runs
    (organization_id, platform_connection_id, platform_profile_id, resource, status)
  values (v_org, v_connection, v_profile, 'reviews', 'running');

  perform pg_temp.check(
    (select count(*) = 2 from public.platform_sync_runs
      where platform_profile_id = v_profile and status = 'running'),
    'a listing check and a review sync of one profile hold separate locks'
  );
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 5. Row-level security.
--
-- Both tables are evidence rather than configuration: a member who could
-- insert either could fabricate review activity on their own listing.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_org uuid;
  v_other_org uuid;
  v_owner uuid;
  v_analyst uuid;
  v_profile uuid;
  v_snapshot uuid;
  v_later_snapshot uuid;
  v_occ uuid;
  v_visible integer;
begin
  select o.id into v_org from public.organizations o order by o.created_at limit 1;
  select o.id into v_other_org from public.organizations o
   where o.id <> v_org order by o.created_at limit 1;

  select m.user_id into v_owner from public.memberships m
   where m.organization_id = v_org and m.role = 'owner' and m.status = 'active' limit 1;
  select m.user_id into v_analyst from public.memberships m
   where m.organization_id = v_org and m.role = 'analyst' and m.status = 'active' limit 1;

  select id into v_profile from public.platform_profiles
   where organization_id = v_org order by created_at limit 1;

  -- Seeded as the owner role (service-role equivalent), which is the only
  -- writer of evidence in production too.
  insert into public.yelp_listing_snapshots
    (organization_id, platform_profile_id, observed_at, review_count, rating)
  values (v_org, v_profile, now() - interval '1 day', 100, 4.0)
  returning id into v_snapshot;

  -- Two statements rather than a data-modifying subquery: an `insert` may only
  -- appear in a `with`, never in a `from`.
  insert into public.yelp_listing_snapshots
    (organization_id, platform_profile_id, observed_at, review_count, rating)
  values (v_org, v_profile, now(), 101, 4.0)
  returning id into v_later_snapshot;

  insert into public.yelp_activity_occurrences
    (organization_id, platform_profile_id, from_snapshot_id, to_snapshot_id, change_kind)
  values (v_org, v_profile, v_snapshot, v_later_snapshot, 'count_increased')
  returning id into v_occ;

  -- A member reads their own organization's evidence.
  perform pg_temp.become(v_analyst);
  select count(*) into v_visible from public.yelp_activity_occurrences;
  perform pg_temp.check(
    v_visible >= 1,
    'an analyst can read their own organization''s detected review activity'
  );
  reset role;

  -- And cannot fabricate any.
  perform pg_temp.become(v_analyst);
  perform pg_temp.refuses(
    format(
      'insert into public.yelp_listing_snapshots'
      || ' (organization_id, platform_profile_id, observed_at, review_count)'
      || ' values (%L, %L, now(), 999)',
      v_org, v_profile
    ),
    '42501',
    'no member can plant a listing snapshot — the concrete path to making the next genuine check report a change that never happened'
  );
  perform pg_temp.refuses(
    format(
      'insert into public.yelp_activity_occurrences'
      || ' (organization_id, platform_profile_id, from_snapshot_id, to_snapshot_id, change_kind)'
      || ' values (%L, %L, %L, %L, ''count_increased'')',
      v_org, v_profile, v_snapshot, v_snapshot
    ),
    '42501',
    'no member can invent review activity out of nothing'
  );
  reset role;

  -- An analyst cannot resolve one either: that is `mention.capture_manual`.
  perform pg_temp.become(v_analyst);
  update public.yelp_activity_occurrences set status = 'dismissed', resolved_at = now()
   where id = v_occ;
  reset role;
  perform pg_temp.check(
    (select status = 'open' from public.yelp_activity_occurrences where id = v_occ),
    'an analyst cannot dismiss detected review activity'
  );

  -- An owner can.
  perform pg_temp.become(v_owner);
  update public.yelp_activity_occurrences
     set status = 'dismissed', resolved_by_user_id = v_owner, resolved_at = now()
   where id = v_occ;
  reset role;
  perform pg_temp.check(
    (select status = 'dismissed' from public.yelp_activity_occurrences where id = v_occ),
    'an owner can dismiss detected review activity'
  );

  -- Cross-tenant reads return nothing at all.
  perform pg_temp.become(
    (select m.user_id from public.memberships m
      where m.organization_id = v_other_org and m.status = 'active'
        and m.user_id not in (
          select m2.user_id from public.memberships m2 where m2.organization_id = v_org
        )
      limit 1)
  );
  select count(*) into v_visible from public.yelp_activity_occurrences
   where organization_id = v_org;
  reset role;
  perform pg_temp.check(
    v_visible = 0,
    'another organization''s review activity is invisible across the tenant boundary'
  );

  select count(*) into v_visible from public.yelp_listing_snapshots
   where organization_id = v_org;
  perform pg_temp.check(
    v_visible >= 1,
    'the owner role still sees the snapshots (proving the cross-tenant zero was RLS, not an empty table)'
  );

  -- Nothing deletes an occurrence: it is the record that Lia noticed something
  -- and somebody dealt with it. Refused at the grant rather than by a policy
  -- matching zero rows, which is the stronger of the two — there is no delete
  -- policy to get wrong.
  perform pg_temp.become(v_owner);
  perform pg_temp.refuses(
    format('delete from public.yelp_activity_occurrences where id = %L', v_occ),
    '42501',
    'nobody can delete detected review activity, not even an owner'
  );
  reset role;
  perform pg_temp.check(
    exists (select 1 from public.yelp_activity_occurrences where id = v_occ),
    'the occurrence a delete was attempted on is still there'
  );
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 6. Deduplication of captured reviews.
--
-- `mentions_unique_external` is what actually prevents a duplicate. The
-- application derives the key; this proves the database arbitrates it.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_org uuid;
  v_user uuid;
  v_connection uuid;
begin
  select id into v_org from public.organizations order by created_at limit 1;
  select id into v_user from public.users order by created_at limit 1;
  select platform_connection_id into v_connection from public.mentions
   where organization_id = v_org order by created_at limit 1;

  insert into public.mentions
    (organization_id, platform_connection_id, source_type, external_id, content,
     published_at, rating, capture_method, captured_by_user_id, captured_at)
  values (v_org, v_connection, 'yelp_review', 'manual:harness-fingerprint',
          'Waited forty minutes.', now(), 2, 'manual_entry', v_user, now());

  perform pg_temp.refuses(
    format(
      'insert into public.mentions'
      || ' (organization_id, platform_connection_id, source_type, external_id, content,'
      || '  published_at, rating, capture_method, captured_by_user_id, captured_at)'
      || ' values (%L, %L, ''yelp_review'', ''manual:harness-fingerprint'','
      || ' ''Waited forty minutes.'', now(), 2, ''manual_entry'', %L, now())',
      v_org, v_connection, v_user
    ),
    '23505',
    'the same derived capture key cannot be inserted twice'
  );

  -- The override path: a discriminated key is accepted, which is what makes a
  -- deliberate "these really are two different reviews" possible.
  insert into public.mentions
    (organization_id, platform_connection_id, source_type, external_id, content,
     published_at, rating, capture_method, captured_by_user_id, captured_at)
  values (v_org, v_connection, 'yelp_review', 'manual:harness-fingerprint:abc123',
          'Waited forty minutes.', now(), 2, 'manual_entry', v_user, now());

  perform pg_temp.check(
    (select count(*) = 2 from public.mentions
      where external_id like 'manual:harness-fingerprint%'),
    'an intentionally overridden duplicate is accepted under a discriminated key'
  );
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 7. Grants: the shape of the write surface.
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.check(
    not has_table_privilege('authenticated', 'public.yelp_listing_snapshots', 'insert'),
    'authenticated holds no insert on yelp_listing_snapshots'
  );
  perform pg_temp.check(
    not has_table_privilege('authenticated', 'public.yelp_activity_occurrences', 'insert'),
    'authenticated holds no insert on yelp_activity_occurrences'
  );
  perform pg_temp.check(
    not has_table_privilege('authenticated', 'public.yelp_activity_occurrences', 'delete'),
    'authenticated holds no delete on yelp_activity_occurrences'
  );
  perform pg_temp.check(
    has_table_privilege('authenticated', 'public.yelp_activity_occurrences', 'update'),
    'authenticated may update an occurrence — resolving one is a member action, gated by policy'
  );
end $$;

\echo 'yelp-verification: all checks passed'
