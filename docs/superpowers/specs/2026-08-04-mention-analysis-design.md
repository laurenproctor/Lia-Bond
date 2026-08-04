# Workflow 04 — AI provider layer and mention analysis

Design document. Written 2026-08-04, before implementation.

## Summary

Add Lia's first AI capability: a provider boundary for Anthropic's API, and a
mention-analysis pipeline that populates the `mention_analyses` table and the
denormalised risk, sentiment, and relevance columns on `mentions`.

Analysis runs as its own bounded, locked, audited run — the same shape as the
Google review sync from workflow 03 — and auto-creates an escalation when it
finds high or critical risk.

**This workflow does not generate or publish a single word of customer-facing
text.** Drafting is workflow 05.

## Why this, before drafting

Workflow 03 imports Google reviews into `public.mentions` with
`risk_level` defaulting to `low` and `sentiment` to `unknown`. Nothing writes to
`mention_analyses` — the table is seeded but has never been populated by code.
Every imported review is therefore "low risk, unknown sentiment".

That matters because Lia's safety guarantees are already written and are all
keyed to risk:

- `docs/product-spec.md` — "High-risk content must always be escalated."
- `isAutoPublishSafe()` in `src/domain/entities/automation.ts` gates
  `auto_publish` on a `risk_level` condition.

Ship drafting first and those guards read `low` for a food-safety complaint and
pass it. The star rating is a partial proxy but does not catch a calmly-worded
three-star review describing an allergic reaction.

So analysis comes first, and the guardrails become real before anything
generates text a customer will read.

## Decisions taken

Recorded because several were close calls and the reasoning should outlive the
conversation.

| # | Decision | Reason |
| --- | --- | --- |
| D32 | Workflow 04 is analysis only; drafting is workflow 05 | The risk signal that drafting's safety rules depend on does not exist yet. Building both together lands customer-facing text generation in the same pass as its own safety inputs. |
| D33 | Real Anthropic SDK **plus** a deterministic mock chosen by env | Exactly the `GOOGLE_INTEGRATION_MODE` pattern from workflow 02. Tests and local development run with no API key; production refuses the mock at environment parse. |
| D34 | Brand voice stays a typed fixture | Analysis does not read brand voice. Promoting it to a table now ships schema nothing queries. It becomes real in workflow 05, where it drives generation. |
| D35 | No publishing, and no publishing state machine | `canPublishResponses` stays false. Publishing needs its own workflow for retries, external-id reconciliation, and the failure modes of writing to a customer's public listing. |
| D36 | One model call per mention, returning one combined structured analysis | `mention_analyses` is one row carrying all five results — the schema already says this. The fields are interdependent (risk depends on topics; recommended action depends on risk), so five separate calls would each re-read the review and still merge into one row. |
| D37 | Analysis is its own run with a database-backed lock | Mirrors `platform_sync_runs`. A scheduler can call the same service later without changing it. |
| D38 | High and critical risk auto-create an open, unassigned escalation | Keeps the product spec's promise. Reversible by dismissal, and an unowned item in the escalations centre is precisely the "someone must look at this" signal. Assignment stays a human decision. |
| D39 | Analysis writes the denormalised mention columns and advances status only from `new` | The inbox filters, the risk index, and every chart read those columns. Advancing only from `new` means a status a person set is never overwritten. |
| D40 | Rating-only reviews are analysed deterministically, with no model call | A rating with no text has nothing to classify. Workflow 03 imports many of them. Free, instant, and a pure function that can be tested as itself. |
| D41 | Reviewer display names are sent to the model | The user's explicit decision. Reviews are public; reviewer names are personal data, and this sends them to a third party for a classification task that does not require them. Recorded here so the trade-off is visible rather than implicit. |
| D42 | The `mention_analyses` insert is the per-item commit point | No transaction is available (D17). Ordering escalation → mention update → analysis insert means a crash costs a repeated model call and never a silently un-analysed mention. |
| D43 | `effort` left at the API default (`high`) | Judging whether a mildly-worded review describes a food-safety incident is the intelligence-sensitive call the guardrails rest on. Sweeping down to `medium`/`low` is the right follow-up once there is labelled data to check it against, not a guess made before the feature has run. |
| D44 | Synchronous Messages API, not the Batches API | Batches are 50% cheaper and can take up to an hour. Wrong for a button somebody is waiting on; the natural home for a future scheduled overnight run. |

