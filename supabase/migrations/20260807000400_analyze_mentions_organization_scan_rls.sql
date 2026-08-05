-- ---------------------------------------------------------------------------
-- Lock down organizations_with_unanalyzed_mentions()
--
-- SECURITY DEFINER and cross-tenant: the same posture as consume_oauth_state
-- and purge_expired_oauth_states in the Google integration migrations, and
-- the same reason. Only the cron path's service-role client calls this, and
-- the service role bypasses RLS anyway, so no grant to `authenticated` or
-- `anon` is issued — revoking from PUBLIC is what keeps a user session from
-- ever reaching a read that spans every tenant.
-- ---------------------------------------------------------------------------

revoke execute on function public.organizations_with_unanalyzed_mentions() from public;
