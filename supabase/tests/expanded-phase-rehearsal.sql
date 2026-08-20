-- ---------------------------------------------------------------------------
-- R1 rehearsal: put a fully-migrated database back into the expansion state
--
-- The rollout is expand-contract (D209). `20260814000500` — the location
-- write-role contraction — ships in a *later release* than the four expansion
-- migrations, so between R1 and R3 production is in a state no local command
-- reproduces: `supabase db reset` applies every migration in the directory,
-- including the contraction.
--
-- That gap is not cosmetic. The single most important property of the
-- expansion phase is that **the application deployed before it keeps working**
-- — specifically, that a communications lead can still create a location by
-- direct insert, because the deployed mapping code does exactly that and will
-- keep doing it until R2. `tenancy-verification.sql` asserts it as T-26, in a
-- section guarded on the contraction being absent. Without this file that
-- section is skipped on every local and CI run, and the assertion that matters
-- most for a safe rollout would be the one nothing ever executes.
--
-- So: reset, apply this, then run the harness. It reverses the contraction and
-- nothing else, using the rollback SQL recorded in 20260814000500's own header,
-- which is also the rollback an operator would run in anger.
--
--   supabase db reset
--   psql "$SUPABASE_DB_URL" -f supabase/tests/expanded-phase-rehearsal.sql
--   psql "$SUPABASE_DB_URL" -f supabase/tests/tenancy-verification.sql
--
-- or simply: npm run db:verify-tenancy-expanded
--
-- This is a test fixture. It is not a migration, it is not applied by
-- `db reset`, and nothing in `supabase/migrations/` references it.
-- ---------------------------------------------------------------------------

drop policy if exists locations_insert on public.locations;
drop policy if exists locations_update on public.locations;

create policy locations_insert on public.locations
  for insert to authenticated
  with check (public.can_write_in_organization(organization_id));

create policy locations_update on public.locations
  for update to authenticated
  using (public.can_write_in_organization(organization_id))
  with check (public.can_write_in_organization(organization_id));

create policy locations_delete on public.locations
  for delete to authenticated
  using (
    public.has_organization_role(organization_id, array['owner', 'admin']::membership_role[])
  );

grant delete on public.locations to authenticated;

-- `pg_temp.contracted()` in the harness keys off both signals — the delete
-- policy's presence and the DELETE privilege — so restoring the pair is what
-- flips it back to the expansion branch. Asserted here rather than assumed,
-- because a rehearsal that silently failed to rehearse is worse than no
-- rehearsal at all.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'locations' and policyname = 'locations_delete'
  ) then
    raise exception 'expanded-phase rehearsal: locations_delete was not restored';
  end if;

  if not has_table_privilege('authenticated', 'public.locations', 'delete') then
    raise exception 'expanded-phase rehearsal: DELETE was not re-granted to authenticated';
  end if;

  raise notice 'ok: database is back in the R1 expansion state';
end $$;
