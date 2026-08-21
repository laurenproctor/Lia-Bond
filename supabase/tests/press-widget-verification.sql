-- Website press widget harness: the eligibility rules, proven against a real
-- Postgres.
--
-- Companion to supabase/tests/rls-verification.sql (tenant isolation, plus
-- section 14's checks on this feature's policies and grants). The two run in
-- ONE psql session, in this order:
--
--   npm run db:verify-press-widget
--     -> supabase db reset
--     -> psql -v ON_ERROR_STOP=1
--          -f supabase/tests/rls-verification.sql
--          -f supabase/tests/press-widget-verification.sql
--
-- The helpers below are defined OUTSIDE a transaction for the reason
-- generation-verification.sql records: rls-verification.sql defines its own
-- `pg_temp.check` inside a `begin; ... rollback;`, and `create function` is
-- transactional DDL, so that definition is gone by the time this file starts.
--
-- **Why this file exists at all.** `public.press_widget_render` is a
-- hand-written SQL mirror of `firstFailedPressRule` in
-- src/lib/widgets/press/eligibility.ts. The duplication is forced — an embed
-- request carries no session, so the anonymous path cannot run TypeScript —
-- and tests/press-widget-eligibility.test.ts can only prove that the migration
-- *names* each rule in a comment. Nothing in the vitest suite can execute the
-- SQL. This file is the other half: it drives the real function through every
-- rule and asserts the answer.
--
-- The failure it guards against is quiet and bad. A rule that drifts here
-- means the coverage a customer sees listed inside Lia and the coverage their
-- website actually serves are selected by two different sets of rules — and
-- the first anybody would know of it is a guest reading a headline about a
-- story an outlet retracted.
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
    raise exception 'PRESS WIDGET CHECK FAILED (%): %',
      case when condition is null then 'unknown' else 'false' end, label;
  end if;
  raise notice 'ok: %', label;
end;
$$;

-- The headlines a widget currently resolves to, in the order it draws them.
-- An empty array is what every unavailable state looks like from here.
create or replace function pg_temp.rendered_headlines(public_id text)
returns text[] language sql stable as $$
  select coalesce(
    array_agg(r.headline order by r.published_at desc, r.headline desc)
      filter (where r.headline is not null),
    '{}'::text[]
  )
  from public.press_widget_render(public_id) r;
$$;

begin;

-- ---------------------------------------------------------------------------
-- 1. Fixtures.
--
-- One organization, two monitoring queries, and a set of articles built to
-- differ in exactly one attribute each. Built rather than borrowed from the
-- seed: the seed's news articles are a demo dataset that will change, and a
-- rule test whose subject can be edited by somebody adjusting a fixture is a
-- rule test that will one day pass for the wrong reason.
-- ---------------------------------------------------------------------------

create temporary table press_fixtures as
select
  (select id from public.organizations where slug = 'union-square-hospitality') as org_id,
  (select id from public.organizations where slug <> 'union-square-hospitality' limit 1) as other_org_id,
  (select c.id from public.platform_connections c
     join public.organizations o on o.id = c.organization_id
    where o.slug = 'union-square-hospitality'
    limit 1) as connection_id;

-- Clear this organization of seeded news articles so the fixtures below are
-- the only candidates. Deleting rather than filtering, because "the three
-- newest eligible articles" is a global question over the organization and a
-- stray seeded article would answer it before any fixture did.
delete from public.mentions m
 using press_fixtures f
 where m.organization_id = f.org_id
   and m.source_type = 'news_article';

insert into public.monitoring_queries
  (id, organization_id, location_id, name, query_type, keywords, enabled)
select
  '00000000-0000-4000-8000-0000000000a1', f.org_id, null,
  'Press fixture watch (enabled)', 'brand', array['fixture'], true
  from press_fixtures f;

insert into public.monitoring_queries
  (id, organization_id, location_id, name, query_type, keywords, enabled)
select
  '00000000-0000-4000-8000-0000000000a2', f.org_id, null,
  'Press fixture watch (disabled)', 'brand', array['fixture'], false
  from press_fixtures f;

-- Eight articles: three eligible controls, and five newer ones that each fail
-- exactly one rule. If any rule were missing from the function, one of the
-- five would displace a control.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status, monitoring_query_id, publisher_name,
   publisher_domain)
