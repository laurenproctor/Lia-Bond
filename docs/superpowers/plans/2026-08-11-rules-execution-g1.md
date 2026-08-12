# Rules execution G1 (internal apply gate) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Plan, v4. Revised three times after design review, before any implementation;
v1–v3 are in git history. Implementation stays paused until v4 is approved.
Every SQL function appears here in full. The durable occurrence architecture,
Q1, Q2, and the carried-forward decisions are settled and not reopened here;
v4 makes the localized corrections review round 3 required.

**Goal:** Build everything the spec's G1 gate requires — the occurrence lifecycle made concurrency-safe, escalation + its audit event atomic in one transaction, null-safe stored-action validation, the corrected sweep collision handler, composite provenance validated before occurrence replay, precise origin/attempt sweep semantics, and bounded deterministic races — so `apply` can be enabled for the internal organization on proofs, not appearances.

**Architecture (settled):** The `mention_analyses` row is the durable analysis occurrence, persisted before escalation effects; recovery reuses stored output. New in v4: occurrence recording is insert-or-load behind a one-pending-per-mention partial unique index (`record_analysis_occurrence`), and the entire effect step — eligibility, escalation creation, mention transition, occurrence completion, and the escalation audit event — is one transaction (`apply_analysis_occurrence`, which calls `raise_escalation` internally). `raise_escalation` remains the database-enforced sole creator, now validating composite occurrence provenance before any replay lookup. `execute_automation_rule` executes only the stored revision with null-safe validation of all eight action shapes. Sweep claiming absorbs exactly its own index collision via `GET STACKED DIAGNOSTICS`.

**Tech Stack:** plpgsql migrations, Supabase JS service-role client, TypeScript strict, Vitest, psql-based deterministic races with bounded timeouts, GitHub Actions (pinned CLI, freshly migrated Postgres).

**Spec:** `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`; decisions D148–D158. Governing principle: **the database must make it impossible for concurrent, malformed, or cross-tenant inputs to produce a false operational history.**

## Approved and not reopened (carried forward)

Durable occurrence persisted before escalation effects; recovery from stored classification output; composite occurrence provenance; `raise_escalation` as sole creator by grant; open-escalation and occurrence-level dedupe; whole-unit rollback via plpgsql subtransaction; stored-revision execution only; deterministic concurrency testing; pinned CLI + freshly migrated verification; Q1/Q2; and the four round-2 resolutions (no pre-existing lifetime uniqueness on `escalations`; first-ever CI with owner-marked required check; the eligibility ladder including legal `new`; the D162 audit contract).

## Global Constraints