## Architecture

Mirrors the existing split: the module that knows the vendor never knows about
organizations, and the module that knows Lia never touches the SDK.

```text
src/ai/                      the model boundary — no Lia domain knowledge
  provider.ts                AiProvider interface, result types
  errors.ts                  AiError + normalised codes (mirrors integrations/errors.ts)
  registry.ts                live | mock | unconfigured, resolved from env
  anthropic/client.ts        @anthropic-ai/sdk — the only network I/O
  mock-provider.ts           deterministic fixtures; refused in production

src/lib/analysis/            orchestration — knows Lia, never touches the SDK
  schema.ts                  Zod schema for the model's structured output
  prompt.ts                  system prompt + ANALYSIS_PROMPT_VERSION
  heuristic.ts               rating-only analysis, no model call
  normalize.ts               structured output -> CreateMentionAnalysisInput (pure)
  analyze.ts                 the run service: lock, batch, persist, audit
```

`AiProvider` exposes **one** method today — `analyzeMention()`. It is not a
general LLM abstraction. Decision D9 already established that inventing
extension points for implementations that do not exist is guessing at their
requirements; workflow 05 adds a `draftResponse()` sibling.

New dependency: `@anthropic-ai/sdk`.

## Data model

### Migration `20260804000100_mention_analysis.sql`

Statement order matters: `analysis_runs` is created **first**, because the
`mention_analyses` column added below carries a foreign key to it.

**`analysis_runs`** — new, shaped like `platform_sync_runs` but organization-
scoped rather than profile-scoped:

| Column | Notes |
| --- | --- |
| `id`, `organization_id` | |
| `trigger` | reuses `sync_trigger` (`manual` \| `scheduled`) |
| `actor_user_id` | null for scheduled runs; nulled rather than cascaded |
| `status` | reuses `sync_run_status` (`running` \| `completed` \| `partial` \| `failed`) |
| `started_at`, `completed_at` | caller-supplied, so both adapters record one instant |
| `analyzed_count` | mentions analysed **by the model** |
| `heuristic_count` | mentions analysed by the rating heuristic, with no model call |
| `escalated_count` | escalations this run created |
| `failed_count` | mentions that could not be analysed |
| `remaining_count` | backlog left after the cap — the "no silent caps" rule made structural |
| `model_provider`, `model_name`, `prompt_version` | what produced this run's analyses |
| `error_code`, `error_message` | Lia's own sentence, capped at 400 |
| `created_at`, `updated_at` | |

```sql
create unique index analysis_runs_one_active
  on public.analysis_runs (organization_id) where status = 'running';
```

That index **is** the lock, for the same reason as workflow 03: an application
check is two statements with a race between them, and Lia runs on serverless
functions where two concurrent requests are routinely two processes. Runs left
`running` by a dead process are reclaimed after 30 minutes
(`SYNC_RUN_STALE_AFTER_MS`, already defined).

Constraints mirror `platform_sync_runs`: a finished run has a `completed_at`, a
running one has neither `completed_at` nor `error_code`, an error message
requires an error code, and a failed run must say why.

Indexes: `(organization_id, started_at desc)` for history.

**`mention_analyses`** already carries every field the analysis produces —
relevance score and explanation, sentiment and sentiment score, risk level,
risk categories, risk explanation, topics, facts needing verification,
recommended action and its explanation. Only provenance is added:

```sql
alter table public.mention_analyses
  add column analysis_run_id uuid references public.analysis_runs (id) on delete set null,
  add column input_tokens integer check (input_tokens is null or input_tokens >= 0),
  add column output_tokens integer check (output_tokens is null or output_tokens >= 0);
```

