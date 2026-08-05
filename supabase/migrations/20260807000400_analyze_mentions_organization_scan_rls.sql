-- ---------------------------------------------------------------------------
-- Lock down organizations_with_unanalyzed_mentions()
--
-- SECURITY DEFINER and cross-tenant: the same posture as consume_oauth_state
-- and purge_expired_oauth_states in the Google integration migrations, and
-- the same reason. Only the cron path's service-role client calls this, and
-- the service role bypasses RLS anyway, so no legitimate caller needs a
-- grant.
--
-- Both revokes below are required, not one or the other. `revoke ... from
-- public` removes only the implicit EXECUTE grant Postgres attaches to every
-- new function by default. It does NOT remove the explicit grant Supabase's
-- project bootstrap issues separately via `alter default privileges in
-- schema public grant all on functions to postgres, anon, authenticated,
-- service_role` — migrations run as `postgres`, so a newly created function
-- picks up that default-privileges grant to `anon` and `authenticated` in
-- addition to the `PUBLIC` one, and revoking only `PUBLIC` leaves both of
-- those in place. A `SECURITY DEFINER` function reachable by `anon` bypasses
-- RLS on every table it touches — this one would otherwise be callable at
-- `POST /rest/v1/rpc/organizations_with_unanalyzed_mentions` by anyone
-- holding the anon key, no session required, returning every tenant's
-- organization ids. Whoever adds the next SECURITY DEFINER function in this
-- schema should copy both statements, not just the first.
-- ---------------------------------------------------------------------------

revoke execute on function public.organizations_with_unanalyzed_mentions() from public;
revoke execute on function public.organizations_with_unanalyzed_mentions() from anon, authenticated;
