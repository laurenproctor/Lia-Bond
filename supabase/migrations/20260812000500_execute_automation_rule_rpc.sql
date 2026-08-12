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
