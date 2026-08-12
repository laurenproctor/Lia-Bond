# Rules execution G1 (internal apply gate) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build everything the spec's G1 gate requires — the transactional execution RPC with its database parity suite, the real Supabase adapter, audit hardening, the two location-scoping action fixes, and D158's open-only escalation dedupe — so `apply` can be enabled for the internal organization via allowlist.

**Architecture:** The PostgreSQL RPC `execute_automation_rule` implements spec §7's claim/validate/apply/record transaction with the transition matrix factored into its own SQL function; the TypeScript matrix stays the source of truth via a generated parity file the database harness executes. The Supabase adapter's G0 stubs become real (`executeUnit` → RPC call; claim/finalize/recordProjection/markActivity as service-role writes). D158 flips escalation dedupe to open-only in one seam (`raiseEscalation`/`escalationFor`) plus a partial unique index, applied to analysis and rules alike.

**Tech Stack:** plpgsql migrations (validated by `npm run db:validate`, exercised by the Docker harness), Supabase JS service-role client, TypeScript strict, Vitest, psql-based database tests.

**Spec:** `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md` (§5 schema, §6 audit, §7 transaction, §11 tests). Decisions D148–D158 in `docs/architecture/current-state.md` bind the parity surface.

## Global Constraints

- The RPC must match the demo twin's pinned semantics exactly (D148–D157): five-part idempotency key with `mode`; terminal replay returns the row unchanged with zero effects; retry cap `attempt_count >= 3`; whole-unit rollback with a surviving `failed` row; policy refusals are outcomes (`blocked`/`no_op`), never errors; success clears `error_class`/`last_error_code`; outcome code strings exactly `escalation_reserved`, `high_risk_guardrail`, `forbidden_transition`, `escalation_exists`, `action_not_executable`, `rule_changed`, `invalid_action`; executable set derived from the capability registry (`set_status`, `escalate` today); `assigneeUserId` on escalate is dropped; `sweep_id`/`started_at` keep first-attempt values on retry; `location_id` follows the mention (schema cascade); all caught technical failures classify `retryable` (matching the twin — refinement is future work).
- D158: only an **open** escalation (`status in ('open','in_progress','pending_approval')`) blocks creation, for BOTH the analysis path and rule execution; enforced by a partial unique index; mention-level `dismissed` stays the permanent refusal (matrix, unchanged); no resolved-vs-dismissed semantic at the escalation level; re-escalation only from a new analysis occurrence (already structural: `execs_idempotent` carries `trigger_analysis_id`).
- Audit: **no authenticated inserts at all** (spec §6). The policy drop and the adapter's switch to the service-role client land in the same task. Execution audit events carry counts only, `actor_type` `'system'`, `actor_user_id` null; never mention content.
- RPC security: `security definer`, `set search_path = public, pg_temp`, `revoke execute … from public, anon, authenticated` — service role is the only caller (the `consume_oauth_state` posture at `20260807000600`).
- Migrations use versions `20260812000100`–`20260812000600`; nothing is applied to the hosted project by this plan (`npm run db:validate` + the local Docker harness are the gates; the hosted push is a post-merge operator step).
- Every commit leaves `npm run verify` green. TypeScript strict; sentence case in any UI copy.
- Worktree note (from project memory): copy `next-env.d.ts` from the main checkout, and export `SUPABASE_DB_URL` from `supabase status` before `db:verify-rls`-style scripts; node scripts resolve only `@/`-alias imports.

---

### Task 1: Audit vocabulary migration

**Files:**
- Create: `supabase/migrations/20260812000100_execution_audit_vocabulary.sql`

**Interfaces:**
- Consumes: the vocabulary-migration pattern (`20260807000700_audit_vocabulary_merge.sql`, `20260808000700_response_edited_audit_event.sql` — read one for the exact constraint-swap idiom).
- Produces: `audit_events_known_event_type` accepts `automation_rule.executed`, `automation_rule.execution_failed`, `automation_sweep.completed`. Also add the three literals to the TypeScript audit vocabulary — find it with `grep -rn "response.edited" src/domain` and extend the same list, so `AuditEventType` accepts them (Task 6's RPC inserts and Task 8's engine call depend on this).

- [ ] **Step 1: Write the migration** — follow the existing idiom exactly (drop the check constraint, re-add with the union of the previous list plus the three new literals, with a comment naming which feature adds them and that nothing writes them until the G1 RPC and sweep integration land).
- [ ] **Step 2: Extend the domain vocabulary** — add the three literals to the audit event-type list in `src/domain` (same file the grep finds); run `npx tsc --noEmit`.
- [ ] **Step 3: Validate** — `npm run db:validate` PASS; full suite green.
- [ ] **Step 4: Commit** — `git commit -m "feat(db): execution audit event vocabulary"`

---

### Task 2: Audit hardening — no authenticated audit inserts

**Files:**
- Create: `supabase/migrations/20260812000200_audit_events_no_client_inserts.sql`
- Modify: `src/lib/data/supabase/index.ts` (the `auditEvents.record` method, ~line 2750)
- Test: extend the supabase-adapter test file that covers `auditEvents` (locate with `grep -rln "audit_events" tests/`), plus harness coverage in Task 9

