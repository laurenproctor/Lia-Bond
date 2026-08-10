-- Row-level security verification.
--
-- Repeatable manual check that the policies in
-- 20260801000200_row_level_security.sql actually isolate tenants.
--
-- Execution status: **all 37 checks pass** against a local stack
-- (`supabase start`, then `supabase db reset`), as of the onboarding workflow.
--
-- It did not, until section 8's delete check was corrected. That check expected
-- an exception from an analyst's DELETE, but a DELETE gated by an RLS `using`
-- clause matches zero rows *silently* — unlike an INSERT, which fails its
-- `with check` and raises 42501. The policy was working the whole time; the
-- assertion was testing for the wrong shape of refusal, and because
-- `ON_ERROR_STOP=1` halts on the first failure it also hid every section after
-- it. See the note above section 8.
--
-- Usage:
--   supabase start
--   supabase db reset            # applies migrations, then supabase/seed.sql
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
--        -v ON_ERROR_STOP=1 -f supabase/tests/rls-verification.sql
--
-- Every check raises an exception on failure, so a clean run means every
-- assertion held.

begin;

-- The seeded organizations and a member of each. Resolved by slug rather than
-- by hard-coded id, so this keeps working if the seed is regenerated.
create temporary table rls_fixtures as
select
  (select id from public.organizations where slug = 'union-square-hospitality') as ushg_id,
  (select id from public.organizations where slug = 'harbor-and-vine')          as harbor_id,
  (select m.user_id
     from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality'
      and m.role = 'admin'
      and m.status = 'active'
    limit 1) as ushg_admin,
  (select m.user_id
     from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'harbor-and-vine'
      and m.role = 'owner'
      and m.status = 'active'
    limit 1) as harbor_owner,
  -- Neither `monitoring.manage_queries`/`monitoring.poll_now`
  -- (owner/admin/communications_lead) nor `can_write_in_organization`
  -- (owner/admin/communications_lead/location_manager/approver) include
  -- analyst — it is the role section 8 below uses to prove the news-
  -- monitoring write policies are gated by role, not merely membership.
  (select m.user_id
     from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality'
      and m.role = 'analyst'
      and m.status = 'active'
    limit 1) as ushg_analyst,
  -- Section 10 below uses this as the role `automation_rules_insert`/
  -- `automation_rules_update` actually admit (owner/admin/communications_lead).
  (select m.user_id
     from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality'
      and m.role = 'communications_lead'
      and m.status = 'active'
    limit 1) as ushg_comms_lead;

-- Impersonate an authenticated user. Supabase derives auth.uid() from the
-- request JWT; setting the claim here reproduces that for a psql session.
create or replace function pg_temp.become(target_user uuid)
returns void
language plpgsql
as $$
begin
  execute format('set local role authenticated');
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', target_user, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.check(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if not condition then
    raise exception 'RLS CHECK FAILED: %', label;
  end if;
  raise notice 'ok: %', label;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. A member sees their own organization's rows and none of the other's.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  mine integer;
  theirs integer;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.ushg_admin);

  select count(*) into mine   from public.mentions where organization_id = f.ushg_id;
  select count(*) into theirs from public.mentions where organization_id = f.harbor_id;

  perform pg_temp.check(mine > 0,     'ushg admin can read their own mentions');
  perform pg_temp.check(theirs = 0,   'ushg admin cannot read harbor mentions');

  select count(*) into theirs from public.escalations where organization_id = f.harbor_id;
  perform pg_temp.check(theirs = 0,   'ushg admin cannot read harbor escalations');

  select count(*) into theirs from public.response_drafts where organization_id = f.harbor_id;
  perform pg_temp.check(theirs = 0,   'ushg admin cannot read harbor response drafts');

  select count(*) into theirs from public.audit_events where organization_id = f.harbor_id;
  perform pg_temp.check(theirs = 0,   'ushg admin cannot read harbor audit events');

  select count(*) into theirs from public.automation_rules where organization_id = f.harbor_id;
  perform pg_temp.check(theirs = 0,   'ushg admin cannot read harbor automation rules');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The check holds in the other direction too.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  mine integer;
  theirs integer;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.harbor_owner);

  select count(*) into mine   from public.mentions where organization_id = f.harbor_id;
  select count(*) into theirs from public.mentions where organization_id = f.ushg_id;

  perform pg_temp.check(mine > 0,   'harbor owner can read their own mentions');
  perform pg_temp.check(theirs = 0, 'harbor owner cannot read ushg mentions');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A cross-tenant write is refused, not silently dropped.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  refused boolean := false;
  affected integer;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.ushg_admin);

  -- UPDATE against a foreign row matches nothing under the USING clause.
  update public.mentions
     set status = 'dismissed'
   where organization_id = f.harbor_id;
  get diagnostics affected = row_count;
  perform pg_temp.check(affected = 0, 'cross-tenant UPDATE affects zero rows');

  -- INSERT stamped with a foreign organization must be rejected by WITH CHECK.
  begin
    insert into public.automation_rules (organization_id, name, status)
    values (f.harbor_id, 'injected rule', 'active');
  exception when insufficient_privilege or check_violation then
    refused := true;
  end;
  perform pg_temp.check(refused, 'cross-tenant INSERT is refused');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Authentication alone grants nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  visible integer;
