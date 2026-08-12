-- Execution harness: the durable occurrence lifecycle, the escalation
-- contract, and the Phase 2 execution unit, proven against a real Postgres.
--
-- Companion to supabase/tests/rls-verification.sql (tenant isolation) and
-- supabase/tests/matrix-parity.generated.sql (transition matrix, cell for
-- cell). The three run in ONE psql session, in this order:
--
--   npm run db:verify-execution
--     -> supabase db reset
--     -> psql -v ON_ERROR_STOP=1
--          -f supabase/tests/rls-verification.sql
--          -f supabase/tests/execution-verification.sql
--          -f supabase/tests/matrix-parity.generated.sql
--     -> bash scripts/execution-race-test.sh
--
-- ---------------------------------------------------------------------------
-- Why the helpers below are defined OUTSIDE a transaction
-- ---------------------------------------------------------------------------
-- rls-verification.sql defines its own `pg_temp.check(condition, label)`
-- *inside* its `begin; ... rollback;`, so that definition is gone by the time
-- this file starts: `create function` is transactional DDL, and the rollback
-- takes the function with it (the pg_temp SCHEMA is session-scoped, its
-- CONTENTS are not transaction-proof). The generated parity file, which runs
-- after this one, calls `pg_temp.check(label, condition)` and defines nothing
-- itself — its header says so explicitly.
--
-- So this file's preamble runs at top level (psql autocommit), which makes the
-- helpers survive into the parity file, and defines BOTH argument orders:
--
--   pg_temp.check(condition boolean, label text)   -- rls-verification's order
--   pg_temp.check(label text, condition boolean)   -- the parity file's order
--
-- The overload pair is unambiguous because PostgreSQL has no implicit
-- boolean->text cast: a call written `check(<bool expr>, 'label')` can only
-- resolve to the first, and `check('label', <bool expr>)` only to the second.
-- Neither of the other two files needs to change.
--
-- Everything that MUTATES is wrapped in `begin; ... rollback;`, so a green run
-- leaves the database exactly as `supabase db reset` left it. Every role
-- switch is explicit: `pg_temp.become(user)` for authenticated (the JWT-claims
-- idiom), `set local role service_role` / `anon`, and `reset role` for owner.
-- Fixtures resolve by slug, never by hard-coded id.
--
-- Every check raises on failure and ON_ERROR_STOP=1 halts the run, so a clean
-- run means every assertion held.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. Preamble: helpers and fixtures (top level — deliberately not in a
--    transaction; see the header).
-- ---------------------------------------------------------------------------

-- `is not true`, deliberately, rather than `not condition`: a NULL condition
-- makes `not condition` NULL, an `if` on NULL does not fire, and the check
-- passes without ever having been true. That is not hypothetical — it hid a
-- wrong assertion in section 3 of this very file during development, where a
-- captured SQLSTATE was null and `v_state = '23503'` evaluated to NULL. A
-- check that cannot distinguish "held" from "unknown" is not a check.
create or replace function pg_temp.check(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'EXECUTION CHECK FAILED (%): %',
      case when condition is null then 'unknown' else 'false' end, label;
  end if;
  raise notice 'ok: %', label;
end $$;

-- Same helper, the generated parity file's argument order.
create or replace function pg_temp.check(label text, condition boolean)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'EXECUTION CHECK FAILED (%): %',
      case when condition is null then 'unknown' else 'false' end, label;
  end if;
  raise notice 'ok: %', label;
end $$;

-- Impersonate an authenticated user, exactly as rls-verification.sql does:
-- Supabase derives auth.uid() from the request JWT, and setting the claim
-- reproduces that for a psql session.
create or replace function pg_temp.become(target_user uuid)
returns void language plpgsql as $$
begin
  execute format('set local role authenticated');
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', target_user, 'role', 'authenticated')::text
  );
end $$;

-- --- fixture builders (called as owner, inside the rolled-back sections) ---

-- A fresh mention in an organization, cloning the platform connection and
-- source type of an existing one so the not-null/unique columns are satisfied
-- without inventing a connection. `p_tag` lands in external_id so the
-- trigger-based sections can recognise their own marker mentions.
create or replace function pg_temp.new_mention(
  p_org uuid, p_location uuid, p_status mention_status,
  p_risk risk_level default 'high', p_tag text default 'generic'
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.mentions
      (organization_id, location_id, platform_connection_id, source_type,
       external_id, content, published_at, status, risk_level)
  select p_org, p_location, m.platform_connection_id, m.source_type,
         'exec-harness-' || p_tag || '-' || gen_random_uuid()::text,
         'execution harness fixture', now(), p_status, p_risk
    from public.mentions m
   where m.organization_id = p_org
     and m.external_id not like 'exec-harness-%'
   order by m.created_at, m.id
   limit 1
  returning id into v_id;
  if v_id is null then
    raise exception 'pg_temp.new_mention: no seed mention to clone in organization %', p_org;
  end if;
  return v_id;
end $$;

-- Completed, not running: `analysis_runs_one_active` allows only one running
-- run per organization, and several sections need several runs at once.
create or replace function pg_temp.new_run(p_org uuid)
returns uuid language sql as $$
  insert into public.analysis_runs (organization_id, status, completed_at)
  values (p_org, 'completed', now())
  returning id;
$$;

create or replace function pg_temp.new_rule(
  p_org uuid, p_actions jsonb, p_status automation_rule_status default 'active'
) returns uuid language sql as $$
  insert into public.automation_rules (organization_id, name, status, actions)
  values (p_org, 'exec harness ' || gen_random_uuid()::text, p_status, p_actions)
  returning id;
$$;

create or replace function pg_temp.new_sweep(
  p_org uuid, p_mode text default 'apply', p_status text default 'completed'
) returns uuid language sql as $$
  insert into public.automation_sweeps (organization_id, mode, status, completed_at)
  values (p_org, p_mode, p_status,
          case when p_status = 'running' then null else now() end)
  returning id;
$$;

-- The real recorder, with the classification columns filled in once.
create or replace function pg_temp.record_occ(
  p_org uuid, p_mention uuid, p_run uuid,
  p_cats escalation_category[] default array['food_safety']::escalation_category[]
) returns table (analysis_id uuid, created boolean) language sql as $$
  select * from public.record_analysis_occurrence(
    p_org, p_mention, p_run, 'anthropic', 'claude-harness', 'v1',
    0.800, 'relevant to the brand', 'negative'::sentiment, -0.600,
    'high'::risk_level, p_cats, 'risky', array['harness']::text[],
    array[]::text[], 'escalate'::recommended_action, 'escalate it', now());
$$;

-- The real analysis entry point.
create or replace function pg_temp.apply_occ(
  p_org uuid, p_mention uuid, p_occ uuid, p_escalate boolean,
  p_sentiment sentiment default 'negative', p_risk risk_level default 'high',
  p_relevance numeric default 0.800
) returns table (escalation_id uuid, escalation_created boolean, reason text,
                 already_applied boolean, final_status mention_status)
language sql as $$
  select * from public.apply_analysis_occurrence(
    p_org, p_mention, p_occ, p_escalate, 'food_safety'::escalation_category,
    p_risk, 'Harness case', 'Raised by the execution harness',
    p_sentiment, p_risk, p_relevance);
$$;

-- The real execution unit.
create or replace function pg_temp.exec_unit(
  p_org uuid, p_sweep uuid, p_rule uuid, p_mention uuid, p_occ uuid,
  p_revision integer default 1
) returns public.automation_rule_executions language sql as $$
  select * from public.execute_automation_rule(
    p_org, p_sweep, p_rule, p_revision, p_mention, p_occ);
$$;

-- Direct writes, for the constraint sections that must reach the indexes
-- without going through an entry point that would deduplicate first.
create or replace function pg_temp.raw_analysis(
  p_org uuid, p_mention uuid, p_run uuid, p_applied timestamptz
) returns uuid language sql as $$
  insert into public.mention_analyses
      (organization_id, mention_id, analysis_run_id, model_provider,
       model_name, prompt_version, relevance_score, sentiment, risk_level,
       recommended_action, outcome_applied_at)
  values (p_org, p_mention, p_run, 'anthropic', 'claude-harness', 'v1',
          0.500, 'neutral', 'low', 'monitor', p_applied)
  returning id;
$$;

create or replace function pg_temp.raw_escalation(
  p_org uuid, p_mention uuid, p_occ uuid,
  p_status escalation_status default 'open'
) returns uuid language sql as $$
  insert into public.escalations
      (organization_id, mention_id, category, severity, status, title,
       trigger_analysis_id)
  values (p_org, p_mention, 'other', 'high', p_status, 'harness case', p_occ)
  returning id;
$$;

create or replace function pg_temp.raw_execution(
  p_org uuid, p_sweep uuid, p_rule uuid, p_mention uuid, p_occ uuid,
  p_location uuid, p_status text default 'applied'
) returns uuid language sql as $$
  insert into public.automation_rule_executions
      (organization_id, sweep_id, automation_rule_id, rule_revision,
       mention_id, trigger_analysis_id, location_id, mode, status)
  values (p_org, p_sweep, p_rule, 1, p_mention, p_occ, p_location, 'apply',
          p_status)
  returning id;
$$;

-- Seeded organizations, members by role, and locations by slug. Same posture
-- as rls-verification.sql's fixture table: nothing is hard-coded by id, so a
-- regenerated seed keeps working.
drop table if exists exec_fixtures;
create temporary table exec_fixtures as
select
  (select id from public.organizations where slug = 'union-square-hospitality') as ushg_id,
  (select id from public.organizations where slug = 'harbor-and-vine')          as harbor_id,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'admin'
      and m.status = 'active' limit 1)                                          as ushg_admin,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'analyst'
      and m.status = 'active' limit 1)                                          as ushg_analyst,
  -- Manages SoHo and Upper East Side in the seed; section 4 depends on that.
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'location_manager'
      and m.status = 'active' limit 1)                                          as ushg_manager,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'harbor-and-vine' and m.role = 'owner'
      and m.status = 'active' limit 1)                                          as harbor_owner,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'union-square-hospitality' and l.slug = 'soho')              as soho_id,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'union-square-hospitality' and l.slug = 'west-village')      as west_village_id,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'union-square-hospitality' and l.slug = 'tribeca')           as tribeca_id,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'harbor-and-vine' and l.slug = 'harbor-house')               as harbor_house_id;

