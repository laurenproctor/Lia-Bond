-- ---------------------------------------------------------------------------
-- Same-organization invariants for everything that references a location
--
-- Release R1 (expansion). Compatible with the application deployed before it:
-- the constraints below reject only cross-tenant writes, which no code path
-- performs and which `scripts/tenancy-preflight.ts` confirmed do not exist in
-- the hosted data. The trigger fires only when a manager is *assigned*, and
-- every existing write path either writes null or already validates active
-- membership in application code.
--
-- 20260811000100 hardened `mentions.location_id` and stopped there, because
-- that was what automation execution needed. Three more columns have the same
-- hole and one has a worse one:
--
--   platform_profiles.location_id   -> locations (id)          plain FK
--   monitoring_queries.location_id  -> locations (id)          plain FK
--   mentions.platform_profile_id    -> platform_profiles (id)  plain FK
--   locations.manager_user_id       -> users (id)              no tenant at all
--
-- Each one lets a row in organization A point at a row in organization B, held
-- today only by application scoping. That was tolerable while belonging to two
-- organizations was an edge case the product could not even produce. It stops
-- being tolerable in the same change that makes multi-organization membership
-- ordinary: a request now routinely carries organization A's scope while the
-- caller legitimately holds ids from organization B.
--
-- The remaining cross-table foreign keys are inventoried rather than closed
-- here — see SEC-1 in docs/architecture/current-state.md. They are `not null`
-- columns on ingest and approval paths with their own test surfaces, which is
-- why they are a separate pass and not a wider version of this one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Server version
--
-- The referential actions below name the column to null out. Without that list
-- `on delete set null` nulls *every* referencing column, including
-- `organization_id`, which is NOT NULL on all four tables — so deleting a
-- membership or a location would raise 23502 instead of clearing the optional
-- reference. The column list is a PostgreSQL 15 feature.
--
-- Asserted rather than assumed, because this is the failure that shows up
-- mid-`db push` against a database somebody is using, long after it parsed
-- cleanly on a laptop.
-- ---------------------------------------------------------------------------

do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception
      'This migration needs PostgreSQL 15 or later for column-specific ON DELETE SET NULL (found %)',
      current_setting('server_version')
      using errcode = '0A000';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Pre-flight
--
-- Four counts, each raising with the number found. A violation here is a live
-- cross-tenant defect to investigate — never data to grandfather, and never
-- data to rewrite into compliance, because a row pointing at another tenant's
-- record is evidence of something and deleting the evidence answers nothing.
--
-- Same posture and wording as 20260811000100's own pre-flight.
-- ---------------------------------------------------------------------------

do $$
declare violating integer;
begin
  select count(*) into violating
  from public.platform_profiles p
  join public.locations l on l.id = p.location_id
  where p.location_id is not null
    and l.organization_id <> p.organization_id;
  if violating > 0 then
    raise exception
      'platform_profiles_location_same_org pre-flight: % cross-organization profile locations exist',
      violating;
  end if;
end $$;

do $$
declare violating integer;
begin
  select count(*) into violating
  from public.monitoring_queries q
  join public.locations l on l.id = q.location_id
  where q.location_id is not null
    and l.organization_id <> q.organization_id;
  if violating > 0 then
    raise exception
      'monitoring_queries_location_same_org pre-flight: % cross-organization query locations exist',
      violating;
  end if;
end $$;

do $$
declare violating integer;
begin
  select count(*) into violating
  from public.mentions m
  join public.platform_profiles p on p.id = m.platform_profile_id
  where m.platform_profile_id is not null
    and p.organization_id <> m.organization_id;
  if violating > 0 then
    raise exception
      'mentions_platform_profile_same_org pre-flight: % cross-organization mention profiles exist',
      violating;
  end if;
end $$;

-- The manager check is not a plain reference test: the target is a membership
-- *pair*, and a manager who holds no membership at all in the organization is
-- exactly as much of a violation as one who holds a membership elsewhere.
--
-- Deliberately not filtered on `status = 'active'`. A suspended manager is a
-- state this design keeps (see the trigger below), so counting it here would
-- block the migration on data it is not trying to change.
do $$
declare violating integer;
begin
  select count(*) into violating
  from public.locations l
  where l.manager_user_id is not null
    and not exists (
      select 1
      from public.memberships m
      where m.organization_id = l.organization_id
        and m.user_id = l.manager_user_id
    );
  if violating > 0 then
    raise exception
      'locations_manager_same_org pre-flight: % locations have a manager with no membership in their organization',
      violating;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Unique target for the profile reference
