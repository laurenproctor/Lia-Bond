# Multi-organization and multi-location management — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any authenticated user belong to and switch among multiple
organizations, create new ones from inside Lia, and add and administer multiple
locations in the active organization — without weakening tenant isolation, the
permission model, auditability, demo/Supabase parity, or onboarding behaviour.

**Spec:** `docs/superpowers/specs/2026-08-13-multi-organization-and-location-management-design.md` — **read it before starting.** Decisions D191–D210 are §3; the SEC-1 follow-up is §6.1; the round-1 and round-2 delta is §8.

**Architecture:** **Six** work stages (A–F) inside one branch, and **three
production releases** (R1 expand → R2 application → R3 contract, D209). The two
are different axes and must not be confused: intra-branch task order is not a
substitute for production compatibility. Database contracts land first and alone
(Stage A); then domain schemas, permissions, and repositories (Stage B); then the
organization workflow (Stage C); then locations (Stage D); then status semantics
(Stage E); then documentation, rollout, and verification (Stage F).

**Tech stack:** Next.js 16 App Router (server components by default), TypeScript
strict + `noUncheckedIndexedAccess`, Zod 4, Vitest (node environment),
Supabase/PostgreSQL **≥ 15** with RLS, Tailwind v4.

---

## Global constraints

- **Sentence case throughout the interface.**
- **TypeScript strict.** No `any` without a justifying comment.
- **Server components by default**; `"use client"` only where interactivity
  requires it.
- **No page component over roughly 300 lines.** `/locations/page.tsx` is at 261
  today — extract before it crosses.
- **`runAction()` and `redirect()` do not compose.** `redirect()` throws
  `NEXT_REDIRECT`, which `runAction`'s catch converts into a generic failure.
  Every action here returns `{ nextPath }` and the client navigates. Do not
  "simplify" this.
- **Foreign ids stay indistinguishable from missing ones.** Scoped lookup returns
  `null`; the route calls `notFound()`. Definer functions return the same error
  code and message for unauthorized, foreign, and nonexistent ids. No "you don't
  have access to that" message anywhere.
- **Nothing may trust the active-organization cookie.**
- **Audit vocabulary changes land in `src/domain/enums.ts` and the migration
  together**, or `tests/audit-vocabulary-migrations.test.ts` fails — by design.
- **`npm run db:validate` after every migration.**
- **Demo and Supabase adapters must behave identically**, including audit-row
  emission and replay semantics. Where a definer function writes rows, the demo
  twin writes them too.
- **Expansion migrations must not break the currently deployed application.**
  Every expansion task states its compatibility argument explicitly, and Task F0
  verifies it before R2 ships.

---

## Task A00: Protect the dirty worktree, byte-sensitively

**Runs before anything else. Touches no file in the current tree.**

`master` carries uncommitted Google Business Profile work — including
`src/domain/enums.ts`, `src/lib/labels.ts`, `src/lib/integrations/google-service.ts`,
`docs/integrations/google-business-profile.md`, and untracked
`src/lib/fixtures/`. This plan edits the first, second, and fourth of those, so
the overlap is real.

**`git status --short` records paths and states, not contents.** Two different
edits to the same file produce identical status output, so the status listing
alone cannot prove the tree was untouched.

- [ ] Capture a **content fingerprint** into the task ledger:
      ```bash
      git rev-parse HEAD
      git branch --show-current
      git status --short
      git diff --binary        | shasum -a 256   # unstaged tracked changes
      git diff --cached --binary | shasum -a 256 # staged changes, if any
      git ls-files --others --exclude-standard | sort | tee /tmp/lia-untracked.txt
      git ls-files --others --exclude-standard -z | sort -z | xargs -0 shasum -a 256
      ```
      Record all seven outputs verbatim. The two diff hashes and the untracked
      manifest-plus-hashes are what make the check byte-sensitive; HEAD and
      branch alone are not.
- [ ] Create a **separate worktree** on a new branch from the recorded base
      commit, so the dirty tree is never checked out, stashed, or reset:
      ```bash
      git worktree add ../lia-multi-org -b multi-organization-and-locations <recorded-HEAD>
      ```
- [ ] Follow this repository's worktree setup: `next-env.d.ts` must exist and
      `SUPABASE_DB_URL` must be exported before any `db:verify-*` script runs.
      Copy `.env` in rather than symlinking it.
- [ ] **Never** run `git stash`, `git clean`, `git reset`, `git checkout --`, or
      any commit in the original working tree. If a task appears to require it,
      stop and ask.
- [ ] **Git metadata will change and that is expected.** `git worktree add`
      writes to `.git/worktrees/` and `.git/config`. The comparison in F2 covers
      working-tree contents only — the seven fingerprints above — and explicitly
      not `.git`.
- [ ] Reconciliation with the GBP work happens **only after both bodies are
      independently green**, as a normal merge taking both sides in `enums.ts`
      and `labels.ts`. Note in the ledger that D93 in `current-state.md` records
      what happens when parallel branches redefine the same closed audit
      constraint; the same care applies here, and this branch's
      `20260814000400` must remain the last word on it after the merge.

**Verify:** the new worktree is clean, and re-running the seven fingerprint
commands in the original tree reproduces the recorded values byte for byte.

---

## Stage A — Database contracts

Five migrations (four expansion, one contraction) and an expanded SQL harness.
No application code in this stage.

### Task A0: Read-only preflight against hosted

**Files:** none — an operator step, recorded so it is not skipped.

- [ ] `show server_version;` — must be ≥ 15 for column-specific referential
      actions (D206).
- [ ] Cross-tenant violation counts, as plain `SELECT`s, **before** A2 is
      written:
      - `platform_profiles` ⋈ `locations` on `location_id`, differing org ids
      - `monitoring_queries` ⋈ `locations` on `location_id`, differing org ids
      - `mentions` ⋈ `platform_profiles` on `platform_profile_id`, differing org ids
      - `locations` ⋈ `memberships` on `(organization_id, manager_user_id)`,
        rows with a non-null manager and no membership row
- [ ] The same manager query restricted to `status <> 'active'`, so the
      suspended-manager population is known before D207's trigger ships.
- [ ] Dependency probe for A1: `pg_depend` entries referencing
      `provision_organization`, and `pg_proc` rows whose `prosrc` names it.