do $$
declare f record;
begin
  select * into f from exec_fixtures;
  perform pg_temp.check(f.ushg_id is not null,          'fixture: union-square-hospitality resolved by slug');
  perform pg_temp.check(f.harbor_id is not null,        'fixture: harbor-and-vine resolved by slug');
  perform pg_temp.check(f.ushg_admin is not null,       'fixture: ushg admin resolved by role');
  perform pg_temp.check(f.ushg_analyst is not null,     'fixture: ushg analyst resolved by role');
  perform pg_temp.check(f.ushg_manager is not null,     'fixture: ushg location manager resolved by role');
  perform pg_temp.check(f.harbor_owner is not null,     'fixture: harbor owner resolved by role');
  perform pg_temp.check(f.soho_id is not null,          'fixture: SoHo resolved by slug');
  perform pg_temp.check(f.west_village_id is not null,  'fixture: West Village resolved by slug');
  perform pg_temp.check(f.harbor_house_id is not null,  'fixture: Harbor House resolved by slug');
  -- Section 4 is only meaningful if the manager really manages SoHo and
  -- really does not manage West Village.
  perform pg_temp.check(
    exists (select 1 from public.locations where id = f.soho_id
              and manager_user_id = f.ushg_manager),
    'fixture: the location manager manages SoHo');
  perform pg_temp.check(
    not exists (select 1 from public.locations where id = f.west_village_id
                  and manager_user_id = f.ushg_manager),
    'fixture: the location manager does not manage West Village');
end $$;

-- ---------------------------------------------------------------------------
-- 1. Privilege boundary.
--
-- The escalation contract's central claim is that `raise_escalation` is the
-- ONLY creator of escalation rows and that no application path can reach it
-- directly — not even service_role, which is otherwise the trusted writer.
-- The definer entry points are the whole surface.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_state text;
  v_org uuid; v_mention uuid; v_run uuid; v_occ uuid; v_rule uuid;
  v_sweep uuid; v_claim record; v_claimed boolean;
  v_exec public.automation_rule_executions;
  v_id uuid; v_created boolean;
  v_events integer; v_meta jsonb; v_visible integer;
  v_mention2 uuid; v_run2 uuid; v_occ2 uuid;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;

  -- Fixtures, as owner.
  v_mention  := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's1');
  v_mention2 := pg_temp.new_mention(v_org, f.soho_id, 'new',      'low',  's1b');
  v_run  := pg_temp.new_run(v_org);
  v_run2 := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
  v_rule := pg_temp.new_rule(v_org,
    '[{"type": "escalate", "assigneeUserId": null}]'::jsonb, 'active');

  ---------------------------------------------------------------------------
  -- authenticated
  ---------------------------------------------------------------------------
  perform pg_temp.become(f.ushg_admin);

  v_state := null;
  begin
    insert into public.audit_events
      (organization_id, actor_type, event_type, entity_type, entity_id)
    values (v_org, 'ai', 'mention.analyzed', 'mention', v_mention);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'authenticated cannot insert audit events — 42501, got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    insert into public.escalations
      (organization_id, mention_id, category, severity, title, trigger_analysis_id)
    values (v_org, v_mention, 'other', 'high', 'forged case', v_occ);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'authenticated cannot insert escalations — 42501, got ' || coalesce(v_state, 'no error'));

  -- Cross-org audit read: audit_events_select is gated on membership.
  select count(*) into v_visible
    from public.audit_events where organization_id = f.harbor_id;
  perform pg_temp.check(v_visible = 0,
    'a ushg admin reads no harbor audit events');

  reset role;

  ---------------------------------------------------------------------------
  -- anon
  ---------------------------------------------------------------------------
  set local role anon;
  v_state := null;
  begin
    insert into public.escalations
      (organization_id, mention_id, category, severity, title, trigger_analysis_id)
    values (v_org, v_mention, 'other', 'high', 'forged case', v_occ);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'anon cannot insert escalations — 42501, got ' || coalesce(v_state, 'no error'));
  reset role;

  ---------------------------------------------------------------------------
  -- service_role: refused the sole creator, granted every entry point
  ---------------------------------------------------------------------------
  set local role service_role;

  v_state := null;
  begin
    insert into public.escalations
      (organization_id, mention_id, category, severity, title, trigger_analysis_id)
    values (v_org, v_mention, 'other', 'high', 'forged case', v_occ);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '42501',
    'service_role cannot insert escalations directly — 42501, got ' || coalesce(v_state, 'no error'));

  -- `raise_escalation` is owner-internal: not executable by service_role, so
  -- no application path can reach the sole creator of escalation rows outside
  -- a transactional entry point.
  --
  -- Asserted from the catalog rather than by attempting the call, because
  -- attempting it CRASHES this Postgres. On the local Supabase image
  -- (PostgreSQL 17.6, shared_preload_libraries = pg_stat_statements, pgaudit,
  -- plpgsql, plpgsql_check, pg_cron, pg_net, pgsodium, auto_explain, pg_tle,
  -- plan_filter, supabase_vault) any EXECUTE-denied call of a NON-IMMUTABLE
  -- function after `set role` terminates the backend with signal 11 and puts
  -- the cluster into crash recovery. Three lines reproduce it on a freshly
  -- reset database, with nothing from this branch involved:
  --
  --   begin; set local role authenticated;
  --   select * from public.organizations_with_unanalyzed_mentions();
  --
  -- (An immutable function — public.automation_is_uuid — returns a clean
  -- 42501 instead, because its ACL check happens during constant folding
  -- rather than in the executor.) A harness cannot attempt a call that takes
  -- the server down, so the privilege itself is what gets asserted; it is the
  -- same fact the refused call would have demonstrated.
  perform pg_temp.check(
    not has_function_privilege('service_role',
      'public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid, text)',
      'execute'),
    'service_role has no EXECUTE on raise_escalation — the sole creator is owner-internal');
  perform pg_temp.check(
    not has_function_privilege('authenticated',
      'public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid, text)',
      'execute')
    and not has_function_privilege('anon',
      'public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid, text)',
      'execute'),
    'neither authenticated nor anon has EXECUTE on raise_escalation either');

  -- …while every entry point it is meant to have succeeds.
  select analysis_id, created into v_id, v_created
    from public.record_analysis_occurrence(
      v_org, v_mention2, v_run2, 'anthropic', 'claude-harness', 'v1', 0.800,
      'relevant', 'negative'::sentiment, -0.600, 'high'::risk_level,
      array['food_safety']::escalation_category[], 'risky',
      array['harness']::text[], array[]::text[], 'escalate'::recommended_action,
      'escalate it', now());
  perform pg_temp.check(v_created,
    'service_role can execute record_analysis_occurrence');
  v_occ2 := v_id;

  perform * from public.apply_analysis_occurrence(
    v_org, v_mention2, v_occ2, false, null::escalation_category,
    'high'::risk_level, null, null, 'negative'::sentiment, 'high'::risk_level,
    0.800);
  perform pg_temp.check(
    (select outcome_applied_at is not null from public.mention_analyses where id = v_occ2),
    'service_role can execute apply_analysis_occurrence');

  select * into v_claim from public.claim_automation_sweep(v_org, 'apply');
  v_claimed := v_claim.claimed;
  perform pg_temp.check(v_claimed,
    'service_role can execute claim_automation_sweep');
  v_sweep := (v_claim.sweep).id;

  v_exec := public.execute_automation_rule(v_org, v_sweep, v_rule, 1, v_mention, v_occ);
  perform pg_temp.check(v_exec.status = 'applied',
    'service_role can execute execute_automation_rule — status ' || v_exec.status);

  perform public.automation_mark_activity(v_org, v_rule, now(), true, true);
  perform pg_temp.check(
    (select last_applied_at is not null from public.automation_rules where id = v_rule),
    'service_role can execute automation_mark_activity');

  -- The definer path's audit trail: exactly one executed event, carrying both
  -- sweep ids (origin = the row's first attempt, attempt = this call's sweep).
  select count(*) into v_events from public.audit_events
   where organization_id = v_org and event_type = 'automation_rule.executed'
     and entity_id = v_rule;
  perform pg_temp.check(v_events = 1,
    'the definer path lands exactly one automation_rule.executed event');

  select metadata into v_meta from public.audit_events
   where organization_id = v_org and event_type = 'automation_rule.executed'
     and entity_id = v_rule;
  perform pg_temp.check(v_meta ? 'originSweepId' and v_meta ? 'attemptSweepId',
    'the executed event carries originSweepId AND attemptSweepId');
  perform pg_temp.check((v_meta->>'originSweepId')::uuid = v_sweep
                    and (v_meta->>'attemptSweepId')::uuid = v_sweep,
    'both sweep ids are this sweep on a first attempt');

  -- A direct service-role audit insert is the trusted adapter path and works.
  insert into public.audit_events
    (organization_id, actor_type, event_type, entity_type, entity_id)
  values (v_org, 'system', 'mention.analyzed', 'mention', v_mention);
  perform pg_temp.check(
    exists (select 1 from public.audit_events
             where organization_id = v_org and event_type = 'mention.analyzed'
               and entity_id = v_mention),
    'service_role can insert audit events directly');

  reset role;

  -- One escalation exists for the mention and it was created by the definer
  -- path, not by any of the refused inserts above.
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 1,
    'exactly one escalation exists for the unit''s mention, from the definer path');
  perform pg_temp.check(
    (select trigger_analysis_id from public.escalations where mention_id = v_mention) = v_occ,
    'that escalation carries the occurrence that authorized it');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 2. Indexes and event identity, as owner.
