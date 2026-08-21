-- Website press widget: one to three news stories, embedded on the customer's
-- own site.
--
-- Lia's second *outbound* surface, and a separate table from `review_widgets`
-- rather than a mode of it. The two look alike from the outside — a public id,
-- a theme, an approved-domain list, a snippet — and are different products
-- underneath:
--
--   * a review widget names a LOCATION; a press widget names an ORGANIZATION,
--     because coverage arrives bound to a monitoring query rather than to a
--     restaurant, and a query may itself be organization-wide;
--   * a review widget shows ONE review; a press widget shows one to three
--     stories;
--   * a review widget can be PINNED to a specific review; a press widget
--     cannot be pinned to anything, so it cannot go stale.
--
-- Overloading `review_widgets` with `monitoring_query_id`, `item_limit`, and a
-- nullable `location_id` would have produced one table where half the columns
-- are meaningless for half the rows, one check constraint nobody can read, and
-- one RLS policy protecting two different things. D21's "extend the canonical
-- model" applies to `mentions`, which is where the CONTENT lives; it does not
-- apply to two publishing surfaces that share only an envelope.
--
-- Three consequences shape what is below.
--
-- 1. There is no copy of an article here, and there must never be one. A
--    widget names a filter and a count; the stories are resolved at render
--    time from `public.mentions`. A denormalised copy would go stale the
--    moment an outlet pulled a piece, or the moment somebody dismissed it, and
--    Lia would keep publishing a headline on a customer's homepage that no
--    longer exists. There is deliberately NO `articles` table: press content
--    is a `mention` with `source_type = 'news_article'`, and it has been since
--    20260806000500.
--
-- 2. `public_id` is an identifier, not a secret, exactly as on
--    `review_widgets`. It is pasted into public HTML by design. It is random
--    rather than sequential to stop anybody enumerating the range and
--    producing a list of every restaurant using Lia; it is not hashed, because
--    hashing a value that is published verbatim protects nothing.
--
-- 3. The anonymous render path is a `SECURITY DEFINER` function, not a policy.
--    An embed request carries no session at all, so `auth.uid()` is null and
--    no policy on `mentions` or `monitoring_queries` could return a row.
--    `public.press_widget_render` below is the whole of what anonymous traffic
--    can reach for this feature, it takes exactly one argument, and it returns
--    exactly the six story fields the widget draws.
--
-- What this migration deliberately does NOT create:
--
--   * No `publisher_logos` table. Logos are a versioned, typed registry in
--     TypeScript (`src/lib/widgets/press/publisher-logos.ts`) keyed by
--     normalised publisher domain, so adding a publication is a code change
--     rather than a migration and so a database row can never name an asset
--     path. See docs/press-widget.md on the logo trust boundary.
--   * No `press_widget_items` pinning table. Selection is automatic and
--     newest-first in v1; a pinned story is the feature that turns a "recent
--     press" strip into a stale one.
--   * No impressions, clicks, or events table. Same reasoning as the review
--     widget: an empty events table is how a product acquires a metric nobody
--     asked for and a retention obligation nobody scoped.

-- ---------------------------------------------------------------------------
-- 1. The composite-key prerequisite.
--
-- `press_widgets.monitoring_query_id` must be unable to point at another
-- tenant's watch. A simple foreign key to `monitoring_queries(id)` cannot
-- express that — Postgres would accept any query id in existence, and the only
-- thing standing between a mis-set row and one restaurant group publishing the
-- coverage another group is watching would be application code.
--
-- So the reference below is composite, on `(monitoring_query_id,
-- organization_id)`, which needs a matching unique on the parent. This is the
-- same construction 20260811000100 built for `mentions.location_id` and
-- 20260813000700 built into `reddit_monitoring_queries` from the start; it is
-- implied by the primary key plus the tenant column, and it costs one index.
--
-- The pre-flight assertion is not ceremony. `monitoring_queries` has been
-- writable for a fortnight, and a violation here would be a live cross-tenant
-- defect to investigate rather than data to grandfather.
-- ---------------------------------------------------------------------------

alter table public.monitoring_queries
  add constraint monitoring_queries_id_org unique (id, organization_id);

comment on constraint monitoring_queries_id_org on public.monitoring_queries is
  'Implied by the primary key plus organization_id. Exists so same-organization composite foreign keys onto this table are expressible — press_widgets.monitoring_query_id is the first.';

