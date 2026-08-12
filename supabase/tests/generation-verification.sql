-- Generation harness: the claim/complete/fail lifecycle behind manual
-- response generation, proven against a real Postgres.
--
-- Companion to supabase/tests/rls-verification.sql (tenant isolation). The two
-- run in ONE psql session, in this order:
--
--   npm run db:verify-generation
--     -> supabase db reset
--     -> psql -v ON_ERROR_STOP=1
--          -f supabase/tests/rls-verification.sql
--          -f supabase/tests/generation-verification.sql
--     -> bash scripts/generation-race-test.sh
--
-- The helpers below are defined OUTSIDE a transaction for the same reason
-- execution-verification.sql's are: rls-verification.sql defines its own
-- `pg_temp.check` inside a `begin; ... rollback;`, and `create function` is
-- transactional DDL, so that definition is gone by the time this file starts.
-- Defining them at top level (psql autocommit) makes them survive.
--
-- Everything that MUTATES is wrapped in `begin; ... rollback;`, so a green run
-- leaves the database exactly as `supabase db reset` left it. Every role
-- switch is explicit: `pg_temp.become(user)` for authenticated (the JWT-claims
-- idiom), `set local role anon` / `service_role`, and `reset role` for owner.
-- Fixtures resolve by slug and by role, never by hard-coded id.
--
-- What this file proves, in one sentence: the three functions are the only
-- writers of an attempt, the claim serialises on the mention row and refuses
-- every role that lacks `response.generate`, the CAS token is the only thing
-- that can finish an attempt, and a completion is one transaction — draft,
-- attempt, and audit event together or not at all.
--
-- Genuinely concurrent proofs (two overlapping connections) are not expressible
-- in one psql session and live in scripts/generation-race-test.sh.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. Preamble: helpers and fixtures (top level — deliberately not in a
--    transaction; see the header).
-- ---------------------------------------------------------------------------

-- `is not true`, deliberately, rather than `not condition`: a NULL condition
-- makes `not condition` NULL, an `if` on NULL never fires, and the check passes
-- without ever having been true.
create or replace function pg_temp.check(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'GENERATION CHECK FAILED (%): %',
      case when condition is null then 'unknown' else 'false' end, label;
  end if;
  raise notice 'ok: %', label;
end $$;

-- Impersonate an authenticated user: Supabase derives auth.uid() from the
-- request JWT, and setting the claim reproduces that for a psql session.
create or replace function pg_temp.become(target_user uuid)
returns void language plpgsql as $$
begin
  execute format('set local role authenticated');
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', target_user, 'role', 'authenticated')::text
  );
end $$;

