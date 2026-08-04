# News Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add news and media monitoring to Lia — monitoring queries, a GNews-backed connector, a deterministic relevance gate, and scheduled polling that lands articles in the existing unified inbox.

**Architecture:** A new `NewsMonitor` boundary sits alongside `PlatformConnector` rather than inside it, because a search API shares almost nothing with an OAuth connector. A cron route polls due `monitoring_queries`, passes each candidate article through a pure relevance gate, and ingests survivors through the existing `mentions.ingest()`. A second cron runs the existing `analyzeMentions()` over the results.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Zod 4, Supabase/PostgreSQL, Vitest 4, Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-08-04-news-monitoring-design.md`. Read it before starting. Decisions are cited as D60–D72 throughout.

## Global Constraints

- TypeScript `strict` **and** `noUncheckedIndexedAccess`. No `any` without a justifying comment.
- Server components by default. Client components only where interactivity requires them.
- Sentence case in all interface copy.
- No page component over roughly 300 lines.
- Every organization-owned repository method takes an `OrganizationScope`. There is no `listAll()`.
- **No provider message reaches a user, a log, a stored row, or an audit event.** Store Lia's own wording and a normalised error code. Never the provider's text, never a request URL, never an API key.
- **The gate never writes `mentions.relevance_score`** (D65). That column belongs to the analysis layer.
- **An ingest writes only source-owned fields.** Use `IngestMentionInput`; never reach around it.
- Migrations are never edited once written — add a new one.
- `supabase/seed.sql` is **generated**. Edit `src/lib/seed/dataset.ts` and run `npm run db:seed:generate`.
- Mock modes are refused at environment parse in production (D20).
- Commit after every task. Run `npm run verify` before the final commit of each task that touches TypeScript.

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `src/domain/entities/monitoring.ts` | Zod schemas for `MonitoringQuery`, `NewsPollRun`, `NewsRejectedCandidate` |
| `src/news/monitor.ts` | The `NewsMonitor` interface and its provider-neutral types |
| `src/news/errors.ts` | `NewsError` and its normalised codes |
| `src/news/gnews/client.ts` | GNews HTTP calls. The only network I/O |
| `src/news/gnews/normalise.ts` | GNews payload → `ExternalArticle` |
| `src/news/gnews/monitor.ts` | `GNewsMonitor implements NewsMonitor` |
| `src/news/mock-monitor.ts` | Deterministic fixture monitor |
| `src/news/registry.ts` | Mode selection, mirroring `src/integrations/registry.ts` |
| `src/lib/monitoring/gate.ts` | The relevance gate. Pure function, no I/O |
| `src/lib/monitoring/budget.ts` | Daily request budget (D67) |
| `src/lib/monitoring/poll-service.ts` | Poll orchestration: lock, search, gate, ingest, audit |
| `src/lib/monitoring/capabilities.ts` | Honest capability list for the integration screen |
| `src/lib/data/demo/monitoring.ts` | Demo adapter for the three new repositories |
| `src/lib/data/supabase/monitoring.ts` | Supabase adapter for the same |
| `src/app/actions/monitoring.ts` | Server actions: query CRUD, manual poll |
| `src/app/api/cron/news-poll/route.ts` | Scheduled poll entry point |
| `src/app/api/cron/analyze-mentions/route.ts` | Scheduled analysis entry point |
| `src/app/(app)/integrations/news-media/page.tsx` | Connection detail screen |
| `src/components/integrations/monitoring-query-form.tsx` | Query editor (client) |
| `src/components/integrations/monitoring-query-list.tsx` | Query list (server) |
| `src/components/integrations/poll-run-history.tsx` | Run history and rejections (server) |
| `supabase/migrations/20260806000100_news_monitoring.sql` | Tables, enums, indexes, constraints |
| `supabase/migrations/20260806000200_news_monitoring_rls.sql` | Row-level security |
| `vercel.ts` | Cron schedules |

**Modify:** `src/domain/enums.ts`, `src/domain/entities/mention.ts`, `src/domain/index.ts`, `src/lib/data/types.ts`, `src/lib/data/demo/index.ts`, `src/lib/data/demo/store.ts`, `src/lib/data/supabase/index.ts`, `src/lib/auth/permissions.ts`, `src/lib/env.ts`, `src/lib/seed/dataset.ts`, `src/app/(app)/media/[id]/page.tsx`, `docs/architecture/current-state.md`.

New repositories live in their own adapter files rather than growing `demo/index.ts` (1,794 lines) and `supabase/index.ts` (2,082 lines) further.

---

### Task 1: Domain schemas and enums

**Files:**
- Create: `src/domain/entities/monitoring.ts`
- Modify: `src/domain/enums.ts`, `src/domain/index.ts`
- Test: `tests/monitoring-domain.test.ts`

**Interfaces:**
- Consumes: `organizationOwnedSchema`, `timestampsSchema`, `timestampSchema`, `uuidSchema`, `unitScoreSchema` from `@/domain/primitives`; `syncRunStatusSchema`, `syncTriggerSchema` from `@/domain/enums`.
- Produces: `MonitoringQuery`, `MonitoringQueryType`, `NewsPollRun`, `NewsRejectedCandidate`, `GateRejectionReason`, `monitoringQuerySchema`, `createMonitoringQueryInputSchema`, `updateMonitoringQueryInputSchema`, `newsPollRunSchema`, `newsRejectedCandidateSchema`.

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring-domain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createMonitoringQueryInputSchema,
  monitoringQuerySchema,
  newsPollRunSchema,
} from "@/domain/entities/monitoring";

const BASE = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  locationId: null,
  name: "Brand mentions",
  queryType: "brand" as const,
  keywords: ["Gramercy Tavern"],
  exclusions: [],
  allowedDomains: [],
  deniedDomains: [],
  sourceCountry: null,
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
  lastPolledAt: null,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

describe("monitoringQuerySchema", () => {
  it("accepts a well-formed query", () => {
    expect(monitoringQuerySchema.parse(BASE).name).toBe("Brand mentions");
  });

  it("requires at least one keyword", () => {
    expect(() => monitoringQuerySchema.parse({ ...BASE, keywords: [] })).toThrow();
  });

  it("rejects a threshold outside 0 to 1", () => {
    expect(() =>
      monitoringQuerySchema.parse({ ...BASE, relevanceThreshold: 1.5 }),
    ).toThrow();
  });

  it("rejects a poll interval below the floor", () => {
    expect(() =>
      monitoringQuerySchema.parse({ ...BASE, pollIntervalMinutes: 5 }),
    ).toThrow();
  });
});

describe("createMonitoringQueryInputSchema", () => {
  it("cannot carry an organizationId", () => {
    const parsed = createMonitoringQueryInputSchema.parse({
      ...BASE,
      organizationId: "33333333-3333-4333-8333-333333333333",
    });
    expect(parsed).not.toHaveProperty("organizationId");
  });
});

describe("newsPollRunSchema", () => {
  it("rejects negative counters", () => {
    expect(() =>
      newsPollRunSchema.parse({
        id: BASE.id,
        organizationId: BASE.organizationId,
        monitoringQueryId: BASE.id,
        trigger: "scheduled",
        actorUserId: null,
        status: "running",
        startedAt: BASE.createdAt,
        completedAt: null,
        candidatesEvaluated: -1,
        acceptedCount: 0,
        rejectedCount: 0,
        requestsSpent: 0,
        truncated: false,
        gateScoreMin: null,
        gateScoreMean: null,
        gateScoreMax: null,
        errorCode: null,
        errorMessage: null,
        createdAt: BASE.createdAt,
        updatedAt: BASE.updatedAt,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/monitoring-domain.test.ts`
Expected: FAIL — cannot resolve `@/domain/entities/monitoring`.

- [ ] **Step 3: Add the enums**

In `src/domain/enums.ts`, append alongside the existing enum exports (match the surrounding `z.enum` + inferred-type style exactly):

```ts
/**
 * What a monitoring query is looking for.
 *
 * Not decoration: the relevance gate weights signals differently per type. A
 * location query weights publisher locality heavily; a brand query does not.
 */
export const monitoringQueryTypeSchema = z.enum([
  "brand",
  "location",
  "person",
  "topic",
]);
export type MonitoringQueryType = z.infer<typeof monitoringQueryTypeSchema>;

/**
 * Why the gate refused a candidate.
 *
 * Lia's own vocabulary. No provider ever supplies one of these, and the reason
 * is what makes the gate tunable rather than a black box (D64).
 */
export const gateRejectionReasonSchema = z.enum([
  "excluded_term",
  "probable_syndication",
  "domain_denied",
  "below_threshold",
]);
export type GateRejectionReason = z.infer<typeof gateRejectionReasonSchema>;
```

- [ ] **Step 4: Create the entity schemas**

Create `src/domain/entities/monitoring.ts`:

