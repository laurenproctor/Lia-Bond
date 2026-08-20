-- Reddit ingest, attribution, run claiming, and removal verification.
--
-- Companion to rls-verification.sql, which proves the *policies*. This proves
-- the *functions*: that an ingest writes what it is allowed to and nothing
-- else, that location attribution is derived rather than claimed, that a run
-- can be claimed exactly once, and that a removal takes a whole thread with it
-- without erasing the customer's own workflow history.
--
-- Usage:
--   supabase db reset
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/reddit-verification.sql
--
-- Concurrency is NOT proved here — a single psql session cannot demonstrate
-- two transactions racing. `scripts/reddit-race-test.sh` drives that with two
-- FIFO-controlled sessions, statement by statement, so the interleaving is
-- reproducible rather than timing-dependent.
--
-- Every check raises on failure, so a clean run means every assertion held.

begin;

create or replace function pg_temp.check(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if not condition then
    raise exception 'REDDIT CHECK FAILED: %', label;
  end if;
  raise notice 'ok: %', label;
end;
$$;

create temporary table rf as
select
  (select id from public.organizations where slug = 'union-square-hospitality') as org,
  (select id from public.organizations where slug = 'harbor-and-vine')          as other_org,
  (select id from public.platform_connections
    where platform = 'reddit'
      and organization_id = (select id from public.organizations
                              where slug = 'union-square-hospitality')
    limit 1) as conn;

-- Two location-scoped monitors and one organization-wide one, so attribution
-- has something to agree and disagree about.
create temporary table rq as
with soho as (
  select id from public.locations
   where organization_id = (select org from rf) order by name limit 1
), tribeca as (
  select id from public.locations
   where organization_id = (select org from rf) order by name desc limit 1
), a as (
  insert into public.reddit_monitoring_queries (organization_id, name, terms, location_id)
  select (select org from rf), 'verify - soho', array['maison laurent'], (select id from soho)
  returning id
), b as (
  insert into public.reddit_monitoring_queries (organization_id, name, terms, location_id)
  select (select org from rf), 'verify - tribeca', array['maison laurent'], (select id from tribeca)
  returning id
), c as (
  insert into public.reddit_monitoring_queries (organization_id, name, terms, location_id)
  select (select org from rf), 'verify - brand wide', array['maison laurent'], null
  returning id
)
select (select id from a) as soho_q, (select id from b) as tribeca_q,
       (select id from c) as brand_q,
       (select id from soho) as soho_loc, (select id from tribeca) as tribeca_loc;

-- ---------------------------------------------------------------------------
-- 1. A post arrives, then arrives again unchanged, then changes.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; r record; m public.mentions;
begin
  select * into f from rf; select * into q from rq;

  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify1', null, 't3_verify1',
    'https://www.reddit.com/r/foodnyc/comments/verify1', 'Worth the hype?',
    'Thinking of booking.', 'u/someone', 't2_someone',
    now() - interval '2 hours', now(), 'foodnyc', 12, 3,
    false, false, false, null, '{}'::jsonb, array['maison laurent'], 0.9
  );
  perform pg_temp.check(r.outcome = 'created', 'a new post ingests as created');

  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify1', null, 't3_verify1',
    'https://www.reddit.com/r/foodnyc/comments/verify1', 'Worth the hype?',
    'Thinking of booking.', 'u/someone', 't2_someone',
    now() - interval '2 hours', now(), 'foodnyc', 12, 3,
    false, false, false, null, '{}'::jsonb, array['maison laurent'], 0.9
  );
  perform pg_temp.check(r.outcome = 'unchanged', 'a repeated identical post ingests as unchanged');

  -- A score move alone counts as a change: publishing and the workspace read
  -- these, and a thread that locked between two polls must not report
  -- `unchanged`.
  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify1', null, 't3_verify1',
    'https://www.reddit.com/r/foodnyc/comments/verify1', 'Worth the hype?',
    'Thinking of booking.', 'u/someone', 't2_someone',
    now() - interval '2 hours', now(), 'foodnyc', 40, 9,
    true, false, false, null, '{}'::jsonb, array['maison laurent'], 0.9
  );
  perform pg_temp.check(r.outcome = 'updated', 'a locked, re-scored post ingests as updated');

  select * into m from public.mentions where id = r.mention_id;
  perform pg_temp.check(m.source_is_locked, 'the lock state was written');
  perform pg_temp.check(m.status = 'new', 'ingest left the workflow status alone');
  perform pg_temp.check(m.source_last_verified_at is not null,
    'a successful ingest counts as a verification');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. An ingest cannot touch a human decision.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; r record; m public.mentions; target uuid;
