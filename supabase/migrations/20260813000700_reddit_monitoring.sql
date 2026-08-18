-- Reddit monitoring schema (Task 3 of the Reddit plan).
--
-- Five new tables and nine new columns on `mentions`. The shape is argued at
-- length in the plan; the decisions worth restating where somebody will read
-- them next to the DDL are these.
--
-- 1. The discussion columns go on `mentions`, not on a Reddit-only table.
--    A threaded public conversation is not a Reddit idea, and forking the
--    canonical inbox for one source would undo the thing that makes the inbox
--    worth having (D21). They are all source-owned: `SOURCE_OWNED_MENTION_FIELDS`
--    in src/domain/entities/mention.ts is the single declaration of that line.
--
-- 2. Reddit monitors get their own table rather than a `platform` column on
--    `monitoring_queries`. That table is news: publisher domains, a country,
--    a language, a GNews relevance threshold. Half of it would be null on
--    every Reddit row and half of this would be null on every news row, and
--    the mature, tested news service would become a union of two incompatible
--    meanings.
--
-- 3. `reddit_query_matches` exists so location attribution can be *derived*
--    from every query that matched, rather than claimed by whichever poll ran
--    first. Two location monitors for one brand routinely match the same
--    thread, and on Reddit the attribution decides which restaurant's team
--    sees it.
--
-- 4. New state vocabularies are check-constrained text, not Postgres enums.
--    An enum value cannot be dropped, and these lists are young — the cost of
--    being wrong about `reddit_poll_run_kind` should be an editable
--    constraint, not a permanent value. The two existing enums that genuinely
--    fit (`sync_trigger`) are reused rather than duplicated.
--
-- 5. `reddit_rate_limit_state` is the one table here with no organization
--    column, and that is deliberate rather than an omission. Reddit meters per
--    OAuth client: the budget is spent by every tenant at once, and exceeding
--    it takes down the deployment rather than one customer. It holds no
--    customer data, which is what makes a global table safe here.

-- ---------------------------------------------------------------------------
-- 1. Discussion columns on mentions.
-- ---------------------------------------------------------------------------

alter table public.mentions
  -- The post at the top of the thread. A root post carries its own external
  -- id here; a comment carries the root's. The self-reference is what makes
  -- "everything in this thread" one equality filter instead of a union, and
  -- what makes a thread with no comments yet still a thread.
  add column conversation_root_external_id text,
  -- Canonical and bare: `askculinary`, never `r/AskCulinary`. A posture keyed
  -- on one casing and a monitor configured with another would mean publishing
  -- into a community whose rules nobody checked.
  add column source_community text,
  -- Volatile. Refreshed, never treated as history.
  add column source_score integer,
  add column source_comment_count integer,
  add column source_is_locked boolean not null default false,
  add column source_is_archived boolean not null default false,
  add column source_is_nsfw boolean not null default false,
  -- When the source stopped carrying this content. What the retention
  -- contract counts from, and what stops Lia showing a customer's team words
  -- their author has withdrawn.
  add column source_removed_at timestamptz,
  -- When Lia last confirmed this still exists at the source. Distinct from
  -- `last_synced_at`, which says when a sync last *wrote* it: this is the
  -- clock the deletion window actually runs on.
  add column source_last_verified_at timestamptz;

alter table public.mentions
  add constraint mentions_discussion_counts_sane check (
    coalesce(source_comment_count, 0) >= 0
  ),
  -- Bare, lowercase, and within Reddit's own 3–21 character rule. Enforced
  -- here as well as in Zod because the canonical form is what every posture
  -- lookup joins on, and a stray `r/` would silently miss every one of them.
  add constraint mentions_source_community_canonical check (
    source_community is null or source_community ~ '^[a-z0-9][a-z0-9_]{2,20}$'
  );

-- Every mention in one thread, oldest first. The query the conversation
-- workspace runs, and the one a thread refresh runs to find what it already
-- holds.
create index mentions_conversation_root_idx
  on public.mentions (organization_id, conversation_root_external_id, published_at)
  where conversation_root_external_id is not null;

-- The deletion-reconciliation queue: what has gone longest without being
-- confirmed to still exist. Nulls first, because content never verified at
-- all is the most overdue, not the least.
create index mentions_verification_due_idx
  on public.mentions (source_last_verified_at nulls first)
  where conversation_root_external_id is not null and source_removed_at is null;

