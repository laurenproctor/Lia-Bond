-- Response generation's lifecycle functions (spec: response-generation v3).
-- All attempt mutations flow through these three; authenticated holds zero
-- direct DML on generation_attempts.
--
-- Lock discipline: claim and complete both acquire locks in the same order
-- — mention, then attempt — never the reverse. claim takes the mention row
-- FOR UPDATE explicitly, first, before touching generation_attempts at all.
-- complete does the same, explicitly, before its CAS update: it has to,
-- because its response_drafts insert (on the success path) implicitly takes
-- a FOR KEY SHARE lock on the same mention row via the mention_id FK. If
-- that implicit lock were the only place complete touched mentions, the two
-- functions would acquire mention and attempt in opposite orders — attempt
-- first, then mention, in complete; mention first, then attempt, in claim —
-- and concurrent traffic (a live lease vs. a completing worker) can deadlock
-- on that (40P01), with complete as the victim and no contract for it. So
-- complete locks the mention up front too, matching claim's order, and the
-- later implicit FK lock is redundant (already held) rather than a second,
-- reversed one. fail() never writes a draft and never touches mentions, so
-- it never participates in this ordering.
--
-- complete/fail are compare-and-set on (id, claim_token, status='pending')
-- so a stale worker can never overwrite a newer attempt's result. claim's
-- own two in-place updates (closing an expired lease, bumping a dedup
-- counter) carry the same status='pending' guard for the same reason: they
-- are read-then-write against a row nothing else here holds a lock on
-- (fail() can resolve it without ever touching the mention), so the WHERE
-- clause — not the row's identity alone — has to be what makes the write
-- correct.

create function public.claim_generation_attempt(
  p_mention_id uuid,
  p_context jsonb,
  p_context_hash text,
  p_prompt_version text,
  p_brand_voice_source brand_voice_source,
  p_brand_voice_version text,
  p_analysis_included boolean,
  p_lease_seconds integer default 120
) returns table (
  outcome text, attempt_id uuid, claim_token uuid, response_draft_id uuid
) language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_mention public.mentions;
  v_attempt public.generation_attempts;
  v_still_pending boolean := false;
  v_draft uuid;
  v_new public.generation_attempts;
