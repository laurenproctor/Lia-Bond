-- Voice-aware response generation for Google reviews (Task 2 of G1).
--
-- Schema: the generation_attempts table, its state-combination and tenant-integrity
-- constraints, the backing unique constraint for composite FKs, operational indexes,
-- and RLS (select-only, via is_organization_member).
--
-- The composite FK ga_mention_same_org targets the existing mentions_id_org unique
-- from migration 20260811000100_tenant_integrity_prereqs.sql. The composite FK
-- ga_draft_same_org requires a new unique on response_drafts(id, organization_id),
-- created before the generation_attempts table to resolve the FK.

create type generation_attempt_status as enum ('pending', 'completed', 'failed');
create type generation_failure_category as enum
  ('provider_error', 'invalid_output', 'lease_expired');
create type brand_voice_source as enum ('configured', 'default');

-- Backing unique constraint for the composite FK ga_draft_same_org.
alter table public.response_drafts add constraint response_drafts_id_org unique (id, organization_id);

create table public.generation_attempts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  mention_id          uuid not null,
  status              generation_attempt_status not null default 'pending',
  failure_category    generation_failure_category,
  claimed_by_user_id  uuid not null references public.users (id),
  -- Compare-and-set credential for complete/fail. Returned only to the
  -- claimant by claim_generation_attempt; never readable via select (the
  -- RLS select policy excludes it via a column grant revoke).
  claim_token         uuid not null default gen_random_uuid(),
  claimed_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  finished_at         timestamptz,
  response_draft_id   uuid,
  -- Immutable provenance (D130, revised per review item 2):
  context             jsonb not null,         -- the DraftingContext, verbatim
  context_hash        text not null,          -- sha256 of canonical context JSON
  prompt_version      text not null,          -- e.g. 'drafting@2026-08-07'
  rendered_system_hash text,                  -- sha256 of the rendered system prompt
  rendered_user_hash  text,                   -- sha256 of the rendered user message
  output_schema_version text,                 -- zod output schema version tag
  model_provider      text,
  model_name          text,
  max_output_tokens   integer,
  temperature         numeric,                -- null = provider default (current client)
  provider_request_id text,
  input_tokens        integer,
  output_tokens       integer,
  latency_ms          integer,
  brand_voice_source  brand_voice_source not null,
  brand_voice_version text,
  analysis_included   boolean not null,
  dedup_hits          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Review item 5: valid state combinations.
  constraint ga_pending_shape check (
    status <> 'pending'
    or (finished_at is null and failure_category is null and response_draft_id is null)
  ),
  constraint ga_completed_shape check (
    status <> 'completed'
    or (finished_at is not null and response_draft_id is not null and failure_category is null)
  ),
  constraint ga_failed_shape check (
    status <> 'failed'
    or (finished_at is not null and failure_category is not null and response_draft_id is null)
  ),
  constraint ga_lease_order   check (expires_at > claimed_at),
  constraint ga_counts_sane   check (
    coalesce(input_tokens, 0) >= 0 and coalesce(output_tokens, 0) >= 0
    and coalesce(latency_ms, 0) >= 0 and dedup_hits >= 0
  ),

  -- Tenant integrity (review item 5): composite FKs pin the mention and the
  -- draft to the same organization as the attempt. Requires the two backing
  -- unique constraints (mentions_id_org from 20260811000100_tenant_integrity_prereqs.sql
  -- and response_drafts_id_org created above) — a new pattern for this schema,
  -- called out in "Conflicts" — actor cross-org integrity is enforced in the claim
  -- function (claimed_by_user_id must hold an active membership; CHECKs
  -- cannot reference other tables).
  constraint ga_mention_same_org foreign key (mention_id, organization_id)
    references public.mentions (id, organization_id) on delete cascade,
  constraint ga_draft_same_org foreign key (response_draft_id, organization_id)
    references public.response_drafts (id, organization_id)
);

-- The concurrency backstop (defense in depth behind the serialized claim).
create unique index generation_attempts_one_pending
  on public.generation_attempts (mention_id) where status = 'pending';

-- Operational indexes (review item 6), each tied to a named query:
--   latestForMention (button state on the workspace):
create index generation_attempts_mention_recency_idx
  on public.generation_attempts (mention_id, created_at desc);
--   telemetry listing/counting per organization:
create index generation_attempts_org_recency_idx
  on public.generation_attempts (organization_id, created_at desc);
--   edited-before-approval metric join (attempt → its draft):
create index generation_attempts_draft_idx
  on public.generation_attempts (response_draft_id)
  where response_draft_id is not null;
-- No status/failure-category reporting index yet: no shipped query reads it
-- (the insights modules that would are unbuilt). Deliberate non-index.
-- No lease-expiration index: expiry is only ever evaluated for one mention's
-- pending row inside the claim, which the partial unique index already serves.

alter table public.generation_attempts enable row level security;

create policy generation_attempts_select on public.generation_attempts
  for select to authenticated
  using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.generation_attempts from authenticated;
-- The CAS credential is never readable: members see attempt existence and
-- state, never the token. Default table-level SELECT privilege makes a bare
-- `revoke select (claim_token)` inert — we must revoke the full table grant
-- and then re-grant only the safe columns.
revoke select on public.generation_attempts from authenticated;
grant select (id, organization_id, mention_id, status, failure_category,
  claimed_by_user_id, claimed_at, expires_at, finished_at, response_draft_id,
  context, context_hash, prompt_version, rendered_system_hash, rendered_user_hash,
  output_schema_version, model_provider, model_name, max_output_tokens, temperature,
  provider_request_id, input_tokens, output_tokens, latency_ms, brand_voice_source,
  brand_voice_version, analysis_included, dedup_hits, created_at, updated_at)
  on public.generation_attempts to authenticated;
