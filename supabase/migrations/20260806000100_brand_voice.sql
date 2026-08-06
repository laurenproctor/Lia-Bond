-- Brand voice configuration.
--
-- Supersedes the typed fixture at src/lib/fixtures/brand-voice.ts. Decision
-- D34 deferred this table on the grounds that it would ship schema nothing
-- queries; that held until the screen's controls became the problem. Nothing
-- generates text from these settings yet.

-- ---------------------------------------------------------------------------
-- Phrase list validation
-- ---------------------------------------------------------------------------
--
-- A check constraint may not contain a subquery, so the per-item length test
-- lives here. Postgres does not re-validate existing rows when this function
-- changes, so tightening the limits later needs an explicit
-- `alter table ... validate constraint` rather than an edit in place.

create function public.brand_voice_phrases_valid(phrases text[])
  returns boolean
  language sql
  immutable
  parallel safe
as $$
  select cardinality(phrases) <= 20
     and not exists (
       select 1 from unnest(phrases) as p
       where length(p) < 1 or length(p) > 80
     );
$$;

comment on function public.brand_voice_phrases_valid is
  'Bounds a brand voice phrase list: at most 20 entries, each 1 to 80 characters.';

-- ---------------------------------------------------------------------------
-- brand_voice_profiles
-- ---------------------------------------------------------------------------

create table public.brand_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  -- One profile per organization. A second row is a constraint violation
  -- rather than a silent question about which one wins.
  organization_id uuid not null unique
    references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),

  -- Named columns rather than jsonb: the axes are a fixed taxonomy, not user
  -- data, so the range is enforceable here. Adding a sixth axis is a migration,
  -- which is correct — it also changes the summary and any future prompt.
  --
  -- No defaults, deliberately. Both adapters always write all five, so a
  -- default would never be exercised — it would only be a second declaration
  -- of the starting values, free to drift from DEFAULT_BRAND_VOICE in
  -- src/domain/entities/brand-voice.ts, which is the one that decides them.
  axis_warmth smallint not null check (axis_warmth between 0 and 100),
  axis_detail smallint not null check (axis_detail between 0 and 100),
  axis_formality smallint not null check (axis_formality between 0 and 100),
  axis_confidence smallint not null check (axis_confidence between 0 and 100),
  axis_hospitality smallint not null check (axis_hospitality between 0 and 100),

  approved_phrases text[] not null default '{}'
    check (public.brand_voice_phrases_valid(approved_phrases)),
  prohibited_phrases text[] not null default '{}'
    check (public.brand_voice_phrases_valid(prohibited_phrases)),

  -- response_drafts.brand_voice_version records which voice produced a draft.
  -- Incremented only when a save actually changes something: bumping on a
  -- no-op would invalidate the provenance of every existing draft because
  -- somebody pressed Save twice.
  version integer not null default 1 check (version > 0),

  updated_by_user_id uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.brand_voice_profiles is
  'How Lia is configured to sound. One row per organization. No generator reads it yet.';

comment on column public.brand_voice_profiles.version is
  'Bumped only on a change. Stamped onto response_drafts.brand_voice_version by a later workflow.';

create trigger brand_voice_profiles_set_updated_at
  before update on public.brand_voice_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit vocabulary
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value 'brand_voice';

-- The event-type check is a closed list, mirroring AUDIT_EVENT_TYPES in
-- src/domain/enums.ts. Recreated rather than extended: a check constraint
-- cannot be added to. The list carries forward every value accumulated by
-- prior migrations (initial schema, integration, review sync, mention
-- analysis, membership provisioning) plus the one this table adds.
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
      'brand_voice.updated'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, or reviewer names in metadata.';
