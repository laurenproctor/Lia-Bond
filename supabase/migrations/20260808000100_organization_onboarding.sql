-- New-user onboarding.
--
-- One row per organization, recording how far its owner got through the
-- five-step setup wizard. The row is what makes progress survive a refresh, a
-- sign-out, and a change of device — none of which a client-side wizard state
-- would survive, and all three of which happen during a real setup (somebody
-- connects Google on their laptop and finishes on a phone).
--
-- Three properties are load-bearing:
--
-- 1. **The row is created with the organization, in the same transaction.**
--    `provision_organization` is rewritten below rather than a trigger being
--    added, because a trigger would also fire for the seed and the backfill —
--    which must land as `completed`, not as step one.
-- 2. **Existing organizations are backfilled as `completed`.** An established
--    customer opening the app the day this deploys must not be redirected into
--    a setup wizard for a workspace they have been using for months.
-- 3. **Absence is not "incomplete".** The application treats a missing row as
--    completed too, so a row lost to any path this migration did not anticipate
--    fails open to the product rather than trapping somebody in onboarding.

-- ---------------------------------------------------------------------------
-- Vocabularies
--
-- These mirror ONBOARDING_STATUSES and ONBOARDING_STEPS in src/domain/enums.ts.
-- `ready` is a value of `onboarding_step` even though it is not one of the five
-- wizard steps: it is where `current_step` points once the wizard is finished
-- but the Workspace Ready screen has not been seen, and giving it a name is
-- what keeps "finished the wizard" distinguishable from "has seen the result".
-- ---------------------------------------------------------------------------

create type onboarding_status as enum ('in_progress', 'completed');

create type onboarding_step as enum (
  'organization', 'connect_sources', 'locations', 'brand_voice', 'team', 'ready'
);

comment on type onboarding_status is
  'Whether an organization is still being set up. Only two values: a wizard that can be abandoned mid-way is still in progress.';
comment on type onboarding_step is
  'Where the wizard resumes. Mirrors ONBOARDING_STEPS in src/domain/enums.ts.';

-- ---------------------------------------------------------------------------
-- organization_onboarding
-- ---------------------------------------------------------------------------