--
-- 2a proves each unique index fires by its own name; 2b and 2c prove
-- `record_analysis_occurrence` turns those constraints into an idempotent
-- recorder under every arrival order.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run1 uuid; v_run2 uuid;
  v_a1 uuid; v_a2 uuid; v_e1 uuid;
  v_constraint text;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;

  -- --- two open escalations on one mention ---------------------------------
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's2a');
  v_run1 := pg_temp.new_run(v_org);
  v_run2 := pg_temp.new_run(v_org);
  v_a1 := pg_temp.raw_analysis(v_org, v_mention, v_run1, now());
  v_a2 := pg_temp.raw_analysis(v_org, v_mention, v_run2, now());

  perform pg_temp.raw_escalation(v_org, v_mention, v_a1, 'open');
  v_constraint := null;
  begin
    perform pg_temp.raw_escalation(v_org, v_mention, v_a2, 'in_progress');
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'escalations_one_open_per_mention',
    'a second open escalation is refused by escalations_one_open_per_mention — got '
      || coalesce(v_constraint, 'no error'));

  -- --- one escalation per occurrence ---------------------------------------
  -- The first case is resolved first, so the one-open index cannot be what
  -- fires: the only thing left to refuse the second row is its occurrence.
  update public.escalations
     set status = 'resolved', resolved_at = now(),
         resolution_note = 'harness: spoke to the guest'
   where mention_id = v_mention;
  v_constraint := null;
  begin
    perform pg_temp.raw_escalation(v_org, v_mention, v_a1, 'open');
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'escalations_one_per_occurrence',
    'a second escalation citing the same occurrence is refused by escalations_one_per_occurrence — got '
      || coalesce(v_constraint, 'no error'));

  -- --- one pending occurrence per mention ----------------------------------
  -- Different runs, so the event key differs and only the pending index can
  -- fire.
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's2b');
  v_run1 := pg_temp.new_run(v_org);
  v_run2 := pg_temp.new_run(v_org);
  perform pg_temp.raw_analysis(v_org, v_mention, v_run1, null);
  v_constraint := null;
  begin
    perform pg_temp.raw_analysis(v_org, v_mention, v_run2, null);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'mention_analyses_one_pending',
    'a second pending occurrence is refused by mention_analyses_one_pending — got '
      || coalesce(v_constraint, 'no error'));

  -- --- one occurrence per (org, run, mention) ------------------------------
  -- Both rows settled, so the pending index cannot fire and the event key is
  -- the only thing refusing the duplicate.
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's2c');
  v_run1 := pg_temp.new_run(v_org);
  perform pg_temp.raw_analysis(v_org, v_mention, v_run1, now());
  v_constraint := null;
  begin
    perform pg_temp.raw_analysis(v_org, v_mention, v_run1, now());
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
  end;
  perform pg_temp.check(v_constraint = 'mention_analyses_one_per_event',
    'a duplicate (org, run, mention) is refused by mention_analyses_one_per_event — got '
      || coalesce(v_constraint, 'no error'));
end $$;

-- 2b. Event identity through the recorder: every arrival order collapses onto
--     one durable occurrence, including a recorder that arrives AFTER the
--     event already completed.
do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run uuid; v_run_b uuid;
  v_id1 uuid; v_id2 uuid; v_id3 uuid; v_id4 uuid;
  v_created boolean; v_applied boolean; v_status mention_status;
  v_rows integer;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'new', 'high', 's2d');
  v_run   := pg_temp.new_run(v_org);
  v_run_b := pg_temp.new_run(v_org);

  select analysis_id, created into v_id1, v_created
    from pg_temp.record_occ(v_org, v_mention, v_run);
  perform pg_temp.check(v_created, 'the first recording of an event creates it');

  -- Same (run, mention) while still pending.
  select analysis_id, created into v_id2, v_created
    from pg_temp.record_occ(v_org, v_mention, v_run);
  perform pg_temp.check(v_id2 = v_id1 and not v_created,
    'recording the same event again while pending returns the same id, created=false');

  -- Complete it.
  select already_applied, final_status into v_applied, v_status
    from pg_temp.apply_occ(v_org, v_mention, v_id1, false);
  perform pg_temp.check(not v_applied and v_status = 'analyzed',
    'the pending occurrence applies once, moving new -> analyzed');

  -- LATE RECORDER, after completion: still the same durable occurrence.
  select analysis_id, created into v_id3, v_created
    from pg_temp.record_occ(v_org, v_mention, v_run);
  perform pg_temp.check(v_id3 = v_id1 and not v_created,
    'a late recorder arriving after completion returns the same id, created=false');

  -- Re-applying it reports already_applied — one applied outcome, ever.
  select already_applied, final_status into v_applied, v_status
    from pg_temp.apply_occ(v_org, v_mention, v_id1, true);
  perform pg_temp.check(v_applied,
    're-applying a completed occurrence reports already_applied');
  perform pg_temp.check(v_status = 'analyzed',
    'the replay reports the mention''s current status and changes nothing');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 0,
    'the replayed application raised no escalation');

  select count(*) into v_rows from public.mention_analyses where mention_id = v_mention;
  perform pg_temp.check(v_rows = 1,
    'three recordings of one event left exactly one occurrence row');
  select count(*) into v_rows from public.mention_analyses
   where mention_id = v_mention and outcome_applied_at is not null;
  perform pg_temp.check(v_rows = 1, 'exactly one applied outcome in total');

  -- A NEW run id is a NEW event.
  select analysis_id, created into v_id4, v_created
    from pg_temp.record_occ(v_org, v_mention, v_run_b);
  perform pg_temp.check(v_created and v_id4 <> v_id1,
    'a new run id for the same mention records a new occurrence, created=true');
end $$;

-- 2c. Cross-event pending conflict: a different event arriving while one is
--     pending returns the PENDING row, and never opens a second pending slot.
do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run_x uuid; v_run_y uuid;
  v_x uuid; v_y uuid; v_created boolean; v_rows integer;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'new', 'high', 's2e');
  v_run_x := pg_temp.new_run(v_org);
  v_run_y := pg_temp.new_run(v_org);

  select analysis_id into v_x from pg_temp.record_occ(v_org, v_mention, v_run_x);

  select analysis_id, created into v_y, v_created
    from pg_temp.record_occ(v_org, v_mention, v_run_y);
  perform pg_temp.check(v_y = v_x and not v_created,
    'event Y recorded while event X is pending returns X''s pending row, created=false');

  select count(*) into v_rows from public.mention_analyses
   where mention_id = v_mention and outcome_applied_at is null;
  perform pg_temp.check(v_rows = 1, 'no second pending occurrence was opened');
  select count(*) into v_rows from public.mention_analyses where mention_id = v_mention;
  perform pg_temp.check(v_rows = 1, 'and no second occurrence row at all');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 3. Provenance: the composite foreign keys, the restrict deletes, the
--    execution table's cross-org refusals, and the location cascade.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_state text;
  v_ushg uuid; v_harbor uuid;
  v_um uuid; v_um2 uuid; v_hm uuid; v_hm2 uuid;
  v_urun uuid; v_hrun uuid;
  v_uocc uuid; v_uocc2 uuid; v_hocc uuid;
  v_urule uuid; v_hrule uuid; v_usweep uuid; v_hsweep uuid;
  v_exec uuid; v_loc uuid;
begin
  select * into f from exec_fixtures;
  v_ushg := f.ushg_id; v_harbor := f.harbor_id;

  v_um   := pg_temp.new_mention(v_ushg,   f.soho_id,         'analyzed', 'high', 's3u');
  v_um2  := pg_temp.new_mention(v_ushg,   f.west_village_id, 'analyzed', 'high', 's3u2');
  v_hm   := pg_temp.new_mention(v_harbor, f.harbor_house_id, 'analyzed', 'high', 's3h');
  -- A second harbor mention with NOTHING recorded against it. The composite
  -- FK check below has to land on a mention that holds no pending occurrence:
  -- mention_analyses_one_pending is keyed on mention_id alone and unique
  -- indexes are enforced during the insert, ahead of the end-of-statement
  -- foreign-key triggers, so a victim mention that already has a pending row
  -- would be caught by the pending arm and never reach the FK at all.
  v_hm2  := pg_temp.new_mention(v_harbor, f.harbor_house_id, 'analyzed', 'high', 's3h2');
  v_urun := pg_temp.new_run(v_ushg);
  v_hrun := pg_temp.new_run(v_harbor);
  select analysis_id into v_uocc  from pg_temp.record_occ(v_ushg,   v_um,  v_urun);
  select analysis_id into v_uocc2 from pg_temp.record_occ(v_ushg,   v_um2, v_urun);
  select analysis_id into v_hocc  from pg_temp.record_occ(v_harbor, v_hm,  v_hrun);
  v_urule := pg_temp.new_rule(v_ushg,   '[{"type": "escalate", "assigneeUserId": null}]'::jsonb);
  v_hrule := pg_temp.new_rule(v_harbor, '[{"type": "escalate", "assigneeUserId": null}]'::jsonb);
  v_usweep := pg_temp.new_sweep(v_ushg);
  v_hsweep := pg_temp.new_sweep(v_harbor);

  -- --- composite FK: recording against a FOREIGN mention -------------------
  v_state := null;
  begin
    perform analysis_id from pg_temp.record_occ(v_ushg, v_hm2, v_urun);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'recording an occurrence against another organization''s mention is refused (23503) — got '
      || coalesce(v_state, 'no error'));
  perform pg_temp.check(
    not exists (select 1 from public.mention_analyses
                 where mention_id = v_hm2),
    'and nothing was written against that mention');

  -- --- composite FK: an escalation citing another MENTION's occurrence ------
  v_state := null;
  begin
    perform pg_temp.raw_escalation(v_ushg, v_um, v_uocc2, 'open');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an escalation citing another mention''s occurrence is refused (23503) — got '
      || coalesce(v_state, 'no error'));

  -- --- composite FK: an escalation stamped with a FOREIGN org --------------
  v_state := null;
  begin
    perform pg_temp.raw_escalation(v_harbor, v_um, v_uocc, 'open');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an escalation stamped with a foreign organization is refused (23503) — got '
      || coalesce(v_state, 'no error'));

  -- --- restrict: a cited occurrence cannot be deleted ----------------------
  perform pg_temp.raw_escalation(v_ushg, v_um, v_uocc, 'open');
  v_state := null;
  begin
    delete from public.mention_analyses where id = v_uocc;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'deleting a cited mention_analyses row is restricted (23503) — got '
      || coalesce(v_state, 'no error'));

  -- --- restrict: a referenced run cannot be deleted ------------------------
  v_state := null;
  begin
    delete from public.analysis_runs where id = v_urun;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'deleting a referenced analysis_runs row is restricted (23503) — got '
      || coalesce(v_state, 'no error'));

  -- --- G0: execution rows cannot mix organizations -------------------------
  v_state := null;
  begin
    perform pg_temp.raw_execution(v_ushg, v_hsweep, v_urule, v_um, v_uocc, f.soho_id);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an execution citing a foreign sweep is refused (23503) — got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    perform pg_temp.raw_execution(v_ushg, v_usweep, v_hrule, v_um, v_uocc, f.soho_id);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an execution citing a foreign rule is refused (23503) — got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    perform pg_temp.raw_execution(v_ushg, v_usweep, v_urule, v_hm, v_hocc, f.harbor_house_id);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an execution citing a foreign mention is refused (23503) — got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    perform pg_temp.raw_execution(v_ushg, v_usweep, v_urule, v_um, v_uocc2, f.soho_id);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an execution citing another mention''s occurrence is refused (23503) — got '
      || coalesce(v_state, 'no error'));

  -- The location has to be the MENTION's location, not merely one of the
  -- organization's.
  v_state := null;
  begin
    perform pg_temp.raw_execution(v_ushg, v_usweep, v_urule, v_um, v_uocc, f.west_village_id);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an execution stamped with a location the mention is not at is refused (23503) — got '
      || coalesce(v_state, 'no error'));

  -- --- mention relocation cascades into the execution row ------------------
  v_exec := pg_temp.raw_execution(v_ushg, v_usweep, v_urule, v_um, v_uocc, f.soho_id);
  update public.mentions set location_id = f.west_village_id where id = v_um;
  select location_id into v_loc from public.automation_rule_executions where id = v_exec;
  perform pg_temp.check(v_loc = f.west_village_id,
    'relocating a mention cascades into its execution rows'' location_id');

  update public.mentions set location_id = null where id = v_um;
  select location_id into v_loc from public.automation_rule_executions where id = v_exec;
  perform pg_temp.check(v_loc is null,
    'un-locating a mention cascades a null location into its execution rows');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 4. Location visibility of execution rows.