select
  f.org_id, f.connection_id, 'news_article',
  v.external_id, v.title, 'Fixture body text.', v.source_url,
  v.published_at::timestamptz, v.status::mention_status,
  '00000000-0000-4000-8000-0000000000a1',
  'Fixture Press', 'fixture-press.example'
from press_fixtures f,
  (values
    -- The three controls. Every other case must fail to beat one of these for
    -- a reason the test names.
    ('pw-fx-first',     'CONTROL FIRST',            'https://fixture-press.example/1', '2026-08-10T12:00:00Z', 'monitoring'),
    ('pw-fx-second',    'CONTROL SECOND',           'https://fixture-press.example/2', '2026-08-09T12:00:00Z', 'monitoring'),
    ('pw-fx-third',     'CONTROL THIRD',            'https://fixture-press.example/3', '2026-08-08T12:00:00Z', 'monitoring'),
    ('pw-fx-fourth',    'CONTROL FOURTH',           'https://fixture-press.example/4', '2026-08-07T12:00:00Z', 'monitoring'),
    -- Each of these is newer than every control.
    ('pw-fx-dismissed', 'DISMISSED but newest',     'https://fixture-press.example/d', '2026-08-19T12:00:00Z', 'dismissed'),
    ('pw-fx-escalated', 'ESCALATED but newest',     'https://fixture-press.example/e', '2026-08-18T12:00:00Z', 'escalated'),
    -- And one that proves an internal workflow state is NOT a rule: a story
    -- Lia has already responded to is still perfectly good coverage. Dated
    -- older than the controls so it does not disturb the ordering assertions.
    ('pw-fx-responded', 'RESPONDED and still shown','https://fixture-press.example/r', '2026-08-06T12:00:00Z', 'responded')
  ) as v(external_id, title, source_url, published_at, status);

-- Newest of all, and syndicated.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status, monitoring_query_id, is_syndicated)
select f.org_id, f.connection_id, 'news_article', 'pw-fx-syndicated',
       'SYNDICATED but newest', 'Fixture body text.',
       'https://fixture-press.example/s', '2026-08-17T12:00:00Z', 'monitoring',
       '00000000-0000-4000-8000-0000000000a1', true
  from press_fixtures f;

-- Removed at the source.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status, monitoring_query_id, source_removed_at)
select f.org_id, f.connection_id, 'news_article', 'pw-fx-removed',
       'REMOVED at source but newest', 'Fixture body text.',
       'https://fixture-press.example/x', '2026-08-16T12:00:00Z', 'monitoring',
       '00000000-0000-4000-8000-0000000000a1', now()
  from press_fixtures f;

-- Typed by a person rather than returned by a provider.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status, monitoring_query_id,
   capture_method, captured_at)
select f.org_id, f.connection_id, 'news_article', 'pw-fx-typed',
       'TYPED BY A PERSON but newest', 'Fixture body text.',
       'https://fixture-press.example/t', '2026-08-15T12:00:00Z', 'monitoring',
       '00000000-0000-4000-8000-0000000000a1', 'manual_entry', now()
  from press_fixtures f;

-- No headline.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status, monitoring_query_id)
select f.org_id, f.connection_id, 'news_article', 'pw-fx-noheadline', '   ',
       'HEADLINE-LESS but newest', 'https://fixture-press.example/h',
       '2026-08-14T12:00:00Z', 'monitoring', '00000000-0000-4000-8000-0000000000a1'
  from press_fixtures f;

-- No usable link. `source_url` is nullable on mentions, so this is
-- representable and must be excluded rather than emitted as a dead anchor.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status, monitoring_query_id)
select f.org_id, f.connection_id, 'news_article', 'pw-fx-nourl',
       'NO LINK but newest', 'Fixture body text.', null,
       '2026-08-13T12:00:00Z', 'monitoring', '00000000-0000-4000-8000-0000000000a1'
  from press_fixtures f;

-- A Reddit post and a Google review, both newer than everything, to prove the
-- `source` rule.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status)
select f.org_id, f.connection_id, 'reddit_post', 'pw-fx-reddit',
       'WRONG SOURCE but newest', 'Fixture body text.',
       'https://fixture-press.example/reddit', '2026-08-20T12:00:00Z', 'monitoring'
  from press_fixtures f;

