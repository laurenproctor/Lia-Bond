# Rules execution G1 (internal apply gate) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Plan, v2. Revised after design review before any implementation; v1 is in git
history. Implementation stays paused until this revision is approved.

**Goal:** Build everything the spec's G1 gate requires — a shared database-backed escalation contract enforcing D158's open-only semantics for analysis and rules alike, the transactional execution RPC with its parity suite, atomic sweep claiming, audit hardening, location-scoping fixes, and a CI gate that runs the database harness — so `apply` can be enabled for the internal organization.

**Architecture:** One plpgsql function, `raise_escalation`, is the single escalation authority: mention eligibility, open-only dedupe, occurrence idempotency, creation, and the mention transition happen atomically inside it, and both the analysis path (`escalations.create`) and the execution RPC call it. `execute_automation_rule` loads actions from the stored rule revision (never trusting caller payloads) and applies them under the SQL transition matrix, which stays parity-locked to TypeScript via a generated assertion file that CI runs against migrated Postgres. Sweep claiming becomes its own atomic RPC. The demo adapter mirrors every contract in TypeScript through the existing `raiseEscalation` seam.

**Tech Stack:** plpgsql migrations, Supabase JS service-role client, TypeScript strict, Vitest, psql-based database tests, GitHub Actions (new — the repo has no CI today).

**Spec:** `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`; decisions D148–D158. The governing product principle for every escalation decision below: **Lia must recognize genuinely new risk without turning retries, concurrent workers, or stale configuration into duplicate actions — history informs future judgment, it never permanently suppresses it.**

## Global Constraints

- **The shared escalation contract** (§Task 4) is the only code path that creates an escalation. It enforces, atomically: (1) mention eligibility — `dismissed` is permanently refused; `escalated` never creates (open case → dedupe result; closed case → refused pending human re-triage); (2) at most one open escalation per mention (`status in ('open','in_progress','pending_approval')`), backed by a partial unique index; (3) occurrence idempotency — a non-null `trigger_analysis_id` that already produced an escalation can never produce another, backed by a partial unique index; (4) creation and the mention's transition to `escalated` commit together. Verified inventory: `escalations` has **no** existing unique constraint on `mention_id` (checked 2026-08-11 against `20260801000100_initial_schema.sql:504-527`), so the partial indexes add the invariants and nothing needs replacing.
- The RPC must match the demo twin's pinned semantics (D148–D157): five-part idempotency key with `mode`; terminal replay returns the row unchanged with zero effects; retry cap `attempt_count >= 3`; whole-unit rollback with a surviving `failed` row; policy refusals are outcomes, never errors; success clears `error_class`/`last_error_code`; outcome codes exactly `escalation_reserved`, `high_risk_guardrail`, `forbidden_transition`, `escalation_exists`, `action_not_executable`, `rule_changed`, `invalid_action`; executable set from the capability registry; `assigneeUserId` dropped; `sweep_id`/`started_at` keep first-attempt values on retry; `location_id` follows the mention; all caught technical failures classify `retryable`. **Malformed configuration (unknown action type, missing required field, invalid enum target, null or non-array actions) is terminal `invalid_action`, validated before the apply subtransaction — never `retryable`.** An empty actions array is valid and yields a `no_op` row with empty outcomes (the G0 twin's behavior).
- **The RPC takes no action payload.** Actions load from the stored rule inside the transaction, after the revision check; a caller can name a unit, never define one.
- **Audit contract (revised):** execution audit events may contain identifiers, outcomes, operational status, SQLSTATE, and aggregate counts — never mention content or other sensitive source text. `actor_type` `'system'`, `actor_user_id` null. No authenticated audit inserts anywhere (spec §6).
- RPC/function security: `security definer`, `set search_path = public, pg_temp`, `revoke execute … from public, anon, authenticated`, `grant … to service_role` — for every function this plan creates.
- Migrations: `20260812000100`–`20260812000600`, listed in §Migration sequence; a migration is never amended after its task's commit — later additions get later versions. Nothing is applied to the hosted project by this plan.
- Fail closed on referenced records: load the mention explicitly and refuse (`notFound`) when absent — never `mention?.locationId ?? null` where the optional chain could hide a missing record.
- Every commit leaves `npm run verify` green. TypeScript strict; sentence case in UI copy.
- Worktree notes (project memory): copy `next-env.d.ts` from the main checkout; `export SUPABASE_DB_URL` from `supabase status` before harness scripts; node scripts resolve only `@/`-alias imports.

## Migration sequence (complete, in order)

| Version | Name | Contents |
| --- | --- | --- |
| 20260812000100 | `execution_audit_vocabulary` | Three audit event types (Task 1) |
| 20260812000200 | `audit_events_no_client_inserts` | Policy drop + revoke (Task 2) |
| 20260812000300 | `escalation_contract` | `trigger_analysis_id` column, both partial unique indexes, `raise_escalation` (Task 4) |
| 20260812000400 | `automation_transition_functions` | Matrix decision functions (Task 6) |
| 20260812000500 | `execute_automation_rule_rpc` | The execution RPC (Task 7) |
| 20260812000600 | `automation_execution_support` | `claim_automation_sweep`, `automation_mark_activity` (Task 8) |

