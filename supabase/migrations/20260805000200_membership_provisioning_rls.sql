-- ---------------------------------------------------------------------------
-- Workflow 05 — row-level security for invitations, and function grants
--
-- The same rule as everywhere else in this schema: no policy grants access on
-- the basis of being authenticated. Reading an organization's invitations
-- requires an active membership in it; changing them requires owner or admin.
--
-- The token hash is a column on a table members can read, which is deliberate
-- and worth being explicit about. It is a SHA-256 digest, so a member who
-- reads it cannot derive the token that would accept the invitation — and any
-- member could see the invitee's address in the member list a moment later
-- anyway. What it buys is that a leaked backup is not a set of usable keys.
-- ---------------------------------------------------------------------------

alter table public.invitations enable row level security;
alter table public.invitations force row level security;

create policy invitations_select_members on public.invitations
  for select to authenticated
  using (public.is_organization_member(organization_id));

create policy invitations_insert_admins on public.invitations
  for insert to authenticated
  with check (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
    -- An invitation must be attributable. Allowing a caller to stamp somebody
    -- else as the inviter would make the audit trail a place to hide.
    and (invited_by_user_id is null or invited_by_user_id = auth.uid())
  );

create policy invitations_update_admins on public.invitations
  for update to authenticated
  using (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  )
  with check (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

create policy invitations_delete_admins on public.invitations
  for delete to authenticated
  using (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

comment on policy invitations_select_members on public.invitations is
  'Members see their own organization''s invitations. Acceptance does not read through this policy — the invitee is not a member yet, and goes through invitation_preview instead.';

-- ---------------------------------------------------------------------------
-- Function privileges
--
-- SECURITY DEFINER functions run with the owner's rights, so EXECUTE is the
-- only thing standing between them and any caller. Each is granted to exactly
-- the roles that must call it and revoked from PUBLIC first, because the
-- default grant on a new function is EXECUTE to PUBLIC.
-- ---------------------------------------------------------------------------

revoke execute on function public.handle_new_auth_user() from public;
revoke execute on function public.handle_auth_user_email_change() from public;
revoke execute on function public.assert_organization_keeps_an_owner() from public;
-- Trigger functions are invoked by the trigger, not by a caller. Nobody needs
-- EXECUTE, and granting it would let a client run the body directly.

revoke execute on function public.provision_organization(text, text, text, text) from public;
grant execute on function public.provision_organization(text, text, text, text) to authenticated;

revoke execute on function public.accept_invitation(text) from public;
grant execute on function public.accept_invitation(text) to authenticated;

-- The one function `anon` may call. The acceptance page has to render for
-- somebody who has not signed up yet, and it is keyed by a secret token hash,
-- so answering tells an anonymous caller nothing they did not already hold.
revoke execute on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to anon, authenticated;

comment on function public.invitation_preview is
  'What the acceptance page needs, keyed by the token hash. Callable while signed out; returns no row for an unknown token.';