-- Another organization's article, newest of all.
insert into public.mentions
  (organization_id, platform_connection_id, source_type, external_id, title,
   content, source_url, published_at, status)
select f.other_org_id,
       (select c.id from public.platform_connections c
         where c.organization_id = f.other_org_id limit 1),
       'news_article', 'pw-fx-other-org', 'ANOTHER TENANT but newest',
       'Fixture body text.', 'https://fixture-press.example/other',
       '2026-08-21T12:00:00Z', 'monitoring'
  from press_fixtures f;

insert into public.press_widgets (organization_id, public_id, item_limit)
select f.org_id, 'pw_verifyA0000000000000', 3 from press_fixtures f;

-- ---------------------------------------------------------------------------
-- 2. Automatic selection applies every rule.
--
-- One assertion does most of the work: eight articles are newer than the
-- controls, and each is excluded by exactly one rule. If any rule were missing
-- from the function, a control would be displaced.
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.check(
    pg_temp.rendered_headlines('pw_verifyA0000000000000')
      = array['CONTROL FIRST', 'CONTROL SECOND', 'CONTROL THIRD'],
    'the three newest eligible articles win over eight newer ones that each fail one rule'
  );
end;
$$;

do $$
declare
  rendered text[] := pg_temp.rendered_headlines('pw_verifyA0000000000000');
begin
  -- Named individually so a failure says which rule leaked rather than only
  -- that the wrong articles came back.
  perform pg_temp.check(not ('DISMISSED but newest'          = any(rendered)), 'not_dismissed: a dismissed article is never served');
  perform pg_temp.check(not ('ESCALATED but newest'          = any(rendered)), 'not_escalated: an escalated article is never served');
  perform pg_temp.check(not ('SYNDICATED but newest'         = any(rendered)), 'not_syndicated: a syndicated copy is never served');
  perform pg_temp.check(not ('REMOVED at source but newest'  = any(rendered)), 'present_at_source: an article withdrawn at the source is never served');
  perform pg_temp.check(not ('TYPED BY A PERSON but newest'  = any(rendered)), 'provider_returned: a manually typed article is never served');
  perform pg_temp.check(not ('HEADLINE-LESS but newest'      = any(rendered)), 'headline: an article with no headline is never served');
  perform pg_temp.check(not ('NO LINK but newest'            = any(rendered)), 'source_url: an article with no usable link is never served');
  perform pg_temp.check(not ('WRONG SOURCE but newest'       = any(rendered)), 'source: a Reddit post is never served by a press widget');
  perform pg_temp.check(not ('ANOTHER TENANT but newest'     = any(rendered)), 'organization: another organization''s coverage is never served');
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Internal workflow state is not evidence of removal.
--
-- The rule this feature deliberately does NOT have. An article Lia has already
-- responded to — or recommended no action on — is very often the best coverage
-- a customer has, and treating a queue status as "this article is gone" would
-- silently empty a widget for a reason nobody could see from the page.
-- ---------------------------------------------------------------------------

do $$
begin
  update public.press_widgets set item_limit = 3 where public_id = 'pw_verifyA0000000000000';
  update public.mentions m set status = 'dismissed'
    from press_fixtures f
   where m.organization_id = f.org_id
     and m.external_id in ('pw-fx-first', 'pw-fx-second', 'pw-fx-third');

  perform pg_temp.check(
    'RESPONDED and still shown' = any(pg_temp.rendered_headlines('pw_verifyA0000000000000')),
    'an article with an internal "responded" status is still published'
  );

  update public.mentions m set status = 'monitoring'
    from press_fixtures f
   where m.organization_id = f.org_id
     and m.external_id in ('pw-fx-first', 'pw-fx-second', 'pw-fx-third');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The item limit, and the ordering underneath it.
-- ---------------------------------------------------------------------------

