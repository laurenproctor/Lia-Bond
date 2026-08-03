-- Row-level security for every organization-owned table.
--
-- The rule enforced here: a request may only touch rows whose organization_id
-- matches an organization where the calling user holds an ACTIVE membership.
-- No policy in this file grants access on the basis of being authenticated.

-- ---------------------------------------------------------------------------
-- Helper functions
--
-- Both are SECURITY DEFINER on purpose. A policy on public.memberships that
-- called a plain function reading public.memberships would recurse into its own
-- policy; running as the definer reads the table without RLS and terminates.
-- search_path is pinned so the definer rights cannot be redirected at a
-- caller-controlled schema.
-- ---------------------------------------------------------------------------

create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

comment on function public.is_organization_member is
  'True when the caller holds an active membership in the given organization. Invited and suspended memberships grant nothing.';

create or replace function public.has_organization_role(
  target_organization_id uuid,
  allowed_roles membership_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = any (allowed_roles)
  );
$$;

comment on function public.has_organization_role is
  'True when the caller has an active membership in the organization AND holds one of the listed roles.';

-- Roles allowed to change data. Analysts and viewers are deliberately absent:
-- they read, they do not write.
create or replace function public.can_write_in_organization(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_organization_role(
    target_organization_id,
    array['owner', 'admin', 'communications_lead', 'location_manager', 'approver']::membership_role[]
  );
$$;

comment on function public.can_write_in_organization is
  'Write gate used by RLS. The application layer applies finer per-action rules on top of this.';

revoke execute on function public.is_organization_member(uuid) from public;
revoke execute on function public.has_organization_role(uuid, membership_role[]) from public;
revoke execute on function public.can_write_in_organization(uuid) from public;
grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.has_organization_role(uuid, membership_role[]) to authenticated;
grant execute on function public.can_write_in_organization(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.users                        enable row level security;
alter table public.organizations                enable row level security;
alter table public.memberships                  enable row level security;
alter table public.locations                    enable row level security;
alter table public.platform_connections         enable row level security;
alter table public.platform_connection_secrets  enable row level security;
alter table public.platform_profiles            enable row level security;
alter table public.mentions                     enable row level security;
alter table public.mention_analyses             enable row level security;
alter table public.response_drafts              enable row level security;
alter table public.approvals                    enable row level security;
alter table public.escalations                  enable row level security;
alter table public.automation_rules             enable row level security;
alter table public.audit_events                 enable row level security;

-- platform_connection_secrets intentionally receives NO policies. RLS is on and
-- nothing is permitted, so only the service role (which bypasses RLS) can read
-- or write OAuth material.

-- ---------------------------------------------------------------------------
-- users
--
-- A user may read their own profile and the profiles of people they share an
-- organization with — enough to render assignee pickers and member lists.
-- ---------------------------------------------------------------------------

create policy users_select_self_or_co_member on public.users
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.memberships mine
      join public.memberships theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid()
        and mine.status = 'active'
        and theirs.user_id = public.users.id
        and theirs.status = 'active'
    )
  );

create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------

create policy organizations_select_members on public.organizations
  for select to authenticated
  using (public.is_organization_member(id));

create policy organizations_update_admins on public.organizations
  for update to authenticated
  using (public.has_organization_role(id, array['owner', 'admin']::membership_role[]))
  with check (public.has_organization_role(id, array['owner', 'admin']::membership_role[]));

-- ---------------------------------------------------------------------------
-- memberships
--
-- Members see the roster of their own organizations. Only owners and admins may
-- change it, so nobody can promote themselves.
-- ---------------------------------------------------------------------------

create policy memberships_select_members on public.memberships
  for select to authenticated
  using (public.is_organization_member(organization_id));