--
-- `locations_id_org` already exists (20260811000100) and
-- `memberships_unique_user_per_org (organization_id, user_id)` has existed
-- since the initial schema. Only `platform_profiles` needs a new one.
--
-- Note what is deliberately *not* added: a reversed
-- `memberships (user_id, organization_id)` unique. The manager foreign key
-- below uses the existing column order instead, so the reversed index would be
-- a second index nothing queries — a write cost with no reader.
-- ---------------------------------------------------------------------------

alter table public.platform_profiles
  add constraint platform_profiles_id_org unique (id, organization_id);

-- ---------------------------------------------------------------------------
-- Composite foreign keys
--
-- Each names the column to null out. See the server-version note above for why
-- the bare form would be wrong on all four.
-- ---------------------------------------------------------------------------

alter table public.locations
  add constraint locations_manager_same_org
    foreign key (organization_id, manager_user_id)
    references public.memberships (organization_id, user_id)
    on delete set null (manager_user_id);
-- No ON UPDATE clause, deliberately. `on update cascade` here would propagate a
-- change to `memberships.organization_id` into `locations.organization_id` —
-- moving a restaurant between tenants as a side effect of a membership edit,
-- which is the single worst thing this constraint could be made to do. Neither
-- referenced column is ever updated, so NO ACTION costs nothing.

alter table public.platform_profiles
  add constraint platform_profiles_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
    on delete set null (location_id);

alter table public.monitoring_queries
  add constraint monitoring_queries_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
    on delete set null (location_id);

alter table public.mentions
  add constraint mentions_platform_profile_same_org
    foreign key (platform_profile_id, organization_id)
    references public.platform_profiles (id, organization_id)
    on delete set null (platform_profile_id);

-- ---------------------------------------------------------------------------
-- Drop the superseded simple foreign keys
--
-- Not optional. Leaving both means the composite carries the tenant invariant
-- while the simple one carries the delete action — which is precisely the
-- arrangement `mentions.location_id` is in today, and precisely why nobody
-- noticed that its composite has no ON DELETE clause at all. That pair is
-- correct as it stands and is deliberately left alone here; it is not a
-- pattern to reproduce three more times.
--
-- Names are resolved from the catalog rather than hard-coded: these were
-- created inline with the column, so their names are PostgreSQL's own
-- construction and are not guaranteed identical across environments.
-- ---------------------------------------------------------------------------

do $$
declare
  target record;
begin
  for target in
    select c.conrelid::regclass as table_name, c.conname
    from pg_constraint c
    where c.contype = 'f'
      and c.connamespace = 'public'::regnamespace
      and c.conrelid in (
        'public.locations'::regclass,
        'public.platform_profiles'::regclass,
        'public.monitoring_queries'::regclass,
        'public.mentions'::regclass
      )
      -- Single-column keys only, so the composites just created are never
      -- candidates for removal.
      and cardinality(c.conkey) = 1
      and (
        (c.conrelid = 'public.locations'::regclass
          and c.confrelid = 'public.users'::regclass
          and c.conkey = array[
            (select attnum from pg_attribute
              where attrelid = 'public.locations'::regclass and attname = 'manager_user_id')
          ]::smallint[])
        or (c.conrelid = 'public.platform_profiles'::regclass
          and c.confrelid = 'public.locations'::regclass)
        or (c.conrelid = 'public.monitoring_queries'::regclass
          and c.confrelid = 'public.locations'::regclass)
        or (c.conrelid = 'public.mentions'::regclass
          and c.confrelid = 'public.platform_profiles'::regclass)
      )
  loop
    execute format('alter table %s drop constraint %I', target.table_name, target.conname);
    raise notice 'dropped superseded foreign key %.%', target.table_name, target.conname;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Active membership, enforced on assignment
