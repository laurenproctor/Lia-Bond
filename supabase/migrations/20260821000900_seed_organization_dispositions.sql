-- Mark the two seeded demo organizations as internal.
--
-- Rollout step 7: every organization that predates billing needs an explicit
-- disposition, because the alternative — free access as the *absence* of a
-- subscription row — is indistinguishable from a customer who never paid.
-- These two are Lia's own demo tenants, seeded by `supabase/seed.sql` from
-- `src/lib/seed/dataset.ts`, and `internal` is what they are.
--
-- Their ids are deterministic (derived in `src/lib/seed/ids.ts`), so this
-- applies to any environment that carries them and is a no-op anywhere else.
--
-- **Guarded on the organization existing, and that guard is load-bearing.**
-- `supabase db reset` applies migrations *before* running the seed, so on a
-- fresh database these rows do not exist yet and an unguarded insert would
-- fail the foreign key. `where exists` makes this a no-op locally at migration
-- time and effective on an environment that has already been seeded — which is
-- the only place the distinction matters, since a disposition only does
-- anything once `BILLING_ENFORCEMENT_MODE` is on.
--
-- Written directly rather than through `set_billing_access_disposition()`
-- because that function writes an audit event, and an audit event needs an
-- actor and a moment. A backfill has neither: nobody decided this on a
-- particular Tuesday, it is a statement about what these rows have always
-- been. The three *hosted-only* test organizations are a different case and do
-- go through the function — they are a decision, taken today, by a person.
--
-- No expiry: an internal tenant does not stop being internal.

insert into public.organization_billing (
  organization_id, access_disposition, access_disposition_note
)
select o.id, 'internal', 'Seeded demo organization — see supabase/seed.sql'
from public.organizations o
where o.id in (
  -- Union Square Hospitality Group
  '2e10c03b-59de-5083-b50b-c2878784ebaa',
  -- Harbor & Vine Restaurant Group
  '2cfb101c-667c-588b-a37e-d52a0f6209ba'
)
on conflict (organization_id) do update
  set access_disposition = 'internal',
      access_disposition_expires_at = null,
      access_disposition_note = excluded.access_disposition_note,
      updated_at = now();
