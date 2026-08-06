-- ---------------------------------------------------------------------------
-- Row-level security for news monitoring
--
-- Reading is governed by active membership (D19): there is no view permission
-- for any of these, and rejected candidates in particular are diagnostic — the
-- person asking "why did we miss this" is often not an admin.
-- ---------------------------------------------------------------------------

alter table public.monitoring_queries enable row level security;
alter table public.news_poll_runs enable row level security;
alter table public.news_rejected_candidates enable row level security;

create policy monitoring_queries_select_members
  on public.monitoring_queries for select to authenticated
  using (public.is_organization_member(organization_id));

create policy monitoring_queries_insert_members
  on public.monitoring_queries for insert to authenticated
  with check (public.is_organization_member(organization_id));

create policy monitoring_queries_update_members
  on public.monitoring_queries for update to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy monitoring_queries_delete_members
  on public.monitoring_queries for delete to authenticated
  using (public.is_organization_member(organization_id));

create policy news_poll_runs_select_members
  on public.news_poll_runs for select to authenticated
  using (public.is_organization_member(organization_id));

create policy news_poll_runs_insert_members
  on public.news_poll_runs for insert to authenticated
  with check (public.is_organization_member(organization_id));

create policy news_poll_runs_update_members
  on public.news_poll_runs for update to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy news_rejected_candidates_select_members
  on public.news_rejected_candidates for select to authenticated
  using (public.is_organization_member(organization_id));

create policy news_rejected_candidates_insert_members
  on public.news_rejected_candidates for insert to authenticated
  with check (public.is_organization_member(organization_id));

create policy news_rejected_candidates_delete_members
  on public.news_rejected_candidates for delete to authenticated
  using (public.is_organization_member(organization_id));

-- ---------------------------------------------------------------------------
-- mentions
--
-- The four columns workflow 06 added to mentions (publisher_name,
-- publisher_domain, is_syndicated, monitoring_query_id) need no policy
-- change: RLS is per row, not per column, and the foundation's
-- mentions_select / mentions_insert / mentions_update policies already cover
-- them.
-- ---------------------------------------------------------------------------
