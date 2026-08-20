-- Website review widget: one Google review, embedded on the customer's own site.
--
-- Lia's first *outbound* surface. Everything else in this schema records
-- something Lia read from somewhere else; this table decides what Lia
-- publishes on somebody's homepage under their own name. Three consequences
-- shape what is below.
--
-- 1. There is no copy of the review here, and there must never be one. A
--    widget names a location and a selection rule; the review is resolved at
--    render time from `public.mentions`. A denormalised copy would go stale the
--    moment the reviewer edited it at the source, or the moment a person
--    dismissed it, and Lia would keep serving words Google no longer shows.
--    This is D21's reasoning ("mentions is the canonical model") applied to a
--    read path rather than to an ingest.
--
-- 2. `public_id` is an identifier, not a secret, and the schema says so in a
--    comment because the next person to read it will assume otherwise. It is
--    pasted into public HTML by design. It is random rather than sequential to
--    stop anybody enumerating the range and producing a list of every
--    restaurant using Lia; it is not hashed, because hashing a value that is
--    published verbatim protects nothing. Contrast `invitations.token_hash`
--    and `oauth_states.state_hash`, which are bearer capabilities and are
--    stored as digests for that reason.
--
-- 3. The anonymous render path is a `SECURITY DEFINER` function, not a policy.
--    An embed request carries no session at all, so `auth.uid()` is null and
--    no policy on `mentions` could return the row. `public.review_widget_render`
--    below is the whole of what anonymous traffic can reach, it takes exactly
--    one argument, and it returns exactly the six review fields the widget
--    draws. The precedent is `invitation_preview` (20260805000100), which
--    solved the same problem for the public acceptance page.
--
-- What this migration deliberately does NOT create:
--
-- * No `widget_reviews`, `widget_impressions`, or `widget_events` table. The
--   feature ships without analytics, and an empty events table is how a
--   product acquires a metric nobody asked for and a retention obligation
--   nobody scoped.
-- * No layout-specific columns. The photo- and video-led layouts in the
--   product brief are not built; `layout` is a one-value check constraint,
--   which is the seam they arrive through.

-- ---------------------------------------------------------------------------
-- 1. Vocabularies.
--
-- Check-constrained text rather than Postgres enums, following the reasoning
-- the Reddit and Yelp schemas recorded: an enum value cannot be dropped, and
-- these lists are one day old. `layout` in particular is expected to gain a
-- value and might well rename this one.
-- ---------------------------------------------------------------------------

create table public.review_widgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- Cascaded rather than nulled, unlike most location references in this
  -- schema. A widget with no location is not a recoverable state — it has
  -- nothing to select a review from and nothing to name in the interface — and
  -- a deleted restaurant should stop appearing on the website that advertises
  -- it, immediately and without anybody remembering to switch something off.
  location_id uuid not null references public.locations (id) on delete cascade,

  -- The identifier in the customer's page source. Not a secret; see the header.
  public_id text not null unique
    check (public_id ~ '^rw_[A-Za-z0-9_-]{20}$'),

  status text not null default 'active'
    check (status in ('active', 'disabled')),

  layout text not null default 'single_review_text'
    check (layout in ('single_review_text')),

  theme text not null default 'light'
    check (theme in ('light', 'dark')),

  selection_mode text not null default 'most_recent'
    check (selection_mode in ('most_recent', 'specific')),

  -- Nulled rather than cascaded, and that pairing is the entire answer to the
  -- product brief's "when a manually selected review becomes unavailable, show
  -- a graceful unavailable state rather than leaking another review". A
  -- deleted pinned review leaves `selection_mode = 'specific'` with nothing
  -- selected, which the renderer answers with "the selected review is not
  -- available" — never with a different review.
  --
  -- Deliberately NOT paired with a check constraint requiring the id when the
  -- mode is 'specific'. Such a constraint would turn deleting a mention into a
  -- failed transaction on an unrelated table, and would make the very state
  -- this feature must handle gracefully impossible to represent.
  selected_mention_id uuid references public.mentions (id) on delete set null,

  -- The lowest rating an *automatically* selected review may carry. Not in the
  -- original brief and added on purpose: "most recent eligible review" with no
  -- floor puts whatever arrived last on a restaurant's homepage, and what
  -- arrives last is as likely to be one star as five.
  minimum_rating numeric(2, 1) not null default 4.0
    check (minimum_rating >= 1 and minimum_rating <= 5),

  -- Approved website hosts, bare and lowercased, optionally with a single
  -- leading '*.' label — the exact vocabulary a CSP `frame-ancestors` source
  -- can express, because that directive is what enforces this. Empty means
  -- unrestricted, which is the honest default: closed-by-default would mean
  -- every widget was broken until somebody found this setting.
  allowed_domains text[] not null default '{}',

  -- The plan seam for the "Powered by Lia" line. Nothing writes it today —
  -- Lia has no billing model — and `resolveWidgetAttribution()` in
  -- src/lib/widgets/attribution.ts is its only reader. It exists for the same
  -- reason `monitoring_queries.postal_code` does: the column is cheap now and
  -- the migration is not.
  attribution_suppressed boolean not null default false,

  public_id_rotated_at timestamptz,

  -- Nulled rather than cascaded, matching platform_sync_runs.actor_user_id: an
  -- offboarded employee must not erase the record that a widget was created.
  created_by_user_id uuid references public.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One widget per location. Not a limitation somebody will regret: the
  -- snippet is pasted into a page and forgotten, and two widgets for one
  -- restaurant means two snippets nobody can tell apart in a page's source.
  -- The day a customer genuinely needs a light one and a dark one, this
  -- constraint is dropped and a `name` column added — a strictly smaller
  -- change than un-picking the ambiguity a nameless second row would create.
  constraint review_widgets_one_per_location unique (organization_id, location_id)
);

