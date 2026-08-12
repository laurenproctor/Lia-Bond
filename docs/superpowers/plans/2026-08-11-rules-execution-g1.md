# Rules execution G1 (internal apply gate) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Plan, v3. Revised twice after design review, before any implementation; v1 and
v2 are in git history. Implementation stays paused until v3 is approved.
Every SQL function this plan builds appears here in full — nothing is
incorporated by reference to an earlier version.

**Goal:** Build everything the spec's G1 gate requires — a database-enforced escalation contract with durable occurrence identity on every new escalation, the complete transactional execution RPC, atomic sweep claiming, audit hardening, location-scoping fixes, deterministic concurrency proofs, and the repository's first CI gate — so `apply` can be enabled for the internal organization.

**Architecture:** The analysis pipeline is restructured into a durable occurrence lifecycle: the `mention_analyses` row is written **first** and becomes the claimed occurrence; escalation and outcome application recover from it after a crash instead of re-classifying. One plpgsql function, `raise_escalation`, is the database-enforced sole creator of escalations (no role retains direct INSERT) — eligibility, open-only dedupe, occurrence idempotency, creation, and the mention transition are one atomic decision, and **every** new escalation carries a non-null occurrence identity with composite provenance to its mention and organization. `execute_automation_rule` executes only the stored rule revision, validated field-by-field for all eight action shapes before its apply subtransaction, and maps the contract's internal reasons into the pinned public outcome vocabulary. Sweep claiming is its own atomic RPC. CI runs the full database harness against freshly migrated Postgres.

**Tech Stack:** plpgsql migrations, Supabase JS service-role client, TypeScript strict, Vitest, psql-based database tests with lock-based deterministic races, GitHub Actions (new — the repo has no CI today).

**Spec:** `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`; decisions D148–D158. Governing principle: **Lia must recognize genuinely new risk without turning retries, concurrent workers, or stale configuration into duplicate actions — history informs future judgment, it never permanently suppresses it. If the database cannot identify the evidence occurrence, it cannot honestly enforce that distinction.**

## Resolved review points carried forward

- `escalations` has no pre-existing lifetime uniqueness constraint (verified against `20260801000100_initial_schema.sql:504-527`); the partial unique index fixes a live duplicate-row race.
- Task 12 creates the repository's first CI workflow; marking its database job a required check is an owner action recorded in the runbook.
- The shared eligibility ladder stands: `new` may escalate; `dismissed` is permanently refused; an open escalation deduplicates; an `escalated` mention with only closed cases requires human re-triage.
- The D162 audit contract as approved: execution audit events may contain identifiers, outcomes, operational status, SQLSTATE, and aggregate counts — never mention content or sensitive source text.

## Global Constraints