-- A fresh google_review mention, cloning the platform connection of an
-- existing one so the not-null columns are satisfied without inventing a
-- connection. Google review, specifically: the claim refuses every other
-- source type, so a harness fixture of any other kind would prove nothing.
create or replace function pg_temp.new_google_mention(
  p_org uuid, p_location uuid, p_tag text default 'generic'
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.mentions
      (organization_id, location_id, platform_connection_id, source_type,
       external_id, content, published_at, status, risk_level)
  select p_org, p_location, m.platform_connection_id, 'google_review',
         'gen-harness-' || p_tag || '-' || gen_random_uuid()::text,
         'generation harness fixture review', now(), 'analyzed', 'low'
    from public.mentions m
   where m.organization_id = p_org
     and m.source_type = 'google_review'
     and m.external_id not like 'gen-harness-%'
   order by m.created_at, m.id
   limit 1
  returning id into v_id;
  if v_id is null then
    raise exception 'pg_temp.new_google_mention: no seed google review to clone in organization %', p_org;
  end if;
  return v_id;
end $$;

-- The real claim, with the provenance columns filled in once.
create or replace function pg_temp.claim(
  p_mention uuid, p_lease_seconds integer default 120
) returns table (outcome text, attempt_id uuid, claim_token uuid,
                 response_draft_id uuid)
language sql as $$
  select * from public.claim_generation_attempt(
    p_mention,
    jsonb_build_object('review', jsonb_build_object('text', 'harness'),
                       'voice', jsonb_build_object('warmth', 3)),
    'harness-context-hash', 'drafting@harness', 'configured'::brand_voice_source,
    '1', true, p_lease_seconds);
$$;

-- The real completion, with the telemetry filled in once.
create or replace function pg_temp.complete(
  p_attempt uuid, p_token uuid, p_text text default 'Thank you for the note. We would like to make it right.'
) returns table (outcome text, response_draft_id uuid)
language sql as $$
  select * from public.complete_generation_attempt(
    p_attempt, p_token, p_text, 'system-hash', 'user-hash', 'draft-output@1',
    'anthropic', 'claude-harness', 1024, null::numeric, 'req_harness',
    900, 120, 1500);
$$;

-- Direct writes, for the constraint section that must reach the CHECKs without
-- going through a function that would satisfy them first.
create or replace function pg_temp.raw_attempt(
  p_org uuid, p_mention uuid, p_user uuid,
  p_status generation_attempt_status default 'pending',
  p_finished timestamptz default null,
  p_category generation_failure_category default null,
  p_draft uuid default null,
  p_claimed timestamptz default null,
  p_expires timestamptz default null
) returns uuid language sql as $$
  insert into public.generation_attempts
      (organization_id, mention_id, claimed_by_user_id, status, finished_at,
       failure_category, response_draft_id, claimed_at, expires_at,
       context, context_hash, prompt_version, brand_voice_source,
       analysis_included)
  values (p_org, p_mention, p_user, p_status, p_finished, p_category, p_draft,
          coalesce(p_claimed, now()),
          coalesce(p_expires, now() + interval '2 minutes'),
          '{}'::jsonb, 'hash', 'drafting@harness', 'configured', true)
  returning id;
$$;

-- Backdate a lease so the next claim finds it expired. Both timestamps move:
-- ga_lease_order requires expires_at > claimed_at, so pulling expiry into the
-- past without moving the claim would violate the constraint rather than
-- simulate a timeout.
create or replace function pg_temp.expire_lease(p_attempt uuid)
returns void language sql as $$
  update public.generation_attempts
     set claimed_at = now() - interval '10 minutes',
         expires_at = now() - interval '5 minutes'
   where id = p_attempt;
$$;

drop table if exists gen_fixtures;
create temporary table gen_fixtures as
select
  (select id from public.organizations where slug = 'union-square-hospitality') as ushg_id,
  (select id from public.organizations where slug = 'harbor-and-vine')          as harbor_id,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'owner'
      and m.status = 'active' limit 1)                                          as ushg_owner,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'admin'
      and m.status = 'active' limit 1)                                          as ushg_admin,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'communications_lead'
      and m.status = 'active' limit 1)                                          as ushg_comms,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'analyst'
      and m.status = 'active' limit 1)                                          as ushg_analyst,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'location_manager'
      and m.status = 'active' limit 1)                                          as ushg_manager,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'approver'
      and m.status = 'active' limit 1)                                          as ushg_approver,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'harbor-and-vine' and m.role = 'owner'
      and m.status = 'active' limit 1)                                          as harbor_owner,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'harbor-and-vine' and m.role = 'viewer'
      and m.status = 'active' limit 1)                                          as harbor_viewer,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'union-square-hospitality' and l.slug = 'soho')              as soho_id,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'harbor-and-vine' and l.slug = 'harbor-house')               as harbor_house_id;

do $$
declare f record;
begin
  select * into f from gen_fixtures;
  perform pg_temp.check(f.ushg_id is not null,       'fixture: union-square-hospitality resolved by slug');
  perform pg_temp.check(f.harbor_id is not null,     'fixture: harbor-and-vine resolved by slug');
  perform pg_temp.check(f.ushg_owner is not null,    'fixture: ushg owner resolved by role');
  perform pg_temp.check(f.ushg_admin is not null,    'fixture: ushg admin resolved by role');
  perform pg_temp.check(f.ushg_comms is not null,    'fixture: ushg communications lead resolved by role');
  perform pg_temp.check(f.ushg_analyst is not null,  'fixture: ushg analyst resolved by role');
  perform pg_temp.check(f.ushg_manager is not null,  'fixture: ushg location manager resolved by role');
  perform pg_temp.check(f.ushg_approver is not null, 'fixture: ushg approver resolved by role');
  perform pg_temp.check(f.harbor_owner is not null,  'fixture: harbor owner resolved by role');
  perform pg_temp.check(f.harbor_viewer is not null, 'fixture: harbor viewer resolved by role');
  perform pg_temp.check(f.soho_id is not null,       'fixture: SoHo resolved by slug');
  perform pg_temp.check(f.harbor_house_id is not null, 'fixture: Harbor House resolved by slug');