--
-- Administrators read the whole organization; a location manager reads their
-- own locations and nothing else — including nothing at all for the unlocated
-- rows, which have no location to match on.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_org uuid; v_sweep uuid; v_rule uuid; v_run uuid;
  v_m_soho uuid; v_m_wv uuid; v_m_none uuid;
  v_o_soho uuid; v_o_wv uuid; v_o_none uuid;
  v_e_soho uuid; v_e_wv uuid; v_e_none uuid;
  v_visible integer;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_sweep := pg_temp.new_sweep(v_org);
  v_rule  := pg_temp.new_rule(v_org, '[{"type": "escalate", "assigneeUserId": null}]'::jsonb);
  v_run   := pg_temp.new_run(v_org);

  v_m_soho := pg_temp.new_mention(v_org, f.soho_id,         'analyzed', 'high', 's4a');
  v_m_wv   := pg_temp.new_mention(v_org, f.west_village_id, 'analyzed', 'high', 's4b');
  v_m_none := pg_temp.new_mention(v_org, null,              'analyzed', 'high', 's4c');
  select analysis_id into v_o_soho from pg_temp.record_occ(v_org, v_m_soho, v_run);
  select analysis_id into v_o_wv   from pg_temp.record_occ(v_org, v_m_wv,   v_run);
  select analysis_id into v_o_none from pg_temp.record_occ(v_org, v_m_none, v_run);

  v_e_soho := pg_temp.raw_execution(v_org, v_sweep, v_rule, v_m_soho, v_o_soho, f.soho_id);
  v_e_wv   := pg_temp.raw_execution(v_org, v_sweep, v_rule, v_m_wv,   v_o_wv,   f.west_village_id);
  v_e_none := pg_temp.raw_execution(v_org, v_sweep, v_rule, v_m_none, v_o_none, null);

  -- The location manager.
  perform pg_temp.become(f.ushg_manager);
  select count(*) into v_visible from public.automation_rule_executions
   where id in (v_e_soho, v_e_wv, v_e_none);
  perform pg_temp.check(v_visible = 1,
    'a location manager sees exactly one of the three fixture executions');
  perform pg_temp.check(
    exists (select 1 from public.automation_rule_executions where id = v_e_soho),
    'the one they see is their own location''s');
  perform pg_temp.check(
    not exists (select 1 from public.automation_rule_executions where id = v_e_wv),
    'a location manager cannot read another location''s execution rows');
  perform pg_temp.check(
    not exists (select 1 from public.automation_rule_executions where id = v_e_none),
    'unlocated execution rows are invisible to a location manager');
  -- Sweeps are organization-level telemetry: administrators only.
  perform pg_temp.check(
    not exists (select 1 from public.automation_sweeps where id = v_sweep),
    'a location manager cannot read sweep telemetry');
  reset role;

  -- The administrator.
  perform pg_temp.become(f.ushg_admin);
  select count(*) into v_visible from public.automation_rule_executions
   where id in (v_e_soho, v_e_wv, v_e_none);
  perform pg_temp.check(v_visible = 3,
    'an administrator sees all three, including the unlocated row');
  perform pg_temp.check(
    exists (select 1 from public.automation_sweeps where id = v_sweep),
    'an administrator reads sweep telemetry');
  reset role;

  -- The other organization's manager/owner.
  perform pg_temp.become(f.harbor_owner);
  select count(*) into v_visible from public.automation_rule_executions
   where id in (v_e_soho, v_e_wv, v_e_none);
  perform pg_temp.check(v_visible = 0,
    'the other organization''s manager sees none of them');
  select count(*) into v_visible from public.automation_sweeps where id = v_sweep;
  perform pg_temp.check(v_visible = 0,
    'the other organization''s manager sees none of the sweeps either');
  reset role;
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 5. The contract matrix, through the entry points.
--
-- 5a is the argument guard; 5b proves provenance is checked BEFORE replay —
-- a mismatched occurrence raises rather than returning somebody else's
-- escalation id — and then walks the ladder.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_state text;
  v_ushg uuid; v_harbor uuid;
  v_um uuid; v_um2 uuid; v_hm uuid;
  v_urun uuid; v_hrun uuid;
  v_uocc uuid; v_uocc2 uuid; v_hocc uuid;
  v_before jsonb; v_after jsonb;
begin
  select * into f from exec_fixtures;
  v_ushg := f.ushg_id; v_harbor := f.harbor_id;

  v_um  := pg_temp.new_mention(v_ushg,   f.soho_id,         'analyzed', 'high', 's5a');
  v_um2 := pg_temp.new_mention(v_ushg,   f.soho_id,         'analyzed', 'high', 's5b');
  v_hm  := pg_temp.new_mention(v_harbor, f.harbor_house_id, 'analyzed', 'high', 's5h');
  v_urun := pg_temp.new_run(v_ushg);
  v_hrun := pg_temp.new_run(v_harbor);
  select analysis_id into v_uocc  from pg_temp.record_occ(v_ushg,   v_um,  v_urun);
  select analysis_id into v_uocc2 from pg_temp.record_occ(v_ushg,   v_um2, v_urun);
  select analysis_id into v_hocc  from pg_temp.record_occ(v_harbor, v_hm,  v_hrun);

  -- 5a. A null occurrence is an argument error, not a silent creation.
  v_state := null;
  begin
    perform * from public.raise_escalation(
      v_ushg, v_um, 'other'::escalation_category, 'high'::risk_level,
      'no occurrence', null, null, null, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '22004',
    'raise_escalation refuses a null occurrence with 22004 — got ' || coalesce(v_state, 'no error'));

  -- 5b. Provenance before replay.
  v_before := to_jsonb((select count(*) from public.escalations));

  v_state := null;
  begin
    perform * from public.raise_escalation(
      v_ushg, v_um, 'other'::escalation_category, 'high'::risk_level,
      'cross-mention occurrence', null, null, v_uocc2, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an occurrence belonging to another mention raises 23503 — got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    perform * from public.raise_escalation(
      v_ushg, v_um, 'other'::escalation_category, 'high'::risk_level,
      'cross-org occurrence', null, null, v_hocc, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = '23503',
    'an occurrence belonging to another organization raises 23503 — got ' || coalesce(v_state, 'no error'));

  v_state := null;
  begin
    perform * from public.raise_escalation(
      v_harbor, v_um, 'other'::escalation_category, 'high'::risk_level,
      'cross-org mention', null, null, v_uocc, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = 'P0002',
    'a mention outside the named organization raises P0002 — got ' || coalesce(v_state, 'no error'));

  v_after := to_jsonb((select count(*) from public.escalations));
  perform pg_temp.check(v_before = v_after,
    'not one of the four refusals created an escalation');
end $$;

-- 5c. The replay triple, including after the case is resolved.
do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run uuid; v_occ uuid;
  v_id1 uuid; v_id2 uuid; v_id3 uuid;
  v_created boolean; v_reason text;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5c');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);

  select escalation_id, created, reason into v_id1, v_created, v_reason
    from public.raise_escalation(v_org, v_mention, 'other'::escalation_category,
      'high'::risk_level, 'first', null, null, v_occ, null);
  perform pg_temp.check(v_created and v_reason is null,
    'the first raise creates the case');

  select escalation_id, created, reason into v_id2, v_created, v_reason
    from public.raise_escalation(v_org, v_mention, 'other'::escalation_category,
      'high'::risk_level, 'second', null, null, v_occ, null);
  perform pg_temp.check(v_id2 = v_id1 and not v_created and v_reason = 'occurrence_replayed',
    'replaying the occurrence returns the same case as occurrence_replayed');

  update public.escalations
     set status = 'resolved', resolved_at = now(),
         resolution_note = 'harness: spoke to the guest'
   where id = v_id1;

  select escalation_id, created, reason into v_id3, v_created, v_reason
    from public.raise_escalation(v_org, v_mention, 'other'::escalation_category,
      'high'::risk_level, 'third', null, null, v_occ, null);
  perform pg_temp.check(v_id3 = v_id1 and not v_created and v_reason = 'occurrence_replayed',
    'replay still returns that case once it is resolved — replay reports history, whatever its state');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 1,
    'three raises off one occurrence left exactly one case');
