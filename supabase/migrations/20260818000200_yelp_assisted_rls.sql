-- Row-level security for the Yelp Assisted tables.
--
-- Both new tables are **select-only for `authenticated`**, which is a departure
-- from the news precedent and a deliberate one. News lets members insert poll
-- runs because the "poll now" button writes one directly. Neither of these is
-- ever written by a person: a snapshot is what Lia observed, and an occurrence
-- is Lia's comparison of two observations. A member who could insert either
-- could fabricate review activity on their own listing — inventing an
-- occurrence out of nothing, or planting a snapshot that makes the *next*
-- genuine check report a change that never happened. Both are written by the
-- service-role check path only.
--
-- The reasoning matches `reddit_poll_runs` and `reddit_query_matches` in the
-- Reddit schema: where a row is evidence rather than configuration, sessions
-- read it and only the job writes it.
--
-- What a member *does* write is the resolution of an occurrence — capturing a
-- review against it, or dismissing it — and that is an UPDATE restricted to the
-- roles holding `mention.capture_manual`, restated here rather than trusted
-- from the server action, for the reason `onboarding.manage` established.

-- ---------------------------------------------------------------------------
-- Snapshots: read-only to sessions.
-- ---------------------------------------------------------------------------

alter table public.yelp_listing_snapshots enable row level security;

create policy yelp_listing_snapshots_select on public.yelp_listing_snapshots
  for select to authenticated
  using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.yelp_listing_snapshots from authenticated;

comment on table public.yelp_listing_snapshots is
  'One successful observation of a connected Yelp listing. Append-only, written by the service-role check path only: a member who could insert one could plant a baseline that makes the next genuine check report activity that never happened.';

-- ---------------------------------------------------------------------------
-- Occurrences: members read, and the capture roles resolve.
--
-- No insert policy and no delete policy, both on purpose. An occurrence is
-- created by the check service when it observes a change, and there is no
-- legitimate way for a person to author one. Deleting it would erase the record
-- that Lia noticed something and somebody dealt with it — the same posture
-- `automation_rules` takes with `archived_at` (D142) and `audit_events` takes
-- with everything: nothing short of a migration removes a row.
-- ---------------------------------------------------------------------------

alter table public.yelp_activity_occurrences enable row level security;

create policy yelp_activity_occurrences_select on public.yelp_activity_occurrences
  for select to authenticated
  using (public.is_organization_member(organization_id));

create policy yelp_activity_occurrences_update on public.yelp_activity_occurrences
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  )
  -- Not redundant with the `using` clause: without it, a member of two
  -- organizations could update a row in one and move it to the other.
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

revoke insert, delete on public.yelp_activity_occurrences from authenticated;

comment on table public.yelp_activity_occurrences is
  'One observed change in a connected Yelp listing''s counters. Written by the service-role check path; a member with the capture roles may only resolve one (capture or dismiss). No insert policy — a person cannot author an observation — and no delete policy, because deleting it would erase the record that Lia noticed something.';
