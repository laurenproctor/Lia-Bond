-- ---------------------------------------------------------------------------
-- Cross-tenant read for the analyse-mentions cron sweep
--
-- `analyzeMentions` (workflow 04) analyses one organization at a time, and
-- the repository layer deliberately has no `listAll()` for anything
-- organization-owned. Cron has no session and no organization, so the
-- scheduled sweep (Task 12) needs to know which organizations have work
-- before it can call the service at all.
--
-- Selecting `mentions` and `mention_analyses` in full and folding the anti-
-- join into application code — the first version of this read — silently
-- degrades once either table exceeds PostgREST's default row cap: the read
-- truncates with no error, and an organization whose unanalysed mentions
-- fell outside the returned page simply stops being swept, forever, with
-- nothing in a log to say so. A function pushes the anti-join into Postgres,
-- so the result set is organizations (small, bounded by tenant count), not
-- mentions (unbounded, grows with product usage).
-- ---------------------------------------------------------------------------

create or replace function public.organizations_with_unanalyzed_mentions()
returns table (organization_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct m.organization_id
  from public.mentions m
  where not exists (
    select 1
    from public.mention_analyses a
    where a.mention_id = m.id
  );
$$;

comment on function public.organizations_with_unanalyzed_mentions is
  'Ids of organizations with at least one mention lacking an analysis row. The one deliberately unscoped cross-tenant read behind the analyse-mentions cron sweep (Task 12) — mirrors monitoring_queries.listDue''s justification exactly. Selection matches MentionRepository.listUnanalyzed ("no analysis row"), not mentions.status = ''new'': a crash between analyzeOne''s mention-status update and its analysis insert leaves a mention whose status already advanced but which still has no analysis row, and that mention must still count. Never callable from a request path; see the paired RLS migration for the EXECUTE revoke.';