end $$;

-- 5d. A dismissed mention: an unused occurrence is refused, a consumed one
--     replays, and neither touches the mention.
do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run uuid; v_occ1 uuid; v_occ2 uuid;
  v_run2 uuid; v_id uuid; v_created boolean; v_reason text;
  v_status mention_status; v_case_id uuid;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5d');
  v_run  := pg_temp.new_run(v_org);
  v_run2 := pg_temp.new_run(v_org);

  select analysis_id into v_occ1 from pg_temp.record_occ(v_org, v_mention, v_run);
  select escalation_id into v_case_id
    from public.raise_escalation(v_org, v_mention, 'other'::escalation_category,
      'high'::risk_level, 'before dismissal', null, null, v_occ1, null);
  update public.escalations
     set status = 'resolved', resolved_at = now(),
         resolution_note = 'harness: spoke to the guest'
   where id = v_case_id;
  update public.mentions set status = 'dismissed' where id = v_mention;
  update public.mention_analyses set outcome_applied_at = now() where id = v_occ1;

  -- An occurrence nothing has consumed: hard refusal, no row at all.
  select analysis_id into v_occ2 from pg_temp.record_occ(v_org, v_mention, v_run2);
  select escalation_id, created, reason into v_id, v_created, v_reason
    from public.raise_escalation(v_org, v_mention, 'other'::escalation_category,
      'high'::risk_level, 'after dismissal', null, null, v_occ2, null);
  perform pg_temp.check(v_id is null and not v_created and v_reason = 'mention_dismissed',
    'a dismissed mention refuses an unused occurrence with mention_dismissed and no row');

  -- The consumed one still reports its history.
  select escalation_id, created, reason into v_id, v_created, v_reason
    from public.raise_escalation(v_org, v_mention, 'other'::escalation_category,
      'high'::risk_level, 'replay after dismissal', null, null, v_occ1, null);
  perform pg_temp.check(v_id = v_case_id and not v_created and v_reason = 'occurrence_replayed',
    'a consumed occurrence replays even on a dismissed mention — replay is checked before the refusal');

  select status into v_status from public.mentions where id = v_mention;
  perform pg_temp.check(v_status = 'dismissed', 'the dismissal stands after both calls');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 1,
    'and no second case was raised');
end $$;

-- 5e. The A/B/C ladder, through apply_analysis_occurrence.
do $$
declare
  f record;
  v_org uuid; v_mention uuid;
  v_r1 uuid; v_r2 uuid; v_r3 uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid;
  v_case1 uuid; v_case2 uuid;
  v_id uuid; v_created boolean; v_reason text; v_applied boolean;
  v_status mention_status; v_open integer;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5e');
  v_r1 := pg_temp.new_run(v_org);
  v_r2 := pg_temp.new_run(v_org);
  v_r3 := pg_temp.new_run(v_org);

  -- A: a resolved case leaves the mention escalated, and a NEW occurrence is
  -- refused as awaiting_retriage — a human has to re-triage first.
  select analysis_id into v_o1 from pg_temp.record_occ(v_org, v_mention, v_r1);
  select escalation_id, escalation_created, reason, final_status
    into v_case1, v_created, v_reason, v_status
    from pg_temp.apply_occ(v_org, v_mention, v_o1, true);
  perform pg_temp.check(v_created and v_reason is null and v_status = 'escalated',
    'A — the first occurrence raises the case and escalates the mention');

  update public.escalations
     set status = 'resolved', resolved_at = now(),
         resolution_note = 'harness: spoke to the guest'
   where id = v_case1;
  select status into v_status from public.mentions where id = v_mention;
  perform pg_temp.check(v_status = 'escalated',
    'A — resolving the case does not re-triage the mention');

  select analysis_id into v_o2 from pg_temp.record_occ(v_org, v_mention, v_r2);
  select escalation_id, escalation_created, reason, already_applied, final_status
    into v_id, v_created, v_reason, v_applied, v_status
    from pg_temp.apply_occ(v_org, v_mention, v_o2, true);
  perform pg_temp.check(v_id is null and not v_created and v_reason = 'awaiting_retriage'
                        and not v_applied and v_status = 'escalated',
    'A — a new occurrence on an un-triaged mention is awaiting_retriage, status preserved');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 1,
    'A — still exactly one case');

  -- B: replaying a completed occurrence has no effects at all.
  update public.mentions set status = 'monitoring' where id = v_mention;
  select escalation_id, escalation_created, reason, already_applied, final_status
    into v_id, v_created, v_reason, v_applied, v_status
    from pg_temp.apply_occ(v_org, v_mention, v_o1, true, 'positive', 'low', 0.100);
  perform pg_temp.check(v_applied and v_status = 'monitoring' and v_id is null,
    'B — replaying a completed occurrence reports already_applied and the current status');
  perform pg_temp.check(
    (select sentiment from public.mentions where id = v_mention) <> 'positive',
    'B — the replay wrote nothing, not even the classification columns');

  -- C: a re-triaged mention escalates again on a new occurrence.
  select analysis_id into v_o3 from pg_temp.record_occ(v_org, v_mention, v_r3);
  select escalation_id, escalation_created, reason, final_status
    into v_case2, v_created, v_reason, v_status
    from pg_temp.apply_occ(v_org, v_mention, v_o3, true);
  perform pg_temp.check(v_created and v_reason is null and v_status = 'escalated'
                        and v_case2 <> v_case1,
    'C — a re-triaged mention raises a second, different case');
  select count(*) into v_open from public.escalations
   where mention_id = v_mention and status in ('open', 'in_progress', 'pending_approval');
  perform pg_temp.check(v_open = 1, 'C — exactly one of the two cases is open');

  -- escalation_exists: a different occurrence while the case is open.
  update public.mentions set status = 'monitoring' where id = v_mention;
  select escalation_id, created, reason into v_id, v_created, v_reason
    from public.raise_escalation(v_org, v_mention, 'other'::escalation_category,
      'high'::risk_level, 'deduped', null, null, v_o2, null);
  perform pg_temp.check(v_id = v_case2 and not v_created and v_reason = 'escalation_exists',
    'escalation_exists returns the OPEN case, not the older resolved one');
end $$;

-- 5f. execute_automation_rule: a terminal row replays with zero effects, and
--     every code the unit produced is inside the pinned vocabulary.
do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run uuid; v_occ uuid;
  v_rule uuid; v_sweep uuid; v_sweep2 uuid;
  v_exec public.automation_rule_executions;
  v_exec2 public.automation_rule_executions;
  v_events integer;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5f');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
  v_rule   := pg_temp.new_rule(v_org, '[{"type": "escalate", "assigneeUserId": null}]'::jsonb);
  v_sweep  := pg_temp.new_sweep(v_org);
  v_sweep2 := pg_temp.new_sweep(v_org);

  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ);
  perform pg_temp.check(v_exec.status = 'applied' and v_exec.attempt_count = 1,
    'the unit applies once — status ' || v_exec.status);

  -- Replay under a DIFFERENT sweep: same row, unchanged, no second event.
  v_exec2 := pg_temp.exec_unit(v_org, v_sweep2, v_rule, v_mention, v_occ);
  perform pg_temp.check(v_exec2.id = v_exec.id and v_exec2.attempt_count = 1
                        and v_exec2.completed_at = v_exec.completed_at,
    'a terminal row replays unchanged under a different sweep');
  perform pg_temp.check(v_exec2.sweep_id = v_sweep,
    'the row keeps its ORIGIN sweep across the replay');
  select count(*) into v_events from public.audit_events
   where organization_id = v_org and entity_id = v_rule
     and event_type = 'automation_rule.executed';
  perform pg_temp.check(v_events = 1, 'the replay wrote no second executed event');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 1,
    'the replay raised no second case');

end $$;