begin
  -- A valid session for a user with no memberships at all.
  perform pg_temp.become('00000000-0000-4000-8000-000000000000'::uuid);

  select count(*) into visible from public.mentions;
  perform pg_temp.check(visible = 0, 'a user with no membership sees no mentions');

  select count(*) into visible from public.organizations;
  perform pg_temp.check(visible = 0, 'a user with no membership sees no organizations');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Secrets are unreachable from any authenticated session.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  visible integer;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.ushg_admin);

  -- The table has RLS enabled and zero policies, so even an owner sees nothing.
  select count(*) into visible from public.platform_connection_secrets;
  perform pg_temp.check(visible = 0, 'platform_connection_secrets is service-role only');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The audit trail cannot be rewritten.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  refused boolean := false;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.ushg_admin);

  begin
    update public.audit_events set event_type = 'response.approved'
     where organization_id = f.ushg_id;
  exception when insufficient_privilege then
    refused := true;
  end;
  perform pg_temp.check(refused, 'audit events cannot be updated');

  refused := false;
  begin
    delete from public.audit_events where organization_id = f.ushg_id;
  exception when insufficient_privilege then
    refused := true;
  end;
  perform pg_temp.check(refused, 'audit events cannot be deleted');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. News monitoring tables isolate tenants (workflow 06).
--
-- None of the three tables carry seed data, unlike mentions above, so this
-- section plants one row per tenant first. Inserted before any impersonation
-- in this block, which means it runs as the connecting role and bypasses RLS
-- the same way supabase/seed.sql does.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  ushg_query_id uuid;
  ushg_run_id uuid;
  harbor_query_id uuid;
  harbor_run_id uuid;
begin
  select * into f from rls_fixtures;

  insert into public.monitoring_queries (organization_id, name, query_type, keywords)
  values (f.ushg_id, 'rls fixture - ushg', 'brand', array['union square hospitality'])
  returning id into ushg_query_id;

  insert into public.news_poll_runs (organization_id, monitoring_query_id)
  values (f.ushg_id, ushg_query_id)
  returning id into ushg_run_id;

  insert into public.news_rejected_candidates
    (organization_id, monitoring_query_id, news_poll_run_id, external_id, url, reason, score, published_at)
  values
    (f.ushg_id, ushg_query_id, ushg_run_id, 'rls-fixture-ushg', 'https://example.com/ushg', 'below_threshold', 0.100, now());

  insert into public.monitoring_queries (organization_id, name, query_type, keywords)
  values (f.harbor_id, 'rls fixture - harbor', 'brand', array['harbor and vine'])
  returning id into harbor_query_id;

  insert into public.news_poll_runs (organization_id, monitoring_query_id)
  values (f.harbor_id, harbor_query_id)
  returning id into harbor_run_id;

  insert into public.news_rejected_candidates
    (organization_id, monitoring_query_id, news_poll_run_id, external_id, url, reason, score, published_at)
  values
    (f.harbor_id, harbor_query_id, harbor_run_id, 'rls-fixture-harbor', 'https://example.com/harbor', 'below_threshold', 0.100, now());
end;
$$;

-- The mine>0 half of each pair below is not incidental: without it, a policy
-- broken so badly that it hides an organization's own rows would still make
-- theirs=0 pass, and the harness would report success while RLS denied
-- everyone everything. Checks 1 and 2 rely on the same pairing against seeded
-- mentions; this block plants its own rows above because these tables start
-- empty.
do $$
declare
  f record;
  mine integer;
  theirs integer;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.harbor_owner);

  select count(*) into mine   from public.monitoring_queries where organization_id = f.harbor_id;
  select count(*) into theirs from public.monitoring_queries where organization_id = f.ushg_id;
  perform pg_temp.check(mine > 0,   'harbor owner can read their own monitoring queries');
  perform pg_temp.check(theirs = 0, 'harbor owner cannot read ushg monitoring queries');

  select count(*) into mine   from public.news_poll_runs where organization_id = f.harbor_id;
  select count(*) into theirs from public.news_poll_runs where organization_id = f.ushg_id;
  perform pg_temp.check(mine > 0,   'harbor owner can read their own news poll runs');
  perform pg_temp.check(theirs = 0, 'harbor owner cannot read ushg news poll runs');

  select count(*) into mine   from public.news_rejected_candidates where organization_id = f.harbor_id;
  select count(*) into theirs from public.news_rejected_candidates where organization_id = f.ushg_id;
  perform pg_temp.check(mine > 0,   'harbor owner can read their own rejected news candidates');
  perform pg_temp.check(theirs = 0, 'harbor owner cannot read ushg rejected news candidates');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. News monitoring writes are gated by role, not just membership