begin
  select * into f from rf; select * into q from rq;

  select mention_id into target from public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify2', null, 't3_verify2',
    'https://www.reddit.com/r/foodnyc/comments/verify2', 'Server was rude',
    'Uncomfortable experience.', 'u/other', 't2_other',
    now() - interval '3 hours', now(), 'foodnyc', 5, 1,
    false, false, false, null, '{}'::jsonb, array['maison laurent'], 0.8
  );

  -- Somebody works it.
  update public.mentions
     set status = 'escalated', sentiment = 'negative', risk_level = 'high',
         relevance_score = 0.95
   where id = target;

  -- A later poll re-ingests it, with different content.
  perform public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify2', null, 't3_verify2',
    'https://www.reddit.com/r/foodnyc/comments/verify2', 'Server was rude (edited)',
    'Uncomfortable experience. Edited to add detail.', 'u/other', 't2_other',
    now() - interval '3 hours', now(), 'foodnyc', 30, 12,
    false, false, false, now(), '{}'::jsonb, array['maison laurent'], 0.8
  );

  select * into m from public.mentions where id = target;
  perform pg_temp.check(m.content like '%Edited to add detail%',
    'a provider edit updates the source-owned text');
  perform pg_temp.check(m.status = 'escalated',   'the escalated status survived a re-ingest');
  perform pg_temp.check(m.sentiment = 'negative', 'the analysed sentiment survived a re-ingest');
  perform pg_temp.check(m.risk_level = 'high',    'the analysed risk survived a re-ingest');
  perform pg_temp.check(m.relevance_score = 0.95, 'the analysed relevance survived a re-ingest');
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Location attribution is derived from the whole match set.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; r record; matches integer;
begin
  select * into f from rf; select * into q from rq;

  -- One located monitor: it wins.
  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, q.soho_q, 'reddit_post', 't3_verify3', null, 't3_verify3',
    'https://www.reddit.com/r/foodnyc/comments/verify3', 'Anniversary dinner',
    'Lovely evening.', 'u/ben', 't2_ben',
    now() - interval '4 hours', now(), 'foodnyc', 8, 2,
    false, false, false, null, '{}'::jsonb, array['maison laurent'], 0.85
  );
  perform pg_temp.check(r.location_id = q.soho_loc,
    'one located monitor attributes the thread to its location');

  -- The brand-wide monitor also matches. It abstains rather than vetoes: the
  -- common case is one brand monitor plus one location monitor, and treating
  -- the brand one as a dissenting vote would resolve that to nothing.
  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify3', null, 't3_verify3',
    'https://www.reddit.com/r/foodnyc/comments/verify3', 'Anniversary dinner',
    'Lovely evening.', 'u/ben', 't2_ben',
    now() - interval '4 hours', now(), 'foodnyc', 8, 2,
    false, false, false, null, '{}'::jsonb, array['maison laurent'], 0.85
  );
  perform pg_temp.check(r.location_id = q.soho_loc,
    'an organization-wide monitor abstains rather than clearing the attribution');

  -- A second *located* monitor disagrees, so the thread goes organization-wide
  -- rather than being stolen by whichever poll ran last.
  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, q.tribeca_q, 'reddit_post', 't3_verify3', null, 't3_verify3',
    'https://www.reddit.com/r/foodnyc/comments/verify3', 'Anniversary dinner',
    'Lovely evening.', 'u/ben', 't2_ben',
    now() - interval '4 hours', now(), 'foodnyc', 8, 2,
    false, false, false, null, '{}'::jsonb, array['maison laurent'], 0.85
  );
  perform pg_temp.check(r.location_id is null,
    'two disagreeing located monitors leave the thread organization-wide');

  -- Three matches, one mention. This is the whole point of the match table.
  select count(*) into matches from public.reddit_query_matches
   where mention_id = r.mention_id;
  perform pg_temp.check(matches = 3, 'three monitors produced three matches on one mention');

  select count(*) into matches from public.mentions
   where external_id = 't3_verify3' and organization_id = f.org;
  perform pg_temp.check(matches = 1, 'three monitors produced exactly one mention');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Comments.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; r record; refused boolean := false; m public.mentions;
