-- ---------------------------------------------------------------------------
-- Provisioning: repeated use, atomic idempotency, and its own audit event
--
-- Release R1 (expansion). This migration is deliberately backward compatible
-- with the application deployed before it: the two new parameters are trailing
-- and defaulted, so every existing four-argument call resolves unchanged. That
-- is what lets the schema go out ahead of the code (D209) instead of both
-- having to land in the same instant.
--
-- Three things change, and only the first is visible to a caller.
--
-- 1. **The signature grows two trailing parameters.** `provision_organization`
--    has always supported being called more than once by the same person —
--    nothing in its body counts memberships — but nothing in the product ever
--    did, so creating a second organization by double-clicking a button
--    produced two real tenants ("Acme" and "acme-2") with no way to tell which
--    one was meant. `p_request_key` closes that; `p_source` records which entry
--    point asked.
--
-- 2. **Idempotency is the insert, not a check before it.** See the long comment
--    on the conflict arm below. A read-then-insert version of this loses
--    exactly the race it exists to solve.
--
-- 3. **The `organization.created` audit event is finally written**, here rather
--    than in the server action. It has been in `audit_events_known_event_type`
--    since workflow 05 with no emitter at all. It cannot be written by the
--    action: `insert` on `audit_events` is revoked from `authenticated`
--    (20260812000200), and `recordAuditEvent` needs an `OrganizationScope`
--    that does not exist until the organization does. Writing it here also
--    makes it atomic with the row it describes, which is the posture
--    `raise_escalation` already established.
--
-- **This is a DROP and CREATE, not a CREATE OR REPLACE.** `CREATE OR REPLACE
-- FUNCTION` cannot change a function's input signature. Adding parameters to
-- the existing definition would produce an *overload* — two functions, one
-- with the old body, and PostgREST resolving whichever matches the argument
-- names a client happens to send. The drop is what keeps there being one
-- answer to "what does provisioning do".
--
-- A DROP also discards the function's privileges, and Supabase's project
-- bootstrap re-grants EXECUTE on any newly created function to `anon`,
-- `authenticated`, and `service_role` through default privileges. So the
-- grants are restated explicitly at the bottom — and this is where a
-- pre-existing gap gets closed: 20260805000200 revoked only from `public`,
-- which never removed the `anon` grant. `provision_organization` has been
-- callable with the anon key ever since. It was safe by *body* rather than by
-- grant (`auth.uid()` is null for anon, so it raised 28000), which is not the
-- same thing as being unreachable. Same class of gap, same fix, as
-- 20260807000600 applied to the OAuth helpers.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Pre-flight: nothing may depend on the function being dropped
--
-- Checked rather than remembered. A static read of the repository says the only
-- references are 20260805000200's own revoke/grant, the Supabase adapter's
-- `client.rpc("provision_organization")` call, and prose in comments — none of
-- which is a database dependency. This block is what turns that reading into a
-- fact about the database actually being migrated.
-- ---------------------------------------------------------------------------

do $$
declare
  target_oid oid;
  dependent_count integer;
  dependent_names text;
begin
  select p.oid into target_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'provision_organization'
    and pg_get_function_identity_arguments(p.oid) = 'text, text, text, text';

  if target_oid is null then
    -- Already migrated, or a database that never had it. Either way there is
    -- nothing to drop and nothing to check.
    return;
  end if;

  -- `refobjid = target_oid` finds objects that depend on the function; the
  -- function's own dependencies on its schema and language are recorded in the
  -- other direction and are not matched here. Restricted to `deptype = 'n'`
  -- (normal) so an internal or automatic bookkeeping row cannot block the
  -- migration with a false positive.
  select count(*), string_agg(distinct d.classid::regclass::text, ', ')
    into dependent_count, dependent_names
  from pg_depend d
  where d.refobjid = target_oid
    and d.refclassid = 'pg_proc'::regclass
    and d.deptype = 'n';

  if dependent_count > 0 then
    raise exception
      'provision_organization has % dependent object(s) (%). Resolve them before this migration drops it.',
      dependent_count, dependent_names
      using errcode = '2BP01';
  end if;

  select count(*) into dependent_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid <> target_oid
    and p.prosrc ilike '%provision_organization%';

  if dependent_count > 0 then
    raise exception
      'provision_organization is referenced by % other function body/bodies. Resolve them before this migration drops it.',
      dependent_count
      using errcode = '2BP01';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The idempotency key
--
-- Partial, so the null every existing row carries does not collide. The index
-- *is* the lock — the same reasoning that made the `WHERE` clause the lock for
-- consuming an OAuth state (D12) and a partial unique index the lock for sync
-- runs (D24). An application-level "has this key been used" check would be two
-- statements with a race between them, and Lia runs on serverless functions,
-- so two clicks are routinely two processes rather than two calls in one.
-- ---------------------------------------------------------------------------

alter table public.organizations
  add column if not exists provision_request_key uuid;

