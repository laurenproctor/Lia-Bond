-- Audit hardening (spec §6, closes F3). The original audit_events_insert
-- policy let any organization member append any event type with
-- actor_user_id null — forgeable system/AI attribution. Requiring
-- actor_user_id = auth.uid() would stop impersonation but not fabrication,
-- so authenticated inserts are removed entirely: audit rows are written
-- only by trusted server-side paths — the service-role adapter method and
-- the security-definer execution functions. Lands with the adapter switch;
-- the two are one behavior.
drop policy audit_events_insert on public.audit_events;
revoke insert on public.audit_events from authenticated;
