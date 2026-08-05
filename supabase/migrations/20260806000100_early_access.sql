-- ---------------------------------------------------------------------------
-- Marketing site — early access requests
--
-- The one table in this schema that is not owned by an organization, because
-- the rows predate any organization existing. A lead is a stranger who typed an
-- address into a public form; there is no tenant to scope them to yet.
--
-- That makes it the only table written by an unauthenticated code path, so the
-- constraints here are the last line rather than a formality. Lengths are
-- bounded at the column, the address is unique case-insensitively, and the
-- companion RLS migration grants nobody any access at all — the server action
-- uses the service-role client, which is what keeps the write behind the
-- application's validation instead of exposed at the REST endpoint.
-- ---------------------------------------------------------------------------

create table public.early_access_requests (
  id uuid primary key default gen_random_uuid(),

  -- 320 is the practical maximum length of an address. The schema in
  -- `@/lib/site/early-access` lowercases before insert; the index below is on
  -- lower(email) anyway, so a row written by some other path still dedupes.
  email text not null check (length(email) between 3 and 320),

  business_name text check (business_name is null or length(business_name) between 1 and 200),

  -- Left as text rather than an enum. The marketing site's vertical list is a
  -- copy decision that changes with campaigns, and a migration per campaign is
  -- a bad trade for a column nothing joins on. The vocabulary is enforced in
  -- the Zod schema, which is the thing that actually runs on every write.
  industry text check (industry is null or length(industry) between 1 and 60),

  -- Which page converted. A path, never an absolute URL.
  source_path text check (source_path is null or source_path like '/%'),

  created_at timestamptz not null default now()
);

-- Case-insensitive, so Sam@ and sam@ are one lead rather than two.
create unique index early_access_requests_email_key
  on public.early_access_requests (lower(email));

-- The only query this table serves: most recent first.
create index early_access_requests_created_at_idx
  on public.early_access_requests (created_at desc);

comment on table public.early_access_requests is
  'Marketing site early-access signups. Written only by the service role via app/actions/early-access.ts.';
