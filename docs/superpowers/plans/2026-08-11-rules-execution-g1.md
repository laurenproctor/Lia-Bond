# Rules execution G1 (internal apply gate) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Plan, v5 — complete and self-contained. Revised four times after design
review, before any implementation; v1–v4 are in git history and are NOT
needed to execute this plan: every SQL function, constraint, grant, and
workflow appears here in full. Implementation stays paused until v5 is
approved. Q1, Q2, the durable-occurrence direction, and every previously
approved decision are settled and not reopened.

**Goal:** Build everything the spec's G1 gate requires, with the three remaining database guarantees closed: occurrence identity keyed to a **logical analysis event** (not lifecycle state), the final mention status **owned by the database** inside atomic outcome application, and the atomic analysis entry point **unbypassable by privilege** — plus the corrections already approved in earlier rounds.

**Architecture (settled):** The `mention_analyses` row is the durable occurrence. Its identity is the logical event key `(organization_id, analysis_run_id, mention_id)`, unique in the database independent of completion state; `record_analysis_occurrence` is insert-or-load on that key under every arrival order. `apply_analysis_occurrence` atomically performs eligibility, escalation creation (via the owner-internal `raise_escalation`), the database-derived mention transition, outcome application, occurrence completion, and the created-audit event. `execute_automation_rule` executes only the stored rule revision with null-safe validation. `service_role` can execute only the transactional entry points — `raise_escalation` itself is owner-internal, and no role can INSERT into `escalations` directly.

**Tech Stack:** plpgsql migrations, Supabase JS service-role client, TypeScript strict, Vitest, psql-based deterministic races with bounded timeouts, GitHub Actions (pinned CLI, freshly migrated Postgres).

**Spec:** `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`; decisions D148–D158. Governing principle: **"pending" describes where an occurrence is in its lifecycle; the event key establishes which real-world event it represents. Lia claims one effect per event only because the database carries an immutable identity for that event and uses it under every possible arrival order.**

## Approved and not reopened

Durable occurrence persisted before escalation effects; recovery from stored classification output; atomic escalation creation + audit insertion; composite provenance validation before replay; exact dismissed-occurrence replay behavior; null-safe stored-action validation; PostgreSQL UUID parsing (`automation_is_uuid`); diagnostics-based sweep collision handling; `originSweepId`/`attemptSweepId`; whole-unit rollback for technical failures; bounded self-cleaning concurrency tests; the narrowed duplicate-model-call promise; sole-creator-by-grant; the eligibility ladder (legal `new`; permanent `dismissed` refusal; open-dedupe; `awaiting_retriage`); the D162 audit contract; first-ever CI with owner-marked required check; Q1; Q2.

## Global Constraints

- **Logical event identity.** Every pipeline recording happens inside an analysis run (`analysisRuns.start` precedes all per-mention work), so the event key is `(organization_id, analysis_run_id, mention_id)`, enforced by a unique index that ignores historical null-run rows. `record_analysis_occurrence` requires a non-null `p_analysis_run_id`, inserts on the event key, and on conflict returns that event's existing row **whether pending or completed** (`created = false` for every later recorder). `mention_analyses_one_pending` (one pending occurrence per mention) remains a separate lifecycle invariant — it is NOT the idempotency key and the plan never describes it as one. The run FK hardens to `on delete restrict` (identity evidence must not be erasable). Honest scope, unchanged: this prevents duplicate occurrence rows and duplicate applied outcomes; **it does not prevent duplicate model calls** — those are bounded by the per-organization analysis run lock at the application layer.
- **The database owns the final mention status.** `apply_analysis_occurrence` locks the mention and derives the final status from its CURRENT state plus the escalation result: `created`/`escalation_exists` → `escalated`; `mention_dismissed` → preserve `dismissed`; `awaiting_retriage` → preserve `escalated`; non-escalation outcome → `analyzed` only when the current status is `new`, otherwise the current status is preserved (human decisions — `dismissed`, `escalated`, `responded`, `needs_approval`, `draft_ready`, `monitoring`, `no_action_recommended` — are never overwritten by a non-escalation analysis result). Sentiment/risk/relevance always update; they never authorize a status transition. There is no caller-supplied status parameter.
- **Unbypassable entry points.** `service_role` holds EXECUTE on exactly: `record_analysis_occurrence`, `apply_analysis_occurrence`, `execute_automation_rule`, `claim_automation_sweep`, `automation_mark_activity`. `raise_escalation` and `automation_is_uuid` are owner-internal (revoked from `service_role` too; security-definer functions call them with owner rights). INSERT on `escalations` is revoked from `public, anon, authenticated, service_role`; the `escalations_insert` policy is dropped. The supabase adapter's `escalations.create` throws (`DataError("unavailable", …)`) — escalations exist only through the two transactional entry points; the demo adapter keeps an internal creator for its in-memory mirror only. A privilege test proves the boundary.
- Occurrence identity is mandatory for escalations (`raise_escalation` raises on null); null survives only on historical rows. Composite provenance `(trigger_analysis_id, mention_id, organization_id)` is validated before any replay lookup; mismatches raise and return nothing.
- Dismissed mentions, precisely: every previously unused occurrence is refused (`mention_dismissed`); a previously consumed occurrence returns `occurrence_replayed` with its historical escalation; replay never creates an escalation and never changes the dismissed state (ladder order — replay before the dismissed check — is load-bearing and tested).
- Escalation return contract: `escalation_exists` → the currently open escalation; `occurrence_replayed` → that occurrence's historical escalation regardless of status; `awaiting_retriage`/`mention_dismissed` → no escalation.
- The pinned public outcome vocabulary is closed (`escalation_reserved`, `high_risk_guardrail`, `forbidden_transition`, `escalation_exists`, `action_not_executable`, `rule_changed`, `invalid_action`); internal reasons map at the RPC boundary (`occurrence_replayed → escalation_exists` no_op; `mention_dismissed`/`awaiting_retriage → forbidden_transition` blocked), defensively and tested.
- Sweep provenance: an execution row's `sweep_id` column is its **originSweepId**; the sweep performing the current attempt is the **attemptSweepId**; audit metadata, RPC results, logs, and tests use these names.
- Stored-action validation is null-safe (`coalesce(..., false)` at both levels), covers all eight shapes, runs before the apply subtransaction, lands as terminal `invalid_action`. Unknown extra fields ignored (Zod strip parity); unknown `type` → `invalid_action`; empty array → `no_op`; null/non-array → `invalid_action`.
- Sweep claim absorbs only the violation whose `GET STACKED DIAGNOSTICS … CONSTRAINT_NAME` is `automation_sweeps_one_running`; everything else re-raises.
- Race tests: `statement_timeout`/`lock_timeout` 10s per session; per-round `timeout 60`; `trap` cleanup closing FIFOs, rolling back held transactions, dropping test artifacts.
- RPC/twin parity pins (D148–D157) stand: five-part idempotency key with `mode`; terminal replay unchanged with zero effects; retry cap `attempt_count >= 3`; whole-unit rollback with surviving `failed` row; success clears `error_class`/`last_error_code`; origin sweep and `started_at` keep first-attempt values; `location_id` follows the mention; caught technical failures classify `retryable`.
- Audit contract (D162): identifiers, outcomes, operational status, SQLSTATE, aggregate counts — never mention content. Function security: `security definer`, `set search_path = public, pg_temp`, explicit revoke/grant blocks (printed in full below).
- Migrations `20260812000100`–`20260812000600`, never amended after commit; nothing applied to the hosted project by this plan. Fail closed on referenced records. Every commit leaves `npm run verify` green. Worktree notes: copy `next-env.d.ts` from the main checkout; quote-stripped `SUPABASE_DB_URL`; `@/`-alias imports in node scripts.

