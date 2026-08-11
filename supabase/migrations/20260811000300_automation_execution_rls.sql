-- Automation execution RLS: select policies and revokes.
--
-- Executions are readable by administrators and location managers (for their
-- own locations' execution history). Sweeps are organization-level telemetry,
-- visible to administrators only. All mutation is revoked from authenticated.

alter table public.automation_rule_executions enable row level security;
alter table public.automation_sweeps enable row level security;

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

-- Sweep rows are organization-wide telemetry, visible to administrators only:
create policy sweeps_select_admin on public.automation_sweeps
  for select to authenticated
  using (public.has_organization_role(organization_id,
    array['owner','admin','communications_lead']::membership_role[]));

-- No insert/update/delete policies for authenticated, and revoked outright:
revoke insert, update, delete on public.automation_rule_executions from authenticated;
revoke insert, update, delete on public.automation_sweeps from authenticated;
