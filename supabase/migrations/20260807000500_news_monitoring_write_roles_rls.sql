-- ---------------------------------------------------------------------------
-- Narrow news-monitoring writes to the roles that may actually write
--
-- 20260806000600_news_monitoring_rls.sql gated every insert/update/delete
-- policy on these three tables with `is_organization_member`, the same
-- predicate the foundation reserves for *reading*. The foundation's own
-- convention — stated in this migration's comment on
-- `can_write_in_organization`, "Analysts and viewers are deliberately
-- absent: they read, they do not write" — was not followed here, and
-- `viewer` is the organization's default role
-- (20260801000100_initial_schema.sql).
--
-- Concretely: a `viewer` holding a valid session can currently create,
-- edit, and delete monitoring queries with no `monitoring.manage_queries`
-- permission (the application-layer check middleware.ts describes as a
-- convenience only — "the real enforcement is row-level security in
-- Postgres"), and can insert `news_poll_runs` rows directly. Because
-- `requestsSpentSince` sums `requests_spent` globally across every tenant by
-- design (D85), a single viewer inserting one inflated row can exhaust the
-- shared daily budget and halt scheduled polling for every organization on
-- the platform, repeatably. Deleting a monitoring query as a viewer also
-- cascades away its poll history and rejection log.
--
-- This migration is additive-only: it drops and recreates the seven write
-- policies below with the correct gate, leaves every `select` policy on
-- `is_organization_member` untouched (reading stays open to every member —
-- D19, and the rejected-candidates diagnostic rationale in D82), and does
-- not touch 20260806000200 itself — migrations are immutable once written.
--
-- Two different write gates, matching two different analogues:
--
--   - `monitoring_queries` and `news_poll_runs` decide what Lia watches and
--     record what happened when it looked — the same class of decision as
--     `automation_rules`, which this feature's own permission table
--     (`monitoring.manage_queries` / `monitoring.poll_now`, both scoped to
--     owner/admin/communications_lead in src/lib/auth/permissions.ts)
--     explicitly analogises to. Gated with `has_organization_role` against
--     that exact role list, matching `automation_rules_insert` and
--     `automation_rules_update` in 20260801000200_row_level_security.sql.
--
--   - `news_rejected_candidates` is written by the poll service on behalf of
--     every member who can trigger a poll, and by nothing else a human
--     writes directly — the closer analogue is a diagnostic/audit-style
--     table, not a configuration table. Gated with the foundation's general
--     `can_write_in_organization` (owner, admin, communications_lead,
--     location_manager, approver), one step broader than the
--     `manage_queries` role set and matching the majority of the
--     foundation's own write policies.
-- ---------------------------------------------------------------------------

-- monitoring_queries: was is_organization_member, now the manage_queries role set.

drop policy monitoring_queries_insert_members on public.monitoring_queries;
drop policy monitoring_queries_update_members on public.monitoring_queries;
drop policy monitoring_queries_delete_members on public.monitoring_queries;

create policy monitoring_queries_insert_write_roles
  on public.monitoring_queries for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy monitoring_queries_update_write_roles
  on public.monitoring_queries for update to authenticated
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

create policy monitoring_queries_delete_write_roles
  on public.monitoring_queries for delete to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

-- news_poll_runs: was is_organization_member, now the manage_queries role set
-- (poll_now shares the same three roles, so one gate covers both actions).

drop policy news_poll_runs_insert_members on public.news_poll_runs;
drop policy news_poll_runs_update_members on public.news_poll_runs;

create policy news_poll_runs_insert_write_roles
  on public.news_poll_runs for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy news_poll_runs_update_write_roles
  on public.news_poll_runs for update to authenticated
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

-- news_rejected_candidates: was is_organization_member, now can_write_in_organization.

drop policy news_rejected_candidates_insert_members on public.news_rejected_candidates;
drop policy news_rejected_candidates_delete_members on public.news_rejected_candidates;

create policy news_rejected_candidates_insert_writers
  on public.news_rejected_candidates for insert to authenticated
  with check (public.can_write_in_organization(organization_id));

create policy news_rejected_candidates_delete_writers
  on public.news_rejected_candidates for delete to authenticated
  using (public.can_write_in_organization(organization_id));