end $$;

-- ---------------------------------------------------------------------------
-- 1. Privilege boundary.
--
-- The claim/complete/fail trio is the whole write surface: `authenticated`
-- holds no DML on generation_attempts at all, and cannot read the one column
-- that would let it finish somebody else's attempt.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_state text;
  v_org uuid; v_mention uuid; v_attempt uuid; v_seen integer;
begin
  select * into f from gen_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_google_mention(v_org, f.soho_id, 's1');
  v_attempt := pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin);

  ---------------------------------------------------------------------------
  -- authenticated: no DML, and no sight of the CAS credential
  ---------------------------------------------------------------------------
  perform pg_temp.become(f.ushg_admin);

  v_state := null;
  begin
    insert into public.generation_attempts
        (organization_id, mention_id, claimed_by_user_id, expires_at,
         context, context_hash, prompt_version, brand_voice_source,
         analysis_included)
    values (v_org, v_mention, f.ushg_admin, now() + interval '2 minutes',
            '{}'::jsonb, 'hash', 'v', 'configured', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'authenticated cannot insert generation attempts — 42501, got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    update public.generation_attempts set dedup_hits = dedup_hits + 1
     where id = v_attempt;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'authenticated cannot update generation attempts — 42501, got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    delete from public.generation_attempts where id = v_attempt;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'authenticated cannot delete generation attempts — 42501, got ' || coalesce(v_state, 'no error'));

  -- The column revoke: state is readable, the token is not. Both halves
  -- matter — a blanket revoke would also pass the first assertion.
  v_state := null;
  begin
    perform claim_token from public.generation_attempts where id = v_attempt;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'authenticated cannot read claim_token — 42501, got ' || coalesce(v_state, 'no error'));

  select count(*) into v_seen from public.generation_attempts
   where id = v_attempt and status = 'pending';
  perform pg_temp.check(v_seen = 1,
    'authenticated can still read the attempt''s id and status');

  reset role;

  ---------------------------------------------------------------------------
  -- Function EXECUTE grants, asserted from the catalog.
  --
  -- Deliberately not by attempting the calls: on this Postgres image an
  -- EXECUTE-denied call of a non-immutable function after `set role`
  -- terminates the backend (see execution-verification.sql section 1 for the
  -- three-line reproduction). The privilege is the same fact the refused call
  -- would have demonstrated.
  ---------------------------------------------------------------------------
  perform pg_temp.check(
    not has_function_privilege('anon',
      'public.claim_generation_attempt(uuid, jsonb, text, text, brand_voice_source, text, boolean, integer)', 'execute')
    and not has_function_privilege('anon',
      'public.complete_generation_attempt(uuid, uuid, text, text, text, text, text, text, integer, numeric, text, integer, integer, integer)', 'execute')
    and not has_function_privilege('anon',
      'public.fail_generation_attempt(uuid, uuid, generation_failure_category, integer, text)', 'execute'),
    'anon has EXECUTE on none of the three lifecycle functions');

  perform pg_temp.check(
    has_function_privilege('authenticated',
      'public.claim_generation_attempt(uuid, jsonb, text, text, brand_voice_source, text, boolean, integer)', 'execute')
    and has_function_privilege('authenticated',
      'public.complete_generation_attempt(uuid, uuid, text, text, text, text, text, text, integer, numeric, text, integer, integer, integer)', 'execute')
    and has_function_privilege('authenticated',
      'public.fail_generation_attempt(uuid, uuid, generation_failure_category, integer, text)', 'execute'),
    'authenticated keeps EXECUTE on all three — the claim guards itself internally');

  perform pg_temp.check(
    not has_function_privilege('authenticated',
      'public.redact_generation_snapshots(interval)', 'execute')
    and not has_function_privilege('anon',
      'public.redact_generation_snapshots(interval)', 'execute')
    and has_function_privilege('service_role',
      'public.redact_generation_snapshots(interval)', 'execute'),
    'redaction is server-only: service_role yes, authenticated and anon no');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 2. Claim authorization: the role list, restated in SQL, and the tenant.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_state text;
  v_org uuid; v_mention uuid; v_harbor_mention uuid;
  v_claim record; v_rows integer;