--
-- The composite foreign key above proves the manager belongs to the
-- organization. It cannot prove the membership is *active*, because a foreign
-- key cannot carry a predicate on the referenced row — and "active member of
-- the same organization" is the rule the application has enforced all along in
-- `assertActiveMember`, on the two paths that remember to call it.
--
-- The two early returns are the design, not defensive padding:
--
--   * A null manager is always allowed. This is also what lets the foreign
--     key's `set null (manager_user_id)` through when a membership is deleted —
--     without it, removing somebody would fire this trigger and fail.
--
--   * On UPDATE, an unchanged manager is always allowed. `update of <columns>`
--     fires whenever a column appears in the SET list, even when the value is
--     identical, so editing a location's address would otherwise re-validate a
--     manager who was legitimate when assigned. More importantly this is what
--     makes suspension *keep* the assignment: suspension writes to
--     `memberships`, never to `locations`, so this trigger does not fire for it
--     at all, and nothing later re-checks it. A manager on leave keeps their
--     restaurants; RLS already ignores their membership, so they can reach
--     nothing in the meantime.
--
-- What is refused is a *new* assignment to somebody suspended, which is the
-- one case where the application rule and the database disagreed.
-- ---------------------------------------------------------------------------

create or replace function public.assert_location_manager_is_active_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.manager_user_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.manager_user_id is not distinct from old.manager_user_id
     and new.organization_id is not distinct from old.organization_id then
    return new;
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.organization_id = new.organization_id
      and m.user_id = new.manager_user_id
      and m.status = 'active'
  ) then
    raise exception
      'A location manager must hold an active membership in the same organization'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.assert_location_manager_is_active_member is
  'Refuses a location manager who is not an active member of the same organization, on assignment only. Never fires for a membership suspended after the fact, which is deliberate: an existing assignment survives suspension.';

drop trigger if exists locations_manager_is_active_member on public.locations;

create trigger locations_manager_is_active_member
  before insert or update of manager_user_id, organization_id
  on public.locations
  for each row execute function public.assert_location_manager_is_active_member();

-- Privileges, for the same reason every other function in this schema gets
-- them restated: a newly created function receives EXECUTE from PUBLIC and
-- from Supabase's project-level default privileges to anon, authenticated, and
-- service_role.
--
-- PostgreSQL checks EXECUTE on a trigger function when the trigger is created,
-- not when it fires, so revoking after CREATE TRIGGER leaves the trigger
-- working for every role. That ordering is load-bearing and is why the revoke
-- is below rather than above — and it is asserted by the harness rather than
-- trusted to this comment: supabase/tests/tenancy-verification.sql exercises
-- the trigger as `authenticated` under `set role`, after this revoke has run.
revoke all on function public.assert_location_manager_is_active_member()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Column documentation
-- ---------------------------------------------------------------------------

comment on column public.locations.manager_user_id is
  'Location manager. Guaranteed by locations_manager_same_org to hold a membership in the same organization; guaranteed active only at the moment of assignment, by locations_manager_is_active_member. Nulled when the membership is deleted, never when it is suspended.';
comment on column public.platform_profiles.location_id is
  'The Lia location this external profile maps to. Guaranteed same-organization by platform_profiles_location_same_org; nulled when the location is deleted.';
comment on column public.monitoring_queries.location_id is
  'Null is organization-wide. Guaranteed same-organization by monitoring_queries_location_same_org; nulled when the location is deleted.';
comment on column public.mentions.platform_profile_id is
  'The external profile this mention arrived through. Guaranteed same-organization by mentions_platform_profile_same_org; nulled when the profile is deleted.';

-- ---------------------------------------------------------------------------
-- Rollback, for the R1 phase of the rollout
--
-- Not executed.
--
--   drop trigger if exists locations_manager_is_active_member on public.locations;
--   drop function if exists public.assert_location_manager_is_active_member();
--   alter table public.locations           drop constraint locations_manager_same_org;
--   alter table public.platform_profiles   drop constraint platform_profiles_location_same_org;
--   alter table public.monitoring_queries  drop constraint monitoring_queries_location_same_org;
--   alter table public.mentions            drop constraint mentions_platform_profile_same_org;
--   alter table public.platform_profiles   drop constraint platform_profiles_id_org;
--   -- then restore the four simple keys:
--   alter table public.locations add constraint locations_manager_user_id_fkey
--     foreign key (manager_user_id) references public.users (id) on delete set null;
--   alter table public.platform_profiles add constraint platform_profiles_location_id_fkey
--     foreign key (location_id) references public.locations (id) on delete set null;
--   alter table public.monitoring_queries add constraint monitoring_queries_location_id_fkey
--     foreign key (location_id) references public.locations (id) on delete set null;
--   alter table public.mentions add constraint mentions_platform_profile_id_fkey
--     foreign key (platform_profile_id) references public.platform_profiles (id) on delete set null;
-- ---------------------------------------------------------------------------