begin
  select * into f from rf; select * into q from rq;

  -- A comment whose root Lia does not hold is refused. Without this a caller
  -- could attach a comment to a thread that does not exist — and the workspace
  -- loads a thread by root id, so it would surface there.
  begin
    perform public.ingest_reddit_mention(
      f.org, f.conn, null, 'reddit_comment', 't1_orphan', 't3_nothere', 't3_nothere',
      null, null, 'An orphan.', 'u/x', 't2_x',
      now(), now(), 'foodnyc', 1, 0, false, false, false, null, '{}'::jsonb, '{}'::text[], 0.5
    );
  exception when others then
    refused := true;
  end;
  perform pg_temp.check(refused, 'a comment with no stored root post is refused');

  -- A comment under a real root inherits the root's derived location.
  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, null, 'reddit_comment', 't1_verify4', 't3_verify1', 't3_verify1',
    'https://www.reddit.com/r/foodnyc/comments/verify1/c4', null,
    'Went last week, pacing was fine.', 'u/west4th', 't2_west4th',
    now() - interval '1 hour', now(), 'foodnyc', 4, 0,
    false, false, false, null, '{}'::jsonb, '{}'::text[], 0.5
  );
  perform pg_temp.check(r.outcome = 'created', 'a comment under a stored root ingests');

  select * into m from public.mentions where id = r.mention_id;
  perform pg_temp.check(m.conversation_root_external_id = 't3_verify1',
    'the comment carries the root fullname');
  perform pg_temp.check(m.external_parent_id = 't3_verify1',
    'the comment carries its direct parent');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Provenance refusals.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; refused boolean; other_conn uuid;
begin
  select * into f from rf; select * into q from rq;

  -- A connection belonging to another organization.
  select id into other_conn from public.platform_connections
   where organization_id = f.other_org limit 1;

  refused := false;
  begin
    perform public.ingest_reddit_mention(
      f.org, other_conn, q.brand_q, 'reddit_post', 't3_crosstenant', null, 't3_crosstenant',
      null, 'x', 'x', 'u/x', 't2_x', now(), now(), 'foodnyc', 1, 0,
      false, false, false, null, '{}'::jsonb, '{}'::text[], 0.5
    );
  exception when others then refused := true;
  end;
  perform pg_temp.check(refused, 'ingest refuses a connection from another organization');

  -- A source type that is not Reddit's.
  refused := false;
  begin
    perform public.ingest_reddit_mention(
      f.org, f.conn, q.brand_q, 'google_review', 'g_1', null, null,
      null, 'x', 'x', 'u/x', 't2_x', now(), now(), 'foodnyc', 1, 0,
      false, false, false, null, '{}'::jsonb, '{}'::text[], 0.5
    );
  exception when others then refused := true;
  end;
  perform pg_temp.check(refused, 'ingest refuses a non-Reddit source type');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Run claiming.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; a record; b record; c record;
