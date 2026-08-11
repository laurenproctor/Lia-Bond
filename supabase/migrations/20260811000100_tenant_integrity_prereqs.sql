-- Composite-key prerequisites for automation execution (Phase 2, G0).
--
-- These uniques exist so same-organization composite foreign keys become
-- expressible. Each is implied by the primary key plus the tenant column;
-- the cost is one index apiece.
--
-- `mentions_location_same_org` closes finding F14 of the Phase 2 spec: a
-- mention's location column was a simple FK to locations(id), so nothing in
-- the database prevented a mention pointing at another organization's
-- location. The pre-flight DO block asserts the constraint is true of
-- existing data — a violation is a live cross-tenant defect to investigate,
-- never data to grandfather.

do $$
declare violating integer;
begin
  select count(*) into violating
  from public.mentions m
  join public.locations l on l.id = m.location_id
  where m.location_id is not null
    and l.organization_id <> m.organization_id;
  if violating > 0 then
    raise exception
      'mentions_location_same_org pre-flight: % cross-organization mention locations exist',
      violating;
  end if;
end $$;

alter table public.automation_rules
  add constraint automation_rules_id_org unique (id, organization_id);

alter table public.locations
  add constraint locations_id_org unique (id, organization_id);

alter table public.mentions
  add constraint mentions_id_org unique (id, organization_id);

-- Proof target for "execution location equals mention location" (spec §5).
alter table public.mentions
  add constraint mentions_id_org_location
    unique (id, organization_id, location_id);

alter table public.mentions
  add constraint mentions_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id);

alter table public.mention_analyses
  add constraint mention_analyses_id_mention_org
    unique (id, mention_id, organization_id);
