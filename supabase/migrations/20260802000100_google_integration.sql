-- Google Business Profile integration (workflow 02).
--
-- Adds what a real OAuth connection needs beyond the placeholder columns from
-- the foundation: granted scopes, connection health, attribution, encrypted
-- credential envelopes, provider metadata on mapped profiles, and a table for
-- single-use OAuth handshakes.
--
-- No review data is introduced here. Nothing in this migration reads, stores,
-- or prepares storage for a Google review — that is workflow 03.

-- ---------------------------------------------------------------------------
-- Connection health
--
-- Deliberately finer-grained than platform_connection_status. "Google is rate
-- limiting us" and "the user revoked our access" both leave a connection
-- unusable, but only one is fixed by re-consenting, and collapsing them would
-- send people to a consent screen that changes nothing.
-- ---------------------------------------------------------------------------

create type connection_health_status as enum (
  'healthy',
  'token_expiring',
  'authorization_required',
  'insufficient_permissions',
  'quota_limited',
  'provider_unavailable',
  'unknown_error'
);

comment on type connection_health_status is
  'Outcome of a connection health check. Mirrors CONNECTION_HEALTH_STATUSES in src/domain/enums.ts.';

-- ---------------------------------------------------------------------------
-- platform_connections
-- ---------------------------------------------------------------------------

alter table public.platform_connections
  add column granted_scopes text[] not null default '{}',
  add column provider_metadata jsonb not null default '{}'::jsonb,
  add column last_health_check_at timestamptz,
  add column last_health_status connection_health_status,
  add column last_error_code text,
  add column last_error_message text,
  add column connected_by_user_id uuid references public.users (id) on delete set null,
  add column connected_at timestamptz,
  add column disconnected_at timestamptz;

comment on column public.platform_connections.granted_scopes is
  'What the provider actually granted, which can be narrower than what was requested. Checked before a connection is treated as usable.';
comment on column public.platform_connections.provider_metadata is
  'Safe, displayable provider facts only — account type, verification state, registered domain. Never tokens, never raw error payloads.';
comment on column public.platform_connections.last_error_message is
  'Lia''s own sentence about the failure. Provider error text is deliberately not stored: it quotes request URLs and can echo parameters.';
comment on column public.platform_connections.connected_by_user_id is
  'Who authorised this connection. Nulled rather than cascaded so an offboarded employee does not erase the connection.';
comment on column public.platform_connections.disconnected_at is
  'Set on disconnect. The row is kept so audit history and profile mappings survive for reconnection.';

alter table public.platform_connections
  add constraint platform_connections_error_requires_code
    check (last_error_message is null or last_error_code is not null);

-- One connection per platform per organization.
--
-- The foundation's unique (organization_id, platform, external_account_id)
-- did not achieve this: Postgres treats NULLs as distinct, so any number of
-- rows with a null account id were permitted, and a reconnection could
-- accumulate duplicates that the integrations screen would render side by side.
alter table public.platform_connections
  drop constraint platform_connections_unique_account;

create unique index platform_connections_one_per_platform
  on public.platform_connections (organization_id, platform);

comment on index public.platform_connections_one_per_platform is
  'One connection row per platform per organization. Reauthorization updates it; disconnecting marks it rather than deleting it.';

create index platform_connections_health_idx
  on public.platform_connections (organization_id, last_health_status)
  where last_health_status is not null;

-- ---------------------------------------------------------------------------
-- platform_connection_secrets
--
-- Re-cut for encrypted envelopes. The foundation's access_token/refresh_token
-- columns were plain text and are dropped rather than reused: a column named
-- access_token holding ciphertext invites exactly the mistake this table
-- exists to prevent. Nothing is lost — no OAuth flow has ever run, so no rows
-- exist.
--
-- This table still has RLS enabled with zero policies, so only the service role
-- can reach it. See 20260802000200.
-- ---------------------------------------------------------------------------

alter table public.platform_connection_secrets
  drop column access_token,
  drop column refresh_token;

alter table public.platform_connection_secrets
  add column access_token_sealed text,
  add column refresh_token_sealed text,
  add column encryption_version text not null default 'v1',
  add column encryption_key_id text not null default 'default',
  add column access_token_expires_at timestamptz;

comment on column public.platform_connection_secrets.access_token_sealed is
  'AES-256-GCM envelope: v1.<keyId>.<iv>.<tag>.<ciphertext>. The key lives in the environment, so a database dump alone decrypts nothing.';
comment on column public.platform_connection_secrets.refresh_token_sealed is
  'Same envelope. Null is a real state: Google withholds the refresh token on silent re-consent, and the callback preserves the stored one.';
comment on column public.platform_connection_secrets.encryption_key_id is
  'Which key sealed these values. Present so keys can be rotated without a flag day.';

-- ---------------------------------------------------------------------------
-- platform_profiles
-- ---------------------------------------------------------------------------

