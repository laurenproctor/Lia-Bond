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
