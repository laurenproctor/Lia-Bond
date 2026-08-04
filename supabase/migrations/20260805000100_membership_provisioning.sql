-- ---------------------------------------------------------------------------
-- Workflow 05 — sign-up, invitations, and member management
--
-- Three gaps this closes, all of them structural rather than cosmetic:
--
-- 1. Nothing created a `public.users` row. The invariant that
--    `auth.users.id = public.users.id` was upheld only by a development
--    script, so any account created another way authenticated perfectly and
--    then saw nothing at all. A trigger now mirrors the profile, which makes
--    the invariant hold by construction instead of by discipline.
--
-- 2. Nothing could create an organization. `public.organizations` has no
--    INSERT policy and `memberships_insert_admins` requires already being an
--    admin, so a brand-new user was locked out of an app with no way in.
--    Provisioning is a SECURITY DEFINER function, not a loosened policy: the
--    ability to create an organization for *yourself* must not become the
--    ability to insert a membership row for anyone.
--
-- 3. `membership_status = 'invited'` existed in the enum with nothing to
--    create it. Invitations are now a real table with a real acceptance path.
--
-- Every function here is SECURITY DEFINER with a pinned search_path, and every
-- one derives the acting user from `auth.uid()` rather than from an argument.
-- A caller can therefore only ever act as themselves, which is what makes
-- definer rights safe to hand out.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Profile mirror
--
-- `public.users` is a profile, not a credential store, and it must exist
-- before any membership can reference it.
--
-- ON CONFLICT (id) DO NOTHING rather than DO UPDATE: the seed loads
-- `public.users` first and `npm run auth:seed` then creates the matching auth
-- accounts, so this trigger fires against rows that already exist and must
-- leave their curated names alone.
--
-- A conflict on `email` is deliberately left to raise. That can only happen
-- when an address already belongs to a different id, and an account silently
-- linked to the wrong profile is far worse than a sign-up that fails loudly.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    -- full_name is NOT NULL. Sign-up collects it, but an account created from
    -- the Supabase dashboard carries no metadata, and failing that insert
    -- would make the dashboard unable to create users at all.
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    nullif(trim(new.raw_user_meta_data ->> 'avatar_url'), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_auth_user is
  'Mirrors a new auth account into public.users so auth.users.id = public.users.id holds by construction.';

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Email is displayed in member lists and is what an invitation is matched
-- against, so a change in auth must not leave the profile stale.
create or replace function public.handle_auth_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.users
     set email = new.email,
         updated_at = now()
   where id = new.id
     and email is distinct from new.email;

  return new;
end;
$$;

comment on function public.handle_auth_user_email_change is
  'Keeps the profile email in step with the auth record. Member lists and invitation matching both read it.';

drop trigger if exists on_auth_user_email_changed on auth.users;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_auth_user_email_change();

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'invitation_status') then
    create type invitation_status as enum ('pending', 'accepted', 'revoked');
  end if;
end;
$$;

comment on type invitation_status is
  'Lifecycle of an invitation. Expiry is NOT a status: it is derived from expires_at, so no scheduled job is needed to keep the table honest.';

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Stored lower-cased. Acceptance compares this against the accepting
  -- account's address, so a case difference must not be able to reject a
  -- legitimate invitee.
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role membership_role not null default 'viewer',
  -- Only the SHA-256 hash of the token, for the same reason oauth_states holds
  -- a hash: read access to this table must not be enough to accept somebody
  -- else's invitation. See D11.
  token_hash text not null unique,
  invited_by_user_id uuid references public.users (id) on delete set null,
  status invitation_status not null default 'pending',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_user_id uuid references public.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.invitations is
  'Pending offers of membership. The token itself is never stored — only its SHA-256 hash.';
comment on column public.invitations.token_hash is
  'SHA-256 of the invitation token. The raw value is shown to the inviter once and never persisted.';
comment on column public.invitations.email is
  'Lower-cased. Acceptance requires the signed-in account to match, which is what stops a forwarded link from admitting anyone who receives it.';

-- One live invitation per address per organization. A partial unique index
-- rather than application checks, matching platform_sync_runs_one_active:
-- two admins inviting the same person at the same moment should collide in
-- the database, not race.
create unique index if not exists invitations_one_pending_per_email
  on public.invitations (organization_id, email)
  where status = 'pending';

create index if not exists invitations_org_status_idx
  on public.invitations (organization_id, status, created_at desc);