begin
  select * into f from gen_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_google_mention(v_org, f.soho_id, 's2');
  v_harbor_mention := pg_temp.new_google_mention(f.harbor_id, f.harbor_house_id, 's2h');

  ---------------------------------------------------------------------------
  -- Every role without response.generate is refused, in its own organization.
  ---------------------------------------------------------------------------
  perform pg_temp.become(f.ushg_analyst);
  v_state := null;
  begin
    perform * from pg_temp.claim(v_mention);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'an analyst cannot claim — 42501, got ' || coalesce(v_state, 'no error'));
  reset role;

  perform pg_temp.become(f.ushg_manager);
  v_state := null;
  begin
    perform * from pg_temp.claim(v_mention);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'a location manager cannot claim — 42501, got ' || coalesce(v_state, 'no error'));
  reset role;

  perform pg_temp.become(f.ushg_approver);
  v_state := null;
  begin
    perform * from pg_temp.claim(v_mention);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'an approver cannot claim — 42501, got ' || coalesce(v_state, 'no error'));
  reset role;

  perform pg_temp.become(f.harbor_viewer);
  v_state := null;
  begin
    perform * from pg_temp.claim(v_harbor_mention);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'a viewer cannot claim — 42501, got ' || coalesce(v_state, 'no error'));
  reset role;

  ---------------------------------------------------------------------------
  -- Cross-org: a communications lead of one tenant cannot claim another's
  -- review, even though their own role would allow it at home. The membership
  -- check is against the MENTION's organization, not the caller's.
  ---------------------------------------------------------------------------
  perform pg_temp.become(f.ushg_comms);
  v_state := null;
  begin
    perform * from pg_temp.claim(v_harbor_mention);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'a cross-org communications lead cannot claim — 42501, got ' || coalesce(v_state, 'no error'));
  reset role;

  -- Not one refusal left a row behind.
  select count(*) into v_rows from public.generation_attempts
   where mention_id in (v_mention, v_harbor_mention);
  perform pg_temp.check(v_rows = 0,
    'every refused claim wrote nothing — 0 attempt rows, got ' || v_rows);

  ---------------------------------------------------------------------------
  -- A non-Google source is refused for a different reason, and also writes
  -- nothing: generation only knows how to write a public reply to a review.
  ---------------------------------------------------------------------------
  perform pg_temp.become(f.ushg_owner);
  v_state := null;
  begin
    perform * from pg_temp.claim(
      (select id from public.mentions
        where organization_id = v_org and source_type = 'reddit_post'
        order by created_at, id limit 1));
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '22023',
    'a reddit post cannot be claimed — 22023, got ' || coalesce(v_state, 'no error'));

  ---------------------------------------------------------------------------
  -- The owner claims, and gets a token.
  ---------------------------------------------------------------------------
  select * into v_claim from pg_temp.claim(v_mention);
  perform pg_temp.check(v_claim.outcome = 'claimed',
    'an owner claims — got ' || v_claim.outcome);
  perform pg_temp.check(v_claim.claim_token is not null,
    'the claim returns a token');
  perform pg_temp.check(v_claim.response_draft_id is null,
    'a fresh claim names no draft');
  reset role;

  select count(*) into v_rows from public.generation_attempts
   where mention_id = v_mention and status = 'pending';
  perform pg_temp.check(v_rows = 1,
    'exactly one pending attempt exists after the claim, got ' || v_rows);
  perform pg_temp.check(
    (select claimed_by_user_id from public.generation_attempts
      where id = v_claim.attempt_id) = f.ushg_owner,
    'the attempt records who claimed it');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 3. State shapes and tenant integrity, as owner.
--
-- The CHECKs are what make an impossible attempt unrepresentable rather than
-- merely unwritten — they hold against a direct owner insert, which is the
-- only writer that could ever get past the function surface.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_constraint text;
  v_state text;
  v_org uuid; v_mention uuid; v_harbor_mention uuid; v_harbor_draft uuid;
