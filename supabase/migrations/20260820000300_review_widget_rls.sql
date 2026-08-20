-- Row-level security for the website review widget.
--
-- The table is ordinary tenant configuration and its read policy says so. The
-- write policies are narrower than `can_write_in_organization`, and the reason
-- is what makes this table different from every other configuration table in
-- the schema: a row here decides what appears on a page the public can see.
-- An automation rule misconfigured is an internal mistake somebody notices in
-- the queue; a widget misconfigured is a stranger reading a one-star review on
-- a restaurant's homepage.
--
-- So the write roles are restated here rather than trusted from the server
-- action — the precedent `onboarding.manage` set, and for the same stated
-- reason: a check in application code protects only the path that runs it.

alter table public.review_widgets enable row level security;

-- ---------------------------------------------------------------------------
-- Read: any member.
--
-- Deliberately not narrowed to the write roles. An analyst asked "why is that
-- review on our website" must be able to answer it, and the row holds no
-- credential, no token, and no content — the public id it does hold is on the
-- customer's own website already.
-- ---------------------------------------------------------------------------

create policy review_widgets_select on public.review_widgets
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- ---------------------------------------------------------------------------
-- Write: owners, admins, and the communications lead.
--
-- The same three roles that hold `brand_voice.update` and
-- `automation_rule.manage`, and for the same reason those two share a list:
-- all three decide what the product says without a person in the loop. The
-- communications lead owns the words a restaurant publishes, and a widget is
-- words a restaurant publishes.
--
-- Location managers are absent, and this is the one place in the schema where
-- their absence needs an argument, because a widget *does* carry a location
-- and `canForLocation` could scope them to it. Two reasons it does not:
--
--   * `has_organization_role` cannot express "and only for their own
--     locations" — the location scoping would live in application code alone,
--     and this table's whole posture is that application code is not the last
--     line for a surface the public can see.
--   * Approving what goes on the company website is not a per-restaurant
--     decision even when its subject is one restaurant. A group's marketing
--     site is one artefact.
--
-- If that becomes wrong, the fix is a policy that joins `locations` on
-- `manager_user_id`, not a widening of this list.
-- ---------------------------------------------------------------------------

create policy review_widgets_insert on public.review_widgets
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy review_widgets_update on public.review_widgets
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
-- would erase that at exactly the moment somebody is asking why a review
-- disappeared from their website. The same posture `automation_rules` takes
-- with `archived_at` and `audit_events` takes with everything: nothing short
-- of a migration removes a row. A deleted *location* still removes its widget,
-- through the cascade, because a widget for a restaurant that no longer exists
-- is not a record worth keeping.
revoke delete on public.review_widgets from authenticated;

-- ---------------------------------------------------------------------------
-- The anonymous render path.
--
-- `review_widget_render` is SECURITY DEFINER, so it runs with the definer's
-- rights and the policies above do not apply inside it. That is the point —
-- an embed request has no session — and it is also why the grant is written
-- out explicitly rather than left to the default.
--
-- `revoke ... from public` first, then grant to the two roles that may call
-- it. Without the revoke, `public` retains EXECUTE and the grant below is
-- decoration; this is the same belt-and-braces the OAuth helper functions got
-- in 20260807000600.
--
-- `anon` is on the list because that is the whole feature: a visitor to a
-- restaurant's website is not signed in to Lia and never will be.
-- `authenticated` is on it because the in-app preview frames the same document
-- from a signed-in browser, and it would otherwise be the one caller that
-- could not see what it was about to publish.
-- ---------------------------------------------------------------------------

revoke execute on function public.review_widget_render(text) from public;
grant execute on function public.review_widget_render(text) to anon, authenticated;

-- No table grant accompanies that. `anon` has SELECT on nothing here: the
-- function is the entire anonymous surface, it takes one argument, and it
-- returns eleven named columns. A widened `select` on review_widgets for anon
-- would additionally expose every organization's allowed domains and location
-- ids to anybody who asked.
revoke all on public.review_widgets from anon;
