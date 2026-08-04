# Mention analysis

Lia's first AI capability. Delivered in workflow 04.

Classifies each imported mention for relevance, sentiment, topics, and risk;
records the result in `mention_analyses`; and raises an escalation when it finds
something serious.

> **It generates no customer-facing text.** Analysis produces classifications
> that a person reads. Drafting a reply is workflow 05, and there is no code in
> this workflow that could produce one.
>
> **It is not monitoring.** Analysis runs when somebody asks it to. There is no
> scheduler, so a backlog stays a backlog until a run clears it.

## 1. Why this came before drafting

Workflow 03 imports Google reviews with `risk_level` defaulting to `low` and
`sentiment` to `unknown`, and nothing had ever written to `mention_analyses`.
Every imported review therefore read as low-risk.

That mattered because Lia's safety promises were already written and were all
keyed to risk:

- `docs/product-spec.md` — "High-risk content must always be escalated."
- `isAutoPublishSafe()` in `src/domain/entities/automation.ts` gates
  `auto_publish` on a `risk_level` condition.

Ship drafting first and those guards read `low` for a food-safety complaint and
pass it. The star rating is a partial proxy, but it does not catch a
calmly-worded three-star review describing an allergic reaction.

So analysis came first, and the guardrails became real before anything
generated text a customer would read.

## 2. Architecture

```text
src/ai/                      the model boundary — no Lia domain knowledge
  provider.ts                AiProvider interface, result types
  errors.ts                  AiError + normalised codes
  registry.ts                live | mock | unconfigured, from env
  anthropic/client.ts        @anthropic-ai/sdk — the only network I/O
  mock-provider.ts           deterministic fixtures; refused in production

src/lib/analysis/            orchestration — knows Lia, never touches the SDK
  schema.ts                  Zod schema for the model's structured output
  prompt.ts                  system prompt + ANALYSIS_PROMPT_VERSION
  heuristic.ts               rating-only analysis, no model call
  normalize.ts               model output -> Lia's shape (pure)
  analyze.ts                 the run: lock, batch, persist, escalate, audit
```

The same split as `src/integrations/` and `src/lib/integrations/`, for the same
reason: nothing above `src/ai/` handles an HTTP status or a model name, and
nothing below it knows what an organization is.

`AiProvider` has **one** method. It is not a general LLM abstraction — decision
D9 established that inventing extension points for implementations that do not
exist is guessing at their requirements, and that applies here unchanged.
Workflow 05 adds a `draftResponse()` sibling when there is a second real caller
to shape it.

## 3. Running an analysis

**In the product.** `/mentions` → the analysis card at the top shows the
unanalysed backlog and an **Analyze** button. Requires the `mention.analyze`
permission (owner, admin, communications lead).

**In code**, including from a future scheduled job:

```ts
import { analyzeMentions } from "@/lib/analysis/analyze";

await analyzeMentions(
  { dataSource, scope },
  { trigger: "scheduled", limit: 200 },
);
```

The service takes no request context, so a job can call it directly. Nothing
about it assumes a person is waiting.

## 4. What one run does

```text
analyzeMentions(context, { limit, trigger })
  |- resolve the provider              <- fails here if unconfigured, before a run row exists
  |- open analysis_run                 <- the lock (partial unique index)
  |- select unanalysed mentions, oldest first, capped at limit
  |- count the whole backlog           <- so the cap can report what it left
  |- rating-only mentions first        <- free, no model call, cannot fail on the provider
  |- first model call alone            <- writes the prompt cache
  |- remaining, 4 at a time            <- read the cache
  |- per mention: escalation -> mention update -> analysis insert
  |- finish the run + audit event
```

Oldest-first, so a backlog drains in arrival order rather than the newest batch
being re-picked while older mentions never surface.

### The model call

| Setting | Value | Why |
| --- | --- | --- |
| Model | `claude-opus-5` | Pinned in code, not env — a correctness-relevant choice, not a deployment knob. |
| `max_tokens` | 8,000 | Thinking is on by default on this model and shares the budget with the response. The analysis is small; the headroom is for thinking. |
| `effort` | API default (`high`) | Deciding whether a mildly-worded review describes a safety incident is the judgement the guardrails rest on. Sweeping down needs labelled data first. |
| Output | `output_config.format` + `zodOutputFormat` | One Zod declaration produces both the API constraint and the runtime parse, so there is no hand-written JSON Schema to drift. |
| System prompt | `cache_control: ephemeral` | Identical for every mention in a run. |

**The cache drives the concurrency shape.** No request can read a cache entry
another is still writing, so the first model call in a run goes alone; the rest
follow four at a time and read it at roughly a tenth of input price. Firing all
fifty at once would pay full price fifty times.

### Rating-only reviews skip the model entirely

