# Rules execution engine (Phase 2) — final implementation plan

Plan, v3 (final for approval). Written 2026-08-11; revised twice the same
day after design review. Supersedes v2 (git history holds v1 and v2). Not
implemented; no code changes yet.

Scope holds at `set_status` and `escalate`. Draft generation, approval,
notification, assignment, tagging, and publishing remain future design
considerations (Section 9 of v2 stands and is restated briefly in §12).

Property claims in this document follow one rule: **atomic, idempotent, and
safe are used only about a specific mechanism, and only where a listed test
demonstrates the property under crashes, retries, overlapping sweeps,
authorization-bypass attempts, or database failures.** Phase 2 as a whole is
not called production-safe; §3's gates define what must be true, and
verified, at each release stage.

## 1. Resolved decisions

**Q1 — what gates `apply`.** Resolved per review: engine development and
`dry_run` proceed now; the full transactionality retrofit does not block
them. Staged gates in §3. The ~20 unrelated actions are explicitly *not* a
prerequisite for engine development; the shared mention/escalation mutation
paths *are* a prerequisite for customer-facing `apply`.

**Q2 — execution-history visibility.** Resolved per review: location
managers get read-only access to execution history for their assigned
locations; rule configuration stays with organization administrators.
`location_id` is on the execution row from day one, database-constrained to
equal the mention's location (§5). Organization-wide or unlocated
executions are visible only to administrator roles.