## Migration sequence (complete, in order)

| Version | Name | Contents | Task |
| --- | --- | --- | --- |
| 20260812000100 | `execution_audit_vocabulary` | Three audit event types | 1 |
| 20260812000200 | `audit_events_no_client_inserts` | Policy drop + revoke | 2 |
| 20260812000300 | `escalation_contract` | `outcome_applied_at`; event-key + one-pending indexes; run-FK hardening; `trigger_analysis_id` + provenance FK; escalation partial uniques; total INSERT revocation; `automation_is_uuid`; `raise_escalation`; `record_analysis_occurrence`; `apply_analysis_occurrence`; all grants | 4 |
| 20260812000400 | `automation_transition_functions` | Matrix decision functions + grants | 7 |
| 20260812000500 | `execute_automation_rule_rpc` | The execution RPC + grants | 8 |
| 20260812000600 | `automation_execution_support` | `claim_automation_sweep`, `automation_mark_activity` + grants | 9 |

## Semantic guarantee → test map

| Guarantee | Test(s) |
| --- | --- |
| One occurrence per logical event under EVERY arrival order — concurrent recorder (pending) AND late recorder after completion both receive the first occurrence's row, `created=false` | Race 4a (pending ordering) and harness §2b (late-recorder-after-completion, same run key → same row id, one applied outcome); event-key index test (owner) |
| A deliberate reanalysis (different run key) mints a new occurrence without colliding with completed ones | Harness §2b second half; Task 6 lifecycle test |
| Two genuinely different events cannot both go pending for one mention; the pipeline completes the older first | `mention_analyses_one_pending` owner test; harness §2c (cross-event pending conflict returns the pending row, documented) |
| Duplicate occurrence rows impossible; duplicate model calls bounded only by the per-org run lock (stated, not overclaimed) | Guarantee wording + D160; run-lock behavior pinned by existing analysis tests |
| Final mention status derived in-database; human decisions between recording and application never overwritten | Harness §6c (every branch of the status derivation, incl. a human `dismissed`/`responded` flip between record and apply); Task 6 tests |
| Escalation, transition, outcome, completion, and created-audit commit together or not at all; retry → exactly one escalation + one event | Harness §6b (audit-failure trigger → full rollback → retry) |
| Analysis code cannot bypass atomic application; `raise_escalation` not executable by `service_role`; no role INSERTs escalations | Harness §1 privilege tests; adapter `escalations.create` throws (Task 5 test) |
| Occurrence provenance validated before replay; cross-mention/org attempts raise, return nothing | Harness §5b; Task 5 mirror tests |
| Dismissed: unused occurrence refused; consumed occurrence replays its historical row; replay never mutates | Task 5 scenarios D/D2; harness §5 |
| Resolved + still-`escalated` → `awaiting_retriage`; re-triaged + replay → historical row; re-triaged + new occurrence → new escalation | Task 5 scenarios A/B/C; harness §5 |
| At most one open escalation per mention, under concurrency | Owner index test (harness §2); deterministic execution race 3 |
| Concurrent identical units → same execution id, one row, one escalation, exactly one recorded transition, one executed event, `attempt_count` 1, neither errored | Race 3 with transition-recording trigger |
| Sweep claim: active lease returned; single stale takeover; no double owner; unrelated unique violations re-raise | Harness §7b/§7c; races 1–2 |
| All eight stored shapes validated null-safely before effects, through the real RPC | Harness §8; Task 8 twin tests |
| Internal reasons never leak into the public vocabulary | Task 8 mapping tests; harness §5 outcome-code assertions |
| Terminal replay zero effects; retry increments; success clears errors; originSweepId/attemptSweepId distinct in audit metadata | Harness §6/§7; twin tests; §5 metadata assertions |
| SQL matrix ≡ TypeScript matrix | Generated parity file (harness §9) + drift-guard vitest + CI database job |
| Location manager blocked from null-location/cross-location/missing-mention records | Task 3 tests; harness §4 |
| No authenticated audit inserts; definer/service paths write; cross-org reads refused as authenticated | Harness §1 |

---

### Task 1: Audit vocabulary migration

**Files:** Create `supabase/migrations/20260812000100_execution_audit_vocabulary.sql`; modify the domain audit event-type list (find with `grep -rn "response.edited" src/domain`).

- [ ] **Step 1:** Constraint-swap idiom (per `20260807000700_audit_vocabulary_merge.sql`): drop `audit_events_known_event_type`, re-add with the previous list plus `automation_rule.executed`, `automation_rule.execution_failed`, `automation_sweep.completed`; comment names the feature and that nothing writes these until the RPCs land.
- [ ] **Step 2:** Add the three literals to the domain vocabulary; `npx tsc --noEmit`.
- [ ] **Step 3:** `npm run db:validate` + full suite. **Step 4:** `git commit -m "feat(db): execution audit event vocabulary"`

---

### Task 2: Audit hardening — no authenticated audit inserts

**Files:** Create `supabase/migrations/20260812000200_audit_events_no_client_inserts.sql`; modify `src/lib/data/supabase/index.ts` (`auditEvents.record`, ~line 2750); extend the supabase adapter audit test.

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

