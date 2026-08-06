-- ---------------------------------------------------------------------------
-- Marketing site — row-level security for early access requests
--
-- Row-level security is enabled and **no policy is created**. That is the whole
-- design, and it is deliberate rather than an omission.
--
-- The obvious alternative — an anon INSERT policy so the public form can write
-- directly — would expose the table at Supabase's REST endpoint, where anyone
-- could insert without passing the honeypot, the length bounds, or the industry
-- vocabulary that `@/lib/site/early-access` enforces. The form would become the
-- polite way in and the endpoint the real one.
--
-- Instead the server action uses `createSupabaseServiceClient`, which bypasses
-- RLS by design. The validation therefore cannot be skipped, because the only
-- credential that can write this table never reaches a browser.
--
-- FORCE is set so that even the table owner is subject to the (empty) policy
-- set. Only the service role, which bypasses RLS entirely, gets through.
-- ---------------------------------------------------------------------------

alter table public.early_access_requests enable row level security;
alter table public.early_access_requests force row level security;