A rating with no text has nothing to classify — no claim to assess, no topic to
extract, no fact to verify. Workflow 03 imports a great many of these, so they
are handled by a pure function in `heuristic.ts` instead: sentiment from the
rating, risk always `low`, no topics, no invented facts.

The saving is incidental. The real reason is that asking a model to explain a
four-star review with no text invites it to invent a reason, and an invented
reason stored as an analysis is worse than an honest shallow one — a later
drafting workflow would quote it back.

Stored with `model_provider: 'lia'`, `model_name: 'rating-heuristic'`, and no
prompt version, so a reader can always tell which analyses a model actually
weighed. Counted separately as `heuristic_count`.

**A one-star review with no words is still `low` risk.** It could be about
anything — but "could be anything" is not evidence of a food-safety incident,
and manufacturing a high risk from a silent rating would fill the escalations
queue with cases nobody can act on, which is how a queue stops being read.

## 5. What a successful analysis writes

Three writes per mention, in this order:

1. **Escalation** — only at `high`/`critical` risk, and only when the mention
   has none. Created `open` and **unassigned**.
2. **Mention update** — `sentiment`, `risk_level`, `relevance_score`, and
   `status` advanced **only from `new`**.
3. **`mention_analyses` insert** — append-only. **This is the commit point.**

Selection is "mentions with no analysis row", so the insert is what makes a
mention done. There is no transaction available (decision D17: the demo adapter
has none and PostgREST exposes none), so this ordering is what makes a partial
failure safe — die before the insert and the mention is simply picked up again,
where the escalation dedupe and the idempotent mention update absorb the repeat.
The cost of a mid-item crash is one repeated model call.

The reverse order is the tempting one and it is wrong: analysis-first means a
failure at step 2 leaves a mention that *looks* analysed, never receives its
risk level, and is never selected again — the guardrail failing silently.

### The ownership line

Workflow 03 established that **a sync may not write Lia state**. This workflow
establishes the mirror: **an analysis may not write source state.**

Analysis never touches `content`, `rating`, `author_name`, `published_at`, or
any `source_*` column. `MentionAnalysisOutcome` has fields for exactly four
columns, so the guarantee is structural rather than a rule a call site has to
remember.

Advancing status only from `new` means a mention somebody has escalated,
dismissed, or responded to keeps the state that person set. In Postgres this is
`eq("status", "new")` in the update itself rather than a read-then-write, so a
race resolves in the person's favour.

## 6. Escalation

`high` and `critical` risk auto-create an escalation, keeping the product
spec's promise that high-risk content is always escalated.

- **`open` and unassigned.** An unowned item in the escalations centre is
  precisely the "somebody must look at this" signal; a default owner would make
  it look handled. Assignment stays a human decision.
- **One per mention.** A mention that already has an escalation gets none —
  two open cases for one review is a queue nobody trusts, and a re-run must not
  produce that.
- **No due date.** Inventing an SLA the organization never agreed to would put
  a deadline in the queue that nobody set and nobody owns.
- **Title derived when the model omits one.** `escalations.title` is `not null`
  with a length check, so an empty title would fail the insert and the
  escalation would silently not exist.

The mention moves to `escalated` rather than `analyzed`, so it reads correctly
in the queue.

## 7. Errors

| Failure | Handling |
| --- | --- |
| `ANTHROPIC_API_KEY` unset | `ConfigurationError` naming the variable, raised **before** a run opens so no failed row is left behind. |
| Refusal (`stop_reason: "refusal"`) | **Per item.** Real for this product: a review describing an injury or an assault can trip a safety classifier, and those are the reviews that most need reading. One must not cost the other forty-nine. Checked before reading content, which is empty or partial on a refusal. |
| 401 / permission denied | **Ends the run.** It will not fix itself; retrying wastes money and delays the one message an operator can act on. What the run did not reach is counted back into `remaining`. |
| 429 / 529 | Retried by the SDK with backoff, then per item. |
| Network failure | Same. |
| `stop_reason: "max_tokens"` | Per item. A real case — thinking shares the budget. |
| Schema mismatch | Per item, `unexpected_output`. |
| Database write failure | Per item; the commit-point ordering makes it retriable. |
| Concurrent run | `DataError("conflict")`, raised before a run row exists. |
| Empty backlog | `completed`, and the UI says so rather than showing an error. |

**No provider message ever reaches a user, a log, or a stored row.** This is
stricter than the rule for Google, and for a specific reason: a model error can
echo the prompt, and the prompt contains the review text and the reviewer's
name. Provider text is a disclosure risk here, not merely unhelpful.

## 8. Concurrency

`analysis_runs_one_active`, a partial unique index on `(organization_id)` where
`status = 'running'`, **is** the lock. Opening a run is the whole of the
concurrency control — the application never checks first and then inserts,
because that is two statements with a race between them, and Lia runs on
serverless functions where two concurrent requests are routinely two processes.

Scoped to the organization rather than to a mention: analysis walks a shared
backlog, so two runs would race over the same rows and pay twice for the
overlap.

