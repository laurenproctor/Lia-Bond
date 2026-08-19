-- Atomic Reddit ingest, location attribution, run claiming, and the removal
-- contract (Task 4 of the Reddit plan).
--
-- Four responsibilities, one transaction each. The reason they are functions
-- rather than application code is the same one D166 gives for generation: the
-- writes have to agree, and an application that does them in sequence can be
-- interrupted between any two of them.
--
-- What is different here, and what shapes `ingest_reddit_mention`:
--
--   * One post can be found by several monitors, concurrently. The mention
--     must be written once and the match written per monitor, and the two
--     cannot race into two mentions.
--
--   * Location is *derived* from the whole match set rather than set by the
--     writer. News gets away with first-writer-wins because an article naming
--     two restaurants is rare and the attribution is cosmetic; on Reddit two
--     location monitors for one brand routinely match the same thread, and the
--     attribution decides which restaurant's team sees it. So the derivation
--     re-runs on every match, inside the same transaction that inserted it.
--
--   * A removal has to take the whole thread with it. A root post that is
--     deleted upstream means every comment Lia stored underneath it is content
--     the author has withdrawn, and honouring that one row at a time across
--     several statements would leave a partially-purged thread visible.
--
-- Content discipline: no function here writes Reddit text into an audit event,
-- and `record_reddit_removal` deliberately takes no content parameter at all.
-- An audit row about deleted content that quoted the content would defeat
-- itself.

-- ---------------------------------------------------------------------------
-- 1. Location attribution.
--
-- Unanimity or nothing. One location among the located matches wins;
-- disagreement leaves the mention organization-wide. Organization-wide matches
-- abstain rather than veto — a brand-wide monitor matching a thread says
-- nothing about which restaurant it concerns, so letting it dissent would
-- resolve the common case (one brand monitor plus one location monitor) to
-- nothing.
-- ---------------------------------------------------------------------------