create table public.organization_onboarding (
  -- The primary key *is* the organization id. One row per organization is not
  -- a rule the application has to remember, and there is no separate surrogate
  -- id for a second row to occupy.
  organization_id uuid primary key
    references public.organizations (id) on delete cascade,

  status onboarding_status not null default 'in_progress',
  current_step onboarding_step not null default 'organization',

  -- One nullable timestamp per outcome rather than a single "furthest step
  -- reached" column. Two reasons: a step can be *skipped* rather than
  -- completed, and those are different facts with different consequences
  -- (skipping the source step means location discovery is unavailable, which
  -- the wizard has to say out loud); and "when did they do this" is a question
  -- support actually asks, which a high-water mark cannot answer.
  organization_completed_at timestamptz,
  source_completed_at timestamptz,
  source_skipped_at timestamptz,
  locations_completed_at timestamptz,
  locations_skipped_at timestamptz,
  brand_voice_completed_at timestamptz,
  team_completed_at timestamptz,
  team_skipped_at timestamptz,
  completed_at timestamptz,
  -- Separate from completed_at: finishing setup and seeing the result are
  -- different moments, and only the second one means the activation banner on
  -- the overview has already been read.
  ready_viewed_at timestamptz,

  -- Onboarding metadata, deliberately not a column on `organizations`.
  -- Nothing in the product reads an organization's size — no query filters on
  -- it, no screen renders it — so putting it on the tenant root would add a
  -- field to the core model to serve one form. It is answered once, during
  -- setup, and it belongs with the rest of what was answered during setup.
  organization_size text
    check (
      organization_size is null
      or organization_size in ('1', '2-5', '6-20', '21-50', '51+')
    ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A completed row must say when. Without this, `status = 'completed'` with a
  -- null `completed_at` is a state every reader would have to handle and none
  -- would handle the same way.
  constraint organization_onboarding_completed_has_timestamp check (
    (status = 'completed') = (completed_at is not null)
  ),

  -- A step cannot be both completed and skipped. These are the three steps
  -- that offer a skip; the organization and brand-voice steps cannot be
  -- skipped at all, which is why neither has a `_skipped_at` column.
  constraint organization_onboarding_source_outcome check (
    source_completed_at is null or source_skipped_at is null
  ),
  constraint organization_onboarding_locations_outcome check (
    locations_completed_at is null or locations_skipped_at is null
  ),
  constraint organization_onboarding_team_outcome check (
    team_completed_at is null or team_skipped_at is null
  )
);

comment on table public.organization_onboarding is
  'How far an organization got through first-run setup. One row per organization, created with it and never deleted.';
comment on column public.organization_onboarding.current_step is
  'Where the wizard resumes. Advisory: the route guard recomputes the first incomplete step from the timestamps, so a stale value cannot let anybody skip ahead.';
comment on column public.organization_onboarding.organization_size is
  'Setup metadata. Deliberately not on public.organizations — nothing in the product queries an organization by size.';
comment on constraint organization_onboarding_completed_has_timestamp
  on public.organization_onboarding is
  'A completed onboarding must record when. Rules out the half-state every reader would otherwise have to interpret.';

create trigger organization_onboarding_set_updated_at
  before update on public.organization_onboarding
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Provisioning creates the onboarding row
--
-- Replaces the function added by 20260805000100. The body is unchanged except
-- for the final insert: the organization, the owner membership, and the
-- onboarding row now all land in one function body, which is one transaction.
-- Splitting the onboarding insert into a second statement in the server action
-- would leave a window where an organization exists with no onboarding row,
-- and the owner would land on a wizard that could not record their progress.
-- ---------------------------------------------------------------------------

create or replace function public.provision_organization(
  organization_name text,
  organization_industry text default 'Restaurant group',
  organization_timezone text default 'UTC',
  organization_language text default 'en-US'
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

  -- Derived here rather than accepted from the caller: the slug is globally
  -- unique and appears in links, so it is not a field a signing-up stranger
  -- should be able to choose.
  base_slug := trim(both '-' from regexp_replace(lower(trimmed_name), '[^a-z0-9]+', '-', 'g'));
  if base_slug = '' then
    base_slug := 'organization';
  end if;
  base_slug := left(base_slug, 40);

  candidate_slug := base_slug;
  while exists (select 1 from public.organizations o where o.slug = candidate_slug) loop
    suffix := suffix + 1;
    candidate_slug := base_slug || '-' || suffix;
    if suffix > 500 then
      raise exception 'Could not derive a unique slug for %', trimmed_name
        using errcode = '23505';
    end if;
  end loop;

  insert into public.organizations (
    name, slug, industry, website_url, default_timezone, default_language
  )
  values (
    trimmed_name,
    candidate_slug,
    coalesce(nullif(trim(organization_industry), ''), 'Restaurant group'),
    null,
    coalesce(nullif(trim(organization_timezone), ''), 'UTC'),
    coalesce(nullif(trim(organization_language), ''), 'en-US')
  )
  returning id into new_organization_id;

  -- Owner, active, and not negotiable: the role is written here rather than
  -- passed in, so this function cannot be used to mint a membership of any
  -- other shape.
  insert into public.memberships (organization_id, user_id, role, status)
  values (new_organization_id, actor, 'owner', 'active');

  -- Step one, in progress. A new self-serve organization has, by definition,
  -- configured nothing yet.
  insert into public.organization_onboarding (organization_id)
  values (new_organization_id);

  return new_organization_id;
end;
$$;

comment on function public.provision_organization is
  'Creates an organization, the calling user''s owner membership, and its onboarding row, atomically. The user is taken from auth.uid(), never from an argument.';

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Every organization that exists before this migration has been in use without
-- a wizard, so it is complete by definition. `completed_at` is set to the
-- organization's own creation instant rather than `now()`: claiming a customer
-- finished setup at the moment of a deployment they had nothing to do with
-- would be a fabricated fact in a table support reads.
--
-- `on conflict do nothing` because the table was created empty moments ago and
-- this should be a no-op if it is ever re-run.
-- ---------------------------------------------------------------------------

insert into public.organization_onboarding (
  organization_id, status, current_step,
  organization_completed_at, source_completed_at, locations_completed_at,
  brand_voice_completed_at, team_completed_at, completed_at, ready_viewed_at,
  created_at, updated_at
)
select
  o.id, 'completed', 'ready',
  o.created_at, o.created_at, o.created_at,
  o.created_at, o.created_at, o.created_at, o.created_at,
  o.created_at, now()
from public.organizations o
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------
-- Audit vocabulary
--
-- Onboarding events are recorded against entity_type 'organization' with the
-- organization's own id, rather than a new entity type. Onboarding is a
-- property of an organization, not a thing in its own right, and adding an
-- enum value would need ALTER TYPE — which cannot run in the same transaction
-- as a statement that writes the new value.
--
-- The check constraint is a closed list that has to be redefined in full,
-- because Postgres has no "add a value to a check constraint". This carries
-- forward every value from 20260807000700 (itself the union of three parallel
-- branches — see that file) plus the eleven added here. Metadata on these
-- events carries step names, counts, and booleans only: never an OAuth token,
-- an invitation token, a Google account identifier, or review text.
-- ---------------------------------------------------------------------------

alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      'escalation.assigned',
      'escalation.status_changed',
      'automation_rule.enabled',
      'automation_rule.disabled',
      'location.manager_changed',
      -- A location a person typed in, as opposed to one discovered through an
      -- integration. Kept apart from 'location.created_from_integration'.
      'location.created',
      'integration.oauth_started',
      'integration.oauth_completed',
      'integration.connected',
      'integration.reauthorization_started',
      'integration.reauthorized',
      'integration.health_checked',
      'integration.health_degraded',
      'integration.profile_connected',
      'integration.profile_mapped',
      'location.created_from_integration',
      'integration.disconnected',
      'integration.credentials_revoked',
      'integration.credentials_revocation_failed',
      'integration.reviews_synced',
      'integration.review_sync_failed',
      'mention.analyzed',
      'mention.analysis_failed',
      'escalation.created_from_analysis',
      'organization.created',
      'membership.invited',
      'membership.invitation_revoked',
      'membership.joined',
      'membership.role_changed',
      'membership.status_changed',
      'membership.removed',
      'brand_voice.updated',
      'monitoring_query.polled',
      'monitoring_query.poll_failed',
      'monitoring_query.created',
      'monitoring_query.updated',
      'monitoring_query.deleted',
      -- Onboarding. Progress metadata only: step names, whether a step was
      -- skipped, and counts. Never a token, an account name, or review text.
      'onboarding.started',
      'onboarding.organization_completed',
      'onboarding.source_connected',
      'onboarding.source_skipped',
      'onboarding.locations_completed',
      'onboarding.locations_skipped',
      'onboarding.brand_voice_completed',
      'onboarding.team_completed',
      'onboarding.team_skipped',
      'onboarding.completed',
      'onboarding.ready_viewed'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, reviewer names, article titles, URLs, or publisher names in metadata.';