A run left `running` by a dead process is reclaimed after **30 minutes**
(`ANALYSIS_RUN_STALE_AFTER_MS`) and closed as `analysis_abandoned`. Without
that, one crash would block an organization's analysis until somebody edited the
database.

## 9. Inspecting a run

- **In the product**: the `/mentions` card shows the backlog, the last
  successful run, whether one is running, and the last sanitised error.
- **In the database**: `public.analysis_runs` — actor, trigger, timings, the
  five counts, model, prompt version, and a normalised error code. Readable by
  any active member, deliberately: telling "nothing new" from "the analyser has
  been failing for two days" is not a privileged question.
- **Per analysis**: `mention_analyses.analysis_run_id` ties each row to its run,
  and `input_tokens`/`output_tokens` record what it cost.
- **In the audit trail**: `mention.analyzed`, `mention.analysis_failed`, and
  `escalation.created_from_analysis`. Metadata carries counts, a model name, a
  prompt version, and a code — never review text, a reviewer's name, or the
  prompt, which contains both.

### The counts

| Count | Meaning |
| --- | --- |
| `analyzed` | Classified by the model. |
| `heuristic` | Classified by the rating heuristic, with no model call. |
| `escalated` | Escalations **this run** raised. A mention that already had one is not counted. |
| `failed` | Could not be classified. Still unanalysed, so a later run retries. |
| `remaining` | Backlog left after the cap, plus anything a fatal error stopped it reaching. |

`analyzed` and `heuristic` are separate because they cost differently and mean
differently — folding them together would make both the bill and the coverage
unreadable.

## 10. Prompt versioning

`ANALYSIS_PROMPT_VERSION` is stored on every row a run produces. Because
`mention_analyses` is append-only, re-analysing under a new version leaves both
readings side by side instead of overwriting the evidence that the change
helped.

**Bump it whenever the prompt changes in a way that could move an output.** Not
bumping is worse than bumping needlessly: two different prompts recorded under
one version make every comparison meaningless.

## 11. Cost

One model call per mention with written text; zero for rating-only. Bounded per
run by `LIA_ANALYSIS_BATCH_SIZE` (default 50). The system prompt is cached, so
after the first call each mention in a run pays roughly a tenth of the input
price for the shared prefix.

Per-analysis token counts are on `mention_analyses`, so actual spend is a query
rather than a guess.

**There is no daily ceiling** — only a per-run one. Adequate while the trigger
is manual; a scheduler needs one.

## 12. Local development

```bash
# .env.local
LIA_AI_MODE=mock
```

The mock walks the entire pipeline — the lock, the batching, the persistence,
the escalation, the audit trail — with no API key and no bill. It is
deterministic and keyword-driven, so typing a review mentioning an allergic
reaction produces a critical escalation locally.

Refused at environment parse when `NODE_ENV=production`, for a sharper reason
than the Google mock: a fabricated "low risk" on a food-safety complaint is not
a cosmetic problem.

## 13. Known limitations

1. **Prompt quality is unvalidated.** There is no labelled dataset, so the
   first version's risk classification is untested against ground truth. The
   `prompt_version` column and the append-only table exist so a later version
   can be compared against this one.
2. **`effort` is unswept.** Left at the API default deliberately — the sweep
   needs real data to check quality against.
3. **No scheduler.** `analyzeMentions()` accepts `trigger: "scheduled"` and
   needs no request context, but nothing calls it on a timer.
4. **No daily cost ceiling.** Per-run only.
5. **Auto-escalation is a machine decision.** A false critical creates an
   escalation somebody must dismiss. Judged the right direction to fail, but a
   real cost worth measuring once there is volume.
6. **The Anthropic API has never been called from this repository.** Same
   position workflow 02 was in with Google: every test stubs the provider.
7. **Reviewer display names are sent to the model provider.** An explicit
   decision (D41), recorded because it sends personal data to a third party for
   a classification task that does not strictly require it.
8. **No re-analysis UI.** The table supports it — append-only, readers take the
   latest — but nothing in the product triggers it.
9. **Analysis is per organization, not per location.** There is no way to
   analyse one restaurant's backlog only.

## 14. The boundary for workflow 05

> Google review response workspace and AI-assisted draft generation — using
> imported reviews, their analyses, brand voice, response rules, citations to
> relevant customer details, human approval, and an explicit separation between
> drafting and publishing.

It inherits, ready to use: populated `mention_analyses` rows carrying risk,
sentiment, topics, recommended action, and the facts a human must verify;
escalations already raised on the high-risk mentions that must never be drafted
casually; an `AiProvider` boundary with a mock, an error vocabulary, and a run
pattern to copy; and the brand voice fixture, which becomes a table there
because that is where it first drives generation.

It must not: publish to Google, add a scheduler, or widen the OAuth scopes.