- **Occurrence claim semantics (v4 precision).** `mention_analyses`' classification columns are `not null` (verified: `20260801000100_initial_schema.sql:386-411`), so a pre-classification pending row cannot exist in that table. The design is therefore insert-or-load: a partial unique index (`mention_analyses_one_pending`, one pending occurrence per mention) plus the `record_analysis_occurrence` RPC guarantee **one durable occurrence and one applied outcome per logical analysis event** — a concurrent recorder receives the existing pending row and discards its own output. **This prevents duplicate occurrence rows, not duplicate model calls.** Duplicate model calls are bounded by the pre-existing per-organization analysis run lock (`analysisRuns.start` refuses a second concurrent run — application-level); the guarantee map states exactly this, no more.
- **Escalation effects are atomic with their audit event.** `apply_analysis_occurrence` performs eligibility, escalation creation, mention transition, occurrence completion, and the `escalation.created_from_analysis` audit insert in ONE transaction. No application code writes that event. Replay after success returns without effects and without a second event.
- Occurrence identity is mandatory (`raise_escalation` raises on null); null survives only on historical rows. **Composite provenance is validated before replay:** the supplied `(trigger_analysis_id, mention_id, organization_id)` triple must name a real analysis of that same mention in that same organization, or the call raises — no foreign escalation id or outcome information is ever returned.
- **Dismissed mentions, precisely:** every previously **unused** occurrence is refused (`mention_dismissed`); a previously **consumed** occurrence still returns `occurrence_replayed` with its historical escalation; replay never creates an escalation and never changes the dismissed state. (The ladder's order — replay before the dismissed check — is load-bearing and tested.)
- Escalation return contract: `escalation_exists` → the currently open escalation; `occurrence_replayed` → that occurrence's historical escalation regardless of status; `awaiting_retriage`/`mention_dismissed` → no escalation.
- The pinned public outcome vocabulary is closed; internal reasons map at the RPC boundary (`occurrence_replayed → escalation_exists` as no_op; `mention_dismissed`/`awaiting_retriage → forbidden_transition` as blocked), defensively and tested.
- **Sweep provenance naming:** an execution row's `sweep_id` column is its **originSweepId** — the sweep that created the execution identity; the sweep performing the current attempt is the **attemptSweepId**. Audit metadata, RPC results, logs, and tests use these names; bare "sweepId" is not used anywhere new.
- Stored-action validation is **null-safe** (`coalesce(..., false)` around the array check and every per-action case — PostgreSQL aggregates ignore nulls, so an unguarded missing field would pass), covers all eight shapes per §Task 8's table, runs before the apply subtransaction, and lands as terminal `invalid_action`. UUID fields validate via a guarded-cast helper (`pg_temp`-free `automation_is_uuid`), whose semantics are the Postgres uuid parser — the operative equivalence, since the values land in uuid columns. Unknown extra fields inside a recognized action are ignored (Zod strip parity); `auto_publish` is structurally valid with no fields and any extra fields are ignored; unknown `type` → `invalid_action`; empty array → `no_op`; null/non-array → `invalid_action`.
- Sweep claim absorbs ONLY a violation whose `GET STACKED DIAGNOSTICS … CONSTRAINT_NAME` equals `automation_sweeps_one_running` (a partial unique **index** is not in `pg_constraint`; diagnostics report it regardless); every other unique violation re-raises.
- **Race tests are bounded and self-cleaning:** every psql session sets `statement_timeout`/`lock_timeout` (10s), the script wraps rounds in an overall timeout, and a bash `trap` closes FIFOs, rolls back held transactions, and drops test-only triggers on any exit path — a failed assertion cannot hang CI or leak open transactions.
- RPC/twin parity pins (D148–D157) stand: five-part idempotency key with `mode`; terminal replay unchanged with zero effects; retry cap `attempt_count >= 3`; whole-unit rollback with surviving `failed` row; success clears `error_class`/`last_error_code`; origin sweep and `started_at` keep first-attempt values; `location_id` follows the mention; caught technical failures classify `retryable`.
- Function security, every function: `security definer`, `set search_path = public, pg_temp`, revoke from `public, anon, authenticated`, grant to `service_role`. `escalations` INSERT revoked from all four roles incl. `service_role`; `escalations_insert` policy dropped; owner-level index tests run as the migration owner.
- Migrations `20260812000100`–`20260812000600`, never amended after commit; nothing applied to the hosted project by this plan. Fail closed on referenced records. Every commit leaves `npm run verify` green. Worktree notes: `next-env.d.ts` copy; quote-stripped `SUPABASE_DB_URL`; `@/`-alias imports in node scripts.

## Migration sequence (complete, in order)

| Version | Name | Contents | Task |
| --- | --- | --- | --- |
| 20260812000100 | `execution_audit_vocabulary` | Three audit event types | 1 |
| 20260812000200 | `audit_events_no_client_inserts` | Policy drop + revoke | 2 |
| 20260812000300 | `escalation_contract` | `outcome_applied_at`; `mention_analyses_one_pending` index; `trigger_analysis_id` + composite provenance FK; both escalation partial uniques; INSERT revocation incl. `service_role`; `automation_is_uuid`; `raise_escalation`; `record_analysis_occurrence`; `apply_analysis_occurrence` | 4 |
| 20260812000400 | `automation_transition_functions` | Matrix decision functions | 7 |
| 20260812000500 | `execute_automation_rule_rpc` | The execution RPC | 8 |
| 20260812000600 | `automation_execution_support` | `claim_automation_sweep`, `automation_mark_activity` | 9 |

## Semantic guarantee → test map

| Guarantee | Test(s) |
| --- | --- |
| One durable occurrence and one applied outcome per logical analysis event (duplicate occurrence rows impossible; duplicate model calls bounded by the per-org run lock, not by this index) | Deterministic concurrent-recording race (Task 11 race 4); `mention_analyses_one_pending` owner test (harness §2); Task 6 lifecycle tests |
| A crashed occurrence recovers under the same id; no orphaned pending rows; deliberate reanalysis mints a new occurrence without colliding with completed ones | Task 6 crash-matrix tests; harness §5 (pending re-pick; completed + new insert) |
| Escalation, mention transition, occurrence completion, and the created audit event commit together or not at all; retry yields exactly one escalation and one event | Harness §6b (audit-insert failure injection via trigger → full rollback → retry) |
| Every new escalation carries a durable pre-persisted occurrence id | `raise_escalation` null raise (harness §5); Task 5 schema pin |
| Supplied occurrence must belong to the named mention and organization; no foreign escalation data returned | Harness §5b (cross-mention and cross-org replay attempts raise); Task 5 mirror tests |
| Dismissed mention: unused occurrences refused; consumed occurrence replays its historical row; replay never mutates | Task 5 scenarios D/D2; harness §5 |
| Resolved + still-`escalated` → `awaiting_retriage`; re-triaged + replay → historical row; re-triaged + new occurrence → new escalation | Task 5 scenarios A/B/C; harness §5 |
| At most one open escalation per mention, under concurrency | Harness §2 (owner); deterministic contract race (Task 11 race 3, via the RPC) |
| No role can insert escalations directly (incl. service_role) | Harness §1 |
| Concurrent identical units → same execution id, one row, one escalation, exactly one recorded status transition, one executed event, `attempt_count` 1, neither caller errored | Task 11 race 3 with transition-recording trigger |
| Sweep claim: active lease returned; single stale takeover; double takeover impossible; unrelated unique violations re-raise | Harness §7b; Task 11 races 1–2; harness §7c (re-raise) |
| All eight stored shapes validated null-safely before effects, through the real RPC | Harness §8 (every fielded type malformed + auto_publish extra-fields case); Task 8 twin tests |
| Internal reasons never leak into the public vocabulary | Task 8 mapping tests; harness §5 outcome-code assertions |
| Terminal replay zero effects; retry increments; success clears errors; origin sweep/`started_at` preserved with originSweepId/attemptSweepId recorded distinctly | Harness §6/§7; twin tests; audit-metadata assertions (harness §5) |
| SQL matrix ≡ TypeScript matrix | Generated parity file (harness §9) + drift-guard vitest + CI database job |
| Location manager blocked from null-location/cross-location/missing-mention records | Task 3 tests; harness §4 |
| No authenticated audit inserts; definer/service paths write; cross-org reads refused as authenticated | Harness §1 |

---

### Task 1: Audit vocabulary migration

**Files:** Create `supabase/migrations/20260812000100_execution_audit_vocabulary.sql`; modify the domain audit event-type list (find with `grep -rn "response.edited" src/domain`).

- [ ] **Step 1:** Constraint-swap idiom (per `20260807000700_audit_vocabulary_merge.sql`): re-add `audit_events_known_event_type` with the prior list plus `automation_rule.executed`, `automation_rule.execution_failed`, `automation_sweep.completed`.
- [ ] **Step 2:** Add the literals to the domain vocabulary; `npx tsc --noEmit`.
- [ ] **Step 3:** `npm run db:validate` + full suite. **Step 4:** `git commit -m "feat(db): execution audit event vocabulary"`

---

### Task 2: Audit hardening — no authenticated audit inserts

**Files:** Create `supabase/migrations/20260812000200_audit_events_no_client_inserts.sql`; modify `src/lib/data/supabase/index.ts` (`auditEvents.record`); extend the supabase adapter audit test.

- [ ] **Step 1:** Migration: `drop policy audit_events_insert on public.audit_events; revoke insert on public.audit_events from authenticated;` with the F3 rationale comment (fabrication, not just impersonation).
- [ ] **Step 2:** `auditEvents.record` inserts via `serviceClient()`; reads keep the user client; comment the trust argument (scope already validated; `server-only`; RLS change removes the client-credentialed path).
- [ ] **Step 3:** Test pins which client received the insert. Validate + suite + tsc. **Step 4:** `git commit -m "feat(auth): audit events are written only by trusted server-side paths"`

---

### Task 3: Location-scoping fixes (P0-4), fail-closed

**Files:** Modify `src/app/actions/escalations.ts` (`updateEscalationStatusAction`), `src/app/actions/responses.ts` (`assignResponseDraftAction`); extend their test files.

- [ ] **Step 1:** Failing tests, four per action: cross-location refusal; own-location success; null-location refusal for managers; missing mention → `notFound("Mention")`. Owner unrestricted.
- [ ] **Step 2:** RED. **Step 3:** Load record → load mention explicitly (`if (!mention) throw notFound("Mention")`) → `assertPermissionForLocation(context, permission, mention.locationId)`, per `src/app/actions/mentions.ts:30`; no optional chaining.
- [ ] **Step 4:** GREEN + suite + tsc. **Step 5:** `git commit -m "fix(auth): location managers act only on their own locations' records, failing closed"`

---

### Task 4: The escalation contract migration

**Files:** Create `supabase/migrations/20260812000300_escalation_contract.sql`.

**Interfaces produced:** `mention_analyses.outcome_applied_at`; `mention_analyses_one_pending`; `escalations.trigger_analysis_id` + `escalations_occurrence_same_mention`; `escalations_one_open_per_mention`; `escalations_one_per_occurrence`; `automation_is_uuid(text)`; and three functions consumed by Tasks 5/6/8:

```sql
public.raise_escalation(p_organization_id uuid, p_mention_id uuid,
  p_category escalation_category, p_severity risk_level, p_title text,
  p_summary text, p_due_at timestamptz, p_trigger_analysis_id uuid,
  p_audit_event_type text)          -- null = no event (rule path; the
                                    -- unit's own executed event records it)
  returns table (escalation_id uuid, created boolean, reason text)

public.record_analysis_occurrence(p_organization_id uuid, p_mention_id uuid,
  /* one parameter per mention_analyses classification column — transcribe
     the exact list and types from 20260801000100_initial_schema.sql:386-411
     plus analysis_run_id and prompt_version */ ...)
  returns table (analysis public.mention_analyses, created boolean)

public.apply_analysis_occurrence(p_organization_id uuid, p_mention_id uuid,
  p_analysis_id uuid, p_should_escalate boolean,
  p_category escalation_category, p_severity risk_level, p_title text,
  p_summary text, p_mention_status mention_status, p_sentiment sentiment,
  p_risk_level risk_level, p_relevance_score numeric)
  returns table (escalation_id uuid, escalation_created boolean,
                 reason text, already_applied boolean)
```

- [ ] **Step 1: Write the migration.** Complete SQL for the schema objects and `raise_escalation`; the two lifecycle functions follow the specified bodies:

```sql
-- D158's shared escalation contract, database-enforced, with the durable
-- occurrence lifecycle's SQL half. raise_escalation is the ONLY creator of
-- escalation rows — by grant: INSERT is revoked from every application
-- role including service_role.

alter table public.mention_analyses
  add column outcome_applied_at timestamptz;
comment on column public.mention_analyses.outcome_applied_at is
  'When this occurrence''s effects (escalation decision + mention outcome) were applied, set only by apply_analysis_occurrence. Null marks a pending occurrence: recovery re-picks it and reuses this row''s id and stored output rather than re-analyzing. Backfilled to created_at for rows predating the lifecycle.';
update public.mention_analyses
   set outcome_applied_at = created_at where outcome_applied_at is null;

-- One pending occurrence per mention: a concurrent recorder loads the
-- existing pending row instead of minting a second occurrence for the same
-- logical event. This bounds occurrence ROWS; duplicate model calls are
-- bounded by the per-organization analysis run lock at the application
-- layer, and the plan claims no more than that.
create unique index mention_analyses_one_pending
  on public.mention_analyses (mention_id)
  where outcome_applied_at is null;

alter table public.escalations add column trigger_analysis_id uuid;
comment on column public.escalations.trigger_analysis_id is
  'The analysis occurrence that authorized this escalation. Required non-null for every escalation created from this migration onward; null only on historical rows. Composite FK proves the occurrence belongs to this escalation''s own mention and organization; on delete restrict preserves the idempotency evidence.';

alter table public.escalations
  add constraint escalations_occurrence_same_mention
    foreign key (trigger_analysis_id, mention_id, organization_id)
    references public.mention_analyses (id, mention_id, organization_id)
    on delete restrict;

do $$  -- pre-flight for the one-open index (assert, never grandfather)
declare violating integer;
begin
  select count(*) into violating from (
    select mention_id from public.escalations
    where status in ('open', 'in_progress', 'pending_approval')
    group by mention_id having count(*) > 1) dupes;
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

-- Guarded-cast uuid check. Semantics = the Postgres uuid parser — the
-- operative equivalence, since these values land in uuid columns.
create function public.automation_is_uuid(p_value text)
returns boolean language plpgsql immutable as $$
begin
  perform p_value::uuid; return true;
exception when invalid_text_representation then return false;
end $$;

create function public.raise_escalation(
  p_organization_id uuid, p_mention_id uuid,
  p_category escalation_category, p_severity risk_level,
  p_title text, p_summary text, p_due_at timestamptz,
  p_trigger_analysis_id uuid, p_audit_event_type text
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

  -- Composite provenance BEFORE any replay lookup: the supplied occurrence
  -- must be an analysis of THIS mention in THIS organization. A mismatch
  -- raises — it never returns foreign escalation ids or outcome data.
  perform 1 from public.mention_analyses
   where id = p_trigger_analysis_id and mention_id = p_mention_id
     and organization_id = p_organization_id;
  if not found then
    raise exception 'occurrence % does not belong to mention % in organization %',
      p_trigger_analysis_id, p_mention_id, p_organization_id
      using errcode = '23503';
  end if;

  -- Occurrence replay (provenance now proven): return THAT escalation
  -- regardless of its current status. Order is load-bearing: replay wins
  -- even over a dismissed mention — a consumed occurrence reports its
  -- history and never mutates state.
  select id into v_found from public.escalations
   where trigger_analysis_id = p_trigger_analysis_id
     and mention_id = p_mention_id and organization_id = p_organization_id;
  if found then
    return query select v_found, false, 'occurrence_replayed'::text; return;
  end if;

  if v_mention.status = 'dismissed' then
    return query select null::uuid, false, 'mention_dismissed'::text; return;
  end if;

  select id into v_found from public.escalations
   where mention_id = p_mention_id
     and status in ('open', 'in_progress', 'pending_approval');
  if found then
    return query select v_found, false, 'escalation_exists'::text; return;
  end if;

  if v_mention.status = 'escalated' then
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
    select id into v_found from public.escalations
     where mention_id = p_mention_id
       and status in ('open', 'in_progress', 'pending_approval');
    return query select v_found, false, 'escalation_exists'::text; return;
  end if;

  update public.mentions set status = 'escalated', updated_at = now()
   where id = p_mention_id;

  -- The created-audit event commits WITH the creation (review round 3,
  -- item 2): no application code writes it, so no crash can separate an
  -- escalation from its trail. Null event type = the caller's own audit
  -- covers it (the execution RPC's executed event).
  if p_audit_event_type is not null then
    insert into public.audit_events
        (organization_id, actor_user_id, actor_type, event_type,
         entity_type, entity_id, previous_state, new_state, metadata)
    values (p_organization_id, null, 'ai', p_audit_event_type,
            'escalation', v_found, null,
            jsonb_build_object('category', p_category::text,
                               'severity', p_severity::text),
            jsonb_build_object('mentionId', p_mention_id,
                               'analysisId', p_trigger_analysis_id));
  end if;

  return query select v_found, true, null::text;
end $$;
```

  `record_analysis_occurrence` (same migration): parameters mirror `mention_analyses`' classification columns exactly (transcribe names/types from `20260801000100_initial_schema.sql:386-411` plus `analysis_run_id`, `prompt_version`); body: `insert into public.mention_analyses (...) values (...) on conflict (mention_id) where outcome_applied_at is null do nothing returning *` into a local; when the insert returned a row → `(row, true)`; when null → select the pending row for the mention and return `(row, false)` — the concurrent recorder's result. (No pending row AND conflict is impossible: the only conflict surface is the one-pending index.)

  `apply_analysis_occurrence` (same migration): lock the analysis row (`select * … where id = p_analysis_id and mention_id = p_mention_id and organization_id = p_organization_id for update`; not found → raise P0002); if `outcome_applied_at is not null` → return `(null, false, null, already_applied := true)` with zero effects (idempotent replay); else: when `p_should_escalate` call `raise_escalation(…, p_analysis_id, 'escalation.created_from_analysis')` and capture its triple; update the mention's analysis outcome (`sentiment`, `risk_level`, `relevance_score`, and `status := p_mention_status` — but when the escalation call reported `created` or `escalation_exists`, status is already/becomes `escalated`; pass the final status the caller computed, mirroring `applyAnalysisOutcome`'s contract); stamp `outcome_applied_at = now()`; return the escalation triple + `already_applied := false`. Everything in the function body is one transaction: a failure anywhere (including the audit insert inside `raise_escalation`) rolls back the escalation, the transition, and the completion together, leaving the pending occurrence recoverable.

  Close the migration with the grants block: drop `escalations_insert`; `revoke insert on public.escalations from public, anon, authenticated, service_role;`; revoke/grant execute for all four functions (`automation_is_uuid` may stay executable by `service_role` only, like the rest).