-- ---------------------------------------------------------------------------
-- 2. The table.
--
-- Check-constrained text rather than Postgres enums, following the reasoning
-- the Reddit, Yelp, and review-widget schemas recorded: an enum value cannot
-- be dropped, and these lists are one day old. `layout` in particular is
-- expected to gain a value.
-- ---------------------------------------------------------------------------

create table public.press_widgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- The identifier in the customer's page source. Not a secret; see the
  -- header. `pw_` rather than `rw_` so a value in a support ticket says which
  -- of the two products it belongs to, and so one widget's snippet cannot
  -- resolve against the other's route.
  public_id text not null unique
    check (public_id ~ '^pw_[A-Za-z0-9_-]{20}$'),

  status text not null default 'active'
    check (status in ('active', 'disabled')),

  layout text not null default 'recent_press_list'
    check (layout in ('recent_press_list')),

  theme text not null default 'light'
    check (theme in ('light', 'dark')),

  -- Null means every eligible news article in the organization. A value
  -- narrows the widget to one monitoring query — which may itself be
  -- organization-wide or scoped to a location, and THAT is how a
  -- per-restaurant press widget is expressed.
  --
  -- There is deliberately no `location_id` column. A story's attribution to a
  -- restaurant is a property of the query that found it (see
  -- `mentions.monitoring_query_id`, which is set once on first sight and never
  -- re-attributed), and a second, independent location filter would silently
  -- disagree with the first the moment an article named two restaurants.
  --
  -- `on delete set null` rather than cascade: deleting a monitoring query
  -- widens the widget to all press rather than destroying it. A customer who
  -- deletes a watch has decided to stop watching something, not that their
  -- homepage should go blank.
  monitoring_query_id uuid,

  item_limit integer not null default 3
    check (item_limit between 1 and 3),

  -- Approved website hosts, bare and lowercased, optionally with a single
  -- leading '*.' label — the exact vocabulary a CSP `frame-ancestors` source
  -- can express. Same bounds, same normalisation, and the same
  -- `src/lib/widgets/domains.ts` as the review widget: this is one of the
  -- pieces of the envelope the two genuinely share. Empty means unrestricted.
  allowed_domains text[] not null default '{}'
    check (cardinality(allowed_domains) <= 20),

  -- The plan seam for the "Powered by Lia" line. Nothing writes it today —
  -- Lia has no billing model — and `resolveWidgetAttribution()` in
  -- src/lib/widgets/attribution.ts is its only reader, shared with the review
  -- widget so the two cannot answer the question differently.
  attribution_suppressed boolean not null default false,

  public_id_rotated_at timestamptz,

  -- Nulled rather than cascaded, matching review_widgets.created_by_user_id:
  -- an offboarded employee must not erase the record that a widget was
  -- created.
  created_by_user_id uuid references public.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One press widget per organization in v1. The snippet is pasted into a page
  -- and forgotten, and two widgets for one group means two snippets nobody can
  -- tell apart in a page's source. The day a customer genuinely needs a light
  -- one in the footer and a dark one on the press page, this constraint is
  -- dropped and a `name` column added — a strictly smaller change than
  -- un-picking the ambiguity a nameless second row would create.
  constraint press_widgets_one_per_organization unique (organization_id),

  -- The tenant-safe reference. A query from another organization is not merely
  -- refused by the application; it is unrepresentable.
  constraint press_widgets_query_same_org
    foreign key (monitoring_query_id, organization_id)
    references public.monitoring_queries (id, organization_id)
    on delete set null (monitoring_query_id)
);

comment on table public.press_widgets is
  'Configuration for one embedded press widget. Holds no article content — headlines are resolved at render time from public.mentions, so coverage that is dismissed, withdrawn at the source, or found to be syndicated stops being published without anybody doing anything.';
comment on column public.press_widgets.public_id is
  'The identifier pasted into the customer''s page. PUBLIC BY DESIGN and deliberately not hashed: unlike invitations.token_hash it grants nothing, and hashing a value that is published verbatim protects nothing. Random rather than sequential so the range cannot be walked to enumerate Lia''s customers.';
comment on column public.press_widgets.monitoring_query_id is
  'Null means all organization press. A value narrows the widget to one watch, which is also how a per-location press widget is expressed — there is no location column, because attribution to a restaurant is a property of the query that found the article.';
comment on column public.press_widgets.item_limit is
  'One to three. Past three a homepage proof strip becomes a press page, which belongs on its own route.';
comment on column public.press_widgets.allowed_domains is
  'Bare hostnames, optionally with one leading *. label. Enforced as a CSP frame-ancestors directive on the widget document. Empty means unrestricted.';
