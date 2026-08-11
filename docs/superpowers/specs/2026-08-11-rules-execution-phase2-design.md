# Rules execution engine (Phase 2) — design

Design document, v1. Written 2026-08-11. Not implemented.

Builds the execution engine designed at design resolution in
`docs/superpowers/plans/2026-08-07-rules-and-automation.md` ("Phase 2
design"), re-planned here against the shipped Phase 1 codebase as that plan
required. Decisions D138–D147 stand unchanged; this spec resolves the
questions the plan deliberately left open.

## Scope

**In scope** (the plan's ordered tasks ①–⑥):

1. `automation_rule_executions` table, RLS, and repository methods.
2. Pure conflict-resolution module with exhaustive tests.
3. Executor registry with `set_status` and `escalate` only.
4. Sweep integration behind an env flag, default off.
5. Idempotency and retry tests.
6. Per-rule outcome UI on `/rules/[ruleId]`: real "Last run" and an
   execution history list.

**Out of scope** (the plan's task ⑦ and its prerequisites): executors for
`generate_draft`, `require_approval`, `notify`, `auto_publish` — each blocked
on a prerequisite from Section 3 of the plan (draft generation service,
approval-request path, notification decision, publishing connector). Each
unlocks later in its own PR against the conflict semantics this phase pins.
Also out of scope: backfill of any kind, `assign`/`tag` semantics (blocked on
product decisions), and rule history/performance summary modules.

## Decisions resolved by this spec

- **Sweep population: just-analyzed mentions only.** The engine evaluates
  rules against the mentions the current analysis sweep applied outcomes to —
  never the historical backlog. Enabling a rule affects the future; it never
  rewrites the past. Cost per sweep is bounded by the sweep itself, and no
  "pending work" diff against execution records is needed. The
  (rule, revision, mention) unique key therefore serves as retry safety, not
  as a retroactive-application mechanism. A deliberate, visible backfill
  action was considered and deferred; it can sit on top of this design
  without schema change.
- **Integration shape: separate service, second pass per organization.**
  `executeRules()` is its own service shaped like `analyzeMentions`, called
  by the cron route after each organization's analysis completes — not inline
  in `analyzeOne`, not an independent cron. Engine failures get their own
  accounting, tests use a plain data-source fake, and the env flag is a
  one-line gate in the route. (An independent cron pass was rejected because
  it is retroactive by nature and needs a new unscoped pending-work query.)
- **Rule-driven escalation input.** The `escalate` action carries only a
  null `assigneeUserId`, so the executor derives the escalation: severity =
  the mention's stored `riskLevel`, category = `"other"` (a rule matches
  conditions; it does not classify), title derived from the rule name,
  summary null, `dueAt` null (no invented SLA — same reasoning as
  `toEscalationInput` in `src/lib/analysis/normalize.ts`).
- **Full conflict table now, two executors reachable.** The conflict module
  implements every pairing from the plan's design — including pairs
  unreachable until later executors unlock — so future executors land
  against already-pinned, already-tested semantics rather than new
  decisions made under implementation pressure.

## Data model

New migration pair `..._automation_execution.sql` +
`..._automation_execution_rls.sql`:

```sql
create table public.automation_rule_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  automation_rule_id uuid not null references public.automation_rules (id) on delete cascade,
  rule_revision integer not null,
  mention_id uuid not null references public.mentions (id) on delete cascade,
  status text not null check (status in ('applied', 'partial', 'blocked', 'failed')),
  -- per-action outcomes: [{ type, outcome: 'applied'|'skipped_duplicate'|'blocked'|'failed', code }]
  outcomes jsonb not null default '[]'::jsonb,
  error_code text,
  executed_at timestamptz not null default now(),
  constraint automation_rule_executions_idempotent
    unique (automation_rule_id, rule_revision, mention_id)
);
```

RLS: organization members may `select`; **no** insert/update/delete for
`authenticated` — only the service role writes. Same posture as
`audit_events`. The membership check is restated in SQL via
`public.is_organization_member(organization_id)`, per repository convention.

The unique key **(rule, revision, mention)** is the idempotency guarantee
(D147): a retry inserts `on conflict do nothing` and reads the existing
record; a re-run after an edit (new revision) is a deliberate new execution.

A second, tiny migration extends the audit event vocabulary with
`automation_rule.executed` and `automation_rule.execution_failed`.

### Seed

Unchanged posture (D143): no fabricated execution records; every seeded
rule's `lastRunAt` stays null until the engine truly runs.

## Repository contract

Added to both adapters (demo and Supabase):

- `ruleExecutions.record(scope, input) → { execution, created }` —
  idempotent insert (`on conflict do nothing`, then read); `created: false`
  signals a retry hit the unique key. Mirrors `escalations.create`'s shape.
- `ruleExecutions.listForRule(scope, ruleId, limit) → Execution[]` — newest
  first, for the detail page.
- `automationRules.markRun(scope, ruleId, at)` — writes `last_run_at`. The
  only writer of that column, ever.
- `automationRules.listActiveForExecution(scope) → AutomationRule[]` —
  active, unarchived, ordered `priority asc, createdAt asc, id asc` (`id`
  breaks equal timestamps; the deterministic tie-breaker).

## Engine (`src/lib/rules/execute.ts`)

`executeRules(context)` mirrors `analyzeMentions`: one `OrganizationScope`
built with `SYSTEM_ACTOR_ID` (D88), the service data source, and the mention
ids the analysis sweep just processed. Never callable from a page request.
No active rules → return immediately.

Per mention, two passes:

**Pass 1 — collect.** Load the mention, build the exact `RuleSubject` from
Phase 1's evaluator (`src/lib/rules/evaluate.ts` — that module, never a
second evaluator; its null rule stands). The subject's `status` is read
after analysis applied its outcome, so a mention analysis just escalated
already reads `escalated`. Evaluate every active rule in order; matching
rules contribute their actions to an intended-action set tagged with source
rule and revision.

**Pass 2 — resolve, then execute.** A pure module
`src/lib/rules/conflicts.ts` takes the intended set plus the subject and
returns, per action: proceed, or block/skip with a code. Full table:

| Conflict | Resolution | Outcome code |
| --- | --- | --- |
| Anything vs escalation | Escalation is sticky: once any rule (or D38 analysis) escalates, no later action may move status off `escalated` | `blocked` / `weaker_status` |
| `require_approval` vs `auto_publish` | Any approval in the set cancels every auto-publish | `blocked` / `approval_required` |
| High/critical subject vs terminal `set_status` or `auto_publish` | Dropped unconditionally — engine-enforced even if a stale rule slipped through activation | `blocked` / `high_risk_guardrail` |
| Duplicate `generate_draft` | At most one per (mention, response type); skip if a draft exists | `skipped_duplicate` |
| Duplicate `assign` | First rule by priority wins | `skipped_duplicate` |
| Duplicate `notify` | One per (mention, channel) per sweep | `skipped_duplicate` |
| `set_status` vs status lattice | May not overwrite a stronger status: `escalated > needs_approval > draft_ready > responded > monitoring/analyzed > dismissed/no_action_recommended` | `blocked` / `weaker_status` |
| `escalate` vs existing escalation | `escalations.create` dedupe; not a failure | `skipped_duplicate` |

Only the `set_status`/`escalate` rows are reachable today; the rest are
implemented and tested now so later executors unlock against pinned
semantics. The final row is the one resolution that happens at execution
time rather than in the pure module: the executor learns of the duplicate
from `escalations.create` returning `created: false` and records
`skipped_duplicate`.

**Executor registry.** `Record<RuleActionType, ActionExecutor | null>`
derived from `ACTION_CAPABILITIES` (D140) — an action becomes executable in
exactly one place. Executors in this phase:

- `set_status`: writes mention status through the existing repository
  update path.
- `escalate`: calls `escalations.create` (per-mention dedupe makes
  double-escalation structurally impossible), with the derived input from
  "Decisions resolved" above, then sets mention status to `escalated`.

**Recording.** One execution record per (rule, mention) with intended
actions; per-action outcomes `applied | skipped_duplicate | blocked |
failed`; record status `applied` when every action applied, `partial` when
some applied and some did not, `blocked` when nothing applied and nothing
threw, `failed` when any executor threw. A throwing executor marks that action `failed` and continues — one
bad action never aborts the mention or the sweep. `markRun` fires only for
records with status `applied` or `partial`.

**Audit.** Per organization sweep: one `automation_rule.executed` event with
counts only (rules run, mentions evaluated, actions applied/blocked/failed),
`actorType: "system"`. A sweep-level failure records
`automation_rule.execution_failed` with an error code. No mention content in
audit metadata.

## Sweep integration

- `analyzeMentions` returns, additionally, the ids of mentions it applied
  outcomes to this run.
- The cron route (`/api/cron/analyze-mentions`) calls `executeRules` per
  organization after that organization's analysis completes, inside its own
  try/catch: an execution failure costs that organization's rule pass and
  nothing else, mirroring the route's existing per-org isolation.
- The call is gated by `RULES_EXECUTION_ENABLED` (read through
  `src/lib/env.ts`), default **off**. Deploying changes nothing until the
  flag is deliberately set; the first live run can be watched.
- The route's sweep totals grow execution counts so the cron response stays
  an honest report.

## Outcome UI (`/rules/[ruleId]`)

- **Last run** becomes real: rendered from `lastRunAt`, written only by
  `markRun`. The rules list column already renders this field and needs no
  change.
- **Execution history**: a section listing recent executions
  (`listForRule`) — when, which mention (linked), record status, and
  per-action outcomes with codes spelled out in sentence case ("skipped:
  already escalated", "blocked: weaker status").
- **Two distinct empty states**, honest to the flag: "Rule execution is not
  yet enabled" when the flag is off, "No executions yet" when it is on but
  the rule has not run. The page never implies activity that is not
  happening.
- No changes to the builder, simulation, or activation flows.

## Testing

- **Conflict module**: exhaustive — every pairing in the table and every
  lattice transition, including today-unreachable pairs.
- **Idempotency**: run `executeRules` twice over the same mentions →
  identical records, single escalation, `created: false` on the second
  pass, no double status writes.
- **Revision semantics**: edit + re-simulate + re-enable (new revision) → a
  new execution record for the same mention is allowed (D147).
- **Executor failure**: a throwing executor yields a `failed` outcome; other
  actions still apply; the sweep completes.
- **Adapters**: `record` / `listForRule` / `markRun` /
  `listActiveForExecution` in both adapters; new-table RLS checks in the
  live-RLS script.
- **Route**: flag off → no execution calls; flag on → per-org calls with
  correct scopes; one organization's execution failure does not affect the
  next.
- **UI**: detail page renders history, outcome codes, and both empty states.

## Risks and operational notes

- The Supabase adapter's new writes will first run against live Postgres
  when the flag is enabled — same position every prior write path started
  in. Mitigation: identical guard logic in the demo adapter, `db:validate`,
  RLS script coverage, and the flag staying off until a watched first run.
- The audit vocabulary migration must be applied to the hosted project
  before the flag is enabled, or the two new event types will 23514-fail —
  same operational caveat as `response.edited`.
- Three seeded rules are active; the moment the flag turns on, they will
  act on newly analyzed mentions. They carry only `set_status`/`escalate`
  actions (D143), but enabling the flag is the real activation moment and
  should be treated as such.