Carried decisions that stand from v1/v2 (per review's "preserve" list):
transactional database-only execution RPC; service-role-only RPC access;
explicit transition matrix; rule-revision validation inside the
transaction; deterministic ordering (`priority asc, created_at asc, id
asc`); per-organization sweep claims; `off | dry_run | apply`;
environment-variable organization allowlist (acceptable for Phase 2);
runtime and volume budgets; monotonic rule-activity timestamps; database
concurrency tests; restrictive deletion and history retention; external
side effects excluded from Phase 2; automation never reopens dismissed
mentions.

## 2. Verified repository findings

v2's findings F1–F12 were re-verified and stand. New findings for v3, each
checked against the repository on 2026-08-11:

| # | Finding | Evidence |
| --- | --- | --- |
| F13 | `mention_analyses.id` is a durable per-occurrence identifier: the table is append-only ("re-analysis inserts, never updates"), rows are removed only by mention/organization cascade, and `createAnalysis` returns the row, so the sweep holds the id that authorized reconsideration. `analysis_run_id` is **not** suitable: it is nullable and `on delete set null`. | `20260801000100_initial_schema.sql:386-411`; `20260804000100_mention_analysis.sql:108`; `src/lib/data/types.ts:559`. |
| F14 | `mentions.location_id` is a **simple** FK (`references locations (id) on delete set null`): nothing in the database prevents a mention pointing at another organization's location. Application code prevents it today; §5 closes it structurally, since the execution table's location proof builds on it. | `20260801000100_initial_schema.sql:323`. |
| F15 | `locations.manager_user_id` exists (`on delete set null`), so a location-manager RLS predicate can be expressed in SQL. No `(id, organization_id)` unique exists on `locations`; composite FKs need one added. | `20260801000100_initial_schema.sql:183-201`. |
| F16 | A service-role client exists server-side (`getServiceRoleClient`, fails hard when unconfigured), and audit writing is already centralized in one function (`recordAuditEvent`) backed by one repository method — so removing authenticated audit inserts is a one-point change in the Supabase adapter, not a per-action retrofit. | `src/lib/supabase/server.ts:70-78`; `src/lib/audit/record.ts:31`. |
| F17 | Response actions do not write mentions today (they touch drafts and revalidate paths); the mutation paths that overlap the engine's rows are: the analysis service (`applyAnalysisOutcome` + `escalations.create` + audit), `updateMentionStatusAction`, `updateEscalationStatusAction`, and `assignEscalationAction`. This is the Gate-2 inventory, to be re-verified when Gate 2 starts. | `src/app/actions/responses.ts`; `src/lib/analysis/analyze.ts:133-175`; `src/app/actions/mentions.ts`, `escalations.ts`. |

## 3. Release gates

| Gate | Stage | Requirements (all verified, not merely merged) |
| --- | --- | --- |
| G0 | **Development + `dry_run`** | Phase 2 migrations, evaluation, and dry-run recording. Dry run performs no business mutations (§8), so its risk surface is operational rows only. P0-2 (clean `supabase db reset` + harness on Docker) must pass before the migrations reach the hosted project. |
| G1 | **Internal `apply`** — founder/test organization only, via allowlist | The transactional execution RPC with its database-harness tests (§7, §11); audit hardening — no authenticated audit inserts (§6); the two location-scoping action fixes (P0-4); all database-level tests in §11 green. |
| G2 | **Customer `apply`** | Every overlapping human and automated mutation path from F17 is atomic (business write + audit in one transaction — per-path RPCs following the execution RPC's pattern), and location authorization for mention/escalation mutations is a database guarantee, not only an application check: the database rejects an unauthorized location mutation even when application checks are bypassed (location-aware write policies or authorization inside the per-path RPCs). |
| G3 | **Broader release** | The remaining critical-action transactionality retrofit (member management, integrations, onboarding, brand voice, monitoring) — scheduled as its own workstream; not part of this plan's implementation order. |

Mode changes are operator actions against these gates; nothing in code
auto-advances a gate.

## 4. Configuration and rollout controls

Unchanged from v2 §7 except as noted: `RULES_EXECUTION_MODE = off | dry_run
| apply` (absent → `off`; unknown → startup validation failure);
`RULES_EXECUTION_ORG_ALLOWLIST` (consulted in both active modes; empty
allowlist + active mode = no work, said plainly in the response);
`RULES_MAX_MENTIONS_PER_SWEEP` 200, `RULES_MAX_ACTIONS_PER_SWEEP` 500, max
rules per mention 50, `RULES_EXECUTION_BUDGET_MS` 60 000 checked between
units; every truncation counted and reported. Snapshot semantics stand: a
sweep executes the revisions it loaded; the RPC re-validates per unit.

## 5. Final schema, composite constraints, RLS, and grants

### Parent-table integrity (one migration)

```sql
alter table public.automation_rules
  add constraint automation_rules_id_org unique (id, organization_id);
alter table public.locations
  add constraint locations_id_org unique (id, organization_id);
alter table public.mentions
  add constraint mentions_id_org unique (id, organization_id),
  -- Proof target for "execution location = mention location" (F14 fix):
  add constraint mentions_id_org_location unique (id, organization_id, location_id),
  -- A mention's own location must belong to its own organization:
  add constraint mentions_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id);
alter table public.mention_analyses
  add constraint mention_analyses_id_mention_org
    unique (id, mention_id, organization_id);
```

(`mentions_location_same_org` needs a backfill check first; the migration
asserts no violating rows exist — if any did, that is a live cross-tenant
defect to fix, not data to grandfather.)

### Sweeps

As v2 §3, plus the review's integrity additions:

```sql
  constraint automation_sweeps_id_org unique (id, organization_id)
```

Partial unique index `(organization_id) where status = 'running'` stands as
the claim; 30-minute lease expiry stands.

### Executions

```sql
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

create index execs_by_org_rule_recent
  on public.automation_rule_executions
  (organization_id, automation_rule_id, started_at desc);
create index execs_by_mention
  on public.automation_rule_executions (organization_id, mention_id);
create index execs_by_location
  on public.automation_rule_executions (organization_id, location_id)
  where location_id is not null;
```

Notes on the constraint set:

- `execs_location_is_mentions` is deliberately **not** a plain FK to
  `locations` — the review is correct that such an FK proves only "a real
  location in some organization." Targeting the mention's own
  `(id, organization_id, location_id)` unique proves equality with the
  mention's location. When `location_id` is null (unlocated mention),
  MATCH SIMPLE skips this constraint — and tenant/mention integrity is
  still held by `execs_mention_same_org`. `on update cascade`: if a
  mention's location assignment changes (remap, or location deletion
  nulling it), history follows the mention — visibility tracks the current
  assignment, and the audit trail of *what happened* is unaffected.
- **The idempotency key** is `(automation_rule_id, rule_revision,
  mention_id, trigger_analysis_id, mode)`. The trigger occurrence is the
  analysis row the sweep just wrote for this mention — the thing that
  authorized reconsideration. A reanalyzed mention gets a new
  `mention_analyses` row, hence a new key, hence the same rule revision may
  legitimately execute again; the same occurrence can never apply twice.
  Dry runs carry the same occurrence, so a later analysis produces a fresh
  projection and an old dry-run row never blocks anything (`mode` in the
  key separates projection from application of the same occurrence).
- Deletion posture: `restrict` throughout (rules, mentions, analyses,
  sweeps); organization cascade only (tenant teardown). Unchanged from v2.

### RLS and grants

```sql
-- Administrators read everything in their organization:
create policy execs_select_admin on public.automation_rule_executions
  for select to authenticated
  using (public.has_organization_role(organization_id,
    array['owner','admin','communications_lead']::membership_role[]));

-- Location managers read rows for locations they manage — and only those.
-- Unlocated rows (location_id null) never match this policy.
create policy execs_select_location_manager on public.automation_rule_executions
  for select to authenticated
  using (
    location_id is not null
    and exists (
      select 1 from public.locations l
      where l.id = location_id
        and l.organization_id = automation_rule_executions.organization_id
        and l.manager_user_id = auth.uid()
    )
  );

-- No insert/update/delete policies for authenticated, and revoked outright:
revoke insert, update, delete
  on public.automation_rule_executions from authenticated;
```

`automation_sweeps`: admin-role select only (a sweep row is organization-
wide telemetry, not location-scoped); writes service-role only, same
revoke pattern. The execution RPC: `security definer`, `set search_path =
public, pg_temp`, `revoke execute … from public, anon, authenticated` —
service role is the only caller.

## 6. Audit hardening (replaces v2's P0-5 design)

The review's correction is accepted: `actor_user_id = auth.uid()` prevents
impersonation, not fabrication — a member could still invent
self-attributed events. The v3 posture: **no authenticated inserts at
all.**

```sql
drop policy audit_events_insert on public.audit_events;
revoke insert on public.audit_events from authenticated;
```

Audit events are then written only by trusted server-side paths:

- The execution RPC writes its own events inside its transaction (§7).
- Every existing action keeps calling `recordAuditEvent` unchanged; the
  Supabase adapter's `auditEvents.record` switches internally to the
  service-role client (F16: one method, one change point — this is *not*
  the ~20-action retrofit). The adapter is `server-only` code and the
  scope it stamps has already passed `getOrganizationContext()`; what the
  RLS change removes is the ability of any *client-credentialed* path —
  PostgREST with a user JWT — to insert trail rows at all.
- The demo adapter is unaffected (in-memory).

Sequencing: this lands in the G1 block. Until the adapter change and the
migration land **together**, nothing else in this plan depends on them.
Test: §11-DB-1.

## 7. The execution unit: transaction structure, rollback, retry, concurrency

### Semantics (review corrections 5 and 8 adopted)

- **Policy refusals are outcomes, not errors.** A `blocked` (matrix
  refusal, guardrail) or `no_op` (already true) coexists with other
  actions' successes; a unit with ≥1 applied and ≥1 blocked/failed commits
  as `partial`.
- **Any technical failure rolls back the whole unit's business effects.**
  No per-action savepoint survival, no partially-committed technical
  failure, no action-level retry machinery in Phase 2. After rollback, a
  `failed` attempt with `error_class = 'retryable'` (or `'terminal'`, per
  classification) is recorded and survives. A retry starts from the last
  committed business state.
- **Validation precedes all mutation.** Malformed/unknown action payloads
  and stale rule revisions fail validation before any business write is
  attempted (`would_fail_validation` in dry run; terminal `failed` with
  code in apply).
- **`set_status` may never target `escalated`** (`blocked`, code
  `escalation_reserved`). Only the `escalate` executor produces the
  escalated state, and it performs — inside the one transaction, in
  order — (1) eligibility validation against the matrix and current locked
  state, (2) escalation creation or confirmation (dedupe → `no_op`),
  (3) the mention status change, (4) execution and audit records. The
  transition matrix (v2 §5) is amended accordingly: the `escalated`
  column belongs to the escalate executor alone; `escalated` remains
  forbidden as a set_status target from every source status.

### Transaction structure (plpgsql)

```text
execute_automation_rule(p_org, p_sweep, p_rule, p_revision,
                        p_mention, p_analysis, p_actions, p_mode)
security definer; single transaction per call.

-- OUTER SCOPE: claim + attempt accounting. Never rolled back except by
-- connection death (in which case nothing committed and no effects exist).
insert into automation_rule_executions
    (org, sweep, rule, revision, mention, trigger_analysis, location,
     mode, status := 'failed', error_class := 'retryable',
     last_error_code := 'claim_only', attempt_count := 1)
  values (…)
  on conflict on constraint execs_idempotent do nothing;

select * into v_exec from automation_rule_executions
  where <idempotency key> for update;          -- blocks a concurrent claimer
if v_exec.status is terminal (applied/partial/blocked/no_op,
                              or failed+terminal,
                              or failed+retryable at attempt cap 3):
    return v_exec;                              -- replay: zero effects
-- else: we own the unit; this is attempt v_exec.attempt_count (+1 if retry)

-- VALIDATION (before any business write; failure here never mutates):
--   rule row FOR SHARE: active, unarchived, revision = p_revision
--       else -> finalize('failed', terminal, 'rule_changed')
--   p_actions parse against the action schema
--       else -> finalize('failed', terminal, 'invalid_action')
--   mention row FOR UPDATE: exists (composite FKs already prove tenancy)

-- INNER SCOPE: the business-mutation subtransaction.
begin                                           -- plpgsql block = savepoint
    for each action in p_actions (in order):
        evaluate matrix / guardrail against CURRENT locked mention state
            -> outcome 'blocked' (code) or 'no_op'; continue
        set_status  -> update mentions …        (never to 'escalated')
        escalate    -> validate eligibility; insert escalation
                       where no open one exists (else 'no_op');
                       update mention status to 'escalated'
    insert audit event (automation_rule.executed, counts only)
exception when others then
    -- every business write above rolls back to the savepoint;
    -- the claim row from the OUTER scope is untouched
    update automation_rule_executions set
        status = 'failed',
        error_class = classify(sqlstate),       -- retryable | terminal
        last_error_code = …, attempt_count = attempt, completed_at = now()
      where id = v_exec.id;
    return …;                                   -- COMMIT: failure survives
end;

-- SUCCESS: becomes terminal in the same transaction as its effects.
update automation_rule_executions set
    status = derive(outcomes),   -- applied | partial | blocked | no_op
    outcomes = …, attempt_count = attempt, completed_at = now()
  where id = v_exec.id;
return …;                                        -- COMMIT
```

Why this shape holds the required properties:

- **Concurrent claims:** two callers race on the `on conflict` insert; the
  second blocks at `for update` until the first commits, then sees a
  terminal row and replays with zero effects. Demonstrated in §11-DB-8.
- **Crash before commit:** the claim, the effects, and the audit event are
  one transaction — all vanish together; the next sweep retries from
  nothing, and no effect escaped. (The `claim_only` placeholder status is
  never observable outside the transaction.)
- **Technical failure:** the inner block is a subtransaction; its
  exception handler rolls back every business write while the outer
  claim row remains, is finalized as `failed` + class, and **commits** —
  the failure record survives the rollback of effects. §11-DB-6/7.
- **Retry:** a later sweep calling with the same key finds
  `failed`/`retryable` under the cap, takes the row lock, increments
  `attempt_count`, and re-runs validation and the inner block against the
  now-current committed state. `failed`+`terminal` and all success states
  return immediately as replays. §11-DB-5.
- **Success is terminal atomically:** the status update commits with the
  effects; there is no window where effects exist without their terminal
  record.

This behavior is verified in the PostgreSQL harness (§11-DB), not only in
the TypeScript twin. The demo adapter implements the same algorithm for
service-level tests; the harness is the authority.

## 8. Dry-run semantics

Dry run projects; it never applies. Accepted vocabulary per action:
`would_apply`, `would_block`, `would_no_op`, `would_fail_validation`; row
status per the §5 check constraint (`would_partial` for mixed
projections). Projections evaluate the real pipeline — condition match,
matrix, guardrails — against current mention state, without taking locks
beyond a plain read and without calling the mutation RPC at all (a
separate read-only recording path writes the projection rows).

**Exactly what dry run may write (operational records, not business
records):** its `automation_sweeps` row, and its `mode='dry_run'`
execution rows. Nothing else: no mention writes, no escalations, no
rule-timestamp updates, **no audit events of any kind** — the sweep row is
the telemetry. The operational/business distinction is tested explicitly
(§11-INT-9): a dry-run sweep leaves `mentions`, `escalations`,
`automation_rules`, and `audit_events` byte-identical.

## 9. Rule-activity timestamps

Unchanged from v2 §6: `last_evaluated_at` / `last_matched_at` /
`last_applied_at`, written once per rule per **apply** sweep with
`greatest()` monotonic updates inside sweep finalization; blocked/failed
evaluations still advance `last_evaluated_at`; revision changes reset
nothing; dry run touches none of them; `last_run_at` dropped; UI shows
"Last applied."

## 10. Cron status and HTTP response contract

Response shape as v2 §8 (analysis block unchanged; execution block with
per-sweep rows, `sweep_id`s, organization counts, evaluation counts, action
outcomes, retryable vs terminal failure counts). Status semantics per the
review's correction:

| Condition | Status | HTTP |
| --- | --- | --- |
| Cron secret missing/invalid | — | 401 (unchanged) |
| Route cannot run its loop at all (config invalid, organization enumeration failed) | `failed` | 500 |
| Work was attempted and **zero** attempted units of work succeeded, due to systemic or execution failures (every attempted org errored, or every execution failed) | `failed` | 503 |
| Some work succeeded and any material work failed (`erroredOrganizations > 0`, `mentionsFailed > 0`, any sweep `failed`, `actionsFailed > 0`, retryable failures present) | `degraded` | 200 |
| Everything attempted completed; blocked/no_op are normal operation | `ok` | 200 |
| Nothing to do (no due organizations, mode `off`, empty allowlist) | `ok`, with the reason stated | 200 |

Sweep rows persist the same counters for diagnosis and alerting without log
access; `sweep_id` propagates through response, execution rows, audit
metadata, and log lines.

## 11. Migration order, implementation order, tests

### Migrations

1. `…_tenant_integrity_prereqs.sql` — §5 parent uniques + the
   `mentions_location_same_org` composite FK (with its pre-flight
   violating-rows assertion).
2. `…_automation_execution.sql` — sweeps + executions + indexes + rule
   timestamp swap.
3. `…_automation_execution_rls.sql` — §5 policies, revokes.
4. `…_automation_execution_rpc.sql` — the RPC of §7, matrix in SQL,
   security posture.
5. `…_automation_execution_audit_vocabulary.sql` — `automation_rule.executed`,
   `automation_rule.execution_failed`, `automation_sweep.completed`.
6. `…_audit_events_no_client_inserts.sql` — §6 (lands together with the
   adapter change, same PR).

All applied to the hosted project only after P0-2 (reset + harness) passes
locally.

### Implementation order

1. **G0 block — implemented (worktree `rules-execution-g0`, Tasks 1–13):**
   P0-2 harness run — done, local Docker stack, `supabase db reset` clean
   with this branch's three migrations, `npm run db:verify-rls` 37/37
   checks (Task 13); migration 1 — done (Task 1); domain types
   (`transitions.ts` matrix with `escalation_reserved`, outcome and
   projection vocabularies) — done (Tasks 2, 5); migrations 2–3 — done
   (Task 4); repository contract + demo adapter (full algorithm, including
   the claim/replay/retry semantics in TypeScript) — done (Tasks 6–7);
   engine loop with `dry_run` + `off` only — done (Task 10); route
   contract — done (Task 11); dry-run UI states — done (Task 12).
   *Releasable: dry run internally.* Decision-ledger entries D148–D155 in
   `docs/architecture/current-state.md` record what shipped and why;
   `apply` is not enabled anywhere by this block.
2. **G1 block — not started:** migration 4 (RPC) + Supabase adapter;
   migration 5; migration 6 + audit adapter change; P0-4 location-scoping
   action fixes; full §11 test suite; `apply` for the internal organization
   via allowlist.
3. **G2 block (its own plan) — not started:** F17 inventory
   re-verification; per-path transactional RPCs for the overlapping
   mutations; database-level location authorization for mention/escalation
   writes. Not scheduled here; a prerequisite line item for customer
   `apply`.
4. Outcome UI on `/rules/[ruleId]` (execution history with mode column,
   projected vs applied outcomes visually distinct, three timestamps,
   mode-aware empty states) — lands with block 1 for dry-run visibility —
   done (Task 12).
5. Docs: decision-ledger entries; current-state updates; this plan marked
   implemented per gate — done (Task 13, this update).

### Tests

**DB harness** (`supabase/tests/`, Docker; the authority for transactional
claims — every test here runs against real PostgreSQL):

1. Authenticated users cannot insert audit events at all (post-§6);
   service-role and RPC writes succeed. Cross-org audit reads still
   refused.
2. Cross-organization combinations rejected by constraints, attempted as
   service role so the constraint itself is what refuses: sweep from org A
   with execution from org B; rule A + mention B; analysis of mention B on
   an execution for mention A; location B on a mention-A execution.
3. Execution location must equal the mention's location: inserting an
   execution whose `location_id` differs from its mention's fails on
   `execs_location_is_mentions`; a mention remap cascades.
4. Location-manager visibility: manager of location L reads only rows with
   `location_id = L`; unlocated rows invisible to managers, visible to
   admin roles; org-B manager sees nothing in org A.
5. Idempotency and occurrence: same key replays with zero effects
   (repeated RPC call after success — row count and mention state
   unchanged); a **new** `mention_analyses` row for the same mention
   permits the same rule revision to execute again; the same occurrence
   can never produce duplicate effects (asserted on escalation count and
   status-write count).
6. Technical failure rollback: a forced mid-unit error (e.g. injected via
   a constraint-violating second action) rolls back the whole unit's
   business writes — escalation created earlier in the unit is gone,
   status unchanged — while the `failed`/`retryable` row **survives and is
   committed**.
7. Retry: after DB-6, a second RPC call re-executes from the last
   committed state, succeeds, `attempt_count = 2`; a `terminal` failure
   and an at-cap retryable failure both replay without effects.
8. Concurrency: two sessions, same unit — one applies, the blocked second
   replays the terminal row; effects exactly once. Two sessions claim the
   same organization's sweep — the partial unique index refuses one.
9. Matrix parity and the escalation reservation: SQL agrees with
   `transitions.ts` on every (from, to, risk) cell; `set_status` to
   `escalated` refused with `escalation_reserved` from every source
   status; escalate validates eligibility before any write (an ineligible
   subject leaves no escalation row and no status change).
10. Clean `supabase db reset` + all migrations + seed + the whole harness
    (P0-2 acceptance).

**Integration/service** (vitest, demo adapter twin — semantics mirrored,
authority stays with the DB harness):

1. Engine loop ordering, snapshot semantics (`rule_changed` mid-sweep),
   caps, budget stop, allowlist filtering.
2. Sweep counter correctness across mixed outcomes.
3. Timestamps: monotonic under an older-sweep-finishes-last interleaving;
   dry run advances nothing.
4. Route: every row of §10's table, including `failed`/503 when all
   attempted work fails and `degraded`/200 on mixed results; `off` and
   empty-allowlist responses.
5. Location-scoping action fixes (P0-4): cross-location refusal for
   escalation status and response assignment; own-location success.
6. Malformed/unknown action payloads fail validation before mutation
   (projected as `would_fail_validation` in dry run).
7. UI: history renders both modes distinctly; projected outcomes never
   read as applied; empty states per mode.
8. Replay/no-effect: calling the service twice over the same analyzed
   set produces no new rows and no new effects.
9. Dry run distinction: full projection rows recorded; `mentions`,
   `escalations`, `automation_rules`, `audit_events` unchanged —
   asserted table-by-table.

### Acceptance criteria

- All §11 tests green; `npm run verify` green; P0-2 recorded as run.
- With `RULES_EXECUTION_MODE` unset, deployed behavior is identical to
  today except the response's `execution` block reporting `mode: "off"`.
- A dry-run sweep over the seeded organizations on the hosted project:
  projection rows exist, business tables and audit trail byte-identical
  (row counts + checksums before/after).
- G1 `apply` on the internal organization: first live sweep's execution
  rows, escalation dedupe against D38, and audit events all reconciled by
  hand against the sweep response before any other organization is
  allowlisted.
- No claim of atomicity/idempotency in docs or UI beyond what §7's tested
  mechanism provides; nothing describes execution as enabled while the
  mode says otherwise.

## 12. Out of scope, restated

Future executors (`generate_draft`, `require_approval`, `notify`,
`auto_publish`, `assign`, `tag`) remain unresolved by design; external side
effects will need an outbox pattern that nothing in this schema presumes.
The G3 retrofit workstream is acknowledged, gated, and not planned here.

## Remaining product decisions

- **Q5 — allowlist graduation.** Env-var allowlist is accepted for
  Phase 2. When customer `apply` (G2) arrives, does rollout move to a
  database-backed per-organization setting with an admin surface, and who
  flips it — Lia operators only, or organization owners? (Affects G2
  scope, not this phase.)
- **Q6 — location-manager notification surface.** Location managers can
  now *read* what automation did to their locations' mentions. Should
  anything actively surface it to them (a feed, a digest) or is the
  history page enough for Phase 2? Plan assumes the page is enough.
- Q4 from v2 stands resolved as specified: automation never reopens
  dismissed mentions.
- **Q7 — open-vs-any escalation dedupe.** This section (§7) says the
  `escalate` executor dedupes against an "open" escalation. G0 shipped
  dedupe against *any* escalation ever raised for the mention — matching
  the analysis path's existing `escalations.create` behavior, which rule
  execution reuses, and which the dry-run projection in D152 mirrors for
  fidelity. Parked rather than silently implemented against the letter of
  this spec: the consequence is that a mention escalated and later
  resolved by a human cannot be re-escalated by either analysis or a rule
  today. Must be decided — reopen to "open only," or keep "any" and amend
  this section — before the G1 execution RPC pins the equivalent SQL
  semantics, since changing it after G1 means a migration against live
  execution history rather than a TypeScript function. (Recorded in
  `docs/architecture/current-state.md`, "New building rule execution
  (G0)".)
