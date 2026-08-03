-- Google Business Profile review synchronization (workflow 03).
--
-- Workflow 02 stopped at "Lia knows which Google locations belong to which
-- restaurant". This migration is what lets those locations' reviews arrive.
--
-- The important decision here is what it does NOT create. There is no
-- google_reviews table. `public.mentions` is already the canonical unified
-- model, it already carries source_type = 'google_review', and it already has
-- the unique constraint that makes a repeated ingest idempotent. A parallel
-- Google-shaped table would fork the inbox, the analytics, and every downstream
-- workflow — and would need merging back later at exactly the moment there was
-- real data to lose. So `mentions` is extended instead.
--
-- Nothing here reads, drafts, or publishes a review reply. The owner reply that
-- Google returns is stored as *source state* — what Google currently shows —
-- and is deliberately not modelled as a Lia response draft. Drafting is
-- workflow 04.

-- ---------------------------------------------------------------------------
-- mentions: source-owned fields
--
-- Every column added here is owned by the source, not by Lia. That split is
-- load-bearing rather than descriptive: the ingest path overwrites these on
-- every sync and must never touch status, sentiment, risk_level, or any of the
-- workflow state a person has since put on the record.
--
-- The names are platform-neutral on purpose. Yelp, Trustpilot, and TripAdvisor
-- all have an owner reply and an edited-at timestamp; naming these
-- google_review_reply would have made the next connector add its own near
-- duplicate.
-- ---------------------------------------------------------------------------

alter table public.mentions
  add column external_resource_name text,
  add column author_avatar_url text,
  add column author_is_anonymous boolean not null default false,
  add column source_updated_at timestamptz,
  add column source_reply_text text,
  add column source_reply_updated_at timestamptz,
  add column source_metadata jsonb not null default '{}'::jsonb,
  add column last_synced_at timestamptz;

comment on column public.mentions.external_resource_name is
  'Fully qualified provider resource name, e.g. accounts/1/locations/2/reviews/3. Kept because replying to a Google review addresses the resource, not the bare review id.';
comment on column public.mentions.author_is_anonymous is
  'The source told us the author is anonymous. Distinct from author_name being null, which only means we were not given one.';
comment on column public.mentions.source_updated_at is
  'When the author last edited it at the source. Null when the source does not report edits.';
comment on column public.mentions.source_reply_text is
  'The owner reply currently published at the source. Source state, not a Lia response draft — Lia has published nothing.';
comment on column public.mentions.source_metadata is
  'Named, reviewed source fields only, never a spread of a provider response. Never credentials.';
comment on column public.mentions.last_synced_at is
  'When a sync last confirmed this record against the source. Differs from updated_at, which also moves when a person changes Lia state.';

-- Reviews that already carry an owner reply are the ones workflow 04 must not
-- draft over, so being able to find them cheaply is worth an index.
create index mentions_org_awaiting_reply_idx
  on public.mentions (organization_id, published_at desc)
  where source_reply_text is null;

-- The sync counts and the per-location review totals both group by profile.
create index mentions_profile_source_idx
  on public.mentions (platform_profile_id, source_type)
  where platform_profile_id is not null;

-- mentions_unique_external (platform_connection_id, source_type, external_id)
-- from the foundation is the idempotency guarantee, and it is left exactly as
-- it is. organization_id is implied rather than absent: a connection belongs to
-- one organization, so the key is strictly narrower than
-- (organization, platform, external_id) would be. external_id holds Google's
-- reviewId, which Google assigns globally rather than per location.
comment on constraint mentions_unique_external on public.mentions is
  'Makes re-sync idempotent: a repeated fetch updates rather than duplicates. This is the conflict target the Google review ingest upserts on.';

-- ---------------------------------------------------------------------------
-- Sync runs
--
-- A sync that leaves no trace is a sync nobody can support. "It says last
-- synced two days ago" needs an answer to "and what happened since", which
-- means the failures have to be recorded as first-class rows rather than
-- inferred from the absence of new mentions.
-- ---------------------------------------------------------------------------

create type sync_run_status as enum ('running', 'completed', 'partial', 'failed');

comment on type sync_run_status is
  'partial is distinct from failed on purpose: some reviews imported and some did not, which is a different thing to tell a user than "nothing worked".';

