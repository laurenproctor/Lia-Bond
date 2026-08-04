-- Row-level security for brand voice.
--
-- Same rule as everywhere else: nothing is granted on the basis of being
-- authenticated.

alter table public.brand_voice_profiles enable row level security;

-- Any active member may read it. How the product is configured to speak is not
-- a privileged question — an analyst reading a draft should be able to see the
-- rules it was written under.
create policy brand_voice_profiles_select on public.brand_voice_profiles
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- Writing matches the `brand_voice.update` row in src/lib/auth/permissions.ts.
-- Restated here rather than trusted to the application: a check in application
-- code protects only the path that runs it.
create policy brand_voice_profiles_insert on public.brand_voice_profiles
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy brand_voice_profiles_update on public.brand_voice_profiles
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  )
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

-- No delete policy. There is no product action that removes a voice; resetting
-- means saving the defaults, which keeps the audit trail intact.
revoke delete on public.brand_voice_profiles from authenticated;

comment on policy brand_voice_profiles_select on public.brand_voice_profiles is
  'Any active member may read the configured voice. Reading the rules a draft was written under is not privileged.';