- [ ] **Service-role caller probe for D210:** confirm nothing calls
      `organizations.provision` through `getServiceDataSource()`. Statically
      there is one call site
      ([supabase/index.ts:489](src/lib/data/supabase/index.ts#L489)) reached only
      from request paths; record the check so the `service_role` revoke is a
      verified decision.
- [ ] Record every count. **A non-zero cross-tenant count stops this stage**
      until investigated — never grandfathered, never rewritten. A non-zero
      suspended-manager count is *not* a blocker; it is the population D207
      deliberately leaves alone, and it belongs in the ledger so the trigger's
      behaviour is checked against real data.

---

### Task A1: Provisioning — canonical signature, atomic idempotency, audit writer

**Release: R1 (expansion).**
**Compatibility argument:** the four-argument call the deployed application makes
resolves through the new defaults, so the old application keeps working against
the expanded database. Verified in Task F0.

**Files:**
- Create: `supabase/migrations/20260814000100_organization_provisioning_idempotency.sql`

**Step 1 — Dependency preflight.** A `DO` block raising if any object depends on
`public.provision_organization(text, text, text, text)`: scan `pg_depend` joined
to `pg_proc`, and scan `pg_proc.prosrc` for other bodies naming it. Statically
there are none — only `20260805000200`'s `revoke`/`grant`, the adapter's
`client.rpc`, and comments — and the block is what makes that checked rather
than remembered.

**Step 2 — Capture the owner** via `pg_get_userbyid(proowner)`, so Step 6
reapplies it rather than assuming the migration role matches workflow 05's.

**Step 3 — Drop, explicitly and narrowly.**
```sql
drop function if exists public.provision_organization(text, text, text, text) restrict;
```
`CREATE OR REPLACE` cannot change an input signature; adding parameters leaves
the four-argument function alive as an overload with a divergent body (D195).

**Step 4 — Column and lock.**
```sql
alter table public.organizations add column provision_request_key uuid;

create unique index organizations_provision_request_key_unique
  on public.organizations (provision_request_key)
  where provision_request_key is not null;
```

**Step 5 — Create one canonical function**, signature exactly:
```sql
create function public.provision_organization(
  organization_name     text,
  organization_industry text default 'Restaurant group',
  organization_timezone text default 'UTC',
  organization_language text default 'en-US',
  p_request_key         uuid default null,
  p_source              text default 'self_serve'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
```

Body, in order:

1. `actor := auth.uid()`; raise `28000` when null. Unchanged.
2. Trim and validate the name; raise `22023` when empty. Unchanged.
3. **Validate `p_source`** against exactly `('self_serve', 'in_app')`; raise
   `22023` otherwise. It reaches `audit_events.metadata`.
4. Slug derivation and collision loop. Unchanged (D196).
5. **Atomic insert** — the insert *is* the idempotency decision:

   ```sql
   insert into public.organizations (
     name, slug, industry, website_url, default_timezone, default_language,
     provision_request_key
   ) values (…, p_request_key)
   on conflict (provision_request_key) where provision_request_key is not null
   do nothing
   returning id into new_organization_id;
   ```

6. **Replay / lost-race arm.** When `new_organization_id is null`, this
   invocation created nothing and must create nothing else. Resolve the winner
   with an **actor-scoped** lookup joining `memberships` on
   `user_id = actor and role = 'owner'`; return that id. Nothing found → raise
   `42501`, never another actor's id, and nothing about which organization it
   is. Comment the subtlety that makes this correct: `ON CONFLICT DO NOTHING`
   waits on the conflicting tuple's transaction before reporting zero rows, so
   by the time the lookup runs the winner has committed its membership row or
   rolled everything back.
7. Owner membership insert. Unchanged. **Winner only.**
8. `organization_onboarding` insert. Unchanged. **Winner only.**
9. **`audit_events` insert. Winner only.** Every required column:
   `organization_id = new_organization_id` (`not null`, and the column RLS
   resolves through — omitting it both fails the constraint and hides the row
   from its own tenant), `actor_type = 'user'`, `actor_user_id = actor`,
   `event_type = 'organization.created'`, `entity_type = 'organization'`,
   `entity_id = new_organization_id`, `previous_state = null`,
   `new_state = jsonb_build_object('name', trimmed_name, 'slug', candidate_slug)`,
   `metadata = jsonb_build_object('source', p_source)`. `occurred_at` defaults.
10. Return `new_organization_id`.

**Step 6 — Reapply owner, comment, and privileges (D210).**
```sql
alter function public.provision_organization(text,text,text,text,uuid,text)
  owner to <captured owner>;

revoke all on function public.provision_organization(text,text,text,text,uuid,text)
  from public, anon, service_role;
grant execute on function public.provision_organization(text,text,text,text,uuid,text)
  to authenticated;
```
A new function gets `EXECUTE` from `PUBLIC` **and** from Supabase's
project-level default privileges to `anon`, `authenticated`, and `service_role`.
Revoking `public` and `anon` alone leaves `service_role` — which is what made
the first draft's SQL disagree with its own prose. Closing this also closes G22
for the pre-existing function. Comment the function stating that repeated use
is supported, that the caller may already hold memberships, and what the request
key guarantees.

**Rollback SQL** (write it into the migration's header comment, not executed):
drop the six-argument function, restore the four-argument body verbatim from
`20260808000100`, re-apply `20260805000200`'s revoke/grant. The
`provision_request_key` column and its index are additive and may stay.

**Verify:** `npm run db:validate`

---

### Task A2: Location tenant integrity

**Release: R1 (expansion).**
**Compatibility argument:** the new FKs reject only cross-tenant writes, which
A0's preflights prove do not occur. The manager trigger fires only on assignment,
and every deployed write path (`updateLocationManagerAction`, onboarding create,
mapping create) already validates active membership or writes `null`. Nothing in
the deployed application inserts a location with a suspended manager.

**Files:**
- Create: `supabase/migrations/20260814000200_location_tenant_integrity.sql`

**Step 1 — Server-version assertion.** A `DO` block raising unless
`current_setting('server_version_num')::int >= 150000` (D206).

**Step 2 — Four preflight `DO` blocks**, one per constraint, each counting
violations and raising with the count, in `20260811000100`'s wording.

**Step 3 — Unique target for the profile reference.**
```sql
alter table public.platform_profiles
  add constraint platform_profiles_id_org unique (id, organization_id);
```
`locations_id_org` already exists from `20260811000100`, and
`memberships_unique_user_per_org unique (organization_id, user_id)` from the
initial schema. **Do not add a reversed membership unique** — the manager FK
uses the existing order (D201).

**Step 4 — Four composite FKs with column-specific referential actions.**
```sql
alter table public.locations
  add constraint locations_manager_same_org
    foreign key (organization_id, manager_user_id)
    references public.memberships (organization_id, user_id)
    on delete set null (manager_user_id);

alter table public.platform_profiles
  add constraint platform_profiles_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
    on delete set null (location_id);

alter table public.monitoring_queries
  add constraint monitoring_queries_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id)
    on delete set null (location_id);

alter table public.mentions
  add constraint mentions_platform_profile_same_org
    foreign key (platform_profile_id, organization_id)
    references public.platform_profiles (id, organization_id)
    on delete set null (platform_profile_id);
```
A bare `on delete set null` would null `organization_id` too, which is `not
null` on all four, so every membership or location deletion would raise `23502`
(D206). The `mentions` action matches the simple FK it replaces.

**Step 5 — Drop the four superseded simple FKs**, resolving each name from
`pg_constraint` in a `DO` block rather than hard-coding an auto-generated name.
**Do not touch `mentions_location_same_org` or the simple FK behind it** — that
pair is correct today and is deliberately out of scope (spec §6).

**Step 6 — The active-manager trigger (D207).**
```sql
create or replace function public.assert_location_manager_is_active_member()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if new.manager_user_id is null then return new; end if;
  if tg_op = 'UPDATE'
     and new.manager_user_id is not distinct from old.manager_user_id
     and new.organization_id is not distinct from old.organization_id then
    return new;
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.organization_id = new.organization_id
      and m.user_id = new.manager_user_id
      and m.status = 'active'
  ) then
    raise exception
      'A location manager must hold an active membership in the same organization'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger locations_manager_is_active_member
  before insert or update of manager_user_id, organization_id
  on public.locations for each row
  execute function public.assert_location_manager_is_active_member();

revoke all on function public.assert_location_manager_is_active_member()
  from public, anon, authenticated, service_role;
```
- [ ] Comment the two early returns as the load-bearing part: the first lets the
      FK's `SET NULL` through on membership deletion; the second is what makes
      suspension keep an existing assignment (D201) while every *new* assignment
      is validated. `update of <columns>` fires when a column is in the `SET`
      list even if unchanged, which is why the `is not distinct from` guard is
      in the body rather than trusted to the trigger clause.
- [ ] **Order matters:** `CREATE TRIGGER` before the `REVOKE`. PostgreSQL checks
      `EXECUTE` on a trigger function at creation time, not at fire time — but
      that is not asserted from documentation here: **T-9a exercises the trigger
      as an `authenticated` user under `set role` after the revoke has run**, so
      a wrong assumption fails the harness rather than shipping.

**Step 7 — Column comments** on all four columns: the invariant is now
structural, and `set null` fires on membership or location deletion, never on
suspension.

**Rollback SQL** (header comment): drop the four composite FKs and the trigger,
restore the four simple FKs with their original `on delete` actions, drop
`platform_profiles_id_org`.

**Verify:** `npm run db:validate`

---

### Task A3: `create_and_map_location`

**Release: R1 (expansion).**
**Compatibility argument:** purely additive. Nothing calls it until R2, and no
policy changes here — the deployed application's direct `locations` insert path
keeps working because `locations_insert` is untouched until R3.

**Files:**
- Create: `supabase/migrations/20260814000300_location_mapping_rpc.sql`

The first draft's `create_location_for_mapping` took only a connection id and
location fields, so a communications lead could call it repeatedly and mint
arbitrary orphaned `setup` locations. Restricting status and manager narrows
what the row looks like; it does not make creation a side effect of mapping.
**This function creates and binds, or it does nothing.**

```sql
create function public.create_and_map_location(
  p_connection_id uuid,
  p_profiles      jsonb,
  p_name          text,
  p_address_line1 text, p_address_line2 text,
  p_city          text, p_region        text,
  p_postal_code   text, p_country_code  text,
  p_timezone      text
) returns table (location_id uuid, profile_id uuid, profile_created boolean, replayed boolean)
language plpgsql security definer set search_path = public, pg_temp
```

`p_profiles` is a JSON array of
`{ externalProfileId, externalProfileName, profileUrl, externalAccountId,
verificationState, providerMetadata }` — the same fields
`platformProfiles.upsert` already carries
([google-mapping.ts:296](src/lib/integrations/google-mapping.ts#L296)). Profiles
are **not** persisted before mapping (spec §1.1); they are fetched live from
Google and written at save time, so this function must be able to create the
row, not merely reference one.

Body, in order:

1. **Require at least one profile.** `jsonb_typeof(p_profiles) <> 'array'` or
   zero elements → raise `22023`. There is no shape of call that creates a
   location and binds nothing.
2. **Resolve the connection → organization.** No row → raise `42501` with the
   same message an unauthorized caller gets, so the function is not a probe for
   which connection ids exist. **No organization id is a parameter.**
3. **Authorize against the derived organization:**
   `has_organization_role(org, array['owner','admin','communications_lead'])`,
   matching `integration.manage_profiles`. Otherwise the same `42501`.
4. Reject a `disconnected` connection with a distinct, non-probing error, as
   `saveGoogleLocationMappings` does today.
5. **Upsert the profiles**, set-based from `jsonb_to_recordset(p_profiles)`, on
   `platform_profiles_unique_external (platform_connection_id, external_profile_id)`
   with `on conflict … do update set external_profile_name = excluded.…, … returning id`.
   New rows are written with `organization_id` = the resolved org and
   `location_id = null`.
6. **Lock the affected rows explicitly:**
   ```sql
   select id, location_id, organization_id, platform_connection_id
   from public.platform_profiles
   where platform_connection_id = p_connection_id
     and external_profile_id = any(external_ids)
   order by id
   for update;
   ```
   The lock is what makes two concurrent submissions for the same listing
   converge instead of minting two locations. `order by id` is what keeps two
   concurrent multi-profile calls from deadlocking against each other. Comment
   both.
7. **Verify the locked set**: its cardinality equals the input's, and every row
   carries the resolved `organization_id` and `platform_connection_id`. Any
   mismatch → `42501`. Mixed-organization sets are structurally impossible (one
   connection, one organization; the natural key is per-connection), so this is
   defence in depth against corrupt data and a future caller shape — comment it
   as such, and note that T-25 and T-27 assert both the structural property and
   this check.
8. **Replay decision** over the locked set's `distinct location_id`:
   - all null → proceed to create;
   - exactly one non-null value → **replay**: return it with `replayed = true`,
     `profile_created = false`, and write **nothing** — no second location, no
     second audit event;
   - two or more distinct values, or a mix of null and non-null → raise `23505`
     with a fixed message. A profile set half-bound to one location and half to
     another is a state no retry should silently resolve.
9. **Create the location.** `status` written `'setup'` and `manager_user_id`
   written `null` **literally** — neither is a parameter. Slug derived from
   `p_name` and de-duplicated within the organization; not a parameter.
10. **Bind:** `update public.platform_profiles set location_id = <new>,
    status = 'active', last_confirmed_at = now() where id = any(<locked ids>)`.
11. **Audit, all inside this transaction** (D200):
    - one `location.created_from_integration` for the location, metadata
      carrying `platform` and the external profile ids;
    - one `integration.profile_connected` per profile row this call **newly
      created** (tracked from step 5's insert-vs-update outcome);
    - one `integration.profile_mapped` per bound profile, with
      `previous_state: { locationId: null }`.
    These are exactly the three events `google-mapping.ts` writes for this
    branch today. Moving them inside is what makes "the application performs no
    second, non-atomic binding step" literally true.
12. Return one row per profile with the location id, the profile id,
    `profile_created`, and `replayed = false`.

**An unbound location can never commit**: steps 9–11 are one function body, which
is one transaction, so any failure discards all of it.

**Grants (D210):**
```sql
revoke all on function public.create_and_map_location(uuid,jsonb,text,text,text,text,text,text,text,text)
  from public, anon, service_role;
grant execute on function public.create_and_map_location(uuid,jsonb,text,text,text,text,text,text,text,text)
  to authenticated;
```

**Rollback SQL** (header comment): `drop function … restrict`. Nothing depends on
it until R2, and after R2 a rollback of this migration must be paired with an
application rollback.

**Verify:** `npm run db:validate`

---

### Task A4: Location audit vocabulary

**Release: R1 (expansion).** Additive — nothing emits the new literals until R2.

**Files:**
- Create: `supabase/migrations/20260814000400_location_audit_vocabulary.sql`

- [ ] Redefine `audit_events_known_event_type`, copying the full list from
      `20260812000700_response_generation_audit_vocabulary.sql` and adding
      `location.updated` and `location.status_changed` (D204).
- [ ] Confirm no later-sorting migration redefines the constraint, and that this
      remains true after the GBP merge (A00).
- [ ] Update the constraint comment.

> **Pairs with Task B1**, one commit. `tests/audit-vocabulary-migrations.test.ts`
> parses the real SQL and fails in both directions.

**Verify:** `npm run db:validate && npx vitest run tests/audit-vocabulary-migrations.test.ts`

---

### Task A5: Location write roles — contraction

**Release: R3 (contraction). Ships in a later release than everything above.**

**Files:**
- Create: `supabase/migrations/20260814000500_location_write_roles_contraction.sql`

> **This migration is the one-way door.** After it runs, the previous
> application's direct location-insert path is blocked, so an application
> rollback past R2 stops communications-lead mapping. It therefore runs **only
> after the R2 rollback window has closed** (Stage F rollout). Nothing in this
> file is required for R2 to function — R2 works because the RPC exists, not
> because the policies narrowed.

Follows `20260807000500_news_monitoring_write_roles_rls.sql` in shape.

- [ ] Drop `locations_insert`, `locations_update`, `locations_delete`.
- [ ] Recreate insert: `has_organization_role(organization_id, array['owner','admin']::membership_role[])`.
- [ ] Recreate update: same roles, `using` **and** `with check`.
- [ ] Do **not** recreate delete, **and** revoke the privilege at table level:
      ```sql
      revoke delete on public.locations from authenticated;
      ```
      Dropping a policy without revoking leaves the grant for whatever policy is
      added next; the revoke is what makes "no hard deletes" structural.
- [ ] Policy comments must name `create_and_map_location` as the mapping path,
      or the next reader "fixes" the comms-lead refusal by widening the policy
      again.

**Rollback SQL** (header comment): restore the three original policies verbatim
from `20260801000200` and `grant delete on public.locations to authenticated`.

**Verify:** `npm run db:validate`

---

### Task A6: SQL verification harness

**Files:**
- Create: `supabase/tests/tenancy-verification.sql`
- Create: `scripts/provisioning-race-test.sh`
- Create: `scripts/mapping-race-test.sh`
- Edit: `package.json`, `.github/workflows/verify.yml`

`tenancy-verification.sql` follows `supabase/tests/rls-verification.sql`:
`begin;`, fixtures resolved by slug in a temporary table, `set role`
impersonation, one `raise exception` per failure, `rollback;`.

**Because A5 ships in R3, the harness runs in two modes.** Sections marked
**[post-contraction]** assert the narrowed policies; they are guarded by a
`DO` block that checks whether `20260814000500` has been applied and skips with
a notice otherwise, so the same file is valid against both an R1 and an R3
database. The guard's own correctness is asserted (it must *run* the checks once
the migration is present, not skip silently — T-29).

**Location write authority [post-contraction]**
- [ ] **T-1** Location manager `INSERT` into `locations` → `42501`.
- [ ] **T-2** Approver `INSERT` → `42501`.
- [ ] **T-3** Communications lead **direct** `INSERT` → `42501`.
- [ ] **T-4** Location manager `UPDATE` → **0 rows** (a `using`-gated UPDATE
      matches nothing silently rather than raising — the trap section 8 of
      `rls-verification.sql` documents).
- [ ] **T-5** Communications lead `UPDATE` → 0 rows.
- [ ] **T-6** Admin `UPDATE` in their own organization succeeds — the control.
- [ ] **T-18** `DELETE` on `locations` refused at the **privilege** level:
      `has_table_privilege('authenticated', 'public.locations', 'delete')` is
      false, as well as the attempted call failing. A future policy cannot
      silently re-enable it.
- [ ] **T-26 [pre-contraction]** Before `20260814000500`, a communications lead's
      direct `INSERT` still **succeeds** — the expansion-phase compatibility
      assertion that proves the deployed application keeps working after R1.

**Manager invariants**
- [ ] **T-7** `manager_user_id` = a user with no membership → `23503`.
- [ ] **T-8** `manager_user_id` = a member of a different organization → `23503`.
- [ ] **T-9a** `manager_user_id` = a **suspended** same-organization member →
      `23514` from the trigger, **executed as an `authenticated` user under
      `set role` after the trigger function's privileges were revoked** — this
      is the check that proves the D210 revoke does not disable the trigger.
- [ ] **T-9** An existing assignment survives suspension: assign while active,
      suspend, re-read, assert unchanged. Then update an unrelated column on the
      same location and assert the trigger still does not fire.
- [ ] **T-10** Deleting the manager's membership nulls `manager_user_id`, leaves
      `organization_id` and every other column unchanged, and does not raise
      `23502`.

**Cross-tenant references**
- [ ] **T-11** `platform_profiles` with another organization's `location_id` →
      `23503`.
- [ ] **T-12** Same for `monitoring_queries`.
- [ ] **T-22** Same for `mentions.platform_profile_id` (D208).
- [ ] **T-20** Deleting a location nulls `location_id` on its
      `platform_profiles` and `monitoring_queries` rows and
      `platform_profile_id` on affected `mentions`, without `23502` and without
      touching any `organization_id`.

**Slugs and lifecycle**
- [ ] **T-13** Two locations in different organizations may share a slug; two in
      one may not (`23505`).
- [ ] **T-17** Marking a location `inactive` leaves its mentions,
      `platform_profiles` mappings, `response_drafts`, and `audit_events`
      row-for-row identical.

**Provisioning**
- [ ] **T-14** Sequential replay: two calls with the same `p_request_key` return
      the same id and leave exactly one organization, one owner membership, one
      onboarding row, and **one** `organization.created` audit row.
- [ ] **T-15** The audit row carries a non-null `organization_id` equal to the
      new organization, `actor_user_id = auth.uid()`,
      `entity_type = 'organization'`, and metadata containing only a valid
      `source`.
- [ ] **T-16** A user with two owner memberships sees both from
      `is_organization_member`, and neither organization's rows are visible from
      the other's scope.
- [ ] **T-24b** `p_source` outside `('self_serve','in_app')` → `22023`, nothing
      written.
- [ ] **T-28** The **four-argument** call still resolves through defaults and
      creates an organization — the R1 compatibility gate expressed as SQL.

**Mapping RPC**
- [ ] **T-19** A communications lead calling `create_and_map_location` with their
      own organization's connection succeeds; the created location has
      `status = 'setup'` and `manager_user_id is null`; **and the profile row is
      bound to it**. Criterion 16's database half.
- [ ] **T-23** The call writes exactly three audit rows — one
      `location.created_from_integration`, one `integration.profile_connected`,
      one `integration.profile_mapped` — all carrying `organization_id`, and all
      committed with the location and the binding.
- [ ] **T-24** **No orphan survives a failure.** Inject a failure after the
      location insert (an invalid `p_timezone`, or a deliberate raise inside a
      test-only wrapper) and assert zero new `locations` rows, zero new
      `audit_events` rows, and the profile's `location_id` unchanged.
- [ ] **T-25** An analyst → `42501`. A member of organization A passing
      organization B's connection id → `42501`, **indistinguishable** from the
      response to an invented uuid (compare `SQLSTATE` and message text).
- [ ] **T-27** **Cross-organization profile isolation.** Given the same external
      profile id existing under organization B's connection, calling as
      organization A creates or resolves *A's own* row and leaves B's row
      byte-identical (`to_jsonb(row)` compared either side). Then assert the
      explicit verification check by corrupting a row's `organization_id`
      directly as the owner and confirming the next call raises `42501`.
- [ ] **T-19b** Empty `p_profiles` → `22023`, and no location is created.
- [ ] **T-19c** Replay: calling twice with the same profile set returns the same
      `location_id` with `replayed = true`, and leaves exactly one location and
      three audit rows in total.
- [ ] **T-19d** A profile set already bound to two different locations →
      `23505`, nothing written.

**Privileges**
- [ ] **T-21** Read from the catalog, not by attempting a denied call — the local
      Postgres image segfaults on an EXECUTE-denied call of a non-immutable
      function after `set role` (D165), which would take the harness's own
      database down. For **both** `provision_organization` and
      `create_and_map_location`: `has_function_privilege` is **false** for
      `anon`, **false** for `service_role`, and **true** for `authenticated`.
      For `assert_location_manager_is_active_member`: false for all four.
- [ ] **T-29** The post-contraction guard itself works: when
      `20260814000500` is present, the guarded section runs (assert a sentinel
      counter incremented) rather than skipping silently.

**Concurrency scripts**
- [ ] `scripts/provisioning-race-test.sh`, modelled on
      `scripts/generation-race-test.sh`: two psql sessions over FIFOs,
      interleaved statement by statement. **T-14 alone does not prove D195** — a
      read-then-insert implementation passes it.
      - Both call `provision_organization` with the same `p_request_key`, A's
        insert issued and uncommitted before B's.
      - Assert B is genuinely parked via `pg_stat_activity` (race 1 of
        `generation-race-test.sh`'s technique), not assumed.
      - After both commit: **same organization id returned**; exactly one
        `organizations` row with the key; one owner membership; one onboarding
        row; **one** `organization.created` audit row.
      - A third session as a **different** actor with the same key → `42501`,
        message containing no uuid.
- [ ] `scripts/mapping-race-test.sh`, the same technique for D200:
      - Two sessions call `create_and_map_location` for the **same** external
        profile id under the same connection, interleaved so A's upsert commits
        while B is parked on the row lock.
      - Assert B is parked via `pg_stat_activity`.
      - After both commit: **exactly one** `locations` row created, **one**
        `location.created_from_integration`, one `integration.profile_connected`,
        one `integration.profile_mapped`; both sessions return the same
        `location_id`; B reports `replayed = true`.

**Scripts and CI**
- [ ] Add to `package.json`:
      ```
      "db:verify-tenancy": "supabase db reset && psql \"$SUPABASE_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/tests/rls-verification.sql -f supabase/tests/tenancy-verification.sql && bash scripts/provisioning-race-test.sh && bash scripts/mapping-race-test.sh"
      ```
- [ ] Add it to the `database` CI job as its own run, alongside
      `db:verify-execution` and `db:verify-generation`.

**Dependencies:** A1–A5.

---

### Stage A gate

At the pinned CLI (`2.101.0`), against a freshly reset local stack:

```bash
export SUPABASE_DB_URL="$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')"
npm run db:validate
npm run db:verify-tenancy      # includes both race scripts
npm run db:verify-rls
npm run db:verify-execution
npm run db:verify-generation
```

- [ ] `db:verify-tenancy` green, explicitly including: **T-21** (privilege
      assertions for all three functions, `service_role` included), **T-14 plus
      `provisioning-race-test.sh`** (concurrent idempotency), **T-22 / T-20**
      (mentions FK and its delete action), **T-19 / T-19b / T-19c / T-19d /
      T-23 / T-24 / T-25 / T-27 plus `mapping-race-test.sh`** (create-and-bind
      authorization, atomicity, replay, isolation, concurrency), **T-9a / T-9 /
      T-10** (active-assignment trigger and its lifecycle, run after the
      revoke), **T-18** (table-level delete denial), and **T-26 / T-28 / T-29**
      (expansion-phase compatibility and the guard's own correctness).
- [ ] The last three harnesses green — regression proof that A2's four
      constraints and its trigger did not break tables those harnesses write to.
      Not a formality: both insert `mentions` rows.

---

## Stage B — Domain, permissions, repositories

### Task B1: Audit vocabulary in TypeScript

**Files:**
- Edit: `src/domain/enums.ts` — `"location.updated"`, `"location.status_changed"`
  in `AUDIT_EVENT_TYPES`, beside the existing `location.*` entries, commented
  with D204's field split.
- Edit: `src/lib/labels.ts` — `AUDIT_EVENT_LABELS` entries.

**Pairs with Task A4 — one commit.** Both files also carry in-flight GBP work;
see A00 for the reconciliation rule.

**Verify:** `npx vitest run tests/audit-vocabulary-migrations.test.ts`

---

### Task B2: Location domain schemas

**Files:**
- Edit: `src/domain/entities/location.ts`

- [ ] `createManualLocationInputSchema` — name, optional slug, address block,
      timezone, `managerUserId` (nullable, default null). **No `status`**: a
      manually created location always starts `setup` (D202).
- [ ] `updateLocationInputSchema` — `locationId` plus name, slug, address block,
      timezone, status, `managerUserId`. **Do not use `.partial()`**: Zod leaves
      `.default()` in place, so an absent key parses to the default and both
      adapters write it — the defect that shipped in
      `updateMonitoringQueryInputSchema`. Declare the fields explicitly.
- [ ] `createAndMapLocationInputSchema` — the RPC's parameter shape:
      `platformConnectionId`, a **non-empty** array of profile descriptors, and
      the location fields. The non-empty constraint mirrors the SQL's `22023`.
- [ ] Export input and parsed-output types; doc-comment why `status` is absent
      from create and present on update, and point at D204.

**Verify:** `npx vitest run tests/repositories.test.ts && npm run typecheck`

---

### Task B3: `location.create` and `location.update` permissions

**Files:**
- Edit: `src/lib/auth/permissions.ts`

- [ ] Add both to `PERMISSIONS` and `PERMISSION_MATRIX`, each `["owner", "admin"]`.
- [ ] Comment in the file's voice: why not `location.update_manager`, why not
      `onboarding.manage`, and that after R3 these **match** the RLS policies
      exactly (D199/D200), so the application and the database state the same
      authority. Note that mapping is a separate authority
      (`integration.manage_profiles`) reaching a separate function that cannot
      create an unbound location — not a wider policy on this table.

**Files:**
- Edit: `tests/permissions.test.ts` — owner and admin hold both; communications
  lead, approver, location manager, analyst, viewer hold neither;
  `permissionsFor("analyst")` and `permissionsFor("viewer")` stay empty.

**Verify:** `npx vitest run tests/permissions.test.ts`

---

### Task B4: `LocationRepository.update` in both adapters

**Files:**
- Edit: `src/lib/data/types.ts`, `src/lib/data/demo/index.ts`,
  `src/lib/data/supabase/index.ts`

- [ ] `update(scope, input: UpdateLocationInput): Promise<Location>`, documented
      alongside why `updateManager` stays separate.
- [ ] Both adapters: parse; scoped lookup first with `notFound("Location")`;
      non-null `managerUserId` → verify **active** same-organization membership
      (the D207 trigger is the backstop, this is the friendly error); slug change
      → per-organization uniqueness with a `conflict()` carrying a `slug` field
      error; fresh `updatedAt`.
- [ ] Supabase: `.eq("organization_id", scope.organizationId)`,
      `.select("*").maybeSingle()`, `notFound` on no row.

**Verify:** `npx vitest run tests/repositories.test.ts && npm run typecheck`

---

### Task B5: Repository tests

**Files:**
- Create: `tests/location-repositories.test.ts`

- [ ] **Criterion 10** — three locations in USHG, all returned, all stamped.
- [ ] **Criterion 11** — `"soho"` accepted in USHG and Harbor; a second in USHG
      raises `conflict`.
- [ ] Slug derivation: two "Gramercy Tavern" in one organization get distinct
      slugs and the second does not throw (no slug supplied).
- [ ] **Criterion 13** — `create` and `update` refuse a foreign-organization
      manager, refuse a suspended member, accept an active one.
- [ ] **Criterion 12** — `update` with Harbor's id under a USHG scope raises
      `not_found`, message naming no organization.
- [ ] **Criterion 14** — after suspension the location still reports that
      manager; a *new* assignment to that suspended person is refused.
- [ ] **Criterion 18** — `status: "inactive"` leaves mentions,
      `platformProfiles`, and `responseDrafts` counts unchanged; the row still
      appears in `list`.
- [ ] Field round-trips; an omitted field is left alone (the `.partial()` trap,
      pinned both ways).

**Verify:** `npx vitest run tests/location-repositories.test.ts`

---

### Task B6: `organizations.provision` accepts a request key and a source

**Files:**
- Edit: `src/domain/entities/organization.ts` — optional `requestKey` (uuid) and
  `source` as the **union** `"self_serve" | "in_app"`, mirroring the SQL check.
- Edit: `src/lib/data/types.ts` — document the idempotency contract, and correct
  the misleading precondition (G6): the caller may already hold memberships;
  what makes the method unscoped is that it *produces* a scope.
- Edit: `src/lib/data/supabase/index.ts` — pass `p_request_key`, `p_source`.
- Edit: `src/lib/data/demo/index.ts` — mirror the whole contract:
  - store `provisionRequestKey` on the demo organization row;
  - a key already carried by an organization **owned by this user** → return it,
    create nothing (no membership, no onboarding row, no audit row);
  - a key carried by an organization owned by **somebody else** → throw the demo
    equivalent of `42501` (`forbidden`) without naming the id;
  - **emit `organization.created` exactly once, only when it wins**, with the
    same columns the RPC writes (D192).
- Edit: `src/lib/seed/dataset.ts` / `src/lib/seed/columns.ts` — add
  `provision_request_key` to `SEED_TABLE_COLUMNS` for `organizations` (null for
  both tenants), or `tests/seed-generator-columns.test.ts` fails.
- Regenerate: `npm run db:seed:generate`.

**Verify:**
```bash
npx vitest run tests/seed-generator-columns.test.ts tests/seed-dataset.test.ts tests/repositories.test.ts
npm run typecheck
```

---

### Task B7: `LocationRepository.createAndMapFromIntegration`

**Files:**
- Edit: `src/lib/data/types.ts` — add
  `createAndMapFromIntegration(scope, input): Promise<{ location: Location; profiles: PlatformProfile[]; replayed: boolean; createdProfileIds: string[] }>`.
  Document that it is the **only** path by which a communications lead can bring
  a location into existence, that it binds the profiles in the same transaction,
  that it writes its own three audit events, and that it cannot set status,
  manager, or slug.
- Edit: `src/lib/data/supabase/index.ts` — call
  `client.rpc("create_and_map_location", …)`, then re-read the location and the
  profiles through scoped reads to return full domain objects.
- Edit: `src/lib/data/demo/index.ts` — **full twin**, not an approximation:
  - resolve the connection under the scope; `notFound`-equivalent for a foreign
    or unknown id, indistinguishable from unauthorized;
  - check `scope.role` ∈ {owner, admin, communications_lead}, else `forbidden`;
  - require a non-empty profile set, else `invalid_input`;
  - upsert the profiles on `(platformConnectionId, externalProfileId)`, tracking
    which were newly created;
  - replay/conflict decision over their `locationId` values, matching the SQL's
    three arms exactly;
  - create the location with `status: "setup"`, `managerUserId: null`, derived
    slug; bind the profiles; push all three audit rows.
  The demo adapter already writes audit rows from inside repository methods
  ([demo/index.ts:581](src/lib/data/demo/index.ts#L581)), so this is the
  established pattern.

**Files:**
- Edit: `tests/repositories.test.ts` or a new
  `tests/location-mapping-repository.test.ts` — replay returns the same location
  and writes no second audit row; an empty profile set is refused; a
  wrong-organization connection is refused indistinguishably; a bound-to-two
  set conflicts.

**Verify:** `npm run typecheck && npx vitest run tests/repositories.test.ts`

---

### Task B8: Switch Google mapping onto the RPC

**Files:**
- Edit: `src/lib/integrations/google-mapping.ts`

- [ ] In the **create** branch only, replace the
      `locations.create(...)` → `recordAuditEvent(location.created_from_integration)`
      → `platformProfiles.upsert(...)` → `recordAuditEvent(integration.profile_connected)`
      → `recordAuditEvent(integration.profile_mapped)` sequence with a single
      `createAndMapFromIntegration` call.
- [ ] **Remove all three `recordAuditEvent` calls on that path.** The repository
      writes them now. Leave a comment saying where they went, or the next reader
      restores them and doubles every event.
- [ ] **No second binding step.** The create branch must not call
      `platformProfiles.upsert` afterwards. Build `result.createdLocations` and
      `result.mappedProfiles` from the RPC's return value.
- [ ] The `map_existing` branch is **untouched** — it creates no location, needs
      no RPC, and keeps writing its own `integration.profile_connected` /
      `integration.profile_mapped` events.
- [ ] `claimedLocationIds` bookkeeping still runs for both branches.
- [ ] Update the file's header comment: D17's "no transaction around the batch"
      still holds — the batch is still a loop of independent, per-row-reported
      decisions — but one decision's create-and-bind is now atomic, which is what
      D17's own "each decision is independent and idempotent" always wanted.

**Files:**
- Edit: `docs/integrations/google-business-profile.md` — the D17 trade-off
  section. **This file is dirty in the original tree (A00);** make the edit in
  the worktree and reconcile at merge.
- Edit: `tests/google-integration.test.ts` — update assertions about which layer
  emits the three events. **Criterion 16** is that this suite stays green in
  substance; a failure is a real regression, not a test to loosen.

**Verify:**
```bash
npx vitest run tests/google-integration.test.ts tests/location-matching.test.ts tests/integration-permissions.test.ts
```

---

**Stage B gate:** `npm run verify`

---

## Stage C — Organization workflow

### Task C1: The active-organization cookie helper

**Files:**
- Edit: `src/lib/tenancy/organization-context.ts`

- [ ] `setActiveOrganizationCookie(organizationId)` writing `httpOnly: true`,
      `sameSite: "lax"`, `secure: NODE_ENV === "production"`, `path: "/"`,
      `maxAge: 60 * 60 * 24 * 365` — lifted verbatim from
      `switchOrganizationAction`.
- [ ] Doc comment: a *selection*, never an authorization; the caller verifies
      membership first, and `getOrganizationContext` re-verifies regardless.
- [ ] Do **not** add a `clear` helper — nothing needs one. Recorded so the
      omission reads as deliberate.
- [ ] `switchOrganizationAction` calls the helper instead of inlining
      `cookies().set`.

**Verify:** `npm run typecheck && npx vitest run tests/selection.test.ts`

---

### Task C2: `createOrganizationAction`

**Files:**
- Edit: `src/app/actions/organization.ts`

- [ ] Schema: `{ name: trimmed 1–160, requestKey: z.uuid() }`, wording matching
      the sign-up form.
- [ ] `requireSession()` — **not** `authorize()`. Comment it: same reason
      `acceptInvitationAction` is unwrapped.
- [ ] `organizations.provision({ userId, name, requestKey, source: "in_app" })`.
- [ ] `setActiveOrganizationCookie(...)`; `revalidatePath("/", "layout")`.
- [ ] Return `{ nextPath: "/onboarding/organization", organizationId }`. **No
      `redirect()`.** Wrapped in `runAction("organization.create", …)`.
- [ ] **No `recordAuditEvent` call**, with a comment: the event is written inside
      `provision_organization` and its demo twin (D192).

**Verify:** `npm run typecheck`

---

### Task C3: The `/organizations/new` route

**Files:**
- Create: `src/app/organizations/layout.tsx` (mirrors
  `src/app/onboarding/layout.tsx`: Geist, `robots: noindex`, no guard)
- Create: `src/app/organizations/new/page.tsx`
- Create: `src/components/organizations/create-organization-form.tsx` (`"use client"`)
- Edit: `src/proxy.ts` — `"/organizations"` in `PRODUCT_PATHS` beside
  `/onboarding`, commented with D191 and correction C1.

- [ ] Page: `requireSession()` only; `listForUser` decides the copy (zero
      memberships → "Create your organization", no escape hatch; otherwise
      "Create another organization" plus a "Back to Lia" link);
      `OnboardingShell`; `export const dynamic = "force-dynamic"`.
- [ ] Form: `useRef` holding `crypto.randomUUID()` generated once per mount, sent
      as `requestKey` (D195) — a retry reuses it, a fresh load gets a new one;
      `useTransition` disabling submit as a courtesy; `router.push(nextPath)` on
      success; `result.error` / `fieldErrors.name` inline with `role="alert"`;
      labelled input, `aria-invalid`, `aria-describedby`.

**Files:**
- Edit: `tests/proxy.test.ts` — `isProductPath("/organizations/new")` true;
  `isProductPath("/organizations-of-interest")` false.

**Verify:** `npx vitest run tests/proxy.test.ts && npm run build`

---

### Task C4: "Create organization" in `OrgSwitcher`, and `/overview` on switch

**Files:**
- Edit: `src/components/shell/org-switcher.tsx`

- [ ] Bordered footer row: a `<Link>` to `/organizations/new` with a `Plus` icon,
      labelled "Create organization". **Always rendered**, regardless of role —
      creating an organization is a property of the account, not the current
      tenant (D191). Comment it so nobody adds a permission check later.
- [ ] Close the popover on navigate.
- [ ] `select()` calls `router.push("/overview")` after a successful switch
      (D194), commented with the failure it fixes (C3/G5).
- [ ] The new row sits inside the container but **outside** `role="listbox"`, so
      it is not announced as a selectable organization.
- [ ] Confirm the compact rail variant renders it legibly at its width.

**Verify:** `npm run build`. Behavioural proof is Task F2's browser flow.

---

### Task C5: Zero-membership post-auth destination

**Files:**
- Edit: `src/lib/onboarding/post-auth.ts`

- [ ] Return `"/organizations/new"` when `memberships.length === 0`.
- [ ] Rewrite the doc comment: the claim that the shell "reports 'your account is
      not a member of any organization yet'" is false — it is a `DataError`
      swallowed by the route error boundary (G2, D197).

**Verify:** `npx vitest run tests/auth-redirect.test.ts tests/onboarding-routing.test.ts`

---

### Task C6: Invitation acceptance selects the joined organization

**Files:**
- Edit: `src/app/actions/invitations.ts` — `acceptInvitationAction` calls the
  cookie helper before returning, plus `revalidatePath("/", "layout")`.
- Edit: `src/app/actions/auth.ts` — `acceptInvitationWithSignUpAction` calls it
  with the id returned by `invitations.accept` before its `redirect`.
- [ ] Comment both with G4: masked today because an invitee has one membership;
      breaks the moment a user belongs to two.
- [ ] Confirm `invitations.accept` returns the organization id in **both**
      adapters.

**Verify:** `npx vitest run tests/membership.test.ts && npm run typecheck`

---

### Task C7: Correct the provisioning comments

**Files:**
- Edit: `src/lib/onboarding/post-auth.ts` — `provisionPendingOrganization`'s
  comment stays true *of that path*, plus a sentence noting an invitee may
  deliberately create one from `/organizations/new`. The guard is about not
  creating one *by accident during a confirmation flow*.
- [ ] Confirm `src/lib/data/types.ts` (B6) and the migration comment (A1) are
      already corrected.

**Verify:** `npm run lint`

---

### Task C8: Organization tests

**Files:**
- Create: `tests/organization-creation.test.ts`, `tests/organization-selection.test.ts`

Mock `requireSession`, `next/headers`' `cookies`, and `revalidatePath` over a
**real** demo `dataSource`, following `tests/monitoring-actions.test.ts`.

`organization-creation.test.ts`:
- [ ] **Criterion 1** — `USER_DANIEL` creates "Bond Hospitality";
      `listForUser` returns three entries with roles `owner`, `viewer`, `owner`.
- [ ] **Criterion 2** — both existing organizations and both onboarding rows
      byte-identical either side.
- [ ] **Criterion 3** — the new onboarding row is `in_progress` at step
      `organization`, every completion timestamp null.
- [ ] Returns `nextPath: "/onboarding/organization"`; the cookie helper was
      called with the new id.
- [ ] **D195** — same `requestKey` twice → same id, one new organization,
      **exactly one** `organization.created` row. Different keys → two.
- [ ] **D195 actor scoping** — a different user with someone else's key is
      refused, message containing no uuid.
- [ ] **D196** — two organizations named "Bond" get distinct global slugs.
- [ ] `source` outside the union is refused by the demo adapter.
- [ ] Blank name → `name` field error, nothing written.
- [ ] `USER_JORDAN` (analyst, holds no permission anywhere) can create one and
      becomes its owner.

`organization-selection.test.ts`:
- [ ] **Criterion 4** — `/organizations/new` for zero memberships; not for one.
- [ ] **Criterion 5** — after acceptance the cookie holds the joined
      organization's id, asserted for a user who **already belonged elsewhere**.
- [ ] **Criterion 6** — a cookie naming a non-member organization resolves to
      `available[0]` and the scope is never the forged one. Repeat with a
      valid-but-nonexistent uuid and a non-uuid string.
- [ ] **Criterion 7, static guard only** — read `org-switcher.tsx`'s source and
      assert it pushes `/overview` and links to `/organizations/new`. Label it a
      guard against silent removal; the **acceptance proof is Task F2's browser
      flow**. Source-reading is the established technique here
      (`tests/brand-voice-onboarding-alignment.test.ts`) because Vitest runs in
      node with no testing-library dependency (D74).

**Verify:** `npx vitest run tests/organization-creation.test.ts tests/organization-selection.test.ts`

---

**Stage C gate:** `npm run verify`

---

## Stage D — Location workflow

### Task D1: Reusable location fields

**Files:**
- Create: `src/components/locations/location-fields.tsx` (`"use client"`)

- [ ] Props: `defaultValues`, `members`, `disabled`, `fieldErrors`, `mode`.
- [ ] Fields: name, slug (edit only), address block, timezone, manager, status
      (edit only, per B2/D202).
- [ ] Manager select lists **only active members**, plus "Unassigned". A
      suspended current manager appears as a **disabled** selected option
      labelled "· access suspended" — disabled rather than merely annotated,
      because re-selecting them would be refused by the D207 trigger.
- [ ] Country and timezone reuse the primitives
      `createLocationInputSchema` and the onboarding form already use. No second
      list of either.
- [ ] **Not** shared with the onboarding step-3 markup — different shell,
      different brand, the split D178 made for the brand-voice preview. Shared:
      the schema and the repository method.

**Verify:** `npm run build`

---

### Task D2: Create and update actions

**Files:**
- Edit: `src/app/actions/locations.ts`

`createLocationAction`:
- [ ] Parse, then `authorize("location.create")`.
- [ ] `locations.create(scope, { ...parsed, status: "setup" })`; let the
      repository's manager `invalid_input` field error through.
- [ ] `recordAuditEvent` — `location.created`, `metadata: { source: "manual" }`
      (D203).
- [ ] **No `completeLocationsStep`, no `ensureLocationMonitoring`, no onboarding
      revalidation.** Comment it, naming `createOnboardingLocationAction` as the
      thing it deliberately is not (criterion 15).
- [ ] `revalidatePath("/locations")`; return
      `` { nextPath: `/locations/${id}`, locationId } ``.

`updateLocationAction`:
- [ ] Parse, then `authorize("location.update")`.
- [ ] `locations.get(scope, locationId)` first; `notFound("Location")` on null.
- [ ] `locations.update(...)`.
- [ ] **Field-partitioned audit (D204)** — three independent diffs, emitting only
      events whose fields changed:

      | Event | Fields |
      | --- | --- |
      | `location.updated` | `name`, `slug`, `addressLine1`, `addressLine2`, `city`, `region`, `postalCode`, `countryCode`, `timezone` |
      | `location.status_changed` | `status` |
      | `location.manager_changed` | `managerUserId` |

      A manager-only edit emits **exactly one** event and **not**
      `location.updated`. Declare the field list as one named constant beside the
      action so the partition is a single declaration, not three call sites that
      can drift.
- [ ] `revalidatePath("/locations")`, `` revalidatePath(`/locations/${id}`) ``,
      and `revalidatePath("/overview")` when status changed.
- [ ] Leave `updateLocationManagerAction` alone; comment the overlap.

**Verify:** `npm run typecheck`

---

### Task D3: `/locations/new`

**Files:**
- Create: `src/app/(app)/locations/new/page.tsx`, `loading.tsx`
- Create: `src/components/locations/create-location-form.tsx` (`"use client"`)

- [ ] `getOrganizationContext()`, then `can(role, "location.create")`.
- [ ] **A role without the permission gets the notice and nothing else** — no
      eleven-field disabled form. Render `PageHeader`, a `Notice` naming the
      roles that may create locations and the caller's own role, and a link back
      to `/locations`. **The form component is not mounted at all.** Disabling
      eleven inputs communicates the same refusal at ten times the visual cost,
      and a form nobody can submit reads as broken rather than forbidden.
- [ ] Load `memberships.listMembers(scope)` only on the permitted branch.
- [ ] Form: `LocationFields` in `mode="create"`, `useTransition`, inline
      `fieldErrors`, `router.push(nextPath)` on success.
- [ ] Copy states plainly that a new location starts in "Onboarding" status.

**Verify:** `npm run build`

---

### Task D4: `/locations/[locationId]`

**Files:**
- Create: `src/app/(app)/locations/[locationId]/page.tsx`, `loading.tsx`
- Create: `src/components/locations/edit-location-form.tsx` (`"use client"`)
- Create: `src/components/locations/mapped-profiles-card.tsx` (server)
- Create: `src/components/locations/location-summary.tsx` (server, read-only)

- [ ] `generateMetadata` reads the location, falling back to "Location".
- [ ] `locations.get(scope, locationId)`; `notFound()` on null — **criterion 12**:
      foreign and missing take the same branch.
- [ ] Parallel loads: members, `platformProfiles.list`,
      `platformConnections.list`, `locations.metrics`.
- [ ] Sections: header with `LocationStatusBadge`; details (`EditLocationForm`
      when the caller holds `location.update`, otherwise `LocationSummary` — a
      `<dl>` plus a `Notice`, **not** a disabled form); mapped platform profiles
      with each profile's status, its connection's health, its last sync, and a
      `ButtonLink` to the relevant integration screen (an `EmptyState` linking
      to the same place when none are mapped); per-location metrics via
      `KpiCard`.
- [ ] A status help line under the status control **and** in the read-only
      summary: *"Status is a lifecycle and reporting state. It does not pause
      data collection or processing."* (D202).
- [ ] Under 300 lines; the profiles card, the summary, and the metrics row are
      separate components for that reason.

**Verify:** `npm run build`

---

### Task D5: Working list page

**Files:**
- Create: `src/lib/locations/search-params.ts`
- Create: `src/components/locations/location-filters.tsx` (`"use client"`)
- Edit: `src/app/(app)/locations/page.tsx`
- Edit: `src/components/ui/data-table.tsx` (if it has no row-link support)

- [ ] `parseLocationStatusParam` — exact match against `LOCATION_STATUSES`, else
      `"all"`. `parseLocationSearchParam` — trimmed, length-capped, else `""`.
      `matchesLocationSearch` — case-insensitive on name, city, region;
      **not** slug (D205). Pure, so directly testable.
- [ ] `location-filters.tsx` wraps `SearchInput` and `SelectFilter`, wiring
      `onChange` to `router.replace(..., { scroll: false })` with `?q=` and
      `?status=`, following `RuleStatusTabs`. Debounce the search using the shape
      in `src/components/monitoring/use-postal-lookup.ts` rather than writing a
      third one. Preserve the other param; drop a param at its default.
- [ ] Page: accept `searchParams`, parse both, filter rows before rendering.
- [ ] **KPI roll-ups come from the unfiltered set**, and the card says so. A
      "Portfolio rating" that changes when you type in a search box is not a
      portfolio rating. Table and comparison card reflect the filter; KPIs do
      not.
- [ ] Status options relabelled per D202 (`inactive` → "Inactive"); "All
      locations" card description corrected.
- [ ] Rows navigate to `/locations/${id}`. If `DataTable` lacks row-link support,
      add an optional `rowHref` prop wrapping the first cell in a `Link` and
      making the row a hit target — an `onClick` on `<tr>` is not
      keyboard-reachable.
- [ ] "Add location" becomes a `ButtonLink` to `/locations/new`, rendered only
      when `can(role, "location.create")` (D188's rule).
- [ ] Distinguish "no locations at all" from "no locations match this filter"
      (D186): the first offers "Add location", the second "Clear filters".
- [ ] Extract the KPI builder and columns if the file approaches 300 lines.

**Verify:** `npm run build && npm run lint`

---

### Task D6: Location action and filter tests

**Files:**
- Create: `tests/location-actions.test.ts`, `tests/location-filters.test.ts`
- Edit: `tests/organization-isolation.test.ts`

`location-actions.test.ts` — mock `authorize` and `revalidatePath`, real demo
`dataSource`:
- [ ] **Criterion 8** — owner and admin succeed.
- [ ] **Criterion 9** — communications lead, approver, location manager, analyst,
      viewer each refused with `forbidden`, writing nothing. RLS half is harness
      T-1…T-5, T-18.
- [ ] **Criterion 12** — Harbor's location id under a USHG admin scope →
      `not_found`-shaped failure naming no organization; the Harbor row
      unmodified.
- [ ] **Criterion 12** — a Harbor member as manager of a USHG location: refused.
- [ ] **Criterion 15** — after `createLocationAction`, the onboarding row is
      byte-identical and no `monitoringQueries` row was created. Run against an
      organization whose onboarding is deliberately **incomplete**, the state
      where an accidental `completeLocationsStep` would do damage.
- [ ] **Criterion 19, per-event** — `location.created` with
      `metadata.source === "manual"`; name-only → `location.updated` and no
      other; status-only → `location.status_changed` and **not**
      `location.updated`; manager-only → `location.manager_changed` and **not**
      `location.updated`; name + status → exactly two; a no-op → **zero**.
- [ ] A new location is `status: "setup"` regardless of input.
- [ ] Slug conflict → `slug` field error.

`location-filters.test.ts` — **Criterion 17**:
- [ ] `parseLocationStatusParam` maps each real status to itself, and `"ACTIVE"`,
      `"archived"`, `""`, `undefined` to `"all"`.
- [ ] `matchesLocationSearch` matches name, city, region case-insensitively; not
      slug; an empty query matches everything.
- [ ] Compose both over a fixture list and assert the row set the page would pass
      to `DataTable`.

`organization-isolation.test.ts`:
- [ ] Add `locations.update` and `locations.createAndMapFromIntegration` to the
      methods asserted to refuse a foreign id.

**Verify:** `npx vitest run tests/location-actions.test.ts tests/location-filters.test.ts tests/organization-isolation.test.ts`

---

**Stage D gate:** `npm run verify`

---

## Stage E — Status semantics

*The first draft's Task E2 (make `inactive` gate Google review sync) is
**removed** (round 1). Status gates no pipeline, and
`src/lib/integrations/google-service.ts` — which carries in-flight GBP work — is
not touched by this plan at all.*

### Task E1: Honest status labels and vocabulary

**Files:**
- Edit: `src/lib/labels.ts` — `inactive` → `"Inactive"`, with a comment giving
  the four operational meanings in one sentence each and stating that **no
  pipeline branches on status**.
- Edit: `src/app/(app)/locations/page.tsx` — filter labels and card description.
- Edit: `src/components/ui/status-badge.tsx` — confirm tones read correctly
  (`inactive` neutral, `review` amber).
- Edit: `docs/data-model.md` — add the four values, their meanings, and the
  sentence that status does not pause processing.

- [ ] `grep -rn "Paused\|paused" src/ docs/` — no hits for location status.
- [ ] Confirm D4's help line renders on the location screen.

**Verify:** `npm run lint && npm run build`

---

**Stage E gate:** `npm run verify`

---

## Stage F — Documentation, rollout, verification

### Task F1: Update the architecture record

**Files:**
- Edit: `docs/architecture/current-state.md`

- [ ] **Correct every `middleware.ts` reference to `src/proxy.ts`** (C1),
      including the Authentication diagram and D92, marked as a correction —
      this document records supersessions rather than rewriting silently.
- [ ] Routes table: `/organizations/new`, `/locations/new`,
      `/locations/[locationId]`.
- [ ] Tenancy section: multiple organizations per user is now a product
      capability; the cookie helper is the single writer; `locations` write
      authority is owner/admin in both layers after R3, with mapping reaching
      creation only through `create_and_map_location`, which cannot produce an
      unbound location.
- [ ] New decision table "Decisions made building multi-organization and
      location management", **D191–D210**, copied from the spec.
- [ ] **The cross-table foreign-key inventory (D208)**, from the catalog:
      ```sql
      select c.conrelid::regclass as referencing,
             c.conname,
             c.confrelid::regclass as referenced,
             pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      order by 1, 2;
      ```
      One row per FK between organization-owned tables, verdict **composite** /
      **intentionally global** / **still defective**. Cross-check against spec
      §4; where the query and the static reading disagree, the query wins and
      the discrepancy is worth a sentence.
- [ ] **Record SEC-1 as a named, prioritized security follow-up**, under a
      heading that reads as an open security item — *not* in the "Known gaps"
      list. Copy §6.1's priority table and exit criteria verbatim, including the
      reason it is filed as security rather than tidiness: multi-organization
      support turns previously unlikely cross-tenant combinations into ordinary
      product behaviour, so an application-only guard now sits in front of a
      routine case rather than an edge case. State the exit criteria (every P1
      and P2 row composite or with a written exception, each with a hosted
      preflight and a harness assertion) so the item can be closed rather than
      admired.
- [ ] Known gaps: concurrent location edits can lose one (no `revision` token);
      no pipeline is location-status aware and a unified pause control is
      deferred; organization deletion and ownership relinquishment do not exist.
- [ ] Migration table: the five new migrations, their versions, contracts, and
      **which release each belongs to**.
- [ ] The rollout runbook from Task F3, in full.

**Files:**
- Edit: `docs/screens.md`, `docs/onboarding.md` as previously specified.

**Verify:** `npm run lint`

---

### Task F2: Full verification

- [ ] `npm run verify`.
- [ ] Fresh local stack at CLI `2.101.0`: `db:verify-tenancy`, `db:verify-rls`,
      `db:verify-execution`, `db:verify-generation` — all green.
- [ ] `npm run db:validate`.
- [ ] **Browser flow — the acceptance proof for criteria 7 and 17**, in demo
      mode as an owner:
      1. Create an organization from the switcher; land on
         `/onboarding/organization`; the switcher now shows three.
      2. Switch back to USHG, open `/reviews/google/[id]`, and switch
         organizations from there — **must land on `/overview`, not a 404**.
      3. Add a location; it lands on its management screen at "Onboarding", and
         onboarding progress elsewhere is unchanged.
      4. Edit address, then status, then manager, as three separate submissions;
         the audit trail shows `location.updated`, `location.status_changed`,
         and `location.manager_changed` respectively, and the manager edit
         produced **no** `location.updated`.
      5. Filter and search; the table changes, the KPIs do not, and the URL
         carries `?q=`/`?status=` and survives a refresh.
      6. Open a location from a table row, by click **and** by keyboard.
- [ ] **Role pass** via the `lia_demo_user` cookie: communications lead and
      viewer on `/locations/new` → notice, back link, **no form**; the same roles
      on `/locations/[locationId]` → read-only summary and notice, **no disabled
      form**; `/locations` shows no "Add location" for either.
- [ ] **Dirty-tree fingerprint check.** Re-run all seven commands from Task A00
      in the original working tree and compare byte for byte — HEAD, branch,
      status listing, both diff hashes, the untracked manifest, and the
      untracked file hashes. `.git` metadata is excluded and is expected to
      differ (the worktree registration).

---

### Task F3: Rollout and rollback

**Files:**
- Edit: `docs/architecture/current-state.md` (the runbook lands in F1)

Expand-contract, per D209. Database and application deployment are **not** one
atomic operation, and intra-branch task order is not a substitute for production
compatibility.

**Phase R1 — expansion.** Push `20260814000100`–`000400` to hosted. **Do not
push `000500`.**
- Rollback: the four are additive except A1's function drop. Restore the
  four-argument body from `20260808000100` and re-apply `20260805000200`'s
  revoke/grant; drop the four composite FKs, the trigger, and
  `create_and_map_location`, restoring the simple FKs. The
  `provision_request_key` column, its index, and the widened audit constraint
  may stay — nothing depends on their absence.

**Phase F0 — compatibility gate, between R1 and R2. Blocking.**
- [ ] Against the expanded hosted database, with the **currently deployed**
      application still running: create an organization through the existing
      sign-up flow and confirm it succeeds (the four-argument call resolving
      through defaults — harness T-28 is the local proof, this is the production
      one).
- [ ] Map a Google location as a communications lead and confirm it succeeds
      (the wide `locations_insert` still in place — harness T-26 locally).
- [ ] Confirm no scheduled analysis or poll regressed (the new FKs and trigger
      touch tables both sweeps write to).
- [ ] Any failure here stops R2 and triggers the R1 rollback above.

**Phase R2 — application.** Deploy the branch.
- Smoke test, in production: create an organization from
  `/organizations/new`; confirm it becomes active and lands on onboarding step 1;
  confirm the `organization.created` audit row exists with a non-null
  `organization_id`. Then map a Google location as a communications lead and
  confirm the location **and** its profile binding both exist, with three audit
  rows.
- Rollback: redeploy the previous application version. **This works**, because
  R3 has not run: the four-argument call still resolves and the wide
  `locations_insert` is still in place. This is the property the expand-contract
  split exists to buy.

**Phase R3 — contraction.** After the R2 rollback window closes, push
`20260814000500`.
- [ ] Re-run the authorization verification against hosted: a communications
      lead's direct `INSERT` into `locations` is refused; their mapping still
      succeeds through the RPC; `has_table_privilege('authenticated',
      'public.locations', 'delete')` is false.
- Rollback: restore the three original policies from `20260801000200` and
  `grant delete on public.locations to authenticated` (SQL in the migration's
  header). **Note that rolling the application back past R2 after R3 has run
  breaks communications-lead mapping** — which is exactly why R3 waits.

---

## Task dependency order

```
A00 → A0 → A1 → A2 → A3 → A4 → A5 → A6 → [Stage A gate]
                                              ↓
     B1(+A4) → B2 → B3 → B4 → B5 → B6 → B7 → B8 → [Stage B gate]
                                                       ↓
     C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → [Stage C gate]
                                                 ↓
     D1 → D2 → D3 → D4 → D5 → D6 → [Stage D gate]
                                       ↓
     E1 → [Stage E gate]
           ↓
     F1 → F2 → F3
```

A1–A5 may be drafted in parallel but must be numbered and applied in order.
B1 and A4 land in one commit. B7 must precede B8. **A5 is written in Stage A but
deployed in R3** (F3) — it is the only migration that does not ship with the
others, and the Stage A harness runs its assertions behind a
migration-presence guard so the same file is valid against both an R1 and an R3
database.

---

## Explicitly out of scope

Organization deletion, ownership relinquishment, leaving an organization,
billing limits, a global organization directory, a unified pause-processing
control, the SEC-1 foreign keys (inventoried and prioritized, not closed),
harmonising `mentions.location_id` onto a single composite FK,
optimistic-concurrency tokens on location edits, a per-location brand-voice
override, and a `phone` column on `locations`. Each is recorded with its
reasoning in §6 and §6.1 of the spec.
