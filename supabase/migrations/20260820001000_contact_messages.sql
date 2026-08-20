-- ---------------------------------------------------------------------------
-- Marketing site — contact messages
--
-- The contact form takes prose now, and prose needs somewhere to live. Until
-- this table existed the message was only ever in one place — the outbound
-- email — so a send that failed lost the question entirely, and the visitor
-- was told so because there was nothing else to tell them.
--
-- Deliberately **not** a column on `early_access_requests`. That table is
-- unique on `lower(email)`, which is right for a lead list and wrong for
-- questions: the second time someone writes, the insert conflicts and their
-- new message would be dropped on the floor. Questions are append-only, so
-- they get an append-only table.
--
-- The bounds below mirror `@/lib/site/contact-message` exactly. The Zod schema
-- is what runs on every write; these are the backstop for a row arriving by
-- some other path, and the two are meant to be read side by side.
-- ---------------------------------------------------------------------------

create table public.contact_messages (
  id uuid primary key default gen_random_uuid(),

  name text not null check (length(name) between 1 and 120),

  -- 320 is the practical maximum length of an address. Lowercased before
  -- insert by the schema; no unique index here, because two messages from one
  -- person are two messages.
  email text not null check (length(email) between 3 and 320),

  business_name text check (
    business_name is null or length(business_name) between 1 and 200
  ),

  -- 10 is the schema's minimum: shorter than that is not a question anyone can
  -- answer. 4000 is its maximum.
  message text not null check (length(message) between 10 and 4000),

  -- Which page they wrote from. A path, never an absolute URL, capped at 120
  -- to match the bound in `@/lib/site/form-text`.
  source_path text check (
    source_path is null or (source_path like '/%' and length(source_path) <= 120)
  ),

  created_at timestamptz not null default now(),

  -- When the notification actually left, or null if nobody has been told yet.
  -- This is the column that makes a failed send recoverable rather than
  -- merely logged: the message is saved either way, and this says whether it
  -- also reached a human.
  notified_at timestamptz
);

-- The list view: most recent first.
create index contact_messages_created_at_idx
  on public.contact_messages (created_at desc);

-- The query that matters after an outage — what came in that nobody was told
-- about. Partial, because the answer is normally empty and a partial index
-- stays small enough to be worth having.
create index contact_messages_unnotified_idx
  on public.contact_messages (created_at desc)
  where notified_at is null;

comment on table public.contact_messages is
  'Marketing site contact form messages. Written only by the service role via app/actions/contact.ts.';

comment on column public.contact_messages.notified_at is
  'When the support notification was sent. Null means the message was saved but nobody has been emailed about it.';