```ts
import { z } from "zod";
import {
  gateRejectionReasonSchema,
  monitoringQueryTypeSchema,
  syncRunStatusSchema,
  syncTriggerSchema,
} from "@/domain/enums";
import {
  languageTagSchema,
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  unitScoreSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * What Lia watches.
 *
 * The entity Google never needed. A review sync knows what to fetch because a
 * listing was mapped to a location; a news poll has no such anchor, so the
 * query itself is the anchor.
 */

/** Below this, polling would burn the daily request budget (D67). */
export const MIN_POLL_INTERVAL_MINUTES = 60;
/** The GNews free tier returns at most this many articles per request. */
export const MAX_ARTICLES_PER_POLL = 10;
/** A repeated headline inside this window is treated as syndication (D68). */
export const SYNDICATION_WINDOW_MS = 72 * 60 * 60 * 1000;
/**
 * How long a rejection is kept.
 *
 * This table writes far more rows per run than a sync does, so unlike
 * `platform_sync_runs` it has a retention policy from the start.
 */
export const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const termSchema = z.string().trim().min(2).max(120);
const domainSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, "Use a bare domain, without a scheme or path.");

export const monitoringQuerySchema = z
  .object({
    /** Null means organization-wide. Set means articles attribute here. */
    locationId: uuidSchema.nullable(),
    name: z.string().trim().min(1).max(120),
    queryType: monitoringQueryTypeSchema,
    /** Required terms. Pushed down to the provider. */
    keywords: z.array(termSchema).min(1).max(20),
    /** Negative terms. GNews supports NOT, so these push down too. */
    exclusions: z.array(termSchema).max(40),
    /** Empty means every domain is allowed. Also the locality signal. */
    allowedDomains: z.array(domainSchema).max(200),
    deniedDomains: z.array(domainSchema).max(200),
    /** ISO 3166-1 alpha-2. What GNews actually filters on. */
    sourceCountry: z.string().length(2).toLowerCase().nullable(),
    language: languageTagSchema.nullable(),
    /** Gate admission floor. Tuned against `news_rejected_candidates`. */
    relevanceThreshold: unitScoreSchema,
    enabled: z.boolean(),
    pollIntervalMinutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES).max(10_080),
    /** Doubles as the incremental cursor: `publishedAfter` (D66). */
    lastPolledAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type MonitoringQuery = z.infer<typeof monitoringQuerySchema>;

/**
 * `organizationId` is absent on purpose: the tenant comes from the caller's
 * verified scope, never from the payload. Same rule as `CreateMentionInput`.
 */
export const createMonitoringQueryInputSchema = monitoringQuerySchema.omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
  lastPolledAt: true,
});
export type CreateMonitoringQueryInput = z.infer<
  typeof createMonitoringQueryInputSchema
>;

/** `lastPolledAt` is absent: only the poll service advances the cursor. */
export const updateMonitoringQueryInputSchema =
  createMonitoringQueryInputSchema.partial();
export type UpdateMonitoringQueryInput = z.infer<
  typeof updateMonitoringQueryInputSchema
>;

/**
 * One attempt to poll one monitoring query.
 *
 * Its own table rather than a reuse of `platform_sync_runs`, whose
 * `platform_profile_id` is `not null` and which news has nothing to put in
 * (D63).
 */
export const newsPollRunSchema = z
  .object({
    monitoringQueryId: uuidSchema,
    trigger: syncTriggerSchema,
    /** Nulled rather than cascaded: offboarding must not erase the record. */
    actorUserId: uuidSchema.nullable(),
    status: syncRunStatusSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    candidatesEvaluated: z.number().int().min(0),
    acceptedCount: z.number().int().min(0),
    rejectedCount: z.number().int().min(0),
    requestsSpent: z.number().int().min(0),
    /** The provider capped the page and there is no paging to follow. */
    truncated: z.boolean(),
    gateScoreMin: unitScoreSchema.nullable(),
    gateScoreMean: unitScoreSchema.nullable(),
    gateScoreMax: unitScoreSchema.nullable(),
    errorCode: z.string().max(80).nullable(),
    /** Lia's own sentence. Never the provider's message. */
    errorMessage: z.string().max(400).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type NewsPollRun = z.infer<typeof newsPollRunSchema>;

/**
 * An article the gate refused.
 *
 * "Why did you miss this story" is the first question asked of any monitoring
 * product, and without this row the gate is unfalsifiable (D64).
 */
export const newsRejectedCandidateSchema = z
  .object({
    monitoringQueryId: uuidSchema,
    newsPollRunId: uuidSchema,
    externalId: z.string().min(1).max(500),
    url: z.url(),
    title: z.string().max(400),
    publisherDomain: z.string().max(253),
    reason: gateRejectionReasonSchema,
    score: unitScoreSchema,
    publishedAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type NewsRejectedCandidate = z.infer<typeof newsRejectedCandidateSchema>;
```

- [ ] **Step 5: Export from the domain barrel**

In `src/domain/index.ts`, add alongside the existing entity re-exports:

```ts
export * from "@/domain/entities/monitoring";
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npx vitest run tests/monitoring-domain.test.ts`
Expected: PASS, 6 tests.

If `languageTagSchema` or `unitScoreSchema` is not exported from `@/domain/primitives`, open that file and use the exact names it does export — do not invent one.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/domain tests/monitoring-domain.test.ts
git commit -m "feat: add monitoring query and news poll run domain schemas"
```

---

### Task 2: Migration — tables

**Files:**
- Create: `supabase/migrations/20260806000100_news_monitoring.sql`
- Test: `npm run db:validate`

**Interfaces:**
- Consumes: `public.organizations`, `public.locations`, `public.users`, `public.mentions`, and the existing `sync_run_status` / `sync_trigger` enums.
- Produces: tables `monitoring_queries`, `news_poll_runs`, `news_rejected_candidates`; enums `monitoring_query_type`, `gate_rejection_reason`; columns `mentions.publisher_name`, `mentions.publisher_domain`, `mentions.is_syndicated`, `mentions.monitoring_query_id`.

- [ ] **Step 1: Read the migration you are modelling on**

Read `supabase/migrations/20260803000100_google_review_sync.sql` end to end. Match its commenting convention: every table and every non-obvious column gets a `comment on`, and the comment says *why*, not *what*.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260806000100_news_monitoring.sql`:

```sql
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
```

- [ ] **Step 3: Validate the migration parses**

Run: `npm run db:validate`
Expected: PASS. If it reports a parse error, fix the SQL — do not proceed with a migration that does not parse.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260806000100_news_monitoring.sql
git commit -m "feat: add news monitoring tables"
```

---

### Task 3: Migration — row-level security

**Files:**
- Create: `supabase/migrations/20260806000200_news_monitoring_rls.sql`
- Modify: `supabase/tests/rls-verification.sql`
- Test: `npm run db:validate`

**Interfaces:**
- Consumes: `public.is_organization_member(uuid)`, already defined.
- Produces: RLS enabled with select/insert/update/delete policies on all three new tables.

- [ ] **Step 1: Read the policy file you are modelling on**

Read `supabase/migrations/20260803000200_google_review_sync_rls.sql`. Note that no policy grants access on the basis of authentication alone — every one resolves through `is_organization_member`.

- [ ] **Step 2: Write the policies**

Create `supabase/migrations/20260806000200_news_monitoring_rls.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Row-level security for news monitoring
--
-- Reading is governed by active membership (D19): there is no view permission
-- for any of these, and rejected candidates in particular are diagnostic — the
-- person asking "why did we miss this" is often not an admin.
-- ---------------------------------------------------------------------------

alter table public.monitoring_queries enable row level security;
alter table public.news_poll_runs enable row level security;
alter table public.news_rejected_candidates enable row level security;

create policy monitoring_queries_select_members
  on public.monitoring_queries for select
  using (public.is_organization_member(organization_id));

create policy monitoring_queries_insert_members
  on public.monitoring_queries for insert
  with check (public.is_organization_member(organization_id));

create policy monitoring_queries_update_members
  on public.monitoring_queries for update
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy monitoring_queries_delete_members
  on public.monitoring_queries for delete
  using (public.is_organization_member(organization_id));

create policy news_poll_runs_select_members
  on public.news_poll_runs for select
  using (public.is_organization_member(organization_id));

create policy news_poll_runs_insert_members
  on public.news_poll_runs for insert
  with check (public.is_organization_member(organization_id));

create policy news_poll_runs_update_members
  on public.news_poll_runs for update
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy news_rejected_candidates_select_members
  on public.news_rejected_candidates for select
  using (public.is_organization_member(organization_id));

create policy news_rejected_candidates_insert_members
  on public.news_rejected_candidates for insert
  with check (public.is_organization_member(organization_id));

create policy news_rejected_candidates_delete_members
  on public.news_rejected_candidates for delete
  using (public.is_organization_member(organization_id));
```

The write permissions (`monitoring.manage_queries`, `monitoring.poll_now`) are enforced in the application layer by `assertPermission()`, exactly as the Google write paths are. RLS enforces the tenant boundary; the matrix enforces the role.

- [ ] **Step 3: Add isolation checks to the RLS verification harness**

Open `supabase/tests/rls-verification.sql` and follow its existing pattern precisely — it includes a self-test proving the checks can fail, and new checks must be written the same way. Add one check per new table asserting that a member of Harbor & Vine sees zero rows belonging to USHG.

- [ ] **Step 4: Validate**

Run: `npm run db:validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260806000200_news_monitoring_rls.sql supabase/tests/rls-verification.sql
git commit -m "feat: add row-level security for news monitoring tables"
```

---

### Task 4: Repository interfaces and demo adapter

**Files:**
- Create: `src/lib/data/demo/monitoring.ts`
- Modify: `src/lib/data/types.ts`, `src/lib/data/demo/store.ts`, `src/lib/data/demo/index.ts`
- Test: `tests/monitoring-repositories.test.ts`

**Interfaces:**
- Consumes: `OrganizationScope`, `MonitoringQuery`, `NewsPollRun`, `NewsRejectedCandidate`.
- Produces: `MonitoringQueryRepository`, `NewsPollRunRepository`, `NewsRejectedCandidateRepository`, `PollRunInProgressError`, `POLL_RUN_STALE_AFTER_MS`, and `dataSource.monitoringQueries` / `.newsPollRuns` / `.newsRejectedCandidates`.

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring-repositories.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { LiaDataSource } from "@/lib/data/types";
import { PollRunInProgressError } from "@/lib/data/errors";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

let dataSource: LiaDataSource;

const QUERY = {
  locationId: null,
  name: "Brand mentions",
  queryType: "brand" as const,
  keywords: ["Gramercy Tavern"],
  exclusions: [],
  allowedDomains: [],
  deniedDomains: [],
  sourceCountry: "us",
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
};

beforeEach(() => {
  dataSource = freshDataSource();
});

describe("monitoringQueries", () => {
  it("creates a query inside the caller's organization", async () => {
    const created = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    expect(created.organizationId).toBe(ushg.admin().organizationId);
    expect(created.lastPolledAt).toBeNull();
  });

  it("does not leak a query across tenants", async () => {
    await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const theirs = await dataSource.monitoringQueries.list(harbor.owner());
    expect(theirs.every((q) => q.name !== "Brand mentions")).toBe(true);
  });

  it("lists only due queries", async () => {
    const created = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const due = await dataSource.monitoringQueries.listDue(
      "2026-08-04T12:00:00.000Z",
      50,
    );
    expect(due.map((q) => q.id)).toContain(created.id);

    await dataSource.monitoringQueries.markPolled(
      ushg.admin(),
      created.id,
      "2026-08-04T12:00:00.000Z",
    );
    const after = await dataSource.monitoringQueries.listDue(
      "2026-08-04T13:00:00.000Z",
      50,
    );
    expect(after.map((q) => q.id)).not.toContain(created.id);
  });

  it("excludes a disabled query from the due list", async () => {
    const created = await dataSource.monitoringQueries.create(ushg.admin(), {
      ...QUERY,
      enabled: false,
    });
    const due = await dataSource.monitoringQueries.listDue(
      "2026-08-04T12:00:00.000Z",
      50,
    );
    expect(due.map((q) => q.id)).not.toContain(created.id);
  });
});

describe("newsPollRuns", () => {
  it("refuses a second concurrent run for one query", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });

    await expect(
      dataSource.newsPollRuns.start(ushg.admin(), {
        monitoringQueryId: query.id,
        trigger: "manual",
        actorUserId: ushg.admin().userId,
      }),
    ).rejects.toBeInstanceOf(PollRunInProgressError);
  });

  it("allows a new run once the previous one finished", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const first = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });
    await dataSource.newsPollRuns.finish(ushg.admin(), first.id, {
      status: "completed",
      candidatesEvaluated: 3,
      acceptedCount: 1,
      rejectedCount: 2,
      requestsSpent: 1,
      truncated: false,
      gateScoreMin: 0.1,
      gateScoreMean: 0.4,
      gateScoreMax: 0.8,
      errorCode: null,
      errorMessage: null,
    });

    const second = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "manual",
      actorUserId: ushg.admin().userId,
    });
    expect(second.status).toBe("running");
  });

  it("sums requests spent since an instant", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const run = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });
    await dataSource.newsPollRuns.finish(ushg.admin(), run.id, {
      status: "completed",
      candidatesEvaluated: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      requestsSpent: 4,
      truncated: false,
      gateScoreMin: 0.5,
      gateScoreMean: 0.5,
      gateScoreMax: 0.5,
      errorCode: null,
      errorMessage: null,
    });

    const spent = await dataSource.newsPollRuns.requestsSpentSince(
      "2026-01-01T00:00:00.000Z",
    );
    expect(spent).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/monitoring-repositories.test.ts`
