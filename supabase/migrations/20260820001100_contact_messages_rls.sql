-- ---------------------------------------------------------------------------
-- Marketing site — row-level security for contact messages
--
-- Row-level security is enabled and **no policy is created**, for the same
-- reason as `early_access_requests`: an anon INSERT policy would expose the
-- table at Supabase's REST endpoint, where anyone could write without passing
-- the honeypot, the length bounds, or the control-character stripping that
-- `@/lib/site/contact-message` enforces. The form would become the polite way
-- in and the endpoint the real one.
--
-- The stakes are higher here than on the lead table. These rows hold prose a
-- stranger wrote, and a readable policy would publish other people's messages
-- — including whatever they chose to put in them — to anyone holding the anon
-- key, which every visitor's browser does.
--
-- The server action uses `createSupabaseServiceClient`, which bypasses RLS by
-- design, so the validation cannot be skipped: the only credential that can
-- touch this table never reaches a browser.
--
-- FORCE is set so that even the table owner is subject to the (empty) policy
-- set. Only the service role, which bypasses RLS entirely, gets through.
-- ---------------------------------------------------------------------------

alter table public.contact_messages enable row level security;
alter table public.contact_messages force row level security;