begin
  select * into f from gen_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_google_mention(v_org, f.soho_id, 's3');
  v_harbor_mention := pg_temp.new_google_mention(f.harbor_id, f.harbor_house_id, 's3h');

  -- pending must carry no outcome
  v_constraint := null;
  begin
    perform pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin, 'pending', now());
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'ga_pending_shape',
    'a pending attempt cannot carry finished_at — ga_pending_shape, got ' || coalesce(v_constraint, 'no error'));

  -- completed must carry a draft and a finish time
  v_constraint := null;
  begin
    perform pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin, 'completed', now(), null, null);
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'ga_completed_shape',
    'a completed attempt cannot lack its draft — ga_completed_shape, got ' || coalesce(v_constraint, 'no error'));

  -- failed must carry a category
  v_constraint := null;
  begin
    perform pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin, 'failed', now(), null, null);
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'ga_failed_shape',
    'a failed attempt cannot lack its category — ga_failed_shape, got ' || coalesce(v_constraint, 'no error'));

  -- a lease must end after it begins
  v_constraint := null;
  begin
    perform pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin, 'pending', null, null, null,
      now(), now() - interval '1 minute');
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'ga_lease_order',
    'a lease cannot expire before it starts — ga_lease_order, got ' || coalesce(v_constraint, 'no error'));

  -- the mention must belong to the attempt's own organization
  v_constraint := null;
  v_state := null;
  begin
    perform pg_temp.raw_attempt(v_org, v_harbor_mention, f.ushg_admin);
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name, v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_constraint = 'ga_mention_same_org' and v_state = '23503',
    'an attempt cannot point at another tenant''s mention — ga_mention_same_org, got ' || coalesce(v_constraint, 'no error'));

  -- and so must the draft it completed into
  insert into public.response_drafts
      (organization_id, mention_id, response_type, draft_text, status, generated_by)
  values (f.harbor_id, v_harbor_mention, 'public_reply', 'harbor draft', 'draft', 'ai')
  returning id into v_harbor_draft;

  v_constraint := null;
  begin
    perform pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin, 'completed', now(), null,
      v_harbor_draft);
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'ga_draft_same_org',
    'an attempt cannot point at another tenant''s draft — ga_draft_same_org, got ' || coalesce(v_constraint, 'no error'));

  -- one pending row per mention, whatever writes it
  perform pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin);
  v_constraint := null;
  begin
    perform pg_temp.raw_attempt(v_org, v_mention, f.ushg_admin);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'generation_attempts_one_pending',
    'a mention cannot carry two pending attempts — generation_attempts_one_pending, got ' || coalesce(v_constraint, 'no error'));
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 4. The lifecycle, through the functions only.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_mention2 uuid;
  v_first record; v_second record; v_third record;
  v_result record; v_before jsonb; v_after jsonb;
  v_drafts integer; v_events integer; v_meta jsonb;
  v_outcome text;
