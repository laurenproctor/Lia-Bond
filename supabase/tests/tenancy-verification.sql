-- ---------------------------------------------------------------------------
-- Tenancy verification: multi-organization membership and location administration
--
-- Companion to rls-verification.sql, covering what migrations 20260814000100
-- through 20260814000500 add. Same shape throughout: fixtures resolved by slug
-- rather than by hard-coded id, `set role` impersonation, one raise per failed
-- assertion, and a rollback at the end so the database is unchanged.
--
-- Usage:
--   supabase start
--   supabase db reset
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-verification.sql \
--                                               -f supabase/tests/tenancy-verification.sql
-- or simply: npm run db:verify-tenancy
--
-- **This file is valid against both an R1 and an R3 database.** The rollout is
-- expand-contract: 20260814000500 (the policy contraction) ships in a later
-- release than the other four, so a database can legitimately be in either
-- state. Sections that assert the *narrowed* policies are guarded on the
-- migration being present, and section 12 asserts the guard itself resolved
-- correctly — a guard that silently skipped everything would be
-- indistinguishable from a clean run, which is the one failure mode a
-- conditional harness must not have.
--
-- Two things are deliberately NOT tested here, with reasons:
--
--   * Function EXECUTE denials are asserted from `pg_catalog`, never by making
--     the denied call. The local Postgres image segfaults the whole cluster on
--     an EXECUTE-denied call of a non-immutable function after `set role` —
--     the exact shape of an unauthorized PostgREST RPC — so attempting it here
--     would take this harness's own database down mid-run. Section 11.
--
--   * Concurrency. Interleaving is not expressible in one psql session;
--     scripts/provisioning-race-test.sh and scripts/mapping-race-test.sh drive
--     two sessions over FIFOs for that, and npm run db:verify-tenancy runs both
--     after this file.
-- ---------------------------------------------------------------------------

begin;

create temporary table tenancy_fixtures as
select
  (select id from public.organizations where slug = 'union-square-hospitality') as ushg_id,
  (select id from public.organizations where slug = 'harbor-and-vine')          as harbor_id,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'owner'  and m.status = 'active' limit 1) as ushg_owner,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'admin'  and m.status = 'active' limit 1) as ushg_admin,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'communications_lead' and m.status = 'active' limit 1) as ushg_comms_lead,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'location_manager'    and m.status = 'active' limit 1) as ushg_location_manager,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'approver' and m.status = 'active' limit 1) as ushg_approver,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'union-square-hospitality' and m.role = 'analyst'  and m.status = 'active' limit 1) as ushg_analyst,
  (select m.user_id from public.memberships m
     join public.organizations o on o.id = m.organization_id
    where o.slug = 'harbor-and-vine' and m.role = 'owner' and m.status = 'active' limit 1) as harbor_owner,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'union-square-hospitality' order by l.slug limit 1) as ushg_location,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'harbor-and-vine' order by l.slug limit 1) as harbor_location,
  (select c.id from public.platform_connections c
     join public.organizations o on o.id = c.organization_id
    where o.slug = 'union-square-hospitality' order by c.platform limit 1) as ushg_connection,
  (select c.id from public.platform_connections c
     join public.organizations o on o.id = c.organization_id
    where o.slug = 'harbor-and-vine' order by c.platform limit 1) as harbor_connection;

create or replace function pg_temp.become(target_user uuid)
returns void language plpgsql as $$
begin
  execute format('set local role authenticated');
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', target_user, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.unbecome()
returns void language plpgsql as $$
begin
  execute 'reset role';
  execute 'set local request.jwt.claims to default';
end;
$$;

create or replace function pg_temp.check(condition boolean, label text)
returns void language plpgsql as $$
begin
  if not condition then
    raise exception 'TENANCY CHECK FAILED: %', label;
  end if;
  raise notice 'ok: %', label;
end;
$$;

/** True once 20260814000500 (the R3 contraction) has been applied. */
create or replace function pg_temp.contracted()
returns boolean language sql stable as $$
  select not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'locations' and policyname = 'locations_delete'
  ) and not has_table_privilege('authenticated', 'public.locations', 'delete');
$$;

-- A counter, so section 12 can prove the guarded sections actually ran rather
-- than having been skipped silently.
create temporary table tenancy_guard_log (section text primary key);

do $$
begin
  perform pg_temp.check(
    (select count(*) from tenancy_fixtures f
      where f.ushg_id is not null and f.harbor_id is not null
        and f.ushg_owner is not null and f.ushg_admin is not null
        and f.ushg_comms_lead is not null and f.ushg_location_manager is not null
        and f.ushg_approver is not null and f.ushg_analyst is not null
        and f.harbor_owner is not null and f.ushg_location is not null
        and f.harbor_location is not null) = 1,
    'fixtures resolved'
  );
end $$;

-- ---------------------------------------------------------------------------
-- 1. Location write authority [post-contraction]
--
-- T-1..T-6, T-18. Guarded: before 20260814000500 the wide
-- can_write_in_organization policy is still in place and these would fail
-- correctly-but-uselessly against an R1 database.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  refused boolean;
  touched integer;