create type sync_trigger as enum ('manual', 'scheduled');

comment on type sync_trigger is
  'Who asked. scheduled exists now so the same service can be called by a job later without a migration.';

create table public.platform_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  platform_connection_id uuid not null
    references public.platform_connections (id) on delete cascade,
  platform_profile_id uuid not null
    references public.platform_profiles (id) on delete cascade,
  -- Named rather than assumed: a connection will later sync posts, questions,
  -- and media from the same profile, and each needs its own lock and history.
  resource text not null default 'reviews' check (length(trim(resource)) > 0),
  trigger sync_trigger not null default 'manual',
  -- Nulled rather than cascaded: an offboarded employee must not erase the
  -- record that a sync happened.
  actor_user_id uuid references public.users (id) on delete set null,
  status sync_run_status not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  fetched_count integer not null default 0 check (fetched_count >= 0),
  created_count integer not null default 0 check (created_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  unchanged_count integer not null default 0 check (unchanged_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  pages_fetched integer not null default 0 check (pages_fetched >= 0),
  -- What the provider says the true total is, when it says. Null is honest:
  -- Google omits totalReviewCount on some responses.
  total_review_count integer check (total_review_count is null or total_review_count >= 0),
  error_code text,
  -- Lia's own sentence. Provider error text is deliberately never stored: it
  -- quotes request URLs and can echo parameters.
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_sync_runs_finished_has_timestamp
    check (status = 'running' or completed_at is not null),
  constraint platform_sync_runs_running_is_clean
    check (status <> 'running' or (completed_at is null and error_code is null)),
  constraint platform_sync_runs_error_requires_code
    check (error_message is null or error_code is not null),
  constraint platform_sync_runs_failure_has_reason
    check (status <> 'failed' or error_code is not null)
);

comment on table public.platform_sync_runs is
  'One attempt to synchronise one resource from one connected profile. Append-only in spirit: a run is inserted when it starts and updated once when it finishes.';
comment on column public.platform_sync_runs.error_message is
  'Lia''s own wording, capped by the application. Never the provider''s message, never a token, never a request URL.';

-- The concurrency control.
--
-- A partial unique index rather than an application check, because an
-- application check is two statements with a race between them. Two people
-- clicking Sync at the same moment — or a manual sync overlapping a scheduled
-- one — means the second INSERT violates this and is reported as "a sync is
-- already running" instead of both runs fetching the same pages and racing each
-- other's upserts.
--
-- An in-memory lock would not do this: Lia runs on serverless functions, so two
-- concurrent requests are routinely two processes.
create unique index platform_sync_runs_one_active
  on public.platform_sync_runs (platform_profile_id, resource)
  where status = 'running';

comment on index public.platform_sync_runs_one_active is
  'At most one running sync per connected profile per resource. This index IS the lock; the application never relies on checking first.';

create index platform_sync_runs_profile_idx
  on public.platform_sync_runs (organization_id, platform_profile_id, started_at desc);

create index platform_sync_runs_connection_idx
  on public.platform_sync_runs (organization_id, platform_connection_id, started_at desc);

-- Finding the last *successful* run is a different question to finding the last
-- run, and the UI asks both.
create index platform_sync_runs_success_idx
  on public.platform_sync_runs (platform_profile_id, completed_at desc)
  where status in ('completed', 'partial');

create trigger platform_sync_runs_set_updated_at
  before update on public.platform_sync_runs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- platform_profiles
--
-- last_synced_at already exists and now has a precise meaning: the last time a
-- sync *succeeded*. A failed run must not move it, or "last synced 3 minutes
-- ago" would be shown next to an error, and the operator would reasonably
-- conclude their reviews were current.
-- ---------------------------------------------------------------------------

comment on column public.platform_profiles.last_synced_at is
  'End of the last SUCCESSFUL sync. A failed run leaves it alone, so it never implies freshness the data does not have.';

-- ---------------------------------------------------------------------------
-- audit_events
--
-- Two new event types, still a closed list.
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
      -- Workflow 03. Both are attributed to the platform_profile that was
      -- synced, because "which restaurant's reviews moved" is the question an
      -- auditor actually has.
      'integration.reviews_synced',
      'integration.review_sync_failed'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. Integration events must never carry tokens, authorization codes, state values, or review payloads in metadata.';