- [ ] **Step 2:** `auditEvents.record` inserts via `serviceClient()` (reads keep the user client); comment the trust argument (scope already passed `getOrganizationContext()`; module is `server-only`; the paired RLS change removes the client-credentialed path).
- [ ] **Step 3:** Adapter test pins which client received the insert. `npm run db:validate` + suite + tsc.
- [ ] **Step 4:** `git commit -m "feat(auth): audit events are written only by trusted server-side paths"`

---

### Task 3: Location-scoping fixes (P0-4), fail-closed

**Files:** Modify `src/app/actions/escalations.ts` (`updateEscalationStatusAction`), `src/app/actions/responses.ts` (`assignResponseDraftAction`); extend their test files (locate with `grep -rln "updateEscalationStatusAction\|assignResponseDraftAction" tests/`).

- [ ] **Step 1: Failing tests**, four per action: (1) location manager of A refused (`forbidden`) on a record whose mention belongs to location B; (2) manager succeeds on their own location's record; (3) manager refused when the record's mention has `locationId: null`; (4) referenced mention missing (store surgery) → explicit `notFound("Mention")`. Plus one owner-unrestricted case.
- [ ] **Step 2:** RED. **Step 3:** Implement: load the record; `const mention = await context.dataSource.mentions.get(context.scope, existing.mentionId); if (!mention) throw notFound("Mention");` then `assertPermissionForLocation(context, permission, mention.locationId)` — the `updateMentionStatusAction` pattern (`src/app/actions/mentions.ts:30`); no optional chaining on the mention.
- [ ] **Step 4:** GREEN + suite + tsc. **Step 5:** `git commit -m "fix(auth): location managers act only on their own locations' records, failing closed"`

---

### Task 4: The escalation contract migration — complete SQL

**Files:** Create `supabase/migrations/20260812000300_escalation_contract.sql`.

- [ ] **Step 1: Write the migration.** The complete file:

```sql
-- D158's shared escalation contract, database-enforced, with the durable
-- occurrence lifecycle's SQL half.
--
-- Identity model: a logical analysis event is (organization, analysis run,
-- mention) — every pipeline recording happens inside a run, so the run id
-- is the shared identity every recorder of the same event carries. The
-- event key is unique regardless of lifecycle state, which is what makes
-- record_analysis_occurrence idempotent under every arrival order,
-- including a late recorder arriving after the event already completed.
-- "Pending" (outcome_applied_at null) is a separate lifecycle invariant:
-- one pending occurrence per mention, so recovery always has exactly one
-- thing to finish. Pending is never used as event identity.

------------------------------------------------------------------
-- Occurrence lifecycle columns and identity
------------------------------------------------------------------
alter table public.mention_analyses
  add column outcome_applied_at timestamptz;
comment on column public.mention_analyses.outcome_applied_at is
  'When this occurrence''s effects (escalation decision + mention outcome) were applied, set only by apply_analysis_occurrence. Null marks a pending occurrence: recovery re-picks it and reuses this row''s id and stored output rather than re-analyzing. Backfilled to created_at for rows predating the lifecycle.';
update public.mention_analyses
   set outcome_applied_at = created_at where outcome_applied_at is null;

-- The logical event key. Null run ids exist only on historical rows and
-- skip the index (MATCH the recorder: record_analysis_occurrence refuses
-- null run ids for new work).
create unique index mention_analyses_one_per_event
  on public.mention_analyses (organization_id, analysis_run_id, mention_id)
  where analysis_run_id is not null;

-- One pending occurrence per mention (lifecycle invariant, NOT identity).
create unique index mention_analyses_one_pending
  on public.mention_analyses (mention_id)
  where outcome_applied_at is null;

-- Identity evidence must not be erasable: the run row anchors the event
-- key. (Previously on delete set null; nothing deletes runs today, so the
-- constraint converts "never happens" into "cannot happen".)
alter table public.mention_analyses
  drop constraint mention_analyses_analysis_run_id_fkey;
alter table public.mention_analyses
  add constraint mention_analyses_analysis_run_id_fkey
    foreign key (analysis_run_id) references public.analysis_runs (id)
    on delete restrict;

------------------------------------------------------------------
-- Escalation provenance
------------------------------------------------------------------
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

------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------
-- Guarded-cast uuid check. Semantics = the Postgres uuid parser — the
-- operative equivalence, since these values land in uuid columns.
create function public.automation_is_uuid(p_value text)
returns boolean language plpgsql immutable as $$
begin
  perform p_value::uuid; return true;
exception when invalid_text_representation then return false;
end $$;

------------------------------------------------------------------
-- raise_escalation — owner-internal. The ONLY creator of escalation rows.
-- Called by apply_analysis_occurrence and execute_automation_rule (both
-- security definer, so the internal call runs with owner rights); not
-- executable by service_role, so no application path can reach it outside
-- a transactional entry point.
------------------------------------------------------------------
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
    -- A concurrent caller won the partial-index race after our read; their
    -- row is the dedupe result, not an error. (The FOR UPDATE mention lock
    -- makes this arm nearly unreachable — constraint-level backstop.)
    select id into v_found from public.escalations
     where mention_id = p_mention_id
       and status in ('open', 'in_progress', 'pending_approval');
    return query select v_found, false, 'escalation_exists'::text; return;
  end if;

  update public.mentions set status = 'escalated', updated_at = now()
   where id = p_mention_id;

  -- The created-audit event commits WITH the creation: no crash can
  -- separate an escalation from its trail. Null event type = the caller's
  -- own audit covers it (the execution RPC's executed event).
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

------------------------------------------------------------------
-- record_analysis_occurrence — insert-or-load on the EVENT key.
-- Parameter list mirrors mention_analyses' classification columns
-- (verified against 20260801000100_initial_schema.sql:386-411 and
-- 20260804000100_mention_analysis.sql:108).
------------------------------------------------------------------
create function public.record_analysis_occurrence(
  p_organization_id uuid,
  p_mention_id uuid,
  p_analysis_run_id uuid,
  p_model_provider text,
  p_model_name text,
  p_prompt_version text,
  p_relevance_score numeric,
  p_relevance_explanation text,
  p_sentiment sentiment,
  p_sentiment_score numeric,
  p_risk_level risk_level,
  p_risk_categories escalation_category[],
  p_risk_explanation text,
  p_topics text[],
  p_facts_needing_verification text[],
  p_recommended_action recommended_action,
  p_recommendation_explanation text,
  p_analyzed_at timestamptz
) returns table (analysis_id uuid, created boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_constraint text;
begin
  if p_analysis_run_id is null then
    raise exception 'record_analysis_occurrence requires a non-null run id'
      using errcode = '22004';
  end if;

  begin
    insert into public.mention_analyses
        (organization_id, mention_id, analysis_run_id, model_provider,
         model_name, prompt_version, relevance_score,
         relevance_explanation, sentiment, sentiment_score, risk_level,
         risk_categories, risk_explanation, topics,
         facts_needing_verification, recommended_action,
         recommendation_explanation, analyzed_at)
    values
        (p_organization_id, p_mention_id, p_analysis_run_id,
         p_model_provider, p_model_name, p_prompt_version,
         p_relevance_score, p_relevance_explanation, p_sentiment,
         p_sentiment_score, p_risk_level, p_risk_categories,
         p_risk_explanation, p_topics, p_facts_needing_verification,
         p_recommended_action, p_recommendation_explanation, p_analyzed_at)
    returning id into v_id;
    return query select v_id, true; return;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'mention_analyses_one_per_event' then
      -- The same logical event was already recorded — pending OR
      -- completed. Return that occurrence; the late recorder's output is
      -- discarded (one durable occurrence per event, every ordering).
      select id into v_id from public.mention_analyses
       where organization_id = p_organization_id
         and analysis_run_id = p_analysis_run_id
         and mention_id = p_mention_id;
      return query select v_id, false; return;
    elsif v_constraint = 'mention_analyses_one_pending' then
      -- A DIFFERENT event's occurrence is still pending for this mention.
      -- Return the pending row (created=false): the caller finishes the
      -- older event's work; the new event records on a later sweep once
      -- the pending occurrence completes. Two events never collapse into
      -- one row — this arm returns the OLD event's row and the new
      -- event's output is discarded, which the lifecycle docs state.
      select id into v_id from public.mention_analyses
       where mention_id = p_mention_id and outcome_applied_at is null;
      return query select v_id, false; return;
    else
      raise;
    end if;
  end;
end $$;

------------------------------------------------------------------
-- apply_analysis_occurrence — the atomic analysis entry point.
-- Eligibility, escalation creation, the DATABASE-DERIVED mention
-- transition, outcome application, occurrence completion, and the
-- created-audit event: one transaction. The final status is derived here
-- from the mention's CURRENT state and the escalation result — there is
-- no caller-supplied status, so a human decision made between recording
-- and application can never be overwritten.
------------------------------------------------------------------
create function public.apply_analysis_occurrence(
  p_organization_id uuid,
  p_mention_id uuid,
  p_analysis_id uuid,
  p_should_escalate boolean,
  p_category escalation_category,
  p_severity risk_level,
  p_title text,
  p_summary text,
  p_sentiment sentiment,
  p_risk_level risk_level,
  p_relevance_score numeric
) returns table (escalation_id uuid, escalation_created boolean,
                 reason text, already_applied boolean,
                 final_status mention_status)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_analysis public.mention_analyses;
  v_mention public.mentions;
  v_esc record;
  v_status mention_status;
begin
  select * into v_analysis from public.mention_analyses
   where id = p_analysis_id and mention_id = p_mention_id
     and organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'occurrence % not found for mention % in organization %',
      p_analysis_id, p_mention_id, p_organization_id using errcode = 'P0002';
  end if;

  if v_analysis.outcome_applied_at is not null then
    -- Replay after success: zero effects, zero events.
    return query select null::uuid, false, null::text, true,
      (select m.status from public.mentions m where m.id = p_mention_id);
    return;
  end if;

  select * into v_mention from public.mentions
   where id = p_mention_id and organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'mention % not found in organization %',
      p_mention_id, p_organization_id using errcode = 'P0002';
  end if;

  if p_should_escalate then
    select * into v_esc from public.raise_escalation(
      p_organization_id, p_mention_id, p_category, p_severity,
      p_title, p_summary, null, p_analysis_id,
      'escalation.created_from_analysis');
    -- Database-owned final status:
    --   created / escalation_exists -> escalated
    --   mention_dismissed           -> preserve dismissed
    --   awaiting_retriage           -> preserve escalated
    if v_esc.created or v_esc.reason = 'escalation_exists'
       or v_esc.reason = 'occurrence_replayed' then
      v_status := 'escalated';
    elsif v_esc.reason = 'mention_dismissed' then
      v_status := 'dismissed';
    else  -- awaiting_retriage
      v_status := 'escalated';
    end if;
  else
    v_esc := null;
    -- Non-escalation outcome: 'analyzed' only from 'new'; every other
    -- current status is a decision (human or prior automation) this
    -- occurrence has no authority to change.
    v_status := case when v_mention.status = 'new'
                     then 'analyzed'::mention_status
                     else v_mention.status end;
  end if;

  -- Sentiment/risk/relevance always update; they never authorize a
  -- transition beyond the derivation above.
  update public.mentions
     set sentiment = p_sentiment, risk_level = p_risk_level,
         relevance_score = p_relevance_score, status = v_status,
         updated_at = now()
   where id = p_mention_id;

  update public.mention_analyses set outcome_applied_at = now()
   where id = p_analysis_id;

  if p_should_escalate then
    return query select v_esc.escalation_id, v_esc.created, v_esc.reason,
                        false, v_status;
  else
    return query select null::uuid, false, null::text, false, v_status;
  end if;
end $$;

------------------------------------------------------------------
-- Grants: sole creator by grant; entry points only for service_role.
------------------------------------------------------------------
drop policy escalations_insert on public.escalations;
revoke insert on public.escalations from public, anon, authenticated, service_role;

revoke execute on function public.automation_is_uuid(text) from public, anon, authenticated, service_role;
revoke execute on function public.raise_escalation(uuid, uuid, escalation_category, risk_level, text, text, timestamptz, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.record_analysis_occurrence(uuid, uuid, uuid, text, text, text, numeric, text, sentiment, numeric, risk_level, escalation_category[], text, text[], text[], recommended_action, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_analysis_occurrence(uuid, uuid, uuid, text, text, text, numeric, text, sentiment, numeric, risk_level, escalation_category[], text, text[], text[], recommended_action, text, timestamptz) to service_role;
revoke execute on function public.apply_analysis_occurrence(uuid, uuid, uuid, boolean, escalation_category, risk_level, text, text, sentiment, risk_level, numeric) from public, anon, authenticated;
grant execute on function public.apply_analysis_occurrence(uuid, uuid, uuid, boolean, escalation_category, risk_level, text, text, sentiment, risk_level, numeric) to service_role;
```

  Before committing, verify two schema facts against the live files (they were checked while writing this plan; re-verify rather than trust): the run FK's auto-generated name (`mention_analyses_analysis_run_id_fkey` per default naming — `supabase db reset` in Task 11 fails loudly if it differs; adjust the drop to the actual name) and the `mention_analyses` column list/types against `20260801000100_initial_schema.sql:386-411` (`sentiment_score` and `relevance_score` are `numeric`; enum types `sentiment`, `risk_level`, `recommended_action`, `escalation_category[]`).