comment on column public.press_widgets.attribution_suppressed is
  'Whether a plan has bought the "Powered by Lia" line away. Nothing writes this: Lia has no billing model. It is the seam a plan gate lands on.';

create index press_widgets_query_idx
  on public.press_widgets (monitoring_query_id)
  where monitoring_query_id is not null;

create trigger press_widgets_set_updated_at
  before update on public.press_widgets
  for each row execute function public.set_updated_at();

-- The index the render path's story query needs. Without it, every embed
-- request on a busy homepage sorts the organization's whole news history to
-- take three rows.
create index mentions_press_recent_idx
  on public.mentions (organization_id, published_at desc, id desc)
  where source_type = 'news_article';

-- ---------------------------------------------------------------------------
-- 3. The anonymous render path.
--
-- THE ELIGIBILITY RULES BELOW ARE A MIRROR. Their twin is
-- `firstFailedPressRule` in src/lib/widgets/press/eligibility.ts, which the
-- demo adapter, the configuration screen, and the in-app preview all use. The
-- rule identifiers are quoted in the `where` clause comments so the two can be
-- read side by side, and tests/press-widget-eligibility.test.ts pins the
-- identifier list. A rule changed in one place and not the other means the
-- coverage a customer sees listed inside Lia and the coverage their website
-- actually serves are chosen by different rules — which is the one drift in
-- this feature nobody would notice until a guest saw it.
--
-- Rules, in the order applied:
--
--   organization       the widget's own organization, never another
--   source             source_type = 'news_article'
--   query              matches the widget's monitoring_query_id, when it sets one
--   query_enabled      and that query is enabled
--   headline           non-empty title; the card IS a headline
--   source_url         a non-empty http(s) URL; the card IS a link
--   published          a publication timestamp exists
--   not_dismissed      status <> 'dismissed'
--   not_escalated      status <> 'escalated'
--   present_at_source  source_removed_at is null
--   not_syndicated     is_syndicated = false
--   provider_returned  capture_method = 'provider_api'
--
-- Four are worth restating in SQL, where somebody will read them next.
--
-- `query_enabled` is not a property of the article; it is a property of the
-- watch that found it. A customer who disables a monitoring query has said
-- "stop watching this", and continuing to publish what it found — on their own
-- homepage, indefinitely — would be Lia deciding that "stop" meant "stop
-- fetching". It applies only when the widget selects a query.
--
-- `not_syndicated` has no review equivalent. `is_syndicated` is Lia's own gate
-- verdict (D86) on a headline that reappeared inside the syndication window —
-- a wire story picked up by four outlets. In the inbox that is a useful
-- signal; in a three-item strip it is the difference between "three
-- publications covered us" and "one wire service did, three times".
--
-- `provider_returned` excludes manually typed content (the Yelp capture path),
-- which nothing can verify. Republishing one as a news article would be Lia
-- asserting coverage no provider ever returned.
--
-- Deliberately NOT rules: `responded`, `monitoring`, and
-- `no_action_recommended`. Those are mention statuses that say something about
-- Lia's internal workflow and nothing about whether the article still exists.
-- An article Lia recommends no action on is very often the best coverage a
-- customer has. Internal workflow state and public existence are different
-- facts.
-- ---------------------------------------------------------------------------