Expected: FAIL — `dataSource.monitoringQueries` is undefined.

- [ ] **Step 3: Add the error class**

In `src/lib/data/errors.ts`, alongside the existing `SyncRunInProgressError` (copy its shape exactly):

```ts
/**
 * A poll is already open for this monitoring query.
 *
 * Raised by the partial unique index, not by a read-then-write check.
 */
export class PollRunInProgressError extends DataError {
  constructor(monitoringQueryId: string) {
    super(`A poll is already running for monitoring query ${monitoringQueryId}.`);
    this.name = "PollRunInProgressError";
  }
}
```

- [ ] **Step 4: Add the repository interfaces**

In `src/lib/data/types.ts`, add near `PlatformSyncRunRepository`:

```ts
/** A run left `running` by a dead process is reclaimed after this. */
export const POLL_RUN_STALE_AFTER_MS = 30 * 60 * 1000;

export interface StartPollRunInput {
  monitoringQueryId: string;
  trigger: NewsPollRun["trigger"];
  actorUserId: string | null;
}

export interface FinishPollRunInput {
  status: Exclude<NewsPollRun["status"], "running">;
  candidatesEvaluated: number;
  acceptedCount: number;
  rejectedCount: number;
  requestsSpent: number;
  truncated: boolean;
  gateScoreMin: number | null;
  gateScoreMean: number | null;
  gateScoreMax: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface MonitoringQueryRepository {
  list(scope: OrganizationScope): Promise<MonitoringQuery[]>;
  get(scope: OrganizationScope, queryId: string): Promise<MonitoringQuery | null>;
  create(
    scope: OrganizationScope,
    input: CreateMonitoringQueryInput,
  ): Promise<MonitoringQuery>;
  update(
    scope: OrganizationScope,
    queryId: string,
    input: UpdateMonitoringQueryInput,
  ): Promise<MonitoringQuery>;
  remove(scope: OrganizationScope, queryId: string): Promise<void>;
  /** Advance the cursor. Only the poll service calls this. */
  markPolled(
    scope: OrganizationScope,
    queryId: string,
    polledAt: string,
  ): Promise<MonitoringQuery>;
  /**
   * Enabled queries whose interval has elapsed, across every tenant.
   *
   * The one deliberately unscoped read in the repository layer. Cron holds no
   * membership and cannot construct a scope, so the poll service builds one per
   * row from `organizationId` (D70). Never call this from a request path.
   */
  listDue(now: string, limit: number): Promise<MonitoringQuery[]>;
}

export interface NewsPollRunRepository {
  /** Throws `PollRunInProgressError`. Reclaims runs older than the stale window. */
  start(scope: OrganizationScope, input: StartPollRunInput): Promise<NewsPollRun>;
  finish(
    scope: OrganizationScope,
    runId: string,
    input: FinishPollRunInput,
  ): Promise<NewsPollRun>;
  listForQuery(
    scope: OrganizationScope,
    queryId: string,
    limit?: number,
  ): Promise<NewsPollRun[]>;
  /** Global spend since an instant. Unscoped, because the budget is Lia's (D67). */
  requestsSpentSince(since: string): Promise<number>;
}

export interface NewsRejectedCandidateRepository {
  recordMany(
    scope: OrganizationScope,
    candidates: readonly Omit<
      NewsRejectedCandidate,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >[],
  ): Promise<void>;
  listForQuery(
    scope: OrganizationScope,
    queryId: string,
    limit?: number,
  ): Promise<NewsRejectedCandidate[]>;
  /** Delete rows older than the retention window. Returns the count removed. */
  purgeOlderThan(scope: OrganizationScope, before: string): Promise<number>;
}
```

Add the three to `LiaDataSource`:

```ts
  /** What Lia watches. */
  monitoringQueries: MonitoringQueryRepository;
  /** Poll history, and the lock that keeps runs from overlapping. */
  newsPollRuns: NewsPollRunRepository;
  /** Why the gate refused an article. Diagnostic, readable by any member. */
  newsRejectedCandidates: NewsRejectedCandidateRepository;
```

Import the new domain types at the top of the file alongside the existing domain imports.

- [ ] **Step 5: Add demo store collections**

In `src/lib/data/demo/store.ts`, add three arrays to the store shape and reset them in `resetDemoStore()`, matching how the existing collections are declared:

```ts
  monitoringQueries: MonitoringQuery[];
  newsPollRuns: NewsPollRun[];
  newsRejectedCandidates: NewsRejectedCandidate[];
```

- [ ] **Step 6: Implement the demo adapter**

Create `src/lib/data/demo/monitoring.ts`. It exports one factory returning the three repositories. Key behaviours, each of which a test above pins:

- `create` stamps `organizationId` from the scope, `lastPolledAt: null`, and both timestamps from the demo clock.
- `listDue` filters `enabled` and `lastPolledAt === null || lastPolledAt + interval <= now`, sorts oldest-cursor-first, and slices to `limit`. **Unscoped by design.**
- `start` scans for an existing `running` run on the same query; if one exists and started within `POLL_RUN_STALE_AFTER_MS` of now, it throws `PollRunInProgressError`; if it is older, it is marked `failed` with code `stale_reclaimed` and the new run opens. This mirrors the partial unique index plus reclaim in the Supabase adapter.
- `finish` sets `completedAt` and is a no-op on an already-finished run.
- `requestsSpentSince` sums `requestsSpent` across **all** organizations.

Read `src/lib/data/demo/index.ts` for the exact clock helper and id generator it uses, and use those — do not call `Date.now()` or `crypto.randomUUID()` directly, because demo mode is pinned to `REFERENCE_NOW` for stable fixtures.

- [ ] **Step 7: Wire it into the demo data source**

In `src/lib/data/demo/index.ts`, import the factory and add the three repositories to the returned object.

- [ ] **Step 8: Run the test and verify it passes**

Run: `npx vitest run tests/monitoring-repositories.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Verify nothing else broke, then commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/data tests/monitoring-repositories.test.ts
git commit -m "feat: add monitoring repositories and demo adapter"
```

---

### Task 5: Supabase adapter

**Files:**
- Create: `src/lib/data/supabase/monitoring.ts`
- Modify: `src/lib/data/supabase/index.ts`, `src/lib/data/supabase/mappers.ts`
- Test: `tests/monitoring-repositories.test.ts` (unchanged — this task must not break it)

**Interfaces:**
- Consumes: the interfaces from Task 4.
- Produces: `createMonitoringRepositories(client)` returning the same three repositories against PostgREST.

- [ ] **Step 1: Read the adapter you are mirroring**

Read how `platformSyncRuns` is implemented in `src/lib/data/supabase/index.ts`, in particular how it turns the unique-violation error code `23505` into `SyncRunInProgressError`. The news equivalent does the same with `PollRunInProgressError`.

- [ ] **Step 2: Add row mappers**

In `src/lib/data/supabase/mappers.ts`, add `mapMonitoringQueryRow`, `mapNewsPollRunRow`, and `mapNewsRejectedCandidateRow`, following the existing mappers exactly: snake_case column to camelCase field, `numeric` columns coerced with `Number(...)`, timestamps passed through as ISO strings, and the result run through the corresponding Zod schema so an unexpected column is stripped rather than serialised onward.

- [ ] **Step 3: Implement the repositories**

Create `src/lib/data/supabase/monitoring.ts`. Points where this differs from the demo adapter and where mistakes are likely:

- Every scoped method adds `.eq("organization_id", scope.organizationId)` even though RLS would also enforce it. Defence in depth is the existing convention — follow it.
- `start` inserts and catches PostgREST error code `23505` on `news_poll_runs_one_active`, rethrowing as `PollRunInProgressError`. Before inserting, it issues one conditional `UPDATE` marking any `running` run older than the stale window as `failed` with `error_code = 'stale_reclaimed'` — a single statement, so two concurrent reclaims cannot both win.
- `listDue` and `requestsSpentSince` are unscoped and must run under the service-role client. Add a comment saying so.
- `recordMany` inserts in one batch. An empty array must short-circuit rather than issuing an insert with no rows.

- [ ] **Step 4: Wire it into the Supabase data source**

In `src/lib/data/supabase/index.ts`, import the factory and add the three repositories to the returned object.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. The repository tests run against the demo adapter, so they should be unaffected; a failure here means the shared interface changed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/data/supabase
git commit -m "feat: add Supabase adapter for monitoring repositories"
```

---

### Task 6: The `NewsMonitor` boundary

**Files:**
- Create: `src/news/monitor.ts`, `src/news/errors.ts`
- Test: none of its own — this task defines types only, and Task 7 is its first consumer.

**Interfaces:**
- Produces: `NewsMonitor`, `NewsSearchQuery`, `NewsSearchBatch`, `ExternalArticle`, `NewsError`, `NewsErrorCode`.

- [ ] **Step 1: Define the error vocabulary**

Create `src/news/errors.ts`, modelled on `src/integrations/errors.ts`:

```ts
/**
 * Normalised news-provider failures.
 *
 * Chosen around what the operator must do next, not around what the provider
 * said. No provider message, request URL, or key ever travels in one of these.
 */
export type NewsErrorCode =
  | "unauthorized"      // The key is missing, wrong, or revoked
  | "rate_limited"      // Daily request allowance exhausted at the provider
  | "quota_exhausted"   // Lia's own budget ceiling, before a request was made
  | "provider_error"    // 5xx, or a response that could not be parsed
  | "invalid_query"     // The provider rejected the search terms
  | "not_configured";   // No mode selected, or no key in the environment

export class NewsError extends Error {
  constructor(
    readonly code: NewsErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NewsError";
  }
}
```

- [ ] **Step 2: Define the boundary**

Create `src/news/monitor.ts`:

```ts
import type { ConnectorCapabilities, JsonObject, Platform } from "@/domain";