begin
  -- One lock, taken first: the mention row. Also proves existence. See the
  -- file header for why complete() takes this same lock, in this same
  -- order, before its own attempt write.
  select * into v_mention from public.mentions
   where id = p_mention_id for update;
  if not found then
    raise exception 'mention % not found', p_mention_id using errcode = 'P0002';
  end if;

  -- response.generate restated in SQL (owner/admin/communications_lead),
  -- plus active membership — the onboarding-migration precedent.
  if not exists (
    select 1 from public.memberships ms
    where ms.user_id = auth.uid()
      and ms.organization_id = v_mention.organization_id
      and ms.status = 'active')
    or not public.has_organization_role(v_mention.organization_id,
      array['owner','admin','communications_lead']::membership_role[]) then
    raise exception 'response.generate is not granted to this user'
      using errcode = '42501';
  end if;

  if v_mention.source_type <> 'google_review' then
    raise exception 'generation supports google reviews only'
      using errcode = '22023';
  end if;

  -- Sweep first: load any pending attempt and close it out if its lease has
  -- expired, BEFORE the draft_exists check below. Ordered this way on
  -- purpose — draft_exists used to run first and would short-circuit every
  -- call once a draft existed (via any path, not just this flow), which
  -- left an expired attempt pinned at status='pending' forever: nothing
  -- ever reached this block again to sweep it, and generation_attempts_one_
  -- pending doesn't reap, it only prevents a second pending row. Now the
  -- sweep always runs first, so a stale lease gets closed even on a mention
  -- that already has a draft.
  select * into v_attempt from public.generation_attempts ga
   where ga.mention_id = p_mention_id and ga.status = 'pending';
  if found then
    if v_attempt.expires_at < now() then
      -- Guarded (and status = 'pending'): this is a read-then-write against
      -- a row we hold no lock on between the two statements — fail() can
      -- resolve this exact attempt without ever touching the mention we're
      -- holding (see the header), so under READ COMMITTED our UPDATE, if it
      -- blocks on fail()'s row lock, re-evaluates this WHERE clause against
      -- the post-fail() row version once it unblocks. Without the guard
      -- we'd blindly reassert status='failed'/failure_category on a row
      -- fail() already finished closing — same outcome, so harmless here —
      -- but the guard is what makes that true instead of assumed. Whether
      -- our own UPDATE or a concurrent fail() closed it, there is no longer
      -- a live pending attempt for this mention either way.
      update public.generation_attempts
         set status = 'failed', failure_category = 'lease_expired',
             finished_at = now(), updated_at = now()
       where id = v_attempt.id and status = 'pending';
      v_still_pending := false;
    else
      v_still_pending := true;
    end if;
  end if;

  -- D132: any draft blocks generation regardless of status.
  select rd.id into v_draft from public.response_drafts rd
   where rd.mention_id = p_mention_id
   order by rd.created_at desc, rd.id limit 1;
  if found then
    return query select 'draft_exists'::text, null::uuid, null::uuid, v_draft;
    return;
  end if;

  if v_still_pending then
    -- Guarded for the same reason as the expired-close branch above.
    update public.generation_attempts
       set dedup_hits = dedup_hits + 1, updated_at = now()
     where id = v_attempt.id and status = 'pending';
    if found then
      return query select 'in_progress'::text, v_attempt.id, null::uuid, null::uuid;
      return;
    end if;
    -- Zero rows: fail() resolved this attempt between our read and this
    -- update, so it is no longer actually in progress — reporting
    -- 'in_progress' with a stale attempt_id would be dishonest. Fall
    -- through to issue a fresh claim, exactly as if we'd found no pending
    -- attempt at all (the one-pending partial index is satisfied either
    -- way: the old row is no longer status='pending').
  end if;

  insert into public.generation_attempts
      (organization_id, mention_id, claimed_by_user_id, expires_at,
       context, context_hash, prompt_version, brand_voice_source,
       brand_voice_version, analysis_included)
  values (v_mention.organization_id, p_mention_id, auth.uid(),
          now() + make_interval(secs => p_lease_seconds),
          p_context, p_context_hash, p_prompt_version,
          p_brand_voice_source, p_brand_voice_version, p_analysis_included)
  returning * into v_new;
  return query select 'claimed'::text, v_new.id, v_new.claim_token, null::uuid;
end $$;

create function public.complete_generation_attempt(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_draft_text text,
  p_rendered_system_hash text,
  p_rendered_user_hash text,
  p_output_schema_version text,
  p_model_provider text,
  p_model_name text,
  p_max_output_tokens integer,
  p_temperature numeric,
  p_provider_request_id text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer
) returns table (outcome text, response_draft_id uuid)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_attempt public.generation_attempts;
  v_draft_id uuid;
