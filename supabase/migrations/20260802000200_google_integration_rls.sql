-- Row-level security for the Google integration tables.
--
-- Same rule as the foundation: nothing is granted on the basis of being
-- authenticated. Two things here are stricter than that.

-- ---------------------------------------------------------------------------
-- oauth_states
--
-- RLS on, zero policies — the same posture as platform_connection_secrets.
--
-- An application user has no legitimate reason to read this table. Being able
-- to list pending handshakes for your own organization would expose the
-- redirect targets and timing of other members' connection attempts, and a
-- state hash is a lookup key for a live handshake. Every read and write goes
-- through the service role from the server, where the caller's identity has
-- already been established by session, not by SQL.
-- ---------------------------------------------------------------------------

alter table public.oauth_states enable row level security;

comment on table public.oauth_states is
  'Single-use OAuth handshakes. RLS enabled with zero policies: only the service role can read or write, and only from the server.';

-- The consume/purge helpers are SECURITY DEFINER and must not be reachable
-- from a user session. Only the service role calls them, and it bypasses RLS
-- anyway, so no grant to `authenticated` is issued.
revoke execute on function public.consume_oauth_state(text) from public;
revoke execute on function public.purge_expired_oauth_states() from public;

-- ---------------------------------------------------------------------------
-- platform_profiles
--
-- The foundation gave this table select/insert/update for the write roles but
-- no delete policy, which was right: disconnecting preserves mappings in an
-- inactive state rather than deleting them, and nothing in the product removes
-- a profile row. Left as-is deliberately.
--
-- Connecting and disconnecting an integration is already restricted to owners
-- and admins by the platform_connections policies. Profile mapping is a
-- separate decision, and the application layer applies the finer rule (see
-- src/lib/auth/permissions.ts) on top of the row-level write gate.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Audit trail integrity
--
-- Re-asserted rather than assumed: the foundation revoked UPDATE and DELETE on
-- audit_events, and this migration adds thirteen new event types to that table.
-- Re-running the revoke costs nothing and documents that widening the event
-- vocabulary did not widen who can rewrite it.
-- ---------------------------------------------------------------------------

revoke update, delete on public.audit_events from authenticated;
