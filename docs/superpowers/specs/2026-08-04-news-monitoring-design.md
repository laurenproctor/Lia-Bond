# Workflow 06 — News monitoring

Design document. Written 2026-08-04, before implementation.

**Taken ahead of workflow 05.** Drafting and brand voice remain unbuilt; this
workflow neither reads brand voice nor generates text, so the two are
independent and the ordering costs nothing. D34's promise that brand voice
becomes a table "in workflow 05" is unaffected.

## Summary

Add Lia's first *monitoring* source: news and media coverage. Where every
existing connector answers "what did people say about a place we administer",
this one answers "did anybody write about us at all" — a question with no
account to connect and no profile to map.

Four things arrive together:

1. **`monitoring_queries`** — the entity that decides what Lia watches. Named in
   `docs/data-model.md` since workflow 01 and never built, because Google never
   needed it.
2. **A `NewsMonitor` boundary** with a GNews implementation and a deterministic
   mock, alongside — not inside — `PlatformConnector`.
3. **A relevance gate** — deterministic admission control that decides whether a
   keyword match is actually about this restaurant group.
4. **A scheduler** — Vercel Cron, closing a gap named in workflows 03 and 04.

**This workflow generates and publishes no customer-facing text.** There is no
composer on the media detail screen and no publishing path to a newspaper.

## Why news is not another connector

Three structural differences, each of which forces a decision below.

**There is no account.** `PlatformConnector` is OAuth-shaped in all ten of its
methods — authorization URL, code exchange, refresh, revoke, accounts,
profiles. A news search API has an API key and a search endpoint. Roughly one
method of ten survives contact.

**There is no profile, so there is nothing to attach a mention to.** A Google
review arrives already bound to a location because the sync asked a specific
listing for it. A news article arrives bound to nothing, and something has to
decide which restaurant — if any — it concerns.

**Matching is not the same as relevance.** A Google review is unambiguously
about your restaurant. An article matching a restaurant's name usually is not.
`mentions.relevance_score` has existed since workflow 01 and nothing has ever
written to it; this is the workflow where it earns its place.

## Decisions taken

| # | Decision | Reason |
| --- | --- | --- |
| D78 | A separate `NewsMonitor` boundary, not a widened `PlatformConnector` | Eight of `PlatformConnector`'s ten methods have no meaning for a search API, and implementing them as throwers is the `if (platform === "google")` that D9 exists to prevent, relocated inside the interface. D35 set the precedent: `AiProvider` has one method because there is one thing to ask. So does this. |
| D79 | The provider key is Lia's, held in the environment, shared by every tenant | Lia buys the news plan and serves it; a restaurant group does not arrive with a GNews subscription. Nothing touches `platform_credentials`, `oauth_states`, or the AES vault. The consequence is that quota is a Lia-level resource, which is why D85 enforces it globally. |
| D80 | A `news_media` connection row is created implicitly on first query save | `mentions.platform_connection_id` is `not null`, so news mentions need a connection whether or not one means anything here. Creating it implicitly reuses the existing status and health machinery without inventing a connect flow for a credential the tenant does not hold. |
| D81 | `news_poll_runs` is a new table, not a reuse of `platform_sync_runs` | `platform_sync_runs.platform_profile_id` is `not null` and news has no profile. Making it nullable would weaken a guarantee every Google row currently relies on, to accommodate a source whose lock target (a monitoring query), counters, and failure modes are all different anyway. |
| D82 | Rejected candidates are stored, with reason and score | D26 justified `platform_sync_runs` because "a sync that failed silently looks exactly like a location with no new reviews". The same argument is sharper here: an article Lia rejected looks exactly like an article nobody wrote. "Why did you miss this story" is the first question asked of any monitoring product, and without this table the gate is unfalsifiable and therefore untunable. |
| D83 | The gate never writes `mentions.relevance_score` | D39 reserves that column for the analysis layer, which supersedes any provisional value within minutes anyway. The gate score is persisted only on rejections — where it is the thing being tuned — and as min/mean/max on the run. The invariant stays exactly as strict as it is today. |
| D84 | Incremental fetch by `publishedAfter`, the opposite of D23 | D23 refetches Google's full history because Google reorders on *edit*, so a cursor silently loses the review somebody changed their mind about. Articles are not edited into a different position, and a metered plan makes a full refetch cost real money for no correctness gain. The reasoning differs; the conclusion inverts. |
| D85 | The request budget is enforced globally, in the scheduler | D79 makes quota shared across tenants, which is new: Google's quota was per-connection, so a noisy customer could only hurt themselves. Here one organization with forty queries can exhaust the day for everyone. Enforced above the tenant loop, with headroom reserved for manual polls. |
| D86 | Syndication dedupe lives in the gate, not the provider | GNews offers no clustering. One wire story republished across forty local papers is the single largest noise source in news monitoring, so the gate normalises headlines and rejects a repeat seen within 72 hours. Deliberately provider-agnostic: it survives the Event Registry upgrade rather than being thrown away. |
| D87 | Two crons, not one chained call | A slow model batch must not be able to blow the poll window. Splitting them also finally gives `analyzeMentions()` the scheduler that workflow 04 built it to accept and never wired. |
| D88 | The poll service constructs its own `OrganizationScope` from the query row | This is the first write path in the codebase with no verified human behind it. `getOrganizationContext()` is unavailable to cron, so RLS is not the backstop it is everywhere else, and the tenancy discipline has to be explicit rather than ambient. |
| D89 | GNews free tier now, Event Registry later | The user's decision, taken with the trade-offs stated. Recorded because the free tier is licensed for development only and cannot be the state when Lia has a paying customer. See "The provider decision" below. |
| D90 | No response composer on the media detail screen | `CLAUDE.md` forbids implying publishing where the source does not support it. There is no path by which Lia posts to a newspaper, and a composer on that screen would be exactly the implication the rule prohibits. |