begin
  if not pg_temp.contracted() then
    raise notice 'skip: section 1 (locations write authority) — 20260814000500 not applied';
    return;
  end if;
  insert into tenancy_guard_log values ('section-1');

  select * into f from tenancy_fixtures;

  -- T-1: location manager INSERT
  perform pg_temp.become(f.ushg_location_manager);
  refused := false;
  begin
    insert into public.locations (
      organization_id, name, slug, address_line1, city, region, postal_code,
      country_code, timezone
    ) values (f.ushg_id, 'T1', 't1-loc', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC');
  exception when insufficient_privilege then refused := true;
  end;
  perform pg_temp.check(refused, 'T-1 location manager cannot insert a location');

  -- T-2: approver INSERT
  perform pg_temp.become(f.ushg_approver);
  refused := false;
  begin
    insert into public.locations (
      organization_id, name, slug, address_line1, city, region, postal_code,
      country_code, timezone
    ) values (f.ushg_id, 'T2', 't2-loc', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC');
  exception when insufficient_privilege then refused := true;
  end;
  perform pg_temp.check(refused, 'T-2 approver cannot insert a location');

  -- T-3: communications lead direct INSERT. Their mapping path is section 9.
  perform pg_temp.become(f.ushg_comms_lead);
  refused := false;
  begin
    insert into public.locations (
      organization_id, name, slug, address_line1, city, region, postal_code,
      country_code, timezone
    ) values (f.ushg_id, 'T3', 't3-loc', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC');
  exception when insufficient_privilege then refused := true;
  end;
  perform pg_temp.check(refused, 'T-3 communications lead cannot insert a location directly');

  -- T-4/T-5: a `using`-gated UPDATE matches zero rows silently rather than
  -- raising. Asserting for an exception here is the mistake section 8 of
  -- rls-verification.sql records having made.
  perform pg_temp.become(f.ushg_location_manager);
  update public.locations set name = name || ' x' where id = f.ushg_location;
  get diagnostics touched = row_count;
  perform pg_temp.check(touched = 0, 'T-4 location manager update touches no rows');

  perform pg_temp.become(f.ushg_comms_lead);
  update public.locations set name = name || ' x' where id = f.ushg_location;
  get diagnostics touched = row_count;
  perform pg_temp.check(touched = 0, 'T-5 communications lead update touches no rows');

  -- T-6: the control. Without it T-4 and T-5 would pass on a table nobody can
  -- write at all.
  perform pg_temp.become(f.ushg_admin);
  update public.locations set name = name where id = f.ushg_location;
  get diagnostics touched = row_count;
  perform pg_temp.check(touched = 1, 'T-6 admin can update a location in their own organization');

  -- T-18: delete refused at the privilege level, not merely by policy absence.
  perform pg_temp.check(
    not has_table_privilege('authenticated', 'public.locations', 'delete'),
    'T-18 authenticated holds no DELETE privilege on locations'
  );

  perform pg_temp.unbecome();
end $$;

-- ---------------------------------------------------------------------------
-- 2. Expansion-phase compatibility [pre-contraction]
--
-- T-26. The mirror of T-3: before the contraction ships, the deployed
-- application's direct mapping insert must still work, or R1 has broken
-- production before R2 could fix it.
-- ---------------------------------------------------------------------------

do $$
declare f record;
begin
  if pg_temp.contracted() then
    raise notice 'skip: section 2 (pre-contraction compatibility) — already contracted';
    return;
  end if;
  insert into tenancy_guard_log values ('section-2');

  select * into f from tenancy_fixtures;
  perform pg_temp.become(f.ushg_comms_lead);
  insert into public.locations (
    organization_id, name, slug, address_line1, city, region, postal_code,
    country_code, timezone
  ) values (f.ushg_id, 'T26', 't26-loc', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC');
  perform pg_temp.check(true, 'T-26 communications lead can still insert directly before contraction');
  perform pg_temp.unbecome();
  delete from public.locations where organization_id = f.ushg_id and slug = 't26-loc';
end $$;

-- ---------------------------------------------------------------------------
-- 3. Manager invariants: same organization, active on assignment
--
-- T-7, T-8, T-9a, T-9, T-10.
--
-- Two mechanisms guard this column and they are deliberately not
-- interchangeable, so each is proven on its own:
--
--   * the composite foreign key `locations_manager_same_org` makes "belongs to
--     this organization" structural, and carries the ON DELETE SET NULL that
--     handles a removed membership;
--   * the trigger `locations_manager_is_active_member` adds "and the
--     membership is active", which no foreign key can express.
--
-- **A BEFORE trigger fires ahead of constraint checking**, so in ordinary use
-- the trigger answers every case the foreign key would have — a stranger and a
-- foreign member both come back as 23514 rather than 23503. That is good
-- behaviour (the clearer error wins) and a bad test: asserting only the
-- observable code would let the foreign key be dropped entirely without
-- anything failing. So each case is run twice, once with the trigger disabled,
-- which is the only way to observe the layer underneath. Disabling is
-- transactional and this whole file rolls back.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  refused boolean;
  code text;
  stranger uuid;
  suspended_user uuid;
  surviving uuid;
  surviving_org uuid;
begin
  select * into f from tenancy_fixtures;

  -- A user with no membership in USHG at all.
  select u.id into stranger
  from public.users u
  where not exists (
    select 1 from public.memberships m where m.user_id = u.id and m.organization_id = f.ushg_id
  )
  limit 1;
  perform pg_temp.check(stranger is not null, 'fixture: a non-member user exists');

  -- T-7a: no membership anywhere in this organization. The trigger answers.
  code := null;
  begin
    update public.locations set manager_user_id = stranger where id = f.ushg_location;
  exception when others then code := sqlstate;
  end;
  perform pg_temp.check(code = '23514', 'T-7a a manager with no membership is refused by the trigger (23514)');

  -- T-8a: a member of a different organization. Also the trigger.
  code := null;
  begin
    update public.locations set manager_user_id = f.harbor_owner where id = f.ushg_location;
  exception when others then code := sqlstate;
  end;
  perform pg_temp.check(code = '23514', 'T-8a a manager from another organization is refused by the trigger (23514)');

  -- With the trigger out of the way, the foreign key must still refuse both.
  -- This is what proves the structural layer exists rather than being implied
  -- by a trigger somebody could drop.
  alter table public.locations disable trigger locations_manager_is_active_member;

  code := null;
  begin
    update public.locations set manager_user_id = stranger where id = f.ushg_location;
  exception when others then code := sqlstate;
  end;
  perform pg_temp.check(code = '23503', 'T-7b the foreign key alone refuses a non-member (23503)');

  code := null;
  begin
    update public.locations set manager_user_id = f.harbor_owner where id = f.ushg_location;
  exception when others then code := sqlstate;
  end;
  perform pg_temp.check(code = '23503', 'T-8b the foreign key alone refuses a member of another organization (23503)');

  -- And the inverse, which is the whole reason the trigger exists: a foreign
  -- key cannot carry a predicate on the referenced row, so with the trigger
  -- disabled a *suspended* same-organization member is accepted. If this ever
  -- starts failing, the trigger has become redundant and one of the two should
  -- go.
  update public.memberships set status = 'suspended'
   where organization_id = f.ushg_id and user_id = f.ushg_approver;
  update public.locations set manager_user_id = f.ushg_approver where id = f.ushg_location;
  perform pg_temp.check(
    (select manager_user_id = f.ushg_approver from public.locations where id = f.ushg_location),
    'T-8c the foreign key alone accepts a suspended member — which is why the trigger exists');
  update public.locations set manager_user_id = null where id = f.ushg_location;
  update public.memberships set status = 'active'
   where organization_id = f.ushg_id and user_id = f.ushg_approver;

  alter table public.locations enable trigger locations_manager_is_active_member;

  -- T-9a: an existing member whose membership is suspended. The composite FK
  -- cannot see status, so this is the trigger's job — and it is exercised
  -- through `authenticated` under set role, *after* 20260814000200 revoked
  -- EXECUTE on the trigger function from every role. PostgreSQL checks that
  -- privilege at CREATE TRIGGER time rather than at fire time; this assertion
  -- is what proves it rather than trusting the documentation.
  suspended_user := f.ushg_approver;
  update public.memberships set status = 'suspended'
   where organization_id = f.ushg_id and user_id = suspended_user;

  perform pg_temp.become(f.ushg_admin);
  refused := false;
  begin
    update public.locations set manager_user_id = suspended_user where id = f.ushg_location;
  exception when check_violation then refused := true;
  end;
  perform pg_temp.check(refused, 'T-9a assigning a suspended member is refused by the trigger (23514), as authenticated, after the revoke');
  perform pg_temp.unbecome();

  update public.memberships set status = 'active'
   where organization_id = f.ushg_id and user_id = suspended_user;

  -- T-9: an assignment made while active survives the manager's suspension,
  -- and an unrelated edit afterwards does not re-validate it.
  update public.locations set manager_user_id = suspended_user where id = f.ushg_location;
  update public.memberships set status = 'suspended'
   where organization_id = f.ushg_id and user_id = suspended_user;

  select manager_user_id into surviving from public.locations where id = f.ushg_location;
  perform pg_temp.check(surviving = suspended_user, 'T-9 an existing assignment survives suspension');

  update public.locations set city = city where id = f.ushg_location;
  select manager_user_id into surviving from public.locations where id = f.ushg_location;
  perform pg_temp.check(surviving = suspended_user, 'T-9 an unrelated edit does not re-validate a suspended manager');

  -- T-10: deleting the membership nulls only manager_user_id. Without the
  -- column list on the referential action this raises 23502 instead, because
  -- organization_id is NOT NULL.
  update public.memberships set status = 'active'
   where organization_id = f.ushg_id and user_id = suspended_user;
  delete from public.memberships
   where organization_id = f.ushg_id and user_id = suspended_user;

  select manager_user_id, organization_id into surviving, surviving_org
  from public.locations where id = f.ushg_location;
  perform pg_temp.check(surviving is null,          'T-10 membership deletion nulls manager_user_id');
  perform pg_temp.check(surviving_org = f.ushg_id,  'T-10 membership deletion leaves organization_id intact');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant references
--
-- T-11, T-12, T-22.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  refused boolean;
  probe_profile uuid;
  probe_mention uuid;
begin
  select * into f from tenancy_fixtures;

  -- T-11: a USHG profile pointing at a Harbor location.
  refused := false;
  begin
    update public.platform_profiles
       set location_id = f.harbor_location
     where organization_id = f.ushg_id
       and id = (select id from public.platform_profiles where organization_id = f.ushg_id limit 1);
  exception when foreign_key_violation then refused := true;
  end;
  perform pg_temp.check(refused, 'T-11 platform_profiles cannot reference another organization''s location');

  -- T-12: same for a monitoring query.
  refused := false;
  begin
    update public.monitoring_queries
       set location_id = f.harbor_location
     where organization_id = f.ushg_id
       and id = (select id from public.monitoring_queries where organization_id = f.ushg_id limit 1);
  exception when foreign_key_violation then refused := true;
  end;
  perform pg_temp.check(refused, 'T-12 monitoring_queries cannot reference another organization''s location');

  -- T-22: a USHG mention pointing at a Harbor profile.
  select id into probe_profile from public.platform_profiles where organization_id = f.harbor_id limit 1;
  select id into probe_mention from public.mentions where organization_id = f.ushg_id limit 1;
  perform pg_temp.check(probe_profile is not null and probe_mention is not null,
    'fixture: a harbor profile and a ushg mention exist');

  refused := false;
  begin
    update public.mentions set platform_profile_id = probe_profile where id = probe_mention;
  exception when foreign_key_violation then refused := true;
  end;
  perform pg_temp.check(refused, 'T-22 mentions cannot reference another organization''s platform profile');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Location deletion nulls references without touching organization_id
--
-- T-20. The proof that every column-specific SET NULL is column-specific.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  doomed uuid;
  profile_id uuid;
  query_id uuid;
  mention_id uuid;
  remaining_org uuid;
begin
  select * into f from tenancy_fixtures;

  insert into public.locations (
    organization_id, name, slug, address_line1, city, region, postal_code,
    country_code, timezone
  ) values (f.ushg_id, 'Doomed', 't20-doomed', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC')
  returning id into doomed;

  update public.platform_profiles set location_id = doomed
   where organization_id = f.ushg_id
     and id = (select id from public.platform_profiles where organization_id = f.ushg_id limit 1)
  returning id into profile_id;

  update public.monitoring_queries set location_id = doomed
   where organization_id = f.ushg_id
     and id = (select id from public.monitoring_queries where organization_id = f.ushg_id limit 1)
  returning id into query_id;

  update public.mentions set platform_profile_id = profile_id
   where organization_id = f.ushg_id
     and id = (select id from public.mentions where organization_id = f.ushg_id limit 1)
  returning id into mention_id;

  delete from public.locations where id = doomed;

  perform pg_temp.check(
    (select location_id is null and organization_id = f.ushg_id
       from public.platform_profiles where id = profile_id),
    'T-20 deleting a location nulls platform_profiles.location_id and keeps organization_id'
  );
  perform pg_temp.check(
    (select location_id is null and organization_id = f.ushg_id
       from public.monitoring_queries where id = query_id),
    'T-20 deleting a location nulls monitoring_queries.location_id and keeps organization_id'
  );

  -- And the profile chain: deleting the profile nulls the mention's reference
  -- rather than raising on the mention's NOT NULL organization_id.
  delete from public.platform_profiles where id = profile_id;
  perform pg_temp.check(
    (select platform_profile_id is null and organization_id = f.ushg_id
       from public.mentions where id = mention_id),
    'T-20 deleting a profile nulls mentions.platform_profile_id and keeps organization_id'
  );
end $$;

-- ---------------------------------------------------------------------------
-- 6. Slugs
--
-- T-13.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  refused boolean;
begin
  select * into f from tenancy_fixtures;

  insert into public.locations (
    organization_id, name, slug, address_line1, city, region, postal_code,
    country_code, timezone
  ) values (f.ushg_id, 'Shared', 't13-shared', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC');

  insert into public.locations (
    organization_id, name, slug, address_line1, city, region, postal_code,
    country_code, timezone
  ) values (f.harbor_id, 'Shared', 't13-shared', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC');

  perform pg_temp.check(true, 'T-13 the same slug is accepted in two organizations');

  refused := false;
  begin
    insert into public.locations (
      organization_id, name, slug, address_line1, city, region, postal_code,
      country_code, timezone
    ) values (f.ushg_id, 'Shared again', 't13-shared', '1 A St', 'NY', 'NY', '10001', 'US', 'UTC');
  exception when unique_violation then refused := true;
  end;
  perform pg_temp.check(refused, 'T-13 the same slug twice in one organization is refused (23505)');

  delete from public.locations where slug = 't13-shared';
end $$;

-- ---------------------------------------------------------------------------
-- 7. Inactivation retains history
--
-- T-17.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  before_counts integer[];
  after_counts integer[];
begin
  select * into f from tenancy_fixtures;

  select array[
    (select count(*)::integer from public.mentions           where location_id = f.ushg_location),
    (select count(*)::integer from public.platform_profiles  where location_id = f.ushg_location),
    (select count(*)::integer from public.monitoring_queries where location_id = f.ushg_location),
    (select count(*)::integer from public.audit_events       where organization_id = f.ushg_id)
  ] into before_counts;

  update public.locations set status = 'inactive' where id = f.ushg_location;

  select array[
    (select count(*)::integer from public.mentions           where location_id = f.ushg_location),
    (select count(*)::integer from public.platform_profiles  where location_id = f.ushg_location),
    (select count(*)::integer from public.monitoring_queries where location_id = f.ushg_location),
    (select count(*)::integer from public.audit_events       where organization_id = f.ushg_id)
  ] into after_counts;

  perform pg_temp.check(before_counts = after_counts,
    'T-17 inactivating a location changes no mention, profile, query, or audit row');

  update public.locations set status = 'active' where id = f.ushg_location;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Provisioning
--
-- T-14, T-15, T-16, T-24b, T-28.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  key uuid := gen_random_uuid();
  first_id uuid;
  second_id uuid;
  four_arg_id uuid;
  refused boolean;
  audit_row public.audit_events;
begin
  select * into f from tenancy_fixtures;

  -- Acting as an existing owner of another organization, which is the case
  -- this whole workflow exists to support: creating an organization while
  -- already belonging to others.
  perform pg_temp.become(f.ushg_owner);

  -- T-14: same key twice.
  first_id  := public.provision_organization('Bond Hospitality', 'Restaurant group', 'UTC', 'en-US', key, 'in_app');
  second_id := public.provision_organization('Bond Hospitality', 'Restaurant group', 'UTC', 'en-US', key, 'in_app');

  perform pg_temp.check(first_id = second_id, 'T-14 a replayed request key returns the same organization');
  perform pg_temp.check(
    (select count(*) from public.organizations where provision_request_key = key) = 1,
    'T-14 a replayed request key creates exactly one organization');
  perform pg_temp.check(
    (select count(*) from public.memberships where organization_id = first_id and role = 'owner') = 1,
    'T-14 a replayed request key creates exactly one owner membership');
  perform pg_temp.check(
    (select count(*) from public.organization_onboarding where organization_id = first_id) = 1,
    'T-14 a replayed request key creates exactly one onboarding row');
  perform pg_temp.check(
    (select count(*) from public.audit_events
      where entity_id = first_id and event_type = 'organization.created') = 1,
    'T-14 a replayed request key writes exactly one organization.created event');

  -- T-15: the audit row is complete and tenant-visible.
  select * into audit_row from public.audit_events
   where entity_id = first_id and event_type = 'organization.created';

  perform pg_temp.check(audit_row.organization_id = first_id,       'T-15 organization.created carries its own organization_id');
  perform pg_temp.check(audit_row.actor_user_id = f.ushg_owner,     'T-15 organization.created records the acting user');
  perform pg_temp.check(audit_row.actor_type = 'user',              'T-15 organization.created is a user event');
  perform pg_temp.check(audit_row.entity_type = 'organization',     'T-15 organization.created names the right entity type');
  perform pg_temp.check(audit_row.metadata ->> 'source' = 'in_app', 'T-15 organization.created records the entry point');
  perform pg_temp.check(audit_row.previous_state is null,           'T-15 organization.created has no previous state');

  -- T-16: the caller now owns two organizations and neither leaks into the other.
  perform pg_temp.check(
    (select count(*) from public.memberships
      where user_id = f.ushg_owner and status = 'active' and role = 'owner') >= 2,
    'T-16 one user holds owner memberships in two organizations');
  perform pg_temp.check(public.is_organization_member(first_id),  'T-16 the new organization is visible to its owner');
  perform pg_temp.check(public.is_organization_member(f.ushg_id), 'T-16 the original organization is still visible');
  perform pg_temp.check(
    (select count(*) from public.locations where organization_id = first_id) = 0,
    'T-16 the new organization starts with no locations of its own');

  -- T-28: the four-argument call still resolves. This is the R1 compatibility
  -- gate expressed as SQL — the deployed application calls it this way, and if
  -- the drop-and-recreate broke it, R1 breaks production before R2 can fix it.
  four_arg_id := public.provision_organization('Four Arg Compatibility');
  perform pg_temp.check(four_arg_id is not null, 'T-28 the four-argument signature still resolves through defaults');
  perform pg_temp.check(
    (select provision_request_key is null from public.organizations where id = four_arg_id),
    'T-28 a four-argument call stores no request key');
  perform pg_temp.check(
    (select count(*) from public.audit_events
      where entity_id = four_arg_id and event_type = 'organization.created'
        and metadata ->> 'source' = 'self_serve') = 1,
    'T-28 a four-argument call records the default source');

  -- T-24b: an unknown source is refused and writes nothing.
  refused := false;
  begin
    perform public.provision_organization('Bad Source', 'Restaurant group', 'UTC', 'en-US', gen_random_uuid(), 'smuggled');
  exception when others then refused := (sqlstate = '22023');
  end;
  perform pg_temp.check(refused, 'T-24b an unrecognised provisioning source is refused (22023)');
  perform pg_temp.check(
    (select count(*) from public.organizations where name = 'Bad Source') = 0,
    'T-24b a refused source writes no organization');

  perform pg_temp.unbecome();
end $$;

-- ---------------------------------------------------------------------------
-- 9. create_and_map_location
--
-- T-19, T-19b, T-19c, T-19d, T-23, T-24, T-25, T-27.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  mapped record;
  first_location uuid;
  second_location uuid;
  refused boolean;
  code text;
  unknown_code text;
  foreign_code text;
  before_locations integer;
  before_audits integer;
  external_id text := 't19-external-' || gen_random_uuid()::text;
  payload jsonb;
begin
  select * into f from tenancy_fixtures;
  perform pg_temp.check(f.ushg_connection is not null, 'fixture: a ushg platform connection exists');

  payload := jsonb_build_array(jsonb_build_object(
    'externalProfileId',   external_id,
    'externalProfileName', 'T19 Listing',
    'profileUrl',          'https://example.com/t19',
    'externalAccountId',   'accounts/t19',
    'verificationState',   'VERIFIED',
    'providerMetadata',    jsonb_build_object('probe', true)
  ));

  -- T-19: a communications lead maps successfully, and the profile is bound.
  perform pg_temp.become(f.ushg_comms_lead);
  select * into mapped from public.create_and_map_location(
    f.ushg_connection, payload,
    'T19 Restaurant', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York'
  ) limit 1;
  first_location := mapped.location_id;

  perform pg_temp.check(first_location is not null, 'T-19 a communications lead can create and map a location');
  perform pg_temp.check(mapped.replayed = false,    'T-19 the first call is not a replay');
  perform pg_temp.check(
    (select status = 'setup' and manager_user_id is null and organization_id = f.ushg_id
       from public.locations where id = first_location),
    'T-19 the created location is setup, unmanaged, and in the connection''s organization');
  perform pg_temp.check(
    (select location_id = first_location
       from public.platform_profiles where id = mapped.profile_id),
    'T-19 the profile is bound to the created location');

  -- T-23: three audit events, all carrying organization_id.
  perform pg_temp.check(
    (select count(*) from public.audit_events
      where entity_id = first_location
        and event_type = 'location.created_from_integration'
        and organization_id = f.ushg_id) = 1,
    'T-23 one location.created_from_integration event, with organization_id');
  perform pg_temp.check(
    (select count(*) from public.audit_events
      where entity_id = mapped.profile_id
        and event_type = 'integration.profile_connected'
        and organization_id = f.ushg_id) = 1,
    'T-23 one integration.profile_connected event, with organization_id');
  perform pg_temp.check(
    (select count(*) from public.audit_events
      where entity_id = mapped.profile_id
        and event_type = 'integration.profile_mapped'
        and organization_id = f.ushg_id) = 1,
    'T-23 one integration.profile_mapped event, with organization_id');

  -- T-19c: replay returns the same location and writes nothing.
  select * into mapped from public.create_and_map_location(
    f.ushg_connection, payload,
    'T19 Restaurant', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York'
  ) limit 1;
  second_location := mapped.location_id;

  perform pg_temp.check(second_location = first_location, 'T-19c a replay returns the location the first call created');
  perform pg_temp.check(mapped.replayed = true,           'T-19c a replay reports itself as one');
  perform pg_temp.check(
    (select count(*) from public.audit_events
      where entity_id = first_location and event_type = 'location.created_from_integration') = 1,
    'T-19c a replay writes no second location.created_from_integration event');
  perform pg_temp.check(
    (select count(*) from public.locations
      where organization_id = f.ushg_id and name = 'T19 Restaurant') = 1,
    'T-19c a replay creates no second location');

  -- T-19b: an empty profile set creates nothing.
  select count(*) into before_locations from public.locations where organization_id = f.ushg_id;
  refused := false;
  begin
    perform public.create_and_map_location(
      f.ushg_connection, '[]'::jsonb,
      'T19b Nothing', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');
  exception when others then refused := (sqlstate = '22023');
  end;
  perform pg_temp.check(refused, 'T-19b an empty profile set is refused (22023)');
  perform pg_temp.check(
    (select count(*) from public.locations where organization_id = f.ushg_id) = before_locations,
    'T-19b a refused empty set creates no location');

  -- T-19d: a profile already bound elsewhere is a deterministic conflict.
  refused := false;
  begin
    perform public.create_and_map_location(
      f.ushg_connection,
      payload || jsonb_build_array(jsonb_build_object(
        'externalProfileId',   't19d-second-' || gen_random_uuid()::text,
        'externalProfileName', 'T19d Second',
        'profileUrl',          null,
        'externalAccountId',   'accounts/t19',
        'verificationState',   null,
        'providerMetadata',    '{}'::jsonb)),
      'T19d Mixed', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');
  exception when others then refused := (sqlstate = '23505');
  end;
  perform pg_temp.check(refused, 'T-19d a half-bound profile set is a deterministic conflict (23505)');

  -- T-24: no orphan location survives a failure after the location insert. An
  -- invalid timezone is rejected by the locations insert itself, so the probe
  -- uses an invalid country code, which fails the table's own CHECK after the
  -- function has already derived a slug and started writing.
  select count(*) into before_locations from public.locations where organization_id = f.ushg_id;
  select count(*) into before_audits    from public.audit_events where organization_id = f.ushg_id;
  refused := false;
  begin
    perform public.create_and_map_location(
      f.ushg_connection,
      jsonb_build_array(jsonb_build_object(
        'externalProfileId',   't24-' || gen_random_uuid()::text,
        'externalProfileName', 'T24 Listing',
        'profileUrl',          null,
        'externalAccountId',   'accounts/t24',
        'verificationState',   null,
        'providerMetadata',    '{}'::jsonb)),
      'T24 Orphan', '1 A St', null, 'New York', 'NY', '10001', 'usa', 'America/New_York');
  exception when others then refused := true;
  end;
  perform pg_temp.check(refused, 'T-24 an invalid location is refused');
  perform pg_temp.check(
    (select count(*) from public.locations where organization_id = f.ushg_id) = before_locations,
    'T-24 a failed create-and-map leaves no orphan location');
  perform pg_temp.check(
    (select count(*) from public.audit_events where organization_id = f.ushg_id) = before_audits,
    'T-24 a failed create-and-map writes no audit event');

  perform pg_temp.unbecome();

  -- T-25: an analyst is refused, and a foreign connection is refused
  -- indistinguishably from an invented one.
  perform pg_temp.become(f.ushg_analyst);
  code := null;
  begin
    perform public.create_and_map_location(
      f.ushg_connection, payload,
      'T25 Analyst', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');
  exception when others then code := sqlstate;
  end;
  perform pg_temp.check(code = '42501', 'T-25 an analyst cannot create and map a location');
  perform pg_temp.unbecome();

  perform pg_temp.become(f.ushg_comms_lead);
  foreign_code := null;
  begin
    perform public.create_and_map_location(
      f.harbor_connection, payload,
      'T25 Foreign', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');
  exception when others then foreign_code := sqlstate || '|' || sqlerrm;
  end;

  unknown_code := null;
  begin
    perform public.create_and_map_location(
      gen_random_uuid(), payload,
      'T25 Unknown', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');
  exception when others then unknown_code := sqlstate || '|' || sqlerrm;
  end;

  perform pg_temp.check(foreign_code is not null and foreign_code = unknown_code,
    'T-25 a foreign connection is indistinguishable from an invented one');
  perform pg_temp.check(split_part(foreign_code, '|', 1) = '42501',
    'T-25 both refusals are 42501');
  perform pg_temp.unbecome();
end $$;

-- ---------------------------------------------------------------------------
-- 10. Cross-organization profile isolation
--
-- T-27. The same external profile id existing under another organization's
-- connection is a different row this call can neither read nor touch.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  shared_external text := 't27-shared-' || gen_random_uuid()::text;
  harbor_profile uuid;
  harbor_before jsonb;
  harbor_after jsonb;
  mapped record;
  refused boolean;
  payload jsonb;
begin
  select * into f from tenancy_fixtures;

  payload := jsonb_build_array(jsonb_build_object(
    'externalProfileId',   shared_external,
    'externalProfileName', 'T27 Listing',
    'profileUrl',          null,
    'externalAccountId',   'accounts/t27',
    'verificationState',   null,
    'providerMetadata',    '{}'::jsonb
  ));

  -- Harbor already has a profile carrying this external id, under its own
  -- connection.
  insert into public.platform_profiles (
    organization_id, platform_connection_id, external_profile_id,
    external_profile_name, status
  ) values (f.harbor_id, f.harbor_connection, shared_external, 'Harbor Listing', 'active')
  returning id into harbor_profile;

  select to_jsonb(p) into harbor_before from public.platform_profiles p where p.id = harbor_profile;

  perform pg_temp.become(f.ushg_comms_lead);
  select * into mapped from public.create_and_map_location(
    f.ushg_connection, payload,
    'T27 Restaurant', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York'
  ) limit 1;
  perform pg_temp.unbecome();

  perform pg_temp.check(mapped.profile_id <> harbor_profile,
    'T-27 the same external id under another connection resolves to a different row');
  perform pg_temp.check(
    (select organization_id = f.ushg_id from public.platform_profiles where id = mapped.profile_id),
    'T-27 the row this call touched belongs to the calling organization');

  select to_jsonb(p) into harbor_after from public.platform_profiles p where p.id = harbor_profile;
  perform pg_temp.check(harbor_before = harbor_after,
    'T-27 the other organization''s profile is byte-identical afterwards');

  -- The function's explicit organization check is defence in depth: with the
  -- tenant derived from a single connection and the natural key scoped to that
  -- connection, a mixed-organization set is not reachable through any ordinary
  -- call. Proving the check works therefore means manufacturing a row the
  -- schema would not otherwise produce.
  --
  -- Note what has to be worked around to do it. The obvious corruption —
  -- restamping the bound profile's organization_id — is itself refused, by
  -- platform_profiles_location_same_org, because the row carries a location:
  declare
    blocked boolean := false;
  begin
    begin
      update public.platform_profiles set organization_id = f.harbor_id where id = mapped.profile_id;
    exception when foreign_key_violation then blocked := true;
    end;
    perform pg_temp.check(blocked,
      'T-27 a bound profile cannot be restamped into another organization (the composite FK refuses it)');
  end;

  -- So the corrupt row has to be an *unbound* one: same connection, wrong
  -- organization, no location. That is the only shape the schema still admits,
  -- and it is exactly what the function's check exists to catch.
  declare
    corrupt_external text := 't27-corrupt-' || gen_random_uuid()::text;
  begin
    insert into public.platform_profiles (
      organization_id, platform_connection_id, external_profile_id,
      external_profile_name, status
    ) values (f.harbor_id, f.ushg_connection, corrupt_external, 'T27 Corrupt', 'pending');

    perform pg_temp.become(f.ushg_comms_lead);
    refused := false;
    begin
      perform public.create_and_map_location(
        f.ushg_connection,
        jsonb_build_array(jsonb_build_object(
          'externalProfileId',   corrupt_external,
          'externalProfileName', 'T27 Corrupt',
          'profileUrl',          null,
          'externalAccountId',   'accounts/t27',
          'verificationState',   null,
          'providerMetadata',    '{}'::jsonb)),
        'T27 Corrupt', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');
    exception when others then refused := (sqlstate = '42501');
    end;
    perform pg_temp.check(refused,
      'T-27 a corrupt cross-organization profile row is refused by the function''s own check (42501)');
    perform pg_temp.unbecome();
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Function privileges, read from the catalog
--
-- T-21. Never by attempting the denied call: the local Postgres image
-- segfaults the whole cluster on an EXECUTE-denied call of a non-immutable
-- function after `set role`, which would take this harness down mid-run.
-- ---------------------------------------------------------------------------

do $$
declare
  provision_sig text := 'public.provision_organization(text, text, text, text, uuid, text)';
  mapping_sig   text := 'public.create_and_map_location(uuid, jsonb, text, text, text, text, text, text, text, text)';
  trigger_sig   text := 'public.assert_location_manager_is_active_member()';
begin
  perform pg_temp.check(not has_function_privilege('anon',         provision_sig, 'execute'), 'T-21 anon cannot execute provision_organization');
  perform pg_temp.check(not has_function_privilege('service_role', provision_sig, 'execute'), 'T-21 service_role cannot execute provision_organization');
  perform pg_temp.check(    has_function_privilege('authenticated', provision_sig, 'execute'), 'T-21 authenticated can execute provision_organization');

  perform pg_temp.check(not has_function_privilege('anon',         mapping_sig, 'execute'), 'T-21 anon cannot execute create_and_map_location');
  perform pg_temp.check(not has_function_privilege('service_role', mapping_sig, 'execute'), 'T-21 service_role cannot execute create_and_map_location');
  perform pg_temp.check(    has_function_privilege('authenticated', mapping_sig, 'execute'), 'T-21 authenticated can execute create_and_map_location');

  perform pg_temp.check(not has_function_privilege('anon',          trigger_sig, 'execute'), 'T-21 anon cannot execute the manager trigger function');
  perform pg_temp.check(not has_function_privilege('authenticated', trigger_sig, 'execute'), 'T-21 authenticated cannot execute the manager trigger function');
  perform pg_temp.check(not has_function_privilege('service_role',  trigger_sig, 'execute'), 'T-21 service_role cannot execute the manager trigger function');

  -- The four-argument function must be gone, not merely shadowed. An overload
  -- surviving here would mean PostgREST could still reach the old body.
  perform pg_temp.check(
    (select count(*) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'provision_organization') = 1,
    'T-21 exactly one provision_organization exists (no surviving overload)'
  );
end $$;

-- ---------------------------------------------------------------------------
-- 12. The guard itself
--
-- T-29. A conditional harness whose condition never resolves is
-- indistinguishable from a clean run, which is the one thing it must not be.
-- ---------------------------------------------------------------------------

do $$
begin
  if pg_temp.contracted() then
    perform pg_temp.check(
      exists (select 1 from tenancy_guard_log where section = 'section-1'),
      'T-29 the post-contraction section ran on a contracted database');
    perform pg_temp.check(
      not exists (select 1 from tenancy_guard_log where section = 'section-2'),
      'T-29 the pre-contraction section was skipped on a contracted database');
  else
    perform pg_temp.check(
      exists (select 1 from tenancy_guard_log where section = 'section-2'),
      'T-29 the pre-contraction section ran on an expanded-only database');
    perform pg_temp.check(
      not exists (select 1 from tenancy_guard_log where section = 'section-1'),
      'T-29 the post-contraction section was skipped on an expanded-only database');
    raise notice 'NOTE: 20260814000500 is not applied — section 1 (narrowed location write authority) was not exercised.';
  end if;
end $$;

rollback;