**Interfaces:**
- Consumes: `serviceClient()` (`src/lib/data/supabase/index.ts:298`) — already constructed for `listDue`/`consume_oauth_state`; F16 established this is a one-point change.
- Produces: every audit write goes through the service-role client; PostgREST with a user JWT can no longer insert trail rows.

- [ ] **Step 1: Write the migration**

```sql
-- Audit hardening (spec §6, closes F3).
--
-- The original audit_events_insert policy let any organization member append
-- any event type with actor_user_id null — i.e. forge events attributed to
-- system/AI actors. Requiring actor_user_id = auth.uid() would only stop
-- impersonation, not fabrication, so authenticated inserts are removed
-- entirely: audit rows are written exclusively by trusted server-side paths
-- (the service-role adapter method, and the execution RPC which runs as
-- security definer). Lands in the same change as the adapter switch — the
-- two are one behavior.
drop policy audit_events_insert on public.audit_events;
revoke insert on public.audit_events from authenticated;
```

- [ ] **Step 2: Switch the adapter** — in `auditEvents.record`, replace the request-scoped `client` with `serviceClient()` for the insert only (reads keep the user client and RLS). Add the load-bearing comment: the scope in hand has already passed `getOrganizationContext()`, this module is `server-only`, and the RLS change this pairs with removes the client-credentialed path entirely.
- [ ] **Step 3: Update/extend the adapter test** to pin that `record` uses the service client (the existing supabase adapter tests stub fetch/clients — follow their pattern for asserting which client received the insert).
- [ ] **Step 4: Validate** — `npm run db:validate`, full suite, tsc. All green.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): audit events are written only by trusted server-side paths"`

---

### Task 3: Location-scoping fixes (P0-4)

**Files:**
- Modify: `src/app/actions/escalations.ts` (`updateEscalationStatusAction`, ~line 20; `assignEscalationAction` is org-wide by permission matrix — only owner/admin/comms lead hold `escalation.assign` — leave it)
- Modify: `src/app/actions/responses.ts` (`assignResponseDraftAction`, ~line 20)
- Test: `tests/escalation-actions.test.ts`, `tests/response-actions.test.ts` (locate the existing files with `grep -rln "updateEscalationStatusAction\|assignResponseDraftAction" tests/` and extend)

**Interfaces:**
- Consumes: `assertPermissionForLocation(context, permission, locationId)` from `src/lib/actions/guard.ts:58` — the exact pattern `updateMentionStatusAction` uses (`src/app/actions/mentions.ts:30`). The record's location comes from its mention: `escalation → mention.locationId`, `responseDraft → mention.locationId` (both records carry `mentionId`).
- Produces: a `location_manager` can act only on records whose mention belongs to a location they manage; org-wide records (null location) are refused to them, per `canForLocation`'s documented contract.