-- ---------------------------------------------------------------------------
-- 2. Reddit monitoring queries.
-- ---------------------------------------------------------------------------

-- Every element of a subreddit array is bare, lowercase, and within Reddit's
-- own 3–21 character rule.
--
-- A function rather than an inline expression because a CHECK constraint may
-- not contain a subquery, and `unnest` in a `bool_and` is one. The function is
-- immutable and touches no table, which is what keeps it legal in a CHECK —
-- the rule a constraint must never break is referencing other rows, and this
-- only ever looks at the value in front of it.
--
-- An empty array is valid: `bool_and` over no rows is null, and a monitor that
-- names no communities means "every community", not "an invalid list".
create function public.reddit_subreddits_canonical(names text[])
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(bool_and(value ~ '^[a-z0-9][a-z0-9_]{2,20}$'), true)
    from unnest(coalesce(names, '{}'::text[])) as value;
$$;

comment on function public.reddit_subreddits_canonical is
  'True when every element is a canonical bare subreddit name. Canonical form is what community-posture lookups join on, so a stray r/ prefix would silently miss every one of them.';

create table public.reddit_monitoring_queries (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  location_id           uuid,
  name                  text not null,
  -- Required terms, negative terms, and the community allow/deny lists.
  -- Arrays rather than child tables: they are edited as a unit on one form,
  -- read as a unit by the gate, and never joined against.
  terms                 text[] not null,
  exclusions            text[] not null default '{}',
  allowed_subreddits    text[] not null default '{}',
  denied_subreddits     text[] not null default '{}',
  include_nsfw          boolean not null default false,
  relevance_threshold   numeric not null default 0.35,
  enabled               boolean not null default true,
  poll_interval_minutes integer not null default 60,
  origin                text not null default 'user',
  -- A high-water mark, not a provider cursor, and the difference is
  -- load-bearing. A Reddit listing is mutable — posts are edited, removed, and
  -- re-scored, and `new` re-orders underneath you — so a cursor advanced past
  -- a page loses whatever moved. Polling re-reads an overlapping window and
  -- relies on fullname uniqueness to make the overlap a no-op.
  last_polled_at        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint rmq_name_length check (char_length(name) between 1 and 120),
  constraint rmq_origin_known check (origin in ('user', 'onboarding')),
  -- A monitor with no required term matches everything, which is not a
  -- monitor. The upper bounds keep one save's provider cost predictable.
  --
  -- Every arm is wrapped in `coalesce(..., 0)`, including the lower bound, and
  -- that is load-bearing rather than stylistic: `array_length('{}', 1)` returns
  -- **null**, not zero, and a CHECK only rejects `false` — a null passes. The
  -- first draft of this constraint read `array_length(terms, 1) between 1 and
  -- 20` and cheerfully accepted an empty `terms` array, which is precisely the
  -- match-everything monitor it was written to prevent. Same trap D163 names
  -- for the rule-action validator.
  constraint rmq_terms_bounded check (
    coalesce(array_length(terms, 1), 0) between 1 and 20
    and coalesce(array_length(exclusions, 1), 0) <= 40
    and coalesce(array_length(allowed_subreddits, 1), 0) <= 100
    and coalesce(array_length(denied_subreddits, 1), 0) <= 100
  ),
  -- Canonical form, checked per element. The same rule `mentions.source_community`
  -- carries, for the same reason: these are what a posture lookup joins on.
  constraint rmq_subreddits_canonical check (
    public.reddit_subreddits_canonical(allowed_subreddits || denied_subreddits)
  ),
  constraint rmq_threshold_unit check (relevance_threshold between 0 and 1),
  -- Below the floor, polling burns the negotiated request budget. The ceiling
  -- is one week: a monitor slower than that is off, and should say so.
  constraint rmq_interval_bounded check (poll_interval_minutes between 15 and 10080),

  constraint rmq_location_same_org foreign key (location_id, organization_id)
    references public.locations (id, organization_id) on delete set null,
  -- Backing unique for the composite FKs the match and run tables carry.
  constraint reddit_monitoring_queries_id_org unique (id, organization_id)
);

-- The due-work scan cron runs: enabled monitors whose interval has elapsed.
create index reddit_monitoring_queries_due_idx
  on public.reddit_monitoring_queries (last_polled_at nulls first)
  where enabled;