- [ ] **Step 2:** `npm run db:validate` PASS. **Step 3:** `git commit -m "feat(db): the escalation contract — event-keyed occurrences, database-owned status, sole creator by grant"`

---

### Task 5: Contract mirror in TypeScript + scenario matrix

**Files:** Modify `src/domain/entities/escalation.ts`, `src/lib/data/types.ts`, `src/lib/data/demo/index.ts`, `src/lib/data/supabase/index.ts`, `src/lib/data/supabase/mappers.ts`. Test: `tests/escalation-contract.test.ts` + deliberate G0 pin updates.

**Interfaces:**
- `Escalation.triggerAnalysisId: uuidSchema.nullable()` (historical rows); mappers carry `trigger_analysis_id`.
- **`EscalationRepository.create` is closed as a production path:** the supabase implementation throws `DataError("unavailable", "Escalations are created only through analysis application or rule execution.")`; the demo adapter keeps an INTERNAL `raiseEscalation` mirror (the exact SQL ladder: provenance check → replay → dismissed → open dedupe → awaiting_retriage → create+transition+audit-marker) used only by its own `applyAnalysisOccurrence` and `executeUnit`. Contract scenario tests drive those two entry points, never a bare create. The caller graph is thereby unambiguous in both adapters: analysis → `applyAnalysisOccurrence`; automation → `executeUnit`; both may reach `raiseEscalation` internally; nothing else can.
- New repository methods (contract in `types.ts`, exact names): `mentions.applyAnalysisOccurrence(scope, input: { mentionId, analysisId, shouldEscalate, category, severity, title, summary, sentiment, riskLevel, relevanceScore }) → { escalationId: string | null, escalationCreated: boolean, reason: EscalationRefusalReason | null, alreadyApplied: boolean, finalStatus: MentionStatus }`; `mentions.recordAnalysisOccurrence(scope, input: CreateMentionAnalysisInput /* which gains required analysisRunId */) → { analysis: MentionAnalysis, created: boolean }`.

- [ ] **Step 1: Failing tests** (driving the demo entry points):
  - **A.** Escalate via `applyAnalysisOccurrence` (occurrence o1); resolve; mention still `escalated` → apply a NEW occurrence o2 with `shouldEscalate` → `awaiting_retriage`, `finalStatus: "escalated"` (preserved), row count 1.
  - **B.** Resolve; re-triage to `monitoring`; apply with the SAME o1 → `alreadyApplied: true`, zero effects (o1 completed earlier) — and the raw replay path via a fresh unit: `executeUnit` whose analysis id is o1 → `no_op`/`escalation_exists` (the mapped `occurrence_replayed`), the historical RESOLVED row's id involved, no new escalation.
  - **C.** Re-triaged; new occurrence o2, `shouldEscalate` → created; two escalation rows, one open; `finalStatus: "escalated"`.
  - **D.** Dismiss the mention; apply UNUSED occurrence o3 with `shouldEscalate` → `mention_dismissed`, `finalStatus: "dismissed"` (preserved), no row.
  - **D2.** Dismissed mention; CONSUMED o1 replayed through `executeUnit` → `escalation_exists` outcome, no new escalation, mention stays `dismissed`.
  - **Status derivation:** non-escalation apply on a `new` mention → `analyzed`; on a mention a human moved to `responded` between record and apply → status preserved `responded`, sentiment/risk still updated; on `dismissed` → preserved.
  - **Event identity:** `recordAnalysisOccurrence` twice with the same (run, mention) → same analysis id, `created:false` second time — including AFTER the first was applied (late recorder); a different run id after completion → new occurrence (`created:true`).
  - Provenance: applying with an occurrence of a different mention → throws; supabase `escalations.create` → throws `unavailable` (adapter test).
  - Null `analysisRunId` fails the input schema parse.
- [ ] **Step 2:** RED. **Step 3:** Implement mirror + supabase `.rpc` calls (`record_analysis_occurrence`, `apply_analysis_occurrence`) + the closed `create`.
- [ ] **Step 4:** GREEN + suite + tsc. **Step 5:** `git commit -m "feat(escalations): entry-point-only contract mirror with event-keyed occurrences (D158)"`

---

### Task 6: The analysis service on the occurrence lifecycle

**Files:** Modify `src/lib/analysis/analyze.ts`, `src/lib/data/types.ts` (selection widening: "needing analysis work" = no analysis row OR latest row pending), both adapters' selection queries. Test: `tests/analysis-run.test.ts`.

**The lifecycle:**

1. **Record** (post-classification, insert-or-load on the event key): classify (model or heuristic), then `recordAnalysisOccurrence` with the CURRENT run's id → `{analysis, created}`; on `created:false` use the returned row and discard the fresh output.
2. **Apply atomically:** compute the escalation decision from the (possibly loaded) stored row via the normalize helpers, then `applyAnalysisOccurrence`; `alreadyApplied: true` → done (replay after success).
3. **Recover:** a re-picked pending mention skips classification and runs step 2 from stored output under the same id; the recovering run's OWN run id is irrelevant — the pending row keeps its original event identity.
4. **Reanalyze (future):** a new run records a new event deliberately; if an older pending exists the recorder returns it (`created:false`) and this sweep completes the older event first — stated plainly, tested.

Crash matrix: before 1 → nothing durable, nothing to duplicate; between 1 and 2 → re-picked pending, applied once; mid-2 → the transaction rolled back whole (escalation, transition, completion, audit together), pending recoverable; after 2 → `alreadyApplied` replay, zero effects. Recovery uses `derivedTitle` (escalation title is not a stored column) — documented cosmetic difference.