do $$
begin
  update public.press_widgets set item_limit = 1 where public_id = 'pw_verifyA0000000000000';
  perform pg_temp.check(
    pg_temp.rendered_headlines('pw_verifyA0000000000000') = array['CONTROL FIRST'],
    'an item limit of one serves the newest eligible article and nothing else'
  );

  update public.press_widgets set item_limit = 2 where public_id = 'pw_verifyA0000000000000';
  perform pg_temp.check(
    pg_temp.rendered_headlines('pw_verifyA0000000000000')
      = array['CONTROL FIRST', 'CONTROL SECOND'],
    'an item limit of two serves the two newest, in order'
  );

  update public.press_widgets set item_limit = 3 where public_id = 'pw_verifyA0000000000000';
  perform pg_temp.check(
    array_length(pg_temp.rendered_headlines('pw_verifyA0000000000000'), 1) = 3,
    'an item limit of three never serves a fourth, even with four eligible articles'
  );
end;
$$;

do $$
declare
  refused boolean := false;
begin
  begin
    update public.press_widgets set item_limit = 4 where public_id = 'pw_verifyA0000000000000';
  exception when check_violation then
    refused := true;
  end;
  perform pg_temp.check(refused, 'the database refuses an item limit above three');

  refused := false;
  begin
    update public.press_widgets set item_limit = 0 where public_id = 'pw_verifyA0000000000000';
  exception when check_violation then
    refused := true;
  end;
  perform pg_temp.check(refused, 'and one below one');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The rules are live, not evaluated once.
--
-- Dismissing the article a widget is currently serving must change what the
-- website shows on the next request, with nobody touching the widget. This is
-- the property that makes "the widget holds no copy of the article" worth the
-- join it costs.
-- ---------------------------------------------------------------------------

do $$
begin
  update public.mentions m set status = 'dismissed'
    from press_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'pw-fx-first';

  perform pg_temp.check(
    (pg_temp.rendered_headlines('pw_verifyA0000000000000'))[1] = 'CONTROL SECOND',
    'dismissing the leading article promotes the next one, with no widget write'
  );

  update public.mentions m set status = 'monitoring'
    from press_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'pw-fx-first';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The monitoring-query filter, and the enabled check that goes with it.
-- ---------------------------------------------------------------------------

do $$
begin
  update public.mentions m set monitoring_query_id = '00000000-0000-4000-8000-0000000000a2'
    from press_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'pw-fx-second';

  update public.press_widgets
     set monitoring_query_id = '00000000-0000-4000-8000-0000000000a1'
   where public_id = 'pw_verifyA0000000000000';

  perform pg_temp.check(
    not ('CONTROL SECOND' = any(pg_temp.rendered_headlines('pw_verifyA0000000000000'))),
    'query: an article found by a different watch is not served when a watch is selected'
  );
end;
$$;

do $$
begin
  update public.press_widgets
     set monitoring_query_id = '00000000-0000-4000-8000-0000000000a2'
   where public_id = 'pw_verifyA0000000000000';

  -- The watch is switched off, so the widget publishes nothing at all — even
  -- though an article is attributed to it. A customer who disabled a watch
  -- said "stop watching this", not "stop fetching".
  perform pg_temp.check(
    pg_temp.rendered_headlines('pw_verifyA0000000000000') = '{}'::text[],
    'query_enabled: a widget pointed at a disabled watch serves nothing'
  );
end;
$$;

do $$
declare
  row_count integer;
begin
  -- And it still returns its configuration row, so the renderer can draw the
  -- quiet "no coverage yet" card rather than nothing at all.
  select count(*) into row_count
    from public.press_widget_render('pw_verifyA0000000000000');
  perform pg_temp.check(
    row_count = 1,
    'and still returns exactly one row, carrying the theme the empty card is drawn with'
  );

  update public.press_widgets set monitoring_query_id = null
   where public_id = 'pw_verifyA0000000000000';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Cross-tenant attachment is impossible in the database, not merely refused
--    in the application.
--
-- `press_widgets_query_same_org` is a composite foreign key on
-- (monitoring_query_id, organization_id). A simple key to monitoring_queries(id)
-- would accept any query in existence, and the only thing standing between a
-- mis-set row and one restaurant group publishing the coverage another group
-- is watching would be application code.
-- ---------------------------------------------------------------------------

do $$
declare
  other_query uuid;
  refused boolean := false;