-- 5g. The outcome-code vocabulary, provoked deliberately. Each unit below is
--     built to produce one specific code; asserting only "the codes we saw are
--     a subset of the vocabulary" would pass vacuously on an empty set, so the
--     set is asserted in BOTH directions.
do $$
declare
  f record;
  v_org uuid; v_run uuid; v_sweep uuid;
  v_m uuid; v_occ uuid; v_occ2 uuid; v_rule uuid; v_run2 uuid;
  v_exec public.automation_rule_executions;
  v_codes text[];
  v_expected text[] := array['escalation_reserved', 'high_risk_guardrail',
                             'forbidden_transition', 'action_not_executable',
                             'escalation_exists'];
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_run   := pg_temp.new_run(v_org);
  v_run2  := pg_temp.new_run(v_org);
  v_sweep := pg_temp.new_sweep(v_org);

  -- escalation_reserved: only the escalate action may reach `escalated`.
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5g1');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  v_rule := pg_temp.new_rule(v_org, '[{"type": "set_status", "status": "escalated"}]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_m, v_occ);
  perform pg_temp.check(v_exec.outcomes->0->>'code' = 'escalation_reserved',
    '5g — set_status to escalated is blocked as escalation_reserved');

  -- high_risk_guardrail: a high-risk mention cannot be parked.
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5g2');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  v_rule := pg_temp.new_rule(v_org, '[{"type": "set_status", "status": "dismissed"}]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_m, v_occ);
  perform pg_temp.check(v_exec.outcomes->0->>'code' = 'high_risk_guardrail',
    '5g — dismissing a high-risk mention is blocked as high_risk_guardrail');

  -- forbidden_transition: `new` is not a movable source.
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'new', 'low', 's5g3');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  v_rule := pg_temp.new_rule(v_org, '[{"type": "set_status", "status": "monitoring"}]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_m, v_occ);
  perform pg_temp.check(v_exec.outcomes->0->>'code' = 'forbidden_transition',
    '5g — moving a new mention is blocked as forbidden_transition');

  -- action_not_executable: valid shape, no effect wired to it yet.
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5g4');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  v_rule := pg_temp.new_rule(v_org, '[{"type": "auto_publish"}]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_m, v_occ);
  perform pg_temp.check(v_exec.outcomes->0->>'code' = 'action_not_executable',
    '5g — auto_publish is blocked as action_not_executable');

  -- escalation_exists: a standing case, reached by a DIFFERENT occurrence.
  -- The ladder's internal reason is mapped into the public vocabulary at the
  -- boundary — internal reasons stay internal.
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's5g5');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  perform escalation_id from public.raise_escalation(v_org, v_m,
    'other'::escalation_category, 'high'::risk_level, 'standing', null, null,
    v_occ, null);
  update public.mention_analyses set outcome_applied_at = now() where id = v_occ;
  update public.mentions set status = 'monitoring' where id = v_m;
  select analysis_id into v_occ2 from pg_temp.record_occ(v_org, v_m, v_run2);
  v_rule := pg_temp.new_rule(v_org, '[{"type": "escalate", "assigneeUserId": null}]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_m, v_occ2);
  perform pg_temp.check(v_exec.outcomes->0->>'code' = 'escalation_exists'
                        and v_exec.outcomes->0->>'outcome' = 'no_op',
    '5g — a standing case makes escalate a no_op coded escalation_exists');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_m) = 1,
    '5g — and no second case was raised');

  -- The vocabulary itself, asserted in both directions so it cannot pass on
  -- an empty set.
  select coalesce(array_agg(distinct o->>'code'), array[]::text[]) into v_codes
    from public.automation_rule_executions e,
         lateral jsonb_array_elements(e.outcomes) o
   where e.sweep_id = v_sweep and o->>'code' is not null;
  perform pg_temp.check(v_codes <@ v_expected,
    '5g — every outcome code produced is inside the pinned vocabulary — saw ' || v_codes::text);
  perform pg_temp.check(v_expected <@ v_codes,
    '5g — and all five blocked/no-op codes were actually produced — saw ' || v_codes::text);
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 6. Whole-unit rollback, escalation/audit atomicity, and status derivation.
--
-- 6a and 6b use real triggers to force a failure at a chosen point. The two
-- failure shapes are deliberately different: `execute_automation_rule` runs
-- its effects in a SUBTRANSACTION and absorbs the exception into a failed row,
-- while `apply_analysis_occurrence` has no handler at all — its atomicity is
-- the caller's transaction, so the whole unit disappears.
-- ---------------------------------------------------------------------------

begin;

create function public.harness_block_escalated_transition()
returns trigger language plpgsql as $fn$
begin
  if new.status = 'escalated'
     and old.external_id like 'exec-harness-s6a-%' then
    raise exception 'harness: forced failure inside the execution unit'
      using errcode = 'P0001';
  end if;
  return new;
end $fn$;

create trigger harness_s6a_guard
  before update on public.mentions
  for each row execute function public.harness_block_escalated_transition();

do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run uuid; v_occ uuid;
  v_rule uuid; v_sweep uuid;
  v_exec public.automation_rule_executions;
  v_status mention_status; v_events integer; v_meta jsonb;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's6a');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
  v_rule  := pg_temp.new_rule(v_org, '[{"type": "escalate", "assigneeUserId": null}]'::jsonb);
  v_sweep := pg_temp.new_sweep(v_org);

  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ);

  perform pg_temp.check(v_exec.status = 'failed' and v_exec.error_class = 'retryable',
    '6a — a technical failure finalizes the claim row as failed/retryable');
  perform pg_temp.check(v_exec.attempt_count = 1,
    '6a — on its first attempt');
  perform pg_temp.check(v_exec.outcomes = '[]'::jsonb,
    '6a — the outcomes accumulated inside the subtransaction rolled back');

  select status into v_status from public.mentions where id = v_mention;
  perform pg_temp.check(v_status = 'analyzed',
    '6a — the mention never moved');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 0,
    '6a — no escalation survived the rollback');

  select count(*) into v_events from public.audit_events
   where organization_id = v_org and entity_id = v_rule
     and event_type = 'automation_rule.executed';
  perform pg_temp.check(v_events = 0, '6a — no executed event');

  select count(*) into v_events from public.audit_events
   where organization_id = v_org and entity_id = v_rule
     and event_type = 'automation_rule.execution_failed';
  perform pg_temp.check(v_events = 1, '6a — exactly one execution_failed event');

  select metadata into v_meta from public.audit_events
   where organization_id = v_org and entity_id = v_rule
     and event_type = 'automation_rule.execution_failed';
  perform pg_temp.check(v_meta ? 'errorCode' and v_meta ? 'originSweepId'
                        and v_meta ? 'attemptSweepId',
    '6a — the failure event carries errorCode and both sweep ids');
end $$;

-- 7a lives here, because it is the same fixture: the retry after the rollback.
drop trigger harness_s6a_guard on public.mentions;

do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_occ uuid; v_rule uuid; v_sweep uuid;
  v_exec public.automation_rule_executions;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  select m.id into v_mention from public.mentions m
   where m.external_id like 'exec-harness-s6a-%' limit 1;
  select a.id into v_occ from public.mention_analyses a where a.mention_id = v_mention limit 1;
  select e.automation_rule_id, e.sweep_id into v_rule, v_sweep
    from public.automation_rule_executions e where e.mention_id = v_mention limit 1;

  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ);

  perform pg_temp.check(v_exec.status = 'applied',
    '7a — the retry after a rolled-back attempt applies');
  perform pg_temp.check(v_exec.attempt_count = 2,
    '7a — attempt_count is 2, got ' || v_exec.attempt_count);
  perform pg_temp.check(v_exec.error_class is null and v_exec.last_error_code is null,
    '7a — success clears the error fields');
  perform pg_temp.check(
    (select status from public.mentions where id = v_mention) = 'escalated',
    '7a — and the effects landed this time');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 1,
    '7a — exactly one case');
end $$;

drop function public.harness_block_escalated_transition();

rollback;

-- 6b. Escalation/audit atomicity through apply_analysis_occurrence: if the
--     created-audit write fails, the escalation, the transition and the
--     completion all go with it.

begin;

create function public.harness_block_escalation_audit()
returns trigger language plpgsql as $fn$
begin
  if new.event_type = 'escalation.created_from_analysis'
     and exists (
       select 1 from public.mentions m
        where m.id = (new.metadata->>'mentionId')::uuid
          and m.external_id like 'exec-harness-s6b-%') then
    raise exception 'harness: forced failure writing the escalation audit event'
      using errcode = 'P0001';
  end if;
  return new;
end $fn$;

create trigger harness_s6b_guard
  before insert on public.audit_events
  for each row execute function public.harness_block_escalation_audit();

do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run uuid; v_occ uuid;
  v_state text; v_status mention_status;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's6b');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);

  -- The plpgsql exception block is a subtransaction: catching the error rolls
  -- back everything apply_analysis_occurrence did, which is the point.
  v_state := null;
  begin
    perform * from pg_temp.apply_occ(v_org, v_mention, v_occ, true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  perform pg_temp.check(v_state = 'P0001',
    '6b — the failing audit write propagates out of apply_analysis_occurrence');

  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 0,
    '6b — no escalation survived');
  select status into v_status from public.mentions where id = v_mention;
  perform pg_temp.check(v_status = 'analyzed',
    '6b — the mention transition rolled back too');
  perform pg_temp.check(
    (select outcome_applied_at is null from public.mention_analyses where id = v_occ),
    '6b — the occurrence is still pending, so recovery will re-pick it');
end $$;

drop trigger harness_s6b_guard on public.audit_events;

do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_occ uuid;
  v_created boolean; v_status mention_status; v_events integer;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  select m.id into v_mention from public.mentions m
   where m.external_id like 'exec-harness-s6b-%' limit 1;
  select a.id into v_occ from public.mention_analyses a where a.mention_id = v_mention limit 1;

  select escalation_created, final_status into v_created, v_status
    from pg_temp.apply_occ(v_org, v_mention, v_occ, true);

  perform pg_temp.check(v_created and v_status = 'escalated',
    '6b — the retry raises the case and escalates the mention');
  perform pg_temp.check(
    (select count(*) from public.escalations where mention_id = v_mention) = 1,
    '6b — exactly one escalation');
  select count(*) into v_events from public.audit_events
   where organization_id = v_org and event_type = 'escalation.created_from_analysis'
     and (metadata->>'mentionId')::uuid = v_mention;
  perform pg_temp.check(v_events = 1, '6b — exactly one created-audit event');
  perform pg_temp.check(
    (select outcome_applied_at is not null from public.mention_analyses where id = v_occ),
    '6b — and the occurrence is completed');
end $$;

drop function public.harness_block_escalation_audit();

rollback;

-- 6c. Status derivation, every branch. There is no caller-supplied status:
--     the database derives it from the mention's CURRENT state and the
--     escalation result, which is what makes a human decision made between
--     recording and application impossible to overwrite.

begin;