create policy memberships_insert_admins on public.memberships
  for insert to authenticated
  with check (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

create policy memberships_update_admins on public.memberships
  for update to authenticated
  using (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  )
  with check (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

create policy memberships_delete_admins on public.memberships
  for delete to authenticated
  using (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

-- ---------------------------------------------------------------------------
-- Organization-owned business tables
--
-- Same shape throughout: read for any active member, write for the write roles.
-- The WITH CHECK clause is what stops a member of org A writing a row stamped
-- with org B.
-- ---------------------------------------------------------------------------

create policy locations_select on public.locations
  for select to authenticated using (public.is_organization_member(organization_id));
create policy locations_insert on public.locations
  for insert to authenticated with check (public.can_write_in_organization(organization_id));
create policy locations_update on public.locations
  for update to authenticated
  using (public.can_write_in_organization(organization_id))
  with check (public.can_write_in_organization(organization_id));
create policy locations_delete on public.locations
  for delete to authenticated
  using (public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[]));

create policy platform_connections_select on public.platform_connections
  for select to authenticated using (public.is_organization_member(organization_id));
create policy platform_connections_insert on public.platform_connections
  for insert to authenticated
  with check (public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[]));
create policy platform_connections_update on public.platform_connections
  for update to authenticated
  using (public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[]))
  with check (public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[]));
create policy platform_connections_delete on public.platform_connections
  for delete to authenticated
  using (public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[]));

create policy platform_profiles_select on public.platform_profiles
  for select to authenticated using (public.is_organization_member(organization_id));
create policy platform_profiles_insert on public.platform_profiles
  for insert to authenticated with check (public.can_write_in_organization(organization_id));
create policy platform_profiles_update on public.platform_profiles
  for update to authenticated
  using (public.can_write_in_organization(organization_id))
  with check (public.can_write_in_organization(organization_id));

create policy mentions_select on public.mentions
  for select to authenticated using (public.is_organization_member(organization_id));
create policy mentions_insert on public.mentions
  for insert to authenticated with check (public.can_write_in_organization(organization_id));
create policy mentions_update on public.mentions
  for update to authenticated
  using (public.can_write_in_organization(organization_id))
  with check (public.can_write_in_organization(organization_id));

create policy mention_analyses_select on public.mention_analyses
  for select to authenticated using (public.is_organization_member(organization_id));
create policy mention_analyses_insert on public.mention_analyses
  for insert to authenticated with check (public.can_write_in_organization(organization_id));

create policy response_drafts_select on public.response_drafts
  for select to authenticated using (public.is_organization_member(organization_id));
create policy response_drafts_insert on public.response_drafts
  for insert to authenticated with check (public.can_write_in_organization(organization_id));
create policy response_drafts_update on public.response_drafts
  for update to authenticated
  using (public.can_write_in_organization(organization_id))
  with check (public.can_write_in_organization(organization_id));

create policy approvals_select on public.approvals
  for select to authenticated using (public.is_organization_member(organization_id));
create policy approvals_insert on public.approvals
  for insert to authenticated with check (public.can_write_in_organization(organization_id));
-- Only approvers and admins decide. A communications lead may request approval
-- but must not grant it to their own draft.
create policy approvals_update on public.approvals
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'approver']::membership_role[]
    )
  )
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'approver']::membership_role[]
    )
  );

create policy escalations_select on public.escalations
  for select to authenticated using (public.is_organization_member(organization_id));
create policy escalations_insert on public.escalations
  for insert to authenticated with check (public.can_write_in_organization(organization_id));
create policy escalations_update on public.escalations
  for update to authenticated
  using (public.can_write_in_organization(organization_id))
  with check (public.can_write_in_organization(organization_id));

create policy automation_rules_select on public.automation_rules
  for select to authenticated using (public.is_organization_member(organization_id));
create policy automation_rules_insert on public.automation_rules
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );
create policy automation_rules_update on public.automation_rules
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

-- ---------------------------------------------------------------------------
-- audit_events
--
-- Members read their organization's trail. Anyone who can act can append.
-- Nobody can rewrite history: there is no UPDATE or DELETE policy, and the
-- privileges are revoked outright below so a future policy cannot re-open it
-- by accident.
-- ---------------------------------------------------------------------------

create policy audit_events_select on public.audit_events
  for select to authenticated using (public.is_organization_member(organization_id));

create policy audit_events_insert on public.audit_events
  for insert to authenticated
  with check (
    public.is_organization_member(organization_id)
    and (actor_user_id is null or actor_user_id = auth.uid())
  );

revoke update, delete on public.audit_events from authenticated;

comment on policy audit_events_insert on public.audit_events is
  'A user may only append events attributed to themselves or to a non-human actor.';