## The provider decision

Perigon was the first choice and has since closed self-serve registration —
it is contact-sales only. Of what remains available self-serve:

| Provider | Entry paid | Full body | Sources | Free tier |
| --- | --- | --- | --- | --- |
| GNews | €39.99/mo annual | Yes, paid only | ~60k outlets, 30 countries | Dev use only, 12h delay |
| NewsData.io | $199.99/mo | Paid only | ~97k, 206 countries | Commercially licensed |
| Event Registry | ~$90/mo, 10k tokens | Yes | 150k+, 60+ languages | Trial only |

Event Registry was selected on merit and then deferred on cost. **GNews free is
what workflow 06 builds against**, and the deferral is cheap precisely because
D78 put a boundary in the way.

What the free tier does not have, and what each absence costs:

| Missing | Consequence |
| --- | --- |
| Article body | Analysis classifies headline plus description, roughly 200 characters. Thin, but genuinely classifiable — unlike the wordless review D40 refuses to send to a model. |
| Event clustering, `isDuplicate` | Syndication dedupe becomes Lia's job. See D86. |
| Concepts (disambiguated entities) | The gate loses its strongest precision signal at the same moment its input gets thinner. The two compound, which is why D82 matters more here than it would have under Event Registry. |
| Source rank | No `source_authority` column. |
| Real-time | News is up to 12 hours behind, and the capability text must say so. |
| Paging (10 articles/request) | A busy query truncates. Runs record `truncated` rather than under-reporting silently. |
| Commercial licence | Must be resolved before Lia has a paying customer. |

The upgrade path is a second `NewsMonitor` implementation, three re-added
columns, and gate signals that are written but disabled — not a rewrite.

## Architecture

```text
cron tick (hourly, CRON_SECRET-guarded)
  └─ selectDueQueries()          ← enabled, interval elapsed, global budget OK
       └─ news_poll_runs insert  ← partial unique index on status='running' is the lock
            └─ NewsMonitor.search()        ← publishedAfter = last_polled_at
                 └─ relevance gate         ← deterministic, no model call
                      ├─ rejected → news_rejected_candidates (reason + score)
                      └─ accepted → mentions.ingest()   ← IngestMentionInput only
       └─ run updated once, with counters

cron tick (separate)
  └─ analyzeMentions()           ← existing service, status `new` → analysed
```

The boundary:

```ts
interface NewsMonitor {
  readonly platform: Platform;              // "news_media"
  capabilities(): ConnectorCapabilities;
  search(query: NewsSearchQuery): Promise<NewsSearchBatch>;
}
```

`NewsSearchQuery` is Lia's vocabulary — keywords, exclusions, language,
`sourceCountry`, `publishedAfter`. `NewsSearchBatch` returns normalised
`ExternalArticle[]` plus `requestsSpent`, `truncated`, and `malformedCount`,
mirroring `ExternalReviewBatch`. GNews's request and response shapes stay
entirely behind it.

Selection between the real client and the deterministic mock is by environment
variable, exactly as `GOOGLE_INTEGRATION_MODE` and the Anthropic provider do
(D33), and the mock is refused at environment parse in production (D20).

