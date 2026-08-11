-- Automation execution: sweeps, executions, and rule activity timestamps.
--
-- Sweeps claim per-organization concurrency and record sweep-level telemetry.
-- Executions record each (rule, mention) decision inside a sweep, with
-- idempotency keyed to the mention's analysis occurrence, not the sweep.
--
-- Composite same-organization foreign keys target Task 1's unique constraints.

create table public.automation_sweeps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  mode text not null check (mode in ('dry_run', 'apply')),
  status text not null check (status in ('running', 'completed', 'failed'))
    default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  mentions_evaluated integer not null default 0,
  rules_matched integer not null default 0,
  actions_applied integer not null default 0,
  actions_blocked integer not null default 0,
  actions_skipped integer not null default 0,
  actions_failed integer not null default 0,
  retryable_failures integer not null default 0,
  terminal_failures integer not null default 0,
  error_code text,

  constraint automation_sweeps_id_org unique (id, organization_id)
);

comment on table public.automation_sweeps is
  'Service role writes; authenticated members read per RLS. Rows are operational history: restrict deletes.';

create unique index automation_sweeps_one_running
  on public.automation_sweeps (organization_id)
  where status = 'running';

create table public.automation_rule_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sweep_id uuid not null,
  automation_rule_id uuid not null,
  rule_revision integer not null check (rule_revision > 0),
  mention_id uuid not null,
  -- The durable trigger occurrence: the analysis row that authorized
  -- reconsidering this mention (F13).
  trigger_analysis_id uuid not null,
  -- Denormalized from the mention at execution time; constrained below to
  -- equal the mention's location. Null = unlocated mention.
  location_id uuid,
  mode text not null check (mode in ('dry_run', 'apply')),
  status text not null,
  outcomes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(outcomes) = 'array'),
  outcome_schema_version integer not null default 1,
  attempt_count integer not null default 1 check (attempt_count >= 1),
  last_error_code text,
  error_class text check (error_class in ('retryable', 'terminal')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,

  -- Outcome vocabulary is mode-specific (§8):
  constraint execs_status_by_mode check (
    (mode = 'apply' and status in
      ('applied', 'partial', 'blocked', 'failed', 'no_op'))
    or
    (mode = 'dry_run' and status in
      ('would_apply', 'would_partial', 'would_block', 'would_no_op',
       'would_fail_validation'))
  ),

  -- Everything belongs together, database-proven:
  constraint execs_sweep_same_org foreign key (sweep_id, organization_id)
    references public.automation_sweeps (id, organization_id) on delete restrict,
  constraint execs_rule_same_org foreign key (automation_rule_id, organization_id)
    references public.automation_rules (id, organization_id) on delete restrict,
  constraint execs_mention_same_org foreign key (mention_id, organization_id)
    references public.mentions (id, organization_id) on delete restrict,
  constraint execs_analysis_same_mention
    foreign key (trigger_analysis_id, mention_id, organization_id)
    references public.mention_analyses (id, mention_id, organization_id)
    on delete restrict,
  -- Location equals the MENTION's location, not merely "a location in this
  -- organization" — the FK targets the mention row's own triple (F14):
  constraint execs_location_is_mentions
    foreign key (mention_id, organization_id, location_id)
    references public.mentions (id, organization_id, location_id)
    on update cascade,

  constraint execs_idempotent unique
    (automation_rule_id, rule_revision, mention_id, trigger_analysis_id, mode)
);

comment on table public.automation_rule_executions is
  'Service role writes; authenticated members read per RLS. Rows are operational history: restrict deletes.';

create index execs_by_org_rule_recent
  on public.automation_rule_executions
  (organization_id, automation_rule_id, started_at desc);
create index execs_by_mention
  on public.automation_rule_executions (organization_id, mention_id);
create index execs_by_location
  on public.automation_rule_executions (organization_id, location_id)
  where location_id is not null;

alter table public.automation_rules
  drop column last_run_at,
  add column last_evaluated_at timestamptz,
  add column last_matched_at timestamptz,
  add column last_applied_at timestamptz;

comment on column public.automation_rules.last_applied_at is
  'Written only by apply-mode sweeps via greatest(); dry run never touches it.';
