-- Website review widget harness: the eligibility rules, proven against a real
-- Postgres.
--
-- Companion to supabase/tests/rls-verification.sql (tenant isolation, plus
-- section 13's checks on this feature's policies and grants). The two run in
-- ONE psql session, in this order:
--
--   npm run db:verify-review-widget
--     -> supabase db reset
--     -> psql -v ON_ERROR_STOP=1
--          -f supabase/tests/rls-verification.sql
--          -f supabase/tests/review-widget-verification.sql
--
-- The helpers below are defined OUTSIDE a transaction for the reason
-- generation-verification.sql records: rls-verification.sql defines its own
-- `pg_temp.check` inside a `begin; ... rollback;`, and `create function` is
-- transactional DDL, so that definition is gone by the time this file starts.
--
-- **Why this file exists at all.** `public.review_widget_render` is a
-- hand-written SQL mirror of `firstFailedWidgetRule` in
-- `src/lib/widgets/eligibility.ts`. The duplication is forced — an embed
-- request carries no session, so the anonymous path cannot run TypeScript —
-- and `tests/review-widget-eligibility.test.ts` can only prove that the
-- migration *names* each rule in a comment. Nothing in the vitest suite can
-- execute the SQL. This file is the other half: it drives the real function
-- through every rule and asserts the answer.
--
-- The failure it guards against is quiet and bad. A rule that drifts here
-- means the reviews a customer can choose from inside Lia and the reviews
-- their website actually serves are selected by two different sets of rules —
-- and the first anybody would know of it is a guest reading a dismissed
-- one-star review on a restaurant's homepage.
--
-- Everything that MUTATES is wrapped in `begin; ... rollback;`, so a green run
-- leaves the database exactly as `supabase db reset` left it.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. Preamble.
-- ---------------------------------------------------------------------------

-- `is not true`, deliberately: a NULL condition makes `not condition` NULL, an
-- `if` on NULL never fires, and the check would pass without ever being true.
create or replace function pg_temp.check(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'REVIEW WIDGET CHECK FAILED (%): %',
      case when condition is null then 'unknown' else 'false' end, label;
  end if;
  raise notice 'ok: %', label;
end;
$$;

-- The review the widget currently resolves to, as its text. Null when nothing
-- resolved, which is what every unavailable state looks like from here.
create or replace function pg_temp.rendered_text(public_id text)
returns text language sql stable as $$
  select r.review_text from public.review_widget_render(public_id) r;
$$;

begin;

-- ---------------------------------------------------------------------------
-- 1. Fixtures.
--
-- One location, one widget, and four reviews built to differ in exactly one
-- attribute each. Built rather than borrowed from the seed: the seed's reviews
-- are a demo dataset that will change, and a rule test whose subject can be
-- edited by somebody adjusting a fixture is a rule test that will one day pass
-- for the wrong reason.
-- ---------------------------------------------------------------------------

create temporary table widget_fixtures as
select
  (select id from public.organizations where slug = 'union-square-hospitality') as org_id,
  -- Ordered by name, not by created_at. Every seeded location shares one
  -- created_at, so `order by created_at` ascending and descending return the
  -- *same* row — which silently made "another restaurant's review" a review at
  -- this very location, and the location rule appeared to fail. Names are
  -- distinct and stable.
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'union-square-hospitality'
    order by l.name limit 1) as location_id,
  (select l.id from public.locations l
     join public.organizations o on o.id = l.organization_id
    where o.slug = 'union-square-hospitality'
    order by l.name desc limit 1) as other_location_id,
  (select c.id from public.platform_connections c
     join public.organizations o on o.id = c.organization_id
    where o.slug = 'union-square-hospitality'
      and c.platform = 'google_business_profile'
    limit 1) as connection_id;

-- Clear this location of seeded reviews so the fixtures below are the only
-- candidates. Deleting rather than filtering, because "the newest eligible
-- review" is a global question over the location and a stray seeded five-star
-- would answer it before any fixture did.
delete from public.mentions m
 using widget_fixtures f
 where m.organization_id = f.org_id
   and m.location_id in (f.location_id, f.other_location_id);

insert into public.mentions
  (organization_id, location_id, platform_connection_id, source_type,
   external_id, content, author_name, rating, published_at, status)