begin
  select * into f from rf; select * into q from rq;

  select * into a from public.claim_reddit_poll_run(
    f.org, 'search', q.brand_q, null, 'scheduled', null, 900);
  perform pg_temp.check(a.claimed, 'the first claim on a monitor succeeds');

  select * into b from public.claim_reddit_poll_run(
    f.org, 'search', q.brand_q, null, 'scheduled', null, 900);
  perform pg_temp.check(not b.claimed and b.reason = 'in_progress',
    'a second claim on a live run is refused as in_progress');
  perform pg_temp.check(b.run_id = a.run_id,
    'the refused claim names the run that already holds it');

  -- An expired lease is taken over, and the abandoned run is closed as failed
  -- rather than deleted — a run that was claimed and never finished is a fact
  -- an operator needs.
  update public.reddit_poll_runs
     set claim_expires_at = now() - interval '1 minute' where id = a.run_id;

  select * into c from public.claim_reddit_poll_run(
    f.org, 'search', q.brand_q, null, 'scheduled', null, 900);
  perform pg_temp.check(c.claimed, 'an expired lease is taken over');
  perform pg_temp.check(c.run_id <> a.run_id, 'the takeover is a new run');
  perform pg_temp.check(
    (select status from public.reddit_poll_runs where id = a.run_id) = 'failed',
    'the abandoned run is closed as failed, not deleted'
  );
  perform pg_temp.check(
    (select error_code from public.reddit_poll_runs where id = a.run_id) = 'lease_expired',
    'the abandoned run records why it ended'
  );

  perform pg_temp.check(
    public.finalize_reddit_poll_run(c.run_id, 'completed', 3, 10, 2, 5, 0,
      '{"below_threshold": 8}'::jsonb, false, 250, null),
    'a live run finalizes'
  );
  perform pg_temp.check(
    not public.finalize_reddit_poll_run(c.run_id, 'completed'),
    'finalizing an already-finished run reports false rather than rewriting it'
  );
  perform pg_temp.check(
    not public.finalize_reddit_poll_run(a.run_id, 'completed'),
    'a stale worker cannot resurrect a run that was taken over'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The removal contract.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; root uuid; child uuid; affected integer;
  m public.mentions; audit_count integer; draft_count integer;
begin
  select * into f from rf; select * into q from rq;

  select id into root from public.mentions
   where organization_id = f.org and external_id = 't3_verify1';
  select id into child from public.mentions
   where organization_id = f.org and external_id = 't1_verify4';

  -- A draft against the root, to prove removal does not erase the customer's
  -- own workflow history along with Reddit's content.
  insert into public.response_drafts
    (organization_id, mention_id, response_type, draft_text, status, generated_by)
  values (f.org, root, 'public_reply', 'Thank you for the feedback.', 'draft', 'user');

  select mentions_affected into affected
    from public.record_reddit_removal(f.org, 't3_verify1', now(), true, 'deleted_at_source');
  perform pg_temp.check(affected = 2, 'removing a root takes its stored comment with it');

  select * into m from public.mentions where id = root;
  perform pg_temp.check(m.content = '',            'the root post body was purged');
  perform pg_temp.check(m.title is null,           'the root post title was purged');
  perform pg_temp.check(m.author_name is null,     'the author name was cleared');
  perform pg_temp.check(m.author_external_id is null, 'the author id was cleared');
  perform pg_temp.check(m.author_is_anonymous,     'the author is marked anonymous');
  perform pg_temp.check(m.raw_payload = '{}'::jsonb, 'the raw payload was emptied');
  perform pg_temp.check(m.source_metadata = '{}'::jsonb, 'the source metadata was emptied');
  perform pg_temp.check(m.source_removed_at is not null, 'the removal instant was recorded');

  select * into m from public.mentions where id = child;
  perform pg_temp.check(m.content = '', 'the comment body was purged with its root');
  perform pg_temp.check(m.author_name is null, 'the comment author was cleared');

  -- The row survives, and so does everything referencing it.
  select count(*) into draft_count from public.response_drafts where mention_id = root;
  perform pg_temp.check(draft_count = 1,
    'the customer''s own draft survived the upstream deletion');

  -- The audit event carries Lia ids and a reason code, and no content.
  select count(*) into audit_count from public.audit_events
   where entity_id = root and event_type = 'reddit_content.removed'
     and metadata::text not like '%Thinking of booking%'
     and metadata::text not like '%foodnyc%'
     and metadata::text not like '%someone%';
  perform pg_temp.check(audit_count = 1,
    'the removal audit event carries no content, community, or handle');
end;
$$;

do $$
declare
  f record; q record; cleared integer; m public.mentions; target uuid;
begin
  select * into f from rf; select * into q from rq;

  select mention_id into target from public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify5', null, 't3_verify5',
    null, 'Still up', 'The post remains, the account is gone.', 'u/gone', 't2_gone',
    now(), now(), 'foodnyc', 2, 0, false, false, false, null, '{}'::jsonb,
    array['maison laurent'], 0.7
  );

  -- The account is deleted while the post stays up. Lia holds no more of the
  -- person than it holds of anybody who never existed.
  select public.clear_reddit_author(f.org, 't2_gone') into cleared;
  perform pg_temp.check(cleared = 1, 'a deleted account clears its author fields');

  select * into m from public.mentions where id = target;
  perform pg_temp.check(m.author_name is null, 'the deleted account''s name is gone');
  perform pg_temp.check(m.content <> '',
    'the post itself remains — the account was deleted, not the content');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Data minimisation.
--
-- The `raw_payload` exception documented on `ingest_reddit_mention`. Nothing
-- stops a caller passing a whole provider object, so this pins the *default*
-- and the removal path rather than pretending the parameter is unreachable —
-- the connector's own tests are what prove it never passes one.
-- ---------------------------------------------------------------------------

do $$
declare
  f record; q record; r record; m public.mentions;
begin
  select * into f from rf; select * into q from rq;

  select * into r from public.ingest_reddit_mention(
    f.org, f.conn, q.brand_q, 'reddit_post', 't3_verify6', null, 't3_verify6',
    null, 'Minimal', 'Body.', 'u/min', 't2_min',
    now(), now(), 'foodnyc', 1, 0, false, false, false, null, null,
    array['maison laurent'], 0.6
  );

  select * into m from public.mentions where id = r.mention_id;
  perform pg_temp.check(m.raw_payload = '{}'::jsonb,
    'raw_payload defaults to empty rather than to a provider object');
  perform pg_temp.check(m.source_metadata = '{}'::jsonb,
    'a null source_metadata normalises to empty rather than to SQL null');
end;
$$;

rollback;
