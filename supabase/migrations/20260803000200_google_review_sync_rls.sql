-- Row-level security for review synchronization (workflow 03).
--
-- Same rule as everywhere else: nothing is granted on the basis of being
-- authenticated. A sync run is organization-owned, so it is gated on active
-- membership for reads and on the roles that may run a sync for writes.

alter table public.platform_sync_runs enable row level security;

-- Any active member may read the sync history. Knowing whether last night's
-- import worked is not a privileged question — an analyst looking at a quiet
-- week needs to be able to tell "no new reviews" from "the import is broken".
create policy platform_sync_runs_select on public.platform_sync_runs
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- Starting and finishing a run is narrower, and matches the
-- `integration.sync_reviews` row in src/lib/auth/permissions.ts. Location
-- managers are absent for the same reason they are absent from profile
-- mapping: a sync is an organization-wide operation against a shared
-- credential, with no location to scope them to.
create policy platform_sync_runs_insert on public.platform_sync_runs
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy platform_sync_runs_update on public.platform_sync_runs
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

-- No delete policy, deliberately. A sync run is evidence about what Lia did
-- with a customer's Google account, and nothing in the product removes one.
revoke delete on public.platform_sync_runs from authenticated;

comment on policy platform_sync_runs_select on public.platform_sync_runs is
  'Any active member may read sync history. Distinguishing "no new reviews" from "the import is failing" is not a privileged question.';

-- ---------------------------------------------------------------------------
-- mentions
--
-- The existing policies already cover the columns workflow 03 added: RLS is
-- per row, not per column, and the ingest path writes as the caller under
-- mentions_insert / mentions_update. Restated rather than assumed, because
-- adding columns to a table with an existing write policy is exactly the change
-- where "it was already covered" is worth checking rather than believing.
--
-- The Lia-owned-field protection is NOT expressible here. RLS cannot say "you
-- may update source_reply_text but not status", so that guarantee lives in the
-- ingest path in src/lib/data/* and is covered by tests instead.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Audit trail integrity
--
-- Re-asserted: this workflow widened the event vocabulary again, and widening
-- what may be written must not widen who may rewrite it.
-- ---------------------------------------------------------------------------

revoke update, delete on public.audit_events from authenticated;