select
  f.org_id, f.location_id, f.connection_id, 'google_review',
  v.external_id, v.content, 'Fixture Reviewer', v.rating, v.published_at::timestamptz, v.status::mention_status
from widget_fixtures f,
  (values
    -- The control. Newest, eligible, five stars — every other case must beat
    -- or fail to beat this one for a reason the test names.
    ('rw-fx-eligible',  'ELIGIBLE five star',        5.0, '2026-08-10T12:00:00Z', 'analyzed'),
    ('rw-fx-older',     'OLDER eligible five star',  5.0, '2026-08-01T12:00:00Z', 'analyzed'),
    ('rw-fx-dismissed', 'DISMISSED but newest',      5.0, '2026-08-19T12:00:00Z', 'dismissed'),
    ('rw-fx-escalated', 'ESCALATED but newest',      5.0, '2026-08-18T12:00:00Z', 'escalated'),
    ('rw-fx-lowrated',  'LOW RATED but newest',      2.0, '2026-08-17T12:00:00Z', 'analyzed'),
    ('rw-fx-empty',     '   ',                       5.0, '2026-08-16T12:00:00Z', 'analyzed')
  ) as v(external_id, content, rating, published_at, status);

-- Two more that need a column the insert above cannot set inline.
insert into public.mentions
  (organization_id, location_id, platform_connection_id, source_type,
   external_id, content, author_name, rating, published_at, status,
   source_removed_at)
select f.org_id, f.location_id, f.connection_id, 'google_review',
       'rw-fx-removed', 'REMOVED at source but newest', 'Fixture Reviewer',
       5.0, '2026-08-15T12:00:00Z', 'analyzed', now()
  from widget_fixtures f;

insert into public.mentions
  (organization_id, location_id, platform_connection_id, source_type,
   external_id, content, author_name, rating, published_at, status,
   capture_method, captured_at)
select f.org_id, f.location_id, f.connection_id, 'google_review',
       'rw-fx-typed', 'TYPED BY A PERSON but newest', 'Fixture Reviewer',
       5.0, '2026-08-14T12:00:00Z', 'analyzed', 'manual_entry', now()
  from widget_fixtures f;

-- A Yelp review at the same location, and a Google review at another one.
-- Both are newer than everything above, so either leaking would be obvious.
insert into public.mentions
  (organization_id, location_id, platform_connection_id, source_type,
   external_id, content, author_name, rating, published_at, status)
select f.org_id, f.location_id, f.connection_id, 'yelp_review',
       'rw-fx-yelp', 'WRONG SOURCE but newest', 'Fixture Reviewer',
       5.0, '2026-08-20T12:00:00Z', 'analyzed'
  from widget_fixtures f;

insert into public.mentions
  (organization_id, location_id, platform_connection_id, source_type,
   external_id, content, author_name, rating, published_at, status)
select f.org_id, f.other_location_id, f.connection_id, 'google_review',
       'rw-fx-other-location', 'ANOTHER RESTAURANT but newest', 'Fixture Reviewer',
       5.0, '2026-08-20T13:00:00Z', 'analyzed'
  from widget_fixtures f;

insert into public.review_widgets
  (organization_id, location_id, public_id, minimum_rating)
select f.org_id, f.location_id, 'rw_verifyA0000000000000', 4.0 from widget_fixtures f;

-- ---------------------------------------------------------------------------
-- 2. Automatic selection applies every rule.
--
-- One assertion does most of the work: eight reviews at this location are
-- newer than the control, and each is excluded by exactly one rule. If any
-- rule were missing from the function, the control would lose.
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.check(
    pg_temp.rendered_text('rw_verifyA0000000000000') = 'ELIGIBLE five star',
    'the newest eligible review wins over eight newer ones that each fail one rule'
  );
end;
$$;

do $$
declare
  rendered text := pg_temp.rendered_text('rw_verifyA0000000000000');