begin
  select * into f from gen_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_google_mention(v_org, f.soho_id, 's4');
  v_mention2 := pg_temp.new_google_mention(v_org, f.soho_id, 's4b');

  perform pg_temp.become(f.ushg_comms);

  ---------------------------------------------------------------------------
  -- claim → in_progress → expiry → re-claim
  ---------------------------------------------------------------------------
  select * into v_first from pg_temp.claim(v_mention);
  perform pg_temp.check(v_first.outcome = 'claimed', '4 — the first claim is granted');

  select * into v_second from pg_temp.claim(v_mention);
  perform pg_temp.check(v_second.outcome = 'in_progress',
    '4 — a second claim while the lease is live reports in_progress, got ' || v_second.outcome);
  perform pg_temp.check(v_second.claim_token is null,
    '4 — and hands out no token');
  perform pg_temp.check(v_second.attempt_id = v_first.attempt_id,
    '4 — naming the attempt already running');
  perform pg_temp.check(
    (select dedup_hits from public.generation_attempts where id = v_first.attempt_id) = 1,
    '4 — the deduplicated click is counted');

  reset role;
  perform pg_temp.expire_lease(v_first.attempt_id);
  perform pg_temp.become(f.ushg_comms);

  select * into v_third from pg_temp.claim(v_mention);
  perform pg_temp.check(v_third.outcome = 'claimed',
    '4 — an expired lease can be re-claimed, got ' || v_third.outcome);
  perform pg_temp.check(v_third.attempt_id <> v_first.attempt_id,
    '4 — as a new attempt, not a revival of the old one');
  perform pg_temp.check(
    (select status from public.generation_attempts where id = v_first.attempt_id) = 'failed'
    and (select failure_category from public.generation_attempts where id = v_first.attempt_id) = 'lease_expired',
    '4 — and the timed-out attempt is closed as lease_expired');

  ---------------------------------------------------------------------------
  -- CAS: the wrong token changes nothing at all
  ---------------------------------------------------------------------------
  -- The whole-row capture reads every column, including the one authenticated
  -- deliberately cannot see, so it runs as owner either side of the call the
  -- claimant makes.
  reset role;
  select to_jsonb(ga.*) into v_before from public.generation_attempts ga
   where ga.id = v_third.attempt_id;
  perform pg_temp.become(f.ushg_comms);

  select * into v_result from pg_temp.complete(v_third.attempt_id, gen_random_uuid());
  perform pg_temp.check(v_result.outcome = 'superseded',
    '4 — completing with the wrong token is superseded, got ' || v_result.outcome);

  reset role;
  select to_jsonb(ga.*) into v_after from public.generation_attempts ga
   where ga.id = v_third.attempt_id;
  perform pg_temp.become(f.ushg_comms);
  perform pg_temp.check(v_before = v_after,
    '4 — and the attempt row is byte-identical afterwards');
  perform pg_temp.check(
    (select count(*) from public.response_drafts where mention_id = v_mention) = 0,
    '4 — a superseded completion writes no draft');

  ---------------------------------------------------------------------------
  -- CAS: the right token writes draft, attempt, and audit together
  ---------------------------------------------------------------------------
  select * into v_result from pg_temp.complete(v_third.attempt_id, v_third.claim_token);
  perform pg_temp.check(v_result.outcome = 'completed',
    '4 — the token holder completes, got ' || v_result.outcome);

  perform pg_temp.check(
    (select status from public.generation_attempts where id = v_third.attempt_id) = 'completed'
    and (select response_draft_id from public.generation_attempts where id = v_third.attempt_id)
        = v_result.response_draft_id,
    '4 — the attempt records the draft it produced');

  perform pg_temp.check(
    (select response_type from public.response_drafts where id = v_result.response_draft_id) = 'public_reply'
    and (select generated_by from public.response_drafts where id = v_result.response_draft_id) = 'ai'
    and (select prompt_version from public.response_drafts where id = v_result.response_draft_id) = 'drafting@harness'
    and (select brand_voice_version from public.response_drafts where id = v_result.response_draft_id) = '1',
    '4 — the draft is a public AI reply stamped with the attempt''s provenance');

  select count(*) into v_events from public.audit_events
   where event_type = 'response.generated' and entity_id = v_result.response_draft_id;
  perform pg_temp.check(v_events = 1,
    '4 — exactly one response.generated event, got ' || v_events);

  select metadata into v_meta from public.audit_events
   where event_type = 'response.generated' and entity_id = v_result.response_draft_id;
  perform pg_temp.check(
    (v_meta->>'attemptId')::uuid = v_third.attempt_id
    and (v_meta->>'mentionId')::uuid = v_mention,
    '4 — the event names the attempt and the mention');
  perform pg_temp.check(
    not (v_meta::text ilike '%make it right%'),
    '4 — and carries no draft text (D162)');

  ---------------------------------------------------------------------------
  -- Double completion, and the draft_exists short-circuit afterwards
  ---------------------------------------------------------------------------
  select * into v_result from pg_temp.complete(v_third.attempt_id, v_third.claim_token);
  perform pg_temp.check(v_result.outcome = 'superseded',
    '4 — completing twice is superseded, got ' || v_result.outcome);

  select count(*) into v_drafts from public.response_drafts where mention_id = v_mention;
  perform pg_temp.check(v_drafts = 1,
    '4 — and leaves exactly one draft, got ' || v_drafts);

  select * into v_result from pg_temp.claim(v_mention);
  perform pg_temp.check(v_result.outcome = 'draft_exists',
    '4 — a mention that already has a draft short-circuits, got ' || v_result.outcome);
  perform pg_temp.check(v_result.claim_token is null,
    '4 — with no token');
  perform pg_temp.check(
    v_result.response_draft_id = (select id from public.response_drafts where mention_id = v_mention),
    '4 — naming the draft that exists');

  ---------------------------------------------------------------------------
  -- The failure path, and its own CAS
  ---------------------------------------------------------------------------
  select * into v_first from pg_temp.claim(v_mention2);
  perform pg_temp.check(v_first.outcome = 'claimed', '4 — a second mention claims cleanly');

  v_outcome := public.fail_generation_attempt(
    v_first.attempt_id, gen_random_uuid(), 'provider_error', 900, null);
  perform pg_temp.check(v_outcome = 'superseded',
    '4 — failing with the wrong token is superseded, got ' || v_outcome);
  perform pg_temp.check(
    (select status from public.generation_attempts where id = v_first.attempt_id) = 'pending',
    '4 — and leaves the attempt pending');

  v_outcome := public.fail_generation_attempt(
    v_first.attempt_id, v_first.claim_token, 'provider_error', 900, 'req_x');
  perform pg_temp.check(v_outcome = 'failed',
    '4 — the token holder fails the attempt, got ' || v_outcome);
  perform pg_temp.check(
    (select status from public.generation_attempts where id = v_first.attempt_id) = 'failed'
    and (select failure_category from public.generation_attempts where id = v_first.attempt_id) = 'provider_error',
    '4 — recording the category it was given');

  v_outcome := public.fail_generation_attempt(
    v_first.attempt_id, v_first.claim_token, 'invalid_output', 900, 'req_x');
  perform pg_temp.check(v_outcome = 'superseded',
    '4 — failing twice is superseded, got ' || v_outcome);
  perform pg_temp.check(
    (select failure_category from public.generation_attempts where id = v_first.attempt_id) = 'provider_error',
    '4 — and cannot rewrite the recorded category');

  -- A failure is not a draft: the mention is claimable again.
  select * into v_second from pg_temp.claim(v_mention2);
  perform pg_temp.check(v_second.outcome = 'claimed',
    '4 — a failed attempt can be retried, got ' || v_second.outcome);

  reset role;
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 5. Atomicity: draft, attempt, and audit event commit together or not at all.
-- ---------------------------------------------------------------------------