Token counts because "what did last night's run cost" is a question somebody
will ask, and reconstructing it from a bill is worse than recording it. Null on
heuristic analyses, which spend none.

### Enums, audit, permissions

- **Reuse** `sync_run_status` and `sync_trigger`. Minting near-identical enums
  for "the same idea, different subsystem" is how a schema accumulates
  synonyms.
- **Three new audit event types**, added to the closed list in both
  `src/domain/enums.ts` and the `audit_events_known_event_type` check
  constraint: `mention.analyzed`, `mention.analysis_failed`,
  `escalation.created_from_analysis`.
- **One new permission**: `mention.analyze` → owner, admin,
  communications_lead. The same three that hold `integration.sync_reviews`, for
  the same reason — it spends money and fills the queue those roles own.
  Location managers are absent: a run spans every location.

### RLS — `20260804000200_mention_analysis_rls.sql`

`analysis_runs`: select for any active member (telling "nothing new" from "the
analyser is broken" is not a privileged question); insert and update restricted
to owner / admin / communications_lead, matching the permission; no delete
policy, and delete revoked.

`mention_analyses` already has select and insert policies from the foundation
and needs none added — RLS is per row, not per column.

## Environment

Three variables, following the `GOOGLE_INTEGRATION_MODE` pattern exactly. Shape
validated at startup, presence at first use, so the app still builds and runs
with no key configured.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **server only** | Never `NEXT_PUBLIC_`, never imported into a client component. |
| `LIA_AI_MODE` | server | `live` \| `mock`. Unset decides from the key's presence. `mock` refused at environment parse when `NODE_ENV=production`. |
| `LIA_ANALYSIS_BATCH_SIZE` | server | Mentions per run. Default 50. |

The model id is pinned in code as `claude-opus-5`, not exposed as an
environment variable — it is a correctness-relevant choice, not a deployment
knob.

`.env.example` gains all three, with the same annotations the Google variables
carry.

## The analysis call

```ts
const result = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 8000,
  system: [{ type: "text", text: SYSTEM_PROMPT,
             cache_control: { type: "ephemeral" } }],
  output_config: { format: zodOutputFormat(mentionAnalysisOutputSchema) },
  messages: [{ role: "user", content: renderMention(mention, location) }],
});
```

**`zodOutputFormat`.** The repo validates every boundary with Zod already. The
SDK helper turns the same schema into the model's output constraint, so one
declaration produces both the API contract and the runtime parse, with no
hand-written JSON Schema to drift from it.

**`max_tokens: 8000`.** Thinking is on by default on Claude Opus 5 and shares
this budget with the response. The structured analysis itself is small; the
headroom is for thinking.

**The cached system prompt** carries the risk taxonomy, the escalation
categories, and the scoring definitions — identical for every mention in a run
and comfortably over the 512-token cache minimum. This drives the run's
concurrency shape: the **first call runs alone to write the cache, then the
remainder run with bounded concurrency** and read it at roughly a tenth of
input price. Firing all fifty at once would pay full price fifty times, because
no request can read a cache entry another is still writing.

### Structured output shape

`mentionAnalysisOutputSchema` mirrors `mention_analyses` and is validated
against the existing domain enums:

```text
relevanceScore              0–1
relevanceExplanation        string
sentiment                   positive | neutral | negative | mixed | unknown
sentimentScore              −1–1
riskLevel                   low | medium | high | critical
riskCategories              escalation category enum, array
riskExplanation             string
topics                      string array
factsNeedingVerification    string array
recommendedAction           recommended action enum
recommendationExplanation   string
escalationTitle             string, optional
```

`escalationTitle` is optional rather than conditionally required: JSON Schema
support for conditional requirements is limited, and a missing title must never
block an escalation. When risk is high or critical and the model omitted one,
the title is derived deterministically from the category and the location.

### Rating-only reviews

`heuristic.ts` produces the analysis directly, with no provider call: sentiment
derived from the star rating, `riskLevel: "low"`, a fixed relevance,
`recommendedAction: "monitor"`. Stored with `model_provider: 'lia'` and
`model_name: 'rating-heuristic'` — honest provenance, so nobody later mistakes
it for model output. Counted as `skipped` in the run.

## What a successful analysis writes

Three writes per mention, in this order:

1. **Escalation** — only when risk is `high` or `critical`, and only when the
   mention has none already. Created `open` and **unassigned**.
2. **Mention update** — `sentiment`, `risk_level`, `relevance_score`, and
   `status` advanced **only when it is still `new`**.
3. **`mention_analyses` insert** — append-only, carrying `analysis_run_id` and
   token counts. **This is the commit point.**

Selection is "mentions with no analysis row", so the insert is what makes a
mention done. A crash before it means the mention is selected again next run:
the escalation is deduped by mention id, the mention update is a set of fixed
values, and the analyses table is append-only. Every step is individually
idempotent, and the cost of a mid-item failure is one repeated model call.

The inverse ordering is the tempting one and it is wrong: analysis-first means a
failure at step 2 leaves a mention that *looks* analysed, never receives its
risk level, and is never selected again — the guardrail failing silently, which
is the exact outcome this workflow exists to prevent.

### The ownership line

Workflow 03 established that **a sync may not write Lia state**. Workflow 04
establishes the mirror: **an analysis may not write source state.** Analysis
never touches `content`, `rating`, `author_name`, `published_at`, or any
`source_*` column. Each side owns its columns and neither can reach the other's,
enforced by the input types rather than by care at the call site.

Advancing status only from `new` means a mention somebody has already escalated,
dismissed, or responded to keeps the state that person put it in.

## The run

```text
analyzeMentions(context, { limit, trigger })
  |- resolve permission + organization scope
  |- open analysis_run                  <- the lock (partial unique index)
  |- select unanalysed mentions, oldest first, capped at limit
  |- heuristic pass                     <- rating-only, free, no model call
  |- first model call alone             <- warms the prompt cache
  |- remaining, bounded concurrency
  |- per mention: escalation -> mention update -> analysis insert
  |- count the backlog left over        <- remaining_count
  |- finish run + audit event
```

Oldest-first so a backlog drains in arrival order rather than the newest fifty
being re-analysed forever.

## Error handling

| Failure | Handling |
| --- | --- |
| `ANTHROPIC_API_KEY` unset | `ConfigurationError` naming the variable. Operator problem, not a user one — same path as Google. |
| `stop_reason: "refusal"` | **Per item**, recorded as `refused`; the run continues. Real for this product: a review describing an injury or a violent incident can trip a classifier, and one such review must not fail the other forty-nine. Checked before reading response content. |
| 401 / permission denied | Abort the run. It will not fix itself, and retrying wastes money while delaying the one message an operator can act on. |
| 429 / 529 overloaded | SDK retries with backoff. Still failing, the run stops early, is marked `partial`, and records what is left in `remaining_count`. |
| Network failure | Retried by the SDK, then per item. |
| `stop_reason: "max_tokens"` | Per item, `output_truncated`. A real case, not a theoretical one — thinking shares the budget. |
| Schema mismatch (`parsed_output` null) | Per item, `unexpected_output`. |
| Database write failure | Per item; the commit-point ordering above makes it retriable. |
| Concurrent run | `DataError("conflict")` raised **before** a run row is opened, so a refused attempt leaves no failed row in a history an operator reads. |
| Cross-organization access | Scoped repository lookups; simply not found. |
| Empty backlog | `completed`, zero analysed, and the UI says so rather than showing an error. |

Provider failures are normalised into `AiError` codes in `src/ai/errors.ts`,
chosen around what the user must do next. A raw SDK message never reaches a
screen — the same rule `IntegrationError` already enforces.

## Authorization and security

- `mention.analyze` gates the action through the central matrix; analysts and
  viewers hold it nowhere.
- Every repository call is organization-scoped, so a mention id from another
  tenant is not found.
- `ANTHROPIC_API_KEY` is server-only and never appears in a log line, an error
  message, an audit event, or an API response.
- Audit events carry counts, a model name, a prompt version, and a normalised
  error code — never review text, never a reviewer's name, never the prompt.
- Reviewer display names **are** sent to the model provider (D41).

## User interface

A card on `/mentions`, the screen where the unanalysed backlog is already
visible:

- count of unanalysed mentions
- **Analyse** button, gated on `mention.analyze`
- last run: when, counts, and how many remain
- last sanitised error when the previous run failed
- disabled with a "running" state while a run holds the lock

After a run: refresh the inbox, and show a restrained summary — "42 analysed, 3
escalated, 118 remaining."

No other screen changes. The escalations centre, the insights charts, and the
risk filters all already read the columns this populates and start working
without modification, which is the point of writing the denormalised fields.

## Testing

Same shape as workflow 03: fake the provider, run everything else for real.

### Pure, no I/O

- rating heuristic — each star value maps to the right sentiment
- structured output → `CreateMentionAnalysisInput` mapping
- escalation-title derivation when the model omits one

### Client, stubbed `fetch`

The Anthropic SDK accepts a custom `fetch`, so the same stub pattern as
`tests/google-review-client.test.ts` applies.

- refusal is surfaced as a typed code, not a crash
- truncation and schema mismatch classified correctly
- retries are bounded; 401 is not retried
- no key appears in any URL or error message

### Service, real repositories + fake provider

- high risk creates an open, unassigned escalation; low risk creates none
- a mention already escalated by a person keeps that status
- **source-owned fields are byte-identical after analysis** — the mirror of
  workflow 03's Lia-fields test
- re-running analyses only the backlog, not what is already done
- the cap sets `remaining_count`, proving nothing is silently dropped
- one refused item does not cost the others
- a rating-only review makes **zero** provider calls, asserted on the fake's
  call counter
- a concurrent run is refused and leaves no run row
- a failed run fabricates no analyses
- permission matrix: analyst and viewer refused
- cross-organization access rejected

## Documentation

- New `docs/ai/analysis.md` — what it does, the prompt contract, the cost model,
  how to run it, how to read a run, known limits.
- `docs/architecture/current-state.md` — decisions D32–D44, new routes, known
  gaps.
- `README.md` — the three environment variables and how to run analysis in mock
  mode.
- `.env.example`.

## Non-goals

No drafting. No brand voice table. No response generation of any kind. No rules
execution. No scheduler. No Batches API. No publishing, and no publishing state
machine. No notifications. No re-analysis UI. No changes to the Google
integration.

## Known risks

- **Prompt quality is unvalidated.** There is no labelled dataset, so the first
  version's risk classification is untested against ground truth. The
  `prompt_version` column and the append-only analyses table exist so a later
  version can be compared against this one.
- **Cost is bounded per run, not per day.** Fifty mentions per click, with no
  daily ceiling. Adequate while the trigger is manual; a scheduler needs one.
- **`effort` is unswept** (D43). Deliberate — the sweep needs real data.
- **The Anthropic API has never been called from this repository.** Same
  position workflow 02 was in with Google: every test stubs the provider.
- **Auto-escalation is a machine decision.** A false critical creates an
  escalation somebody must dismiss. Judged the right direction to fail, but it
  is a real cost and worth measuring once there is volume.

## The boundary for workflow 05

> Google review response workspace and AI-assisted draft generation — using
> imported reviews, their analyses, brand voice, response rules, citations to
> relevant customer details, human approval, and an explicit separation between
> drafting and publishing.

It inherits, ready to use: populated `mention_analyses` rows with risk,
sentiment, topics, and a recommended action; escalations already raised on the
high-risk mentions that must never be drafted casually; an `AiProvider`
boundary with a mock, an error vocabulary, and a run pattern; and the brand
voice fixture, which becomes a table there because that is where it first drives
generation.

It must not: publish to Google, add a scheduler, or widen the Google OAuth
scopes.