--    (fix-wave finding: 20260806000600_news_monitoring_rls.sql originally
--    gated every write policy on these three tables with
--    `is_organization_member`, which every active member — including a
--    read-only `viewer` or `analyst` — satisfies. Corrected in
--    20260807000500_news_monitoring_write_roles_rls.sql.)
--
-- Two different refusal shapes, and conflating them is how this section came
-- to assert something false:
--
-- - An **INSERT** blocked by a `with check` clause fails the whole statement
--   with SQLSTATE 42501 (insufficient_privilege), so it is wrapped to turn the
--   exception into a boolean.
-- - A **DELETE** or **UPDATE** blocked by a `using` clause matches zero rows
--   *silently*. There is no exception to catch — the row is simply not visible
--   to the statement — so the assertion is on `row_count`, exactly as section
--   3's cross-tenant UPDATE check does.
--
-- The delete check below originally expected an exception and therefore failed
-- against a real database while the policy it was testing was working
-- correctly.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  ushg_query_id uuid;
  ushg_run_id uuid;
  raised boolean;
  affected integer;
begin
  select * into f from rls_fixtures;

  -- Reuses the fixture rows section 7 planted as the connecting role.
  select id into ushg_query_id
    from public.monitoring_queries
   where organization_id = f.ushg_id and name = 'rls fixture - ushg'
   limit 1;
  select id into ushg_run_id
    from public.news_poll_runs
   where organization_id = f.ushg_id and monitoring_query_id = ushg_query_id
   limit 1;

  perform pg_temp.become(f.ushg_analyst);

  raised := false;
  begin
    insert into public.monitoring_queries (organization_id, name, query_type, keywords)
    values (f.ushg_id, 'rls fixture - analyst denied', 'brand', array['denied']);
  exception when insufficient_privilege then
    raised := true;
  end;
  perform pg_temp.check(
    raised,
    'an analyst cannot insert a monitoring query (member of the org, but not owner/admin/communications_lead)'
  );

  -- No exception to catch: `monitoring_queries_delete_write_roles` gates this
  -- with a `using` clause, so the row is invisible to the statement and the
  -- delete matches nothing. Asserting on row_count is what actually proves the
  -- row survived.
  delete from public.monitoring_queries where id = ushg_query_id;
  get diagnostics affected = row_count;
  perform pg_temp.check(affected = 0, 'an analyst cannot delete a monitoring query');
  perform pg_temp.check(
    exists (select 1 from public.monitoring_queries where id = ushg_query_id),
    'the monitoring query an analyst tried to delete is still there'
  );

  raised := false;
  begin
    insert into public.news_poll_runs (organization_id, monitoring_query_id)
    values (f.ushg_id, ushg_query_id);
  exception when insufficient_privilege then
    raised := true;
  end;
  perform pg_temp.check(
    raised,
    'an analyst cannot insert a news poll run — the concrete path a viewer or analyst could otherwise use to exhaust the shared global request budget (D85) for every tenant'
  );

  raised := false;
  begin
    insert into public.news_rejected_candidates
      (organization_id, monitoring_query_id, news_poll_run_id, external_id, url, reason, score, published_at)
    values (
      f.ushg_id, ushg_query_id, ushg_run_id,
      'rls-fixture-analyst-denied', 'https://example.com/analyst-denied',
      'below_threshold', 0.100, now()
    );
  exception when insufficient_privilege then
    raised := true;
  end;
  perform pg_temp.check(raised, 'an analyst cannot insert a rejected news candidate either');

  reset role;
end;
$$;

do $$
declare
  f record;
  inserted_id uuid;
  failed boolean := false;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.ushg_admin);

  begin
    insert into public.monitoring_queries (organization_id, name, query_type, keywords)
    values (f.ushg_id, 'rls fixture - admin allowed', 'brand', array['allowed'])
    returning id into inserted_id;
  exception when insufficient_privilege then
    failed := true;
  end;
  -- The negative checks above are only meaningful if the same policy also
  -- lets the intended role through — otherwise a policy that denied
  -- everyone, including owners and admins, would pass every check above too.
  perform pg_temp.check(not failed and inserted_id is not null,
    'an admin (in monitoring.manage_queries''s role set) can insert a monitoring query');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. organization_onboarding