create function public.derive_reddit_mention_location(p_mention_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- `(array_agg(distinct ...))[1]` rather than `min(...)`: Postgres has no
  -- `min(uuid)`. The count guard means the array holds exactly one element
  -- whenever this branch is taken, so which one is picked is not a question.
  select case
           when count(distinct q.location_id) = 1
             then (array_agg(distinct q.location_id))[1]
           else null
         end
    from public.reddit_query_matches m
    join public.reddit_monitoring_queries q
      on q.id = m.reddit_monitoring_query_id
   where m.mention_id = p_mention_id
     and q.location_id is not null;
$$;

comment on function public.derive_reddit_mention_location is
  'The location every located monitor matching this mention agrees on, or null. Null means organization-wide, which is also what disagreement means.';

-- ---------------------------------------------------------------------------
-- 2. Ingest.
--
-- Returns `created`, `updated`, or `unchanged` — the same vocabulary the
-- Google and news ingests report, so a Reddit poll's counts read the same way.
--
-- `p_raw_payload` defaults to `{}` and is bounded below. This is the Reddit
-- data-minimisation exception to the repository's standing "raw payload holds
-- the provider response verbatim" rule: a Reddit object carries far more about
-- a person than Lia has any reason to hold, under retention terms Lia has to
-- honour, so the connector stores the named columns and discards the rest.
-- ---------------------------------------------------------------------------

create function public.ingest_reddit_mention(
  p_organization_id uuid,
  p_platform_connection_id uuid,
  p_reddit_monitoring_query_id uuid,
  p_source_type mention_source_type,
  p_external_id text,
  p_external_parent_id text,
  p_conversation_root_external_id text,
  p_source_url text,
  p_title text,
  p_content text,
  p_author_name text,
  p_author_external_id text,
  p_published_at timestamptz,
  p_synced_at timestamptz,
  p_source_community text,
  p_source_score integer,
  p_source_comment_count integer,
  p_source_is_locked boolean,
  p_source_is_archived boolean,
  p_source_is_nsfw boolean,
  p_source_updated_at timestamptz,
  p_source_metadata jsonb,
  p_matched_terms text[],
  p_match_score numeric,
  p_raw_payload jsonb default '{}'::jsonb
) returns table (outcome text, mention_id uuid, location_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.mentions;
  v_mention_id uuid;
  v_outcome text;
  v_changed boolean;
  v_location uuid;
  v_root public.mentions;
begin
  if p_source_type not in ('reddit_post', 'reddit_comment') then
    raise exception 'ingest_reddit_mention refuses source type %', p_source_type
      using errcode = '22023';
  end if;

  -- Provenance, checked rather than trusted. Each of these would otherwise be
  -- a cross-tenant write: a caller naming another organization's connection or
  -- monitor, with its own organization id on the row.
  if not exists (
    select 1 from public.platform_connections
     where id = p_platform_connection_id
       and organization_id = p_organization_id
       and platform = 'reddit'
  ) then
    raise exception 'reddit connection % does not belong to organization %',
      p_platform_connection_id, p_organization_id using errcode = '42501';
  end if;

  if p_reddit_monitoring_query_id is not null and not exists (
    select 1 from public.reddit_monitoring_queries
     where id = p_reddit_monitoring_query_id
       and organization_id = p_organization_id
  ) then
    raise exception 'reddit monitor % does not belong to organization %',
      p_reddit_monitoring_query_id, p_organization_id using errcode = '42501';
  end if;

  -- A comment needs a root post Lia already holds, in the same organization
  -- and on the same connection. Without this a caller could attach a comment
  -- to a thread that does not exist, or worse, to one in another tenant — and
  -- the workspace loads a thread by root id, so the comment would surface
  -- there.
  if p_source_type = 'reddit_comment' then
    select * into v_root from public.mentions
     where organization_id = p_organization_id
       and platform_connection_id = p_platform_connection_id
       and source_type = 'reddit_post'
       and external_id = p_conversation_root_external_id;
    if not found then
      raise exception 'no root post % in organization % for this connection',
        p_conversation_root_external_id, p_organization_id using errcode = 'P0002';
    end if;
  end if;

  -- Insert first, and let the unique index arbitrate.
  --
  -- The obvious shape — `select ... for update`, then insert if absent — is
  -- wrong, and `scripts/reddit-race-test.sh` is what proved it rather than
  -- review. `for update` cannot lock a row that does not exist yet, so two
  -- monitors finding the same post concurrently both see nothing, both fall
  -- through, and the second dies on `mentions_unique_external`. That is not a
  -- rare interleaving on Reddit: two location monitors for one brand hitting
  -- the same thread is the ordinary case, and it would have failed one poll
  -- every time it happened.
  --
  -- `on conflict do nothing` is what actually serializes. It waits on the
  -- conflicting transaction, and then reports no row if that transaction
  -- committed, or inserts if it rolled back. The `select ... for update` below
  -- runs only on the path where the row demonstrably exists, and takes a fresh
  -- snapshot to find it — which is exactly when `for update` has something to
  -- lock.
  insert into public.mentions (
    organization_id, platform_connection_id, location_id, source_type,
    external_id, external_parent_id, conversation_root_external_id,
    source_url, title, content, author_name, author_external_id,
    published_at, received_at, raw_payload, source_metadata,
    source_community, source_score, source_comment_count,
    source_is_locked, source_is_archived, source_is_nsfw,
    source_updated_at, last_synced_at, source_last_verified_at
  ) values (
    p_organization_id, p_platform_connection_id,
    -- A comment inherits the root's derived location. Deriving it from the
    -- comment's own matches would be wrong: comments are not matched by
    -- monitors at all, they are collected because their thread was.
    case when p_source_type = 'reddit_comment' then v_root.location_id else null end,
    p_source_type, p_external_id, p_external_parent_id,
    p_conversation_root_external_id, p_source_url, p_title, p_content,
    p_author_name, p_author_external_id, p_published_at, p_synced_at,
    coalesce(p_raw_payload, '{}'::jsonb), coalesce(p_source_metadata, '{}'::jsonb),
    p_source_community, p_source_score, p_source_comment_count,
    p_source_is_locked, p_source_is_archived, p_source_is_nsfw,
    p_source_updated_at, p_synced_at, p_synced_at
  )
  on conflict on constraint mentions_unique_external do nothing
  returning id into v_mention_id;

  if v_mention_id is not null then
    v_outcome := 'created';
  else
    select * into v_existing from public.mentions
     where platform_connection_id = p_platform_connection_id
       and source_type = p_source_type
       and external_id = p_external_id
     for update;

    if not found then
      -- The conflicting row disappeared between the insert and this read,
      -- which means something deleted it concurrently. Better to fail loudly
      -- than to loop: a mention being deleted mid-ingest is not a state this
      -- system produces, and quietly retrying would hide whatever did.
      raise exception 'reddit mention % vanished during ingest', p_external_id
        using errcode = '40001';
    end if;

    v_mention_id := v_existing.id;

    -- Source-owned fields only. Everything absent from this list — status,
    -- sentiment, risk_level, relevance_score, received_at — is a decision a
    -- person or an analysis made, and a re-ingest has no authority over it.
    v_changed :=
      v_existing.content            is distinct from p_content
      or v_existing.title           is distinct from p_title
      or v_existing.author_name     is distinct from p_author_name
      or v_existing.source_url      is distinct from p_source_url
      or v_existing.source_score    is distinct from p_source_score
      or v_existing.source_comment_count is distinct from p_source_comment_count
      or v_existing.source_is_locked   is distinct from p_source_is_locked
      or v_existing.source_is_archived is distinct from p_source_is_archived
      or v_existing.source_is_nsfw     is distinct from p_source_is_nsfw
      or v_existing.source_updated_at  is distinct from p_source_updated_at
      or v_existing.source_metadata    is distinct from coalesce(p_source_metadata, '{}'::jsonb);

    update public.mentions set
      title                  = p_title,
      content                = p_content,
      author_name            = p_author_name,
      author_external_id     = p_author_external_id,
      source_url             = p_source_url,
      external_parent_id     = p_external_parent_id,
      conversation_root_external_id = p_conversation_root_external_id,
      source_community       = p_source_community,
      source_score           = p_source_score,
      source_comment_count   = p_source_comment_count,
      source_is_locked       = p_source_is_locked,
      source_is_archived     = p_source_is_archived,
      source_is_nsfw         = p_source_is_nsfw,
      source_updated_at      = p_source_updated_at,
      source_metadata        = coalesce(p_source_metadata, '{}'::jsonb),
      raw_payload            = coalesce(p_raw_payload, '{}'::jsonb),
      last_synced_at         = p_synced_at,
      -- A successful ingest *is* a verification that this still exists, which
      -- is what the retention clock reads.
      source_last_verified_at = p_synced_at,
      -- And it is alive again, if a previous pass had marked it gone. A
      -- Reddit post can return: a moderator removal can be reversed.
      source_removed_at      = null,
      updated_at             = case when v_changed then p_synced_at else v_existing.updated_at end
     where id = v_mention_id;

    v_outcome := case when v_changed then 'updated' else 'unchanged' end;
  end if;

  -- The match, and the attribution derived from it. Both inside the same
  -- transaction as the mention write, so a crash between them is impossible.
  if p_reddit_monitoring_query_id is not null then
    insert into public.reddit_query_matches (
      organization_id, reddit_monitoring_query_id, mention_id,
      matched_terms, match_score, first_matched_at, last_matched_at
    ) values (
      p_organization_id, p_reddit_monitoring_query_id, v_mention_id,
      coalesce(p_matched_terms, '{}'::text[]), p_match_score, p_synced_at, p_synced_at
    )
    on conflict on constraint reddit_query_matches_unique do update set
      -- `first_matched_at` is deliberately not updated: it records when this
      -- monitor first saw this thread, and a second poll did not first see it
      -- again.
      last_matched_at = excluded.last_matched_at,
      matched_terms   = excluded.matched_terms,
      match_score     = excluded.match_score,
      updated_at      = excluded.last_matched_at;

    -- Re-derived from the whole set, every time, rather than adjusted. A monitor
    -- can be edited to point at a different location, or deleted, and the
    -- attribution has to follow the matches that exist now.
    v_location := public.derive_reddit_mention_location(v_mention_id);

    -- Aliased because the OUT parameter `location_id` shadows the column
    -- everywhere it appears unqualified. The left-hand side of a SET is always
    -- a column so it needs no alias; every read of the old value does.
    update public.mentions as t
       set location_id = v_location,
           updated_at  = case when t.location_id is distinct from v_location
                              then p_synced_at else t.updated_at end
     where t.id = v_mention_id;

    -- A root post's location moving takes its comments with it: they were
    -- collected because of the thread, so they belong wherever the thread does.
    if p_source_type = 'reddit_post' then
      update public.mentions as t
         set location_id = v_location, updated_at = p_synced_at
       where t.organization_id = p_organization_id
         and t.source_type = 'reddit_comment'
         and t.conversation_root_external_id = p_external_id
         and t.location_id is distinct from v_location;
    end if;
  else
    select m.location_id into v_location from public.mentions m where m.id = v_mention_id;
  end if;

  return query select v_outcome, v_mention_id, v_location;
end;
$$;

comment on function public.ingest_reddit_mention is
  'Atomic Reddit upsert plus query match plus derived location attribution. Writes only source-owned fields; status, sentiment, risk, and received_at are never reachable from here.';

-- ---------------------------------------------------------------------------
-- 3. Run claiming.
--
-- Same shape as `claim_automation_sweep` (D164): lock the running row first,
-- so exactly one caller performs a stale-lease takeover and every other
-- concurrent caller blocks on that lock, re-reads, and receives the winner's
-- claim as an ordinary `claimed: false` rather than racing the insert.
-- ---------------------------------------------------------------------------

create function public.claim_reddit_poll_run(
  p_organization_id uuid,
  p_kind text,
  p_reddit_monitoring_query_id uuid,
  p_root_external_id text,
  p_trigger sync_trigger,
  p_actor_user_id uuid default null,
  p_lease_seconds integer default 900
) returns table (claimed boolean, run_id uuid, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_running public.reddit_poll_runs;
  v_new_id uuid;
begin
  -- Lock whatever is already running for this subject. Taking the lock before
  -- deciding whether the lease has expired is what stops two callers both
  -- deciding it has.
  select * into v_running from public.reddit_poll_runs
   where organization_id = p_organization_id
     and kind = p_kind
     and status = 'running'
     and reddit_monitoring_query_id is not distinct from p_reddit_monitoring_query_id
     and root_external_id is not distinct from p_root_external_id
   for update;

  if found then
    if v_running.claim_expires_at is not null and v_running.claim_expires_at <= now() then
      -- Expired lease. Close it as failed rather than deleting it: a run that
      -- was claimed and never finished is a fact an operator needs, and
      -- silently reusing the row would erase it.
      update public.reddit_poll_runs
         set status = 'failed', completed_at = now(),
             error_code = 'lease_expired', updated_at = now()
       where id = v_running.id;
    else
      return query select false, v_running.id, 'in_progress'::text;
      return;
    end if;
  end if;

  insert into public.reddit_poll_runs (
    organization_id, kind, reddit_monitoring_query_id, root_external_id,
    status, trigger, actor_user_id, claim_expires_at
  ) values (
    p_organization_id, p_kind, p_reddit_monitoring_query_id, p_root_external_id,
    'running', p_trigger, p_actor_user_id,
    now() + make_interval(secs => p_lease_seconds)
  ) returning id into v_new_id;

  return query select true, v_new_id, 'claimed'::text;
exception
  -- The partial unique indexes are the backstop behind the lock, not the
  -- mechanism. Absorbing only these three by name, and re-raising anything
  -- else, is D164's discipline: a partial unique index has no pg_constraint
  -- entry, so the constraint name in the diagnostics is the only identity
  -- available, and swallowing every unique_violation would hide an unrelated
  -- future constraint on this table.
  when unique_violation then
    declare
      v_constraint text;
    begin
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint not in (
        'reddit_poll_runs_one_active_search',
        'reddit_poll_runs_one_active_thread',
        'reddit_poll_runs_one_active_reconcile'
      ) then
        raise;
      end if;
      return query
        select false, r.id, 'in_progress'::text
          from public.reddit_poll_runs r
         where r.organization_id = p_organization_id
           and r.kind = p_kind
           and r.status = 'running'
           and r.reddit_monitoring_query_id is not distinct from p_reddit_monitoring_query_id
           and r.root_external_id is not distinct from p_root_external_id;
    end;
end;
$$;

create function public.finalize_reddit_poll_run(
  p_run_id uuid,
  p_status text,
  p_requests_spent integer default 0,
  p_posts_evaluated integer default 0,
  p_posts_accepted integer default 0,
  p_comments_ingested integer default 0,
  p_malformed_count integer default 0,
  p_rejected_reason_counts jsonb default '{}'::jsonb,
  p_truncated boolean default false,
  p_rate_limit_remaining integer default null,
  p_error_code text default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_status not in ('completed', 'failed') then
    raise exception 'finalize_reddit_poll_run refuses status %', p_status
      using errcode = '22023';
  end if;

  -- Compare-and-set on `status = 'running'`, so a worker whose lease expired
  -- and whose run was taken over by the claim above cannot resurrect it.
  update public.reddit_poll_runs set
    status = p_status,
    completed_at = now(),
    requests_spent = p_requests_spent,
    posts_evaluated = p_posts_evaluated,
    posts_accepted = p_posts_accepted,
    comments_ingested = p_comments_ingested,
    malformed_count = p_malformed_count,
    rejected_reason_counts = coalesce(p_rejected_reason_counts, '{}'::jsonb),
    truncated = p_truncated,
    rate_limit_remaining = p_rate_limit_remaining,
    -- A failed run must carry a code, and a completed one must not: the
    -- state-shape CHECKs enforce that, so this normalises rather than trusting
    -- the caller to have got it right.
    error_code = case when p_status = 'failed'
                      then coalesce(p_error_code, 'unknown_error') else null end,
    updated_at = now()
   where id = p_run_id and status = 'running';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The removal contract.
--
-- Content that stopped existing at the source. `p_purge` distinguishes the two
-- shapes the signed terms may demand: purge empties the text outright, redact
-- keeps the row as a tombstone with the content gone. Neither is a delete —
-- a mention id is referenced by analyses, escalations, drafts, and approvals,
-- and cascading those away would erase a customer's own workflow history
-- because somebody on Reddit deleted a comment.
--
-- Author identity is cleared in both shapes. A deleted Reddit account is a
-- withdrawal of the person, not just the words.
-- ---------------------------------------------------------------------------

create function public.record_reddit_removal(
  p_organization_id uuid,
  p_external_id text,
  p_removed_at timestamptz,
  p_purge boolean default true,
  p_reason text default 'deleted_at_source'
) returns table (mentions_affected integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.mentions;
  v_ids uuid[];
  v_count integer;
begin
  select * into v_target from public.mentions
   where organization_id = p_organization_id
     and external_id = p_external_id
   for update;

  if not found then
    return query select 0;
    return;
  end if;

  -- A removed root takes its whole stored thread. Every comment underneath it
  -- is content whose author posted into a discussion that no longer exists,
  -- and honouring the root's removal while leaving the replies visible would
  -- be the worst of both.
  if v_target.source_type = 'reddit_post' then
    select array_agg(id) into v_ids from public.mentions
     where organization_id = p_organization_id
       and (id = v_target.id
            or (source_type = 'reddit_comment'
                and conversation_root_external_id = v_target.external_id));
  else
    v_ids := array[v_target.id];
  end if;

  update public.mentions set
    source_removed_at = p_removed_at,
    source_last_verified_at = p_removed_at,
    -- Author identity goes in both shapes.
    author_name = null,
    author_external_id = null,
    author_avatar_url = null,
    author_is_anonymous = true,
    -- Purge empties the words; redact leaves them. `source_metadata` and
    -- `raw_payload` go either way — they are derived copies of the same
    -- content, and a retention obligation that spares them is not one.
    title = case when p_purge then null else title end,
    content = case when p_purge then '' else content end,
    source_metadata = '{}'::jsonb,
    raw_payload = '{}'::jsonb,
    updated_at = p_removed_at
   where id = any(v_ids);

  get diagnostics v_count = row_count;

  -- Lia's own row ids and a reason code. No content, no external id, no
  -- subreddit, no handle — an audit row about deleted content that quoted it
  -- would defeat itself.
  insert into public.audit_events (
    organization_id, actor_type, entity_type, entity_id, event_type, metadata
  ) values (
    p_organization_id, 'system', 'mention', v_target.id, 'reddit_content.removed',
    jsonb_build_object(
      'reason', p_reason,
      'purged', p_purge,
      'mentionsAffected', v_count,
      'rootRemoval', v_target.source_type = 'reddit_post'
    )
  );

  return query select v_count;
end;
$$;

comment on function public.record_reddit_removal is
  'Honours an upstream deletion across a whole stored thread in one transaction. Never deletes the mention row: analyses, escalations, and drafts reference it, and a customer''s workflow history must not be erased because somebody on Reddit deleted a comment.';

-- A Reddit account that is gone while its posts remain. Reddit shows these as
-- `[deleted]` authors on live content, and Lia holds no more of the person
-- than it holds of anybody who never existed.
create function public.clear_reddit_author(
  p_organization_id uuid,
  p_author_external_id text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.mentions set
    author_name = null,
    author_external_id = null,
    author_avatar_url = null,
    author_is_anonymous = true,
    updated_at = now()
   where organization_id = p_organization_id
     and author_external_id = p_author_external_id
     and source_type in ('reddit_post', 'reddit_comment');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants.
--
-- Every one of these is service-role only. There is no authenticated path to
-- any of them: ingest, run claiming, and removal all run from cron or from a
-- service-role worker, and none is a thing a session should be able to call.
-- `security definer` without this revoke would make them callable by anyone
-- who can reach PostgREST.
-- ---------------------------------------------------------------------------

revoke execute on function public.derive_reddit_mention_location(uuid)
  from public, anon, authenticated;
revoke execute on function public.ingest_reddit_mention(
  uuid, uuid, uuid, mention_source_type, text, text, text, text, text, text,
  text, text, timestamptz, timestamptz, text, integer, integer, boolean,
  boolean, boolean, timestamptz, jsonb, text[], numeric, jsonb
) from public, anon, authenticated;
revoke execute on function public.claim_reddit_poll_run(
  uuid, text, uuid, text, sync_trigger, uuid, integer
) from public, anon, authenticated;
revoke execute on function public.finalize_reddit_poll_run(
  uuid, text, integer, integer, integer, integer, integer, jsonb, boolean,
  integer, text
) from public, anon, authenticated;
revoke execute on function public.record_reddit_removal(
  uuid, text, timestamptz, boolean, text
) from public, anon, authenticated;
revoke execute on function public.clear_reddit_author(uuid, text)
  from public, anon, authenticated;