begin
  -- Named individually so a failure says which rule leaked rather than only
  -- that the wrong review came back.
  perform pg_temp.check(rendered <> 'DISMISSED but newest',        'not_dismissed: a dismissed review is never served');
  perform pg_temp.check(rendered <> 'ESCALATED but newest',        'not_escalated: an escalated review is never served');
  perform pg_temp.check(rendered <> 'LOW RATED but newest',        'minimum_rating: a review below the floor is never served');
  perform pg_temp.check(rendered <> '   ',                         'text: a review with no written content is never served');
  perform pg_temp.check(rendered <> 'REMOVED at source but newest','present_at_source: a review withdrawn at the source is never served');
  perform pg_temp.check(rendered <> 'TYPED BY A PERSON but newest','provider_returned: a manually typed review is never served');
  perform pg_temp.check(rendered <> 'WRONG SOURCE but newest',     'source: a Yelp review is never served by a Google widget');
  perform pg_temp.check(rendered <> 'ANOTHER RESTAURANT but newest','location: another location''s review is never served');
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The rules are live, not evaluated once.
--
-- Dismissing the review a widget is currently serving must change what the
-- website shows on the next request, with nobody touching the widget. This is
-- the property that makes "the widget holds no copy of the review" worth the
-- join it costs.
-- ---------------------------------------------------------------------------

do $$
begin
  update public.mentions m
     set status = 'dismissed'
    from widget_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'rw-fx-eligible';

  perform pg_temp.check(
    pg_temp.rendered_text('rw_verifyA0000000000000') = 'OLDER eligible five star',
    'dismissing the served review moves the widget to the next eligible one, with no widget write'
  );

  update public.mentions m
     set status = 'analyzed'
    from widget_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'rw-fx-eligible';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Pinning.
--
-- The one deliberate difference between the branches: an explicit choice is
-- not overridden by a floor meant for automatic selection, but every other
-- rule still applies.
-- ---------------------------------------------------------------------------

do $$
declare
  low_rated uuid;
begin
  select m.id into low_rated from public.mentions m, widget_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'rw-fx-lowrated';

  update public.review_widgets
     set selection_mode = 'specific', selected_mention_id = low_rated
   where public_id = 'rw_verifyA0000000000000';

  perform pg_temp.check(
    pg_temp.rendered_text('rw_verifyA0000000000000') = 'LOW RATED but newest',
    'a deliberately pinned two-star review is served, because the floor governs automatic selection only'
  );
end;
$$;

do $$
declare
  escalated uuid;
begin
  select m.id into escalated from public.mentions m, widget_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'rw-fx-escalated';

  update public.review_widgets
     set selected_mention_id = escalated
   where public_id = 'rw_verifyA0000000000000';

  perform pg_temp.check(
    pg_temp.rendered_text('rw_verifyA0000000000000') is null,
    'a pinned review that is escalated is not served — every rule but the floor still applies to a pin'
  );
end;
$$;

do $$
declare
  elsewhere uuid;