comment on column public.organizations.provision_request_key is
  'Client-generated idempotency key for provision_organization. One per mounted creation form: a retry reuses it, a fresh page load gets a new one. Null for every organization created before this column existed.';

create unique index if not exists organizations_provision_request_key_unique
  on public.organizations (provision_request_key)
  where provision_request_key is not null;

-- ---------------------------------------------------------------------------
-- Capture the current owner, so the recreated function keeps it
--
-- Migrations run as `postgres` today, so this is very likely a no-op. It is
-- here because "very likely" is not the same as "by construction", and a
-- SECURITY DEFINER function silently changing owner changes whose rights it
-- runs with — which is the entire mechanism this function depends on.
--
-- Carried in a session GUC rather than a temporary table. A temp table created
-- inside a DO block is bound to whatever transaction wraps the migration, and
-- whether one wraps it differs between `supabase db push`, `db reset`, and a
-- bare `psql` run; a GUC is session-scoped and behaves the same under all
-- three. `set_config(..., false)` is session-level, and the value is read back
-- with the missing-ok form so a database that never had the function skips the
-- restore instead of failing on an unset setting.
-- ---------------------------------------------------------------------------

do $$
declare
  previous_owner text;
begin
  select pg_get_userbyid(p.proowner) into previous_owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'provision_organization'
    and pg_get_function_identity_arguments(p.oid) = 'text, text, text, text';

  perform set_config('lia.provision_owner', coalesce(previous_owner, ''), false);
end $$;

drop function if exists public.provision_organization(text, text, text, text) restrict;

-- ---------------------------------------------------------------------------
-- The canonical function
--
-- One signature. Existing four-argument callers resolve through the defaults.
-- ---------------------------------------------------------------------------