create index reddit_monitoring_queries_org_idx
  on public.reddit_monitoring_queries (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Poll runs.
-- ---------------------------------------------------------------------------

create table public.reddit_poll_runs (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  kind                      text not null,
  reddit_monitoring_query_id uuid,
  root_external_id          text,
  status                    text not null default 'running',
  trigger                   sync_trigger not null,
  -- Nulled rather than cascaded: offboarding a person must not erase the
  -- record that a poll ran.
  actor_user_id             uuid references public.users (id) on delete set null,
  started_at                timestamptz not null default now(),
  completed_at              timestamptz,
  -- Lease expiry, so a crashed worker's run can be reclaimed rather than
  -- pinning the unit at `running` forever.
  claim_expires_at          timestamptz,
  requests_spent            integer not null default 0,
  posts_evaluated           integer not null default 0,
  posts_accepted            integer not null default 0,
  comments_ingested         integer not null default 0,
  malformed_count           integer not null default 0,
  -- Reason → count. Deliberately a tally and not a list of what was refused:
  -- the news gate keeps whole rejected candidates so it can be tuned, which
  -- was right for news and is wrong here, because keeping refused Reddit posts
  -- would mean storing content Lia decided it had no reason to hold, under the
  -- same retention obligations as content it did.
  rejected_reason_counts    jsonb not null default '{}'::jsonb,
  -- Coverage was incomplete: the listing was capped, the comment budget ran
  -- out, or the rate budget did. Surfaced rather than swallowed — partial
  -- coverage reported as success is what makes a monitoring product
  -- untrustworthy.
  truncated                 boolean not null default false,
  rate_limit_remaining      integer,
  -- A normalised Lia code. There is deliberately no `error_message` column:
  -- a provider sentence can quote the content that caused it, and an
  -- operator-facing run record is not the place to find that out.
  error_code                text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint rpr_kind_known check (kind in ('search', 'thread_refresh', 'deletion_reconcile')),
  constraint rpr_status_known check (status in ('running', 'completed', 'failed')),
  -- Each kind names its own subject, and only its own. A search without a
  -- query and a thread refresh without a root are both incoherent, and a
  -- reconcile carries neither because it sweeps the whole organization.
  constraint rpr_subject_matches_kind check (
    case kind
      when 'search' then reddit_monitoring_query_id is not null and root_external_id is null
      when 'thread_refresh' then root_external_id is not null and reddit_monitoring_query_id is null
      else reddit_monitoring_query_id is null and root_external_id is null
    end
  ),
  constraint rpr_running_shape check (
    status <> 'running' or (completed_at is null and error_code is null)
  ),
  constraint rpr_completed_shape check (
    status <> 'completed' or (completed_at is not null and error_code is null)
  ),
  constraint rpr_failed_shape check (
    status <> 'failed' or (completed_at is not null and error_code is not null)
  ),
  constraint rpr_counts_sane check (
    requests_spent >= 0 and posts_evaluated >= 0 and posts_accepted >= 0
    and comments_ingested >= 0 and malformed_count >= 0
    and posts_accepted <= posts_evaluated
    and coalesce(rate_limit_remaining, 0) >= 0
  ),
  constraint rpr_root_is_post_fullname check (
    root_external_id is null or root_external_id ~ '^t3_[a-z0-9]{1,20}$'
  ),
  constraint rpr_query_same_org foreign key (reddit_monitoring_query_id, organization_id)
    references public.reddit_monitoring_queries (id, organization_id) on delete cascade
);

-- One live unit of work per subject. Partial unique indexes rather than one
-- index over a coalesced expression, because the three kinds have three
-- different subjects and a single index would have to invent a shared key.
create unique index reddit_poll_runs_one_active_search
  on public.reddit_poll_runs (reddit_monitoring_query_id)
  where status = 'running' and kind = 'search';

create unique index reddit_poll_runs_one_active_thread
  on public.reddit_poll_runs (organization_id, root_external_id)
  where status = 'running' and kind = 'thread_refresh';

create unique index reddit_poll_runs_one_active_reconcile
  on public.reddit_poll_runs (organization_id)
  where status = 'running' and kind = 'deletion_reconcile';

create index reddit_poll_runs_org_recency_idx
  on public.reddit_poll_runs (organization_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 4. Query matches.
-- ---------------------------------------------------------------------------

create table public.reddit_query_matches (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid not null references public.organizations (id) on delete cascade,
  reddit_monitoring_query_id uuid not null,
  mention_id                 uuid not null,
  -- Which of the monitor's terms actually hit. Lia's own configured words,
  -- never an excerpt of the Reddit post.
  matched_terms              text[] not null default '{}',
  match_score                numeric not null,
  first_matched_at           timestamptz not null default now(),
  last_matched_at            timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint rqm_score_unit check (match_score between 0 and 1),
  constraint rqm_terms_bounded check (coalesce(array_length(matched_terms, 1), 0) <= 20),
  constraint rqm_match_order check (last_matched_at >= first_matched_at),
  -- One row per (query, mention). A second poll of the same monitor finding
  -- the same post updates `last_matched_at`; it does not add a match.
  constraint reddit_query_matches_unique unique (reddit_monitoring_query_id, mention_id),
  constraint rqm_query_same_org foreign key (reddit_monitoring_query_id, organization_id)
    references public.reddit_monitoring_queries (id, organization_id) on delete cascade,
  constraint rqm_mention_same_org foreign key (mention_id, organization_id)
    references public.mentions (id, organization_id) on delete cascade
);

-- Every match for one mention: what location attribution is derived from.
create index reddit_query_matches_mention_idx
  on public.reddit_query_matches (mention_id);

-- ---------------------------------------------------------------------------
-- 5. Community postures.
-- ---------------------------------------------------------------------------

create table public.reddit_community_postures (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  subreddit          text not null,
  posture            text not null default 'unknown',
  rules_url          text,
  -- A hash of the fetched rules, never the rules text, which is Reddit's.
  -- This is what makes `allowed` revocable without a person watching: when a
  -- refresh finds the hash has moved, the posture returns to review. An
  -- `allowed` granted against rules that no longer exist is a stale note, not
  -- a permission.
  rules_hash         text,
  rules_checked_at   timestamptz,
  decided_by_user_id uuid references public.users (id) on delete set null,
  decided_at         timestamptz,
  -- An operator's own note. Free text a person typed, never provider text.
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint rcp_posture_known check (
    posture in ('unknown', 'review_required', 'allowed', 'blocked')
  ),
  constraint rcp_subreddit_canonical check (subreddit ~ '^[a-z0-9][a-z0-9_]{2,20}$'),
  constraint rcp_note_length check (note is null or char_length(note) <= 1000),
  -- A decision without a decider is not a decision. Publishing checks for a
  -- named person and a date, so a row that could hold `allowed` with neither
  -- would be a permission nobody granted.
  constraint rcp_decision_named check (
    posture in ('unknown', 'review_required')
    or (decided_by_user_id is not null and decided_at is not null)
  ),
  constraint reddit_community_postures_unique unique (organization_id, subreddit),
  constraint reddit_community_postures_id_org unique (id, organization_id)
);

-- ---------------------------------------------------------------------------
-- 6. The provider-global rate budget.
--
-- No organization column, no RLS policy, no grant to `authenticated`. Reddit
-- meters per OAuth client, so this is a property of the deployment rather than
-- of any customer, and it holds nothing that belongs to one. An in-memory
-- limiter would be worse than none here: a per-instance counter on a platform
-- that runs many instances is not a limit, it is a multiplier.
-- ---------------------------------------------------------------------------

create table public.reddit_rate_limit_state (
  id            uuid primary key default gen_random_uuid(),
  -- Which OAuth client this budget belongs to. An identifier, never the secret.
  client_key_id text not null unique,
  remaining     integer not null default 0,
  reset_at      timestamptz,
  observed_at   timestamptz not null default now(),
  -- Requests handed out but not yet accounted for by a response header.
  -- Subtracted from `remaining` before a call is allowed, so concurrent
  -- workers cannot each see the same headroom and all spend it.
  reserved      integer not null default 0,
  updated_at    timestamptz not null default now(),

  constraint rrls_counts_sane check (remaining >= 0 and reserved >= 0)
);

comment on table public.reddit_rate_limit_state is
  'Provider-global Reddit request budget, keyed on the OAuth client. Deliberately not tenant-scoped: Reddit meters per client, so the limit is consumed across every organization at once. Service role only — no RLS policy and no grant to authenticated.';
