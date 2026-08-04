-- Row-level security for mention analysis (workflow 04).
--
-- Same rule as everywhere else: nothing is granted on the basis of being
-- authenticated.

alter table public.analysis_runs enable row level security;

-- Any active member may read the analysis history.
--
-- Deliberately wider than the write policy, matching the sync-run reasoning:
-- telling "no new mentions" from "the analyser has been failing for two days"
-- is not a privileged question. An analyst looking at a queue that stopped
-- moving needs to be able to answer it without asking an admin.
create policy analysis_runs_select on public.analysis_runs
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- Starting and finishing a run is narrower, and matches the
-- `mention.analyze` row in src/lib/auth/permissions.ts. Location managers are
-- absent: a run walks the whole organization's backlog, so there is no
-- location to scope them to.
create policy analysis_runs_insert on public.analysis_runs
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy analysis_runs_update on public.analysis_runs
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

-- No delete policy. A run is evidence of what Lia did with a customer's data
-- and what it spent doing it; nothing in the product removes one.
revoke delete on public.analysis_runs from authenticated;

comment on policy analysis_runs_select on public.analysis_runs is
  'Any active member may read analysis history. Distinguishing "nothing new" from "the analyser is broken" is not a privileged question.';

-- ---------------------------------------------------------------------------
-- mention_analyses
--
-- The foundation already grants select and insert to organization members and
-- writers respectively, and deliberately grants no update or delete — the
-- table is append-only, so re-analysing inserts a new row and readers take the
-- latest.
--
-- The columns added in 20260804000100 need no policy change: RLS is per row,
-- not per column. Restated rather than assumed, because adding columns to a
-- table with existing write policies is exactly where "it was already covered"
-- deserves checking rather than believing.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- escalations
--
-- Workflow 04 is the first thing that creates an escalation from code rather
-- than from a seed. The foundation's escalations_insert policy already permits
-- it for every writing role, and that is correct: an analysis run executes
-- under the caller's own session, and the caller has already been checked
-- against `mention.analyze`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Audit trail integrity
--
-- Re-asserted: this workflow widened the event vocabulary again, and widening
-- what may be written must not widen who may rewrite it.
-- ---------------------------------------------------------------------------

revoke update, delete on public.audit_events from authenticated;
