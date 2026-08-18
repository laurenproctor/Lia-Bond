-- Row-level security for the Reddit monitoring tables (Task 3 of the Reddit plan).
--
-- The shape follows what news settled on in 20260807000500: members read,
-- and only the three roles that hold `monitoring.manage_queries` write. The
-- role list is restated here rather than trusted from application code, for
-- the reason `onboarding.manage` established — a check in a server action
-- protects the one path that runs it, and the database protects the table.
--
-- Two departures from the news precedent, both deliberate:
--
--   * `reddit_poll_runs` and `reddit_query_matches` are select-only for
--     `authenticated`. News lets members insert poll runs because the
--     "poll now" button writes one directly. Reddit's runs are written by the
--     claim/finalize functions in the next migration, which serialize the
--     work — an authenticated insert would be a way to fabricate a claim and
--     get a real one refused.
--
--   * `reddit_rate_limit_state` gets no policy and no grant at all. It is not
--     customer data, it is not tenant-scoped, and it is not readable by a
--     session. Enabling RLS with zero policies is what makes that a refusal
--     rather than an oversight — the same posture `oauth_states` and
--     `platform_connection_secrets` already take.

-- ---------------------------------------------------------------------------
-- Monitoring queries: members read, write roles write.
-- ---------------------------------------------------------------------------

alter table public.reddit_monitoring_queries enable row level security;

create policy reddit_monitoring_queries_select on public.reddit_monitoring_queries
  for select to authenticated
  using (public.is_organization_member(organization_id));

create policy reddit_monitoring_queries_insert on public.reddit_monitoring_queries
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy reddit_monitoring_queries_update on public.reddit_monitoring_queries
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  )
  -- The `with check` is not redundant with the `using`: without it, a member
  -- of two organizations could update a row in one and move it to the other.
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy reddit_monitoring_queries_delete on public.reddit_monitoring_queries
  for delete to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

-- ---------------------------------------------------------------------------
-- Poll runs: read-only to sessions.
-- ---------------------------------------------------------------------------

alter table public.reddit_poll_runs enable row level security;

create policy reddit_poll_runs_select on public.reddit_poll_runs
  for select to authenticated
  using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.reddit_poll_runs from authenticated;

-- ---------------------------------------------------------------------------
-- Query matches: read-only to sessions.
--
-- Written only by the ingest function, because a match is the evidence
-- location attribution is derived from. A member who could insert one could
-- move somebody else's thread into their own restaurant's queue.
-- ---------------------------------------------------------------------------

alter table public.reddit_query_matches enable row level security;

create policy reddit_query_matches_select on public.reddit_query_matches
  for select to authenticated
  using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.reddit_query_matches from authenticated;

-- ---------------------------------------------------------------------------
-- Community postures: members read, write roles decide.
--
-- Deciding whether Lia may post into a community is the same class of act as
-- deciding what Lia watches, so it carries the same role list. It is
-- deliberately *not* narrowed to owners and admins: the communications lead is
-- the person who reads a subreddit's rules in the course of their work, and
-- routing that decision through an admin would mean it gets rubber-stamped by
-- somebody who has not read them.
-- ---------------------------------------------------------------------------

alter table public.reddit_community_postures enable row level security;

create policy reddit_community_postures_select on public.reddit_community_postures
  for select to authenticated
  using (public.is_organization_member(organization_id));

create policy reddit_community_postures_insert on public.reddit_community_postures
  for insert to authenticated
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

create policy reddit_community_postures_update on public.reddit_community_postures
  for update to authenticated
  using (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  )
  with check (
    public.has_organization_role(
      organization_id, array['owner', 'admin', 'communications_lead']::membership_role[]
    )
  );

-- No delete policy, and that is the point rather than an omission. A posture
-- is a record that somebody looked at a community's rules and made a call;
-- deleting it would erase the decision and silently return the community to
-- `unknown`, which reads as "never assessed" rather than "somebody changed
-- their mind". Reversing a decision is an update to `blocked`.

-- ---------------------------------------------------------------------------
-- Rate budget: no policy, no grant.
-- ---------------------------------------------------------------------------

alter table public.reddit_rate_limit_state enable row level security;

revoke all on public.reddit_rate_limit_state from authenticated;
revoke all on public.reddit_rate_limit_state from anon;

comment on table public.reddit_rate_limit_state is
  'Provider-global Reddit request budget, keyed on the OAuth client. Deliberately not tenant-scoped: Reddit meters per client, so the limit is consumed across every organization at once. RLS is enabled with zero policies and every grant revoked — service role only, matching oauth_states and platform_connection_secrets.';