alter table public.platform_profiles
  add column external_account_id text,
  add column verification_state text,
  add column provider_metadata jsonb not null default '{}'::jsonb,
  add column last_confirmed_at timestamptz;

comment on column public.platform_profiles.external_account_id is
  'The provider account this profile hangs off. Google nests locations under accounts, and a mapping is only valid within the account that owns it.';
comment on column public.platform_profiles.last_confirmed_at is
  'When Lia last saw this profile in a live provider listing. Distinguishes "not synced yet" from "no longer offered by the provider".';

-- A Lia location must not be wired to the same connection twice: two profiles
-- pointing at one restaurant would double-count every mention it produces.
create unique index platform_profiles_one_location_per_connection
  on public.platform_profiles (platform_connection_id, location_id)
  where location_id is not null;

comment on index public.platform_profiles_one_location_per_connection is
  'Stops one Lia location being mapped to two profiles on the same connection, which would duplicate every imported mention.';

create index platform_profiles_external_account_idx
  on public.platform_profiles (platform_connection_id, external_account_id)
  where external_account_id is not null;

-- ---------------------------------------------------------------------------
-- oauth_states
--
-- One row per handshake. The state value is never stored — only its SHA-256
-- hash — for the same reason a password is not stored in the clear: read access
-- to this table must not be enough to forge a callback.
--
-- Everything the callback authorises against is bound in at creation time and
-- never travels through the provider, so none of it can be tampered with in
-- transit.
-- ---------------------------------------------------------------------------

create table public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  provider platform not null,
  -- Hex SHA-256. Unique so a replayed value cannot create a second row.
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- Internal path, validated against a closed list in the application layer
  -- before it is written. Never a full URL: this is the parameter an
  -- open-redirect attack wants control of.
  redirect_path text not null check (redirect_path ~ '^/[A-Za-z0-9/_-]*$'),
  reauthorization boolean not null default false,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_states_expires_after_creation check (expires_at > created_at)
);

comment on table public.oauth_states is
  'Single-use OAuth handshakes. Stores a hash of the state, never the state itself. Service role only — see 20260802000200.';
comment on column public.oauth_states.state_hash is
  'SHA-256 of the state value, hex. The callback hashes what the provider returned and looks it up; a match proves the caller held the original.';
comment on column public.oauth_states.consumed_at is
  'Set by a conditional UPDATE that only matches unconsumed, unexpired rows, so consumption is atomic and replay loses the race.';

-- Lookup is always by hash, and only unconsumed rows can be redeemed.
create index oauth_states_pending_idx
  on public.oauth_states (state_hash)
  where consumed_at is null;

-- Supports sweeping expired handshakes.
create index oauth_states_expiry_idx on public.oauth_states (expires_at);

create index oauth_states_organization_idx
  on public.oauth_states (organization_id, created_at desc);

/**
 * Consume a handshake, atomically.
 *
 * Written as a single conditional UPDATE rather than a SELECT followed by an
 * UPDATE: two concurrent callbacks carrying the same state would both pass a
 * separate read, and only one may win. The WHERE clause is the lock.
 *
 * Returns the row only when it was this call that consumed it.
 */
create or replace function public.consume_oauth_state(target_state_hash text)
returns setof public.oauth_states
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.oauth_states
     set consumed_at = now()
   where state_hash = target_state_hash
     and consumed_at is null
     and expires_at > now()
  returning *;
$$;

comment on function public.consume_oauth_state is
  'Marks an OAuth handshake consumed and returns it, only if it was unconsumed and unexpired. Replays return zero rows.';

/**
 * Remove handshakes that will never be redeemed.
 *
 * Expired rows are useless but not harmless: they are a growing list of who
 * started connecting what and when. Swept rather than retained.
 */
create or replace function public.purge_expired_oauth_states()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from public.oauth_states
   where expires_at < now() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.purge_expired_oauth_states is
  'Deletes handshakes an hour past expiry. Called opportunistically when a new handshake starts; no scheduler required.';

-- ---------------------------------------------------------------------------
-- audit_events
--
-- Widen the closed event list to cover the integration lifecycle. Still a
-- closed list: a typo in an audit trail is worse than a failed insert.
-- ---------------------------------------------------------------------------

alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      'escalation.assigned',
      'escalation.status_changed',
      'automation_rule.enabled',
      'automation_rule.disabled',
      'location.manager_changed',
      'integration.oauth_started',
      'integration.oauth_completed',
      'integration.connected',
      'integration.reauthorization_started',
      'integration.reauthorized',
      'integration.health_checked',
      'integration.health_degraded',
      'integration.profile_connected',
      'integration.profile_mapped',
      'location.created_from_integration',
      'integration.disconnected',
      'integration.credentials_revoked',
      'integration.credentials_revocation_failed'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. Integration events must never carry tokens, authorization codes, or state values in metadata.';