- [ ] **Step 2:** `npm run db:validate` PASS. **Step 3:** `git commit -m "feat(db): the escalation contract — atomic occurrence lifecycle, provenance-validated replay, sole creator by grant"`

---

### Task 5: Contract mirror in TypeScript + scenario matrix

**Files:** Modify `src/domain/entities/escalation.ts`, `src/lib/data/types.ts`, `src/lib/data/demo/index.ts`, `src/lib/data/supabase/index.ts`, `src/lib/data/supabase/mappers.ts`. Test: `tests/escalation-contract.test.ts` + deliberate G0 pin updates.

**Interfaces:** `escalations.create(scope, input) → { escalation: Escalation | null, created: boolean, reason: "escalation_exists" | "occurrence_replayed" | "mention_dismissed" | "awaiting_retriage" | null }`; `CreateEscalationInput.triggerAnalysisId: uuidSchema` required non-null; `Escalation.triggerAnalysisId: uuidSchema.nullable()` (historical rows). Demo `raiseEscalation` mirrors the SQL ladder exactly — provenance check first (missing/mismatched occurrence throws), then replay, dismissed, open dedupe, awaiting_retriage, create+transition — with the same reason strings and return-row semantics.

- [ ] **Step 1: Failing tests:**
  - **A.** Escalate (occurrence o1); resolve; mention still `escalated` → create(o2) → `awaiting_retriage`, null escalation, row count 1.
  - **B.** Resolve; re-triage to `monitoring`; create with SAME o1 → `occurrence_replayed` returning the RESOLVED historical row.
  - **C.** Re-triaged; NEW o2 → created; two rows, one open; mention `escalated`.
  - **D.** Dismiss the mention; create with UNUSED o3 → `mention_dismissed`, null escalation, no state change.
  - **D2.** Dismissed mention, CONSUMED o1 replayed → `occurrence_replayed` with the historical row; no new escalation; mention stays `dismissed` (the ladder's replay-before-dismissed order pinned).
  - Provenance: create with an occurrence belonging to a different mention → throws (the mirror raises like the SQL); different org scope → throws.
  - Open blocks with the open row returned; null `triggerAnalysisId` fails schema parse; rules-path unreachability of the two hard refusals pinned (matrix intercepts first).
- [ ] **Step 2:** RED. **Step 3:** Implement mirror + supabase `.rpc("raise_escalation", …)` call (passing `p_audit_event_type: "escalation.created_from_analysis"` only from the analysis-path entry — see Task 6; the repository method takes an internal option the two callers set) + mappers.
- [ ] **Step 4:** GREEN + suite + tsc. **Step 5:** `git commit -m "feat(escalations): contract mirror — provenance-validated, replay-precise (D158)"`

---

### Task 6: The analysis occurrence lifecycle

**Files:** Modify `src/lib/analysis/analyze.ts`, `src/lib/data/types.ts` (`createAnalysis` → insert-or-load contract returning `{analysis, created}`; widened selection; `applyAnalysisOutcome` superseded by the atomic apply — keep the method for now, the service stops calling it on this path), both adapters. Test: `tests/analysis-run.test.ts`.

**The lifecycle (v4):**

1. **Record the occurrence** (post-classification, insert-or-load): classify (model or heuristic), then `createAnalysis` → `record_analysis_occurrence` semantics — `{analysis, created:false}` means a concurrent or crashed prior recording exists for this mention; **use the returned row and discard the fresh output** (one durable occurrence per logical event).
2. **Apply atomically:** compute the escalation decision + outcome from the (possibly loaded) stored row via the existing normalize helpers, then `apply_analysis_occurrence` — escalation, transition, outcome, completion, audit: one transaction. `already_applied: true` → nothing to do (replay after success).
3. **Recovery:** selection = no analysis row OR latest row pending (`outcome_applied_at` null). A re-picked pending mention **skips classification** and re-runs step 2 from stored output under the same id.
4. **Deliberate reanalysis (future):** records a new occurrence while none is pending; the one-pending index cannot collide with completed rows.

Crash matrix: before step 1 → nothing durable, nothing to duplicate; between 1 and 2 → re-picked pending, applied once; mid-step-2 → the transaction rolled back whole, pending recoverable; after 2 → `already_applied` replay, zero effects, zero extra audit events. The old escalation-title caveat stands (recovery uses `derivedTitle`; documented cosmetic difference).

- [ ] **Step 1: Failing tests:** the Task 6 v3 suite reshaped to the atomic apply — first-escalation provenance; crash between record and apply (inject: apply throws once) → one model call total (provider spy), recovery applies under the same id, one escalation, one `escalation.created_from_analysis` event; replay after success → no effects, no second event; dismissed-mention refusal through the pipeline; escalated-with-closed-cases refusal (`awaiting_retriage`) through recovery; counts include pending mentions.
- [ ] **Step 2:** RED. **Step 3:** Implement (rewrite the old write-order comment: superseded by the occurrence lifecycle, with the crash matrix). Demo adapter mirrors both functions' semantics (single-threaded atomicity; `createAnalysis` gains insert-or-load against a pending row; new `applyAnalysisOccurrence` repo method or equivalent — name it exactly `applyAnalysisOccurrence` in `types.ts`).
- [ ] **Step 4:** GREEN + suite + tsc. **Step 5:** `git commit -m "feat(analysis): concurrency-safe occurrence lifecycle — record, apply atomically, recover"`

---

### Task 7: Transition matrix in SQL + generated parity file

Unchanged from v3 (already complete there): migration `20260812000400_automation_transition_functions.sql` with `automation_set_status_decision` / `automation_escalate_decision` exactly as printed in v3 Task 7 — reproduced in the migration verbatim; generator `scripts/generate-matrix-parity-sql.ts` exporting `buildMatrixParityLines()`; committed `supabase/tests/matrix-parity.generated.sql`; drift-guard `tests/matrix-parity-generated.test.ts`; `matrix:parity:generate` script.

- [ ] **Steps 1–5** as v3 Task 7 (migration → generator → drift guard → validate/generate → `git commit -m "feat(db): transition matrix in SQL with generated parity assertions"`).

---

### Task 8: The execution RPC — null-safe validation, origin/attempt sweeps

**Files:** Create `supabase/migrations/20260812000500_execute_automation_rule_rpc.sql`; modify `src/lib/data/types.ts` (`ExecuteUnitInput` without `actions`; the input's sweep field is the **attempt** sweep), `src/lib/rules/execute.ts`, `src/lib/data/demo/index.ts`. Test: `tests/automation-execution-repository.test.ts`.

Action table as v3 (all eight shapes, verified against `ruleActionSchema` at `src/domain/entities/automation.ts:97-120`), with the v4 policy notes: validation is null-safe throughout; `auto_publish` is type-only — structurally valid, extra fields ignored, non-executable (`action_not_executable`).

- [ ] **Step 1: Failing twin tests** — v3's set plus: per-fielded-type malformed cases asserted to fail **before** any mutation; `auto_publish` with extra junk fields → valid, `blocked`/`action_not_executable`; origin/attempt semantics: a retry under a different sweep records audit metadata `originSweepId` = first sweep, `attemptSweepId` = current sweep (twin's audit fake asserts both keys).
- [ ] **Step 2:** RED. **Step 3:** Twin updates (validation via `ruleActionSchema.safeParse` per element — Zod is null-safe by construction; reason mapping as v3; audit metadata renamed).
- [ ] **Step 4: Write the RPC migration.** The complete v3 function with exactly these v4 corrections applied (everything else byte-identical to v3's printed body, which remains authoritative for structure — claim → replay/retry gate → validation → subtransaction → record/audit → exception handler):

  **Correction 1 — null-safe validation block** replacing v3's:

```sql
  v_actions := v_rule.actions;
  v_valid := coalesce(jsonb_typeof(v_actions) = 'array', false);
  if v_valid then
    select coalesce(bool_and(coalesce(
      case a->>'type'
        when 'generate_draft' then
          a ? 'voiceProfile' and (jsonb_typeof(a->'voiceProfile') = 'null'
            or (jsonb_typeof(a->'voiceProfile') = 'string'
                and length(a->>'voiceProfile') <= 80))
        when 'auto_publish' then true
        when 'require_approval' then
          a ? 'approverUserId' and (jsonb_typeof(a->'approverUserId') = 'null'
            or (jsonb_typeof(a->'approverUserId') = 'string'
                and public.automation_is_uuid(a->>'approverUserId')))
        when 'assign' then
          a ? 'assigneeUserId' and (jsonb_typeof(a->'assigneeUserId') = 'null'
            or (jsonb_typeof(a->'assigneeUserId') = 'string'
                and public.automation_is_uuid(a->>'assigneeUserId')))
        when 'escalate' then
          a ? 'assigneeUserId' and (jsonb_typeof(a->'assigneeUserId') = 'null'
            or (jsonb_typeof(a->'assigneeUserId') = 'string'
                and public.automation_is_uuid(a->>'assigneeUserId')))
        when 'notify' then
          coalesce(jsonb_typeof(a->'channel') = 'string', false)
          and a->>'channel' in ('email', 'in_app', 'both')
        when 'tag' then
          coalesce(jsonb_typeof(a->'label') = 'string', false)
          and length(a->>'label') between 1 and 80
        when 'set_status' then
          coalesce(jsonb_typeof(a->'status') = 'string', false)
          and (a->>'status') = any (enum_range(null::mention_status)::text[])
        else false
      end, false)), true)
    into v_valid
    from jsonb_array_elements(v_actions) a;
  end if;
```

  **Correction 2 — the escalate arm** calls `raise_escalation(…, p_analysis_id, null)` — null audit type; the unit's own `automation_rule.executed` event is the trail. Mapping unchanged (`occurrence_replayed → escalation_exists` no_op; hard refusals → `forbidden_transition` blocked). Note the provenance raise inside `raise_escalation` surfaces as a technical failure here (retryable, capped) — acceptable: the engine always passes the unit's own coherent triple, so it is unreachable except under corruption, and the harness pins the direct-call behavior instead.

  **Correction 3 — audit metadata** in both the executed and execution_failed events: `'originSweepId', v_exec.sweep_id, 'attemptSweepId', p_sweep_id` replacing the single `'sweepId'` key.

- [ ] **Step 5:** `npm run db:validate`; suite + tsc. **Step 6:** `git commit -m "feat(db): execute_automation_rule — null-safe stored validation, origin/attempt sweep provenance"`

---

### Task 9: Atomic sweep claim + activity support

**Files:** Create `supabase/migrations/20260812000600_automation_execution_support.sql`.

- [ ] **Step 1: Write the migration** — `automation_mark_activity` exactly as v3 (greatest()-monotonic, printed there and reproduced verbatim); `claim_automation_sweep` with the corrected handler:

```sql
create function public.claim_automation_sweep(
  p_organization_id uuid, p_mode text
) returns table (sweep public.automation_sweeps, claimed boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_running public.automation_sweeps;
  v_new public.automation_sweeps;
  v_constraint text;
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
    -- A partial unique INDEX is not in pg_constraint; the reliable
    -- identity is the diagnostics' reported name. Absorb exactly our
    -- index's collision; anything else re-raises untouched.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'automation_sweeps_one_running' then
      raise;
    end if;
    select * into v_running from public.automation_sweeps s
     where s.organization_id = p_organization_id and s.status = 'running';
    return query select v_running, false; return;
  end;
  return query select v_new, true;
end $$;
```

  Grants block for both functions as the Global Constraints require.

- [ ] **Step 2:** `npm run db:validate`. **Step 3:** `git commit -m "feat(db): atomic sweep claiming (diagnostics-verified collision) and monotonic activity stamps"`

---

### Task 10: Supabase adapter goes real

As v3, unchanged in substance: `executeUnit` → `.rpc("execute_automation_rule", …)`; `claim` → `.rpc("claim_automation_sweep", …)`; `finalize` update; `recordProjection` insert-ignore-duplicates + read-back of the stored row; `markActivity` → `.rpc("automation_mark_activity", …)`; `createAnalysis` → `.rpc("record_analysis_occurrence", …)` and the new `applyAnalysisOccurrence` → `.rpc("apply_analysis_occurrence", …)` (Task 6's contract); all via `serviceClient()`; errors translated to `DataError`.

- [ ] **Steps 1–5:** failing stubbed-client tests per method → RED → implement → GREEN + suite + tsc + validate → `git commit -m "feat(data): supabase adapters for the occurrence lifecycle and execution RPCs"`

---

### Task 11: Database harness + deterministic, bounded concurrency proofs

**Files:** Create `supabase/tests/execution-verification.sql`, `scripts/execution-race-test.sh`; modify `package.json` (`db:verify-execution`).

- [ ] **Step 1: Harness** (explicit identities throughout; owner via `reset role`, app roles via the JWT-claims idiom):
  1. **Identities:** authenticated → `audit_events` insert 42501; authenticated/anon/`service_role` → `escalations` insert refused; definer path (`execute_automation_rule`) lands exactly one executed event with BOTH `originSweepId` and `attemptSweepId` keys; direct service-role audit insert succeeds; cross-org audit read refused as authenticated (never via service role).
  2. **Indexes as owner:** two open escalations → `escalations_one_open_per_mention`; duplicate `trigger_analysis_id` → `escalations_one_per_occurrence`; two pending analyses for one mention → `mention_analyses_one_pending`.
  3. **Provenance:** composite-FK refusals (foreign mention / foreign org / restricted delete of cited analysis); G0 execution-table cross-org refusals re-checked; mention-relocation cascade.
  4. **Location visibility:** as G0/v3.
  5. **Contract matrix via the functions:** null occurrence → 22004; **5b provenance-before-replay:** `raise_escalation` with an occurrence of another mention → raises 23503 (no data returned); another organization's occurrence → raises; the true triple still replays, including when its escalation is resolved; dismissed-mention: unused occurrence → `mention_dismissed`, consumed occurrence → `occurrence_replayed`, state untouched; the full A/B/C ladder; `execute_automation_rule` terminal replay zero-effects with outcome codes inside the pinned vocabulary.
  6. **Whole-unit rollback:** as v3 (trigger-forced failure; failed row survives; no executed event; execution_failed present). **6b escalation-audit atomicity:** a temporary trigger on `audit_events` raising for `escalation.created_from_analysis` rows of a marker mention; call `apply_analysis_occurrence` → the escalation AND the mention transition AND the completion all rolled back (occurrence still pending); drop the trigger; retry → exactly one escalation, one transition, one created event, occurrence completed.
  7. **Retry + claims:** as v3, plus **7c:** force an unrelated unique violation through the claim path (temporarily add a throwaway unique index on `automation_sweeps(organization_id, mode)` as owner, insert a colliding row, call the claim) → the violation RE-RAISES (not absorbed); drop the index.
  8. **Stored-action validation through the real RPC:** every fielded type malformed (missing field, wrong type, bad enum — including the null-trap cases: `notify` without `channel`, `tag` without `label`, `set_status` without `status`), `auto_publish` with extra fields (valid, non-executable), null/non-array/empty/unknown-type → each terminal `invalid_action` (or `no_op` for empty), mention untouched.
  9. **Matrix parity:** the generated file.
- [ ] **Step 2: Race script** — FIFO-handshake sessions as v3, with the v4 safety rails: every session opens with `set statement_timeout = '10s'; set lock_timeout = '10s';`; the script wraps each round in `timeout 60`; a `trap 'cleanup' EXIT INT TERM` closes FIFOs, issues `rollback` to any held session, drops test triggers/scratch tables, and exits nonzero on assertion failure without hanging. Four races:
  1. Sweep claim, empty state → one running row, one `claimed=true`, neither errored.
  2. Stale takeover (seeded 35-minute-old running sweep) → exactly one takeover, no double owner.
  3. Execution unit (transition-recording trigger) → same execution id both sessions, one row, one escalation, exactly one recorded transition to `escalated`, one executed event, `attempt_count` 1, neither errored.
  4. **Occurrence recording:** both sessions call `record_analysis_occurrence` for the same mention (one holds its transaction open on the FIFO; the other provably blocks on the pending-index insert) → one pending row; one `created=true`, one `created=false` returning the same row id; no orphaned second pending row.
- [ ] **Step 3:** Wire `db:verify-execution` (reset → rls file → execution file → parity file → race script). **Step 4:** Run to green (Docker; quote-stripped `SUPABASE_DB_URL`). **Step 5:** `git commit -m "test(db): execution harness — atomic lifecycle, provenance, bounded deterministic races"`

---

### Task 12: CI gate

As v3, unchanged: confirm the default branch via `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; pin the Supabase CLI to the locally verified version; the workflow's two jobs (`verify`, `database`) with the quote-stripping `tr -d '"'` on `SUPABASE_DB_URL`; `db:verify-execution` always begins with `supabase db reset` so the harness runs against freshly migrated Postgres; push a branch and confirm both jobs pass on the forge; the runbook records the owner action to mark `database` required.

- [ ] **Steps 1–4** as v3 Task 12 → `git commit -m "ci: verify + database harness as merge gates"`

---

### Task 13: Docs, ledger, and the internal-apply runbook

**Files:** Modify `docs/architecture/current-state.md`, `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`.

- [ ] **Step 1: Decision rows** — D159: the escalation contract (sole creator by grant; ladder; mandatory occurrence identity; composite provenance validated before replay; the precise return contract incl. dismissed-replay semantics; atomic created-audit). D160: the occurrence lifecycle (insert-or-load claim behind `mention_analyses_one_pending`; **the honest scope statement: one durable occurrence and one applied outcome guaranteed by the database; duplicate model calls bounded by the per-org run lock at the application layer**; recovery; deliberate reanalysis). D161: stored-revision execution with null-safe eight-shape validation; boundary reason mapping; originSweepId/attemptSweepId semantics. D162: audit contract as approved. D163: atomic sweep claiming with diagnostics-verified collision absorption. D164: CI as the parity gate. D158's tail → "landed" with versions.
- [ ] **Step 2: Runbook** — six-migration push table; owner marks `database` required; `dry_run` + internal allowlist → watch → `apply`; first-live-sweep reconciliation; false-positive re-escalation watch item; cron response-shape note.
- [ ] **Step 3:** Spec §11 G1 block marked implemented per line; Q7 note gains the occurrence-lifecycle addendum.
- [ ] **Step 4:** `npm run verify` green. **Step 5:** `git commit -m "docs: record G1 decisions and the internal-apply runbook"`

---

## Not in this plan

Hosted migration push and mode changes (runbook, human-executed); marking the CI check required (owner action); G2's overlapping-mutation-path RPCs and location-aware write policies; ledgered G0 minors not named above; any new executor. A future re-analysis surface records a new occurrence deliberately (no pending collision possible against completed rows) and inherits idempotency, provenance, atomic application, and recovery with no contract change.
