-- Row-level security for the website press widget.
--
-- The same shape as `review_widgets` (20260820000300), and deliberately so:
-- these are two publishing surfaces with one authorisation story. A row in
-- either table decides what appears on a page the public can see, so both
-- restate the write roles here rather than trusting the server action — the
-- precedent `onboarding.manage` set, and for the same stated reason: a check
-- in application code protects only the path that runs it.
--
-- **On the permission's name.** The TypeScript permission is
-- `website_widget.manage`, renamed in this change from `review_widget.manage`
-- now that it gates two products. The role list is unchanged — owner, admin,
-- communications lead — which is why the policies below are identical to the
-- review widget's and why the rename needed no policy migration: the policies
-- have always named the roles rather than the permission, because
-- `has_organization_role` is what Postgres can express.

alter table public.press_widgets enable row level security;

-- ---------------------------------------------------------------------------
-- Read: any member.
--
-- Deliberately not narrowed to the write roles. An analyst asked "why is that
-- article on our website" must be able to answer it, and the row holds no
-- credential, no token, and no content — the public id it does hold is on the
-- customer's own website already.
-- ---------------------------------------------------------------------------

create policy press_widgets_select on public.press_widgets
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- ---------------------------------------------------------------------------
-- Write: owners, admins, and the communications lead.
--
-- The same three roles that hold `brand_voice.update` and
-- `automation_rule.manage`, and the same three the review widget's policies
-- name. All of them decide what the product says without a person in the loop.
-- The communications lead owns the words a restaurant publishes, and a press
-- strip is words a restaurant publishes.
--
-- Location managers are absent, and here the argument is easier than it was
-- for the review widget: a press widget carries no location at all. Its only
-- filter is a monitoring query, which may be organization-wide, so there is
-- nothing for `canForLocation` to scope them to even in principle.
--
-- `to authenticated` on its own would be insufficient and is not what is
-- written: every clause below carries an ownership-and-role predicate, so a
-- signed-in member of another organization matches nothing.
-- ---------------------------------------------------------------------------

create policy press_widgets_insert on public.press_widgets
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy press_widgets_update on public.press_widgets
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  )
  -- Not redundant with `using`: without it, a member of two organizations
  -- could update a row in one and move it to the other. The same pairing every
  -- update policy in this schema carries.
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

-- No delete policy, deliberately.
--
-- "Revoke" in this feature is rotation of the public id, and "switch it off"
-- is `status = 'disabled'` — both of which leave a row, and therefore a record
-- that a widget existed and what it was configured to show. Deleting the row
-- would erase that at exactly the moment somebody is asking why a headline
-- disappeared from their website. A deleted *organization* still removes its
-- widget, through the cascade.
revoke delete on public.press_widgets from authenticated;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Written out rather than left to the default, because Supabase grants `anon`
-- and `authenticated` broad table privileges on the whole `public` schema by
-- default. A new table is NOT closed to the Data API merely by existing, and
-- the absence of a policy is not the same guarantee as the absence of a grant:
-- a missing policy yields zero rows, a missing grant raises 42501 before RLS
-- is consulted at all.
--
-- `authenticated` gets exactly what the four repository methods need — select,
-- insert, and update — and nothing else. `service_role` gets the same three.
--
-- **The grants alone are not the narrowing, and this is the trap.** Supabase's
-- `alter default privileges` hands both roles ALL privileges on every new table
-- in `public`, and `grant select, insert, update` does not take back the DELETE
-- they already hold — a grant adds, it never subtracts. So the revokes below
-- are what actually close the door, and they are written out for both roles.
-- Caught by supabase/tests/press-widget-verification.sql, which asserts the
-- absence rather than trusting the grant list above to imply it.
-- ---------------------------------------------------------------------------

grant select, insert, update on public.press_widgets to authenticated;
grant select, insert, update on public.press_widgets to service_role;

-- No code path deletes a press widget: "revoke" is a public-id rotation and
-- "switch off" is a status, and both leave the row. A privilege nobody uses is
-- a privilege nobody notices being used, so neither role keeps it. A migration
-- runs as the table's owner and is unaffected, which is the one path that
-- should be able to remove a row and the one that leaves a record of doing so.
revoke delete on public.press_widgets from service_role;

-- `anon` has SELECT on nothing here: the function below is the entire
-- anonymous surface. A widened `select` on press_widgets for anon would
-- additionally expose every organization's approved domains and monitoring
-- query ids to anybody who asked.
revoke all on public.press_widgets from anon;

-- ---------------------------------------------------------------------------
-- The anonymous render path.
--
-- `press_widget_render` is SECURITY DEFINER, so it runs with the definer's
-- rights and the policies above do not apply inside it. That is the point — an
-- embed request has no session — and it is also why the grant is written out
-- explicitly rather than left to the default.
--
-- `revoke ... from public` first, then grant to the two roles that may call
-- it. Without the revoke, `public` retains EXECUTE and the grant below is
-- decoration; this is the same belt-and-braces the OAuth helper functions got
-- in 20260807000600 and `review_widget_render` got in 20260820000300.
--
-- `anon` is on the list because that is the whole feature: a visitor to a
-- restaurant's website is not signed in to Lia and never will be.
-- `authenticated` is on it because the in-app preview frames the same document
-- from a signed-in browser.
-- ---------------------------------------------------------------------------

revoke execute on function public.press_widget_render(text) from public;
grant execute on function public.press_widget_render(text) to anon, authenticated;
