-- Row-level security verification.
--
-- Repeatable manual check that the policies in
-- 20260801000200_row_level_security.sql actually isolate tenants.
--
-- This script has NOT been executed. The environment used to build workflow 01
-- had no PostgreSQL server available and no running Docker daemon, so it is
-- provided as the documented verification procedure rather than as a passing
-- result. Run it before trusting the policies in any deployment.
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
    limit 1) as harbor_owner;

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

rollback;
