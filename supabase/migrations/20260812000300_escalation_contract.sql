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

-- Without this, record_analysis_occurrence accepts org A recording an
-- occurrence against org B's mention_id: a readable cross-tenant row, plus
-- a durable denial-of-service on the victim mention's one-pending slot
-- (mention_analyses_one_pending is keyed on mention_id alone, so org A's
-- bogus pending row blocks org B's real recorder). The composite unique
-- target (mentions_id_org) was added by 20260811000100.
alter table public.mention_analyses
  add constraint mention_analyses_mention_same_org
    foreign key (mention_id, organization_id)
    references public.mentions (id, organization_id);

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
    --   occurrence_replayed         -> preserve current status (replay never
    --                                  mutates — a human decision made
    --                                  between recording and this replayed
    --                                  application, e.g. dismissing the
    --                                  mention, must not be overwritten)
    --   mention_dismissed           -> preserve dismissed
    --   awaiting_retriage           -> preserve escalated
    if v_esc.created or v_esc.reason = 'escalation_exists' then
      v_status := 'escalated';
    elsif v_esc.reason = 'occurrence_replayed' then
      v_status := v_mention.status;
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