- [ ] **Step 1: Failing tests:** first-escalation provenance (escalation's `triggerAnalysisId` = the analysis id; one `escalation.created_from_analysis` event, written by the database not the service — assert the service records no such event itself); crash between record and apply (inject apply-throw once) → one model call total (provider spy), recovery applies under the same id; replay after success → no effects, no second event; dismissed-mention refusal through the pipeline (`finalStatus` preserved); escalated-with-closed-cases refusal through recovery; human `responded` flip between record and apply → preserved; counts include pending mentions.
- [ ] **Step 2:** RED. **Step 3:** Implement (rewrite the old write-order comment: superseded by the occurrence lifecycle, with the crash matrix; the audit call for escalation creation is REMOVED from the service — the database writes it).
- [ ] **Step 4:** GREEN + suite + tsc. **Step 5:** `git commit -m "feat(analysis): event-keyed occurrence lifecycle — record, apply atomically, recover"`

---

### Task 7: Transition matrix in SQL + generated parity file — complete

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

- [ ] **Step 2: Generator** — `buildMatrixParityLines()` iterates `MENTION_STATUSES × MENTION_STATUSES × RISK_LEVELS` (324 set_status checks) plus the 9 escalate sources, one line per cell: `select pg_temp.check('set_status <from>-><to>@<risk>', public.automation_set_status_decision('<from>','<to>','<risk>') = '<expected>');` where `<expected>` maps `{kind:"blocked"}` → its code, `apply` → `'apply'`, `no_op` → `'no_op'`; wrapped in `begin;`/`rollback;`. CLI writes the file; wire `"matrix:parity:generate": "node --experimental-strip-types --no-warnings --import ./scripts/tsconfig-paths-hook.mjs scripts/generate-matrix-parity-sql.ts"`.
- [ ] **Step 3: Drift guard** — the committed file equals `buildMatrixParityLines().join("\n") + "\n"` byte-for-byte.
- [ ] **Step 4:** Generate; `npm run db:validate`; focused + full suite. **Step 5:** `git commit -m "feat(db): transition matrix in SQL with generated parity assertions"`

---

### Task 8: The execution RPC — complete SQL

**Files:** Create `supabase/migrations/20260812000500_execute_automation_rule_rpc.sql`; modify `src/lib/data/types.ts` (`ExecuteUnitInput` = `{sweepId /* the ATTEMPT sweep */, automationRuleId, ruleRevision, mentionId, triggerAnalysisId}`), `src/lib/rules/execute.ts`, `src/lib/data/demo/index.ts`. Test: `tests/automation-execution-repository.test.ts`.

**Stored action validation table** (from `ruleActionSchema`, `src/domain/entities/automation.ts:97-120`; unknown extra fields ignored — Zod strip parity; missing required field / wrong type / bad enum → terminal `invalid_action`; executability is a separate later judgment):

| Type | Required fields | Types / accepted values | Null handling | Executable (G1) |
| --- | --- | --- | --- | --- |
| `generate_draft` | `voiceProfile` | string ≤ 80 or null | nullable | No → `action_not_executable` |
| `auto_publish` | — (type only; extra fields ignored) | — | — | No → `action_not_executable` |
| `require_approval` | `approverUserId` | uuid or null | nullable | No → `action_not_executable` |
| `assign` | `assigneeUserId` | uuid or null | nullable | No → `action_not_executable` |
| `escalate` | `assigneeUserId` | uuid or null (always dropped, D157) | nullable | Yes |
| `notify` | `channel` | `'email'`,`'in_app'`,`'both'` | not null | No → `action_not_executable` |
| `tag` | `label` | string, 1–80 chars | not null | No → `action_not_executable` |
| `set_status` | `status` | a `mention_status` value, checked as text before casting | not null | Yes |

- [ ] **Step 1: Failing twin tests** — malformed cases per fielded type through the twin (corrupt the STORED rule); `auto_publish` extra-fields case; null/non-array/empty/unknown-type; empty → `no_op`; origin/attempt audit metadata; reason-mapping tests (`occurrence_replayed → escalation_exists` no_op via a replayed occurrence under a new revision; hard refusals → `forbidden_transition` via the exported mapper).
- [ ] **Step 2:** RED. **Step 3:** Twin updates (stored-actions load post-revision-check; `ruleActionSchema.safeParse` per element; escalate through the Task 5 mirror with boundary mapping; audit fake asserts `originSweepId`/`attemptSweepId`).
- [ ] **Step 4: Write the RPC migration.** The complete function:

```sql
-- The Phase 2 execution unit (spec §7): claim, validate, apply, record,
-- audit — one transaction. The demo adapter's executeUnit is the pinned
-- reference twin; supabase/tests/execution-verification.sql proves the
-- semantics D148–D158 promise. Service-role only. Executes ONLY the stored
-- rule revision: callers name a unit, they never define one.
create function public.execute_automation_rule(
  p_organization_id uuid,
  p_sweep_id uuid,       -- the ATTEMPT sweep; the row keeps its origin
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
  -- keeps it following the mention). sweep_id here becomes the row's
  -- originSweepId: on conflict nothing is updated, so a retry keeps the
  -- first attempt's sweep and started_at.
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
  -- Null-safe complete validation (see the action table). PostgreSQL
  -- aggregates ignore nulls, so every case arm is coalesced to false —
  -- a missing field can never slip through as null.
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
        else false  -- unknown type
      end, false)), true)
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
  -- APPLY, inside a subtransaction: any technical failure rolls back
  -- every statement inside it — mention writes, escalations, the success
  -- update, the success audit row — while the claim row survives to
  -- record the failure. Policy refusals are outcomes, not exceptions.
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
          -- Null audit type: this unit's own executed event is the trail.
          select * into v_esc from public.raise_escalation(
            p_organization_id, p_mention_id, 'other',
            v_mention.risk_level, 'Escalated by rule: ' || v_rule.name,
            null, null, p_analysis_id, null);
          if v_esc.created then
            v_status := 'escalated';
            v_applied := v_applied + 1;
            v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
              'type', v_type, 'outcome', 'applied', 'code', null);
          elsif v_esc.reason in ('escalation_exists', 'occurrence_replayed') then
            -- Boundary mapping: internal reasons stay internal.
            v_noop := v_noop + 1;
            v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
              'type', v_type, 'outcome', 'no_op', 'code', 'escalation_exists');
          else
            -- mention_dismissed / awaiting_retriage: unreachable behind
            -- the matrix, mapped defensively into the pinned vocabulary.
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
        -- Valid shape, not executable (D156): configuration fact.
        v_blocked := v_blocked + 1;
        v_outcomes := v_outcomes || jsonb_build_object('index', v_index,
          'type', v_type, 'outcome', 'blocked',
          'code', 'action_not_executable');
      end if;

      v_index := v_index + 1;
    end loop;

    -- RECORD + AUDIT inside the subtransaction: they commit with the
    -- effects. Success clears the error fields (pinned twin parity).
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

    insert into public.audit_events
        (organization_id, actor_user_id, actor_type, event_type,
         entity_type, entity_id, previous_state, new_state, metadata)
    values (p_organization_id, null, 'system', 'automation_rule.executed',
            'automation_rule', p_rule_id, null, null,
            jsonb_build_object('originSweepId', v_exec.sweep_id,
              'attemptSweepId', p_sweep_id, 'mentionId', p_mention_id,
              'analysisId', p_analysis_id, 'status', v_row_status,
              'applied', v_applied, 'blocked', v_blocked, 'noOp', v_noop));
    return v_exec;

  exception when others then
    -- Whole-unit rollback happened (subtransaction). The claim row
    -- survives; finalize as retryable (twin parity; cap bounds it).
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
            jsonb_build_object('originSweepId', v_exec.sweep_id,
              'attemptSweepId', p_sweep_id, 'mentionId', p_mention_id,
              'analysisId', p_analysis_id, 'sqlstate', sqlstate));
    return v_exec;
  end;
end $$;

revoke execute on function public.execute_automation_rule(uuid, uuid, uuid, integer, uuid, uuid) from public, anon, authenticated;
grant execute on function public.execute_automation_rule(uuid, uuid, uuid, integer, uuid, uuid) to service_role;
```

- [ ] **Step 5:** `npm run db:validate`; suite + tsc. **Step 6:** `git commit -m "feat(db): execute_automation_rule — complete transactional unit over the stored revision"`

---

### Task 9: Atomic sweep claim + activity support — complete SQL

**Files:** Create `supabase/migrations/20260812000600_automation_execution_support.sql`.

- [ ] **Step 1: Write the migration** (complete):

```sql
-- Sweep claiming as one atomic decision: the existing running row is
-- locked FOR UPDATE, so exactly one caller performs a stale takeover; the
-- loser blocks, re-reads, and receives the winner's claim as a normal
-- (sweep, claimed=false) outcome. automation_sweeps_one_running remains
-- the constraint-level backstop; only ITS violation is absorbed (a
-- partial unique INDEX is not in pg_constraint — the reliable identity is
-- the diagnostics' reported name); anything else re-raises.
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

- [ ] **Step 2:** `npm run db:validate`. **Step 3:** `git commit -m "feat(db): atomic sweep claiming (diagnostics-verified collision) and monotonic activity stamps"`

---

### Task 10: Supabase adapter — entry points only

**Files:** Modify `src/lib/data/supabase/index.ts`, `src/lib/data/supabase/mappers.ts` (`mapAutomationSweep` if absent). Test: the supabase adapter automation test file (stubbed-client pattern).

Call-site map (all via `serviceClient()`, errors translated to `DataError`, never raw postgrest):

| Repository method | Database call |
| --- | --- |
| `mentions.recordAnalysisOccurrence` | `.rpc("record_analysis_occurrence", { p_organization_id, p_mention_id, p_analysis_run_id, …all classification params })` → `{analysis, created}` (re-read the row by returned id for the full entity) |
| `mentions.applyAnalysisOccurrence` | `.rpc("apply_analysis_occurrence", { p_organization_id, p_mention_id, p_analysis_id, p_should_escalate, p_category, p_severity, p_title, p_summary, p_sentiment, p_risk_level, p_relevance_score })` |
| `escalations.create` | **throws** `DataError("unavailable", "Escalations are created only through analysis application or rule execution.")` — analysis cannot bypass atomic application |
| `automationRuleExecutions.executeUnit` | `.rpc("execute_automation_rule", { p_organization_id, p_sweep_id /* attempt */, p_rule_id, p_revision, p_mention_id, p_analysis_id })` → `mapAutomationRuleExecution` |
| `automationRuleExecutions.recordProjection` | insert with `ignoreDuplicates` + read-back of the STORED row |
| `automationSweeps.claim` | `.rpc("claim_automation_sweep", …)` → `{sweep, claimed}` |
| `automationSweeps.finalize` | update status/counters/completed_at |
| `automationRules.markActivity` | `.rpc("automation_mark_activity", …)` |

- [ ] **Step 1:** Failing stubbed-client tests per row of the table (params snake_case; `escalations.create` throw pinned). **Step 2:** RED. **Step 3:** Implement. **Step 4:** GREEN + suite + tsc + `npm run db:validate`. **Step 5:** `git commit -m "feat(data): supabase adapters — transactional entry points only"`

---

### Task 11: Database harness + deterministic, bounded concurrency proofs

**Files:** Create `supabase/tests/execution-verification.sql`, `scripts/execution-race-test.sh`; modify `package.json` (`db:verify-execution`).

- [ ] **Step 1: Harness** (fixtures by slug; `pg_temp.check` helper hoisted so all included files share it; mutating sections in `begin`/`rollback`; every role switch explicit — authenticated via the JWT-claims idiom, `set role service_role`, `reset role` for owner):
  1. **Privilege boundary:** authenticated `audit_events` insert → 42501; authenticated/anon/`service_role` `escalations` inserts → refused; **`service_role` executing `raise_escalation` directly → refused (42501)** while `record_analysis_occurrence`/`apply_analysis_occurrence`/`execute_automation_rule`/`claim_automation_sweep`/`automation_mark_activity` succeed as `service_role`; definer path lands exactly one executed event with `originSweepId` AND `attemptSweepId`; direct service-role audit insert succeeds; cross-org audit read refused as authenticated.
  2. **Indexes as owner:** two open escalations → `escalations_one_open_per_mention`; duplicate `trigger_analysis_id` → `escalations_one_per_occurrence`; two pending analyses for one mention → `mention_analyses_one_pending`; duplicate `(org, run, mention)` → `mention_analyses_one_per_event`. **2b event-identity orderings via `record_analysis_occurrence`:** same (run, mention) while pending → same id, `created=false`; complete it via `apply_analysis_occurrence`, then record the same (run, mention) again — **late recorder after completion** → same id, `created=false`, and re-applying reports `already_applied` (one applied outcome total); a NEW run id for the same mention → new occurrence, `created=true`. **2c cross-event pending conflict:** with event X pending, record event Y (different run) → returns X's pending row, `created=false`, no second pending.
  3. **Provenance:** composite-FK refusals (foreign mention / foreign org); deleting a cited `mention_analyses` row → restricted; deleting a referenced `analysis_runs` row → restricted; G0 execution-table cross-org refusals re-checked; mention-relocation cascade.
  4. **Location visibility:** manager sees only their location's execution rows; null-location rows invisible to managers, visible to admins; org-B manager sees none.
  5. **Contract matrix via the entry points:** `raise_escalation` null occurrence → 22004 (owner call); **5b provenance-before-replay** (owner calls): cross-mention occurrence → raises 23503, no data; cross-org → raises; true triple replays including when its escalation is resolved; dismissed: unused occurrence → `mention_dismissed`, consumed → `occurrence_replayed`, state untouched; the A/B/C ladder; `execute_automation_rule` terminal replay zero-effects; outcome codes within the pinned vocabulary.
  6. **Whole-unit rollback** (trigger-forced failure → failed row survives, no executed event, execution_failed present). **6b escalation-audit atomicity:** trigger on `audit_events` raising for `escalation.created_from_analysis` of a marker mention; `apply_analysis_occurrence` → escalation, transition, completion ALL rolled back (occurrence still pending); drop trigger; retry → one escalation, one transition, one event, completed. **6c status derivation, every branch:** created → `escalated`; escalation_exists → `escalated`; mention_dismissed → `dismissed` preserved; awaiting_retriage → `escalated` preserved; non-escalation from `new` → `analyzed`; non-escalation after a human set `responded` (update between record and apply) → `responded` preserved with sentiment/risk updated; non-escalation on `dismissed` → preserved.
  7. **Retry + claims:** post-rollback retry → `applied`, `attempt_count = 2`, error fields null; `rule_changed` terminal replay; **7b** claim states (active lease same-id `claimed=false`; backdated 35-minute takeover exactly once; finalize between cases); **7c** unrelated unique violation through the claim path (throwaway unique index on `automation_sweeps(organization_id, mode)` as owner; colliding insert; call claim) → RE-RAISES; drop index.
  8. **Stored-action validation through the real RPC:** every fielded type malformed (incl. the null traps: `notify` without `channel`, `tag` without `label`, `set_status` without `status`), `auto_publish` with extra fields (valid, `action_not_executable`), null/non-array/empty/unknown-type → terminal `invalid_action` (or `no_op` for empty), mention untouched.
  9. **Matrix parity:** the generated file.
- [ ] **Step 2: Race script** (`scripts/execution-race-test.sh`) — FIFO-handshake sessions; every session opens `set statement_timeout = '10s'; set lock_timeout = '10s';`; each round wrapped in `timeout 60`; `trap 'cleanup' EXIT INT TERM` closes FIFOs, rolls back held sessions, drops test triggers/scratch tables. Four races:
  1. **Sweep claim, empty state** → one running row, one `claimed=true`, neither errored.
  2. **Stale takeover** (seeded 35-minute-old running sweep) → exactly one takeover, no double owner, neither errored.
  3. **Execution unit** (transition-recording trigger on `mentions` into a scratch table) → same execution id both sessions, one row, one escalation, **exactly one recorded transition to `escalated`**, one executed event, `attempt_count` 1, neither errored.
  4. **Occurrence recording, pending ordering:** session A records event (run R, mention M) and holds its transaction on the FIFO; session B calls `record_analysis_occurrence` with the SAME (R, M) and provably blocks (pg_stat_activity wait check) → after release: one row, one `created=true`, one `created=false` with the same id. (The after-completion ordering is deterministic single-session work and lives in harness §2b.)
- [ ] **Step 3:** Wire `"db:verify-execution": "supabase db reset && psql \"$SUPABASE_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/tests/rls-verification.sql -f supabase/tests/execution-verification.sql -f supabase/tests/matrix-parity.generated.sql && bash scripts/execution-race-test.sh"`.
- [ ] **Step 4:** Run to green (Docker; quote-stripped `SUPABASE_DB_URL`). **Step 5:** `git commit -m "test(db): execution harness — event identity, atomic lifecycle, bounded deterministic races"`

---

### Task 12: CI gate — complete workflow

**Files:** Create `.github/workflows/verify.yml`.

- [ ] **Step 1:** Confirm the default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; expected `master` — use what it prints) and pin the Supabase CLI to the locally verified version (`supabase --version`).
- [ ] **Step 2: Write the workflow** (replace the two placeholders with Step 1's outputs):

```yaml
name: verify
on:
  pull_request:
  push:
    branches: [master]   # from Step 1
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
        with: { version: "<pin from Step 1>" }
      - run: npm ci
      - run: supabase start
      - name: Run the database harness against freshly migrated Postgres
        run: |
          export SUPABASE_DB_URL="$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')"
          npm run db:verify-execution
```

- [ ] **Step 3:** Push a branch; confirm both jobs pass on the forge. The runbook records the owner action: mark `database` a required status check, so a TypeScript matrix change can never merge with stale SQL behavior.
- [ ] **Step 4:** `git commit -m "ci: verify + database harness as merge gates"`

---

### Task 13: Docs, ledger, and the internal-apply runbook

**Files:** Modify `docs/architecture/current-state.md`, `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`.

- [ ] **Step 1: Decision rows** — D159: the escalation contract (sole creator by grant with `raise_escalation` owner-internal; ladder; mandatory occurrence identity; provenance validated before replay; precise return contract incl. dismissed-replay; atomic created-audit). D160: occurrence identity and lifecycle (the event key `(organization, analysis_run, mention)` with its unique index; pending as a separate lifecycle invariant, explicitly NOT the idempotency key; insert-or-load under every arrival order incl. late-recorder-after-completion; run-FK hardened to restrict; **the honest scope: one durable occurrence and one applied outcome guaranteed by the database — duplicate model calls bounded only by the per-org run lock**). D161: database-owned final status (the derivation table; human decisions between record and apply never overwritten). D162: audit contract as approved. D163: stored-revision execution, null-safe validation, boundary reason mapping, originSweepId/attemptSweepId. D164: atomic sweep claiming with diagnostics-verified collision absorption. D165: CI as the parity gate. D158's tail → "landed", with versions.
- [ ] **Step 2: Runbook** — six-migration push table; owner marks `database` required; `dry_run` + internal allowlist → watch → `apply`; first-live-sweep reconciliation; false-positive re-escalation watch item; cron response-shape note.
- [ ] **Step 3:** Spec §11 G1 block marked implemented per line; Q7 note gains the occurrence-lifecycle addendum (event-keyed identity supersedes both the "null today" and the pending-as-claim interim statements).
- [ ] **Step 4:** `npm run verify` green. **Step 5:** `git commit -m "docs: record G1 decisions and the internal-apply runbook"`

---

## Not in this plan

Hosted migration push and mode changes (runbook, human-executed); marking the CI check required (owner action); G2's overlapping-mutation-path RPCs and location-aware write policies; ledgered G0 minors not named above; any new executor. A future re-analysis surface records a new event (its own run id) deliberately: if an older occurrence is pending it completes first; otherwise the new occurrence proceeds — idempotency, provenance, atomic application, and recovery all inherited with no contract change.
