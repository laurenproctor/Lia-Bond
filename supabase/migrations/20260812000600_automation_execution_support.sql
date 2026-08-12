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

-- ---------------------------------------------------------------------------
-- Widen the cron org-scan to match the occurrence lifecycle (Task 6)
--
-- `organizations_with_unanalyzed_mentions` (20260807000300) predates the
-- occurrence lifecycle and only ever checked "no analysis row at all". Once
-- `applyAnalysisOccurrence` could leave a durable classification whose
-- outcome was never applied — a crash between `recordAnalysisOccurrence` and
-- `applyAnalysisOccurrence` — `MentionRepository.listUnanalyzed` widened its
-- own selection to "no analysis row, OR a latest row whose outcome was never
-- applied" (see the doc comment on `OrganizationRepository.listWithUnanalyzedMentions`
-- in src/lib/data/types.ts, which named this exact migration as the fix).
-- This function did not move with it, and the gap is not cosmetic: an
-- organization whose only remaining work is a pending occurrence was not
-- offered to the cron sweep until some unrelated mention arrived with no
-- analysis row at all, silently deferring recovery from a crash that already
-- happened. `not exists (… and outcome_applied_at is not null)` is the same
-- predicate `listUnanalyzed` uses — a mention counts as needing work unless
-- it has a settled (applied) analysis row.
-- ---------------------------------------------------------------------------

create or replace function public.organizations_with_unanalyzed_mentions()
returns table (organization_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct m.organization_id
  from public.mentions m
  where not exists (
    select 1
    from public.mention_analyses a
    where a.mention_id = m.id
      and a.outcome_applied_at is not null
  );
$$;

comment on function public.organizations_with_unanalyzed_mentions is
  'Ids of organizations with at least one mention needing analysis work: no analysis row, or a latest row whose outcome was never applied. Widened in migration 20260812000600 to mirror MentionRepository.listUnanalyzed''s post-lifecycle selection exactly (see the doc comment on OrganizationRepository.listWithUnanalyzedMentions in types.ts) — an organization whose only remaining work is a pending occurrence (a crash between recordAnalysisOccurrence and applyAnalysisOccurrence) must still be swept, or that recovery never happens on its own. The one deliberately unscoped cross-tenant read behind the analyse-mentions cron sweep (Task 12) — mirrors monitoring_queries.listDue''s justification exactly. Never callable from a request path; the EXECUTE revoke below reasserts 20260807000400''s posture for this replaced definition.';

-- Same posture as the original definition (20260807000400): the implicit
-- PUBLIC grant and Supabase's default-privileges grant to anon/authenticated
-- both need revoking, and CREATE OR REPLACE preserves whatever privileges the
-- prior definition already carried — but this migration is meant to stand on
-- its own, so both revokes are reasserted here rather than assumed inherited.
-- No explicit grant to service_role: the project's default-privileges
-- bootstrap already grants it, exactly as the original migration relied on.
revoke execute on function public.organizations_with_unanalyzed_mentions() from public;
revoke execute on function public.organizations_with_unanalyzed_mentions() from anon, authenticated;
