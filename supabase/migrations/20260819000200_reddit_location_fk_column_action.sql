-- Deleting a location must not fail because a Reddit monitor referenced it
--
-- `rmq_location_same_org` (20260813000700) is a composite foreign key on a
-- nullable column with a **bare** `on delete set null`:
--
--   foreign key (location_id, organization_id)
--     references public.locations (id, organization_id) on delete set null
--
-- A bare `set null` nulls *every* referencing column, not just the nullable
-- one, and `reddit_monitoring_queries.organization_id` is `not null`. So
-- deleting a location that any Reddit monitor points at does not clear
-- `location_id` — it tries to null `organization_id` too and raises 23502.
--
-- Reproduced against the merged schema before writing this:
--
--   null value in column "organization_id" of relation
--   "reddit_monitoring_queries" violates not-null constraint  (23502)
--
-- The composite key itself is right, and is the same hardening this branch
-- applies to `platform_profiles`, `monitoring_queries`, and `mentions`. Only
-- the referential action is wrong, and it is wrong in exactly the way D206
-- records: PostgreSQL 15 added the column list for this shape, and every
-- composite FK on a nullable column needs it.
--
-- **How reachable is it?** No request path deletes a location — the product
-- retires them by moving to `inactive`, and 20260814000500 revokes `DELETE` on
-- `locations` from `authenticated` outright. But it is reachable from
-- service-role paths, from a migration, and from any test that deletes a
-- location: this branch's own harness check T-20 does exactly that, and passes
-- today only because it creates its own throwaway location that no seeded
-- monitor references. It also means "delete a location" is not a recoverable
-- operation for an operator, which is a surprising thing to discover during an
-- incident.
--
-- A new migration rather than an edit to 20260813000700, because that one has
-- already been applied wherever this schema exists.

do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception
      'Column-specific ON DELETE SET NULL needs PostgreSQL 15 or later (found %)',
      current_setting('server_version')
      using errcode = '0A000';
  end if;
end $$;

alter table public.reddit_monitoring_queries
  drop constraint rmq_location_same_org;

alter table public.reddit_monitoring_queries
  add constraint rmq_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
    on delete set null (location_id);

comment on column public.reddit_monitoring_queries.location_id is
  'Null is organization-wide. Guaranteed same-organization by rmq_location_same_org; nulled when the location is deleted, leaving organization_id intact.';
