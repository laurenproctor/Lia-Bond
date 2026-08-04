-- Mention analysis (workflow 04).
--
-- Workflow 03 imports Google reviews with risk_level defaulting to 'low' and
-- sentiment to 'unknown', and nothing has ever written to mention_analyses. So
-- every imported review currently reads as low-risk — which matters, because
-- Lia's safety promises are all keyed to risk: docs/product-spec.md says
-- high-risk content must always be escalated, and isAutoPublishSafe() gates
-- auto-publishing on a risk_level condition. Those guards are inert until
-- something populates the field. This migration is what lets that happen.
--
-- No response text is generated or stored here. Drafting is workflow 05.

-- ---------------------------------------------------------------------------
-- analysis_runs
--
-- Created before the mention_analyses columns below, which carry a foreign key
-- to it.
--
-- Shaped like platform_sync_runs deliberately: same lock discipline, same
-- counts-and-sanitised-error reporting, same "a run that failed is a row, not
-- an absence". The difference is scope — a sync run covers one connected
-- location, an analysis run covers an organization's backlog.
-- ---------------------------------------------------------------------------

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  trigger sync_trigger not null default 'manual',
  -- Nulled rather than cascaded: an offboarded employee must not erase the
  -- record that an analysis happened.
  actor_user_id uuid references public.users (id) on delete set null,
  status sync_run_status not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Analysed by the model.
  analyzed_count integer not null default 0 check (analyzed_count >= 0),
  -- Analysed by the rating heuristic, with no model call. Counted separately
  -- because "42 analysed" meaning two different things depending on where you
  -- read it is how a metric quietly becomes wrong.
  heuristic_count integer not null default 0 check (heuristic_count >= 0),
  escalated_count integer not null default 0 check (escalated_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  -- Backlog left after the per-run cap. Recorded rather than dropped: a run
  -- that silently analysed 50 of 2,000 mentions and reported success reads as
  -- "the inbox is triaged" when it is not.
  remaining_count integer not null default 0 check (remaining_count >= 0),
  model_provider text,
  model_name text,
  prompt_version text,
  error_code text,
  -- Lia's own sentence. Provider error text is never stored: it can quote the
  -- prompt, which contains a customer's review.
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_runs_finished_has_timestamp
    check (status = 'running' or completed_at is not null),
  constraint analysis_runs_running_is_clean
    check (status <> 'running' or (completed_at is null and error_code is null)),
  constraint analysis_runs_error_requires_code
    check (error_message is null or error_code is not null),
  constraint analysis_runs_failure_has_reason
    check (status <> 'failed' or error_code is not null)
);

comment on table public.analysis_runs is
  'One attempt to analyse an organization''s unanalysed mentions. Inserted when the run starts, updated once when it finishes.';
comment on column public.analysis_runs.heuristic_count is
  'Mentions analysed without a model call — a rating with no written review has nothing to classify. Separate from analyzed_count so cost and coverage stay legible.';
comment on column public.analysis_runs.remaining_count is
  'Unanalysed mentions still left when the run hit its cap. Zero means the backlog is clear.';
comment on column public.analysis_runs.error_message is
  'Lia''s own wording, capped by the application. Never the provider''s message, never the prompt, never review text.';

-- The concurrency control.
--
-- A partial unique index rather than an application check, for the same reason
-- as platform_sync_runs_one_active: checking first and then inserting is two
-- statements with a race between them, and Lia runs on serverless functions
-- where two concurrent requests are routinely two processes. An in-memory lock
-- would not help.
--
-- Scoped to the organization rather than to a mention: analysis walks a shared
-- backlog, so two concurrent runs would race each other over the same rows and
-- pay twice for the overlap.
create unique index analysis_runs_one_active
  on public.analysis_runs (organization_id) where status = 'running';

comment on index public.analysis_runs_one_active is
  'At most one running analysis per organization. This index IS the lock; the application never relies on checking first.';

create index analysis_runs_organization_idx
  on public.analysis_runs (organization_id, started_at desc);

create trigger analysis_runs_set_updated_at
  before update on public.analysis_runs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- mention_analyses
--
-- The table already carries every field an analysis produces — relevance,
-- sentiment, risk, categories, topics, facts needing verification, recommended
-- action. Only provenance is missing.
-- ---------------------------------------------------------------------------

alter table public.mention_analyses
  add column analysis_run_id uuid references public.analysis_runs (id) on delete set null,
  add column input_tokens integer check (input_tokens is null or input_tokens >= 0),
  add column output_tokens integer check (output_tokens is null or output_tokens >= 0);

comment on column public.mention_analyses.analysis_run_id is
  'Which run produced this analysis. Nulled rather than cascaded so deleting a run never destroys the analysis it produced.';
comment on column public.mention_analyses.input_tokens is
  'Tokens the model read. Null on heuristic analyses, which spend none. Recorded because "what did last night cost" is easier to answer here than from a bill.';

create index mention_analyses_run_idx
  on public.mention_analyses (analysis_run_id)
  where analysis_run_id is not null;

-- ---------------------------------------------------------------------------
-- audit_events
--
-- Three new event types. Still a closed list.
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
      'integration.reviews_synced',
      'integration.review_sync_failed',
      -- Workflow 04. Metadata carries counts, a model name, a prompt version,
      -- and a normalised error code — never review text, never a reviewer's
      -- name, never the prompt.
      'mention.analyzed',
      'mention.analysis_failed',
      'escalation.created_from_analysis'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, or reviewer names in metadata.';