- [ ] **Step 1: Write the failing tests** — for each action: a location manager of location A (seeded scope; follow the existing test file's context/fixture setup) is REFUSED (`forbidden`) on a record whose mention belongs to location B, and succeeds on their own location's record; an owner remains unrestricted. Use the same seeding approach the mention-status tests use for their cross-location case (find with `grep -n "location" tests/mention-actions.test.ts` or the file covering `updateMentionStatusAction`).
- [ ] **Step 2: RED** — run the two test files; the new cases fail (actions currently use plain `authorize`).
- [ ] **Step 3: Implement** — in each action, after loading the record: load its mention (`context.dataSource.mentions.get(context.scope, existing.mentionId)`), then replace `authorize(permission)` with `mutationContext()` + `assertPermissionForLocation(context, permission, mention?.locationId ?? null)` — mirroring `updateMentionStatusAction`'s structure exactly, including the not-found handling order (record first, then permission).
- [ ] **Step 4: GREEN** — both files, then full suite + tsc.
- [ ] **Step 5: Commit** — `git commit -m "fix(auth): location managers act only on their own locations' escalations and drafts"`

---

### Task 4: D158 in TypeScript — open-only dedupe, both paths

**Files:**
- Modify: `src/lib/data/demo/index.ts` (`escalationFor` ~line 362 — the single seam `raiseEscalation` and the execution unit share)
- Modify: `src/lib/rules/execute.ts` (dry-run `escalationExists` seeding, ~line 353 — currently `length > 0` over all escalations)
- Test: `tests/automation-execution-repository.test.ts` (the pinned `escalation_exists` tests), `tests/rules-execute.test.ts` (the resolved-escalation pairing test), the analysis test file covering escalation dedupe (locate with `grep -rln "created: false\|dedupe" tests/analysis*.test.ts tests/repositories.test.ts`)

**Interfaces:**
- Consumes: `isEscalationClosed` from `@/domain` (`CLOSED_ESCALATION_STATUSES = ["resolved","dismissed"]`).
- Produces: `escalationFor` returns only a mention's **open** escalation; `raiseEscalation` therefore creates a new escalation when every prior one is closed — for `escalations.create` (analysis path) and `executeUnit` (rules path) alike, and the dry-run projection matches.

- [ ] **Step 1: Write the failing tests (deliberate updates + new coverage)**

1. **Rule-driven re-escalation:** escalate a mention via `executeUnit`; resolve the escalation (`escalations.updateStatus` → `resolved` with a note); re-triage the mention to `monitoring` (`mentions.updateStatus`); call `executeUnit` with a **new** `triggerAnalysisId` and an escalate action → `applied`, a SECOND escalation row exists (total 2, one open), mention back to `escalated`.
2. **Same occurrence stays idempotent:** repeat the final call with the SAME `triggerAnalysisId` → replay, zero new effects (this already passes via the key; keep it beside the new test to state the safeguard).
3. **Open still blocks:** the existing `escalation_exists` test (mention at `monitoring` with an OPEN escalation) still pins `no_op`/`escalation_exists` — unchanged.
4. **Closed no longer blocks (the deliberate flip):** copy test 3's arrangement but resolve the escalation first → now `applied`, not `no_op`. This is the G0 pin being updated on purpose; say so in a comment referencing D158.
5. **Analysis-driven re-escalation:** through `escalations.create` directly (the analysis path's entry): create → `{created: true}`; create again → `{created: false}` (open blocks); resolve it; create again → `{created: true}` and a comment noting the crash-retry story survives because a just-created escalation is open.
6. **Dry-run fidelity:** in `tests/rules-execute.test.ts`, the "resolved ones included" pairing test flips meaning: a mention with only a RESOLVED escalation now projects `would_apply` and applies `applied` — update the test name and assertions to pin agreement in the new direction.

- [ ] **Step 2: RED** — the flipped cases fail against any-escalation dedupe.
- [ ] **Step 3: Implement** — `escalationFor` filters with `!isEscalationClosed(row.status)` (update its doc comment: D158, open-only, the partial index is the database statement of the same invariant); `execute.ts`'s seeding becomes `.some((row) => !isEscalationClosed(row.status))` (import from `@/domain`); no other code changes — the seam design from G0 means both paths flip together.
- [ ] **Step 4: GREEN** — all named files, then full suite + tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat(escalations): open-only dedupe — a resolved case no longer blocks re-escalation (D158)"`

---

### Task 5: D158 in Postgres — partial unique index + Supabase predicate

**Files:**
- Create: `supabase/migrations/20260812000300_escalations_open_only_dedupe.sql`
- Modify: `src/lib/data/supabase/index.ts` (`escalations.create` — find its dedupe read with `grep -n "escalations" src/lib/data/supabase/index.ts` and read the method)

**Interfaces:**
- Consumes: `CLOSED_ESCALATION_STATUSES` (the SQL restates the complement: open statuses `'open','in_progress','pending_approval'`).
- Produces: the schema guarantees at most one open escalation per mention; `escalations_one_open_per_mention` is the ON CONFLICT target Task 6's RPC uses.

- [ ] **Step 1: Write the migration**

```sql
-- D158: escalation dedupe is open-only, and the invariant lives in the
-- schema. At most one OPEN escalation per mention; resolved/dismissed rows
-- do not block a new one. The open-status list is the complement of
-- CLOSED_ESCALATION_STATUSES in src/domain/entities/escalation.ts — if a
-- status is ever added to either vocabulary, both statements must move
-- together.
--
-- Pre-flight: the index cannot build if any mention already carries two
-- open escalations. Today's application dedupe makes that impossible, but
-- assert rather than assume.
do $$
declare violating integer;
begin
  select count(*) into violating from (
    select mention_id from public.escalations
    where status in ('open', 'in_progress', 'pending_approval')
    group by mention_id having count(*) > 1
  ) dupes;
  if violating > 0 then
    raise exception
      'escalations_one_open_per_mention pre-flight: % mentions carry multiple open escalations', violating;
  end if;
end $$;

create unique index escalations_one_open_per_mention
  on public.escalations (mention_id)
  where status in ('open', 'in_progress', 'pending_approval');
```

- [ ] **Step 2: Update the Supabase adapter's `escalations.create`** — its dedupe read (currently any escalation for the mention) filters to open statuses: `.in("status", ["open", "in_progress", "pending_approval"])`, with a D158 comment. Keep the `{escalation, created}` contract identical.
- [ ] **Step 3: Validate** — `npm run db:validate`; full suite (demo behavior already flipped in Task 4, so nothing else moves); tsc.
- [ ] **Step 4: Commit** — `git commit -m "feat(db): at most one open escalation per mention, enforced by partial unique index (D158)"`

---

### Task 6: The transition matrix in SQL + generated parity file

**Files:**
- Create: `supabase/migrations/20260812000400_automation_transition_functions.sql`
- Create: `scripts/generate-matrix-parity-sql.ts`
- Create: `supabase/tests/matrix-parity.generated.sql` (generated, committed)
- Modify: `package.json` (script `matrix:parity:generate`)
- Test: `tests/matrix-parity-generated.test.ts`

**Interfaces:**
- Consumes: `decideSetStatus`/`decideEscalate` from `src/lib/rules/transitions.ts`; `MENTION_STATUSES`, `RISK_LEVELS` from `@/domain`.
- Produces: SQL functions the RPC calls — `automation_set_status_decision(p_current mention_status, p_target mention_status, p_risk risk_level) returns text` and `automation_escalate_decision(p_current mention_status) returns text`, each returning `'apply'`, `'no_op'`, or a blocked code (`'escalation_reserved'` / `'high_risk_guardrail'` / `'forbidden_transition'`) — collapsing decision kind and code into one text value keeps the SQL trivial and the parity file one assertion per cell. Plus the generated parity SQL the harness runs.

- [ ] **Step 1: Write the migration** — both functions `language sql immutable`, restating `transitions.ts` exactly:

```sql
-- The Phase 2 transition matrix, restated in SQL for the execution RPC.
-- src/lib/rules/transitions.ts is the source of truth; the generated file
-- supabase/tests/matrix-parity.generated.sql asserts every cell agrees.
create function public.automation_set_status_decision(
  p_current mention_status, p_target mention_status, p_risk risk_level
) returns text language sql immutable as $$
  select case
    when p_target = 'escalated' then 'escalation_reserved'
    when p_current = p_target then 'no_op'
    when p_current not in ('analyzed', 'monitoring') then 'forbidden_transition'
    when p_current = 'analyzed' and p_target = 'monitoring' then 'apply'
    when p_target in ('no_action_recommended', 'dismissed') then
      case when p_risk in ('high', 'critical')
        then 'high_risk_guardrail' else 'apply' end
    else 'forbidden_transition'
  end
$$;

create function public.automation_escalate_decision(
  p_current mention_status
) returns text language sql immutable as $$
  select case
    when p_current = 'escalated' then 'no_op'
    when p_current in ('analyzed', 'monitoring', 'no_action_recommended') then 'apply'
    else 'forbidden_transition'
  end
$$;

revoke execute on function public.automation_set_status_decision(mention_status, mention_status, risk_level) from public, anon, authenticated;
revoke execute on function public.automation_escalate_decision(mention_status) from public, anon, authenticated;
grant execute on function public.automation_set_status_decision(mention_status, mention_status, risk_level) to service_role;
grant execute on function public.automation_escalate_decision(mention_status) to service_role;
```

- [ ] **Step 2: Write the generator** (`scripts/generate-matrix-parity-sql.ts`, run via the same `node --experimental-strip-types --import ./scripts/tsconfig-paths-hook.mjs` harness as the seed generator; `@/` imports only, per project memory):

```ts
import { writeFileSync } from "node:fs";
import { MENTION_STATUSES, RISK_LEVELS } from "@/domain";
import { decideSetStatus, decideEscalate } from "@/lib/rules/transitions";

function verdict(d: ReturnType<typeof decideSetStatus>): string {
  return d.kind === "blocked" ? d.code : d.kind === "apply" ? "apply" : "no_op";
}

const lines: string[] = [
  "-- GENERATED by scripts/generate-matrix-parity-sql.ts — do not edit.",
  "-- Asserts the SQL matrix functions agree with src/lib/rules/transitions.ts",
  "-- on every (from, to, risk) cell and every escalate source.",
  "begin;",
];
for (const from of MENTION_STATUSES)
  for (const to of MENTION_STATUSES)
    for (const risk of RISK_LEVELS) {
      const expected = verdict(decideSetStatus(from, to, risk));
      lines.push(
        `select pg_temp.check('set_status ${from}->${to}@${risk}', ` +
        `public.automation_set_status_decision('${from}','${to}','${risk}') = '${expected}');`,
      );
    }
for (const from of MENTION_STATUSES) {
  const expected = verdict(decideEscalate(from));
  lines.push(
    `select pg_temp.check('escalate from ${from}', ` +
    `public.automation_escalate_decision('${from}') = '${expected}');`,
  );
}
lines.push("rollback;", "");
writeFileSync("supabase/tests/matrix-parity.generated.sql", lines.join("\n"));
console.log(`wrote ${MENTION_STATUSES.length ** 2 * RISK_LEVELS.length + MENTION_STATUSES.length} checks`);
```

(The `pg_temp.check` helper is defined by the harness file that includes this one — Task 9 — mirroring `rls-verification.sql`'s helper. If that file defines it inside its own transaction, Task 9 hoists the helper definition before both files' inclusion; resolve there, not here.)

- [ ] **Step 3: Wire and generate** — add `"matrix:parity:generate": "node --experimental-strip-types --no-warnings --import ./scripts/tsconfig-paths-hook.mjs scripts/generate-matrix-parity-sql.ts"` to package.json; run it; commit the generated file.
- [ ] **Step 4: Drift guard test** (`tests/matrix-parity-generated.test.ts`): regenerate the expected content in-memory using the same functions and assert the committed file equals it byte-for-byte — so editing `transitions.ts` without regenerating fails CI:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Recompute what the generator would emit (same loops, same format) and
// compare to the committed artifact.
```

Write the test by importing the generator's building blocks — extract the line-building into an exported `buildMatrixParityLines(): string[]` in the script file so the test and the CLI share one implementation (no duplicated loop).

- [ ] **Step 5: Validate** — `npm run db:validate`, focused test, full suite, tsc. Commit — `git commit -m "feat(db): transition matrix in SQL with generated parity assertions"`

---

### Task 7: The execution RPC

**Files:**
- Create: `supabase/migrations/20260812000500_execute_automation_rule_rpc.sql`

**Interfaces:**
- Consumes: Task 6's decision functions; Task 5's `escalations_one_open_per_mention` index; Task 1's audit vocabulary; the G0 tables/constraints (`execs_idempotent`, composite FKs).
- Produces: `public.execute_automation_rule(p_organization_id uuid, p_sweep_id uuid, p_rule_id uuid, p_revision integer, p_mention_id uuid, p_analysis_id uuid, p_actions jsonb) returns public.automation_rule_executions` — Task 8's adapter calls it via `.rpc(...)`.

- [ ] **Step 1: Write the migration.** The complete function (transcribe; comments are part of the deliverable):

```sql
-- The Phase 2 execution unit (spec §7): claim, validate, apply, record,
-- audit — one transaction. The demo adapter's executeUnit
-- (src/lib/data/demo/index.ts) is the pinned reference; the harness in
-- supabase/tests/execution-verification.sql asserts the semantics D148-D158
-- promise. Service-role only.
create function public.execute_automation_rule(
  p_organization_id uuid,
  p_sweep_id uuid,
  p_rule_id uuid,
  p_revision integer,
  p_mention_id uuid,
  p_analysis_id uuid,
  p_actions jsonb
) returns public.automation_rule_executions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exec public.automation_rule_executions;
  v_attempt integer;
  v_rule public.automation_rules;
  v_mention public.mentions;
  v_outcomes jsonb := '[]'::jsonb;
  v_applied integer := 0;
  v_blocked integer := 0;
  v_noop integer := 0;
  v_action jsonb;
  v_index integer := 0;
  v_type text;
  v_decision text;
  v_target mention_status;
  v_status mention_status;
  v_escalation_id uuid;
  v_row_status text;
begin
  -- CLAIM. The insert races on execs_idempotent; the loser of a concurrent
  -- claim blocks on the row lock below until the winner commits, then
  -- replays. location_id copies the mention's current location (the
  -- execs_location_is_mentions cascade keeps it following the mention).
  insert into public.automation_rule_executions
      (organization_id, sweep_id, automation_rule_id, rule_revision,
       mention_id, trigger_analysis_id, location_id, mode, status,
       error_class, last_error_code)
  select p_organization_id, p_sweep_id, p_rule_id, p_revision,
         p_mention_id, p_analysis_id, m.location_id, 'apply', 'failed',
         'retryable', 'claim_only'
    from public.mentions m
   where m.id = p_mention_id and m.organization_id = p_organization_id
  on conflict on constraint execs_idempotent do nothing;

  select * into v_exec from public.automation_rule_executions
   where automation_rule_id = p_rule_id and rule_revision = p_revision
     and mention_id = p_mention_id and trigger_analysis_id = p_analysis_id
     and mode = 'apply'
   for update;

  if v_exec is null then
    -- The mention did not exist in this organization: nothing was claimed.
    raise exception 'mention % not found in organization %',
      p_mention_id, p_organization_id using errcode = 'P0002';
  end if;

  -- REPLAY / RETRY GATE. Terminal rows return unchanged with zero effects.
  if v_exec.last_error_code is distinct from 'claim_only'
     or v_exec.completed_at is not null then
    if v_exec.status in ('applied', 'partial', 'blocked', 'no_op')
       or (v_exec.status = 'failed' and v_exec.error_class = 'terminal')
       or (v_exec.status = 'failed' and v_exec.attempt_count >= 3) then
      return v_exec;
    end if;
    v_attempt := v_exec.attempt_count + 1;   -- retryable failure under cap
  else
    v_attempt := 1;                          -- fresh claim
  end if;

  -- VALIDATE, before any business write.
  select * into v_rule from public.automation_rules
   where id = p_rule_id and organization_id = p_organization_id
   for share;
  if v_rule is null or v_rule.status <> 'active'
     or v_rule.archived_at is not null or v_rule.revision <> p_revision then
    update public.automation_rule_executions
       set status = 'failed', error_class = 'terminal',
           last_error_code = 'rule_changed', attempt_count = v_attempt,
           completed_at = now()
     where id = v_exec.id
     returning * into v_exec;
    return v_exec;
  end if;

  if jsonb_typeof(p_actions) is distinct from 'array' or (
    select bool_or(coalesce(a->>'type', '') not in
      ('generate_draft','auto_publish','require_approval','assign',
       'escalate','notify','tag','set_status'))
    from jsonb_array_elements(p_actions) a) then
    update public.automation_rule_executions
       set status = 'failed', error_class = 'terminal',
           last_error_code = 'invalid_action', attempt_count = v_attempt,
           completed_at = now()
     where id = v_exec.id
     returning * into v_exec;
    return v_exec;
  end if;

  select * into v_mention from public.mentions
   where id = p_mention_id and organization_id = p_organization_id
   for update;
  v_status := v_mention.status;

  -- APPLY, inside a subtransaction: any technical failure rolls back every
  -- business write while the claim row survives to record the failure.
  begin
    for v_action in select * from jsonb_array_elements(p_actions) loop
      v_type := v_action->>'type';

      if v_type = 'set_status' then
        v_target := (v_action->>'status')::mention_status;
        v_decision := public.automation_set_status_decision(
          v_status, v_target, v_mention.risk_level);
        if v_decision = 'apply' then
          update public.mentions set status = v_target, updated_at = now()
           where id = p_mention_id;
          v_status := v_target; v_applied := v_applied + 1;
          v_outcomes := v_outcomes || jsonb_build_object(
            'index', v_index, 'type', v_type, 'outcome', 'applied',
            'code', null);
        elsif v_decision = 'no_op' then
          v_noop := v_noop + 1;
          v_outcomes := v_outcomes || jsonb_build_object(
            'index', v_index, 'type', v_type, 'outcome', 'no_op',
            'code', null);
        else
          v_blocked := v_blocked + 1;
          v_outcomes := v_outcomes || jsonb_build_object(
            'index', v_index, 'type', v_type, 'outcome', 'blocked',
            'code', v_decision);
        end if;

      elsif v_type = 'escalate' then
        -- Eligibility first (matrix), then D158's open-only dedupe via the
        -- partial unique index, then the status write — all or nothing
        -- with the rest of the unit. assigneeUserId is dropped (D157).
        v_decision := public.automation_escalate_decision(v_status);
        if v_decision = 'apply' then
          insert into public.escalations
              (organization_id, mention_id, category, severity, status,
               title, summary, due_at)
          values (p_organization_id, p_mention_id, 'other',
                  v_mention.risk_level, 'open',
                  'Escalated by rule: ' || v_rule.name, null, null)
          on conflict (mention_id)
            where status in ('open', 'in_progress', 'pending_approval')
            do nothing
          returning id into v_escalation_id;
          if v_escalation_id is null then
            v_noop := v_noop + 1;
            v_outcomes := v_outcomes || jsonb_build_object(
              'index', v_index, 'type', v_type, 'outcome', 'no_op',
              'code', 'escalation_exists');
          else
            update public.mentions set status = 'escalated', updated_at = now()
             where id = p_mention_id;
            v_status := 'escalated'; v_applied := v_applied + 1;
            v_outcomes := v_outcomes || jsonb_build_object(
              'index', v_index, 'type', v_type, 'outcome', 'applied',
              'code', null);
          end if;
        elsif v_decision = 'no_op' then
          v_noop := v_noop + 1;
          v_outcomes := v_outcomes || jsonb_build_object(
            'index', v_index, 'type', v_type, 'outcome', 'no_op',
            'code', null);
        else
          v_blocked := v_blocked + 1;
          v_outcomes := v_outcomes || jsonb_build_object(
            'index', v_index, 'type', v_type, 'outcome', 'blocked',
            'code', v_decision);
        end if;

      else
        -- Authorable but not executable (D156): a configuration fact, not
        -- an error. Executable set = ACTION_CAPABILITIES' executable
        -- entries; if an action becomes executable there, this branch and
        -- that registry must move together.
        v_blocked := v_blocked + 1;
        v_outcomes := v_outcomes || jsonb_build_object(
          'index', v_index, 'type', v_type, 'outcome', 'blocked',
          'code', 'action_not_executable');
      end if;

      v_index := v_index + 1;
    end loop;

    -- RECORD + AUDIT, committing with the effects. Success clears the
    -- error fields (pinned parity with the demo twin).
    v_row_status := case
      when v_applied > 0 and v_blocked = 0 then 'applied'
      when v_applied > 0 then 'partial'
      when v_blocked > 0 then 'blocked'
      else 'no_op' end;

    update public.automation_rule_executions
       set status = v_row_status, outcomes = v_outcomes,
           attempt_count = v_attempt, error_class = null,
           last_error_code = null, completed_at = now()
     where id = v_exec.id
     returning * into v_exec;

    insert into public.audit_events
        (organization_id, actor_user_id, actor_type, event_type,
         entity_type, entity_id, previous_state, new_state, metadata)
    values (p_organization_id, null, 'system', 'automation_rule.executed',
            'automation_rule', p_rule_id, null, null,
            jsonb_build_object('sweepId', p_sweep_id,
              'mentionId', p_mention_id, 'status', v_row_status,
              'applied', v_applied, 'blocked', v_blocked, 'noOp', v_noop));
    return v_exec;

  exception when others then
    -- Whole-unit rollback: the subtransaction discards every business
    -- write above; the claim row survives to say the attempt failed. All
    -- caught failures classify retryable, matching the demo twin; the
    -- attempt cap bounds the retries.
    update public.automation_rule_executions
       set status = 'failed', error_class = 'retryable',
           last_error_code = left(coalesce(sqlstate, 'unknown'), 40),
           attempt_count = v_attempt, completed_at = now()
     where id = v_exec.id
     returning * into v_exec;

    insert into public.audit_events
        (organization_id, actor_user_id, actor_type, event_type,
         entity_type, entity_id, previous_state, new_state, metadata)
    values (p_organization_id, null, 'system',
            'automation_rule.execution_failed', 'automation_rule',
            p_rule_id, null, null,
            jsonb_build_object('sweepId', p_sweep_id,
              'mentionId', p_mention_id, 'sqlstate', sqlstate));
    return v_exec;
  end;
end $$;

revoke execute on function public.execute_automation_rule(uuid, uuid, uuid, integer, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.execute_automation_rule(uuid, uuid, uuid, integer, uuid, uuid, jsonb) to service_role;
```

Check the `escalations` table's actual column list before finalizing the insert (`grep -n -A20 "create table public.escalations" supabase/migrations/20260801000100_initial_schema.sql`) — match required columns exactly; if `title`/`summary` names differ, follow the schema. Same for `mention_status`/`risk_level` enum type names.

- [ ] **Step 2: Validate** — `npm run db:validate` PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(db): execute_automation_rule — the transactional execution unit in plpgsql"`

---

### Task 8: Supabase adapter goes real

**Files:**
- Modify: `src/lib/data/supabase/index.ts` (`automationSweeps.claim`/`finalize`, `automationRuleExecutions.executeUnit`/`recordProjection`, `automationRules.markActivity` — all currently throwing stubs)
- Modify: `src/lib/data/supabase/mappers.ts` (add `mapAutomationSweep` if absent)
- Test: extend the supabase adapter test file covering automation (locate with `grep -rln "automation" tests/ | grep -i supabase` — follow its stubbed-client pattern)

**Interfaces:**
- Consumes: Task 7's RPC; the sweeps partial unique index `automation_sweeps_one_running`; `serviceClient()`.
- Produces: the full `AutomationSweepRepository`/`AutomationRuleExecutionRepository`/`markActivity` contract against real Postgres. All five methods use `serviceClient()` — execution is a cron-context write path (D88); RLS grants authenticated no writes on these tables by design.

- [ ] **Step 1: Write the failing adapter tests** — following the existing supabase test pattern (stubbed fetch/client): `executeUnit` calls `.rpc("execute_automation_rule", {...})` with snake_case params mapped from `ExecuteUnitInput` and maps the returned row through `mapAutomationRuleExecution`; RPC error → `DataError` (translate through the adapter's existing error helper); `claim` inserts and, on unique-violation (code `23505` on `automation_sweeps_one_running`), reads the running sweep — fresh (< 30 min) → `{claimed: false}`, stale → update it `failed`/`lease_expired` then insert fresh and return `{claimed: true}`; `finalize` updates status/counters/completed_at; `recordProjection` inserts `on conflict do nothing` (via upsert with `ignoreDuplicates: true` or a second read when insert returns no row — follow whichever idiom the adapter already uses for insert-or-read) and returns the stored row; `markActivity` issues `update automation_rules set last_evaluated_at = greatest(coalesce(last_evaluated_at, 'epoch'::timestamptz), $at), …` — since PostgREST cannot express `greatest`, implement as a small SQL function in the same migration family (add `automation_mark_activity(p_rule_id uuid, p_org uuid, p_at timestamptz, p_matched boolean, p_applied boolean)` to Task 7's migration file while it is still unapplied, service-role-only like the RPC) and call it via `.rpc(...)`.
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN** + full suite + tsc + `npm run db:validate` (the migration gained `automation_mark_activity`).
- [ ] **Step 5: Commit** — `git commit -m "feat(data): supabase execution adapter — RPC-backed unit, sweep claims, monotonic activity"`

---

### Task 9: The database execution harness

**Files:**
- Create: `supabase/tests/execution-verification.sql`
- Modify: `package.json` (script `db:verify-execution`)

**Interfaces:**
- Consumes: everything above, applied by `supabase db reset`; the `pg_temp.check` helper idiom from `rls-verification.sql`; Task 6's generated parity file.
- Produces: the spec §11 DB suite, runnable as `npm run db:verify-execution` (which runs reset, then the RLS file, then this file, then the parity file — all under `ON_ERROR_STOP=1`).

- [ ] **Step 1: Write the harness.** Structure mirrors `rls-verification.sql` (fixtures temp table resolved by slug, `pg_temp.check(name, condition)` helper that raises on failure, numbered sections, `begin`/`rollback` around mutating sections). Sections, each with the concrete assertions:

1. **Audit hardening (DB-1):** as a seeded authenticated member (`set local role authenticated; set local request.jwt.claims ...` — copy the impersonation idiom from `rls-verification.sql`), `insert into audit_events ...` must fail (42501); as service role it succeeds; cross-org select still refused.
2. **Cross-org integrity (DB-2):** as service role, insert an execution mixing org A's rule with org B's mention → FK violation; same for sweep/org, analysis/mention, location/mention mismatches (four checks, each expecting the specific constraint name in the error).
3. **Location equality (DB-3):** an execution whose `location_id` differs from its mention's fails `execs_location_is_mentions`; updating the mention's `location_id` cascades into the stored execution row (insert, remap, re-read).
4. **Location-manager visibility (DB-4):** impersonate the seeded location manager: sees only rows whose `location_id` is their location; unlocated rows invisible; admin sees all; org-B manager sees none.
5. **Idempotency and occurrence (DB-5):** call `execute_automation_rule` twice with identical args → second call returns the same row, `attempt_count` unchanged, exactly one escalation/status write (assert row counts); insert a second `mention_analyses` row and call with the new id → new execution row, and with D158: after resolving the first escalation and re-triaging the mention, the new occurrence escalates again (assert two escalations, one open).
6. **Whole-unit rollback (DB-6):** create a constraint trigger on `public.escalations` that raises for a marker mention id; call the RPC with `[set_status monitoring, escalate]` on that mention → returned row `failed`/`retryable`, the mention's status is UNCHANGED (the earlier set_status rolled back), no escalation row; drop the trigger.
7. **Retry (DB-7):** after DB-6, call again (trigger dropped) → `applied`, `attempt_count = 2`, `error_class is null`, `last_error_code is null` (the success-clears pin). A terminal `rule_changed` row (bump the rule's revision, call with the old one) replays unchanged on a second call.
8. **Claim concurrency at the constraint (DB-8):** two inserts into `automation_sweeps` with `status='running'` for one org → second fails `automation_sweeps_one_running`; two RPC calls for the same unit serialized in one session → one applies, one replays (true two-session interleaving is exercised by the race script below).
9. **Matrix parity (DB-9):** `\i supabase/tests/matrix-parity.generated.sql` (324 set_status cells + 9 escalate sources).
10. **Reset gate (DB-10):** implicit — the script only runs after a clean `supabase db reset`.

Also create `scripts/execution-claim-race.sh`: launches two `psql` processes in parallel, each attempting the same organization's sweep claim inside a transaction with a `pg_sleep(1)` before commit; asserts afterwards exactly one `running` row exists. Wire it as the last step of `db:verify-execution`.

- [ ] **Step 2: Add the script** — `"db:verify-execution": "supabase db reset && psql \"$SUPABASE_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/tests/rls-verification.sql -f supabase/tests/execution-verification.sql && bash scripts/execution-claim-race.sh"`.
- [ ] **Step 3: Run it** (Docker required; `export SUPABASE_DB_URL` from `supabase status` per project memory). Iterate until green. This step is the plan's centerpiece verification — the RPC's semantics are only proven here.
- [ ] **Step 4: Commit** — `git commit -m "test(db): execution harness — hardening, integrity, idempotency, rollback, parity"`

---

### Task 10: Route-level apply-mode test + engine wiring check

**Files:**
- Test: `tests/rules-execution-route.test.ts` (extend)

**Interfaces:**
- Consumes: the G0 route (`executionEnabled` gating) and engine; nothing new to build — this closes the deferred "no route-level apply test" minor.

- [ ] **Step 1: Write the test** — mode `apply` + allowlisted org: `executeRules` is invoked with `mode: "apply"` (spy assertion on the argument), sweeps appear in the response, and mode `apply` + non-allowlisted org is skipped exactly as dry_run is. RED only if gating is broken — expected GREEN immediately; the test's value is pinning apply isn't accidentally gated differently (verify it fails if you flip `executionEnabled` to exclude apply — do that locally as the RED check, then revert).
- [ ] **Step 2: Full suite + tsc. Commit** — `git commit -m "test(cron): pin apply-mode gating parity with dry run"`

---

### Task 11: Docs, ledger, and the G1 runbook

**Files:**
- Modify: `docs/architecture/current-state.md` (decision rows D159+; gaps; the Q7/D158 interim-behavior note becomes "landed")
- Modify: `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md` (§11 G1 block marked implemented)

- [ ] **Step 1: Decision rows** — D159: the RPC's shape (claim-row + subtransaction, all-retryable classification matching the twin, success clears error fields — now proven in the harness, superseding the "parity delta" note); D160: matrix parity is generated, not hand-kept (the drift-guard test + generated SQL); D161: audit events are service-path-only (policy dropped; adapter switched; RPC writes its own). Update the D158 row's "lands as a G1 task" tail to "landed" with the migration version.
- [ ] **Step 2: Gaps** — G1 gaps section: apply is now REACHABLE for allowlisted orgs once migrations are pushed and mode is set; enumerate the operator runbook: (1) push migrations `20260812000100`–`000500` to hosted after `db:verify-execution` passes locally; (2) set `RULES_EXECUTION_MODE=dry_run` + internal org allowlist; watch a sweep; (3) flip to `apply`; reconcile the first live sweep's execution rows, escalation dedupe, and audit events by hand per the spec's acceptance criteria; (4) **watch item: false-positive re-escalation** (D158) — if resolved-then-retriaged mentions re-escalate noisily, that feedback gates any allowlist growth; (5) the cron response shape change note for any external monitoring.
- [ ] **Step 3: `npm run verify` green. Commit** — `git commit -m "docs: record G1 decisions and the internal-apply runbook"`

---

## Not in this plan

The hosted migration push and mode changes (operator runbook steps, deliberately human-executed); G2's overlapping-mutation-path RPCs and location-aware write policies; the `not_claimed` reason discriminator, engine observability, and the other ledgered G0 minors not named above; any new executor.