begin
  -- Lock the mention first, matching claim's order (see the file header).
  -- Locks nothing if p_attempt_id doesn't resolve to a mention; the CAS
  -- below then finds no row either and returns 'superseded'.
  perform 1 from public.mentions
   where id = (select mention_id from public.generation_attempts where id = p_attempt_id)
     for update;

  -- CAS: only the pending attempt whose token this caller holds.
  update public.generation_attempts
     set updated_at = now()
   where id = p_attempt_id and claim_token = p_claim_token
     and status = 'pending'
  returning * into v_attempt;
  if not found then
    return query select 'superseded'::text, null::uuid; return;
  end if;

  -- Draft + completion + audit: one transaction (a generated draft
  -- without audit history is unrepresentable).
  insert into public.response_drafts
      (organization_id, mention_id, response_type, draft_text, status,
       generated_by, generation_provider, generation_model,
       prompt_version, brand_voice_version)
  values (v_attempt.organization_id, v_attempt.mention_id, 'public_reply',
          p_draft_text, 'draft', 'ai', p_model_provider, p_model_name,
          v_attempt.prompt_version, v_attempt.brand_voice_version)
  returning id into v_draft_id;

  update public.generation_attempts
     set status = 'completed', finished_at = now(),
         response_draft_id = v_draft_id,
         rendered_system_hash = p_rendered_system_hash,
         rendered_user_hash = p_rendered_user_hash,
         output_schema_version = p_output_schema_version,
         model_provider = p_model_provider, model_name = p_model_name,
         max_output_tokens = p_max_output_tokens,
         temperature = p_temperature,
         provider_request_id = p_provider_request_id,
         input_tokens = p_input_tokens, output_tokens = p_output_tokens,
         latency_ms = p_latency_ms, updated_at = now()
   where id = p_attempt_id;

  -- D162 posture: identifiers, versions, counts — never draft text.
  insert into public.audit_events
      (organization_id, actor_user_id, actor_type, event_type,
       entity_type, entity_id, previous_state, new_state, metadata)
  values (v_attempt.organization_id, v_attempt.claimed_by_user_id, 'ai',
          'response.generated', 'response_draft', v_draft_id, null, null,
          jsonb_build_object('mentionId', v_attempt.mention_id,
            'attemptId', p_attempt_id, 'promptVersion', v_attempt.prompt_version,
            'modelProvider', p_model_provider, 'modelName', p_model_name,
            'inputTokens', p_input_tokens, 'outputTokens', p_output_tokens,
            'latencyMs', p_latency_ms,
            'brandVoiceSource', v_attempt.brand_voice_source::text,
            'brandVoiceVersion', v_attempt.brand_voice_version));

  return query select 'completed'::text, v_draft_id;
end $$;

create function public.fail_generation_attempt(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_failure_category generation_failure_category,
  p_latency_ms integer,
  p_provider_request_id text
) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  update public.generation_attempts
     set status = 'failed', failure_category = p_failure_category,
         finished_at = now(), latency_ms = p_latency_ms,
         provider_request_id = p_provider_request_id, updated_at = now()
   where id = p_attempt_id and claim_token = p_claim_token
     and status = 'pending'
  returning id into v_id;
  if not found then return 'superseded'; end if;
  return 'failed';
end $$;

-- Retention mechanism (policy deliberately open — nothing calls this yet).
-- JSON-null sentinel: the column stays NOT NULL; a redacted snapshot reads
-- as jsonb 'null', distinguishable from any real context object.
create function public.redact_generation_snapshots(p_older_than interval)
returns integer
language sql security definer set search_path = public, pg_temp
as $$
  with redacted as (
    update public.generation_attempts
       set context = 'null'::jsonb, updated_at = now()
     where finished_at is not null
       and finished_at < now() - p_older_than
       and context <> 'null'::jsonb
    returning id)
  select count(*)::integer from redacted;
$$;

-- Grants (spec lines 180–186): claim/complete/fail stay executable by
-- authenticated — claim enforces the role check internally, and
-- complete/fail are useless without the CAS token only the claimant held.
-- Redaction is server-only (the consume_oauth_state convention).
revoke execute on function public.claim_generation_attempt(uuid, jsonb, text, text, brand_voice_source, text, boolean, integer) from public, anon;
revoke execute on function public.complete_generation_attempt(uuid, uuid, text, text, text, text, text, text, integer, numeric, text, integer, integer, integer) from public, anon;
revoke execute on function public.fail_generation_attempt(uuid, uuid, generation_failure_category, integer, text) from public, anon;
revoke execute on function public.redact_generation_snapshots(interval) from public, anon, authenticated;
grant execute on function public.redact_generation_snapshots(interval) to service_role;
