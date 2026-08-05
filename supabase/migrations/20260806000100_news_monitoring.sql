-- ---------------------------------------------------------------------------
-- News monitoring
--
-- Lia's first source with no account behind it. A Google review arrives bound
-- to a location because the sync asked a specific listing for it; a news
-- article arrives bound to nothing, so a monitoring query is what decides both
-- what Lia looks for and which restaurant a match concerns.
-- ---------------------------------------------------------------------------

create type monitoring_query_type as enum ('brand', 'location', 'person', 'topic');

comment on type monitoring_query_type is
  'Weights the relevance gate. A location query weights publisher locality heavily; a brand query does not.';

create type gate_rejection_reason as enum (
  'excluded_term', 'probable_syndication', 'domain_denied', 'below_threshold'
);

comment on type gate_rejection_reason is
  'Lia''s own vocabulary. No provider supplies one of these.';

create table public.monitoring_queries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Null is organization-wide. Set means a match attributes to this location.
  location_id uuid references public.locations (id) on delete set null,
  name text not null check (length(trim(name)) > 0 and length(name) <= 120),
  query_type monitoring_query_type not null,
  keywords text[] not null check (cardinality(keywords) between 1 and 20),
  exclusions text[] not null default '{}' check (cardinality(exclusions) <= 40),
  -- Empty means every domain is allowed. Also the locality signal for a
  -- location query, which is why it is not merely a filter.
  allowed_domains text[] not null default '{}' check (cardinality(allowed_domains) <= 200),
  denied_domains text[] not null default '{}' check (cardinality(denied_domains) <= 200),
  source_country char(2),
  language text,
  relevance_threshold numeric(4, 3) not null default 0.350
    check (relevance_threshold >= 0 and relevance_threshold <= 1),
  enabled boolean not null default true,
  -- Floored at 60: the free tier allows 100 requests a day across every tenant,
  -- so a per-minute poll would exhaust it before lunch.
  poll_interval_minutes integer not null default 360
    check (poll_interval_minutes between 60 and 10080),
  -- Doubles as the incremental cursor. Deliberately unlike Google, which
  -- refetches in full because it reorders on edit.
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.monitoring_queries is
  'What Lia watches. The entity a connector-based source never needed, because a news article arrives bound to no location.';
comment on column public.monitoring_queries.last_polled_at is
  'Also the fetch cursor: the next poll asks the provider for articles published after this.';
comment on column public.monitoring_queries.allowed_domains is
  'Empty means unrestricted. Non-empty also raises the gate score for a location query, so it is a relevance signal and not only a filter.';

create index monitoring_queries_due_idx
  on public.monitoring_queries (enabled, last_polled_at nulls first)
  where enabled;

create table public.news_poll_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  monitoring_query_id uuid not null
    references public.monitoring_queries (id) on delete cascade,
  trigger sync_trigger not null default 'scheduled',
  -- Nulled rather than cascaded: an offboarded employee must not erase the
  -- record that a poll happened.
  actor_user_id uuid references public.users (id) on delete set null,
  status sync_run_status not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  candidates_evaluated integer not null default 0 check (candidates_evaluated >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  requests_spent integer not null default 0 check (requests_spent >= 0),
  -- The provider capped the page and offers no paging on this tier. Recorded
  -- so a truncated poll never reads as a quiet news day.
  truncated boolean not null default false,
  gate_score_min numeric(4, 3) check (gate_score_min between 0 and 1),
  gate_score_mean numeric(4, 3) check (gate_score_mean between 0 and 1),
  gate_score_max numeric(4, 3) check (gate_score_max between 0 and 1),
  error_code text,
  -- Lia's own wording. Provider error text is never stored: it quotes request
  -- URLs and can echo the API key.
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint news_poll_runs_finished_has_timestamp
    check (status = 'running' or completed_at is not null),
  constraint news_poll_runs_running_is_clean
    check (status <> 'running' or (completed_at is null and error_code is null)),
  constraint news_poll_runs_error_requires_code
    check (error_message is null or error_code is not null),
  constraint news_poll_runs_failure_has_reason
    check (status <> 'failed' or error_code is not null)
);

comment on table public.news_poll_runs is
  'One attempt to poll one monitoring query. Its own table rather than a reuse of platform_sync_runs, whose platform_profile_id is not null and which news has nothing to put in.';

-- The lock. A partial unique index rather than an application check, which
-- would be two statements with a race between them — and serverless means two
-- requests are routinely two processes.
create unique index news_poll_runs_one_active
  on public.news_poll_runs (monitoring_query_id)
  where status = 'running';

create index news_poll_runs_query_started_idx
  on public.news_poll_runs (monitoring_query_id, started_at desc);

create index news_poll_runs_org_started_idx
  on public.news_poll_runs (organization_id, started_at desc);

create table public.news_rejected_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  monitoring_query_id uuid not null
    references public.monitoring_queries (id) on delete cascade,
  news_poll_run_id uuid not null
    references public.news_poll_runs (id) on delete cascade,
  external_id text not null check (length(trim(external_id)) > 0),
  url text not null,
  title text not null default '',
  publisher_domain text not null default '',
  reason gate_rejection_reason not null,
  score numeric(4, 3) not null check (score >= 0 and score <= 1),
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.news_rejected_candidates is
  'Every article the gate refused, with the reason and the score. An article Lia rejected looks exactly like an article nobody wrote, and without this row the gate cannot be falsified or tuned. Retained 30 days.';

create index news_rejected_candidates_query_created_idx
  on public.news_rejected_candidates (monitoring_query_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Mentions gain four platform-neutral columns
--
-- Same trade accepted for Google in D21: extend the canonical model rather than
-- fork the inbox. A Reddit crosspost has the same shape as a syndicated story,
-- so none of these are news-only in principle.
-- ---------------------------------------------------------------------------

alter table public.mentions
  add column publisher_name text,
  add column publisher_domain text,
  add column is_syndicated boolean not null default false,
  add column monitoring_query_id uuid
    references public.monitoring_queries (id) on delete set null;

comment on column public.mentions.monitoring_query_id is
  'The query that first found this. Not overwritten on conflict: an article naming two restaurants attributes to whichever query saw it first.';
comment on column public.mentions.is_syndicated is
  'Set by Lia''s own gate, not by a provider. The free news tier offers no clustering flag.';

create index mentions_monitoring_query_idx
  on public.mentions (monitoring_query_id)
  where monitoring_query_id is not null;