comment on table public.review_widgets is
  'Configuration for one embedded website widget. Holds no review text — the review is resolved at render time from public.mentions, so a dismissed or edited review stops being published without anybody doing anything.';
comment on column public.review_widgets.public_id is
  'The identifier pasted into the customer''s page. PUBLIC BY DESIGN and deliberately not hashed: unlike invitations.token_hash it grants nothing, and hashing a value that is published verbatim protects nothing. Random rather than sequential so the range cannot be walked to enumerate Lia''s customers.';
comment on column public.review_widgets.selected_mention_id is
  'The pinned review, when selection_mode is specific. on delete set null, on purpose: a deleted review must leave the widget pinned to nothing so the renderer can say so, rather than silently substituting another location''s or another customer''s words.';
comment on column public.review_widgets.minimum_rating is
  'The floor for automatic selection. Configuration, not review state — the eligibility rules that ARE review state live in review_widget_render below.';
comment on column public.review_widgets.allowed_domains is
  'Bare hostnames, optionally with one leading *. label. Enforced as a CSP frame-ancestors directive on the widget document. Empty means unrestricted.';
comment on column public.review_widgets.attribution_suppressed is
  'Whether a plan has bought the "Powered by Lia" line away. Nothing writes this: Lia has no billing model. It is the seam a plan gate lands on.';

-- The public render path's only lookup. `public_id` is already unique, so this
-- index exists implicitly; named here only so the intent is visible next to
-- the function that depends on it.
create index review_widgets_org_idx
  on public.review_widgets (organization_id, location_id);

create index review_widgets_selected_mention_idx
  on public.review_widgets (selected_mention_id)
  where selected_mention_id is not null;

create trigger review_widgets_set_updated_at
  before update on public.review_widgets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. The anonymous render path.
--
-- THE ELIGIBILITY RULES BELOW ARE A MIRROR. Their twin is
-- `firstFailedWidgetRule` in src/lib/widgets/eligibility.ts, which the demo
-- adapter and the configuration screen both use. The rule identifiers are
-- quoted in the `where` clause comments so the two can be read side by side,
-- and tests/review-widget-eligibility.test.ts pins the identifier list. A rule
-- changed in one place and not the other means the review a customer picks
-- from in Lia and the review their website serves are chosen by different
-- rules — which is the one drift in this feature nobody would notice until a
-- guest saw it.
--
-- Rules, in the order applied:
--
--   location           the widget's own location, never another
--   source             source_type = 'google_review'
--   text               non-empty content; a rating-only review renders empty
--   rating             a rating exists; the widget draws stars
--   not_dismissed      status <> 'dismissed'
--   not_escalated      status <> 'escalated'
--   present_at_source  source_removed_at is null
--   provider_returned  capture_method = 'provider_api'
--   minimum_rating     rating >= the widget's configured floor
--
-- Two of those are worth restating in SQL, where somebody will read them next.
-- `not_escalated` reuses an existing meaning rather than inventing one: an
-- escalated mention is one Lia routed to a person as a risk, and "needs
-- handling" and "put this on the homepage" cannot both be true.
-- `provider_returned` excludes manually typed reviews (the Yelp capture path),
-- which nothing can verify — republishing one as a Google review would be Lia
-- asserting words no provider ever returned.
-- ---------------------------------------------------------------------------

