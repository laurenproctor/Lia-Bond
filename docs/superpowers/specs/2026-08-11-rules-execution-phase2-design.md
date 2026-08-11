# Rules execution engine (Phase 2) — revised implementation plan

Plan, v2. Written 2026-08-11; revised the same day after design review.
Supersedes v1 (git history holds it). Not implemented; no code changes yet.

Scope holds at `set_status` and `escalate`. Everything else in v1 that
promised semantics for draft generation, approval, notification, assignment,
or publishing is demoted in this revision to "future design considerations"
(Section 9).

Terminology discipline for this document: the design is described as
idempotent or atomic **only where a specific mechanism provides it and a
listed test demonstrates it**. Nothing here is called production-safe;
Section 2 defines what must be true and verified before `apply` mode is
enabled anywhere.

## 1. Verified current-state findings

Each finding below was checked against the repository on 2026-08-11, not
carried over from review feedback.

| # | Finding | Evidence |
| --- | --- | --- |
| F1 | Migration versions are unique. The two collisions (`monitoring_query_origin`, `response_edited_audit_event`) were renumbered in `b93ce2a` before reaching the hosted project. | `ls supabase/migrations` shows no duplicate version prefixes; `docs/architecture/current-state.md` "Still open" records the renumbering. |
| F2 | A clean `supabase db reset` has **never been verified**. `npm run db:verify-rls` needs Docker and has never been executed; `supabase/tests/rls-verification.sql` has never run. | current-state.md "Still open". |
| F3 | **Audit events are forgeable by any authenticated member.** `audit_events_insert` allows any org member to insert any `event_type` with `actor_user_id null` — i.e. events attributed to system/AI actors. | `20260801000200_row_level_security.sql:307-313`. |
| F4 | **Two location-scoping omissions confirmed.** The permission matrix grants `location_manager` both `escalation.update_status` and `response.assign` with the stated contract "location managers appear only where a scoping check can constrain them" — but `updateEscalationStatusAction` and `assignResponseDraftAction` use plain `authorize()`, giving a location manager organization-wide reach. `mention.update_status` does it correctly via `assertPermissionForLocation`. | `src/app/actions/escalations.ts:27`, `src/app/actions/responses.ts:23`, `src/lib/auth/permissions.ts:44-46`, `src/app/actions/mentions.ts:30`. |
| F5 | Database authorization enforces **organization** boundaries everywhere (`is_organization_member`) and a coarse **role** boundary on writes (`can_write_in_organization`: owner/admin/comms lead/location manager/approver). **Location** boundaries are enforced nowhere in the database; they exist only in `canForLocation` at the application layer. | `20260801000200_row_level_security.sql:59-75`; `src/lib/auth/permissions.ts:202`. |
| F6 | **No mutation is transactional with its audit record.** Every action performs the business write, then `recordAuditEvent` as a second, separate write; a failure between the two leaves a mutation with no trail (the activation action already carries a workaround for the reverse case, `92e6f13`). No Supabase JS transaction exists; atomicity requires an RPC (D17 recorded this constraint for brand voice). | `src/lib/audit/record.ts:31-47`; any action in `src/app/actions/`. |
| F7 | Config posture is fail-closed where it matters today: mock modes are refused in production, and a missing `CRON_SECRET` refuses every scheduled request rather than opening the route. Phase 2 settings must match this posture. | `src/lib/env.ts` header comment; `src/lib/cron/authorize.ts:28-30`. |
| F8 | **The cron response over-reports success.** `/api/cron/analyze-mentions` returns `status: "ok"` with HTTP 200 even when `erroredOrganizations > 0` or `mentionsFailed > 0`. | `src/app/api/cron/analyze-mentions/route.ts:139-150`. |
| F9 | A per-organization concurrency claim already exists as a pattern: `analysisRuns.start` throws a conflict when a run is in progress, and the cron route counts the refusal as `skipped`, not a failure. | `src/lib/analysis/analyze.ts:222-242`; route lines 113-136. |
| F10 | Neither `automation_rules` nor `mentions` carries a `unique (id, organization_id)` constraint, so composite same-organization foreign keys are not yet possible. | `20260801000100_initial_schema.sql` (mentions, automation_rules definitions). |
| F11 | `automation_rules.last_run_at` exists from the initial schema, is written by nothing, and every seeded value is null (D143). It can be replaced without data migration. | `20260801000100_initial_schema.sql:553`; seed tests pin null. |
| F12 | Mentions and rules are never deleted by the application (rules are archive-only with no DELETE policy, D142; deleted Google reviews are deliberately retained). Cascade behavior on the new table is therefore about posture, not observed traffic. | current-state.md workflow 03 gaps; D142. |

