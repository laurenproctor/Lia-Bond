-- ---------------------------------------------------------------------------
-- Location write authority: owner and admin only
--
-- **Release R3 (contraction). This migration does NOT ship with R1.**
--
-- It is the one-way door in this rollout. After it runs, the application
-- deployed before R2 can no longer create a location during Google mapping,
-- because that version inserts into `locations` directly and this policy
-- refuses it. So it runs only once the R2 rollback window has closed — see the
-- rollout runbook in docs/architecture/current-state.md. Nothing in R2 needs
-- it: the application works because `create_and_map_location` exists
-- (20260814000300), not because these policies narrowed.
--
-- What it fixes. `locations_insert` and `locations_update` have used
-- `can_write_in_organization` since the initial schema, which admits owner,
-- admin, communications lead, **location manager, and approver**. Two of those
-- five have no business creating a restaurant record, and the update policy is
-- worse than the insert one: a location manager can reassign
-- `manager_user_id` — including to themselves — which is exactly the widening
-- that keeping `location.update_manager` at owner/admin was supposed to
-- prevent. The application check was the only thing standing in front of it.
--
-- Why the insert policy can be this narrow now. A communications lead still
-- needs a location to come into existence while mapping a Google listing, and
-- the database cannot tell that insert apart from a hand-typed one. It does not
-- have to: `create_and_map_location` is SECURITY DEFINER, derives the tenant
-- from the connection, checks `integration.manage_profiles`'s role list for
-- itself, and cannot produce a location without binding a profile to it. The
-- mapping path goes through that function; this policy governs everything else.
--
-- The product contract and the database contract now say the same thing, which
-- an earlier draft of this work did not: it left the policy open to
-- communications leads while the product claimed location administration was
-- owner/admin. Both cannot be true.
-- ---------------------------------------------------------------------------

drop policy if exists locations_insert on public.locations;
drop policy if exists locations_update on public.locations;
drop policy if exists locations_delete on public.locations;

create policy locations_insert on public.locations
  for insert to authenticated
  with check (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

create policy locations_update on public.locations
  for update to authenticated
  using (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  )
  with check (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

comment on policy locations_insert on public.locations is
  'Owner and admin only. The Google mapping path does NOT come through here — it calls create_and_map_location (20260814000300), which is SECURITY DEFINER, derives the organization from the connection, and cannot create a location without binding a profile to it. Do not widen this policy to restore communications-lead mapping; that would re-open direct, unbound location creation, which is the defect the function exists to close.';
comment on policy locations_update on public.locations is
  'Owner and admin only, matching the location.create/location.update permissions. Narrower than can_write_in_organization on purpose: under that gate a location manager could reassign manager_user_id to themselves, defeating location.update_manager being owner/admin.';

-- ---------------------------------------------------------------------------
-- No hard deletes, structurally
--
-- `locations_delete` (owner/admin) has existed since the initial schema with no
-- repository method behind it — a granted authority nothing in the product
-- uses. Locations are retired by moving to `inactive`, which keeps every
-- mention, mapping, draft, metric, and audit row attached to them.
--
-- Dropping the policy is not enough on its own. RLS policies filter a
-- privilege the role already holds; with the policy gone but DELETE still
-- granted, the next policy anybody adds to this table re-enables deletion
-- without them ever deciding to. The revoke is what makes "no hard deletes" a
-- property of the schema rather than of the current policy set — the same
-- belt-and-braces `audit_events` gets from 20260801000200 (update, delete) and
-- 20260812000200 (insert).
-- ---------------------------------------------------------------------------

revoke delete on public.locations from authenticated;

-- ---------------------------------------------------------------------------
-- Rollback, for the R3 phase of the rollout
--
-- Not executed. Restores the pre-contraction state exactly as
-- 20260801000200_row_level_security.sql wrote it.
--
--   drop policy if exists locations_insert on public.locations;
--   drop policy if exists locations_update on public.locations;
--   create policy locations_insert on public.locations
--     for insert to authenticated
--     with check (public.can_write_in_organization(organization_id));
--   create policy locations_update on public.locations
--     for update to authenticated
--     using (public.can_write_in_organization(organization_id))
--     with check (public.can_write_in_organization(organization_id));
--   create policy locations_delete on public.locations
--     for delete to authenticated
--     using (public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[]));
--   grant delete on public.locations to authenticated;
--
-- Note what rolling this back does *not* fix: an application rolled back past
-- R2 needs this, because that version maps by inserting directly. That
-- dependency is the whole reason this migration waits for the rollback window
-- to close instead of shipping with R1.
-- ---------------------------------------------------------------------------