create function public.provision_organization(
  organization_name text,
  organization_industry text default 'Restaurant group',
  organization_timezone text default 'UTC',
  organization_language text default 'en-US',
  p_request_key uuid default null,
  p_source text default 'self_serve'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  trimmed_name text := nullif(trim(organization_name), '');
  base_slug text;
  candidate_slug text;
  suffix integer := 1;
  new_organization_id uuid;
begin
  if actor is null then
    raise exception 'An authenticated caller is required to create an organization'
      using errcode = '28000';
  end if;

  if trimmed_name is null then
    raise exception 'Organization name is required'
      using errcode = '22023';
  end if;

  -- Validated rather than trusted, because this value reaches
  -- `audit_events.metadata`. An audit trail whose metadata is caller-authored
  -- free text is a trail somebody can write anything into.
  if p_source is null or p_source not in ('self_serve', 'in_app') then
    raise exception 'Unknown provisioning source'
      using errcode = '22023';
  end if;

  -- Derived here rather than accepted from the caller: the slug is globally
  -- unique and appears in links, so it is not a field a signing-up stranger
  -- should be able to choose. Collisions are now *expected* rather than
  -- exceptional — somebody running three restaurant groups may well name two
  -- of them similarly — which is why the loop below is covered by a test
  -- rather than left as an untested fallback.
  base_slug := trim(both '-' from regexp_replace(lower(trimmed_name), '[^a-z0-9]+', '-', 'g'));
  if base_slug = '' then
    base_slug := 'organization';
  end if;
  base_slug := left(base_slug, 40);

  -- Unchanged, including its pre-existing race: two concurrent calls naming
  -- the same organization derive the same candidate, and one of them loses the
  -- `organizations_slug_key` unique constraint with 23505. That is not what
  -- `p_request_key` addresses — the key makes *one* submission idempotent, not
  -- two different people picking the same name in the same instant — and the
  -- loser gets a retryable error rather than a wrong row.
  candidate_slug := base_slug;
  while exists (select 1 from public.organizations o where o.slug = candidate_slug) loop
    suffix := suffix + 1;
    candidate_slug := base_slug || '-' || suffix;
    if suffix > 500 then
      raise exception 'Could not derive a unique slug for %', trimmed_name
        using errcode = '23505';
    end if;
  end loop;

  -- The insert IS the idempotency decision.
  --
  -- A replay lookup followed by an insert loses the race it exists to solve:
  -- two concurrent invocations can both miss the lookup, one wins the unique
  -- index, and the other receives 23505 instead of the id it asked for. Here
  -- the conflict arm decides it, and a null return means "somebody else
  -- created this one".
  insert into public.organizations (
    name, slug, industry, website_url, default_timezone, default_language,
    provision_request_key
  )
  values (
    trimmed_name,
    candidate_slug,
    coalesce(nullif(trim(organization_industry), ''), 'Restaurant group'),
    null,
    coalesce(nullif(trim(organization_timezone), ''), 'UTC'),
    coalesce(nullif(trim(organization_language), ''), 'en-US'),
    p_request_key
  )
  on conflict (provision_request_key) where provision_request_key is not null
  do nothing
  returning id into new_organization_id;

  if new_organization_id is null then
    -- This invocation created nothing, so it must create nothing else: no
    -- membership, no onboarding row, no audit event. Everything below this
    -- block belongs to whichever call won.
    --
    -- The lookup is scoped to the caller's own owner membership on purpose. A
    -- key is a random uuid and is not a secret worth much, but returning an
    -- organization id for a key the caller does not own would still be a
    -- disclosure, so a key belonging to somebody else is refused rather than
    -- answered — and the refusal says nothing about which organization it is.
    --
    -- Reading committed state here is safe, and the ordering is why: `on
    -- conflict do nothing` waits on the conflicting tuple's transaction before
    -- reporting zero rows, so by the time control reaches this statement the
    -- winner has either committed its membership row or rolled the whole thing
    -- back. Without that wait this lookup could find the organization and miss
    -- the membership.
    select o.id into new_organization_id
    from public.organizations o
    join public.memberships m
      on m.organization_id = o.id
     and m.user_id = actor
     and m.role = 'owner'
    where o.provision_request_key = p_request_key;

    if new_organization_id is null then
      raise exception 'That provisioning request could not be completed'
        using errcode = '42501';
    end if;

    return new_organization_id;
  end if;

  -- Owner, active, and not negotiable: the role is written here rather than
  -- passed in, so this function cannot be used to mint a membership of any
  -- other shape.
  insert into public.memberships (organization_id, user_id, role, status)
  values (new_organization_id, actor, 'owner', 'active');

  -- Step one, in progress. A new organization has, by definition, configured
  -- nothing yet — and that is as true of the third one somebody creates from
  -- inside the product as it was of the first one created at sign-up.
  insert into public.organization_onboarding (organization_id)
  values (new_organization_id);

  -- Written here, and only by the invocation that actually created the
  -- organization, so a replay produces no second row.
  --
  -- `organization_id` is not decoration: the column is NOT NULL, and it is
  -- what every RLS policy on this table resolves through, so an event written
  -- without it would both fail the constraint and be invisible to the tenant
  -- it describes. The metadata carries the entry point and nothing else —
  -- names live in `new_state`, where a reader expects them.
  insert into public.audit_events (
    organization_id, actor_type, actor_user_id,
    event_type, entity_type, entity_id,
    previous_state, new_state, metadata
  )
  values (
    new_organization_id,
    'user',
    actor,
    'organization.created',
    'organization',
    new_organization_id,
    null,
    jsonb_build_object('name', trimmed_name, 'slug', candidate_slug),
    jsonb_build_object('source', p_source)
  );

  return new_organization_id;
end;
$$;

comment on function public.provision_organization(text, text, text, text, uuid, text) is
  'Creates an organization, the calling user''s owner membership, its onboarding row, and its organization.created audit event, atomically. The user is taken from auth.uid(), never from an argument. Repeated use is supported and expected: a caller who already belongs to other organizations may create another and becomes its owner. Supplying p_request_key makes the call idempotent — a replay returns the organization the first call created and writes nothing.';

-- Restore the captured owner, if this database had a different one.
do $$
declare
  previous_owner text := nullif(current_setting('lia.provision_owner', true), '');
begin
  if previous_owner is not null and previous_owner <> current_user then
    execute format(
      'alter function public.provision_organization(text, text, text, text, uuid, text) owner to %I',
      previous_owner
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- A newly created function receives EXECUTE from PUBLIC *and* from Supabase's
-- project-level default privileges (`alter default privileges in schema public
-- grant all on functions to postgres, anon, authenticated, service_role`).
-- Revoking PUBLIC alone leaves both `anon` and `service_role` holding it, which
-- is the gap 20260807000600 documents for the OAuth helpers and the gap
-- 20260805000200 left open here.
--
-- `service_role` is revoked deliberately, not by omission. This function takes
-- its actor from `auth.uid()`, which is null for a service-role client, so a
-- service-role call could only ever raise 28000 — the grant bought nothing and
-- cost a surface. Nothing in the application calls provisioning through
-- `getServiceDataSource()`; if something ever does, it will fail loudly here
-- rather than quietly creating an ownerless organization.
-- ---------------------------------------------------------------------------

revoke all on function public.provision_organization(text, text, text, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.provision_organization(text, text, text, text, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Rollback, for the R1 phase of the rollout (docs/architecture/current-state.md)
--
-- Not executed. Recorded here because the drop above is the one irreversible-
-- looking step in the expansion phase, and whoever needs this will need it
-- under time pressure.
--
--   drop function if exists public.provision_organization(text, text, text, text, uuid, text) restrict;
--   -- then re-create the four-argument body verbatim from
--   -- 20260808000100_organization_onboarding.sql, and re-apply
--   -- 20260805000200's revoke/grant:
--   --   revoke execute on function public.provision_organization(text, text, text, text) from public;
--   --   grant execute on function public.provision_organization(text, text, text, text) to authenticated;
--
-- `organizations.provision_request_key` and its index are additive and may
-- stay: nothing depends on their absence, and dropping them would discard the
-- idempotency evidence for organizations already created through them.
-- ---------------------------------------------------------------------------
