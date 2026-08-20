-- ---------------------------------------------------------------------------
-- create_and_map_location: creation as a side effect of binding
--
-- Release R1 (expansion). Purely additive — nothing calls this until the
-- application deploys (R2), and no policy changes here, so the currently
-- deployed mapping path keeps working through `locations_insert` exactly as it
-- does today. Narrowing that policy is a separate migration in a separate
-- release (20260814000500), which is what keeps an application rollback
-- possible in between.
--
-- The problem this solves. `locations_insert` today admits
-- `can_write_in_organization`: owner, admin, communications lead, **location
-- manager, and approver**. Two of those five have no business creating a
-- restaurant record at all, and `locations_update` under the same gate lets a
-- location manager reassign `manager_user_id` to themselves — the exact
-- widening that `location.update_manager` being owner/admin exists to prevent.
--
-- So the policy narrows to owner/admin. But a communications lead genuinely
-- does need a location to come into existence while mapping a Google listing —
-- that is the day-to-day work of running the integration, and it is what
-- `integration.manage_profiles` grants them. The database cannot tell those
-- two inserts apart: a row written by the mapping service and a row written by
-- a hand-typed form are the same INSERT.
--
-- An earlier draft of this function resolved that by taking a connection id
-- and location fields and creating an unbound `setup` location. That is not a
-- mapping — a communications lead could call it repeatedly and mint arbitrary
-- orphaned locations, and restricting `status` and `manager_user_id` only
-- narrows what those orphans look like. Creation has to be *inseparable* from
-- binding, which is what this function is: it takes the profiles being mapped,
-- and it cannot commit a location without having bound them.
--
-- What it may produce is deliberately one shape of row:
--
--   * the organization comes from the connection, never from an argument;
--   * `status` is written 'setup' literally and `manager_user_id` null
--     literally — neither is a parameter, so this cannot mint an active or
--     managed location;
--   * the slug is derived inside and de-duplicated within the organization;
--   * and at least one profile must be bound, or nothing happens at all.
--
-- **This narrows D17 rather than reversing it.** D17 refused a Postgres
-- function wrapping the whole mapping *batch*, because the demo adapter has no
-- transaction and each decision should be independent and idempotent. That
-- still holds — the batch is still a loop reporting failures per row. What
-- becomes atomic is one decision's create-and-bind, which was never
-- independent: a location without its profile was always a half-applied
-- decision, and "each decision is independent and idempotent" is what this
-- delivers rather than what it trades away.
-- ---------------------------------------------------------------------------