/**
 * The news-monitoring boundary.
 *
 * Deliberately *not* `PlatformConnector`. Eight of that interface's ten methods
 * — authorization URL, code exchange, refresh, revoke, accounts, profiles —
 * have no meaning for a search API, and implementing them as throwers is the
 * `if (platform === "google")` that D9 exists to prevent, relocated inside the
 * interface. One method, following D35's precedent: there is one thing Lia asks
 * a news provider to do.
 */

/** A search in Lia's vocabulary. No provider parameter names appear here. */
export interface NewsSearchQuery {
  keywords: readonly string[];
  exclusions: readonly string[];
  /** ISO 3166-1 alpha-2, or null for everywhere the provider covers. */
  sourceCountry: string | null;
  /** BCP-47 tag, or null for every language. */
  language: string | null;
  /** The incremental cursor (D66). Null on a query's first ever poll. */
  publishedAfter: string | null;
  /** Hard ceiling on articles requested. The free tier caps this at 10. */
  maxResults: number;
}

/**
 * An article as the provider has it.
 *
 * Provider-neutral: Event Registry and NewsData normalise into this same shape,
 * which is the part that is expensive to retrofit. Nothing is
 * optional-by-omission — a field the provider may not supply is explicitly
 * nullable, so "not told" is a value the caller must handle.
 */
export interface ExternalArticle {
  /** The provider's identifier. The idempotency key. GNews uses the URL. */
  externalId: string;
  url: string;
  title: string;
  /**
   * Headline summary. Null when the provider gave none.
   *
   * The free tier supplies no article body, so this is the whole of the text
   * the analysis layer will see.
   */
  description: string | null;
  publisherName: string | null;
  publisherDomain: string | null;
  authorName: string | null;
  publishedAt: string;
  language: string | null;
  /** Named, reviewed provider fields. Never a spread of the raw response. */
  metadata: JsonObject;
}

export interface NewsSearchBatch {
  articles: ExternalArticle[];
  /** Requests consumed. Charged against the global daily budget (D67). */
  requestsSpent: number;
  /**
   * The provider capped the page and offers no paging on this tier.
   *
   * Recorded rather than ignored, so a truncated poll never reads as a quiet
   * news day.
   */
  truncated: boolean;
  /**
   * Items the provider sent that could not be normalised.
   *
   * Counted rather than thrown, so one unusable article does not cost a query
   * its other nine.
   */
  malformedCount: number;
}

export interface NewsMonitor {
  readonly platform: Platform;
  /** What this monitor can honestly do today. Drives the capability display. */
  capabilities(): ConnectorCapabilities;
  search(query: NewsSearchQuery): Promise<NewsSearchBatch>;
}
```

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
git add src/news
git commit -m "feat: add NewsMonitor boundary"
```

If `ConnectorCapabilities` does not exist with that name in `@/domain`, open `src/domain` and use the exact exported name.

---

### Task 7: GNews client and normalisation

**Files:**
- Create: `src/news/gnews/client.ts`, `src/news/gnews/normalise.ts`, `src/news/gnews/monitor.ts`
- Test: `tests/gnews-client.test.ts`

**Interfaces:**
- Consumes: `NewsMonitor`, `NewsSearchQuery`, `NewsSearchBatch`, `ExternalArticle`, `NewsError`.
- Produces: `GNewsMonitor` (class implementing `NewsMonitor`), `normaliseGNewsArticle(raw) => ExternalArticle | null`, `buildGNewsQuery(query) => string`.

- [ ] **Step 1: Write the failing test**

Create `tests/gnews-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GNewsMonitor } from "@/news/gnews/monitor";
import { buildGNewsQuery, normaliseGNewsArticle } from "@/news/gnews/normalise";
import { NewsError } from "@/news/errors";

const ARTICLE = {
  title: "Gramercy Tavern reopens after renovation",
  description: "The Union Square restaurant welcomes diners back.",
  content: "truncated on the free tier...",
  url: "https://example-paper.com/food/gramercy-reopens",
  image: "https://example-paper.com/img.jpg",
  publishedAt: "2026-08-03T09:00:00Z",
  source: { name: "Example Paper", url: "https://example-paper.com" },
};

const QUERY = {
  keywords: ["Gramercy Tavern"],
  exclusions: ["obituary"],
  sourceCountry: "us",
  language: "en",
  publishedAfter: "2026-08-01T00:00:00.000Z",
  maxResults: 10,
};

function stubFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("GNEWS_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildGNewsQuery", () => {
  it("quotes multi-word keywords and negates exclusions", () => {
    expect(buildGNewsQuery(QUERY)).toBe('"Gramercy Tavern" NOT obituary');
  });

  it("joins several keywords with OR", () => {
    expect(
      buildGNewsQuery({ ...QUERY, keywords: ["Gramercy Tavern", "Maialino"], exclusions: [] }),
    ).toBe('"Gramercy Tavern" OR Maialino');
  });
});

describe("normaliseGNewsArticle", () => {
  it("maps a well-formed article", () => {
    const result = normaliseGNewsArticle(ARTICLE);
    expect(result).not.toBeNull();
    expect(result?.externalId).toBe(ARTICLE.url);
    expect(result?.publisherDomain).toBe("example-paper.com");
    expect(result?.publisherName).toBe("Example Paper");
    expect(result?.publishedAt).toBe("2026-08-03T09:00:00.000Z");
  });

  it("returns null rather than throwing on a missing url", () => {
    expect(normaliseGNewsArticle({ ...ARTICLE, url: undefined })).toBeNull();
  });

  it("does not carry the truncated content field through", () => {
    const result = normaliseGNewsArticle(ARTICLE);
    expect(JSON.stringify(result?.metadata)).not.toContain("truncated on the free tier");
  });
});

describe("GNewsMonitor.search", () => {
  it("returns normalised articles and counts one request", async () => {
    const fetchStub = stubFetch(200, { totalArticles: 1, articles: [ARTICLE] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    const batch = await monitor.search(QUERY);

    expect(batch.articles).toHaveLength(1);
    expect(batch.requestsSpent).toBe(1);
    expect(batch.malformedCount).toBe(0);
  });

  it("counts a malformed article without losing the others", async () => {
    const fetchStub = stubFetch(200, {
      totalArticles: 2,
      articles: [ARTICLE, { title: "no url here" }],
    });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    const batch = await monitor.search(QUERY);

    expect(batch.articles).toHaveLength(1);
    expect(batch.malformedCount).toBe(1);
  });

  it("flags truncation when the provider filled the page", async () => {
    const fetchStub = stubFetch(200, {
      totalArticles: 57,
      articles: Array.from({ length: 10 }, () => ARTICLE),
    });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    expect((await monitor.search(QUERY)).truncated).toBe(true);
  });

  it("maps 401 to unauthorized and does not retry", async () => {
    const fetchStub = stubFetch(401, { errors: ["invalid api key"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      code: "unauthorized",
      retryable: false,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("maps 429 to rate_limited and marks it retryable", async () => {
    const fetchStub = stubFetch(429, { errors: ["too many requests"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  it("never puts the api key in the error message", async () => {
    const fetchStub = stubFetch(500, { errors: ["boom"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    const error = await monitor.search(QUERY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NewsError);
    expect((error as NewsError).message).not.toContain("test-key");
    expect((error as NewsError).message).not.toContain("boom");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/gnews-client.test.ts`
Expected: FAIL — cannot resolve `@/news/gnews/monitor`.

- [ ] **Step 3: Write the normaliser**

Create `src/news/gnews/normalise.ts`:

```ts
import type { ExternalArticle, NewsSearchQuery } from "@/news/monitor";

/**
 * GNews search syntax.
 *
 * Multi-word terms must be quoted or the provider treats them as separate
 * words, which is the difference between finding "Gramercy Tavern" and finding
 * every article containing "tavern".
 */
export function buildGNewsQuery(query: NewsSearchQuery): string {
  const quote = (term: string) => (term.includes(" ") ? `"${term}"` : term);
  const positive = query.keywords.map(quote).join(" OR ");
  if (query.exclusions.length === 0) return positive;
  const negative = query.exclusions.map((term) => `NOT ${quote(term)}`).join(" ");
  return `${positive} ${negative}`;
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * One GNews article to Lia's shape, or null.
 *
 * Null rather than throw: one unusable article must not cost a query its other
 * nine. The caller counts nulls into `malformedCount`.
 *
 * `content` is deliberately dropped. The free tier truncates it mid-sentence
 * with a "[1234 chars]" marker, and a truncated body stored as if it were the
 * article would be quoted back by the analysis layer as though complete.
 */
export function normaliseGNewsArticle(raw: unknown): ExternalArticle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const article = raw as Record<string, unknown>;

  const url = typeof article.url === "string" ? article.url : null;
  const title = typeof article.title === "string" ? article.title.trim() : "";
  const publishedAt = isoOrNull(article.publishedAt);
  if (!url || !title || !publishedAt) return null;

  const source =
    typeof article.source === "object" && article.source !== null
      ? (article.source as Record<string, unknown>)
      : {};

  return {
    externalId: url,
    url,
    title,
    description:
      typeof article.description === "string" && article.description.trim()
        ? article.description.trim()
        : null,
    publisherName: typeof source.name === "string" ? source.name : null,
    publisherDomain: domainOf(url),
    authorName: null,
    publishedAt,
    language: null,
    metadata: {
      imageUrl: typeof article.image === "string" ? article.image : null,
      sourceUrl: typeof source.url === "string" ? source.url : null,
    },
  };
}
```

- [ ] **Step 4: Write the client and the monitor**

Create `src/news/gnews/client.ts` holding the URL construction and one `fetch`. It is the only file in the news layer that touches the network, and the only one that reads `GNEWS_API_KEY`. Requirements pinned by the tests:

- Non-2xx maps to a `NewsError` by status: 401/403 → `unauthorized` (not retryable), 429 → `rate_limited` (retryable), ≥500 → `provider_error` (retryable), 400 → `invalid_query` (not retryable).
- The thrown message is **Lia's own sentence**. Never interpolate the response body, the URL, or the key.
- A missing `GNEWS_API_KEY` throws `not_configured` before any request.