## 2. P0 prerequisites

`RULES_EXECUTION_MODE=apply` must not be enabled anywhere — including a
personal test project — until every item below is **done and verified**.
Build order for the engine itself may proceed in parallel where noted.

| P0 | Status | What remains |
| --- | --- | --- |
| P0-1 Unique migration versions | **Done** (F1) | Nothing. |
| P0-2 Clean `supabase db reset` | **Outstanding** (F2) | Run `npm run db:verify-rls` (needs Docker) on a machine that has it; fix whatever surfaces; record the run in current-state.md. Acceptance: reset + all migrations + seed + RLS harness pass from scratch. |
| P0-3 DB boundaries: organization, role, location | **Partial** (F5) | Organization: done. Role: coarse write gate exists; the new tables/RPC in this plan get exact role policies (Section 3). Location: a product decision plus policy work — see the visibility decision in Section 3 and open question Q2. |
| P0-4 Location-scoping omissions | **Outstanding** (F4) | Fix both actions with `assertPermissionForLocation`, resolving the record's location through its mention (`escalation → mention.locationId`, `responseDraft → mention.locationId`), the exact pattern `updateMentionStatusAction` uses. Cross-location refusal tests for both. Small, self-contained; lands in this phase's first commit block. |
| P0-5 Audit forgery | **Outstanding** (F3) | Tighten `audit_events_insert`: authenticated inserts must set `actor_user_id = auth.uid()` — no authenticated path may write a null-actor (system/ai/integration-attributed) event; those become service-role-only. Requires a call-site audit first: at least `analyzeMentions` (manual trigger writes `actorType: "ai"`, `actorUserId: null` through the user's client) and `escalation.created_from_analysis` violate the tightened policy today. Each such site either (a) attributes the event to the triggering user (`actorUserId = auth.uid()`, keeping `actor_type` as the description of agency), or (b) moves to the service client. Recommendation: (a) for manual triggers — a person pressed the button and the trail should say who — leaving null-actor events exclusively to cron/service paths. |
| P0-6 Transactional mutation + audit | **Split** (F6) | For everything Phase 2 writes: provided by the execution RPC (Section 4) — mutation, escalation, execution record, and audit commit or roll back together. For the ~20 existing actions: a retrofit workstream (per-action-family RPCs) that this plan does not attempt. See open question Q1 on whether that retrofit gates `apply` mode. |
| P0-7 Fail-closed configuration | **Verified for existing config** (F7); Phase 2 settings specified to match | `RULES_EXECUTION_MODE` parses as a Zod enum; absent → `off`; an unknown value fails startup shape-validation like every other mode enum. `apply` with an empty allowlist executes nothing. No default ever enables execution. |

## 3. Final schema and RLS design

### Parent-table prerequisites (one migration)

```sql
alter table public.automation_rules
  add constraint automation_rules_id_org unique (id, organization_id);
alter table public.mentions
  add constraint mentions_id_org unique (id, organization_id);
```

These exist to make same-organization composite foreign keys possible; they
are implied by the primary keys plus the org column and cost one index each.

### Sweeps

One row per cron execution pass per organization — the concurrency claim
(modelled on `analysisRuns.start`, F9) and the anchor for observability.

```sql
create table public.automation_sweeps (
  id uuid primary key default gen_random_uuid(),          -- the sweep_id
  organization_id uuid not null references public.organizations (id) on delete cascade,
  mode text not null check (mode in ('dry_run', 'apply')),
  status text not null check (status in ('running', 'completed', 'failed'))
    default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- counters: mentions_evaluated, rules_matched, actions_applied,
  -- actions_blocked, actions_skipped, actions_failed, retryable_failures,
  -- terminal_failures — integer not null default 0 each
  mentions_evaluated integer not null default 0,
  rules_matched integer not null default 0,
  actions_applied integer not null default 0,
  actions_blocked integer not null default 0,
  actions_skipped integer not null default 0,
  actions_failed integer not null default 0,
  retryable_failures integer not null default 0,
  terminal_failures integer not null default 0,
  error_code text
);

-- One live sweep per organization; a crashed worker's claim expires by age.
create unique index automation_sweeps_one_running
  on public.automation_sweeps (organization_id)
  where status = 'running';
```

**Lease semantics:** claiming = inserting the `running` row (unique partial
index makes double-claims impossible at the database, not the application).
A `running` sweep older than **30 minutes** (twice the cron interval margin;
the analysis sweep's own budget is far shorter) is considered abandoned: the
claimer marks it `failed` with `error_code = 'lease_expired'` in the same
statement batch that inserts its own claim. Recovery after a worker crash is
therefore automatic on the next cron tick, and an in-flight sweep whose
executions already committed loses nothing — each execution row is
independently final (Section 4).

### Executions

```sql
create table public.automation_rule_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sweep_id uuid not null references public.automation_sweeps (id) on delete restrict,
  automation_rule_id uuid not null,
  rule_revision integer not null check (rule_revision > 0),
  mention_id uuid not null,
  mode text not null check (mode in ('dry_run', 'apply')),
  status text not null check (status in
    ('applied', 'partial', 'blocked', 'failed', 'no_op')),
  -- [{ index, type, outcome: 'applied'|'no_op'|'blocked'|'failed', code }]
  -- `index` is the action's position in the executed revision's actions
  -- array — the stable action identity for that revision.
  outcomes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(outcomes) = 'array'),
  outcome_schema_version integer not null default 1,
  attempt_count integer not null default 1 check (attempt_count >= 1),
  last_error_code text,
  error_class text check (error_class in ('retryable', 'terminal')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Same-organization integrity, database-enforced (F10 fixed above):
  constraint execs_rule_same_org foreign key (automation_rule_id, organization_id)
    references public.automation_rules (id, organization_id) on delete restrict,
  constraint execs_mention_same_org foreign key (mention_id, organization_id)
    references public.mentions (id, organization_id) on delete restrict,
  constraint execs_idempotent
    unique (automation_rule_id, rule_revision, mention_id, mode)
);

create index execs_by_org_rule_recent
  on public.automation_rule_executions
  (organization_id, automation_rule_id, started_at desc);
create index execs_by_mention
  on public.automation_rule_executions (organization_id, mention_id);
```

Deletion posture: `on delete restrict` for rules and mentions — neither is
deleted by the application today (F12), and the constraint converts "never
happens" into "cannot happen without a deliberate migration." Organization
deletion cascades: removing a tenant removes the tenant's history, which is
tenant teardown, not history loss. `sweep_id` is `restrict` so a sweep row
cannot vanish out from under its executions.

`mode` is part of the idempotency key so a dry run never blocks the later
real execution of the same (rule, revision, mention), and vice versa.

### Outcome vocabulary (mutually exclusive, exact)

Per action: `applied` (the effect happened), `no_op` (the desired effect
already existed — escalation already open, status already the target),
`blocked` (the transition matrix or a policy refused it), `failed` (it was
attempted and errored). v1's `skipped_duplicate` is replaced by `no_op`.

Per execution row: `applied` — every action applied (or `no_op`; a row of
pure no-ops is `no_op`); `partial` — at least one applied and at least one
blocked or failed; `blocked` — nothing applied, at least one blocked, none
failed; `failed` — nothing applied and at least one failed; `no_op` — every
action was a no-op.

**`no_match` writes no execution row.** A rule that evaluated and did not
match contributes to sweep counters (`mentions_evaluated`; and the rule's
`last_evaluated_at`, Section 6) only. Rationale: rows for non-matches would
multiply as (rules × mentions) and record nothing an operator can act on;
the sweep row preserves the evidence that evaluation happened.

### Retry classification

`error_class = 'retryable'`: serialization/deadlock failures, lock
timeouts, transient connection errors. A later sweep may re-attempt: the
RPC, on finding an existing row with `status='failed'` and
`error_class='retryable'` and `attempt_count < 3`, re-executes and updates
the same row (`attempt_count + 1`). `'terminal'`: refused transition, rule
archived/revision changed mid-flight, malformed action payload — never
re-attempted; the row is final. A failed **insert** cannot wedge recovery:
the claim is `insert … on conflict` + row lock, never insert-only.

### RLS and grants

- `automation_rule_executions`, `automation_sweeps`: `select` restricted to
  members holding an automation role — `has_organization_role(org_id,
  array['owner','admin','communications_lead'])` — matching
  `automation_rule.manage`'s roles. **Recommendation (decision recorded,
  see Q2): execution history is an organization-level administrative
  resource.** Location managers cannot author, toggle, or read rules'
  execution history; there is consequently no `location_id` column and no
  location-scoped select policy. The alternative (constrained
  `location_id` + location-scoped selects) is specified in Q2 if product
  decides location managers should see what automation did to their own
  restaurants' mentions.
- No `insert`/`update`/`delete` policies for `authenticated` on either
  table, **and** those privileges revoked outright (the
  `revoke … from authenticated` convention), so a future policy cannot
  re-open them by accident. This is deliberately *not* v1's "same posture
  as audit_events" claim — audit_events' actual posture is
  member-insertable and is itself a P0 defect (F3).
- The execution RPC (Section 4): `security definer`, `set search_path =
  public, pg_temp`, `revoke execute from public, anon, authenticated` —
  callable by the service role only. Cron is the only caller (D88 posture).

### Audit vocabulary

New event types via the established vocabulary-migration pattern:
`automation_rule.executed`, `automation_rule.execution_failed`,
`automation_sweep.completed`. Counts only in metadata; no mention content.

## 4. Execution algorithm (transactional, claim-based)

All of Phase 2's business effects are database-only, so one plpgsql RPC —
`execute_automation_rule(...)` — performs the entire execution of one
(rule, revision, mention, actions) unit inside a single transaction:

1. **Claim.** `insert into automation_rule_executions … on conflict
   (automation_rule_id, rule_revision, mention_id, mode) do nothing`, then
   `select … for update` on the row. If the row pre-exists with a final
   status other than retryable-failed (Section 3), return it unchanged —
   the completed-execution replay path, no effects. If it pre-exists as
   retryable-failed under the attempt cap, proceed as a retry.
2. **Validate.** Under the same transaction: the rule row (`for share`) is
   `active`, unarchived, and its `revision` equals the requested revision —
   otherwise terminal failure `rule_changed`; the mention row (`for
   update`) exists in the same organization (the composite FKs make the
   cross-org case unrepresentable, this check makes it legible).
3. **Apply actions in order, each in a savepoint** (plpgsql nested
   `begin … exception` block):
   - `set_status`: permitted only by the transition matrix (Section 5),
     evaluated against the mention's **current, locked** status — not the
     status the sweep read earlier. Refusals → `blocked` with the matrix's
     code. Target equals current → `no_op`.
   - `escalate`: `insert … where not exists (open escalation for this
     mention)` — the same dedupe contract `escalations.create` implements,
     here enforced inside the transaction; duplicate → `no_op`. On insert:
     severity = mention's stored risk level, category `other`, title from
     the rule name, no due date; then status → `escalated` via the matrix
     (which always permits it for eligible statuses).
   - An action's savepoint rolling back records that action `failed` and
     continues with the next — which is precisely what makes `partial`
     reachable and keeps one bad action from voiding the others.
4. **Record.** Update the claimed row: status, outcomes array, attempt
   count, error fields, `completed_at`.
5. **Audit.** Insert the `automation_rule.executed` (or
   `execution_failed`) event.
6. **Commit.** Everything above commits together or not at all.

**The crash window the v1 design had is closed by construction:** there is
no state where the mutation committed but the execution record did not,
because they are one transaction. A crash anywhere before commit rolls back
both; the retry re-runs from a clean claim. A crash after commit finds the
final row at step 1 and replays nothing. The tests in Section 10 demonstrate
both halves rather than asserting them.

**Whole-unit failure** (validation failure, or the RPC's outer block
catching an error outside any action savepoint): the outer exception
handler still commits the claimed row as `failed` with its class and code —
failure visibility survives the rollback of effects, via the nested-block
savepoint structure. If the connection itself dies mid-transaction, no row
remains, no effect remains, and the next sweep retries from nothing — safe
because zero effects escaped.

**Demo adapter parity.** The demo adapter implements the identical
algorithm in TypeScript (single-threaded, so its atomicity is trivial), so
every service-level test runs against the same claim/validate/apply/record
semantics without Docker.

**Engine loop (TypeScript, `src/lib/rules/execute.ts`).** Per organization:
claim sweep → load active rules once (config + revision snapshot; ordered
`priority asc, created_at asc, id asc`) → for each just-analyzed mention id
(the population decision from v1 stands: never the backlog): build
`RuleSubject` via the Phase 1 evaluator module, evaluate rules in order,
and for each matching rule call the RPC (apply mode) or record the decision
(dry-run mode). Multiple matching rules execute in the deterministic order
above; every action a later rule loses to the matrix or to an earlier
rule's effect is recorded on that rule's own execution row with its code —
nothing is silently suppressed.

## 5. Status transition matrix

The lattice is gone; v1's "stronger/weaker" ordering treated `dismissed`,
`responded`, and `escalated` as ranked when they are different outcomes.
In its place, an explicit matrix of what **Phase 2 automation** may do.
Humans are governed by their own paths and are untouched by this table;
resolving an escalation stays a human action in the escalations centre.

Automation-permitted transitions (everything not listed is refused,
`blocked` / code `forbidden_transition`):

| From \ To | analyzed | monitoring | no_action_recommended | dismissed | escalated |
| --- | --- | --- | --- | --- | --- |
| analyzed | no_op | ✓ | ✓ ¹ | ✓ ¹ | ✓ (escalate action) |
| monitoring | ✗ | no_op | ✓ ¹ | ✓ ¹ | ✓ (escalate action) |
| no_action_recommended | ✗ | ✗ | no_op | ✗ | ✓ (escalate action) |
| dismissed | ✗ | ✗ | ✗ | no_op | ✗ ² |

¹ **High-risk guard:** refused (`blocked` / `high_risk_guardrail`) when the
mention's stored risk level is high or critical — automation may never move
high-risk content into a non-escalated resting state, enforced in the RPC
even if a stale rule slipped activation.
² Escalating a dismissed mention is refused: a human explicitly closed it;
automation reopening it would need a product decision nobody has made.

Rows and columns absent entirely — and why:

- `new` never appears as a source: the engine's population is post-analysis
  mentions only.
- `escalated`, `responded`, `needs_approval`, `draft_ready` as **sources**:
  automation may not move a mention out of any of them. Escalation is
  sticky; the response pipeline (drafting, approval, publishing) owns its
  own states.
- `responded`, `needs_approval`, `draft_ready`, `new` as **targets**:
  publishing owns `responded`; the draft/approval flow owns the middle
  states; nothing returns a mention to `new`.

The matrix is defined once as data in `src/lib/rules/transitions.ts`
(consumed by dry-run decisions and the demo adapter) and restated in the
RPC's SQL. Two statements of one truth is a real drift risk: a
database-harness test (Section 10) asserts the SQL function agrees with the
TypeScript module on every (from, to, risk) combination.

## 6. Rule activity timestamps

`automation_rules.last_run_at` (never written, all null — F11) is dropped
and replaced:

```sql
alter table public.automation_rules
  drop column last_run_at,
  add column last_evaluated_at timestamptz,
  add column last_matched_at timestamptz,
  add column last_applied_at timestamptz;
```

- `last_evaluated_at`: the engine considered the rule against at least one
  mention — **updated in apply mode regardless of outcome**, including
  all-blocked and all-failed sweeps.
- `last_matched_at`: at least one subject matched the rule's conditions.
- `last_applied_at`: at least one action reached `applied`.

All three are written once per rule per sweep, monotonically:
`set last_x = greatest(coalesce(last_x, 'epoch'), $sweep_started_at)` — an
older sweep completing after a newer one (possible across the lease
boundary) can never move a timestamp backwards. Updates ride inside the
sweep-finalization transaction, not per execution.

Revision changes do not reset any of them: they are rule-lifetime facts
("when did this rule last do anything"), and per-revision truth lives in
the execution rows, which carry `rule_revision`. Dry-run sweeps update
**none** of them — dry run makes zero writes outside its own execution and
sweep rows, so the "dry run mutates nothing" test stays absolute; a
dry-run's evaluation evidence is its recorded decisions.

UI: the list and detail pages replace "Last run" with "Last applied"
(`last_applied_at`), the honest number, with evaluated/matched shown on the
detail page alongside the execution history.

## 7. Rollout, concurrency, and budget controls

Configuration (all parsed in `src/lib/env.ts`, Zod-validated at startup,
F7 posture):

- `RULES_EXECUTION_MODE = off | dry_run | apply`. Absent → `off`. Unknown
  value → startup validation failure, not a fallback.
- `RULES_EXECUTION_ORG_ALLOWLIST`: comma-separated organization ids.
  Consulted in both `dry_run` and `apply`; an organization not listed is
  skipped entirely. Empty or absent allowlist + any active mode = the
  sweep does nothing and says so in its response. (Env-var storage is the
  Phase 2 answer; a DB-backed rollout table is future work, noted in Q3.)
- `RULES_MAX_MENTIONS_PER_SWEEP` (default 200), `RULES_MAX_ACTIONS_PER_SWEEP`
  (default 500), max rules evaluated per mention (default 50, a structural
  backstop rather than a knob — active rule counts are tiny today).
- `RULES_EXECUTION_BUDGET_MS` (default 60 000): checked between mentions;
  on exhaustion the sweep stops cleanly, finalizes counters, reports
  `budget_exhausted` in its sweep row and the cron response. Never
  mid-mention: the RPC unit is atomic, so stopping between units is always
  a consistent stop.

Every truncation is reported, never silent: mentions skipped by cap or
budget appear as a count in the sweep row and cron response.

**Concurrency.** The sweep claim (Section 3's partial unique index) is the
per-organization lock; two overlapping cron ticks race on the insert and
the loser skips the organization, exactly the F9 pattern. Within a sweep,
the RPC's claim row + `for update` locks make two workers on the same
(rule, revision, mention) impossible to double-apply — one claims, one
replays the final row.

**Snapshot semantics.** A sweep executes the rule revisions it loaded at
claim time. A rule edited, disabled, or archived mid-sweep is caught by the
RPC's validate step (rule status and revision re-checked inside each
execution's transaction) and recorded as terminal `rule_changed` — the
sweep never executes a moving target, and never half-applies an old
revision after the new one exists.

**Dry run** evaluates conditions, runs the full decision pipeline including
the transition matrix against current mention state, and records execution
rows (`mode='dry_run'`) with the outcomes that *would* have occurred — and
performs no business mutation: no status writes, no escalations, no rule
timestamps, no audit events beyond the sweep-completed event. Its rows are
the rollout evidence to read before flipping an organization to `apply`.

## 8. Observability and the cron response contract

The route (`/api/cron/analyze-mentions`, unchanged URL — execution stays
inside the existing sweep per D88/prereq 6) returns:

```jsonc
{
  "status": "ok" | "degraded" | "failed",
  "analysis": { /* existing totals, unchanged shape */ },
  "execution": {
    "mode": "off" | "dry_run" | "apply",
    "sweeps": [{ "sweepId": "…", "organizationId": "…", "status": "…",
                 "mentionsEvaluated": 0, "rulesMatched": 0,
                 "actionsApplied": 0, "actionsBlocked": 0,
                 "actionsSkipped": 0, "actionsFailed": 0,
                 "retryableFailures": 0, "terminalFailures": 0 }],
    "organizationsAttempted": 0, "organizationsCompleted": 0
  }
}
```

- **HTTP 401** — cron secret missing/wrong (existing behavior, unchanged).
- **HTTP 500, `status: "failed"`** — the route itself could not run its
  loop (organization enumeration failed, config invalid). No partial work
  happened or its records stand on their own.
- **HTTP 200, `status: "degraded"`** — the sweep ran and *any* material
  work failed: `erroredOrganizations > 0`, `mentionsFailed > 0`, any
  execution sweep `failed`, or `actionsFailed > 0`. This fixes F8 for the
  analysis totals too — the current code answers `ok` to a sweep where
  every mention failed.
- **HTTP 200, `status: "ok"`** — everything attempted completed; blocked
  and no-op outcomes are normal operation, not degradation.

`sweep_id` appears in: the response, every execution row, every
execution-related audit event's metadata, and every engine log line.
Persistence for diagnosis is the sweep row itself — counters, error code,
timing — queryable without log access, which is what an alert can be hung
on later.

## 9. Future executors — considerations, not commitments

Phase 2 finalizes semantics for `set_status` and `escalate` only. For the
rest, the following are recorded as design **considerations** the future
phases must answer, deliberately unresolved here:

- `generate_draft`: provider-level idempotency (an AI call is not
  transactional with anything), draft-per-mention dedupe, cost bounding.
- `require_approval` / `notify` / `auto_publish`: external side effects
  need an outbox pattern — a transactionally-recorded intent executed by a
  delivery worker — because a Postgres transaction cannot span an email or
  a Google API call. Nothing in this phase's schema presumes the outbox's
  shape; the executions table records database effects only.
- `assign` / `tag`: blocked on product decisions (assignee of what? tag on
  what entity?), unchanged from Phase 1's deferral.

The conflict rules v1 pre-committed for these actions (approval blocks
auto-publish, notification dedupe, and so on) are demoted to notes inside
`transitions.ts` comments; only the matrix rows for the two real executors
are normative.

## 10. Migration order, implementation order, tests

### Migrations (in order)

1. `…_automation_execution_prereqs.sql` — parent `(id, organization_id)`
   uniques (F10).
2. `…_automation_execution.sql` — sweeps + executions tables, indexes,
   timestamp column swap on `automation_rules`.
3. `…_automation_execution_rls.sql` — policies, revokes, role-restricted
   selects.
4. `…_automation_execution_rpc.sql` — `execute_automation_rule`, matrix in
   SQL, security posture (definer, search_path, revokes).
5. `…_automation_execution_audit_vocabulary.sql` — three event types.
6. P0-5's separate pair: audit call-site changes + tightened
   `audit_events_insert` policy (sequenced after the call-site audit; may
   land before or after 1–5, they are independent).

Operational note (unchanged from v1): all of these must reach the hosted
project before any mode above `off` is set there, and P0-2's reset
verification gates the set.

### Implementation order

1. **P0 block**: location-scoping fixes (P0-4) with tests; audit call-site
   audit + P0-5 migration; P0-2 reset run on a Docker machine.
2. Domain + `transitions.ts` (matrix as data) + outcome vocabulary types.
3. Migrations 1–3; repository contract (`sweeps.claim/finalize`,
   `executions.record/listForRule`, `automationRules.markActivity`,
   `listActiveForExecution`) in the demo adapter with the full algorithm.
4. RPC migration (4) + Supabase adapter calling it; audit vocabulary (5).
5. Engine loop + env config + route integration + response contract.
6. Outcome UI on `/rules/[ruleId]` (execution history, three timestamps,
   mode-aware empty states: "Rule execution is off", "Dry run only —
   nothing is applied yet", "No executions yet").
7. Docs: current-state decisions ledger entries; this plan marked
   implemented.

### Tests (each maps to a required scenario from review)

Vitest, demo adapter (algorithm semantics):

1. Crash after mutation before recording — *by construction* this state
   cannot exist in the RPC design; the demo adapter test proves the
   TypeScript twin: inject a throw between apply and record → assert the
   mutation did not persist (transaction semantics of the adapter's unit),
   then retry → exactly one effect, one record.
2. Two concurrent sweeps, same (rule, revision, mention): first claims and
   applies; second replays the final row; effects applied exactly once.
3. Escalation insert succeeds, status write fails (injected) → escalation
   and status roll back together in the unit; recorded `failed`; retry
   produces exactly one escalation.
4. Audit insert failure (injected) → the whole unit rolls back; no
   unaudited mutation survives.
5. Repeated execution after success → `no_op` replay, zero new effects,
   zero new rows.
6. Retryable failure → same row, `attempt_count` 2, then success; terminal
   failure → never re-attempted; attempt cap respected.
7. Every matrix cell: all permitted transitions apply; all refused
   combinations return `blocked`/`forbidden_transition`; high-risk guard
   on both ¹-marked columns; escalate-from-dismissed refused.
8. Older sweep finishing after newer → `greatest()` keeps the newer
   timestamps.
9. Rule edited / disabled / archived between sweep load and execution →
   terminal `rule_changed`, no effects.
10. Malformed and unknown action payloads → terminal failure with code,
    sweep continues.
11. Dry run: full decision records, and a byte-for-byte assertion that no
    mention, escalation, rule-timestamp, or audit write occurred.
12. Caps and budget: mentions-per-sweep cap, actions cap, budget
    exhaustion — all stop cleanly and report truncation counts.
13. Route contract: `off` → no sweeps; allowlist filtering; `ok` /
    `degraded` / `failed` responses each produced under the conditions in
    Section 8; 401 unchanged.
14. Location-scoping fixes (P0-4): location manager refused on another
    location's escalation status and response assignment; permitted on
    their own.

Database harness (`supabase/tests/`, needs Docker — extends the existing
RLS script):

1. Clean `supabase db reset` + all migrations + seed (P0-2 acceptance).
2. Cross-organization integrity: inserting an execution whose rule and
   mention belong to different organizations fails on the composite FKs —
   attempted as service role, so the constraint itself is what refuses.
3. RLS: member without automation role cannot select executions/sweeps;
   automation-role member of org A cannot read org B's rows; authenticated
   cannot insert/update/delete either table; authenticated cannot execute
   the RPC; tightened audit policy refuses null-actor authenticated
   inserts (P0-5 acceptance).
4. SQL/TypeScript matrix parity: every (from, to, risk) combination agrees
   between `transitions.ts` and the RPC.
5. Concurrency at the database: two sessions claim the same sweep →
   partial unique index rejects one; two sessions execute the same unit →
   one applies, one replays.

### Acceptance criteria

- All tests above pass; `npm run verify` green.
- P0-2 recorded as run; P0-4 and P0-5 landed with their tests.
- With `RULES_EXECUTION_MODE` unset, the deployed behavior is
  byte-identical to today's (route response gains the `execution` block
  with `mode: "off"` and nothing else).
- A dry-run sweep on the hosted project over the seeded organizations
  produces decision records and zero mutations (verified by row counts
  before/after).
- No document or UI string describes execution as enabled, safe, or
  automatic while mode is `off` or `dry_run`.

## Open questions requiring product input

- **Q1 — Does the existing-actions transactionality retrofit (P0-6) gate
  `apply` mode?** My recommendation: no. The rules-execution path is fully
  transactional in this design and never traverses the existing action
  code; retrofitting ~20 human-triggered actions is real work with its own
  risk, and holding automation hostage to it protects nothing automation
  touches. It should be its own scheduled workstream regardless.
- **Q2 — Execution-history visibility.** Recommended and specified above:
  org-level administrative resource (owner/admin/communications lead),
  matching who can manage rules; no `location_id` on the table. The
  alternative — location managers see executions touching their own
  restaurants — requires a constrained `location_id` column (composite FK
  to `locations(id, organization_id)`, denormalized from the mention at
  execution time) and a location-scoped select policy, and can be added by
  migration later without rewriting history.
- **Q3 — Allowlist storage.** Env var now (operator-controlled, no UI);
  a `organizations.automation_enabled` column with an admin surface is the
  eventual home. Acceptable to defer?
- **Q4 — Escalating dismissed mentions.** The matrix refuses it. If
  product wants "a rule may reopen a dismissed mention when new risk
  appears," that is a deliberate row flip plus an audit story, not a
  default.