begin;

create function public.harness_block_generated_audit()
returns trigger language plpgsql as $fn$
begin
  if new.event_type = 'response.generated'
     and exists (
       select 1 from public.mentions m
        where m.id = (new.metadata->>'mentionId')::uuid
          and m.external_id like 'gen-harness-s5-%') then
    raise exception 'harness: forced failure writing the generated audit event'
      using errcode = 'P0001';
  end if;
  return new;
end $fn$;

create trigger harness_s5_guard
  before insert on public.audit_events
  for each row execute function public.harness_block_generated_audit();

do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_claim record; v_state text;
begin
  select * into f from gen_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_google_mention(v_org, f.soho_id, 's5');

  perform pg_temp.become(f.ushg_admin);
  select * into v_claim from pg_temp.claim(v_mention);
  perform pg_temp.check(v_claim.outcome = 'claimed', '5 — claimed before the forced failure');

  -- The plpgsql exception block is a subtransaction: catching the error rolls
  -- back everything complete_generation_attempt did, which is the point.
  v_state := null;
  begin
    perform * from pg_temp.complete(v_claim.attempt_id, v_claim.claim_token);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = 'P0001',
    '5 — the failing audit write propagates out of complete_generation_attempt');

  perform pg_temp.check(
    (select count(*) from public.response_drafts where mention_id = v_mention) = 0,
    '5 — no draft survived');
  perform pg_temp.check(
    (select status from public.generation_attempts where id = v_claim.attempt_id) = 'pending',
    '5 — the attempt is still pending, so the worker can retry');
  perform pg_temp.check(
    (select response_draft_id from public.generation_attempts where id = v_claim.attempt_id) is null,
    '5 — and names no draft');

  reset role;
end $$;

drop trigger harness_s5_guard on public.audit_events;

do $$
declare
  f record;
  v_mention uuid; v_attempt record; v_result record;