create or replace function public.review_widget_render(widget_public_id text)
returns table (
  theme text,
  layout text,
  status text,
  attribution_suppressed boolean,
  allowed_domains text[],
  selection_mode text,
  review_rating numeric,
  review_text text,
  review_author_name text,
  review_published_at timestamptz,
  profile_url text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with widget as (
    select w.*
      from public.review_widgets w
     where w.public_id = widget_public_id
  ),
  -- The pinned review, subjected to exactly the same eligibility rules as an
  -- automatically selected one, minus the rating floor. A person who pinned a
  -- three-star review meant it; a floor that overrode an explicit choice would
  -- be the product second-guessing a decision somebody made on purpose. Every
  -- other rule still applies — a pinned review that was since dismissed,
  -- escalated, or removed at the source stops being published.
  pinned as (
    select m.rating, m.content, m.author_name, m.published_at, m.platform_profile_id
      from widget w
      join public.mentions m on m.id = w.selected_mention_id
     where w.selection_mode = 'specific'
       and m.organization_id = w.organization_id          -- location
       and m.location_id     = w.location_id              -- location
       and m.source_type     = 'google_review'            -- source
       and length(btrim(m.content)) > 0                   -- text
       and m.rating is not null                           -- rating
       and m.status <> 'dismissed'                        -- not_dismissed
       and m.status <> 'escalated'                        -- not_escalated
       and m.source_removed_at is null                    -- present_at_source
       and m.capture_method = 'provider_api'              -- provider_returned
  ),
  -- The newest eligible review at this location.
  --
  -- Ordered by published_at — when the reviewer wrote it — rather than by
  -- received_at. A backfill imports three years of reviews in one afternoon,
  -- and arrival order would leave a 2023 review sitting on the homepage as
  -- "most recent" until the next sync. `id` breaks ties so the choice is
  -- stable across renders rather than reshuffling on every page load.
  automatic as (
    select m.rating, m.content, m.author_name, m.published_at, m.platform_profile_id
      from widget w
      join public.mentions m
        on m.organization_id = w.organization_id          -- location
       and m.location_id     = w.location_id              -- location
     where w.selection_mode = 'most_recent'
       and m.source_type     = 'google_review'            -- source
       and length(btrim(m.content)) > 0                   -- text
       and m.rating is not null                           -- rating
       and m.status <> 'dismissed'                        -- not_dismissed
       and m.status <> 'escalated'                        -- not_escalated
       and m.source_removed_at is null                    -- present_at_source
       and m.capture_method = 'provider_api'              -- provider_returned
       and m.rating >= w.minimum_rating                   -- minimum_rating
     order by m.published_at desc, m.id desc
     limit 1
  ),
  chosen as (
    select * from pinned
    union all
    select * from automatic
  )
  select
    w.theme,
    w.layout,
    w.status,
    w.attribution_suppressed,
    w.allowed_domains,
    w.selection_mode,
    c.rating,
    c.content,
    c.author_name,
    c.published_at,
    -- Where "Read on Google" points. Google publishes no per-review permalink
    -- (see src/integrations/google-business-profile/reviews.ts), so this is
    -- the location's own Google profile, and it is re-validated against an
    -- allowlist of Google hosts in TypeScript before it becomes an anchor.
    p.profile_url
  from widget w
  -- Left joins throughout: a widget with nothing to show must still return its
  -- row, because the theme and the attribution decision are what the
  -- "unavailable" card is drawn with. Returning no row at all would make a
  -- disabled widget indistinguishable from a deleted one.
  left join chosen c on true
  left join public.platform_profiles p on p.id = c.platform_profile_id;
$$;

comment on function public.review_widget_render is
  'Everything an anonymous embed request may read, keyed by the widget''s public id. SECURITY DEFINER because an embed carries no session and no policy on mentions could return the row (the invitation_preview precedent). Returns exactly the six review fields the widget draws — never a status, a sentiment, a risk level, or a raw payload. Its eligibility rules mirror firstFailedWidgetRule in src/lib/widgets/eligibility.ts clause for clause; change both or neither.';

-- ---------------------------------------------------------------------------
-- 3. The audit subject.
--
-- Here rather than in the vocabulary migration alongside the event names,
-- because `npm run audit:vocabulary:generate` writes that file and its header
-- says not to hand-edit it — the whole value of a generated restatement is
-- that its list is derived rather than copied. The generator emits event names
-- only, and tells you to add an entity type in its own migration; this is the
-- feature's own migration, which is the natural home.
--
-- Safe to sit beside the table DDL for the reason the generator records:
-- `audit_entity_type` is a Postgres enum and values are added with
-- `add value if not exists`, which is additive. Unlike the check constraint,
-- a later migration cannot drop an earlier one's value, so this carries none
-- of the ordering hazard that makes the event list a recurring problem.
--
-- Its own subject rather than `location`. The location is a restaurant; the
-- widget is a thing published on the internet under that restaurant's name,
-- and an auditor asking "when did this stop appearing on our homepage" would
-- otherwise have to read every event about the restaurant to find out.
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value if not exists 'review_widget';