do $$
declare
  f record;
  v_org uuid; v_m uuid; v_run uuid; v_run2 uuid; v_occ uuid; v_occ2 uuid;
  v_case uuid; v_status mention_status; v_reason text; v_created boolean;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;

  -- created -> escalated
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's6c1');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  select escalation_created, reason, final_status into v_created, v_reason, v_status
    from pg_temp.apply_occ(v_org, v_m, v_occ, true);
  perform pg_temp.check(v_created and v_status = 'escalated',
    '6c — created -> escalated');

  -- escalation_exists -> escalated
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's6c2');
  v_run  := pg_temp.new_run(v_org);
  v_run2 := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  select escalation_id into v_case
    from public.raise_escalation(v_org, v_m, 'other'::escalation_category,
      'high'::risk_level, 'standing case', null, null, v_occ, null);
  update public.mentions set status = 'monitoring' where id = v_m;
  update public.mention_analyses set outcome_applied_at = now() where id = v_occ;
  select analysis_id into v_occ2 from pg_temp.record_occ(v_org, v_m, v_run2);
  select escalation_created, reason, final_status into v_created, v_reason, v_status
    from pg_temp.apply_occ(v_org, v_m, v_occ2, true);
  perform pg_temp.check(not v_created and v_reason = 'escalation_exists'
                        and v_status = 'escalated',
    '6c — escalation_exists -> escalated');

  -- mention_dismissed -> dismissed, preserved
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'dismissed', 'high', 's6c3');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  select escalation_created, reason, final_status into v_created, v_reason, v_status
    from pg_temp.apply_occ(v_org, v_m, v_occ, true);
  perform pg_temp.check(not v_created and v_reason = 'mention_dismissed'
                        and v_status = 'dismissed',
    '6c — mention_dismissed -> dismissed preserved');
  perform pg_temp.check(
    (select status from public.mentions where id = v_m) = 'dismissed',
    '6c — and the row really is still dismissed');

  -- awaiting_retriage -> escalated, preserved
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'escalated', 'high', 's6c4');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  select escalation_created, reason, final_status into v_created, v_reason, v_status
    from pg_temp.apply_occ(v_org, v_m, v_occ, true);
  perform pg_temp.check(not v_created and v_reason = 'awaiting_retriage'
                        and v_status = 'escalated',
    '6c — awaiting_retriage -> escalated preserved');

  -- non-escalation from new -> analyzed
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'new', 'low', 's6c5');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  select final_status into v_status from pg_temp.apply_occ(v_org, v_m, v_occ, false);
  perform pg_temp.check(v_status = 'analyzed', '6c — non-escalation from new -> analyzed');

  -- non-escalation after a HUMAN set responded between record and apply
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'new', 'low', 's6c6');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  update public.mentions set status = 'responded' where id = v_m;  -- the human
  select final_status into v_status
    from pg_temp.apply_occ(v_org, v_m, v_occ, false, 'negative', 'critical', 0.900);
  perform pg_temp.check(v_status = 'responded',
    '6c — a status a person set between recording and application is preserved');
  perform pg_temp.check(
    (select sentiment = 'negative' and risk_level = 'critical'
            and relevance_score = 0.900 from public.mentions where id = v_m),
    '6c — while sentiment, risk and relevance still update');

  -- non-escalation on dismissed -> preserved
  v_m := pg_temp.new_mention(v_org, f.soho_id, 'dismissed', 'low', 's6c7');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_m, v_run);
  select final_status into v_status from pg_temp.apply_occ(v_org, v_m, v_occ, false);
  perform pg_temp.check(v_status = 'dismissed',
    '6c — a non-escalating occurrence never un-dismisses a mention');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 7. Retry, terminal replay, and sweep claiming.
--    (7a — the retry after the forced rollback — lives with its fixture in
--    section 6 above.)
-- ---------------------------------------------------------------------------

begin;

-- 7b. rule_changed is terminal: it replays rather than retrying.
do $$
declare
  f record;
  v_org uuid; v_mention uuid; v_run uuid; v_occ uuid;
  v_rule uuid; v_sweep uuid;
  v_exec public.automation_rule_executions;
  v_exec2 public.automation_rule_executions;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's7b');
  v_run := pg_temp.new_run(v_org);
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
  v_rule  := pg_temp.new_rule(v_org, '[{"type": "escalate", "assigneeUserId": null}]'::jsonb);
  v_sweep := pg_temp.new_sweep(v_org);

  -- The stored revision moved on since this unit was queued.
  update public.automation_rules set revision = 2 where id = v_rule;

  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ, 1);
  perform pg_temp.check(v_exec.status = 'failed' and v_exec.error_class = 'terminal'
                        and v_exec.last_error_code = 'rule_changed',
    '7b — a stale revision fails terminally as rule_changed');
  perform pg_temp.check(
    (select status from public.mentions where id = v_mention) = 'analyzed',
    '7b — nothing was applied');

  v_exec2 := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ, 1);
  perform pg_temp.check(v_exec2.id = v_exec.id and v_exec2.attempt_count = 1
                        and v_exec2.completed_at = v_exec.completed_at,
    '7b — a terminal row replays unchanged rather than retrying');
end $$;

-- 7c. Claim states.
do $$
declare
  f record;
  v_org uuid;
  v_first public.automation_sweeps; v_second public.automation_sweeps;
  v_third public.automation_sweeps;
  v_claim record; v_claimed boolean; v_running integer;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;

  select * into v_claim from public.claim_automation_sweep(v_org, 'apply');
  v_first := v_claim.sweep; v_claimed := v_claim.claimed;
  perform pg_temp.check(v_claimed and v_first.status = 'running',
    '7c — the first claim of an idle organization wins the lease');

  -- An active lease: same sweep back, claimed=false, no new row.
  select * into v_claim from public.claim_automation_sweep(v_org, 'apply');
  v_second := v_claim.sweep; v_claimed := v_claim.claimed;
  perform pg_temp.check(not v_claimed and v_second.id = v_first.id,
    '7c — a second claim under an active lease returns the SAME sweep, claimed=false');
  select count(*) into v_running from public.automation_sweeps
   where organization_id = v_org and status = 'running';
  perform pg_temp.check(v_running = 1, '7c — still exactly one running sweep');

  -- Backdate past the 30-minute lease: the takeover happens exactly once.
  update public.automation_sweeps set started_at = now() - interval '35 minutes'
   where id = v_first.id;

  select * into v_claim from public.claim_automation_sweep(v_org, 'apply');
  v_third := v_claim.sweep; v_claimed := v_claim.claimed;
  perform pg_temp.check(v_claimed and v_third.id <> v_first.id,
    '7c — a 35-minute-old lease is taken over by a new sweep');
  perform pg_temp.check(
    (select status = 'failed' and error_code = 'lease_expired'
       from public.automation_sweeps where id = v_first.id),
    '7c — the stale sweep is finalized as failed/lease_expired');
  select count(*) into v_running from public.automation_sweeps
   where organization_id = v_org and status = 'running';
  perform pg_temp.check(v_running = 1, '7c — the takeover left exactly one running sweep');

  -- And the takeover is not repeatable while the new lease is fresh.
  select * into v_claim from public.claim_automation_sweep(v_org, 'apply');
  v_claimed := v_claim.claimed;
  perform pg_temp.check(not v_claimed,
    '7c — the fresh lease is not taken over a second time');

  -- Finalize between cases, so the next block starts from a clean state.
  update public.automation_sweeps set status = 'completed', completed_at = now()
   where organization_id = v_org and status = 'running';
end $$;

rollback;

-- 7d. An UNRELATED unique violation inside the claim path must re-raise, not
--     be absorbed as "somebody else won the race". Only
--     automation_sweeps_one_running is absorbed.
--
-- Its own transaction: the throwaway index is on (organization_id, mode), and
-- 7b/7c above leave several apply-mode sweeps behind that it could not be
-- built over.

begin;

do $$
declare
  f record;
  v_org uuid; v_state text; v_msg text;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;

  execute 'create unique index harness_sweeps_one_per_mode
             on public.automation_sweeps (organization_id, mode)';
  -- A completed row, so automation_sweeps_one_running is not what fires.
  perform pg_temp.new_sweep(v_org, 'apply', 'completed');

  v_state := null;
  begin
    perform * from public.claim_automation_sweep(v_org, 'apply');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  perform pg_temp.check(v_state = '23505',
    '7d — an unrelated unique violation re-raises out of the claim path (23505) — got '
      || coalesce(v_state, 'no error'));
  perform pg_temp.check(coalesce(v_msg, '') like '%harness_sweeps_one_per_mode%',
    '7d — and it is the unrelated constraint that surfaced: ' || coalesce(v_msg, ''));

  execute 'drop index harness_sweeps_one_per_mode';

  -- With the throwaway index gone, the same call succeeds.
  perform pg_temp.check(
    (select claimed from public.claim_automation_sweep(v_org, 'apply')),
    '7d — the claim path works again once the unrelated constraint is gone');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 8. Stored-action validation, through the real RPC.
--
-- The unit executes the STORED revision: callers name a unit, they never
-- define one. So every case below writes the actions column directly — the
-- authoring path would have refused these rows — and then asks the RPC.
--
-- Two arms of the SQL validator are deliberately NOT exercised here: the null
-- and non-array cases. `automation_rules.actions` is `not null` with a
-- `jsonb_typeof(actions) = 'array'` check constraint, so the column cannot
-- hold those values at all; those arms are defensive, and the twin
-- (tests/automation-execution-repository.test.ts, whose store has no
-- constraints) is where they are pinned. Non-RFC-shaped uuid strings are
-- excluded too: `automation_is_uuid` is the PostgreSQL parser and Zod's
-- `z.uuid()` is stricter, and that documented divergence is the one place the
-- two validators disagree.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  f record;
  v_org uuid; v_run uuid; v_sweep uuid;
  v_case record;
  v_mention uuid; v_occ uuid; v_rule uuid;
  v_exec public.automation_rule_executions;
  v_n integer := 0;