drop trigger if exists invitations_set_updated_at on public.invitations;

create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Provisioning an organization
--
-- The only path that creates an organization. SECURITY DEFINER because the
-- caller holds no membership yet and therefore satisfies no policy — and
-- because the organization row and its owner membership must both exist or
-- neither must. A function body is a transaction, which is the one place this
-- codebase has that guarantee (see D17).
-- ---------------------------------------------------------------------------

create or replace function public.provision_organization(
  organization_name text,
  organization_industry text default 'Restaurant group',
  organization_timezone text default 'UTC',
  organization_language text default 'en-US'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  trimmed_name text := nullif(trim(organization_name), '');
  base_slug text;
  candidate_slug text;
  suffix integer := 1;
  new_organization_id uuid;
begin
  if actor is null then
    raise exception 'An authenticated caller is required to create an organization'
      using errcode = '28000';
  end if;

  if trimmed_name is null then
    raise exception 'Organization name is required'
      using errcode = '22023';
  end if;

  -- Derived here rather than accepted from the caller: the slug is globally
  -- unique and appears in links, so it is not a field a signing-up stranger
  -- should be able to choose.
  base_slug := trim(both '-' from regexp_replace(lower(trimmed_name), '[^a-z0-9]+', '-', 'g'));
  if base_slug = '' then
    base_slug := 'organization';
  end if;
  base_slug := left(base_slug, 40);

  candidate_slug := base_slug;
  while exists (select 1 from public.organizations o where o.slug = candidate_slug) loop
    suffix := suffix + 1;
    candidate_slug := base_slug || '-' || suffix;
    if suffix > 500 then
      raise exception 'Could not derive a unique slug for %', trimmed_name
        using errcode = '23505';
    end if;
  end loop;

  insert into public.organizations (
    name, slug, industry, website_url, default_timezone, default_language
  )
  values (
    trimmed_name,
    candidate_slug,
    coalesce(nullif(trim(organization_industry), ''), 'Restaurant group'),
    null,
    coalesce(nullif(trim(organization_timezone), ''), 'UTC'),
    coalesce(nullif(trim(organization_language), ''), 'en-US')
  )
  returning id into new_organization_id;

  -- Owner, active, and not negotiable: the role is written here rather than
  -- passed in, so this function cannot be used to mint a membership of any
  -- other shape.
  insert into public.memberships (organization_id, user_id, role, status)
  values (new_organization_id, actor, 'owner', 'active');

  return new_organization_id;
end;
$$;

comment on function public.provision_organization is
  'Creates an organization and the calling user''s owner membership, atomically. The user is taken from auth.uid(), never from an argument.';

-- ---------------------------------------------------------------------------
-- Reading an invitation before accepting it
--
-- Callable while signed out, because the person holding the link has not
-- created an account yet. It is keyed by the token hash, so answering proves
-- nothing to anyone who was not given the link, and it returns only what the
-- acceptance page must display.
-- ---------------------------------------------------------------------------

create or replace function public.invitation_preview(invitation_token_hash text)
returns table (
  organization_name text,
  invited_email text,
  invited_role membership_role,
  invitation_state text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    o.name,
    i.email,
    i.role,
    case
      when i.status = 'revoked' then 'revoked'
      when i.status = 'accepted' then 'accepted'
      when i.expires_at <= now() then 'expired'
      else 'pending'
    end
  from public.invitations i
  join public.organizations o on o.id = i.organization_id
  where i.token_hash = invitation_token_hash;
$$;

comment on function public.invitation_preview is
  'What the acceptance page needs, keyed by the token hash. Returns no row for an unknown token.';

-- ---------------------------------------------------------------------------
-- Accepting an invitation
--
-- The UPDATE is the gate. Every condition that must hold is in its WHERE
-- clause, so acceptance is single-use by construction: a replay loses the race
-- rather than being detected afterwards. Same reasoning as consuming an OAuth
-- state.
--
-- The email comparison is what makes a copyable link safe to send. Holding the
-- token is not sufficient; the accepting account must own the invited address.
-- ---------------------------------------------------------------------------

create or replace function public.accept_invitation(invitation_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  actor_email text;
  claimed public.invitations;
begin
  if actor is null then
    raise exception 'An authenticated caller is required to accept an invitation'
      using errcode = '28000';
  end if;

  select lower(u.email) into actor_email from auth.users u where u.id = actor;

  if actor_email is null then
    raise exception 'The accepting account has no email address'
      using errcode = '22023';
  end if;

  update public.invitations i
     set status = 'accepted',
         accepted_at = now(),
         accepted_by_user_id = actor
   where i.token_hash = invitation_token_hash
     and i.status = 'pending'
     and i.expires_at > now()
     and i.email = actor_email
  returning i.* into claimed;

  if claimed.id is null then
    -- Unknown, expired, already accepted, revoked, and addressed to somebody
    -- else all collapse into one answer. The caller is told which by
    -- invitation_preview *before* they get here; distinguishing them at this
    -- point would only grade an attacker's attempts.
    raise exception 'That invitation cannot be accepted'
      using errcode = 'P0002';
  end if;

  -- DO UPDATE rather than DO NOTHING: re-inviting somebody who was suspended,
  -- or who is being moved to a different role, has to actually take effect.
  insert into public.memberships (organization_id, user_id, role, status)
  values (claimed.organization_id, actor, claimed.role, 'active')
  on conflict (organization_id, user_id) do update
    set role = excluded.role,
        status = 'active',
        updated_at = now();

  return claimed.organization_id;
end;
$$;

comment on function public.accept_invitation is
  'Spends an invitation and grants the membership, atomically. Requires the caller''s own email to match the invited address.';

-- ---------------------------------------------------------------------------
-- Guardrail: an organization must keep at least one active owner
--
-- Enforced in the database rather than only in the server action, because
-- "the last owner demoted themselves" is unrecoverable through the UI — there
-- would be nobody left who could promote anyone. A constraint trigger holds
-- regardless of which code path performed the write.
-- ---------------------------------------------------------------------------

create or replace function public.assert_organization_keeps_an_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_organization uuid;
begin
  -- Branching on TG_OP rather than coalescing: in PL/pgSQL `new` is unassigned
  -- during a DELETE, and reading it there raises before any check can run.
  if tg_op = 'DELETE' then
    affected_organization := old.organization_id;
  else
    affected_organization := new.organization_id;
  end if;

  -- Skipped when the organization itself is going away: a cascading delete
  -- removes the owner row too, and that is not a lockout.
  if not exists (select 1 from public.organizations o where o.id = affected_organization) then
    return null;
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.organization_id = affected_organization
      and m.role = 'owner'
      and m.status = 'active'
  ) then
    raise exception 'An organization must always have at least one active owner'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

comment on function public.assert_organization_keeps_an_owner is
  'Refuses any write that would leave an organization with no active owner, which is an unrecoverable state through the UI.';

drop trigger if exists memberships_keep_an_owner on public.memberships;

-- DEFERRABLE INITIALLY DEFERRED so the check runs at commit rather than per
-- row. Handing ownership over is legitimately two statements — promote the
-- new owner, demote the old one — and a per-row check would reject whichever
-- order it was written in.
create constraint trigger memberships_keep_an_owner
  after update or delete on public.memberships
  deferrable initially deferred
  for each row execute function public.assert_organization_keeps_an_owner();

-- ---------------------------------------------------------------------------
-- Audit vocabulary
--
-- Invitations are recorded against entity_type 'membership' rather than a new
-- entity type. An invitation is a membership that has not been accepted yet,
-- and adding an enum value would need ALTER TYPE, which cannot be used in the
-- same transaction that writes it.
-- ---------------------------------------------------------------------------

alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      'escalation.assigned',
      'escalation.status_changed',
      'automation_rule.enabled',
      'automation_rule.disabled',
      'location.manager_changed',
      'integration.oauth_started',
      'integration.oauth_completed',
      'integration.connected',
      'integration.reauthorization_started',
      'integration.reauthorized',
      'integration.health_checked',
      'integration.health_degraded',
      'integration.profile_connected',
      'integration.profile_mapped',
      'location.created_from_integration',
      'integration.disconnected',
      'integration.credentials_revoked',
      'integration.credentials_revocation_failed',
      'integration.reviews_synced',
      'integration.review_sync_failed',
      'mention.analyzed',
      'mention.analysis_failed',
      'escalation.created_from_analysis',
      -- Workflow 05. Metadata carries roles, statuses, and email addresses —
      -- never an invitation token, which would make the trail a way in.
      'organization.created',
      'membership.invited',
      'membership.invitation_revoked',
      'membership.joined',
      'membership.role_changed',
      'membership.status_changed',
      'membership.removed'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. Membership events must never carry an invitation token in metadata.';