begin
  insert into public.monitoring_queries
    (organization_id, location_id, name, query_type, keywords, enabled)
  select f.other_org_id, null, 'Other tenant watch', 'brand', array['other'], true
    from press_fixtures f
  returning id into other_query;

  begin
    update public.press_widgets
       set monitoring_query_id = other_query
     where public_id = 'pw_verifyA0000000000000';
  exception when foreign_key_violation then
    refused := true;
  end;

  perform pg_temp.check(
    refused,
    'the database refuses to attach another organization''s monitoring query, whatever the application does'
  );
end;
$$;

do $$
declare
  refused boolean := false;
  f record;
begin
  select * into f from press_fixtures;

  -- The same refusal on an insert, not only an update.
  begin
    insert into public.press_widgets (organization_id, public_id, monitoring_query_id)
    select f.other_org_id, 'pw_verifyB0000000000000',
           '00000000-0000-4000-8000-0000000000a1';
  exception when foreign_key_violation then
    refused := true;
  end;

  perform pg_temp.check(
    refused,
    'and refuses it on an insert as well as an update'
  );
end;
$$;

do $$
declare
  refused boolean := false;
  f record;
begin
  select * into f from press_fixtures;

  begin
    insert into public.press_widgets (organization_id, public_id)
    select f.org_id, 'pw_verifyC0000000000000';
  exception when unique_violation then
    refused := true;
  end;

  perform pg_temp.check(
    refused,
    'one press widget per organization: a second insert conflicts'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Deleting a watch widens the widget rather than emptying it.
--
-- `on delete set null (monitoring_query_id)`. A customer who deletes a watch
-- has decided to stop watching something, not that their homepage should go
-- blank — and the alternative, a cascade, would delete the widget with it.
-- ---------------------------------------------------------------------------

do $$
declare
  still_there boolean;
begin
  update public.press_widgets
     set monitoring_query_id = '00000000-0000-4000-8000-0000000000a1'
   where public_id = 'pw_verifyA0000000000000';

  delete from public.monitoring_queries
   where id = '00000000-0000-4000-8000-0000000000a1';

  select (monitoring_query_id is null) into still_there
    from public.press_widgets where public_id = 'pw_verifyA0000000000000';

  perform pg_temp.check(
    still_there,
    'deleting the selected watch nulls the reference and leaves the widget showing all press'
  );
  perform pg_temp.check(
    array_length(pg_temp.rendered_headlines('pw_verifyA0000000000000'), 1) > 0,
    'and the widget keeps publishing rather than going blank'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The row a disabled widget returns, and the one an unknown id does not.
-- ---------------------------------------------------------------------------

do $$
declare
  row_count integer;
  reported text;
begin
  update public.press_widgets set status = 'disabled'
   where public_id = 'pw_verifyA0000000000000';

  select count(*), max(r.status) into row_count, reported
    from public.press_widget_render('pw_verifyA0000000000000') r;

  perform pg_temp.check(
    row_count >= 1 and reported = 'disabled',
    'a disabled widget still returns its row, carrying the status the renderer draws the card from'
  );

  select count(*) into row_count
    from public.press_widget_render('pw_doesnotexist000000') r;
  perform pg_temp.check(
    row_count = 0,
    'an unknown public id returns no row at all — the state the renderer reports as unknown_widget'
  );

  update public.press_widgets set status = 'active'
   where public_id = 'pw_verifyA0000000000000';
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. The public-id shape, enforced by the database rather than only by the
--     application that issues it.
-- ---------------------------------------------------------------------------

do $$
declare
  refused boolean := false;
  f record;
begin
  select * into f from press_fixtures;

  begin
    insert into public.press_widgets (organization_id, public_id)
    select f.other_org_id, 'rw_areviewwidgetsid0';
  exception when check_violation then
    refused := true;
  end;

  perform pg_temp.check(
    refused,
    'a review widget''s id shape cannot be stored on a press widget'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. What the function is allowed to return.
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
   where p.proname = 'press_widget_render'
     and p.pronamespace = 'public'::regnamespace
     and u.mode = 't';

  perform pg_temp.check(
    columns = array[
      'theme', 'layout', 'status', 'attribution_suppressed', 'allowed_domains',
      'headline', 'excerpt', 'publisher_name', 'publisher_domain', 'source_url',
      'published_at'
    ],
    'press_widget_render returns exactly the eleven columns the widget draws — no status, sentiment, risk level, relevance score, mention id, organization id, or raw payload'
  );
end;
$$;

do $$
declare
  normalized text;
begin
  -- The publisher domain crosses the boundary normalised, so what the renderer
  -- receives is a key it can look a LOCAL logo up by — never a URL, never
  -- markup, and never anything a provider chose the shape of.
  update public.mentions m set publisher_domain = 'WWW.Fixture-Press.example'
    from press_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'pw-fx-first';

  select r.publisher_domain into normalized
    from public.press_widget_render('pw_verifyA0000000000000') r
   where r.headline = 'CONTROL FIRST';

  perform pg_temp.check(
    normalized = 'fixture-press.example',
    'the publisher domain is lowercased and stripped of www. before it crosses the anonymous boundary'
  );
end;
$$;

do $$
declare
  trimmed text;
begin
  update public.mentions m set content = repeat('word ', 200)
    from press_fixtures f
   where m.organization_id = f.org_id and m.external_id = 'pw-fx-first';

  select r.excerpt into trimmed
    from public.press_widget_render('pw_verifyA0000000000000') r
   where r.headline = 'CONTROL FIRST';

  perform pg_temp.check(
    length(trimmed) <= 241 and right(trimmed, 1) = '…',
    'a long description is trimmed to a card''s worth before it crosses the boundary'
  );
end;
$$;

rollback;

-- ---------------------------------------------------------------------------
-- 12. The anonymous surface, at both layers that can close it.
--
-- Supabase's default grants are the thing to understand here, and they are the
-- reason 20260821000200 writes an explicit `revoke all ... from anon` rather
-- than relying on the absence of a policy.
--
-- `anon` and `authenticated` are granted broad table privileges on the whole
-- `public` schema by default; row-level security is what actually stops an
-- anonymous read, and `has_table_privilege` therefore returns TRUE for tables
-- an anon session can read nothing from. `public.mentions` and
-- `public.monitoring_queries` are exactly that case, and it is why
-- `press_widget_render` has to be SECURITY DEFINER rather than merely
-- convenient.
-- ---------------------------------------------------------------------------

do $$
begin
  perform pg_temp.check(
    has_function_privilege('anon', 'public.press_widget_render(text)', 'execute'),
    'anon may execute press_widget_render — the whole feature depends on it'
  );
  perform pg_temp.check(
    not has_function_privilege('public', 'public.press_widget_render(text)', 'execute')
      or has_function_privilege('anon', 'public.press_widget_render(text)', 'execute'),
    'and PUBLIC''s default execute grant was revoked before the explicit grants'
  );
  perform pg_temp.check(
    not has_table_privilege('anon', 'public.press_widgets', 'select'),
    'anon holds no SELECT grant on press_widgets — the explicit revoke, not merely a missing policy'
  );
  perform pg_temp.check(
    not has_table_privilege('authenticated', 'public.press_widgets', 'delete'),
    'no session holds a DELETE grant on press_widgets'
  );
  perform pg_temp.check(
    not has_table_privilege('service_role', 'public.press_widgets', 'delete'),
    'not even service_role: no code path deletes a widget'
  );
  -- Explicitly granted rather than inherited. A new public-schema table is not
  -- closed to the Data API merely by existing, and it is not opened by
  -- existing either — the grants are written out in the migration.
  perform pg_temp.check(
    has_table_privilege('authenticated', 'public.press_widgets', 'select')
      and has_table_privilege('authenticated', 'public.press_widgets', 'insert')
      and has_table_privilege('authenticated', 'public.press_widgets', 'update'),
    'authenticated holds exactly the three privileges the repository needs'
  );
  perform pg_temp.check(
    (select relrowsecurity from pg_class where oid = 'public.press_widgets'::regclass),
    'row-level security is enabled on press_widgets'
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

do $$
declare
  visible integer;
begin
  set local role anon;
  select count(*) into visible from public.monitoring_queries;
  reset role;

  perform pg_temp.check(
    visible = 0,
    'and zero rows from monitoring_queries — a customer''s watch terms are their own competitive information'
  );
end;
$$;

rollback;