begin
  select * into f from exec_fixtures;
  v_org := f.ushg_id;
  v_run   := pg_temp.new_run(v_org);
  v_sweep := pg_temp.new_sweep(v_org);

  for v_case in
    select * from (values
      ('generate_draft without voiceProfile',            '{"type": "generate_draft"}'::jsonb),
      ('generate_draft whose voiceProfile is not a string', '{"type": "generate_draft", "voiceProfile": 12}'::jsonb),
      ('generate_draft whose voiceProfile is over 80 characters',
        jsonb_build_object('type', 'generate_draft', 'voiceProfile', repeat('x', 81))),
      ('require_approval without approverUserId',        '{"type": "require_approval"}'::jsonb),
      ('require_approval whose approverUserId is not a uuid',
        '{"type": "require_approval", "approverUserId": "somebody"}'::jsonb),
      ('assign without assigneeUserId',                  '{"type": "assign"}'::jsonb),
      ('assign whose assigneeUserId is not a uuid',      '{"type": "assign", "assigneeUserId": 7}'::jsonb),
      ('escalate without assigneeUserId',                '{"type": "escalate"}'::jsonb),
      ('escalate whose assigneeUserId is not a uuid',    '{"type": "escalate", "assigneeUserId": "nobody"}'::jsonb),
      ('notify without a channel',                       '{"type": "notify"}'::jsonb),
      ('notify whose channel is null',                   '{"type": "notify", "channel": null}'::jsonb),
      ('notify whose channel is outside the vocabulary', '{"type": "notify", "channel": "sms"}'::jsonb),
      ('tag without a label',                            '{"type": "tag"}'::jsonb),
      ('tag whose label is empty',                       '{"type": "tag", "label": ""}'::jsonb),
      ('tag whose label is over 80 characters',
        jsonb_build_object('type', 'tag', 'label', repeat('x', 81))),
      ('set_status without a status',                    '{"type": "set_status"}'::jsonb),
      ('set_status outside the mention_status vocabulary',
        '{"type": "set_status", "status": "not_a_status"}'::jsonb),
      ('an action with no type at all',                  '{"voiceProfile": null}'::jsonb),
      ('an action type nothing knows about',             '{"type": "publish_to_tiktok"}'::jsonb)
    ) as t(label, action)
  loop
    v_n := v_n + 1;
    v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's8');
    select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
    v_rule := pg_temp.new_rule(v_org, jsonb_build_array(v_case.action));

    v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ);

    perform pg_temp.check(
      v_exec.status = 'failed' and v_exec.error_class = 'terminal'
        and v_exec.last_error_code = 'invalid_action'
        and v_exec.outcomes = '[]'::jsonb,
      '8 — ' || v_case.label || ' fails terminally as invalid_action');
    perform pg_temp.check(
      (select status from public.mentions where id = v_mention) = 'analyzed'
        and not exists (select 1 from public.escalations where mention_id = v_mention),
      '8 — ' || v_case.label || ' left the mention untouched');
  end loop;

  perform pg_temp.check(v_n = 19, '8 — all 19 malformed cases ran, got ' || v_n);

  -- A malformed element refuses the WHOLE list, even behind an executable one.
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's8');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
  v_rule := pg_temp.new_rule(v_org,
    '[{"type": "set_status", "status": "monitoring"},
      {"type": "notify", "channel": "carrier_pigeon"}]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ);
  perform pg_temp.check(v_exec.last_error_code = 'invalid_action',
    '8 — a valid action ahead of a malformed one does not save the list');
  perform pg_temp.check(
    (select status from public.mentions where id = v_mention) = 'analyzed',
    '8 — and the executable action ahead of it did not run');

  -- Unknown fields on an otherwise valid action: valid, then separately
  -- refused for not being wired to an effect.
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's8');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
  v_rule := pg_temp.new_rule(v_org,
    '[{"type": "auto_publish", "tone": "friendly", "maxLength": 400, "dryRun": true}]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ);
  perform pg_temp.check(v_exec.status = 'blocked' and v_exec.last_error_code is null,
    '8 — auto_publish with extra fields is valid and blocked, not invalid');
  perform pg_temp.check(
    v_exec.outcomes = '[{"code": "action_not_executable", "type": "auto_publish", "index": 0, "outcome": "blocked"}]'::jsonb,
    '8 — with the action_not_executable outcome — got ' || v_exec.outcomes::text);

  -- An empty list is well formed: a rule may legitimately have had its
  -- actions removed. no_op, not a failure.
  v_mention := pg_temp.new_mention(v_org, f.soho_id, 'analyzed', 'high', 's8');
  select analysis_id into v_occ from pg_temp.record_occ(v_org, v_mention, v_run);
  v_rule := pg_temp.new_rule(v_org, '[]'::jsonb);
  v_exec := pg_temp.exec_unit(v_org, v_sweep, v_rule, v_mention, v_occ);
  perform pg_temp.check(v_exec.status = 'no_op' and v_exec.error_class is null
                        and v_exec.last_error_code is null
                        and v_exec.outcomes = '[]'::jsonb,
    '8 — an empty action list is a valid unit that does nothing');

  -- The check constraint really does make the null/non-array arms unreachable
  -- from the column, which is why they are twin-only above.
  declare v_state text;
  begin
    begin
      update public.automation_rules set actions = '{"type": "set_status"}'::jsonb
       where id = v_rule;
    exception when check_violation then
      v_state := 'blocked';
    end;
    perform pg_temp.check(v_state = 'blocked',
      '8 — automation_rules_actions_is_array blocks a non-array actions column outright');
  end;
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- 9. Matrix parity.
--
-- The cell-for-cell assertions are the generated file, which psql runs
-- immediately after this one in the same session. This section only proves the
-- handoff works: the decision functions exist, and the helper the generated
-- file calls resolves in ITS argument order from a definition that is not
-- inside a rolled-back transaction.
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.check(
    to_regprocedure('public.automation_set_status_decision(mention_status, mention_status, risk_level)')
      is not null,
    '9 — automation_set_status_decision is present for the parity file');
  perform pg_temp.check(
    to_regprocedure('public.automation_escalate_decision(mention_status)') is not null,
    '9 — automation_escalate_decision is present for the parity file');
  perform pg_temp.check(
    (select count(*) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'check' and n.nspname like 'pg_temp%') = 2,
    '9 — both pg_temp.check overloads are defined');
end $$;

-- The parity file's own call shape, once, so a resolution failure surfaces
-- here with an explanation rather than 333 lines later.
select pg_temp.check('9 — the parity file''s (label, condition) call order resolves', true);

-- ---------------------------------------------------------------------------
-- 10. The cron org scan.
--
-- `organizations_with_unanalyzed_mentions` is the only unscoped cross-tenant
-- read behind the analyse-mentions sweep, and its predicate is a disjunction
-- for a reason: a mention can carry an older SETTLED occurrence and a newer
-- PENDING one at the same time, and "no settled row exists" alone would drop
-- that organization from the sweep while unapplied work still sits on it.
-- Vitest cannot see drift between this function and its twin, so it is
-- checked here against a hand-built fixture — five shapes, five verdicts.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_orgs uuid[] := array[]::uuid[];
  v_ids record;
  v_case text;
  v_org uuid; v_conn uuid; v_mention uuid; v_run uuid; v_run2 uuid;
  v_settled_only uuid; v_settled_and_pending uuid; v_both_settled uuid;
  v_pending_only uuid; v_no_rows uuid;
  v_scan uuid[];
begin
  -- Five organizations, one shape each. Built here rather than reused from
  -- the seed because the verdicts have to be unambiguous.
  for v_case in select unnest(array['settled-only', 'settled-and-pending',
                                    'both-settled', 'pending-only', 'no-rows'])
  loop
    insert into public.organizations (name, slug, industry)
    values ('exec harness ' || v_case, 'exec-harness-' || v_case || '-' ||
              substr(gen_random_uuid()::text, 1, 8), 'restaurants')
    returning id into v_org;
    insert into public.platform_connections (organization_id, platform)
    values (v_org, 'google_business_profile') returning id into v_conn;
    v_orgs := v_orgs || v_org;

    if v_case <> 'no-rows' then
      insert into public.mentions
          (organization_id, platform_connection_id, source_type, external_id,
           content, published_at, status)
      values (v_org, v_conn, 'google_review',
              'exec-harness-s10-' || gen_random_uuid()::text,
              'org scan fixture', now(), 'new')
      returning id into v_mention;

      v_run  := pg_temp.new_run(v_org);
      v_run2 := pg_temp.new_run(v_org);

      if v_case = 'settled-only' then
        perform pg_temp.raw_analysis(v_org, v_mention, v_run, now());
      elsif v_case = 'settled-and-pending' then
        perform pg_temp.raw_analysis(v_org, v_mention, v_run,  now());
        perform pg_temp.raw_analysis(v_org, v_mention, v_run2, null);
      elsif v_case = 'both-settled' then
        perform pg_temp.raw_analysis(v_org, v_mention, v_run,  now());
        perform pg_temp.raw_analysis(v_org, v_mention, v_run2, now());
      elsif v_case = 'pending-only' then
        perform pg_temp.raw_analysis(v_org, v_mention, v_run, null);
      end if;
    end if;
  end loop;

  v_settled_only        := v_orgs[1];
  v_settled_and_pending := v_orgs[2];
  v_both_settled        := v_orgs[3];
  v_pending_only        := v_orgs[4];
  v_no_rows             := v_orgs[5];

  select coalesce(array_agg(organization_id), array[]::uuid[]) into v_scan
    from public.organizations_with_unanalyzed_mentions();

  perform pg_temp.check(not (v_settled_only = any (v_scan)),
    '10 — a mention with only a settled occurrence is not swept');
  perform pg_temp.check(v_settled_and_pending = any (v_scan),
    '10 — a mention carrying a settled AND a pending occurrence IS swept (the disjunction''s whole point)');
  perform pg_temp.check(not (v_both_settled = any (v_scan)),
    '10 — two settled occurrences on one mention are still settled');
  perform pg_temp.check(v_pending_only = any (v_scan),
    '10 — a pending-only mention is swept');
  perform pg_temp.check(not (v_no_rows = any (v_scan)),
    '10 — an organization with no mentions at all is not swept');

  -- And the negative control: a mention with no analysis row at all — the
  -- original predicate — is still swept.
  insert into public.mentions
      (organization_id, platform_connection_id, source_type, external_id,
       content, published_at, status)
  select v_settled_only, pc.id, 'google_review',
         'exec-harness-s10-fresh-' || gen_random_uuid()::text,
         'org scan fixture', now(), 'new'
    from public.platform_connections pc where pc.organization_id = v_settled_only;

  select coalesce(array_agg(organization_id), array[]::uuid[]) into v_scan
    from public.organizations_with_unanalyzed_mentions();
  perform pg_temp.check(v_settled_only = any (v_scan),
    '10 — adding one never-analyzed mention brings the organization back into the sweep');
end $$;

rollback;

-- ---------------------------------------------------------------------------
-- Everything above ran inside `begin; ... rollback;`. Nothing persists except
-- the pg_temp helpers, which the generated parity file needs next.
-- ---------------------------------------------------------------------------