- **Occurrence identity is mandatory.** Every NEW escalation — analysis-driven and rule-driven — carries a non-null `trigger_analysis_id`; `raise_escalation` raises on a null occurrence. Null is legal only on historical rows predating the contract. The occurrence is durably persisted (the `mention_analyses` row) **before** any escalation can exist, and the same persisted occurrence is reused by crash recovery — never a fresh caller-generated id per retry.
- **Provenance is structural.** `escalations (trigger_analysis_id, mention_id, organization_id)` is a composite FK to `mention_analyses (id, mention_id, organization_id)` (the unique target `mention_analyses_id_mention_org` exists from G0), `on delete restrict` — the database rejects an analysis from another mention or organization, and refuses deletion that would erase occurrence-idempotency evidence.
- **`raise_escalation` is the sole creator by grant, not convention:** INSERT on `escalations` is revoked from `public`, `anon`, `authenticated`, **and** `service_role`; the `escalations_insert` policy is dropped; `service_role` holds only EXECUTE on the definer function. Low-level index tests run as the migration owner.
- Escalation return contract: `escalation_exists` → the currently open escalation; `occurrence_replayed` → the historical escalation that occurrence created, **regardless of its current status**; `awaiting_retriage` / `mention_dismissed` → no escalation.
- The pinned public execution outcome vocabulary is closed: `escalation_reserved`, `high_risk_guardrail`, `forbidden_transition`, `escalation_exists`, `action_not_executable`, `rule_changed`, `invalid_action`. Internal contract reasons map at the RPC boundary — `occurrence_replayed → escalation_exists` (no_op), `mention_dismissed → forbidden_transition` (blocked), `awaiting_retriage → forbidden_transition` (blocked) — defensively, even where unreachable behind the matrix, and the mapping is tested.
- The RPC takes no action payload; stored actions are validated completely (all eight shapes, §Task 8's table) before the apply subtransaction; recognized-but-malformed configuration is terminal `invalid_action` — never `action_not_executable`, never `retryable`. Unknown JSON fields inside a recognized action are ignored (Zod strip parity); an unknown `type` is `invalid_action`; an empty array is valid and derives `no_op`; null/non-array is `invalid_action`.
- RPC/twin parity pins (D148–D157) stand: five-part idempotency key with `mode`; terminal replay returns unchanged with zero effects; retry cap `attempt_count >= 3`; whole-unit rollback with surviving `failed` row; success clears `error_class`/`last_error_code`; `sweep_id`/`started_at` keep first-attempt values; `location_id` follows the mention; caught technical failures classify `retryable`.
- Function security, every function here: `security definer`, `set search_path = public, pg_temp`, `revoke execute … from public, anon, authenticated`, `grant … to service_role`.
- Migrations `20260812000100`–`20260812000600`, never amended after their task's commit. Nothing is applied to the hosted project by this plan.
- Fail closed on referenced records: load explicitly, `notFound` when absent; no optional chaining that can hide a missing record.
- Every commit leaves `npm run verify` green. TypeScript strict; sentence case in UI copy.
- Worktree notes (project memory): copy `next-env.d.ts` from the main checkout; `export SUPABASE_DB_URL` (quote-stripped) before harness scripts; node scripts resolve only `@/`-alias imports.

## Migration sequence (complete, in order)

| Version | Name | Contents | Task |
| --- | --- | --- | --- |
| 20260812000100 | `execution_audit_vocabulary` | Three audit event types | 1 |
| 20260812000200 | `audit_events_no_client_inserts` | Policy drop + revoke | 2 |
| 20260812000300 | `escalation_contract` | `mention_analyses.outcome_applied_at`; `escalations.trigger_analysis_id` + composite provenance FK; both partial unique indexes; INSERT revocation incl. `service_role`; `raise_escalation` | 4 |
| 20260812000400 | `automation_transition_functions` | Matrix decision functions | 7 |
| 20260812000500 | `execute_automation_rule_rpc` | The execution RPC | 8 |
| 20260812000600 | `automation_execution_support` | `claim_automation_sweep`, `automation_mark_activity` | 9 |

All six appear in the operator runbook (Task 13) as one ordered push.

## Semantic guarantee → test map

| Guarantee | Test(s) |
| --- | --- |
| Every new escalation carries a durable, pre-persisted occurrence id | Task 5 lifecycle tests; harness §5 (insert path); `raise_escalation` null-occurrence raise (harness §5) |
| Crash retry reuses the persisted occurrence; no duplicate escalation, no duplicate model call | Task 6 crash-matrix tests (provider-call spy); harness §5 occurrence replay |
| New occurrence only on intentional new analysis | Task 6 lifecycle tests (recovery does not re-classify); occurrence index |
| Analysis from another mention/org rejected; evidence deletion refused | Harness §3 composite-FK refusals + `on delete restrict` check |
| No role can insert escalations directly | Harness §1 (explicit identities incl. `service_role` refusal) |
| Dismissed mention permanently refused (both paths) | Task 5 scenario D; Task 6 pipeline test; harness §5 |
| Resolved + still-`escalated` → refused pending re-triage | Task 5 scenario A; Task 6 pipeline test; harness §5 |
| Re-triaged + replayed occurrence → no new escalation, historical row returned | Task 5 scenario B (closed-row return pinned); harness §5 |
| Re-triaged + new occurrence → new escalation | Task 5 scenario C; harness §5 |
| At most one open escalation per mention, under concurrency | Harness §2 (as migration owner); deterministic contract race (Task 11) |
| Concurrent identical units → one row, one escalation, exactly one status transition, one audit event, `attempt_count` 1, no error surfaced | Deterministic execution race with transition-recording trigger (Task 11) |
| Terminal replay → zero effects; retry increments; success clears errors | Twin tests (standing + Task 8 updates); harness §6/§7 |
| Whole-unit rollback with surviving failure record | Harness §6 |
| Caller cannot supply actions; stale revision refused | RPC signature; harness §5 (`rule_changed`) |
| All eight stored action shapes validated before effects | Task 8 twin tests (one malformed case per type + null/non-array/empty/unknown-type/bad-enum/missing-field); harness §8 |
| Internal reasons never leak into the public outcome vocabulary | Task 8 mapping tests; harness §5 asserts outcome codes |
| SQL matrix ≡ TypeScript matrix | Generated parity file (harness §9) + drift-guard vitest + CI database job |
| Sweep claim: active lease returned, single stale takeover, no double takeover | Task 9 fn; harness §7b; deterministic takeover race (Task 11) |
| Location manager blocked from null-location/cross-location/missing-mention records | Task 3 tests; harness §4 |
| No authenticated audit inserts; definer/service paths write | Harness §1 |

---

### Task 1: Audit vocabulary migration

**Files:** Create `supabase/migrations/20260812000100_execution_audit_vocabulary.sql`; modify the domain audit event-type list (find with `grep -rn "response.edited" src/domain`).

- [ ] **Step 1:** Migration follows the constraint-swap idiom of `20260807000700_audit_vocabulary_merge.sql`: drop `audit_events_known_event_type`, re-add with the previous list plus `automation_rule.executed`, `automation_rule.execution_failed`, `automation_sweep.completed`; comment names the feature and that nothing writes these until the RPC lands.
- [ ] **Step 2:** Add the three literals to the domain vocabulary; `npx tsc --noEmit`.
- [ ] **Step 3:** `npm run db:validate` + full suite green.
- [ ] **Step 4:** `git commit -m "feat(db): execution audit event vocabulary"`

---

### Task 2: Audit hardening — no authenticated audit inserts

**Files:** Create `supabase/migrations/20260812000200_audit_events_no_client_inserts.sql`; modify `src/lib/data/supabase/index.ts` (`auditEvents.record`, ~line 2750); extend the supabase adapter test covering `auditEvents`.

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

- [ ] **Step 2:** Switch `auditEvents.record`'s insert to `serviceClient()` (reads keep the user client), with the comment: scope already passed `getOrganizationContext()`; module is `server-only`; the paired RLS change removes the client-credentialed path.
- [ ] **Step 3:** Adapter test pins which client received the insert. Validate + suite + tsc.
- [ ] **Step 4:** `git commit -m "feat(auth): audit events are written only by trusted server-side paths"`

---

### Task 3: Location-scoping fixes (P0-4), fail-closed

**Files:** Modify `src/app/actions/escalations.ts` (`updateEscalationStatusAction`), `src/app/actions/responses.ts` (`assignResponseDraftAction`); extend their action test files.

- [ ] **Step 1: Failing tests**, four per action: (1) location manager of A refused (`forbidden`) on a record whose mention belongs to location B; (2) manager succeeds on their own location's record; (3) manager refused when the record's mention has `locationId: null`; (4) referenced mention missing (store surgery) → explicit `notFound("Mention")`. Plus one owner-unrestricted case.
- [ ] **Step 2:** RED. **Step 3:** Implement: load the record; `const mention = await context.dataSource.mentions.get(context.scope, existing.mentionId); if (!mention) throw notFound("Mention");` then `assertPermissionForLocation(context, permission, mention.locationId)` — the `updateMentionStatusAction` pattern (`src/app/actions/mentions.ts:30`), no optional chaining on the mention.
- [ ] **Step 4:** GREEN + full suite + tsc. **Step 5:** `git commit -m "fix(auth): location managers act only on their own locations' records, failing closed"`

---

### Task 4: The escalation contract migration

**Files:** Create `supabase/migrations/20260812000300_escalation_contract.sql`.

**Interfaces:**
- Produces: `mention_analyses.outcome_applied_at` (the occurrence lifecycle's completion marker, consumed by Task 6); `escalations.trigger_analysis_id` with composite provenance; both partial unique indexes; total INSERT revocation on `escalations`; and:

```sql
public.raise_escalation(
  p_organization_id uuid, p_mention_id uuid,
  p_category escalation_category, p_severity risk_level,
  p_title text, p_summary text, p_due_at timestamptz,
  p_trigger_analysis_id uuid   -- REQUIRED non-null; raises otherwise
) returns table (escalation_id uuid, created boolean, reason text)
```

- [ ] **Step 1: Write the migration** (complete; comments are part of the deliverable):

```sql
-- D158's shared escalation contract, database-enforced.
--
-- raise_escalation is the ONLY creator of escalation rows — by grant, not
-- convention: INSERT is revoked from every application role including
-- service_role, so eligibility, open-only dedupe, occurrence idempotency,
-- creation, and the mention's transition to 'escalated' cannot be bypassed.
--
-- Occurrence identity: every new escalation names the mention_analyses row
-- that authorized it. The analysis pipeline persists that row FIRST (the
-- durable occurrence claim) and recovers from it after a crash, so the same
-- logical work retries under the same id; a new id exists only when Lia
-- intentionally begins a new analysis. Null survives only on rows that
-- predate this migration.

-- The occurrence lifecycle's completion marker (see the analysis service):
-- null = effects (escalation + mention outcome) not yet applied; recovery
-- selects these and re-derives effects from the stored output instead of
-- re-classifying.
alter table public.mention_analyses
  add column outcome_applied_at timestamptz;
comment on column public.mention_analyses.outcome_applied_at is
  'When this occurrence''s effects (escalation decision + mention outcome) were applied. Null marks a pending occurrence: crash recovery re-picks it and reuses this row''s id rather than re-analyzing. Backfilled to created_at for rows predating the occurrence lifecycle.';
update public.mention_analyses
   set outcome_applied_at = created_at
 where outcome_applied_at is null;

alter table public.escalations
  add column trigger_analysis_id uuid;
comment on column public.escalations.trigger_analysis_id is
  'The analysis occurrence that authorized this escalation. Required non-null for every escalation created from this migration onward (raise_escalation raises on null); null only on historical rows. Composite FK proves the occurrence belongs to this escalation''s own mention and organization; on delete restrict preserves the idempotency evidence.';

-- Structural provenance: the occurrence must belong to the same mention and
-- organization (target unique mention_analyses_id_mention_org exists from
-- migration 20260811000100). MATCH SIMPLE skips historical null rows.
alter table public.escalations
  add constraint escalations_occurrence_same_mention
    foreign key (trigger_analysis_id, mention_id, organization_id)
    references public.mention_analyses (id, mention_id, organization_id)
    on delete restrict;

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
  v_found uuid;
begin
  if p_trigger_analysis_id is null then
    raise exception 'raise_escalation requires a non-null occurrence id'
      using errcode = '22004';
  end if;

  select * into v_mention from public.mentions
   where id = p_mention_id and organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'mention % not found in organization %',
      p_mention_id, p_organization_id using errcode = 'P0002';
  end if;

  -- Occurrence replay: this occurrence already produced an escalation.
  -- Return THAT row regardless of its current status — the historical
  -- record, not necessarily an open one.
  select id into v_found from public.escalations
   where trigger_analysis_id = p_trigger_analysis_id;
  if found then
    return query select v_found, false, 'occurrence_replayed'::text; return;
  end if;

  if v_mention.status = 'dismissed' then
    return query select null::uuid, false, 'mention_dismissed'::text; return;
  end if;

  -- Open case dedupe: return the currently open escalation.
  select id into v_found from public.escalations
   where mention_id = p_mention_id
     and status in ('open', 'in_progress', 'pending_approval');
  if found then
    return query select v_found, false, 'escalation_exists'::text; return;
  end if;

  if v_mention.status = 'escalated' then
    -- Only closed cases and no re-triage: history informs judgment, a
    -- human decision reopens the door. No escalation to return.
    return query select null::uuid, false, 'awaiting_retriage'::text; return;
  end if;

  insert into public.escalations
      (organization_id, mention_id, category, severity, status,
       title, summary, due_at, trigger_analysis_id)
  values (p_organization_id, p_mention_id, p_category, p_severity, 'open',
          p_title, p_summary, p_due_at, p_trigger_analysis_id)
  on conflict (mention_id)
    where status in ('open', 'in_progress', 'pending_approval')
    do nothing
  returning id into v_found;

  if v_found is null then
    -- A concurrent caller won the partial-index race after our read; their
    -- row is the dedupe result, not an error. (The FOR UPDATE mention lock
    -- makes this arm nearly unreachable — it is the constraint-level backstop.)
    select id into v_found from public.escalations
     where mention_id = p_mention_id
       and status in ('open', 'in_progress', 'pending_approval');
    return query select v_found, false, 'escalation_exists'::text; return;
  end if;

  update public.mentions set status = 'escalated', updated_at = now()
   where id = p_mention_id;
  return query select v_found, true, null::text;
end $$;

-- Sole creator by grant. The definer (migration owner) retains table
-- privileges; every application role loses INSERT, including service_role.
drop policy escalations_insert on public.escalations;
revoke insert on public.escalations from public, anon, authenticated, service_role;

revoke execute on function public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid) to service_role;
```

(Column names `title`/`summary`/`due_at` and enum types `escalation_category`/`risk_level` verified against `20260801000100_initial_schema.sql:504-527`.)

- [ ] **Step 2:** `npm run db:validate` PASS.
- [ ] **Step 3:** `git commit -m "feat(db): the escalation contract — occurrence-mandatory, provenance-proven, sole creator by grant"`

---

### Task 5: Contract mirror in TypeScript + scenario matrix

**Files:** Modify `src/domain/entities/escalation.ts` (`Escalation` + `CreateEscalationInput` gain `triggerAnalysisId`), `src/lib/data/types.ts` (`EscalationRepository.create` contract), `src/lib/data/demo/index.ts` (`raiseEscalation`/`escalationFor`), `src/lib/data/supabase/index.ts` (`escalations.create` → `.rpc("raise_escalation", …)`), `src/lib/data/supabase/mappers.ts`. Test: `tests/escalation-contract.test.ts` (new) + deliberate updates to G0-pinned dedupe tests.

**Interfaces:**
- Produces: `escalations.create(scope, input) → { escalation: Escalation | null, created: boolean, reason: "escalation_exists" | "occurrence_replayed" | "mention_dismissed" | "awaiting_retriage" | null }`. `CreateEscalationInput.triggerAnalysisId: uuidSchema` — **required, non-null** (the input schema refuses null; historical nulls exist only in stored rows, so `Escalation.triggerAnalysisId` is `uuidSchema.nullable()`). Return-row semantics per the Global Constraints contract: `escalation_exists` carries the open row; `occurrence_replayed` carries that occurrence's historical row whatever its status; the two hard refusals carry null.

- [ ] **Step 1: Failing tests** (`tests/escalation-contract.test.ts`, demo adapter):
  - **A.** Escalate (occurrence o1); resolve; mention still `escalated` → create(o2) → `{created:false, reason:"awaiting_retriage", escalation:null}`; row count 1.
  - **B.** Resolve; re-triage to `monitoring`; create with the SAME o1 → `{created:false, reason:"occurrence_replayed"}` and **the returned escalation is the resolved historical row** (status `resolved` — pin that the return is not filtered to open).
  - **C.** Re-triaged; NEW o2 → `{created:true}`; two rows, one open; mention `escalated`.
  - **D.** Dismiss the mention → `{created:false, reason:"mention_dismissed", escalation:null}` for any occurrence, forever.
  - Open blocks: with an open escalation, create(new occurrence o3) → `{created:false, reason:"escalation_exists"}` returning the OPEN row (not o3's — none exists).
  - Null occurrence refused: `createEscalationInputSchema.safeParse` with `triggerAnalysisId: null` fails (schema-level pin of the SQL function's raise).
  - The G0 `executeUnit` dedupe-test updates from v2 carry forward: closed-no-longer-blocks flip; the rules path's unreachability of the two hard refusals (matrix no-ops `escalated` / refuses `dismissed` before the contract is consulted) pinned in one test.
- [ ] **Step 2:** RED. **Step 3: Implement** — demo `raiseEscalation` becomes the exact SQL ladder (occurrence replay first, then dismissed, then open dedupe, then awaiting_retriage, then create+transition) with the same reason strings and return-row semantics; `escalationFor` splits into `openEscalationFor` (status-filtered) and `escalationForOccurrence` (by trigger id, any status); supabase `escalations.create` calls the RPC and re-reads the returned id (when non-null) for the `escalation` field; mappers carry `trigger_analysis_id`. `analyze.ts` compiles against the new input shape but its real changes land in Task 6 — if the compiler forces interim edits here, keep them minimal and note them for Task 6.
- [ ] **Step 4:** GREEN + full suite + tsc. **Step 5:** `git commit -m "feat(escalations): contract mirror — mandatory occurrence, precise return semantics (D158)"`

---

### Task 6: The analysis occurrence lifecycle

**Files:** Modify `src/lib/analysis/analyze.ts` (reordered writes + recovery), `src/lib/data/types.ts` (`MentionRepository`: `listUnanalyzed`/`countUnanalyzed` semantics widen; new `markAnalysisOutcomeApplied(scope, analysisId)`; `CreateMentionAnalysisInput` unchanged — the row is created pending), both adapters. Test: `tests/analysis-run.test.ts` (lifecycle + crash matrix + pipeline scenarios).

**The lifecycle (replaces the G0 write order deliberately — this is the reviewed change):**

1. **Claim the occurrence:** classify (model or heuristic), then `createAnalysis` immediately — the `mention_analyses` row IS the durable occurrence, persisted before any effect, with `outcome_applied_at` null (pending).
2. **Effects from the occurrence:** if the stored output requires escalation, `escalations.create({ …, triggerAnalysisId: analysis.id })` — occurrence-idempotent by the unique index; then `applyAnalysisOutcome` (status `escalated`/`analyzed` — idempotent write).
3. **Complete:** `markAnalysisOutcomeApplied(scope, analysis.id)` sets `outcome_applied_at`.
4. **Selection** (`listUnanalyzed`, renamed in doc comment to "needing analysis work"): mentions with **no analysis row OR whose latest analysis row has `outcome_applied_at` null**. Recovery therefore re-picks a crashed mention, finds the pending row, **skips classification entirely** (no second model call), and re-runs steps 2–3 from the stored output under the SAME occurrence id.
5. **New occurrence** = a deliberate new `createAnalysis` (today: only first analysis; tomorrow: a re-analysis surface) — never a retry.

Crash behavior at every boundary: before step 1 → nothing durable, nothing happened, a re-run is a fresh (first) occurrence with no duplicate risk because no effect exists to duplicate; between 1 and 2 → re-picked pending, escalation raised once under the stored id; between escalation and outcome application → `occurrence_replayed` absorbs, outcome applies; between 2 and 3 → both effects idempotent (`occurrence_replayed`; same-status write), completion stamps. Recovery re-derives the escalation input from the stored row; `escalationTitle` is not a stored column, so recovery uses `derivedTitle` — an accepted, documented cosmetic difference on the rare recovery path.

- [ ] **Step 1: Failing tests:**
  1. **First escalation carries the occurrence:** high-risk `new` mention → escalation row's `triggerAnalysisId` equals the created analysis id; mention `escalated`; analysis `outcome_applied_at` set.
  2. **Crash between claim and effects** (inject: `escalations.create` throws once): re-run `analyzeMentions` → provider spy shows **one** model call total; same analysis id produced the eventual escalation; exactly one escalation; run counts report the mention once per run honestly.
  3. **Crash between escalation and completion** (inject: `markAnalysisOutcomeApplied` throws once): re-run → `occurrence_replayed` absorbed silently (`created:false`), one escalation, one `escalation.created_from_analysis` audit event total, completion stamped.
  4. **Dismissed mention:** classified critical → no escalation (`mention_dismissed`), run completes, mention still `dismissed`, occurrence completed (the decision "refused" is itself the applied outcome).
  5. **Escalated mention with only closed cases** (store surgery: pending analysis on an `escalated` mention with a resolved escalation) → recovery run refuses (`awaiting_retriage`), no new escalation, occurrence completes.
  6. **Counts:** `countUnanalyzed` includes pending-outcome mentions; a completed mention leaves the queue.
- [ ] **Step 2:** RED. **Step 3: Implement** — restructure `analyzeOne` per the lifecycle; rewrite the old write-order comment to document the occurrence lifecycle and its crash matrix (the old comment's reasoning is superseded, say so explicitly); adapters implement the widened selection and `markAnalysisOutcomeApplied` (demo: array scan; supabase: update by id + scope). `escalation.created_from_analysis` audit fires only on `created: true` (unchanged shape).
- [ ] **Step 4:** GREEN + full suite + tsc. **Step 5:** `git commit -m "feat(analysis): durable occurrence lifecycle — claim, effect, complete, recover"`

---

### Task 7: Transition matrix in SQL + generated parity file

**Files:** Create `supabase/migrations/20260812000400_automation_transition_functions.sql`, `scripts/generate-matrix-parity-sql.ts` (exporting `buildMatrixParityLines(): string[]`), `supabase/tests/matrix-parity.generated.sql` (committed); modify `package.json` (`matrix:parity:generate`). Test: `tests/matrix-parity-generated.test.ts`.

- [ ] **Step 1: Write the migration** (complete):

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

- [ ] **Step 2: Generator** — `buildMatrixParityLines()` iterates `MENTION_STATUSES × MENTION_STATUSES × RISK_LEVELS` (324 set_status checks) plus the 9 escalate sources, emitting one `select pg_temp.check('set_status <from>-><to>@<risk>', public.automation_set_status_decision('<from>','<to>','<risk>') = '<expected>');` per cell, where `<expected>` maps `{kind:"blocked"}` to its code, `apply`→`'apply'`, `no_op`→`'no_op'`; wrapped in `begin;`/`rollback;`. CLI writes `supabase/tests/matrix-parity.generated.sql`; wire `"matrix:parity:generate"` with the strip-types + paths-hook invocation the seed generator uses.
- [ ] **Step 3: Drift guard** — `tests/matrix-parity-generated.test.ts` asserts the committed file equals `buildMatrixParityLines().join("\n") + "\n"` byte-for-byte.
- [ ] **Step 4:** Generate, `npm run db:validate`, focused + full suite. **Step 5:** `git commit -m "feat(db): transition matrix in SQL with generated parity assertions"`

---

### Task 8: The execution RPC — complete, stored-actions only

**Files:** Create `supabase/migrations/20260812000500_execute_automation_rule_rpc.sql`; modify `src/lib/data/types.ts` (`ExecuteUnitInput` loses `actions`), `src/lib/rules/execute.ts` (call sites), `src/lib/data/demo/index.ts` (twin loads stored actions; validation extended per the table; reason mapping). Test: `tests/automation-execution-repository.test.ts`.

**Stored action validation table** (transcribed from `ruleActionSchema`, `src/domain/entities/automation.ts:97-120` — verified 2026-08-11). Policy for all: unknown extra fields ignored (Zod strip parity); a missing required field, wrong type, or out-of-vocabulary enum value → terminal `invalid_action`; `type` outside the eight → `invalid_action`; executability is a SEPARATE, later judgment (`action_not_executable` outcome for valid-but-unwired actions):

| Type | Required fields | Types / accepted values | Null handling | Executable (G1) |
| --- | --- | --- | --- | --- |
| `generate_draft` | `voiceProfile` | string ≤ 80 or null | nullable | No → `action_not_executable` |
| `auto_publish` | — (type only) | — | — | No → `action_not_executable` |
| `require_approval` | `approverUserId` | uuid or null | nullable | No → `action_not_executable` |
| `assign` | `assigneeUserId` | uuid or null | nullable | No → `action_not_executable` |
| `escalate` | `assigneeUserId` | uuid or null (always dropped, D157) | nullable | Yes |
| `notify` | `channel` | `'email'`,`'in_app'`,`'both'` | not null | No → `action_not_executable` |
| `tag` | `label` | string, 1–80 chars | not null | No → `action_not_executable` |
| `set_status` | `status` | one of `mention_status`'s values, checked as text before casting | not null | Yes |

- [ ] **Step 1: Failing twin tests** — one malformed case per type (e.g. `generate_draft` with `voiceProfile: 42`; `notify` with `channel: "sms"`; `tag` with empty `label`; `set_status` with `status: "sideways"`; `require_approval` missing `approverUserId`; …), plus null actions, non-array actions, empty array (→ `no_op`, empty outcomes, zero effects), unknown type — every malformed case: terminal `invalid_action`, mention untouched, `errorClass: "terminal"`. Mapping tests: force the contract's `occurrence_replayed` through the twin's escalate arm (re-triage + replay the unit under a new revision so the unit key differs but the occurrence collides) → outcome `no_op` code `escalation_exists`; assert `mention_dismissed`/`awaiting_retriage` map to `blocked`/`forbidden_transition` by driving the twin's mapper function directly (exported for the test).
- [ ] **Step 2:** RED. **Step 3:** Update the twin: `ExecuteUnitInput` = `{sweepId, automationRuleId, ruleRevision, mentionId, triggerAnalysisId}`; actions load from the stored rule post-revision-check; validation per the table (reuse `ruleActionSchema.safeParse` per element — Zod IS the table in TypeScript); escalate flows through the Task 5 mirror with the boundary mapping `occurrence_replayed→escalation_exists (no_op)`, `mention_dismissed→forbidden_transition (blocked)`, `awaiting_retriage→forbidden_transition (blocked)`.
- [ ] **Step 4: Write the RPC migration** (complete — this is the whole function):

```sql
-- The Phase 2 execution unit (spec §7): claim, validate, apply, record,
-- audit — one transaction. The demo adapter's executeUnit is the pinned
-- reference twin; supabase/tests/execution-verification.sql proves the
-- semantics D148–D158 promise. Service-role only. Executes ONLY the stored
-- rule revision: callers name a unit, they never define one.
create function public.execute_automation_rule(
  p_organization_id uuid,
  p_sweep_id uuid,
  p_rule_id uuid,
  p_revision integer,
  p_mention_id uuid,
  p_analysis_id uuid
) returns public.automation_rule_executions
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_exec public.automation_rule_executions;
  v_rule public.automation_rules;
  v_mention public.mentions;
  v_attempt integer;
  v_actions jsonb;
  v_action jsonb;
  v_index integer := 0;
  v_type text;
  v_decision text;
  v_status mention_status;
  v_outcomes jsonb := '[]'::jsonb;
  v_applied integer := 0;
  v_blocked integer := 0;
  v_noop integer := 0;
  v_valid boolean;
  v_esc record;
  v_row_status text;
begin
  ------------------------------------------------------------------
  -- CLAIM. Insert races on execs_idempotent; a concurrent caller blocks
  -- on the FOR UPDATE below until the winner commits, then replays.
  -- location_id copies the mention's current location (the schema cascade
  -- keeps it following the mention thereafter).
  ------------------------------------------------------------------
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
  if not found then
    raise exception 'mention % not found in organization %',
      p_mention_id, p_organization_id using errcode = 'P0002';
  end if;

  ------------------------------------------------------------------
  -- REPLAY / RETRY GATE. Terminal rows return unchanged, zero effects.
  -- A retryable failure under the cap re-runs as attempt N+1; the row's
  -- sweep_id and started_at keep their first-attempt values (the claim
  -- insert above no-ops on conflict, never updates).
  ------------------------------------------------------------------
  if v_exec.last_error_code is distinct from 'claim_only'
     or v_exec.completed_at is not null then
    if v_exec.status in ('applied', 'partial', 'blocked', 'no_op')
       or (v_exec.status = 'failed' and v_exec.error_class = 'terminal')
       or (v_exec.status = 'failed' and v_exec.attempt_count >= 3) then
      return v_exec;
    end if;
    v_attempt := v_exec.attempt_count + 1;
  else
    v_attempt := 1;
  end if;

  ------------------------------------------------------------------
  -- VALIDATE — before the apply subtransaction; nothing here mutates.
  ------------------------------------------------------------------
  select * into v_rule from public.automation_rules
   where id = p_rule_id and organization_id = p_organization_id
   for share;
  if not found or v_rule.status <> 'active'
     or v_rule.archived_at is not null or v_rule.revision <> p_revision then
    update public.automation_rule_executions
       set status = 'failed', error_class = 'terminal',
           last_error_code = 'rule_changed', attempt_count = v_attempt,
           completed_at = now()
     where id = v_exec.id returning * into v_exec;
    return v_exec;
  end if;

  v_actions := v_rule.actions;
  -- Complete stored-shape validation (see the plan's action table; unknown
  -- extra fields are ignored for Zod-strip parity). Any failure below is
  -- terminal invalid_action: malformed configuration, never a retry.
  v_valid := jsonb_typeof(v_actions) = 'array';
  if v_valid then
    select coalesce(bool_and(
      case a->>'type'
        when 'generate_draft' then
          a ? 'voiceProfile' and (jsonb_typeof(a->'voiceProfile') = 'null'
            or (jsonb_typeof(a->'voiceProfile') = 'string'
                and length(a->>'voiceProfile') <= 80))
        when 'auto_publish' then true
        when 'require_approval' then
          a ? 'approverUserId' and (jsonb_typeof(a->'approverUserId') = 'null'
            or (a->>'approverUserId') ~ '^[0-9a-f-]{36}$')
        when 'assign' then
          a ? 'assigneeUserId' and (jsonb_typeof(a->'assigneeUserId') = 'null'
            or (a->>'assigneeUserId') ~ '^[0-9a-f-]{36}$')
        when 'escalate' then
          a ? 'assigneeUserId' and (jsonb_typeof(a->'assigneeUserId') = 'null'
            or (a->>'assigneeUserId') ~ '^[0-9a-f-]{36}$')
        when 'notify' then
          jsonb_typeof(a->'channel') = 'string'
          and a->>'channel' in ('email', 'in_app', 'both')
        when 'tag' then
          jsonb_typeof(a->'label') = 'string'
          and length(a->>'label') between 1 and 80
        when 'set_status' then
          jsonb_typeof(a->'status') = 'string'
          and (a->>'status') = any (enum_range(null::mention_status)::text[])
        else false  -- unknown type
      end), true)
    into v_valid
    from jsonb_array_elements(v_actions) a;
  end if;
  if not v_valid then
    update public.automation_rule_executions
       set status = 'failed', error_class = 'terminal',
           last_error_code = 'invalid_action', attempt_count = v_attempt,
           completed_at = now()
     where id = v_exec.id returning * into v_exec;
    return v_exec;
  end if;

  select * into v_mention from public.mentions
   where id = p_mention_id and organization_id = p_organization_id
   for update;
  v_status := v_mention.status;

  ------------------------------------------------------------------
  -- APPLY, inside a subtransaction (this begin/exception block): any
  -- technical failure rolls back every statement inside it — mention
  -- writes, escalations, the success update, the success audit row —
  -- while the claim row from the outer scope survives to record the
  -- failure. Policy refusals are outcomes, not exceptions; they commit.
  ------------------------------------------------------------------
  begin
    for v_action in select * from jsonb_array_elements(v_actions) loop
      v_type := v_action->>'type';

      if v_type = 'set_status' then
        v_decision := public.automation_set_status_decision(
          v_status, (v_action->>'status')::mention_status,
          v_mention.risk_level);
        if v_decision = 'apply' then
          update public.mentions
             set status = (v_action->>'status')::mention_status,
                 updated_at = now()
           where id = p_mention_id;
          v_status := (v_action->>'status')::mention_status;
          v_applied := v_applied + 1;
          v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
            'type', v_type, 'outcome', 'applied', 'code', null);
        elsif v_decision = 'no_op' then
          v_noop := v_noop + 1;
          v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
            'type', v_type, 'outcome', 'no_op', 'code', null);
        else
          v_blocked := v_blocked + 1;
          v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
            'type', v_type, 'outcome', 'blocked', 'code', v_decision);
        end if;

      elsif v_type = 'escalate' then
        v_decision := public.automation_escalate_decision(v_status);
        if v_decision = 'apply' then
          select * into v_esc from public.raise_escalation(
            p_organization_id, p_mention_id, 'other',
            v_mention.risk_level, 'Escalated by rule: ' || v_rule.name,
            null, null, p_analysis_id);
          if v_esc.created then
            v_status := 'escalated';  -- the contract moved the mention
            v_applied := v_applied + 1;
            v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
              'type', v_type, 'outcome', 'applied', 'code', null);
          elsif v_esc.reason in ('escalation_exists', 'occurrence_replayed') then
            -- Boundary mapping: internal reasons stay internal; the pinned
            -- public vocabulary says escalation_exists for both.
            v_noop := v_noop + 1;
            v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
              'type', v_type, 'outcome', 'no_op', 'code', 'escalation_exists');
          else
            -- mention_dismissed / awaiting_retriage: unreachable behind the
            -- matrix today, mapped defensively so a future matrix change
            -- cannot mint a new public outcome by accident.
            v_blocked := v_blocked + 1;
            v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
              'type', v_type, 'outcome', 'blocked',
              'code', 'forbidden_transition');
          end if;
        elsif v_decision = 'no_op' then
          v_noop := v_noop + 1;
          v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
            'type', v_type, 'outcome', 'no_op', 'code', null);
        else
          v_blocked := v_blocked + 1;
          v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
            'type', v_type, 'outcome', 'blocked', 'code', v_decision);
        end if;

      else
        -- Valid shape, not executable (D156): configuration fact, not error.
        v_blocked := v_blocked + 1;
        v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
          'type', v_type, 'outcome', 'blocked',
          'code', 'action_not_executable');
      end if;

      v_index := v_index + 1;
    end loop;

    -- RECORD + AUDIT — inside the subtransaction so they commit with the
    -- effects. Success clears the error fields (pinned twin parity). The
    -- empty-actions case falls through to no_op with empty outcomes.
    v_row_status := case
      when v_applied > 0 and v_blocked = 0 then 'applied'
      when v_applied > 0 then 'partial'
      when v_blocked > 0 then 'blocked'
      else 'no_op' end;

    update public.automation_rule_executions
       set status = v_row_status, outcomes = v_outcomes,
           attempt_count = v_attempt, error_class = null,
           last_error_code = null, completed_at = now()
     where id = v_exec.id returning * into v_exec;

    -- Audit contract (D162): identifiers, outcomes, status, counts — never
    -- mention content.
    insert into public.audit_events
        (organization_id, actor_user_id, actor_type, event_type,
         entity_type, entity_id, previous_state, new_state, metadata)
    values (p_organization_id, null, 'system', 'automation_rule.executed',
            'automation_rule', p_rule_id, null, null,
            jsonb_build_object('sweepId', p_sweep_id, 'mentionId',
              p_mention_id, 'analysisId', p_analysis_id,
              'status', v_row_status, 'applied', v_applied,
              'blocked', v_blocked, 'noOp', v_noop));
    return v_exec;

  exception when others then
    -- Whole-unit rollback happened above (subtransaction). The claim row
    -- survives; finalize it as a retryable failure (twin parity: all
    -- caught technical failures are retryable; the cap bounds them), and
    -- record the failure event — identifiers and SQLSTATE only (D162).
    update public.automation_rule_executions
       set status = 'failed', error_class = 'retryable',
           last_error_code = left(coalesce(sqlstate, 'unknown'), 40),
           attempt_count = v_attempt, completed_at = now()
     where id = v_exec.id returning * into v_exec;
    insert into public.audit_events
        (organization_id, actor_user_id, actor_type, event_type,
         entity_type, entity_id, previous_state, new_state, metadata)
    values (p_organization_id, null, 'system',
            'automation_rule.execution_failed', 'automation_rule',
            p_rule_id, null, null,
            jsonb_build_object('sweepId', p_sweep_id, 'mentionId',
              p_mention_id, 'analysisId', p_analysis_id,
              'sqlstate', sqlstate));
    return v_exec;
  end;
end $$;

revoke execute on function public.execute_automation_rule(uuid, uuid, uuid, integer, uuid, uuid) from public, anon, authenticated;
grant execute on function public.execute_automation_rule(uuid, uuid, uuid, integer, uuid, uuid) to service_role;
```

- [ ] **Step 5:** `npm run db:validate`; full suite + tsc green (the twin and type changes from Steps 1–3 are already in). **Step 6:** `git commit -m "feat(db): execute_automation_rule — complete transactional unit over the stored revision"`

---

### Task 9: Atomic sweep claim + activity support

**Files:** Create `supabase/migrations/20260812000600_automation_execution_support.sql`.

- [ ] **Step 1: Write the migration** (complete):

```sql
-- Sweep claiming as one atomic decision: the existing running row is
-- locked FOR UPDATE, so exactly one caller performs a stale takeover; the
-- loser blocks, re-reads, and receives the winner's claim as a normal
-- (sweep, claimed=false) outcome. automation_sweeps_one_running remains
-- the constraint-level backstop; only ITS violation is absorbed — any
-- other unique violation re-raises.
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

  if found then
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
    if (select conname from pg_constraint
         where conname = 'automation_sweeps_one_running') is null then
      raise;  -- defensive: index dropped/renamed would make this wrong
    end if;
    -- Only the one-running index can collide here (it is the sole unique
    -- surface this insert touches); a racer inserted between our empty
    -- lock read and this insert. Their claim is the answer.
    select * into v_running from public.automation_sweeps s
     where s.organization_id = p_organization_id and s.status = 'running';
    return query select v_running, false; return;
  end;
  return query select v_new, true;
end $$;

-- Monotonic activity stamps (D154): greatest() is not expressible through
-- PostgREST. Never moves a timestamp backwards; matched/applied advance
-- only when their flag says so.
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

(Note the `found` variable — not a composite-null test — after both the initial SELECT and inside the handler; the pg_constraint guard makes the absorbed violation provably the intended one.)

- [ ] **Step 2:** `npm run db:validate`. **Step 3:** `git commit -m "feat(db): atomic sweep claiming and monotonic activity stamps"`

---

### Task 10: Supabase adapter goes real

**Files:** Modify `src/lib/data/supabase/index.ts` (five stubs), `src/lib/data/supabase/mappers.ts` (`mapAutomationSweep` if absent). Test: the supabase adapter automation test file (stubbed-client pattern).

- [ ] **Step 1: Failing tests** — `executeUnit` → `.rpc("execute_automation_rule", {p_organization_id, p_sweep_id, p_rule_id, p_revision, p_mention_id, p_analysis_id})` mapped through `mapAutomationRuleExecution`, errors translated to `DataError` (never raw postgrest); `claim` → `.rpc("claim_automation_sweep", …)` → `{sweep, claimed}`; `finalize` → status/counters/completed_at update; `recordProjection` → insert with `ignoreDuplicates` + read-back of the STORED row; `markActivity` → `.rpc("automation_mark_activity", …)`. All via `serviceClient()` (cron-context path, D88).
- [ ] **Step 2:** RED. **Step 3:** Implement. **Step 4:** GREEN + full suite + tsc + `npm run db:validate`. **Step 5:** `git commit -m "feat(data): supabase execution adapter — RPC-backed units, atomic claims, monotonic activity"`

---

### Task 11: Database harness + deterministic concurrency proofs

**Files:** Create `supabase/tests/execution-verification.sql`, `scripts/execution-race-test.sh`; modify `package.json` (`db:verify-execution`).

- [ ] **Step 1: Write the harness** (`pg_temp.check` idiom; fixtures by slug; mutating sections in `begin`/`rollback`; **every role switch explicit** — `set role` / JWT-claims impersonation for `authenticated`, `set role service_role`, `reset role` for the migration owner):
  1. **Audit + escalation insert identities:** authenticated insert into `audit_events` → 42501; authenticated, **service_role**, and anon inserts into `escalations` → all refused (sole-creator-by-grant); a definer-path write via `execute_automation_rule` lands exactly one `automation_rule.executed` event; a direct service-role `audit_events` insert succeeds; cross-org audit READ refused as an authenticated member of the other org (service role never used for read-refusal tests — it bypasses RLS by design).
  2. **Escalation invariants as migration owner** (`reset role` — the owner retains table privileges; application roles cannot even run these inserts): two open escalations for one mention → `escalations_one_open_per_mention`; two rows with one `trigger_analysis_id` → `escalations_one_per_occurrence`.
  3. **Provenance (composite FK):** as owner — escalation citing an analysis of a DIFFERENT mention → `escalations_occurrence_same_mention`; another organization's analysis → same refusal; deleting a `mention_analyses` row cited by an escalation → restricted; plus the four G0 execution-table cross-org refusals and the mention-relocation cascade re-check.
  4. **Location-manager visibility:** manager sees only their location's execution rows; null-location rows invisible to managers, visible to admins; org-B manager sees none.
  5. **Contract scenario matrix through the functions:** `raise_escalation` with null occurrence → raises 22004; resolved + still-`escalated` → `awaiting_retriage`, no row; re-triaged + replayed occurrence → `occurrence_replayed` returning the RESOLVED historical row's id; re-triaged + new `mention_analyses` row → created (two escalations, one open); dismissed → `mention_dismissed` always; `execute_automation_rule` replay of a terminal unit → same row id, `attempt_count` unchanged, escalation/status/audit counts unchanged; outcome codes asserted to stay within the pinned public vocabulary.
  6. **Whole-unit rollback:** constraint trigger on `escalations` raising for a marker mention; RPC on a rule with stored `[set_status monitoring, escalate]` → row `failed`/`retryable`, mention status unchanged, no escalation, no `automation_rule.executed` event (the success audit rolled back with the unit; the `execution_failed` event exists); drop the trigger.
  7. **Retry + claim states:** re-call after dropping the trigger → `applied`, `attempt_count = 2`, error fields null; `rule_changed` terminal replay; **7b:** `claim_automation_sweep` — active lease returns `claimed=false` with the same sweep id; a backdated (35-minute-old) running sweep is taken over exactly once (old row `failed`/`lease_expired`, new row `running`); finalize between checks so each case starts clean.
  8. **Stored-actions validation:** as owner, corrupt a rule's `actions` (non-array; unknown type; `notify` channel `'sms'`; `set_status` status `'sideways'`; `tag` empty label; missing `approverUserId`) → each: terminal `invalid_action`, mention untouched.
  9. **Matrix parity:** the generated file runs via the script chain.
- [ ] **Step 2: Write the deterministic race script** (`scripts/execution-race-test.sh`). Mechanics — lock-based determinism, not timing hope: session A opens a transaction, executes the contested call, and **holds the transaction open** on a named-pipe handshake (`psql` reading a FIFO) while session B issues the same call; B provably blocks on A's row/index lock (`FOR UPDATE` or the unique-index insert wait); the script confirms B is blocked (`pg_stat_activity` `wait_event_type = 'Lock'` poll), releases A, then asserts. Three races:
  1. **Sweep claim, empty state:** both call `claim_automation_sweep` → exactly one `running` row; outputs show exactly one `claimed=true`; neither errored.
  2. **Stale takeover:** seed a 35-minute-old running sweep; both call → exactly one takeover (one `failed`/`lease_expired` old row, one new `running` row, one `claimed=true`); neither errored.
  3. **Execution unit:** a test-only trigger (created by the script, dropped after) records qualifying mention-status transitions into a scratch table; both sessions call `execute_automation_rule` with identical args → both outputs carry the SAME execution id; one execution row; one escalation; **exactly one recorded transition to `escalated`** (the trigger table, not the audit count, proves it); exactly one `automation_rule.executed` event; `attempt_count = 1`; neither session received an error.
- [ ] **Step 3:** Wire `"db:verify-execution": "supabase db reset && psql \"$SUPABASE_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/tests/rls-verification.sql -f supabase/tests/execution-verification.sql -f supabase/tests/matrix-parity.generated.sql && bash scripts/execution-race-test.sh"` (hoist the `pg_temp.check` helper so all included files share it).
- [ ] **Step 4: Run it** (Docker; `SUPABASE_DB_URL` exported quote-stripped). Iterate until green — this proves the RPC and the contract.
- [ ] **Step 5:** `git commit -m "test(db): execution harness — contract matrix, rollback, deterministic races"`

---

### Task 12: CI gate

**Files:** Create `.github/workflows/verify.yml`.

- [ ] **Step 1:** Confirm the default branch: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` (expected `master`; use whatever it prints). Pin the Supabase CLI to the version the harness was developed against: run `supabase --version` locally and pin that exact version in the workflow.
- [ ] **Step 2: Write the workflow**

```yaml
name: verify
on:
  pull_request:
  push:
    branches: [master]   # confirmed via gh in Step 1; adjust if it differs
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
        with: { version: "<pin from Step 1, e.g. 2.30.4>" }
      - run: npm ci
      - run: supabase start
      - name: Run the database harness against freshly migrated Postgres
        run: |
          export SUPABASE_DB_URL="$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')"
          npm run db:verify-execution
```

(The `tr -d '\"'` strips the quotes `supabase status -o env` emits; `db:verify-execution` begins with `supabase db reset`, so the harness always runs against freshly migrated Postgres.)

- [ ] **Step 3:** Push a branch; confirm both jobs pass on GitHub (verified on the forge, not locally). The runbook records: an owner must mark `database` a required status check so a TypeScript matrix change can never merge with stale SQL behavior.
- [ ] **Step 4:** `git commit -m "ci: verify + database harness as merge gates"`

---

### Task 13: Docs, ledger, and the internal-apply runbook

**Files:** Modify `docs/architecture/current-state.md`, `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`.

- [ ] **Step 1: Decision rows** — D159: the escalation contract (sole creator by grant including the service-role INSERT revocation; the eligibility ladder; mandatory occurrence identity with composite provenance and `on delete restrict`; the precise return contract; the governing principle sentence). D160: the analysis occurrence lifecycle (analysis row persisted first as the durable claim; recovery re-derives effects from stored output without re-classifying; `outcome_applied_at` as the completion marker; the superseded G0 write order and why the change is safe). D161: the RPC executes only the stored revision; complete eight-shape validation before the subtransaction; internal reasons mapped into the pinned public vocabulary at the boundary. D162: the audit contract as approved. D163: atomic sweep claiming. D164: CI as the parity gate. Update D158's tail to "landed", with migration versions.
- [ ] **Step 2: Runbook** — the six-migration push sequence (the table verbatim); owner action: mark `database` required; `dry_run` + internal allowlist → watch → `apply`; first-live-sweep reconciliation; the false-positive re-escalation watch item; the cron response-shape note for external monitoring.
- [ ] **Step 3:** Spec §11 G1 block marked implemented per line; the spec's Q7 resolution note gains the occurrence-lifecycle addendum (analysis path now carries real occurrence ids — the earlier "null today" interim statement is superseded).
- [ ] **Step 4:** `npm run verify` green. **Step 5:** `git commit -m "docs: record G1 decisions and the internal-apply runbook"`

---

## Not in this plan

The hosted migration push and mode changes (runbook, human-executed); marking the CI check required (owner action, in the runbook); G2's overlapping-mutation-path RPCs and location-aware write policies; ledgered G0 minors not named above; any new executor. A future re-analysis surface plugs into the occurrence lifecycle as designed — it creates a new pending `mention_analyses` row deliberately and inherits idempotency, provenance, and recovery with no contract change.
