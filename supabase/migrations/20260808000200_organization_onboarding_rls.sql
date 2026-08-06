-- Row-level security for onboarding progress.
--
-- Same rule as everywhere else: nothing is granted on the basis of being
-- authenticated.

alter table public.organization_onboarding enable row level security;

-- Any active member may read it. The route guard in the application layout
-- runs for every signed-in person, not only owners — an analyst opening
-- `/overview` in an organization that is still being set up has to be told
-- something, and answering that question needs this row. Nothing sensitive is
-- here: step names and timestamps.
create policy organization_onboarding_select on public.organization_onboarding
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- Writing matches the `onboarding.manage` row in src/lib/auth/permissions.ts.
-- Restated here rather than trusted to the application: a check in application
-- code protects only the path that runs it.
--
-- Narrower than `can_write_in_organization` deliberately. Onboarding decides
-- what the whole organization sees on sign-in — a communications lead marking
-- setup complete would push everybody past a wizard whose steps they had no
-- authority to perform.
create policy organization_onboarding_insert on public.organization_onboarding
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin']::membership_role[]
    )
  );

create policy organization_onboarding_update on public.organization_onboarding
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin']::membership_role[]
    )
  )
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin']::membership_role[]
    )
  );

-- No delete policy, and the grant is revoked so the absence is deliberate
-- rather than incidental. There is no product action that removes onboarding
-- history, and deleting the row would read as "never onboarded" — which the
-- application treats as complete, so a delete would silently look like a
-- successful setup that never happened.
revoke delete on public.organization_onboarding from authenticated;

comment on policy organization_onboarding_select on public.organization_onboarding is
  'Any active member may read setup progress. The route guard runs for every role, so every role needs the read.';
comment on policy organization_onboarding_update on public.organization_onboarding is
  'Owners and admins only, mirroring the onboarding.manage permission. Narrower than can_write_in_organization on purpose.';