create or replace function public.press_widget_render(widget_public_id text)
returns table (
  theme text,
  layout text,
  status text,
  attribution_suppressed boolean,
  allowed_domains text[],
  headline text,
  excerpt text,
  publisher_name text,
  publisher_domain text,
  source_url text,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with widget as (
    select w.*
      from public.press_widgets w
     where w.public_id = widget_public_id
  ),
  stories as (
    select
      m.title       as headline,
      m.content     as excerpt,
      m.publisher_name,
      m.publisher_domain,
      m.source_url,
      m.published_at
      from widget w
      join public.mentions m
        on m.organization_id = w.organization_id            -- organization
      -- The query filter, and the enabled check that goes with it. A left join
      -- to `monitoring_queries` would let a disabled watch through; an inner
      -- join in a scalar subquery is what makes `query_enabled` structural.
      -- When the widget selects no query the `or` short-circuits and no join
      -- is needed at all.
     where (
             w.monitoring_query_id is null
             or (
               m.monitoring_query_id = w.monitoring_query_id  -- query
               and exists (
                 select 1
                   from public.monitoring_queries q
                  where q.id = w.monitoring_query_id
                    and q.organization_id = w.organization_id
                    and q.enabled                             -- query_enabled
               )
             )
           )
       and m.source_type = 'news_article'                     -- source
       and length(btrim(coalesce(m.title, ''))) > 0           -- headline
       and m.source_url is not null                           -- source_url
       and m.source_url ~* '^https?://[^/?#\s]+'              -- source_url
       and m.published_at is not null                         -- published
       and m.status <> 'dismissed'                            -- not_dismissed
       and m.status <> 'escalated'                            -- not_escalated
       and m.source_removed_at is null                        -- present_at_source
       and m.is_syndicated = false                            -- not_syndicated
       and m.capture_method = 'provider_api'                  -- provider_returned
     -- Ordered by published_at — when the outlet published it — rather than by
     -- received_at. A poll catching up after an outage ingests a fortnight of
     -- coverage in one run, and arrival order would leave a two-week-old piece
     -- at the top until the next poll. `id desc` breaks ties so the order is
     -- stable across renders rather than reshuffling on every page load, and
     -- it matches `selectPressStories`' tiebreaker exactly.
     order by m.published_at desc, m.id desc
     limit (select w.item_limit from widget w)
  )
  select
    w.theme,
    w.layout,
    w.status,
    w.attribution_suppressed,
    w.allowed_domains,
    s.headline,
    -- Trimmed here rather than in the renderer, so the anonymous surface
    -- carries what the widget shows and not a paragraph the widget would
    -- discard. `excerptOf` in src/lib/widgets/press/excerpt.ts applies the
    -- same 240-character cut; a difference between the two costs an ellipsis,
    -- never a story.
    case
      when s.excerpt is null then null
      when length(btrim(regexp_replace(s.excerpt, '\s+', ' ', 'g'))) = 0 then null
      when length(btrim(regexp_replace(s.excerpt, '\s+', ' ', 'g'))) <= 240
        then btrim(regexp_replace(s.excerpt, '\s+', ' ', 'g'))
      else left(btrim(regexp_replace(s.excerpt, '\s+', ' ', 'g')), 240) || '…'
    end as excerpt,
    s.publisher_name,
    -- Normalised here, so what crosses the anonymous boundary is a key the
    -- application can look a LOCAL logo up by — never a URL, never markup, and
    -- never anything a provider chose the shape of. `resolvePublisherLogo`
    -- normalises again on the other side rather than trusting this; that is
    -- deliberate belt-and-braces on the one value that selects an asset.
    --
    -- `lower` before the `www.` strip, not after: a provider reporting
    -- `WWW.Example.com` would otherwise keep its `www.` through a
    -- case-sensitive match and miss a registry entry keyed on the bare host.
    -- `nullif` on the way out, so "no domain reported" stays null rather than
    -- becoming an empty string the renderer would have to special-case.
    nullif(regexp_replace(lower(coalesce(s.publisher_domain, '')), '^www\.', ''), '') as publisher_domain,
    s.source_url,
    s.published_at
  from widget w
  -- A left join, so a widget with nothing to show still returns its row: the
  -- theme, the status, and the attribution decision are what the "unavailable"
  -- card is drawn with. Returning no row at all would make a disabled widget
  -- indistinguishable from a deleted one, and those are two different
  -- sentences on a customer's page.
  left join stories s on true;
$$;

comment on function public.press_widget_render is
  'Everything an anonymous embed request may read, keyed by the press widget''s public id. SECURITY DEFINER because an embed carries no session and no policy on mentions or monitoring_queries could return the row (the review_widget_render and invitation_preview precedents). Returns exactly the six story fields the widget draws — never a status, a sentiment, a risk level, a relevance score, a monitoring keyword, a mention id, an organization id, or a raw payload. Its eligibility rules mirror firstFailedPressRule in src/lib/widgets/press/eligibility.ts clause for clause; change both or neither.';

-- ---------------------------------------------------------------------------
-- 4. The audit subject.
--
-- Here rather than in the vocabulary migration alongside the event names,
-- because `npm run audit:vocabulary:generate` writes that file and its header
-- says not to hand-edit it. The generator emits event names only and tells you
-- to add an entity type in its own migration; this is the feature's own
-- migration, which is the natural home.
--
-- Safe to sit beside the table DDL: `audit_entity_type` is a Postgres enum and
-- values are added with `add value if not exists`, which is additive. Unlike
-- the event-type check constraint, a later migration cannot drop an earlier
-- one's value.
--
-- Its own subject rather than `review_widget`. They are two products, two
-- tables, and two different answers to "what appears on our site"; an auditor
-- filtering on one must not have to read the other's events to find out which
-- of the two changed.
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value if not exists 'press_widget';