begin
  select m.id into elsewhere from public.mentions m, widget_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'rw-fx-other-location';

  update public.review_widgets
     set selected_mention_id = elsewhere
   where public_id = 'rw_verifyA0000000000000';

  -- The failure the product brief singles out. Postgres will accept the
  -- foreign key — `selected_mention_id` references `mentions`, not
  -- `mentions at this location` — so the function's own location clause is the
  -- only thing standing between a mis-set row and another restaurant's review
  -- appearing on this one's homepage.
  perform pg_temp.check(
    pg_temp.rendered_text('rw_verifyA0000000000000') is null,
    'a pin to another location''s review renders nothing rather than that review'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Losing the pin does not fall back to another review.
--
-- `selected_mention_id` is `on delete set null` with no paired check
-- constraint, deliberately: the widget must be able to *be* pinned to nothing
-- so the renderer can say so. A pinned widget that quietly served the newest
-- review instead would be indistinguishable, to the customer, from the feature
-- working.
-- ---------------------------------------------------------------------------

do $$
declare
  pinned uuid;
  still_specific boolean;
begin
  select m.id into pinned from public.mentions m, widget_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'rw-fx-lowrated';

  update public.review_widgets
     set selected_mention_id = pinned
   where public_id = 'rw_verifyA0000000000000';

  delete from public.mentions where id = pinned;

  select (selection_mode = 'specific' and selected_mention_id is null)
    into still_specific
    from public.review_widgets where public_id = 'rw_verifyA0000000000000';

  perform pg_temp.check(
    still_specific,
    'deleting the pinned review nulls the reference and leaves the widget pinned to nothing'
  );
  perform pg_temp.check(
    pg_temp.rendered_text('rw_verifyA0000000000000') is null,
    'and the widget serves nothing rather than substituting another review'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The row a disabled widget returns.
--
-- Returning no row at all would make a disabled widget indistinguishable from
-- a deleted one, and those are two different sentences on a customer's page.
-- ---------------------------------------------------------------------------

do $$
declare
  row_count integer;
  reported text;
begin
  update public.review_widgets
     set status = 'disabled', selection_mode = 'most_recent', selected_mention_id = null
   where public_id = 'rw_verifyA0000000000000';

  select count(*), max(r.status) into row_count, reported
    from public.review_widget_render('rw_verifyA0000000000000') r;

  perform pg_temp.check(
    row_count = 1 and reported = 'disabled',
    'a disabled widget still returns its row, carrying the status the renderer draws the card from'
  );

  select count(*) into row_count
    from public.review_widget_render('rw_doesnotexist00000000') r;
  perform pg_temp.check(
    row_count = 0,
    'an unknown public id returns no row at all — the state the renderer reports as unknown_widget'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. What the function is allowed to return.
--
-- The anonymous surface is bounded by this column list. A column added here
-- without thought is a column on a public page.
-- ---------------------------------------------------------------------------

do $$
declare
  columns text[];
begin
  -- A `returns table (...)` function declares its output columns as OUT
  -- arguments with mode 't', so they live in `proargnames`/`proargmodes`
  -- rather than in a `pg_class` row.
  select array_agg(name order by ordinality) into columns
    from pg_proc p,
      lateral unnest(p.proargnames, p.proargmodes) with ordinality as u(name, mode, ordinality)
   where p.proname = 'review_widget_render'
     and p.pronamespace = 'public'::regnamespace
     and u.mode = 't';

  perform pg_temp.check(
    columns = array[
      'theme', 'layout', 'status', 'attribution_suppressed', 'allowed_domains',
      'selection_mode', 'review_rating', 'review_text', 'review_author_name',
      'review_published_at', 'profile_url'
    ],
    'review_widget_render returns exactly the eleven columns the widget draws — no status, sentiment, risk level, or raw payload'
  );
end;
$$;

rollback;

-- ---------------------------------------------------------------------------
-- 8. The anonymous surface, at both layers that can close it.
--
-- Supabase's default grants are the thing to understand here, and they are the
-- reason 20260820000300 writes an explicit `revoke all ... from anon` rather
-- than relying on the absence of a policy.
--
-- `anon` and `authenticated` are granted broad table privileges on the whole
-- `public` schema by default; row-level security is what actually stops an
-- anonymous read, and `has_table_privilege` therefore returns TRUE for tables
-- an anon session can read nothing from. `public.mentions` is exactly that
-- case, and it is why `review_widget_render` has to be SECURITY DEFINER rather
-- than merely convenient.
--
-- So the two tables are checked at the two different layers that actually
-- apply: `review_widgets` at the grant layer, because the migration revoked
-- it, and `mentions` at the RLS layer, because nothing revoked it and the
-- policies are what hold.
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.check(
    has_function_privilege('anon', 'public.review_widget_render(text)', 'execute'),
    'anon may execute review_widget_render — the whole feature depends on it'
  );
  perform pg_temp.check(
    not has_table_privilege('anon', 'public.review_widgets', 'select'),
    'anon holds no SELECT grant on review_widgets — the explicit revoke, not merely a missing policy'
  );
  perform pg_temp.check(
    not has_table_privilege('authenticated', 'public.review_widgets', 'delete'),
    'no session holds a DELETE grant on review_widgets'
  );
end;
$$;

begin;

do $$
declare
  visible integer;
begin
  set local role anon;
  select count(*) into visible from public.mentions;
  reset role;

  perform pg_temp.check(
    visible = 0,
    'an anon session reads zero rows from mentions — the grant exists, RLS is what holds, and that is why the render function must be SECURITY DEFINER'
  );
end;
$$;

rollback;