All six appear in the operator runbook (Task 12) as one ordered push.

## Semantic guarantee → test map

| Guarantee | Test(s) |
| --- | --- |
| Dismissed mention permanently refused (both paths) | Task 4 scenario D; harness §5; matrix cell tests (G0, standing) |
| Resolved escalation + mention still `escalated` → refused | Task 4 scenario A; harness §5 |
| Re-triaged + same occurrence replayed → no new escalation | Task 4 scenario B; harness §5 (occurrence index) |
| Re-triaged + genuinely new occurrence → new escalation | Task 4 scenario C; harness §5; Task 7's RPC path via harness §5 |
| At most one open escalation per mention, under concurrency | Harness §2 (index), race script session test (Task 10) |
| Same unit executed concurrently → one row, one escalation, one transition, one audit event | Race script `execute_automation_rule` test (Task 10) |
| Replay of a terminal unit → zero effects | Harness §5, §7; G0 twin tests (standing) |
| Whole-unit rollback with surviving failure record | Harness §6/§7 |
| Caller cannot supply actions; stale revision refused | RPC signature (no payload) + harness §5 (`rule_changed`) |
| Analysis pipeline respects the contract end to end | Task 5's pipeline tests |
| SQL matrix ≡ TypeScript matrix | Generated parity file (harness §9) + drift-guard vitest + CI job |
| Location manager blocked from null-location and cross-location records | Task 3 tests; harness §4 |
| No authenticated audit inserts; definer/service paths write | Harness §1 (explicit identities) |

---

### Task 1: Audit vocabulary migration

**Files:**
- Create: `supabase/migrations/20260812000100_execution_audit_vocabulary.sql`
- Modify: the domain audit event-type list (find with `grep -rn "response.edited" src/domain`)

**Interfaces:**
- Produces: `audit_events_known_event_type` and `AuditEventType` accept `automation_rule.executed`, `automation_rule.execution_failed`, `automation_sweep.completed`.

- [ ] **Step 1:** Write the migration following the constraint-swap idiom of `20260807000700_audit_vocabulary_merge.sql` (drop check, re-add with the union), comment naming the feature and that nothing writes these until the RPC lands.
- [ ] **Step 2:** Add the three literals to the domain vocabulary; `npx tsc --noEmit`.
- [ ] **Step 3:** `npm run db:validate` + full suite green.
- [ ] **Step 4:** `git commit -m "feat(db): execution audit event vocabulary"`

---

### Task 2: Audit hardening — no authenticated audit inserts

**Files:**
- Create: `supabase/migrations/20260812000200_audit_events_no_client_inserts.sql`
- Modify: `src/lib/data/supabase/index.ts` (`auditEvents.record`, ~line 2750)
- Test: extend the supabase adapter test covering `auditEvents` (`grep -rln "audit_events" tests/`)

- [ ] **Step 1:** Migration:

```sql
-- Audit hardening (spec §6, closes F3). The original audit_events_insert
-- policy let any organization member append any event type with
-- actor_user_id null — forgeable system/AI attribution. Requiring
-- actor_user_id = auth.uid() would stop impersonation but not fabrication,
-- so authenticated inserts are removed entirely: audit rows are written
-- only by trusted server-side paths — the service-role adapter method and
-- the security-definer execution functions. Lands with the adapter switch;
-- the two are one behavior.
drop policy audit_events_insert on public.audit_events;
revoke insert on public.audit_events from authenticated;
```