--
-- Three properties, and the third is the one worth the section. Reads are open
-- to any active member because the route guard runs for every role. Writes are
-- owner-and-admin only — narrower than `can_write_in_organization`, because
-- finishing setup decides what everybody in the organization sees on sign-in.
-- And a member of one organization must not be able to see, still less
-- advance, another organization's setup.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  visible integer;
  raised boolean;
  updated integer;
begin
  select * into f from rls_fixtures;

  -- Every organization has a row: provision_organization writes one, and the
  -- backfill in 20260808000100 covered everything that predated it. A missing
  -- row here means the backfill or the seed did not land.
  perform pg_temp.become(f.ushg_admin);

  select count(*) into visible from public.organization_onboarding;
  perform pg_temp.check(
    visible = 1,
    'an admin sees exactly one onboarding row — their own organization''s, never Harbor''s'
  );

  select count(*) into visible
    from public.organization_onboarding
   where organization_id = f.harbor_id;
  perform pg_temp.check(
    visible = 0,
    'cross-organization read of onboarding progress returns nothing'
  );

  -- An admin may advance their own organization's setup.
  update public.organization_onboarding
     set current_step = 'connect_sources'
   where organization_id = f.ushg_id;
  get diagnostics updated = row_count;
  perform pg_temp.check(
    updated = 1,
    'an admin can advance their own organization''s onboarding'
  );

  -- …and cannot touch another organization's, which fails as zero rows
  -- matched rather than as an error: the USING clause filters it out before
  -- the update is attempted.
  update public.organization_onboarding
     set current_step = 'team'
   where organization_id = f.harbor_id;
  get diagnostics updated = row_count;
  perform pg_temp.check(
    updated = 0,
    'a cross-organization onboarding update matches no rows'
  );

  reset role;

  -- An analyst reads (the guard needs it) but writes nothing.
  perform pg_temp.become(f.ushg_analyst);

  select count(*) into visible from public.organization_onboarding;
  perform pg_temp.check(
    visible = 1,
    'an analyst can read onboarding progress — the route guard runs for every role'
  );

  raised := false;
  begin
    update public.organization_onboarding
       set status = 'completed', completed_at = now()
     where organization_id = f.ushg_id;
    get diagnostics updated = row_count;
    if updated > 0 then
      raise exception 'analyst update unexpectedly affected % row(s)', updated;
    end if;
  exception when insufficient_privilege then
    raised := true;
  end;
  perform pg_temp.check(
    raised or updated = 0,
    'an analyst cannot mark onboarding complete — the concrete path by which a read-only role could push the whole organization past a wizard whose steps it has no authority to perform'
  );

  raised := false;
  begin
    delete from public.organization_onboarding where organization_id = f.ushg_id;
  exception when insufficient_privilege then
    raised := true;
  end;
  perform pg_temp.check(
    raised,
    'nobody can delete an onboarding row — its absence reads as "completed", so a delete would look like a setup that never happened'
  );

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Automation rule writes are gated to owner/admin/communications_lead
--     (rule authoring). `automation_rules_insert`/`automation_rules_update`
--     in 20260801000200_row_level_security.sql admit that role set; there is
--     no DELETE policy on this table at all, so — per the header note above —
--     a cleanup DELETE here would silently match zero rows rather than prove
--     anything about permissions. The row this section inserts is left in
--     place and undone by the final `rollback;` below, the same way section
--     8's admin-allowed insert is never explicitly deleted either.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  inserted_id uuid;
  failed boolean := false;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.ushg_comms_lead);

  begin
    insert into public.automation_rules (organization_id, name, status)
    values (f.ushg_id, 'rls fixture - comms lead allowed', 'draft')
    returning id into inserted_id;
  exception when insufficient_privilege then
    failed := true;
  end;
  perform pg_temp.check(
    not failed and inserted_id is not null,
    'a communications lead (in automation_rules_insert''s role set) can insert an automation rule'
  );

  perform pg_temp.check(
    exists (
      select 1 from public.automation_rules
       where id = inserted_id and organization_id = f.ushg_id
    ),
    'the automation rule a communications lead inserted is visible in their own organization'
  );

  reset role;
end;
$$;

do $$
declare
  f record;
  refused boolean := false;
begin
  select * into f from rls_fixtures;
  perform pg_temp.become(f.ushg_analyst);

  begin
    insert into public.automation_rules (organization_id, name, status)
    values (f.ushg_id, 'rls fixture - analyst denied', 'draft');
  exception when insufficient_privilege or check_violation then
    refused := true;
  end;
  perform pg_temp.check(
    refused,
    'an analyst cannot insert an automation rule (member of the org, but not owner/admin/communications_lead)'
  );

  reset role;
end;
$$;

rollback;