create or replace function public.create_and_map_location(
  p_connection_id uuid,
  p_profiles jsonb,
  p_name text,
  p_address_line1 text,
  p_address_line2 text,
  p_city text,
  p_region text,
  p_postal_code text,
  p_country_code text,
  p_timezone text
)
returns table (
  location_id uuid,
  profile_id uuid,
  profile_created boolean,
  replayed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  resolved_organization_id uuid;
  connection_platform platform;
  connection_status platform_connection_status;
  requested_count integer;
  locked_count integer;
  distinct_locations integer;
  existing_location_id uuid;
  base_slug text;
  candidate_slug text;
  suffix integer := 1;
  new_location_id uuid;
  created_profile_ids uuid[] := '{}';
  bound_profile_ids uuid[] := '{}';
  external_ids text[];
begin
  if actor is null then
    raise exception 'An authenticated caller is required'
      using errcode = '28000';
  end if;

  -- At least one profile. There is no shape of call that creates a location
  -- and binds nothing — that possibility is the whole defect this function
  -- replaces.
  if p_profiles is null
     or jsonb_typeof(p_profiles) <> 'array'
     or jsonb_array_length(p_profiles) = 0 then
    raise exception 'At least one platform profile is required to map a location'
      using errcode = '22023';
  end if;

  requested_count := jsonb_array_length(p_profiles);

  select array_agg(distinct value ->> 'externalProfileId')
    into external_ids
  from jsonb_array_elements(p_profiles) as value;

  if external_ids is null
     or cardinality(external_ids) <> requested_count
     or exists (select 1 from unnest(external_ids) e where e is null or trim(e) = '') then
    -- Either a null/blank external id, or the same one twice. Both are caller
    -- mistakes that would otherwise produce a locked set smaller than the
    -- request and fail the cardinality check below with a less useful message.
    raise exception 'Each profile must carry a distinct, non-empty externalProfileId'
      using errcode = '22023';
  end if;

  -- The tenant is derived, never supplied. There is no organization_id
  -- parameter on this function, so a caller cannot aim it at another
  -- organization; the connection they name is what decides.
  select c.organization_id, c.platform, c.status
    into resolved_organization_id, connection_platform, connection_status
  from public.platform_connections c
  where c.id = p_connection_id;

  -- An unknown connection and an unauthorized one answer identically, so this
  -- function is not a probe for which connection ids exist.
  if resolved_organization_id is null
     or not public.has_organization_role(
          resolved_organization_id,
          array['owner', 'admin', 'communications_lead']::membership_role[]
        ) then
    raise exception 'That connection is not available'
      using errcode = '42501';
  end if;

  -- Distinct from the refusal above on purpose: the caller is entitled to know
  -- their own connection needs reconnecting, and this is not information about
  -- anyone else's tenant.
  if connection_status = 'disconnected' then
    raise exception 'This connection is disconnected. Reconnect it before mapping locations.'
      using errcode = '55000';
  end if;

  if nullif(trim(p_name), '') is null then
    raise exception 'A location name is required'
      using errcode = '22023';
  end if;

  if nullif(trim(p_address_line1), '') is null
     or nullif(trim(p_city), '') is null
     or nullif(trim(p_region), '') is null
     or nullif(trim(p_postal_code), '') is null
     or nullif(trim(p_country_code), '') is null
     or nullif(trim(p_timezone), '') is null then
    raise exception 'A complete address and timezone are required'
      using errcode = '22023';
  end if;

  -- Upsert the profiles.
  --
  -- Platform profiles are not persisted before mapping: they are fetched live
  -- from the provider on every render of the setup screen and written at save
  -- time, keyed on platform_profiles_unique_external. So this function has to
  -- be able to create the row, not merely reference one.
  --
  -- `do update` rather than `do nothing` because the display name, URL, and
  -- verification state come from the provider on each fetch and the freshest
  -- read should win — and because `do update` takes the row lock, so a
  -- concurrent caller parks here rather than racing past.
  with requested as (
    select
      value ->> 'externalProfileId'   as external_profile_id,
      value ->> 'externalProfileName' as external_profile_name,
      value ->> 'profileUrl'          as profile_url,
      value ->> 'externalAccountId'   as external_account_id,
      value ->> 'verificationState'   as verification_state,
      coalesce(value -> 'providerMetadata', '{}'::jsonb) as provider_metadata
    from jsonb_array_elements(p_profiles) as value
  ),
  upserted as (
    insert into public.platform_profiles (
      organization_id, platform_connection_id, location_id,
      external_profile_id, external_profile_name, profile_url,
      external_account_id, verification_state, provider_metadata,
      status, last_confirmed_at
    )
    select
      resolved_organization_id, p_connection_id, null,
      r.external_profile_id, r.external_profile_name, r.profile_url,
      r.external_account_id, r.verification_state, r.provider_metadata,
      'pending', now()
    from requested r
    on conflict (platform_connection_id, external_profile_id) do update
      set external_profile_name = excluded.external_profile_name,
          profile_url           = excluded.profile_url,
          external_account_id   = coalesce(excluded.external_account_id, public.platform_profiles.external_account_id),
          verification_state    = excluded.verification_state,
          provider_metadata     = excluded.provider_metadata,
          last_confirmed_at     = excluded.last_confirmed_at
    returning id, (xmax = 0) as was_inserted
  )
  select array_agg(id) filter (where was_inserted)
    into created_profile_ids
  from upserted;

  created_profile_ids := coalesce(created_profile_ids, '{}');

  -- Lock the affected rows explicitly.
  --
  -- This is what makes two concurrent submissions for the same listing
  -- converge on one location instead of minting two: the second caller parks
  -- here until the first commits, then re-reads and finds the binding already
  -- done. `order by id` is deadlock avoidance — two concurrent calls covering
  -- overlapping profile sets would otherwise be free to take the same locks in
  -- opposite orders.
  -- `min()` has no uuid overload, so the single bound location is taken from a
  -- filtered aggregate rather than an ordering aggregate. Correct here because
  -- `distinct_locations` is checked to be exactly 1 before the value is used.
  select count(*),
         count(distinct pp.location_id) filter (where pp.location_id is not null),
         (array_agg(pp.location_id) filter (where pp.location_id is not null))[1],
         array_agg(pp.id order by pp.id)
    into locked_count, distinct_locations, existing_location_id, bound_profile_ids
  from (
    select pp.id, pp.location_id, pp.organization_id, pp.platform_connection_id
    from public.platform_profiles pp
    where pp.platform_connection_id = p_connection_id
      and pp.external_profile_id = any(external_ids)
    order by pp.id
    for update
  ) pp;

  if locked_count <> requested_count then
    raise exception 'That connection is not available'
      using errcode = '42501';
  end if;

  -- Defence in depth. Mixed-organization sets are structurally impossible —
  -- one connection belongs to exactly one organization, and the natural key is
  -- scoped to the connection, so an external id that also exists under another
  -- organization's connection is a different row this call can neither read
  -- nor touch. This check catches corrupt data and any future caller shape
  -- that supplies profile ids directly.
  if exists (
    select 1
    from public.platform_profiles pp
    where pp.platform_connection_id = p_connection_id
      and pp.external_profile_id = any(external_ids)
      and (pp.organization_id <> resolved_organization_id
           or pp.platform_connection_id <> p_connection_id)
  ) then
    raise exception 'That connection is not available'
      using errcode = '42501';
  end if;

  -- Replay, conflict, or create.
  if distinct_locations = 1 and locked_count = (
    select count(*)
    from public.platform_profiles pp
    where pp.platform_connection_id = p_connection_id
      and pp.external_profile_id = any(external_ids)
      and pp.location_id = existing_location_id
  ) then
    -- Every requested profile is already bound to the same location. This is a
    -- retry of a call that already succeeded: return what it produced, and
    -- write nothing — no second location, no second audit event.
    return query
      select existing_location_id, pp.id, false, true
      from public.platform_profiles pp
      where pp.platform_connection_id = p_connection_id
        and pp.external_profile_id = any(external_ids)
      order by pp.id;
    return;
  end if;

  if distinct_locations > 0 then
    -- Some bound, some not — or bound to two different locations. Either way a
    -- retry cannot resolve it and guessing would be worse than refusing: this
    -- is a mapping somebody has to look at.
    raise exception 'These profiles are already mapped to a different location'
      using errcode = '23505';
  end if;

  -- Slug derived here, not accepted: it is part of the location's identity and
  -- the caller is a mapping screen, not a person naming a URL.
  base_slug := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
  if base_slug = '' then
    base_slug := 'location';
  end if;
  base_slug := left(base_slug, 40);

  candidate_slug := base_slug;
  while exists (
    select 1 from public.locations l
    where l.organization_id = resolved_organization_id
      and l.slug = candidate_slug
  ) loop
    suffix := suffix + 1;
    candidate_slug := base_slug || '-' || suffix;
    if suffix > 500 then
      raise exception 'Could not derive a unique location slug for %', p_name
        using errcode = '23505';
    end if;
  end loop;

  -- 'setup' and null, written literally. A location that arrived through a
  -- provider listing has not been set up in Lia, and marking it active would
  -- flatter every portfolio roll-up that counts active locations. Neither is a
  -- parameter, so this function cannot be talked into either.
  insert into public.locations (
    organization_id, name, slug,
    address_line1, address_line2, city, region, postal_code, country_code,
    timezone, status, manager_user_id
  )
  values (
    resolved_organization_id, trim(p_name), candidate_slug,
    trim(p_address_line1), nullif(trim(coalesce(p_address_line2, '')), ''),
    trim(p_city), trim(p_region), trim(p_postal_code), upper(trim(p_country_code)),
    trim(p_timezone), 'setup', null
  )
  returning id into new_location_id;

  -- The bind. Everything above this point can still be discarded; after it,
  -- there is no state in which the location exists without its mapping,
  -- because both are in this one transaction.
  update public.platform_profiles pp
     set location_id = new_location_id,
         status = 'active'
   where pp.id = any(bound_profile_ids);

  -- Audit, in the same transaction as the writes it describes. These are the
  -- three events the mapping service writes for this branch today; moving them
  -- here is what makes "the application performs no second, non-atomic binding
  -- step" true rather than nearly true.
  insert into public.audit_events (
    organization_id, actor_type, actor_user_id,
    event_type, entity_type, entity_id,
    previous_state, new_state, metadata
  )
  values (
    resolved_organization_id, 'user', actor,
    'location.created_from_integration', 'location', new_location_id,
    null,
    jsonb_build_object('name', trim(p_name), 'slug', candidate_slug, 'status', 'setup'),
    jsonb_build_object(
      'platform', connection_platform,
      'connectionId', p_connection_id,
      'externalProfileIds', to_jsonb(external_ids)
    )
  );

  insert into public.audit_events (
    organization_id, actor_type, actor_user_id,
    event_type, entity_type, entity_id,
    previous_state, new_state, metadata
  )
  select
    resolved_organization_id, 'user', actor,
    'integration.profile_connected', 'platform_profile', pp.id,
    null,
    jsonb_build_object(
      'externalProfileId', pp.external_profile_id,
      'externalProfileName', pp.external_profile_name
    ),
    jsonb_build_object('platform', connection_platform)
  from public.platform_profiles pp
  where pp.id = any(created_profile_ids);

  insert into public.audit_events (
    organization_id, actor_type, actor_user_id,
    event_type, entity_type, entity_id,
    previous_state, new_state, metadata
  )
  select
    resolved_organization_id, 'user', actor,
    'integration.profile_mapped', 'platform_profile', pp.id,
    jsonb_build_object('locationId', null),
    jsonb_build_object('locationId', new_location_id),
    jsonb_build_object(
      'platform', connection_platform,
      'externalProfileId', pp.external_profile_id
    )
  from public.platform_profiles pp
  where pp.id = any(bound_profile_ids);

  return query
    select new_location_id, pp.id, pp.id = any(created_profile_ids), false
    from public.platform_profiles pp
    where pp.id = any(bound_profile_ids)
    order by pp.id;
end;
$$;

comment on function public.create_and_map_location is
  'Creates a location and binds the named platform profiles to it, atomically, or does neither. The organization is derived from the connection; status is always setup and the manager is always null; the slug is derived. Requires owner, admin, or communications_lead in the connection''s organization. A repeat call with the same profiles returns the location the first call created and writes nothing.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- A newly created function receives EXECUTE from PUBLIC and from Supabase's
-- project-level default privileges to anon, authenticated, and service_role.
-- All three are revoked; only `authenticated` is granted.
--
-- `service_role` is revoked deliberately. This function reads `auth.uid()` for
-- the audit trail and `has_organization_role` for authorization, neither of
-- which means anything for a service-role client, and nothing in the
-- application reaches mapping through `getServiceDataSource()`. A grant that
-- can only ever produce an unauthenticated failure is a surface with no use.
-- ---------------------------------------------------------------------------

revoke all on function public.create_and_map_location(uuid, jsonb, text, text, text, text, text, text, text, text)
  from public, anon, service_role;
grant execute on function public.create_and_map_location(uuid, jsonb, text, text, text, text, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Rollback, for the R1 phase of the rollout
--
-- Not executed. Safe on its own only while nothing calls it — i.e. before R2.
-- After R2, rolling this back must be paired with an application rollback.
--
--   drop function if exists public.create_and_map_location(
--     uuid, jsonb, text, text, text, text, text, text, text, text) restrict;
-- ---------------------------------------------------------------------------