- [ ] **Step 2:** Switch `auditEvents.record`'s insert to `serviceClient()` (reads keep the user client). Comment: scope already passed `getOrganizationContext()`; module is `server-only`; the paired RLS change removes the client-credentialed path.
- [ ] **Step 3:** Adapter test pins which client received the insert (follow the file's existing client-stub pattern). Validate + suite + tsc.
- [ ] **Step 4:** `git commit -m "feat(auth): audit events are written only by trusted server-side paths"`

---

### Task 3: Location-scoping fixes (P0-4), fail-closed

**Files:**
- Modify: `src/app/actions/escalations.ts` (`updateEscalationStatusAction`), `src/app/actions/responses.ts` (`assignResponseDraftAction`)
- Test: the existing action test files (`grep -rln "updateEscalationStatusAction\|assignResponseDraftAction" tests/`)

**Interfaces:**
- Consumes: `assertPermissionForLocation` (`src/lib/actions/guard.ts:58`), the `updateMentionStatusAction` pattern (`src/app/actions/mentions.ts:30`).

- [ ] **Step 1: Failing tests**, four per action:
  1. Location manager of A refused (`forbidden`) on a record whose mention belongs to location B.
  2. Location manager succeeds on their own location's record.
  3. **Location manager refused when the record's mention has `locationId: null`** (org-wide record; `canForLocation` refuses scoped roles with no location — pin it at the action level).
  4. **Referenced mention missing** (delete it from the store after creating the record, or seed a dangling reference the way the store allows) → explicit `notFound("Mention")`, not a silent org-wide fallback. Owner remains unrestricted (one shared case).
- [ ] **Step 2:** RED. **Step 3:** Implement: load the record, then `const mention = await context.dataSource.mentions.get(context.scope, existing.mentionId); if (!mention) throw notFound("Mention");` then `assertPermissionForLocation(context, permission, mention.locationId)`. No optional chaining on the mention.
- [ ] **Step 4:** GREEN + full suite + tsc. **Step 5:** `git commit -m "fix(auth): location managers act only on their own locations' records, failing closed"`

---

### Task 4: The shared escalation contract

**Files:**
- Create: `supabase/migrations/20260812000300_escalation_contract.sql`
- Modify: `src/domain/entities/escalation.ts` (add `triggerAnalysisId` to the entity + `CreateEscalationInput`), `src/lib/data/supabase/mappers.ts`
- Modify: `src/lib/data/demo/index.ts` (`raiseEscalation`/`escalationFor` — the existing shared seam becomes the TypeScript mirror of the contract)
- Modify: `src/lib/data/types.ts` (`EscalationRepository.create` return gains `reason`)
- Modify: `src/lib/data/supabase/index.ts` (`escalations.create` calls the function via `.rpc`)
- Modify: `src/lib/analysis/analyze.ts` (handle the `created:false, escalation:null` refusal shapes)
- Test: `tests/escalation-contract.test.ts` (new), plus deliberate updates to the G0-pinned dedupe tests named in v1

**Interfaces:**
- Produces, in SQL:

```sql
public.raise_escalation(
  p_organization_id uuid, p_mention_id uuid,
  p_category escalation_category, p_severity risk_level,
  p_title text, p_summary text, p_due_at timestamptz,
  p_trigger_analysis_id uuid   -- null on the analysis path (see below)
) returns table (escalation_id uuid, created boolean, reason text)
```

  `reason` is null on creation, else one of `escalation_exists`, `awaiting_retriage`, `mention_dismissed`, `occurrence_replayed`.
- Produces, in TypeScript: `escalations.create(scope, input) → { escalation: Escalation | null, created: boolean, reason: EscalationRefusalReason | null }` — `escalation` is the existing open one for `escalation_exists`/`occurrence_replayed`, null for the two hard refusals. Both adapters implement identically; the demo's `raiseEscalation` is the mirror and stays the seam `executeUnit` shares.
- **Occurrence identity:** `escalations.trigger_analysis_id uuid null` — the analysis row that authorized the escalation. Rules path always passes it (the unit's `trigger_analysis_id`). The analysis path passes null today because its load-bearing write order (escalation → mention update → analysis insert; the analysis row is the crash-recovery commit point and does not exist yet at escalation time) — its retry safety is the open-escalation dedupe: the escalation a crashed run just created is open and absorbs the re-run. When a re-analysis pipeline exists and analyzes with a known occurrence, it passes the id and gains structural idempotency. Recorded in the migration comment and the decision ledger (Task 12).

- [ ] **Step 1: Write the migration**

```sql
-- D158's shared escalation contract. This function is the ONLY creator of
-- escalation rows: analysis (escalations.create) and rule execution
-- (execute_automation_rule) both call it, so eligibility, open-only
-- dedupe, occurrence idempotency, creation, and the mention's transition
-- to 'escalated' are one atomic decision with one owner.
--
-- Eligibility ladder (mention locked FOR UPDATE):
--   dismissed              -> refused, 'mention_dismissed' (permanent; the
--                             matrix states the same for rules)
--   escalated, open case   -> dedupe, 'escalation_exists'
--   escalated, no open one -> refused, 'awaiting_retriage' (a human must
--                             re-triage before anything re-escalates)
--   anything else          -> eligible. 'new' is deliberately legal: the
--                             analysis path escalates before applying its
--                             outcome. The rules path layers the stricter
--                             transition matrix on top BEFORE calling.

alter table public.escalations
  add column trigger_analysis_id uuid
    references public.mention_analyses (id) on delete set null;
comment on column public.escalations.trigger_analysis_id is
  'The analysis occurrence that authorized this escalation. Null on the analysis path (the analysis row does not exist yet at escalation time; its retry safety is the open-escalation dedupe). Non-null and unique for rule-driven escalations: the same occurrence can never escalate twice.';

-- Pre-flight: the one-open index cannot build if any mention already
-- carries two open escalations. Application dedupe should make this
-- impossible; assert rather than assume.
do $$
declare violating integer;
begin
  select count(*) into violating from (
    select mention_id from public.escalations
    where status in ('open', 'in_progress', 'pending_approval')
    group by mention_id having count(*) > 1
  ) dupes;
  if violating > 0 then
    raise exception 'escalations_one_open_per_mention pre-flight: % mentions carry multiple open escalations', violating;
  end if;
end $$;

create unique index escalations_one_open_per_mention
  on public.escalations (mention_id)
  where status in ('open', 'in_progress', 'pending_approval');

create unique index escalations_one_per_occurrence
  on public.escalations (trigger_analysis_id)
  where trigger_analysis_id is not null;

create function public.raise_escalation(
  p_organization_id uuid, p_mention_id uuid,
  p_category escalation_category, p_severity risk_level,
  p_title text, p_summary text, p_due_at timestamptz,
  p_trigger_analysis_id uuid
) returns table (escalation_id uuid, created boolean, reason text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_mention public.mentions;
  v_open uuid;
  v_replayed uuid;
  v_new uuid;
begin
  select * into v_mention from public.mentions
   where id = p_mention_id and organization_id = p_organization_id
   for update;
  if v_mention is null then
    raise exception 'mention % not found in organization %',
      p_mention_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_mention.status = 'dismissed' then
    return query select null::uuid, false, 'mention_dismissed'; return;
  end if;

  if p_trigger_analysis_id is not null then
    select id into v_replayed from public.escalations
     where trigger_analysis_id = p_trigger_analysis_id;
    if v_replayed is not null then
      return query select v_replayed, false, 'occurrence_replayed'; return;
    end if;
  end if;

  select id into v_open from public.escalations
   where mention_id = p_mention_id
     and status in ('open', 'in_progress', 'pending_approval');
  if v_open is not null then
    return query select v_open, false, 'escalation_exists'; return;
  end if;

  if v_mention.status = 'escalated' then
    -- Closed case, mention never re-triaged: history informs judgment,
    -- a human decision reopens the door.
    return query select null::uuid, false, 'awaiting_retriage'; return;
  end if;

  insert into public.escalations
      (organization_id, mention_id, category, severity, status,
       title, summary, due_at, trigger_analysis_id)
  values (p_organization_id, p_mention_id, p_category, p_severity, 'open',
          p_title, p_summary, p_due_at, p_trigger_analysis_id)
  on conflict (mention_id)
    where status in ('open', 'in_progress', 'pending_approval')
    do nothing
  returning id into v_new;

  if v_new is null then
    -- A concurrent caller won the partial-index race after our read;
    -- their row is the dedupe result, not an error.
    select id into v_open from public.escalations
     where mention_id = p_mention_id
       and status in ('open', 'in_progress', 'pending_approval');
    return query select v_open, false, 'escalation_exists'; return;
  end if;

  update public.mentions set status = 'escalated', updated_at = now()
   where id = p_mention_id;
  return query select v_new, true, null::text;
end $$;

revoke execute on function public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid) to service_role;
```

(Check `escalations`' exact column names — `title`/`summary`/`due_at` — against `20260801000100_initial_schema.sql:504-527` and match; check the enum type names `escalation_category`/`risk_level` the same way. The FOR UPDATE mention lock serializes racing callers: the loser blocks, re-reads, and takes the dedupe path — the ON CONFLICT arm is the backstop for the index race, and both arms return `created:false` normally, never a 23505 to the caller.)

- [ ] **Step 2: Failing TypeScript tests** (`tests/escalation-contract.test.ts`, demo adapter — the TS mirror), the review's exact scenario matrix plus the standing cases:
  - **A.** Escalate; resolve the escalation; mention still `escalated` → `create` again returns `{created: false, reason: "awaiting_retriage", escalation: null}`; row count unchanged.
  - **B.** Resolve; re-triage mention to `monitoring`; call with the SAME `triggerAnalysisId` that produced the first escalation → `{created: false, reason: "occurrence_replayed"}`; row count unchanged.
  - **C.** Resolve; re-triage; NEW `triggerAnalysisId` → `{created: true}`; two rows total, exactly one open; mention `escalated` again.
  - **D.** Dismiss the mention → `{created: false, reason: "mention_dismissed"}` forever, regardless of occurrence.
  - Open blocks (`escalation_exists` with the open row returned); analysis-shaped call (`triggerAnalysisId: null`) still dedupes on open and refuses on `escalated`-closed and `dismissed`.
  - Deliberate G0 pin updates from v1's Task 4 carry over: the closed-no-longer-blocks flip in `executeUnit`'s tests and the dry-run pairing test — but note `executeUnit`'s escalate arm now flows through this contract, so `awaiting_retriage` surfaces there as `no_op` with code `awaiting_retriage`? No — the matrix already no-ops `escalated` before the contract is consulted, and refuses `dismissed`; the contract's two hard refusals are unreachable from the rules path. Assert that unreachability in one test (rules path on an `escalated` mention with a closed escalation → matrix `no_op`, no contract call recorded).
- [ ] **Step 3:** RED. **Step 4: Implement the TypeScript mirror** — `raiseEscalation` in the demo adapter becomes the ladder above (same order, same reason strings); `escalationFor` filters open (from v1); `CreateEscalationInput` gains `triggerAnalysisId: uuidSchema.nullable()` (analysis callers pass null); `EscalationRepository.create` returns the new shape; supabase `escalations.create` becomes a `.rpc("raise_escalation", …)` call mapping the returned `(escalation_id, created, reason)` — re-reading the row by id for the `escalation` field when non-null; `analyze.ts` treats `created:false` with null escalation as "no escalation" (skip the audit event, count nothing) — the pipeline semantics tests in Task 5 pin this.
- [ ] **Step 5:** GREEN across the named files + full suite + tsc + `npm run db:validate`.
- [ ] **Step 6:** `git commit -m "feat(escalations): one shared, atomic escalation contract — open-only, occurrence-idempotent (D158)"`

---

### Task 5: Analysis-pipeline end-to-end tests

**Files:**
- Test: extend `tests/analysis-run.test.ts`

**Interfaces:**
- Consumes: `analyzeMentions` with the stubbed provider (existing pattern), Task 4's contract.

- [ ] **Step 1: Write the tests** — through the pipeline, not `escalations.create` directly:
  1. **First escalation:** a `new` mention classified high risk → escalated once; escalation row carries `triggerAnalysisId: null` (analysis path), mention `escalated`.
  2. **Crash-retry absorption:** simulate the documented crash window — after `analyzeOne` created the escalation but before the analysis row exists (drive it the way the G0 rollback tests injected failures: make `createAnalysis` throw once) → re-run `analyzeMentions` → the mention is re-picked (still unanalyzed), the open escalation absorbs the retry (`created:false`), exactly one escalation, one `escalation.created_from_analysis` audit event total.
  3. **Dismissed mention never escalates:** a mention with status `dismissed` and no analysis row, classified critical by the stub → no escalation row; the run completes (the refusal is not an error); mention still `dismissed`.
  4. **Escalated mention with closed escalation is not re-escalated by the pipeline:** arrange a mention at `escalated` whose escalation is resolved and which has no analysis row (store surgery, mirroring how the repository tests arrange edge states) → run → `awaiting_retriage` refusal, no new escalation. (Unreachable through normal flow — analysis only picks unanalyzed mentions — but this pins the pipeline against the contract rather than against reachability luck.)
- [ ] **Step 2:** RED where behavior changed (test 3 and 4 fail before Task 4's `analyze.ts` handling). **Step 3:** any `analyze.ts` adjustments live in Task 4; this task should need test code only — if implementation gaps surface, they are Task 4 defects to fix there.
- [ ] **Step 4:** GREEN + full suite. **Step 5:** `git commit -m "test(analysis): the pipeline honors the shared escalation contract end to end"`

---

### Task 6: Transition matrix in SQL + generated parity file

Unchanged from v1 except file version. **Files:** `supabase/migrations/20260812000400_automation_transition_functions.sql`, `scripts/generate-matrix-parity-sql.ts` (exporting `buildMatrixParityLines(): string[]` shared by CLI and drift test), `supabase/tests/matrix-parity.generated.sql` (committed), `tests/matrix-parity-generated.test.ts`, package.json script `matrix:parity:generate`.

- [ ] **Step 1:** Migration with `automation_set_status_decision(p_current mention_status, p_target mention_status, p_risk risk_level) returns text` and `automation_escalate_decision(p_current mention_status) returns text` — `language sql immutable`, the exact `case` bodies from v1 (git history `139098e`, Task 6 Step 1 — transcribe verbatim), revokes + service_role grants.
- [ ] **Step 2:** Generator emitting one `pg_temp.check(...)` per cell (324 set_status + 9 escalate), from `buildMatrixParityLines()`.
- [ ] **Step 3:** Drift-guard vitest: committed file equals `buildMatrixParityLines().join("\n")` byte-for-byte.
- [ ] **Step 4:** `npm run db:validate`, focused + full suite, commit — `git commit -m "feat(db): transition matrix in SQL with generated parity assertions"`

---

### Task 7: The execution RPC — actions from storage

**Files:**
- Create: `supabase/migrations/20260812000500_execute_automation_rule_rpc.sql`
- Modify: `src/lib/data/types.ts` (`ExecuteUnitInput` loses `actions`; becomes the five-field unit key), `src/lib/rules/execute.ts` (stops passing actions to `executeUnit`; dry-run projection keeps using the loaded rule's actions directly), `src/lib/data/demo/index.ts` (`executeUnit` loads actions from the stored rule after the revision check)
- Test: `tests/automation-execution-repository.test.ts` (contract change ripples; plus the new validation cases)

**Interfaces:**
- Produces: `public.execute_automation_rule(p_organization_id uuid, p_sweep_id uuid, p_rule_id uuid, p_revision integer, p_mention_id uuid, p_analysis_id uuid) returns public.automation_rule_executions` — **no actions parameter**. TypeScript: `ExecuteUnitInput = { sweepId, automationRuleId, ruleRevision, mentionId, triggerAnalysisId }`; `RecordProjectionInput = ExecuteUnitInput & { status: DryRunExecutionStatus, outcomes: ExecutionActionOutcome[] }`.

- [ ] **Step 1: Failing twin tests first** — the demo `executeUnit` contract change: a caller can no longer influence actions (the old "malformed action payload" test becomes: corrupt the STORED rule's actions in the store → terminal `invalid_action`); add: stored rule with an action whose `set_status` target is not a valid mention status → terminal `invalid_action` before any mutation; empty stored actions array → `no_op` row, empty outcomes, zero effects; null-ish/corrupt stored actions (store surgery) → terminal `invalid_action`.
- [ ] **Step 2:** RED. **Step 3:** Update the demo twin (load `rule.actions` after the revision check; run the same Zod array parse it already used, now against stored data) and the engine call sites; tsc chases the type change through `tests/rules-execute.test.ts` helpers.
- [ ] **Step 4: Write the RPC migration.** Start from v1's full function body (git history `139098e`, Task 7 Step 1) with these deltas, each mirroring a review item:
  1. Drop `p_actions`; after the rule validation block, `v_actions := v_rule.actions;` — the stored revision's actions are the only actions.
  2. **Validation before the subtransaction:** `v_actions` must be a jsonb array (else terminal `invalid_action`); every element's `type` in the eight-member vocabulary (else `invalid_action`); every `set_status` element's `status` value in `select enum_range(null::mention_status)::text[]` — checked as text BEFORE any cast (else `invalid_action`); `escalate`/`set_status` field presence checked the same way. Empty array skips the loop and derives `no_op`.
  3. The escalate arm calls the shared contract: `select * into v_esc_id, v_esc_created, v_esc_reason from public.raise_escalation(p_organization_id, p_mention_id, 'other', v_mention.risk_level, 'Escalated by rule: ' || v_rule.name, null, null, p_analysis_id);` — `created` → `applied` outcome + `v_status := 'escalated'` (the contract already moved the mention; refresh `v_status` from its effect); `escalation_exists`/`occurrence_replayed` → `no_op` with that reason as code; `mention_dismissed`/`awaiting_retriage` are unreachable behind the matrix (the function may still return them; map to `blocked` with the reason as code, so a future matrix change cannot silently invent an eighth semantics).
  4. Everything else from v1 stands: claim insert with `on conflict do nothing`, `for update` replay/retry gate, `rule_changed` on revision drift, per-action outcomes, status derivation, success clearing error fields, the exception handler's whole-unit rollback with retryable classification and the `execution_failed` audit event carrying identifiers + SQLSTATE (permitted by the revised audit contract).
- [ ] **Step 5:** `npm run db:validate`; full suite + tsc green. **Step 6:** `git commit -m "feat(db): execute_automation_rule — transactional unit executing the stored revision only"`

---

### Task 8: Atomic sweep claim + activity support functions

**Files:**
- Create: `supabase/migrations/20260812000600_automation_execution_support.sql`

**Interfaces:**
- Produces: `public.claim_automation_sweep(p_organization_id uuid, p_mode text) returns table (sweep public.automation_sweeps, claimed boolean)` and `public.automation_mark_activity(p_organization_id uuid, p_rule_id uuid, p_at timestamptz, p_matched boolean, p_applied boolean) returns void`.

- [ ] **Step 1: Write the migration**

```sql
-- Sweep claiming as one atomic decision (review item 4): the multi-step
-- PostgREST version could double-expire a stale sweep and race the
-- replacement insert. Here the existing running row is locked FOR UPDATE,
-- so exactly one caller performs the takeover; the loser blocks, re-reads,
-- and receives the winner's claim as a normal (sweep, claimed=false)
-- outcome. The partial unique index automation_sweeps_one_running remains
-- the constraint-level backstop.
create function public.claim_automation_sweep(
  p_organization_id uuid, p_mode text
) returns table (sweep public.automation_sweeps, claimed boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_running public.automation_sweeps;
  v_new public.automation_sweeps;
begin
  select * into v_running from public.automation_sweeps s
   where s.organization_id = p_organization_id and s.status = 'running'
   for update;

  if v_running is not null then
    if v_running.started_at > now() - interval '30 minutes' then
      return query select v_running, false; return;
    end if;
    update public.automation_sweeps
       set status = 'failed', error_code = 'lease_expired',
           completed_at = now()
     where id = v_running.id;
  end if;

  begin
    insert into public.automation_sweeps (organization_id, mode, status)
    values (p_organization_id, p_mode, 'running')
    returning * into v_new;
  exception when unique_violation then
    -- A racer inserted between our lock release path and this insert
    -- (possible only when no running row existed to lock). Their claim
    -- is the answer.
    select * into v_running from public.automation_sweeps s
     where s.organization_id = p_organization_id and s.status = 'running';
    return query select v_running, false; return;
  end;
  return query select v_new, true;
end $$;

-- Monotonic activity stamps (D154): greatest() is not expressible through
-- PostgREST, so the update is a function. Never moves a timestamp
-- backwards; matched/applied advance only when their flag says so.
create function public.automation_mark_activity(
  p_organization_id uuid, p_rule_id uuid, p_at timestamptz,
  p_matched boolean, p_applied boolean
) returns void
language sql security definer set search_path = public, pg_temp
as $$
  update public.automation_rules set
    last_evaluated_at = greatest(coalesce(last_evaluated_at, '-infinity'), p_at),
    last_matched_at = case when p_matched
      then greatest(coalesce(last_matched_at, '-infinity'), p_at)
      else last_matched_at end,
    last_applied_at = case when p_applied
      then greatest(coalesce(last_applied_at, '-infinity'), p_at)
      else last_applied_at end
  where id = p_rule_id and organization_id = p_organization_id;
$$;

revoke execute on function public.claim_automation_sweep(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_automation_sweep(uuid, text) to service_role;
revoke execute on function public.automation_mark_activity(uuid, uuid, timestamptz, boolean, boolean) from public, anon, authenticated;
grant execute on function public.automation_mark_activity(uuid, uuid, timestamptz, boolean, boolean) to service_role;
```

- [ ] **Step 2:** `npm run db:validate`. **Step 3:** `git commit -m "feat(db): atomic sweep claiming and monotonic activity stamps"`

---

### Task 9: Supabase adapter goes real

**Files:**
- Modify: `src/lib/data/supabase/index.ts` (all five stubs), `src/lib/data/supabase/mappers.ts` (`mapAutomationSweep` if absent)
- Test: the supabase adapter test file covering automation (follow its stubbed-client pattern)

**Interfaces:**
- Consumes: Tasks 7–8's functions; `serviceClient()`.
- Produces: `executeUnit` → `.rpc("execute_automation_rule", { p_organization_id, p_sweep_id, p_rule_id, p_revision, p_mention_id, p_analysis_id })` mapped through `mapAutomationRuleExecution`; `claim` → `.rpc("claim_automation_sweep", …)` mapped to `{sweep, claimed}`; `finalize` → status/counters/completed_at update; `recordProjection` → insert with `ignoreDuplicates` + read-back of the stored row (the returned row, not the intended one — G0's pinned counter semantics depend on it); `markActivity` → `.rpc("automation_mark_activity", …)`. All via `serviceClient()` (cron-context path, D88; RLS grants authenticated no writes by design). RPC errors translate through the adapter's existing error helper into `DataError` — never a raw postgrest error.

- [ ] **Step 1:** Failing adapter tests per method (params mapped snake_case; error translation; claim's `{claimed:false}` shape; recordProjection returning the STORED row on replay). **Step 2:** RED. **Step 3:** Implement. **Step 4:** GREEN + full suite + tsc + `npm run db:validate`. **Step 5:** `git commit -m "feat(data): supabase execution adapter — RPC-backed units, atomic claims, monotonic activity"`

---

### Task 10: Database harness + real concurrency tests

**Files:**
- Create: `supabase/tests/execution-verification.sql`
- Create: `scripts/execution-race-test.sh`
- Modify: `package.json` (`db:verify-execution`)

**Interfaces:**
- Consumes: everything above via `supabase db reset`; the `pg_temp.check` idiom from `rls-verification.sql` (hoist the helper so both included files share it — resolve the transaction-scoping here).
- Produces: `npm run db:verify-execution` = reset → rls file → execution file → generated parity file → race script, all `ON_ERROR_STOP=1`.

- [ ] **Step 1: Write the harness.** Sections (fixtures resolved by slug, mutating sections in `begin`/`rollback`, **every role switch explicit** — review item 11):
  1. **Audit identities (DB-1):** as `authenticated` (the harness's JWT-claims impersonation idiom) insert into `audit_events` → expect 42501; **as the definer path** — call `execute_automation_rule` for a unit that applies and assert exactly one `automation_rule.executed` row landed (the RPC's security-definer identity is the intended privileged writer); as `service_role` a direct insert succeeds; cross-organization audit READ refused as an authenticated member of the other org — service role is never used to test read refusal (it bypasses RLS by design).
  2. **Escalation invariants (DB-2):** as service role, two direct inserts of open escalations for one mention → second fails `escalations_one_open_per_mention`; two inserts with one `trigger_analysis_id` → second fails `escalations_one_per_occurrence`.
  3. **Cross-org + location integrity (DB-3):** the four composite-FK mismatch refusals (sweep/rule/analysis/location vs org or mention), each asserting the constraint name; mention relocation cascades into stored execution rows.
  4. **Location-manager visibility (DB-4):** manager sees only their location's rows; null-location rows invisible to managers, visible to admins; org-B manager sees none.
  5. **Contract scenario matrix (DB-5):** through `raise_escalation` and `execute_automation_rule`: resolved + still-escalated → `awaiting_retriage`, no row; re-triaged + replayed occurrence → `occurrence_replayed`, no row; re-triaged + new `mention_analyses` row → created, two escalations one open; dismissed → `mention_dismissed` always; RPC replay of a terminal unit → same row id, `attempt_count` unchanged, single escalation/status-write/audit-event (counted).
  6. **Whole-unit rollback (DB-6):** constraint trigger on `escalations` raising for a marker mention; RPC with stored actions `[set_status monitoring, escalate]` → returned row `failed`/`retryable`, mention status unchanged, no escalation; drop trigger.
  7. **Retry (DB-7):** re-call after dropping the trigger → `applied`, `attempt_count = 2`, `error_class`/`last_error_code` null; terminal `rule_changed` (bump revision, call with the old one) replays unchanged.
  8. **Stored-actions validation (DB-8):** corrupt a rule's `actions` to a non-array / unknown type / invalid `set_status` target (direct update as service role) → terminal `invalid_action` before any mutation (mention untouched).
  9. **Matrix parity (DB-9):** `\i supabase/tests/matrix-parity.generated.sql`.
- [ ] **Step 2: Write the race script** (`scripts/execution-race-test.sh`) — **two genuine sessions, two races** (review item 5):
  1. **Claim race:** two backgrounded `psql` processes call `claim_automation_sweep` for the same org simultaneously (loop a few rounds); after each round assert exactly one `running` row and exactly one `claimed=true` result (capture each psql's output to a temp file and grep).
  2. **Execution race:** seed one unit's inputs; two backgrounded `psql` processes call `execute_automation_rule` with identical arguments simultaneously; afterwards assert — both outputs carry the SAME execution id; exactly one `automation_rule_executions` row for the key; exactly one escalation for the mention; the mention's status history shows one transition (status is `escalated`, and `updated_at` count can't show double-writes, so assert instead: exactly one `automation_rule.executed` audit event, `attempt_count = 1`).
- [ ] **Step 3:** Wire `"db:verify-execution": "supabase db reset && psql \"$SUPABASE_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/tests/rls-verification.sql -f supabase/tests/execution-verification.sql -f supabase/tests/matrix-parity.generated.sql && bash scripts/execution-race-test.sh"`.
- [ ] **Step 4: Run it** (Docker; `SUPABASE_DB_URL` exported). Iterate until green — this step proves the RPC.
- [ ] **Step 5:** `git commit -m "test(db): execution harness — contract matrix, rollback, and two-session races"`

---

### Task 11: CI gate

**Files:**
- Create: `.github/workflows/verify.yml`

**Interfaces:**
- Consumes: `npm run verify`, `npm run db:verify-execution`. The repo has no CI today (verified); this workflow is the first, and the database job is REQUIRED so a TypeScript matrix change can never merge with stale SQL behavior (review item 6).

- [ ] **Step 1: Write the workflow**

```yaml
name: verify
on:
  pull_request:
  push:
    branches: [master]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run verify
  database:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - run: npm ci
      - run: supabase start
      - name: Run the database harness
        run: |
          export SUPABASE_DB_URL="$(supabase status -o env | grep DB_URL | cut -d= -f2-)"
          npm run db:verify-execution
```

- [ ] **Step 2:** Push a branch and confirm both jobs run and pass on GitHub (this is the one task verified on the forge, not locally). Note in the PR that "database" should be marked a required status check in repo settings — an owner action; record it in the runbook.
- [ ] **Step 3:** `git commit -m "ci: verify + database harness as merge gates"`

---

### Task 12: Docs, ledger, and the internal-apply runbook

**Files:**
- Modify: `docs/architecture/current-state.md`, `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`

- [ ] **Step 1: Decision rows** — D159: the shared escalation contract (`raise_escalation` as sole creator; eligibility ladder; occurrence idempotency via `trigger_analysis_id` + partial unique index; the analysis path's null-occurrence rationale and its write-order-based retry safety; the governing principle sentence). D160: the RPC executes only the stored revision (no caller payload; malformed stored configuration is terminal). D161: atomic sweep claiming. D162: audit contract revision (identifiers/outcomes/status/SQLSTATE/counts permitted; mention content never) + service-path-only writes. D163: CI as the parity gate. Update D158's tail to "landed", with migration versions.
- [ ] **Step 2: Runbook** — the six-migration push sequence (the §Migration sequence table verbatim); mark "database" as a required check; `dry_run` + internal allowlist → watch → `apply`; first-live-sweep reconciliation; the false-positive re-escalation watch item; the cron response-shape note.
- [ ] **Step 3:** `npm run verify` green. **Step 4:** `git commit -m "docs: record G1 decisions and the internal-apply runbook"`

---

## Not in this plan

The hosted migration push and mode changes (runbook, human-executed); marking the CI check required (repo-settings owner action, in the runbook); G2's overlapping-mutation-path RPCs and location-aware write policies; ledgered G0 minors not named above; any new executor; re-analysis surfaces (when one exists, it passes a real occurrence id into the contract and gains structural idempotency for the analysis path too).