begin
  select * into f from gen_fixtures;
  -- The same mention, whose attempt is still pending from the block above.
  select m.id into v_mention from public.mentions m
   where m.external_id like 'gen-harness-s5-%'
   order by m.created_at desc, m.id limit 1;

  select ga.id as attempt_id, ga.claim_token into v_attempt
    from public.generation_attempts ga
   where ga.mention_id = v_mention and ga.status = 'pending';

  perform pg_temp.become(f.ushg_admin);
  select * into v_result from pg_temp.complete(v_attempt.attempt_id, v_attempt.claim_token);
  perform pg_temp.check(v_result.outcome = 'completed',
    '5 — the retry completes once the audit write can land, got ' || v_result.outcome);
  reset role;

  perform pg_temp.check(
    (select count(*) from public.response_drafts where mention_id = v_mention) = 1,
    '5 — exactly one draft');
  perform pg_temp.check(
    (select count(*) from public.audit_events
      where event_type = 'response.generated' and entity_id = v_result.response_draft_id) = 1,
    '5 — exactly one audit event');
  perform pg_temp.check(
    (select count(*) from public.generation_attempts
      where mention_id = v_mention and status = 'completed') = 1,
    '5 — exactly one completed attempt');
end $$;

drop function public.harness_block_generated_audit();

rollback;

-- ---------------------------------------------------------------------------
-- 6. Retention: redaction empties the stored context and nothing else.
--
-- The mechanism only — no schedule calls this yet, and the retention period
-- is an open operational decision rather than something the migration picked.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_org uuid; v_old uuid; v_recent uuid; v_live uuid;
  v_mention_old uuid; v_mention_recent uuid; v_mention_live uuid;
  v_count integer; v_audit_before integer; v_audit_after integer;
begin
  select * into f from gen_fixtures;
  v_org := f.ushg_id;
  v_mention_old    := pg_temp.new_google_mention(v_org, f.soho_id, 's6a');
  v_mention_recent := pg_temp.new_google_mention(v_org, f.soho_id, 's6b');
  v_mention_live   := pg_temp.new_google_mention(v_org, f.soho_id, 's6c');

  -- Finished long ago, finished recently, and still running.
  v_old := pg_temp.raw_attempt(v_org, v_mention_old, f.ushg_admin, 'failed',
    now() - interval '90 days', 'provider_error');
  v_recent := pg_temp.raw_attempt(v_org, v_mention_recent, f.ushg_admin, 'failed',
    now() - interval '2 days', 'provider_error');
  v_live := pg_temp.raw_attempt(v_org, v_mention_live, f.ushg_admin);

  update public.generation_attempts
     set rendered_system_hash = 'sys', rendered_user_hash = 'usr',
         latency_ms = 1234, model_name = 'claude-harness'
   where id in (v_old, v_recent, v_live);

  select count(*) into v_audit_before from public.audit_events;

  set local role service_role;
  select public.redact_generation_snapshots(interval '30 days') into v_count;
  reset role;

  perform pg_temp.check(v_count = 1,
    '6 — redaction reports the one snapshot it emptied, got ' || v_count);
  perform pg_temp.check(
    (select context from public.generation_attempts where id = v_old) = 'null'::jsonb,
    '6 — the old attempt''s context is the JSON null sentinel');
  perform pg_temp.check(
    (select context from public.generation_attempts where id = v_recent) <> 'null'::jsonb,
    '6 — a recently finished attempt is untouched');
  perform pg_temp.check(
    (select context from public.generation_attempts where id = v_live) <> 'null'::jsonb,
    '6 — a running attempt is untouched');

  -- Provenance and telemetry are not the snapshot: they survive, which is what
  -- makes a redacted row still auditable.
  perform pg_temp.check(
    (select rendered_system_hash from public.generation_attempts where id = v_old) = 'sys'
    and (select rendered_user_hash from public.generation_attempts where id = v_old) = 'usr'
    and (select context_hash from public.generation_attempts where id = v_old) = 'hash'
    and (select latency_ms from public.generation_attempts where id = v_old) = 1234
    and (select model_name from public.generation_attempts where id = v_old) = 'claude-harness',
    '6 — hashes and telemetry survive redaction');

  select count(*) into v_audit_after from public.audit_events;
  perform pg_temp.check(v_audit_before = v_audit_after,
    '6 — redaction writes no audit events of its own');

  -- Idempotent: the second pass has nothing left to empty.
  set local role service_role;
  select public.redact_generation_snapshots(interval '30 days') into v_count;
  reset role;
  perform pg_temp.check(v_count = 0,
    '6 — a second pass redacts nothing, got ' || v_count);
end $$;

rollback;

\echo 'generation-verification.sql: all checks passed'
