-- Yelp Assisted: listing connection, activity detection, manual capture, and
-- assisted-posting provenance.
--
-- The shape is argued at length in docs/integrations/yelp-assisted.md; the
-- decisions worth restating where somebody will read them next to the DDL are
-- these.
--
-- 1. There is no `yelp_connections` table and no `yelp_listings` table.
--    `platform_connections` and `platform_profiles` already model "an
--    organization's link to a platform" and "one external presence bound to a
--    location", and `platform_sync_runs` already models "one attempt to
--    synchronise one resource from one profile" — complete with a `resource`
--    column added in workflow 03 precisely so a connection could later check
--    something other than reviews, and a partial unique index that makes the
--    lock real. Yelp needs exactly those three things. Forking them would
--    fork connection health, the integrations screen, and the disconnect
--    path (D21's reasoning, applied to connections rather than to mentions).
--
-- 2. Two new tables, and both exist because the existing ones cannot answer
--    the question. `yelp_listing_snapshots` records *what Lia observed*, which
--    `platform_sync_runs` does not hold (it records that a check happened, not
--    what it saw). `yelp_activity_occurrences` records *what changed between
--    two observations*, which neither holds and which is the entire product
--    surface of this feature.
--
-- 3. The counters are the whole evidence base, and the vocabulary says so.
--    There is deliberately no column anywhere below for "number of new
--    reviews". Yelp's review count moves when reviews are added, removed, or
--    reclassified by its recommendation software, and a schema that recorded a
--    delta as a review count would be a lie quoted back by every screen and
--    every report that ever read it. `change_kind` names what moved.
--
-- 4. New state vocabularies are check-constrained text, not Postgres enums,
--    following the reasoning the Reddit schema recorded: an enum value cannot
--    be dropped, and these lists are young. The existing enums that genuinely
--    fit (`sync_trigger`, `sync_run_status`) are reused rather than duplicated.
--
-- 5. Capture and publication provenance go on `mentions` and `response_drafts`
--    as platform-neutral columns, not on a Yelp-only side table. Manual
--    capture is what every provider without a readable review feed will need,
--    and a `yelp_captured_reviews` table would have to be merged back into the
--    inbox at exactly the moment there was real data to lose.

-- ---------------------------------------------------------------------------
-- 1. Capture provenance on mentions.
--
-- Answers "how did this content get here", which `source_type` does not:
-- `yelp_review` is equally true of a review an API returned and one a customer
-- typed, and those carry very different evidentiary weight. Every column here
-- is deliberately absent from `IngestMentionInput` in
-- src/domain/entities/mention.ts and from `SOURCE_OWNED_MENTION_FIELDS`, so no
-- synchronisation can relabel a typed review as retrieved, or the reverse.
-- ---------------------------------------------------------------------------

alter table public.mentions
  add column capture_method text not null default 'provider_api'
    check (capture_method in ('provider_api', 'manual_entry')),
  -- Nulled rather than cascaded, matching platform_sync_runs.actor_user_id: an
  -- offboarded employee must not erase the record that a capture happened.
  add column captured_by_user_id uuid references public.users (id) on delete set null,
  add column captured_at timestamptz,
  add column yelp_activity_occurrence_id uuid;

comment on column public.mentions.capture_method is
  'How this content reached Lia. provider_api means a provider returned it and a later sync may overwrite it; manual_entry means a person typed it, nothing can verify it, and no sync will ever refresh it. Never writable by an ingest.';
comment on column public.mentions.captured_by_user_id is
  'Who typed it. Null on every provider_api row, and null again if that person is later offboarded — the audit event is the durable record of who.';

-- A typed review has a typist; a fetched one does not.
--
-- Deliberately written as a pairing rather than two independent checks. The
-- failure this guards is not "a missing field" but "a row that claims one
-- provenance while carrying the evidence of the other" — a provider_api row
-- naming a capturing person reads, to every screen and every export, as a
-- fetched review somebody put their name on.
--
-- `captured_by_user_id` is excluded from the required half on purpose: the FK
-- nulls it when a user is deleted, and a constraint demanding it would turn
-- offboarding an employee into a failed transaction on rows they once touched.
alter table public.mentions
  add constraint mentions_capture_actor_pairing check (
    case
      when capture_method = 'manual_entry' then captured_at is not null
      else captured_at is null and captured_by_user_id is null
    end
  );

comment on constraint mentions_capture_actor_pairing on public.mentions is
  'A manual_entry mention must record when it was captured; a provider_api mention must record no capturing actor or moment at all. Deleting a user nulls captured_by_user_id, so that column is deliberately not required.';

-- The inbox filter for "reviews somebody typed in", and the join a Yelp
-- activity occurrence uses to find the review that answered it.
create index mentions_manual_capture_idx
  on public.mentions (organization_id, captured_at desc)
  where capture_method = 'manual_entry';

create index mentions_yelp_occurrence_idx
  on public.mentions (yelp_activity_occurrence_id)
  where yelp_activity_occurrence_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Publication provenance on response_drafts.
--
-- `published_at` says a response went public; these say on whose word. Without
-- them a reply a person told Lia they had posted is stored identically to one
-- a provider acknowledged, and that difference is the whole question when
-- somebody disputes a reply months later.
-- ---------------------------------------------------------------------------

alter table public.response_drafts
  add column publication_method text
    check (publication_method in ('provider_api', 'manual_external')),
  add column published_by_user_id uuid references public.users (id) on delete set null;

comment on column public.response_drafts.publication_method is
  'How the response reached the public. manual_external means a person posted it themselves and confirmed it here; Lia did not observe it and holds no provider acknowledgement. provider_api means a provider accepted it and returned an identifier. Nothing writes provider_api today — no connector can publish.';
comment on column public.response_drafts.published_by_user_id is
  'Who confirmed a manual publication. Not the approver, necessarily: one person signs the words off and another may carry them to the platform. Nulled on offboarding; the audit event is the durable record.';

-- Backfill before the constraint, so an existing published row cannot fail it.
--
-- The rule reads each row's own evidence rather than guessing: a draft
-- carrying a provider's reply identifier records a provider publication, and
-- one published without an identifier records a person having posted it. This
-- mirrors the derivation in src/lib/seed/dataset.ts exactly, so a seeded
-- database and a migrated one agree.
update public.response_drafts
   set publication_method =
         case when external_response_id is not null
              then 'provider_api'
              else 'manual_external'
         end
 where status = 'published'
   and publication_method is null;

-- A published response must say how it got there.
--
-- `published_by_user_id` is not required, for the same offboarding reason as
-- the capture pairing above.
alter table public.response_drafts
  add constraint response_drafts_published_has_provenance check (
    status <> 'published' or (published_at is not null and publication_method is not null)
  );

-- A provider-assigned identifier can only come from a provider publication.
--
-- The invariant that keeps "user-confirmed" from ever being mistaken for
-- "provider-verified": on the manual path there is no identifier to hold,
-- permanently, so a row carrying one is either a provider publication or a
-- bug. Written as a constraint rather than left to the application because the
-- application is exactly what would drift.
alter table public.response_drafts
  add constraint response_drafts_external_id_requires_provider check (
    external_response_id is null or publication_method = 'provider_api'
  );

comment on constraint response_drafts_external_id_requires_provider on public.response_drafts is
  'A manual_external publication has no provider-assigned identifier and must never appear to have one. This is what stops a user-confirmed publication being read as provider-verified.';

-- ---------------------------------------------------------------------------
-- 3. Listing snapshots.
--
-- One row per successful check. Storing every observation rather than only the
-- changes costs two integers a day per location and buys three things a
-- change-only table could not: a rating history somebody can chart, the
-- ability to prove Lia *was* checking during a period when nothing happened,
-- and a stable pair of ids for an occurrence to point at.
-- ---------------------------------------------------------------------------

create table public.yelp_listing_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  platform_profile_id uuid not null
    references public.platform_profiles (id) on delete cascade,
  -- Which check produced it. Nulled rather than cascaded so a future retention
  -- sweep over sync runs cannot take the observations with it.
  sync_run_id uuid references public.platform_sync_runs (id) on delete set null,
  observed_at timestamptz not null default now(),
  -- Both nullable, and that is load-bearing rather than defensive. Yelp omits
  -- these on some responses, and both alternatives are wrong: a zero would read
  -- as every review having been deleted, and refusing to store the observation
  -- would lose the evidence that a check ran at all.
  review_count integer check (review_count is null or review_count >= 0),
  rating numeric(2,1) check (rating is null or (rating >= 0 and rating <= 5)),
  is_closed boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.yelp_listing_snapshots is
  'One successful observation of a connected Yelp listing. Append-only. Null counters mean Yelp did not report them, which is not the same as zero and never establishes or moves a baseline.';

-- The comparison every check runs: the most recent prior observation for this
-- listing. Descending, because that is the only direction anything reads it.
create index yelp_listing_snapshots_profile_idx
  on public.yelp_listing_snapshots (platform_profile_id, observed_at desc);

create index yelp_listing_snapshots_org_idx
  on public.yelp_listing_snapshots (organization_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- 4. Activity occurrences.
--
-- Identity is the pair of snapshots the change sits between, which is what
-- makes detection idempotent: a repeated or concurrent check comparing the
-- same two observations produces the same occurrence, and the unique index
-- refuses the second write rather than the application checking first (D24).
-- ---------------------------------------------------------------------------

create table public.yelp_activity_occurrences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  platform_profile_id uuid not null
    references public.platform_profiles (id) on delete cascade,
  -- Denormalised from the profile so the inbox can filter by restaurant
  -- without a join, and nulled rather than cascaded if the location is removed.
  location_id uuid references public.locations (id) on delete set null,
  -- Restricted, not cascaded: an occurrence's whole meaning is the two
  -- observations it sits between, and deleting one would leave a change record
  -- that can no longer say what changed.
  from_snapshot_id uuid not null
    references public.yelp_listing_snapshots (id) on delete restrict,
  to_snapshot_id uuid not null
    references public.yelp_listing_snapshots (id) on delete restrict,
  detected_at timestamptz not null default now(),
  change_kind text not null check (
    change_kind in ('count_increased', 'count_decreased', 'count_and_rating', 'rating_only')
  ),
  previous_review_count integer check (previous_review_count is null or previous_review_count >= 0),
  current_review_count integer check (current_review_count is null or current_review_count >= 0),
  previous_rating numeric(2,1) check (previous_rating is null or (previous_rating >= 0 and previous_rating <= 5)),
  current_rating numeric(2,1) check (current_rating is null or (current_rating >= 0 and current_rating <= 5)),
  status text not null default 'open' check (status in ('open', 'captured', 'dismissed')),
  -- The review somebody added in response. Nulled rather than cascaded: an
  -- occurrence is a record of an observation and outlives any mention.
  captured_mention_id uuid references public.mentions (id) on delete set null,
  resolved_by_user_id uuid references public.users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An occurrence must sit between two *different* observations. A change from
  -- a snapshot to itself is not a change.
  constraint yelp_activity_distinct_snapshots check (from_snapshot_id <> to_snapshot_id),
  -- A resolved occurrence says who resolved it and when; an open one says
  -- neither. Same pairing discipline as the capture constraint above.
  constraint yelp_activity_resolution_pairing check (
    case
      when status = 'open' then resolved_at is null and captured_mention_id is null
      else resolved_at is not null
    end
  ),
  -- Only a captured occurrence may name the review that answered it.
  constraint yelp_activity_capture_pairing check (
    captured_mention_id is null or status = 'captured'
  )
);

comment on table public.yelp_activity_occurrences is
  'One observed change in a connected Yelp listing''s counters, between two named snapshots. Deliberately carries no count of new reviews: a review-count delta cannot support one, because the count moves when reviews are added, removed, or reclassified.';

-- The idempotency guarantee. This index IS the deduplication; the application
-- never checks first. Two concurrent checks that observe the same transition
-- race to insert, one wins, and the loser reads the winner's row.
create unique index yelp_activity_occurrences_unique_transition
  on public.yelp_activity_occurrences (platform_profile_id, from_snapshot_id, to_snapshot_id);

comment on index public.yelp_activity_occurrences_unique_transition is
  'At most one occurrence per observed transition. Makes a repeated or concurrent listing check idempotent without an application-level check-then-insert race (D24).';

-- The activity inbox: what is still open, newest first.
create index yelp_activity_occurrences_open_idx
  on public.yelp_activity_occurrences (organization_id, detected_at desc)
  where status = 'open';

create index yelp_activity_occurrences_profile_idx
  on public.yelp_activity_occurrences (organization_id, platform_profile_id, detected_at desc);

create trigger yelp_activity_occurrences_set_updated_at
  before update on public.yelp_activity_occurrences
  for each row execute function public.set_updated_at();

-- The mentions FK, added here rather than inline above because the table it
-- points at did not exist when the column was created.
alter table public.mentions
  add constraint mentions_yelp_activity_occurrence_fkey
  foreign key (yelp_activity_occurrence_id)
  references public.yelp_activity_occurrences (id) on delete set null;

-- Only a manually captured mention may cite an occurrence. A provider-returned
-- review was not prompted by anything Lia observed.
alter table public.mentions
  add constraint mentions_occurrence_requires_manual_capture check (
    yelp_activity_occurrence_id is null or capture_method = 'manual_entry'
  );

-- ---------------------------------------------------------------------------
-- 5. Listing-to-location mapping: what the database guarantees, and what it
--    deliberately does not.
--
-- **Guaranteed here, and it is the invariant that matters.** The existing
-- `platform_profiles_unique_external (platform_connection_id,
-- external_profile_id)` already refuses the same Yelp business id twice under
-- one connection, and there is one Yelp connection per organization — so one
-- external listing can be bound to at most one location per tenant. That is
-- the guarantee the product needs: it is what stops one restaurant's activity
-- and captured reviews being attributed to another, and it is enforced by a
-- unique index rather than by an application check.
--
-- **Not enforced across organizations, deliberately.** Two tenants can
-- legitimately connect the same listing — an owner and the agency working for
-- them — and a global constraint would both break that case and leak the
-- existence of another tenant's mapping through a constraint violation.
--
-- **The reverse direction (one location, two different listings) is an
-- application check, not a constraint, and that is a real limitation rather
-- than an oversight.** A partial unique index on
-- `(organization_id, location_id)` would need `platform = 'yelp'` in its
-- predicate, and the platform lives on `platform_connections` — Postgres
-- refuses a subquery in an index predicate, so the only route to an index is
-- denormalising `platform` onto `platform_profiles`. That is a schema change
-- to a table three other integrations share, taken on a Yelp migration, to
-- enforce a rule none of them currently has. The trade was judged not worth
-- it: the connect service refuses a second listing for a location that already
-- has one, and the failure mode if that check ever races is a visible
-- duplicate on the location's own settings screen, not a silent
-- misattribution. Revisit if a second assisted provider wants the same rule,
-- at which point the denormalised column earns its keep.

comment on constraint platform_profiles_unique_external on public.platform_profiles is
  'One external listing per connection. For Yelp this is also the one-listing-per-location guarantee, since a tenant holds a single Yelp connection: it is what stops one restaurant''s review activity being attributed to another.';