## Data model

### `monitoring_queries`

Organization-owned, `location_id` nullable per `docs/data-model.md`.

| Column | Notes |
| --- | --- |
| `query_type` | New enum: `brand`, `location`, `person`, `topic`. Exists because gate weights differ — a location query weights source locality, a brand query does not. |
| `keywords` | `text[]`, required terms. Pushed to the provider. |
| `exclusions` | `text[]`. GNews supports `NOT`, so these push down too. |
| `source_country` | Nullable. What GNews actually filters on. |
| `language` | Nullable. |
| `relevance_threshold` | Numeric 0–1, per query. Default set during implementation from the fixture corpus. |
| `enabled`, `poll_interval_minutes`, `last_polled_at` | Scheduling state. |

`concept_uris` and `min_source_rank` are deliberately **not** included. GNews
supplies neither, and shipping columns nothing queries contradicts the instinct
behind D18 and D34.

### `news_poll_runs`

Mirrors `platform_sync_runs` in spirit and in its constraint set — finished runs
have a timestamp, running runs are clean, errors require a code. Reuses the
existing `sync_run_status` and `sync_trigger` enums.

Differs in counters: `candidates_evaluated`, `accepted_count`,
`rejected_count`, `requests_spent`, `truncated`, plus `gate_score_min`,
`gate_score_mean`, `gate_score_max`.

The lock is a partial unique index on `monitoring_query_id where status =
'running'`, per D24 and D37 — an application check is two statements with a race
between them, and serverless means two requests are routinely two processes.
Stale `running` runs are reclaimed after 30 minutes, per D25.

### `news_rejected_candidates`

`external_id`, `url`, `title`, `publisher_domain`, `reason`, `score`,
`monitoring_query_id`, `news_poll_run_id`, `created_at`. Reasons are a Lia
vocabulary: `excluded_term`, `probable_syndication`, `below_threshold`,
`domain_denied`.

Retention capped at 30 days. Unlike `platform_sync_runs`, which accumulates
without a policy, this table has one from the start — it writes far more rows
per run than a sync does.

### Additions to `mentions`

`publisher_name`, `publisher_domain`, `is_syndicated`, `monitoring_query_id`
(nullable FK). Platform-neutral in the spirit of D21 — a Reddit crosspost has
the same shape.

Event Registry's enrichment columns (`source_authority`, `event_cluster_id`) are
**not** added now; they arrive with the provider that populates them.

`mentions_unique_external` is unchanged. `external_id` holds GNews's article
URL, which is globally unique, so re-polling upserts rather than duplicating —
exactly as it does for Google.

## The relevance gate

A pure function over a candidate and its monitoring query. No model call, no
I/O, no clock beyond an injected `now`.

**Hard rejections**, evaluated first and short-circuiting:

1. An exclusion term appears → `excluded_term`
2. The normalised headline was seen within 72 hours → `probable_syndication`
3. The publisher domain is denied → `domain_denied`

An article Lia has already ingested is **not** a rejection. It flows through to
`mentions.ingest()`, where `mentions_unique_external` upserts it and refreshes
the source-owned fields. Rejecting it would mean a corrected headline or a
changed publisher never reaches the record. D84's incremental fetch makes this
rare, not impossible — the overlap window at `publishedAfter` guarantees some
repeats.

**Scored** 0–1 for everything else, on: term placement (title outweighs
description), term occurrence count, publisher-domain locality for
`location`-type queries, and an ambiguity penalty for short or common brand
names. Below `relevance_threshold` → `below_threshold`, with the score stored.

Accepted candidates are ingested through the existing `mentions.ingest()` with
`IngestMentionInput`, so D22's guarantee holds unchanged: an ingest has no field
for status, sentiment, risk, or assignment, and a re-poll cannot move an
escalated article back to `new`.

### Attribution

`mentions.monitoring_query_id` is set on insert and **not** overwritten on
conflict — first finder wins — and `location_id` is taken from that query. An
article naming two of your restaurants attributes to one of them. That is a real
limitation, recorded in the known gaps rather than solved with a link table
nobody has asked for.

## Scheduling and budget

Hourly Vercel Cron, `CRON_SECRET`-guarded, with queries staggered across ticks
rather than polled in one burst.

The budget is requests per day, not tokens per month: 100/day, 10 articles each.
Twenty queries at a four-hour interval is 120/day and busts the limit; **at six
hours it is 80/day and fits**. This is why D85 is enforcement rather than
assumption — the ceiling is reachable with a realistic number of queries.