Create `src/news/gnews/monitor.ts` with `GNewsMonitor implements NewsMonitor`. Its constructor takes an optional `fetch` so tests can inject a stub, defaulting to the global. `search()` builds the query, calls the client once, normalises each article, counts nulls as `malformedCount`, and sets `truncated` when the returned array length reaches `query.maxResults`. `capabilities()` reports read-only: no publishing, no comments, and human approval required.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/gnews-client.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/news tests/gnews-client.test.ts
git commit -m "feat: add GNews client and article normalisation"
```

---

### Task 8: Mock monitor, environment, registry

**Files:**
- Create: `src/news/mock-monitor.ts`, `src/news/registry.ts`
- Modify: `src/lib/env.ts`
- Test: `tests/news-mock-mode.test.ts`

**Interfaces:**
- Consumes: `NewsMonitor`, `GNewsMonitor`.
- Produces: `MockNewsMonitor`, `getNewsMonitor()`, `isNewsMonitorAvailable()`, `resolveNewsMode()`.

- [ ] **Step 1: Write the failing test**

Create `tests/news-mock-mode.test.ts`, modelled on the existing `tests/google-mock-mode.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolveNewsMode", () => {
  it("returns mock when the mode says so outside production", async () => {
    vi.stubEnv("LIA_NEWS_MODE", "mock");
    vi.stubEnv("NODE_ENV", "development");
    const { resolveNewsMode } = await import("@/lib/env");
    expect(resolveNewsMode()).toBe("mock");
  });

  it("refuses the mock in production", async () => {
    vi.stubEnv("LIA_NEWS_MODE", "mock");
    vi.stubEnv("NODE_ENV", "production");
    const { resolveNewsMode } = await import("@/lib/env");
    expect(() => resolveNewsMode()).toThrow();
  });

  it("reports unconfigured when no mode and no key are set", async () => {
    vi.stubEnv("LIA_NEWS_MODE", "");
    vi.stubEnv("GNEWS_API_KEY", "");
    const { resolveNewsMode } = await import("@/lib/env");
    expect(resolveNewsMode()).toBe("unconfigured");
  });
});

describe("MockNewsMonitor", () => {
  it("returns the same articles for the same query", async () => {
    const { MockNewsMonitor } = await import("@/news/mock-monitor");
    const monitor = new MockNewsMonitor();
    const query = {
      keywords: ["Gramercy Tavern"],
      exclusions: [],
      sourceCountry: "us",
      language: "en",
      publishedAfter: null,
      maxResults: 10,
    };

    const first = await monitor.search(query);
    const second = await monitor.search(query);

    expect(first.articles.map((a) => a.externalId)).toEqual(
      second.articles.map((a) => a.externalId),
    );
    expect(first.articles.length).toBeGreaterThan(0);
  });

  it("returns a mix the gate will both admit and reject", async () => {
    const { MockNewsMonitor } = await import("@/news/mock-monitor");
    const batch = await new MockNewsMonitor().search({
      keywords: ["Gramercy Tavern"],
      exclusions: [],
      sourceCountry: "us",
      language: "en",
      publishedAfter: null,
      maxResults: 10,
    });

    const titles = batch.articles.map((a) => a.title.toLowerCase());
    expect(titles.some((t) => t.includes("gramercy tavern"))).toBe(true);
    expect(titles.some((t) => !t.includes("gramercy tavern"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/news-mock-mode.test.ts`
Expected: FAIL — `resolveNewsMode` is not exported.

- [ ] **Step 3: Extend the environment schema**

In `src/lib/env.ts`, following the `LIA_AI_MODE` pattern exactly — schema entry, the production refinement, the `process.env` read, and a `resolve*` function:

```ts
const newsModeSchema = z.enum(["live", "mock"]);
export type NewsMode = z.infer<typeof newsModeSchema>;
```

Add `LIA_NEWS_MODE: newsModeSchema.optional()`, `GNEWS_API_KEY: z.string().min(1).optional()`, and `CRON_SECRET: z.string().min(16).optional()` to the schema object; add the refinement refusing `LIA_NEWS_MODE=mock` when `NODE_ENV === "production"`; add all three to the `process.env` mapping.

Then:

```ts
/**
 * Which news monitor is in play.
 *
 * `unconfigured` rather than a silent fallback, for the same reason as Google:
 * a deployment quietly serving fabricated articles is worse than one that
 * plainly says news is not set up.
 */
export function resolveNewsMode(): NewsMode | "unconfigured" {
  if (env.LIA_NEWS_MODE === "mock") {
    if (env.NODE_ENV === "production") {
      throw new EnvironmentError(
        "LIA_NEWS_MODE=mock cannot be used in production.",
        ["LIA_NEWS_MODE"],
      );
    }
    return "mock";
  }
  if (env.LIA_NEWS_MODE === "live" && env.GNEWS_API_KEY) return "live";
  return "unconfigured";
}
```

Match the existing `EnvironmentError` constructor signature — open the file and copy it rather than assuming.

- [ ] **Step 4: Write the mock monitor**

Create `src/news/mock-monitor.ts`. It returns a fixed, hand-written set of eight articles, deterministic for a given query — no `Math.random()`, no `Date.now()`. Include, deliberately:

- three genuine matches naming the keyword in the title,
- two where the keyword appears only in the description,
- two that do not match at all (so the gate has something to reject),
- two sharing an identical headline from different domains (so syndication detection has something to collapse).

That is nine entries across overlapping categories; the exact count does not matter, the coverage does. Every article must satisfy `ExternalArticle`. `requestsSpent: 1`, `truncated: false`, `malformedCount: 0`.

- [ ] **Step 5: Write the registry**

Create `src/news/registry.ts`, mirroring `src/integrations/registry.ts`:

```ts
import "server-only";
import { resolveNewsMode } from "@/lib/env";
import { GNewsMonitor } from "@/news/gnews/monitor";
import { MockNewsMonitor } from "@/news/mock-monitor";
import { NewsError } from "@/news/errors";
import type { NewsMonitor } from "@/news/monitor";

export function isNewsMonitorAvailable(): boolean {
  return resolveNewsMode() !== "unconfigured";
}

export function getNewsMonitor(): NewsMonitor {
  const mode = resolveNewsMode();
  if (mode === "mock") return new MockNewsMonitor();
  if (mode === "live") return new GNewsMonitor();
  throw new NewsError(
    "not_configured",
    "News monitoring is not configured for this deployment.",
    false,
  );
}
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npx vitest run tests/news-mock-mode.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
npm run typecheck && npx vitest run
git add src/news src/lib/env.ts tests/news-mock-mode.test.ts
git commit -m "feat: add mock news monitor, environment wiring, and registry"
```

---

### Task 9: The relevance gate

This is the highest-value task in the plan. It is the only genuinely new logic, it is a pure function, and it is what decides whether Lia's news feature is useful or noise.

**Files:**
- Create: `src/lib/monitoring/gate.ts`
- Test: `tests/relevance-gate.test.ts`

**Interfaces:**
- Consumes: `MonitoringQuery`, `ExternalArticle`, `GateRejectionReason`, `SYNDICATION_WINDOW_MS`.
- Produces: `evaluateCandidate(candidate, context) => GateVerdict`, `normaliseHeadline(title) => string`, types `GateContext`, `GateVerdict`.

- [ ] **Step 1: Write the failing test**

Create `tests/relevance-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateCandidate, normaliseHeadline } from "@/lib/monitoring/gate";
import type { MonitoringQuery } from "@/domain";
import type { ExternalArticle } from "@/news/monitor";

const NOW = "2026-08-04T12:00:00.000Z";

const QUERY: MonitoringQuery = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  locationId: null,
  name: "Brand mentions",
  queryType: "brand",
  keywords: ["Gramercy Tavern"],
  exclusions: ["obituary"],
  allowedDomains: [],
  deniedDomains: ["contentfarm.example"],
  sourceCountry: "us",
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
  lastPolledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function article(overrides: Partial<ExternalArticle> = {}): ExternalArticle {
  return {
    externalId: "https://paper.example/a",
    url: "https://paper.example/a",
    title: "Gramercy Tavern reopens after renovation",
    description: "The restaurant welcomes diners back this week.",
    publisherName: "Paper",
    publisherDomain: "paper.example",
    authorName: null,
    publishedAt: "2026-08-04T09:00:00.000Z",
    language: "en",
    metadata: {},
    ...overrides,
  };
}

function context(overrides: Partial<Parameters<typeof evaluateCandidate>[1]> = {}) {
  return { query: QUERY, now: NOW, recentHeadlines: [], ...overrides };
}

describe("normaliseHeadline", () => {
  it("collapses case, punctuation, and whitespace", () => {
    expect(normaliseHeadline("Gramercy Tavern  Reopens!")).toBe(
      "gramercy tavern reopens",
    );
  });

  it("makes two syndicated copies of one story identical", () => {
    expect(normaliseHeadline("Chef named 'Best in City'")).toBe(
      normaliseHeadline("Chef Named “Best in City”"),
    );
  });
});

describe("hard rejections", () => {
  it("rejects an excluded term found in the title", () => {
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern founder obituary" }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  it("rejects an excluded term found in the description", () => {
    const verdict = evaluateCandidate(
      article({ description: "A full obituary follows." }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  it("rejects a denied domain", () => {
    const verdict = evaluateCandidate(
      article({ publisherDomain: "contentfarm.example" }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "domain_denied" });
  });

  it("rejects a headline already seen inside the syndication window", () => {
    const verdict = evaluateCandidate(
      article(),
      context({
        recentHeadlines: [
          {
            headline: normaliseHeadline("Gramercy Tavern reopens after renovation"),
            seenAt: "2026-08-03T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(verdict).toMatchObject({
      admitted: false,
      reason: "probable_syndication",
    });
  });

  it("admits a repeat once the syndication window has passed", () => {
    const verdict = evaluateCandidate(
      article(),
      context({
        recentHeadlines: [
          {
            headline: normaliseHeadline("Gramercy Tavern reopens after renovation"),
            seenAt: "2026-07-20T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("checks exclusions before syndication, so the reason is the strongest one", () => {
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern obituary" }),
      context({
        recentHeadlines: [
          { headline: normaliseHeadline("Gramercy Tavern obituary"), seenAt: NOW },
        ],
      }),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });
});

describe("scoring", () => {
  it("admits a title match", () => {
    const verdict = evaluateCandidate(article(), context());
    expect(verdict.admitted).toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(0.5);
  });

  it("scores a description-only match below a title match", () => {
    const titleOnly = evaluateCandidate(article(), context());
    const descriptionOnly = evaluateCandidate(
      article({
        title: "A restaurant reopens downtown",
        description: "Gramercy Tavern welcomes diners back.",
      }),
      context(),
    );
    expect(descriptionOnly.score).toBeLessThan(titleOnly.score);
  });

  it("rejects an article matching nothing", () => {
    const verdict = evaluateCandidate(
      article({ title: "City council debates parking", description: "No mention." }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "below_threshold" });
    expect(verdict.score).toBe(0);
  });

  it("penalises a short single-word brand matched only once", () => {
    const ambiguous: MonitoringQuery = { ...QUERY, keywords: ["Bond"] };
    const verdict = evaluateCandidate(
      article({ title: "Bond markets rally", description: "Yields fell." }),
      context({ query: ambiguous }),
    );
    expect(verdict.admitted).toBe(false);
  });

  it("does not penalise a short brand when a second keyword also matches", () => {
    const ambiguous: MonitoringQuery = {
      ...QUERY,
      keywords: ["Bond", "Union Square"],
    };
    const verdict = evaluateCandidate(
      article({
        title: "Bond opens in Union Square",
        description: "The new restaurant debuts.",
      }),
      context({ query: ambiguous }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("boosts a location query published by an allowed local outlet", () => {
    const local: MonitoringQuery = {
      ...QUERY,
      queryType: "location",
      allowedDomains: ["paper.example"],
    };
    const boosted = evaluateCandidate(article(), context({ query: local }));
    const plain = evaluateCandidate(article(), context());
    expect(boosted.score).toBeGreaterThan(plain.score);
  });

  it("never returns a score outside 0 to 1", () => {
    const everything: MonitoringQuery = {
      ...QUERY,
      queryType: "location",
      keywords: ["Gramercy Tavern", "renovation", "diners"],
      allowedDomains: ["paper.example"],
    };
    const verdict = evaluateCandidate(article(), context({ query: everything }));
    expect(verdict.score).toBeLessThanOrEqual(1);
    expect(verdict.score).toBeGreaterThanOrEqual(0);
  });

  it("respects a raised threshold", () => {
    const strict: MonitoringQuery = { ...QUERY, relevanceThreshold: 0.95 };
    const verdict = evaluateCandidate(article(), context({ query: strict }));
    expect(verdict).toMatchObject({ admitted: false, reason: "below_threshold" });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/relevance-gate.test.ts`
Expected: FAIL — cannot resolve `@/lib/monitoring/gate`.

- [ ] **Step 3: Implement the gate**

Create `src/lib/monitoring/gate.ts`:

```ts
import type { MonitoringQuery } from "@/domain";
import { SYNDICATION_WINDOW_MS } from "@/domain/entities/monitoring";
import type { GateRejectionReason } from "@/domain/enums";
import type { ExternalArticle } from "@/news/monitor";

/**
 * Admission control for news candidates.
 *
 * A pure function: no I/O, no clock beyond the injected `now`, no model call.
 * That is what makes it cheap enough to run on every candidate, and testable
 * against a fixture corpus rather than against production noise.
 *
 * This gate deliberately does **not** write `mentions.relevance_score` (D65).
 * That column belongs to the analysis layer, which supersedes any provisional
 * number within minutes. The score here is persisted only on rejections, where
 * it is the thing being tuned.
 */

/** A headline Lia has already admitted, for syndication detection. */
export interface SeenHeadline {
  headline: string;
  seenAt: string;
}

export interface GateContext {
  query: MonitoringQuery;
  now: string;
  /** Normalised headlines admitted recently, any tenant-scoped source. */
  recentHeadlines: readonly SeenHeadline[];
}

export type GateVerdict =
  | { admitted: true; score: number; isSyndicated: false }
  | { admitted: false; score: number; reason: GateRejectionReason };

/* -------------------------------------------------------------------------- */
/* Weights                                                                     */
/*                                                                            */
/* Named constants rather than inline numbers, because these are the dials a   */
/* later workflow will turn once `news_rejected_candidates` has enough rows to */
/* judge them against. Unvalidated today, exactly as prompt quality is (D43).  */
/* -------------------------------------------------------------------------- */

const TITLE_MATCH = 0.5;
const DESCRIPTION_MATCH = 0.2;
const MULTI_KEYWORD_BONUS = 0.15;
const LOCAL_OUTLET_BONUS = 0.25;
const AMBIGUITY_PENALTY = 0.25;
/** At or below this length, a single-word term is treated as ambiguous. */
const AMBIGUOUS_TERM_MAX_LENGTH = 8;

/**
 * Reduce a headline to its comparable core.
 *
 * Two papers running the same wire story differ in quote style, casing, and
 * trailing punctuation, and in nothing else. Lowercasing and stripping
 * non-alphanumerics collapses exactly that difference.
 */
export function normaliseHeadline(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle.toLowerCase());
}

function isAmbiguous(term: string): boolean {
  return !term.includes(" ") && term.length <= AMBIGUOUS_TERM_MAX_LENGTH;
}

export function evaluateCandidate(
  candidate: ExternalArticle,
  context: GateContext,
): GateVerdict {
  const { query, now, recentHeadlines } = context;
  const title = candidate.title.toLowerCase();
  const description = (candidate.description ?? "").toLowerCase();
  const haystack = `${title} ${description}`;

  /* Hard rejections, strongest reason first. An article that is both excluded
   * and syndicated should report the exclusion: it is the more actionable of
   * the two, because it means the query itself wants adjusting. */

  if (query.exclusions.some((term) => contains(haystack, term))) {
    return { admitted: false, score: 0, reason: "excluded_term" };
  }

  const domain = candidate.publisherDomain ?? "";
  if (query.deniedDomains.includes(domain)) {
    return { admitted: false, score: 0, reason: "domain_denied" };
  }

  const normalised = normaliseHeadline(candidate.title);
  const nowMs = new Date(now).getTime();
  const syndicated = recentHeadlines.some(
    (seen) =>
      seen.headline === normalised &&
      nowMs - new Date(seen.seenAt).getTime() <= SYNDICATION_WINDOW_MS,
  );
  if (syndicated) {
    return { admitted: false, score: 0, reason: "probable_syndication" };
  }

  /* Scoring. */

  const inTitle = query.keywords.filter((term) => contains(title, term));
  const inDescription = query.keywords.filter((term) => contains(description, term));
  const matched = new Set([...inTitle, ...inDescription]);

  if (matched.size === 0) {
    return { admitted: false, score: 0, reason: "below_threshold" };
  }

  let score = 0;
  if (inTitle.length > 0) score += TITLE_MATCH;
  if (inDescription.length > 0) score += DESCRIPTION_MATCH;
  if (matched.size >= 2) score += MULTI_KEYWORD_BONUS;

  if (
    query.queryType === "location" &&
    query.allowedDomains.length > 0 &&
    query.allowedDomains.includes(domain)
  ) {
    score += LOCAL_OUTLET_BONUS;
  }

  // A short single-word brand matched exactly once is the classic false
  // positive: "Bond" finds the bond market long before it finds the restaurant.
  // A second matching term is what distinguishes them.
  const onlyMatch = matched.size === 1 ? [...matched][0] : null;
  if (onlyMatch && isAmbiguous(onlyMatch)) {
    score -= AMBIGUITY_PENALTY;
  }

  score = Math.min(1, Math.max(0, Number(score.toFixed(3))));

  if (score < query.relevanceThreshold) {
    return { admitted: false, score, reason: "below_threshold" };
  }
  return { admitted: true, score, isSyndicated: false };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/relevance-gate.test.ts`
Expected: PASS, 17 tests.

If the ambiguity tests fail, do **not** loosen the assertion — adjust the weights until both the "Bond markets" rejection and the "Bond opens in Union Square" admission hold simultaneously. Those two cases together are the whole point of the penalty.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/monitoring tests/relevance-gate.test.ts
git commit -m "feat: add deterministic relevance gate for news candidates"
```

---

### Task 10: Budget and poll service

**Files:**
- Create: `src/lib/monitoring/budget.ts`, `src/lib/monitoring/poll-service.ts`
- Test: `tests/news-poll-service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4, 6, 8, 9.
- Produces: `pollMonitoringQuery(options) => PollOutcome`, `pollDueQueries(options) => PollSweepOutcome`, `remainingDailyRequests(dataSource, now) => number`, `DAILY_REQUEST_BUDGET`, `MANUAL_RESERVE`.

- [ ] **Step 1: Write the failing test**

Create `tests/news-poll-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiaDataSource } from "@/lib/data/types";
import { pollMonitoringQuery } from "@/lib/monitoring/poll-service";
import type { NewsMonitor, NewsSearchBatch } from "@/news/monitor";
import { NewsError } from "@/news/errors";
import { freshDataSource, ushg } from "./helpers/scope";

let dataSource: LiaDataSource;

const QUERY_INPUT = {
  locationId: null,
  name: "Brand mentions",
  queryType: "brand" as const,
  keywords: ["Gramercy Tavern"],
  exclusions: ["obituary"],
  allowedDomains: [],
  deniedDomains: [],
  sourceCountry: "us",
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
};

function batch(titles: string[]): NewsSearchBatch {
  return {
    articles: titles.map((title, index) => ({
      externalId: `https://paper.example/${index}`,
      url: `https://paper.example/${index}`,
      title,
      description: "A description.",
      publisherName: "Paper",
      publisherDomain: "paper.example",
      authorName: null,
      publishedAt: "2026-08-04T09:00:00.000Z",
      language: "en",
      metadata: {},
    })),
    requestsSpent: 1,
    truncated: false,
    malformedCount: 0,
  };
}

function monitorReturning(result: NewsSearchBatch | Error): NewsMonitor {
  return {
    platform: "news_media",
    capabilities: () => ({}) as never,
    search: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as NewsMonitor;
}

beforeEach(() => {
  dataSource = freshDataSource();
});

describe("pollMonitoringQuery", () => {
  it("ingests admitted articles and records the rejected ones", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        batch([
          "Gramercy Tavern reopens",
          "City council debates parking",
          "Gramercy Tavern obituary notice",
        ]),
      ),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    expect(outcome.accepted).toBe(1);
    expect(outcome.rejected).toBe(2);

    const rejections = await dataSource.newsRejectedCandidates.listForQuery(
      ushg.admin(),
      query.id,
    );
    expect(rejections.map((r) => r.reason).sort()).toEqual([
      "below_threshold",
      "excluded_term",
    ]);
  });

  it("creates mentions carrying the query and publisher", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const created = mentions.find((m) => m.title === "Gramercy Tavern reopens");
    expect(created).toBeDefined();
    expect(created?.monitoringQueryId).toBe(query.id);
    expect(created?.publisherDomain).toBe("paper.example");
    expect(created?.sourceType).toBe("news_article");
  });

  it("leaves the mention unanalysed for the analysis layer", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const created = mentions.find((m) => m.title === "Gramercy Tavern reopens");
    expect(created?.status).toBe("new");
    expect(created?.relevanceScore).toBeNull();
    expect(created?.sentiment).toBe("unknown");
  });

  it("advances the cursor on success", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "scheduled",
      actorUserId: null,
      now: "2026-08-04T12:00:00.000Z",
    });

    const after = await dataSource.monitoringQueries.get(ushg.admin(), query.id);
    expect(after?.lastPolledAt).toBe("2026-08-04T12:00:00.000Z");
  });

  it("does not advance the cursor when the provider failed", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        new NewsError("provider_error", "The news provider is unavailable.", true),
      ),
      trigger: "scheduled",
      actorUserId: null,
      now: "2026-08-04T12:00:00.000Z",
    });

    const after = await dataSource.monitoringQueries.get(ushg.admin(), query.id);
    expect(after?.lastPolledAt).toBeNull();
  });

  it("closes the run as failed and stores no provider text", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        new NewsError("unauthorized", "GNews said: bad key sk-live-123", false),
      ),
      trigger: "scheduled",
      actorUserId: null,
      now: "2026-08-04T12:00:00.000Z",
    });

    const [run] = await dataSource.newsPollRuns.listForQuery(ushg.admin(), query.id, 1);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("unauthorized");
    expect(run?.errorMessage ?? "").not.toContain("sk-live-123");
  });

  it("re-polling the same article updates rather than duplicating", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);
    const options = {
      dataSource,
      scope: ushg.admin(),
      query,
      trigger: "manual" as const,
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    };

    await pollMonitoringQuery({
      ...options,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });
    await pollMonitoringQuery({
      ...options,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const matching = mentions.filter((m) => m.title === "Gramercy Tavern reopens");
    expect(matching).toHaveLength(1);
  });

  it("records min, mean, and max gate scores on the run", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        batch(["Gramercy Tavern reopens", "City council debates parking"]),
      ),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    const [run] = await dataSource.newsPollRuns.listForQuery(ushg.admin(), query.id, 1);
    expect(run?.gateScoreMax).toBeGreaterThan(0);
    expect(run?.gateScoreMin).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/news-poll-service.test.ts`
Expected: FAIL — cannot resolve `@/lib/monitoring/poll-service`.

- [ ] **Step 3: Write the budget module**

Create `src/lib/monitoring/budget.ts`:

```ts
import type { LiaDataSource } from "@/lib/data/types";

/**
 * The daily request ceiling, shared by every tenant.
 *
 * New in this workflow (D67). Google's quota was per connection, so a noisy
 * customer could only hurt themselves; here one organization with forty
 * queries can exhaust the day for everyone, which is why this is enforced
 * above the tenant loop rather than inside it.
 */
export const DAILY_REQUEST_BUDGET = 100;

/** Held back from the scheduler so a person can always poll by hand. */
export const MANUAL_RESERVE = 20;

function startOfUtcDay(now: string): string {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

/** What the scheduler may still spend today. Never negative. */
export async function remainingScheduledRequests(
  dataSource: LiaDataSource,
  now: string,
): Promise<number> {
  const spent = await dataSource.newsPollRuns.requestsSpentSince(startOfUtcDay(now));
  return Math.max(0, DAILY_REQUEST_BUDGET - MANUAL_RESERVE - spent);
}
```

- [ ] **Step 4: Write the poll service**

Create `src/lib/monitoring/poll-service.ts` exporting `pollMonitoringQuery` and `pollDueQueries`. Requirements, each pinned by a test above:

**`pollMonitoringQuery(options)`** — options are `{ dataSource, scope, query, monitor, trigger, actorUserId, now }`. In order:

1. `newsPollRuns.start(...)`. A `PollRunInProgressError` is caught and returned as a `skipped` outcome, not rethrown — a scheduled sweep must not die because one query is busy.
2. Build the `NewsSearchQuery`: keywords, exclusions, `sourceCountry`, `language`, `publishedAfter: query.lastPolledAt`, `maxResults: MAX_ARTICLES_PER_POLL`.
3. `monitor.search(...)`. On `NewsError`, finish the run as `failed` with `errorCode: error.code` and a **Lia-authored** message chosen from a fixed map keyed by code — never `error.message`, which may quote the provider. Do not advance the cursor. Return.
4. Load recent admitted headlines for the syndication window: read the organization's `news_article` mentions published within `SYNDICATION_WINDOW_MS` of `now` and map them through `normaliseHeadline`. Accumulate headlines admitted *within this run* into the same list, so two syndicated copies arriving in one batch still collapse.
5. For each article, `evaluateCandidate`. Rejections accumulate into an array recorded in one `recordMany` call at the end. Admissions go through `mentions.ingest()` with `sourceType: "news_article"`, `platformConnectionId` from the organization's `news_media` connection, `locationId: query.locationId`, `externalId: article.externalId`, `title`, `content: article.description ?? article.title`, `publishedAt`, `rawPayload: {}`, and the new publisher fields.
6. `monitoringQueries.markPolled(scope, query.id, now)`.
7. `newsPollRuns.finish(...)` with every counter and the three gate-score aggregates. `gateScoreMean` is the mean across all evaluated candidates, rounded to three decimals; all three are null when nothing was evaluated.
8. `newsRejectedCandidates.purgeOlderThan(scope, new Date(nowMs - REJECTION_RETENTION_MS).toISOString())`. Retention runs here rather than in its own job because this is the only code path that writes the table, so it cannot fall behind what it is trimming.
9. `recordAuditEvent(...)` — follow the existing call sites for the exact signature. **The event must not contain an article title, a URL, or a publisher name**, only counts and the query id.

**`pollDueQueries(options)`** — options are `{ dataSource, monitor, now, limit }`. Returns `{ polled, accepted, rejected, skippedForBudget }`. Calls `monitoringQueries.listDue`, and for each row constructs its own `OrganizationScope` from `organizationId` with a synthetic system actor, per D70. Stops as soon as `remainingScheduledRequests` is exhausted and reports the unpolled count as `skippedForBudget`, so a sweep that covered eight of forty queries cannot read as full coverage.

The `news_media` connection is created on demand if absent (D62) — one row per organization, status `connected`, no credential row.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/news-poll-service.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/monitoring tests/news-poll-service.test.ts
git commit -m "feat: add news poll service with budget and gate integration"
```

---

### Task 11: Permissions and server actions

**Files:**
- Create: `src/app/actions/monitoring.ts`
- Modify: `src/lib/auth/permissions.ts`
- Test: `tests/monitoring-permissions.test.ts`

**Interfaces:**
- Consumes: `assertPermission`, `getOrganizationContext`, the monitoring repositories, `pollMonitoringQuery`.
- Produces: permissions `monitoring.manage_queries` and `monitoring.poll_now`; actions `createMonitoringQueryAction`, `updateMonitoringQueryAction`, `deleteMonitoringQueryAction`, `pollMonitoringQueryAction`.

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring-permissions.test.ts`, modelled on `tests/integration-permissions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { can } from "@/lib/auth/permissions";

describe("monitoring permissions", () => {
  it("lets owner, admin, and communications lead manage queries", () => {
    expect(can("owner", "monitoring.manage_queries")).toBe(true);
    expect(can("admin", "monitoring.manage_queries")).toBe(true);
    expect(can("communications_lead", "monitoring.manage_queries")).toBe(true);
  });

  it("refuses everyone else", () => {
    expect(can("location_manager", "monitoring.manage_queries")).toBe(false);
    expect(can("approver", "monitoring.manage_queries")).toBe(false);
    expect(can("analyst", "monitoring.manage_queries")).toBe(false);
  });

  it("grants poll_now to exactly the roles that hold sync_reviews", () => {
    for (const role of [
      "owner",
      "admin",
      "communications_lead",
      "location_manager",
      "approver",
      "analyst",
    ] as const) {
      expect(can(role, "monitoring.poll_now")).toBe(
        can(role, "integration.sync_reviews"),
      );
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/monitoring-permissions.test.ts`
Expected: FAIL — the permission names do not exist.

- [ ] **Step 3: Add the permissions**

In `src/lib/auth/permissions.ts`, add both to the permission union and both to the matrix:

```ts
  "monitoring.manage_queries": ["owner", "admin", "communications_lead"],
  "monitoring.poll_now": ["owner", "admin", "communications_lead"],
```

Deciding what Lia watches is the same class of decision as deciding which locations it syncs, which is why these match `integration.manage_profiles` and `integration.sync_reviews`. There is no read permission, per D19.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/monitoring-permissions.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the server actions**

Create `src/app/actions/monitoring.ts` with `"use server"` at the top. Read `src/app/actions/` for the exact result-shape convention this codebase uses for form actions and follow it — do not invent a new one.

Each action: `getOrganizationContext()`, then `assertPermission(role, "monitoring.manage_queries")` (or `monitoring.poll_now`), then parse the form data with the Zod input schema from Task 1, then call the repository, then `recordAuditEvent`, then `revalidatePath("/integrations/news-media")`.

`pollMonitoringQueryAction` additionally calls `getNewsMonitor()` and `pollMonitoringQuery` with `trigger: "manual"`. A `NewsError` is caught and returned as a field error carrying **Lia's** sentence for that code, never the provider's.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/auth/permissions.ts src/app/actions/monitoring.ts tests/monitoring-permissions.test.ts
git commit -m "feat: add monitoring permissions and server actions"
```

---

### Task 12: Cron routes

**Files:**
- Create: `src/app/api/cron/news-poll/route.ts`, `src/app/api/cron/analyze-mentions/route.ts`, `vercel.ts`
- Test: `tests/cron-routes.test.ts`

**Interfaces:**
- Consumes: `pollDueQueries`, `analyzeMentions`, `env.CRON_SECRET`.
- Produces: two POST route handlers.

- [ ] **Step 1: Write the failing test**

Create `tests/cron-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-cron-secret-value";

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("LIA_NEWS_MODE", "mock");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("POST /api/cron/news-poll", () => {
  it("rejects a request with no authorization header", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(new Request("https://lia.test/api/cron/news-poll", {
      method: "POST",
    }));
    expect(response.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/news-poll", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret-entirely" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("accepts the configured secret", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/news-poll", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("never returns a provider message in the body", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/news-poll", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const body = await response.text();
    expect(body).not.toContain(SECRET);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/cron-routes.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Write the routes**

Create `src/app/api/cron/news-poll/route.ts`:

```ts
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getDataSource } from "@/lib/data";
import { getNewsMonitor, isNewsMonitorAvailable } from "@/news/registry";
import { pollDueQueries } from "@/lib/monitoring/poll-service";

/**
 * Scheduled news polling.
 *
 * POST only, and guarded by a shared secret rather than a session: cron has no
 * user. That makes this the first write path in the codebase where RLS is not
 * the backstop, which is why the poll service constructs a scope per query row
 * rather than relying on anything ambient (D70).
 */

export const dynamic = "force-dynamic";

/** Timing-safe enough for a fixed-length secret compared in constant time. */
function authorized(request: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isNewsMonitorAvailable()) {
    return NextResponse.json({ status: "not_configured", polled: 0 }, { status: 200 });
  }

  const dataSource = await getDataSource();
  const outcome = await pollDueQueries({
    dataSource,
    monitor: getNewsMonitor(),
    now: new Date().toISOString(),
    limit: 25,
  });

  // `skippedForBudget` is returned rather than swallowed: a sweep that polled
  // eight of forty queries must not read as full coverage.
  return NextResponse.json(
    {
      status: "ok",
      polled: outcome.polled,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      skippedForBudget: outcome.skippedForBudget,
    },
    { status: 200 },
  );
}
```

Create `src/app/api/cron/analyze-mentions/route.ts` with the same guard, calling the existing `analyzeMentions()` with `trigger: "scheduled"`. Read `src/lib/analysis/` for its exact signature and required arguments.

- [ ] **Step 4: Add the schedules**

Create `vercel.ts` at the repository root:

```ts
import type { VercelConfig } from "@vercel/config/v1";

/**
 * Cron schedules.
 *
 * Polling is hourly while individual queries carry their own interval, so the
 * sweep is a chance to poll rather than a guarantee of one. Analysis runs on
 * the half hour so it picks up what the poll just ingested rather than racing
 * it.
 */
export const config: VercelConfig = {
  crons: [
    { path: "/api/cron/news-poll", schedule: "0 * * * *" },
    { path: "/api/cron/analyze-mentions", schedule: "30 * * * *" },
  ],
};
```

Install the config package if it is absent: `npm install --save-dev @vercel/config`.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run tests/cron-routes.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npx vitest run
git add src/app/api/cron vercel.ts package.json package-lock.json tests/cron-routes.test.ts
git commit -m "feat: add cron routes for news polling and mention analysis"
```

---

### Task 13: Seed data

**Files:**
- Modify: `src/lib/seed/dataset.ts`, `supabase/seed.sql` (generated)
- Test: `tests/seed-dataset.test.ts` (existing — extend it)

**Interfaces:**
- Produces: exported ids `MQ_USHG_BRAND`, `MQ_USHG_GRAMERCY`, `MQ_HARBOR_BRAND`, and news mentions attached to them.

- [ ] **Step 1: Read the seed contract**

Read `src/lib/seed/dataset.ts` header and `tests/seed-dataset.test.ts`. `supabase/seed.sql` is **generated** (D3) — never hand-edit it.

- [ ] **Step 2: Add a failing assertion**

In `tests/seed-dataset.test.ts`, add:

```ts
it("seeds monitoring queries for both tenants", () => {
  const orgs = new Set(dataset.monitoringQueries.map((q) => q.organizationId));
  expect(orgs.size).toBeGreaterThanOrEqual(2);
  expect(dataset.monitoringQueries.length).toBeGreaterThanOrEqual(3);
});

it("attaches every seeded news mention to a seeded monitoring query", () => {
  const ids = new Set(dataset.monitoringQueries.map((q) => q.id));
  const news = dataset.mentions.filter((m) => m.sourceType === "news_article");
  expect(news.length).toBeGreaterThan(0);
  for (const mention of news) {
    expect(ids.has(mention.monitoringQueryId ?? "")).toBe(true);
  }
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `npx vitest run tests/seed-dataset.test.ts`
Expected: FAIL — `dataset.monitoringQueries` is undefined.

- [ ] **Step 4: Add the seed rows**

In `src/lib/seed/dataset.ts`:

- Add a `news_media` platform connection for each of USHG and Harbor & Vine.
- Add three monitoring queries: a USHG brand query, a USHG location query bound to Gramercy Tavern, and a Harbor & Vine brand query. Use fixed UUID constants exported by name, matching how `CONN_GOOGLE` and `LOC_SOHO` are declared.
- Update the existing seeded `news_article` mentions so each carries `monitoringQueryId`, `publisherName`, `publisherDomain`, and `isSyndicated: false`. Add any new fields to every existing mention row too — `NEW_MENTION_DEFAULTS` is the place to extend if the shape is shared.
- Timestamps use the frozen `REFERENCE_NOW`, not the wall clock.

- [ ] **Step 5: Regenerate and validate**

```bash
npm run db:seed:generate
npm run db:validate
npx vitest run tests/seed-dataset.test.ts
```
Expected: all PASS, and `git diff supabase/seed.sql` shows the new rows.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/seed/dataset.ts supabase/seed.sql tests/seed-dataset.test.ts
git commit -m "feat: seed monitoring queries and news mentions"
```

---

### Task 14: Capabilities and the integration screen

**Files:**
- Create: `src/lib/monitoring/capabilities.ts`, `src/app/(app)/integrations/news-media/page.tsx`, `src/components/integrations/monitoring-query-list.tsx`, `src/components/integrations/monitoring-query-form.tsx`, `src/components/integrations/poll-run-history.tsx`
- Modify: `src/app/(app)/integrations/page.tsx`
- Test: `tests/news-capabilities.test.ts`

**Interfaces:**
- Consumes: the repositories, `isNewsMonitorAvailable`, `remainingScheduledRequests`.
- Produces: `newsCapabilities(available) => IntegrationCapability[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/news-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newsCapabilities } from "@/lib/monitoring/capabilities";

describe("newsCapabilities", () => {
  it("never claims Lia can publish to a publication", () => {
    for (const available of [true, false]) {
      const publishing = newsCapabilities(available).find(
        (c) => c.id === "media_publishing",
      );
      expect(publishing?.state).toBe("unavailable");
    }
  });

  it("states the delay, the missing body text, and the result cap", () => {
    const text = newsCapabilities(true)
      .map((c) => `${c.label} ${c.detail}`)
      .join(" ")
      .toLowerCase();
    expect(text).toContain("12 hours");
    expect(text).toContain("headline");
    expect(text).toContain("10");
  });

  it("reports nothing as enabled when the monitor is unconfigured", () => {
    expect(newsCapabilities(false).every((c) => c.state !== "enabled")).toBe(true);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run tests/news-capabilities.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the capabilities**

Create `src/lib/monitoring/capabilities.ts`, modelled closely on `src/lib/integrations/capabilities.ts`. Return capabilities with these ids: `article_monitoring`, `scheduled_polling`, `relevance_filtering`, `full_text`, `media_publishing`, `comment_monitoring`.

The honesty requirement in `CLAUDE.md` is sharper here than it was for Google, because "monitoring" sounds like completeness. Three limits must appear in the copy verbatim in substance:

- `article_monitoring` — headline and description only, **not** the article body.
- `scheduled_polling` — up to **12 hours** behind, and at most **10** articles per poll.
- `full_text` — `unavailable`, stating the current plan does not include article body text.
- `media_publishing` — `unavailable` **regardless of configuration**, exactly as `review_publishing` is. Monitoring the news changes nothing about whether Lia can write to a newspaper.

Use sentence case throughout.

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run tests/news-capabilities.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Build the screen**

Create `src/app/(app)/integrations/news-media/page.tsx` as a server component under 300 lines. Read `src/app/(app)/integrations/google-business-profile/page.tsx` first and mirror its structure: page header, capability list, then content sections. It renders:

- the capability list from Step 3,
- the monitoring queries via `monitoring-query-list.tsx`,
- recent runs and their rejections via `poll-run-history.tsx`,
- remaining daily budget from `remainingScheduledRequests`.

`monitoring-query-form.tsx` is the only client component — it needs interactivity for the keyword and exclusion chip inputs. It posts to the Task 11 actions. Labels use sentence case, every input has an associated `<label>`, and the destructive delete goes through the existing confirmation dialog primitive.

Add the news and media card to `src/app/(app)/integrations/page.tsx`, following the Google card exactly.

Add route-level `loading.tsx` and `error.tsx` for the new route — `CLAUDE.md` requires both.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/lib/monitoring/capabilities.ts src/app/\(app\)/integrations src/components/integrations tests/news-capabilities.test.ts
git commit -m "feat: add news and media integration screen"
```

---

### Task 15: Media detail, docs, and final verification

**Files:**
- Modify: `src/app/(app)/media/[id]/page.tsx`, `src/lib/view-models/`, `docs/architecture/current-state.md`
- Test: full suite

- [ ] **Step 1: Update the media detail screen**

Open `src/app/(app)/media/[id]/page.tsx`. It currently renders seeded articles. Change what it shows so it does not imply Lia holds the article:

- Show headline, description, publisher name, and published date.
- Add a prominent "read at source" link to `sourceUrl`, opening in a new tab with `rel="noopener noreferrer"`.
- Show the analysis results where present.
- **Do not add a response composer** (D72). There is no path by which Lia posts to a publication, and a composer would imply one.
- Where the body would be, state plainly that Lia holds the headline and summary rather than the full article.

Update the corresponding view-model in `src/lib/view-models/` to carry `publisherName`, `publisherDomain`, and `isSyndicated`.

- [ ] **Step 2: Verify the whole suite**

```bash
npm run verify
```
Expected: lint, typecheck, all tests, and the production build all pass. Fix anything that fails before continuing — this is the gate on the whole workflow.

- [ ] **Step 3: Update the architecture record**

In `docs/architecture/current-state.md`:

- Add the new routes to the routes table.
- Add `src/news/` and `src/lib/monitoring/` to the directories table.
- Add a "Decisions made in workflow 06" section carrying **D60–D72 verbatim** from the spec.
- Add the technical constraints: the gate never writes `relevance_score`; no provider message reaches a user, log, or stored row; cron carries its own tenancy discipline.
- Add a "New in workflow 06" gaps section carrying the spec's known-gaps list, with **one correction**: the spec predicted rejections would have "no sweeper job until one exists to hang it on". A sweeper now exists — `pollMonitoringQuery` purges on every run — so record retention as working rather than as a gap.
- Update the workflow-04 gap that reads "No scheduler" — a scheduler now exists, and the entry should say so rather than being deleted.

- [ ] **Step 4: Final commit**

```bash
git add src/app/\(app\)/media src/lib/view-models docs/architecture/current-state.md
git commit -m "feat: complete news monitoring workflow"
```

---

## Verification checklist

Before declaring the workflow complete, confirm each by running the command and reading the output — not by assuming:

- [ ] `npm run verify` passes end to end
- [ ] `npm run db:validate` passes
- [ ] `git diff --stat supabase/seed.sql` shows generated changes, and `supabase/seed.sql` was never hand-edited
- [ ] `grep -rn "relevance_score\|relevanceScore" src/lib/monitoring/` returns **no writes** — only the gate's internal score
- [ ] `grep -rn "error.message" src/lib/monitoring/ src/news/` shows no provider message reaching a stored row or a response
- [ ] Both cron routes return 401 without the correct bearer secret
- [ ] The integration screen states the 12-hour delay, the headline-only limitation, and the 10-result cap
- [ ] No page component exceeds 300 lines: `find src/app -name 'page.tsx' -exec wc -l {} + | sort -rn | head`