Day-to-date spend is `sum(requests_spent)` over `news_poll_runs`, so no counter
table. Above a reserve threshold, scheduled polls stop and the integration
capability degrades honestly while manual polls keep the remaining headroom.

Provider 429s and 5xxs back off and retry, per D30: a poll is background-shaped,
so waiting out a rate limit is right — the opposite of discovery, which runs
inside a page render.

## Surfaces

| Route | Change |
| --- | --- |
| `/integrations` | News and media card |
| `/integrations/news-media` | **New.** Capabilities, poll health, recent runs, monitoring queries, rejected candidates |
| `/media/[id]` | Now receives real articles. Headline, description, publisher, analysis, prominent link out. No composer (D90), and no pretence of being a reading surface for a body Lia does not have |
| `/mentions` | No structural change — news arrives through the existing inbox and source badge |
| `/api/cron/news-poll` | **New.** GET and POST, `CRON_SECRET`-guarded |
| `/api/cron/analyze-mentions` | **New.** GET and POST, `CRON_SECRET`-guarded |

`/integrations/news-media` sits outside `CLAUDE.md`'s fixed route list in the
same way the Google screens do — as a child of `/integrations`, which the list
contains.

**Correction, post-implementation:** the two cron routes originally shipped
exporting `POST` only, per this section's original "POST only" wording. That
was wrong — Vercel Cron invokes scheduled routes with `GET`, and the App
Router 405s any method a route module does not export — so every scheduled
poll and analysis sweep 405ed and never ran until a whole-branch review
caught it. Both routes now export `GET` and `POST` from one shared handler.
The table above has been corrected in place rather than left wrong with a
note beside it, since this exact sentence is what the implementation copied.

Capability text must state three limits plainly: news is up to 12 hours behind,
Lia holds headline and description rather than the article, and one poll returns
at most 10 matches.

## Permissions

Two additions to the matrix in `src/lib/auth/permissions.ts`:

| Permission | Roles | Analogue |
| --- | --- | --- |
| `monitoring.manage_queries` | `owner`, `admin`, `communications_lead` | `integration.manage_profiles` — deciding what Lia watches is the same class of decision as deciding which locations it syncs |
| `monitoring.poll_now` | `owner`, `admin`, `communications_lead` | `integration.sync_reviews` |

No read permission, per D19. Rejected candidates in particular are diagnostic,
and gating them would mean the person asking "why did we miss this" often cannot
see the answer.

## Testing

| Surface | Approach |
| --- | --- |
| Relevance gate | The highest-value target and the only genuinely new logic. Pure function, tested against a fixture corpus: obvious matches, obvious noise, the ambiguous-brand-name case, a syndication cluster, and every hard-rejection reason |
| GNews client | Stubbed `fetch`, matching workflows 02–04 |
| Mock monitor | Deterministic, env-selected, refused in production at environment parse |
| Poll service | Lock contention, stale reclaim, budget exhaustion, provider failure, truncation |
| Cron routes | Reject without `CRON_SECRET` |
| Seed data | Monitoring queries and news mentions added to `src/lib/seed/dataset.ts`, which regenerates `seed.sql`. Per D3 they cannot be hand-added to the SQL |
| RLS | All three new tables verified against live Postgres, as the existing policies are |

## Out of scope

Article comments and Disqus, despite `article_comment` existing in the enum — a
different connector with a different consent model. Reddit. Response generation
for articles, which is workflow 05's brand-voice territory. Per-location outlet
curation. Push notification: a critical story auto-creates an escalation via
D38, and the escalation centre is the alerting surface for now.

## Known gaps this will ship with

- **The GNews API will not have been called live** unless a key is obtained
  first — the same position workflows 02, 03, and 04 all shipped in, and named
  in each of their gap lists.
- **Gate thresholds are unvalidated** against labelled data, exactly as prompt
  quality is per D43. The rejections table exists so a later threshold can be
  compared against this one.
- **The free tier is licensed for development only.** Must be resolved before
  commercial use.
- News is up to 12 hours behind, and the analysis layer sees headline and
  description rather than the article.
- A poll returning more than 10 matches truncates; no paging is available.
- An article naming two restaurants attributes to one. First finder wins; see
  "Attribution".
- Syndication detection is headline-similarity only. A rewritten wire story
  under a different headline will produce a second mention.
- No notification beyond escalation. A critical story found at 03:00 waits for
  somebody to open the escalations centre.
- `news_rejected_candidates` has a 30-day retention policy but no sweeper job
  until one exists to hang it on.
