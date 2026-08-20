# Multi-organization and multi-location management — design

**Date:** 2026-08-13 (revised 2026-08-14, review rounds 1 and 2)
**Status:** Proposed — awaiting approval
**Scope:** Creating and switching organizations from inside Lia; creating and
administering locations inside the active organization; the database
invariants both depend on.

Plan: `docs/superpowers/plans/2026-08-13-multi-organization-and-location-management.md`

**Revision note.** Round 1 rejected four decisions and tightened five. Round 2
rejected four more. Materially changed since the first draft, in order of
consequence:

- The mapping function creates **and binds** — it takes the profile set being
  mapped, locks it, and can never commit an unbound location (D200, round 2).
- The rollout is **expand-contract across three releases and five migrations**,
  not one push timed against one deploy (D209, round 2).
- Privileges revoke `service_role` too, so the SQL and the prose agree (D210,
  round 2).
- The dirty-tree guard fingerprints **contents**, not `git status` output
  (plan Task A00, round 2).
- The remaining cross-table foreign-key defects become a **named, prioritized
  security follow-up (SEC-1)**, not documentation debt (§6.1, round 2).
- Round-1 changes: `provision_organization` dropped and recreated rather than
  replaced; atomic idempotency; column-specific referential actions and the
  existing membership key order; `mentions.platform_profile_id` closed here;
  an active-membership trigger; and `inactive` as lifecycle-only.

§8 is the full decision delta.

---

## 1. Current-state audit

Read before writing anything: `CLAUDE.md`, `docs/data-model.md`,
`docs/onboarding.md`, `docs/screens.md`, `docs/product-spec.md`,
`docs/design-system.md`, `docs/implementation-plan.md`,
`docs/architecture/current-state.md`, `docs/integrations/*`. Every claim below
is checked against the code on `master` as it stands today, not against the
documents.

### 1.1 What already works, confirmed

| Claim in the brief | Verdict | Evidence |
| --- | --- | --- |
| `memberships` is a user↔organization join, unique on `(organization_id, user_id)` | **True** | `memberships_unique_user_per_org unique (organization_id, user_id)`, [20260801000100_initial_schema.sql:161](supabase/migrations/20260801000100_initial_schema.sql#L161) — "A user may hold several memberships." |
| `organizations.listForUser()` returns all active memberships | **True** | [types.ts:264](src/lib/data/types.ts#L264); demo [index.ts:708](src/lib/data/demo/index.ts#L708) filters on `status === "active"` only |
| `getOrganizationContext()` verifies the active org against those memberships | **True** | [organization-context.ts:43-84](src/lib/tenancy/organization-context.ts#L43-L84) |
| `lia_active_organization` is an httpOnly selection cookie, not authorization | **True** | [organization-context.ts:25](src/lib/tenancy/organization-context.ts#L25); an unknown or foreign id falls back to `available[0]` |
| `OrgSwitcher` already displays and switches among organizations | **True** | [org-switcher.tsx](src/components/shell/org-switcher.tsx), rendered twice by [sidebar.tsx:102-114](src/components/shell/sidebar.tsx#L102-L114) |
| `provision_organization` creates org + owner membership + onboarding row atomically | **True** | [20260805000100](supabase/migrations/20260805000100_membership_provisioning.sql), rewritten by [20260808000100](supabase/migrations/20260808000100_organization_onboarding.sql) |
| …and does **not** restrict the caller to one organization | **True** | The function reads `auth.uid()`, validates the name, derives a slug, and inserts. There is no membership-count check in its body. The "one organization per person" behaviour comes entirely from `provisionPendingOrganization()`'s `memberships.length > 0` guard ([post-auth.ts:77](src/lib/onboarding/post-auth.ts#L77)), a *recovery* path, not the contract. |
| Repository scopes and RLS isolate organization-owned records | **True** | Every organization-owned method takes `OrganizationScope`; policies call `is_organization_member` / `can_write_in_organization` |
| `locations` already supports multiple records per organization | **True** | [initial_schema.sql:183-212](supabase/migrations/20260801000100_initial_schema.sql#L183-L212); unique on `(organization_id, slug)` |
| `locations.create()` exists in both adapters, used by onboarding and GBP mapping | **True** | demo [index.ts:1286](src/lib/data/demo/index.ts#L1286), supabase [index.ts:1014](src/lib/data/supabase/index.ts#L1014); callers [onboarding.ts:321](src/app/actions/onboarding.ts#L321) and [google-mapping.ts:267](src/lib/integrations/google-mapping.ts#L267) |

Five further facts the brief did not state, all of which shape the design:

- **The seed already contains a multi-organization user.** `USER_DANIEL` is
  `owner` of Union Square Hospitality and `viewer` of Harbor & Vine
  ([dataset.ts:174,183](src/lib/seed/dataset.ts#L174)). Criterion 1 is
  expressible against the existing fixture with no new seed data.
- **`organization.created` and `location.created` are already in the audit
  vocabulary**, in both `AUDIT_EVENT_TYPES`
  ([enums.ts:479,509](src/domain/enums.ts#L479)) and the latest check-constraint
  migration. `location.created` is emitted by `createOnboardingLocationAction`;
  `organization.created` is emitted by **nothing at all**. The brief's item 9 is
  a missing *writer*, not missing vocabulary.
- **`createOnboardingLocationAction` already stamps `metadata.source = "onboarding_manual"`**
  ([onboarding.ts:339](src/app/actions/onboarding.ts#L339)), so the three-way
  distinction between wizard, manual, and integration creation needs one new
  value, not three.
- **The demo adapter already writes audit rows from inside repository methods**
  ([demo/index.ts:581](src/lib/data/demo/index.ts#L581),
  [2673](src/lib/data/demo/index.ts#L2673)), mirroring `raise_escalation` and
  `complete_generation_attempt`. Folding audit inserts into a definer function
  and its demo twin is the established pattern here.
- **Platform profiles are not persisted before mapping.** They are fetched live
  from Google on every render of the setup screen and written by
  `platformProfiles.upsert` at the moment a mapping decision is saved, keyed on
  `platform_profiles_unique_external (platform_connection_id, external_profile_id)`
  ([google-mapping.ts:296](src/lib/integrations/google-mapping.ts#L296)). Any
  "create and bind" contract must therefore be able to *create* the profile row,
  not merely reference one — which is exactly what D200 does.

### 1.2 Premises the code contradicts

**C1 — There is no `middleware.ts`. The file is `src/proxy.ts`.**
Next.js 16 renamed the convention and this repository followed it. The auth
gate, the product denylist (`PRODUCT_PATHS`), and the `SESSIONLESS_PATHS`
carve-out all live in [src/proxy.ts](src/proxy.ts).
`docs/architecture/current-state.md` still says `middleware.ts` throughout.
Concrete consequence: **`/organizations/new` must be added to `PRODUCT_PATHS`**,
or an anonymous request falls through the gate to a page that throws rather
than redirecting to `/sign-in`.

**C2 — `runAction()` and `redirect()` do not compose.**
`redirect()` throws `NEXT_REDIRECT`, and [`runAction`](src/lib/actions/result.ts)
catches everything and converts it to `{ ok: false }` — so a `redirect()` inside
a `runAction` body becomes a generic failure and the navigation never happens.
This is why [`auth.ts`](src/app/actions/auth.ts) is deliberately unwrapped and
why the onboarding actions return `{ nextPath }`
([onboarding.ts:349](src/app/actions/onboarding.ts#L349)). This design follows
the second pattern.

**C3 — `switchOrganizationAction` does not navigate at all today.**
It writes the cookie and calls `revalidatePath("/", "layout")`; the browser
stays put. On `/overview` that is invisible. On `/reviews/google/[id]`,
`/rules/[ruleId]`, `/media/[id]` — every tenant-specific detail route — the
re-render asks the *new* organization for the *old* organization's record id,
gets `null`, and calls `notFound()`. Not a data leak; a 404. Item 7 is real and
its fix is client-side navigation.

### 1.3 The actual gaps

**Organizations**

| # | Gap | Where |
| --- | --- | --- |
| G1 | No route, action, or UI entry creates an organization from inside the app. | — |
| G2 | An account with zero memberships reaches `(app)/layout.tsx`, `getOrganizationContext()` throws `not_a_member`, and the error boundary renders a generic `ErrorState` with a retry that fails identically forever. `postAuthDestination`'s comment claims the shell "reports 'your account is not a member of any organization yet'" — it does not. | [post-auth.ts:129-138](src/lib/onboarding/post-auth.ts#L129-L138), [(app)/error.tsx](src/app/(app)/error.tsx) |
| G3 | The cookie is written in one place with five attributes inline. Three more writers are about to exist. | [organization.ts:30-36](src/app/actions/organization.ts#L30-L36) |
| G4 | `acceptInvitationAction` returns `{ organizationId }` and never selects it; `acceptInvitationWithSignUpAction` redirects without selecting either. Masked today because a fresh invitee has one membership, so `available[0]` is right by accident. | [invitations.ts:160-176](src/app/actions/invitations.ts#L160-L176), [auth.ts:283-342](src/app/actions/auth.ts#L283-L342) |
| G5 | Switching from a detail route 404s (C3). | [org-switcher.tsx:56-66](src/components/shell/org-switcher.tsx#L56-L66) |
| G6 | Comments state provisioning's precondition as "the caller holds no membership yet", false for every organization this feature creates. | [types.ts:270-271](src/lib/data/types.ts#L270-L271), [20260805000100:167](supabase/migrations/20260805000100_membership_provisioning.sql#L167) |
| G7 | Nothing writes `organization.created`. | [enums.ts:509](src/domain/enums.ts#L509) |
| G8 | Nothing makes provisioning idempotent under a double submit. Two clicks produce "Acme" and "acme-2" — two tenants, two onboarding rows. | [20260808000100:137](supabase/migrations/20260808000100_organization_onboarding.sql#L137) |

**Locations**

| # | Gap | Where |
| --- | --- | --- |
| G9 | "Add location" is a `<Button>` with no `onClick` and no `href`. | [locations/page.tsx:199-201](src/app/(app)/locations/page.tsx#L199-L201) |
| G10 | `LocationRepository` has no `update`. Identity, address, timezone, and status are unreachable after creation. | [types.ts:414-431](src/lib/data/types.ts#L414-L431) |
| G11 | The only manual creation path also calls `completeLocationsStep`, `ensureLocationMonitoring`, and returns the wizard's next path. | [onboarding.ts:321-351](src/app/actions/onboarding.ts#L321-L351) |
| G12 | No `location.create` / `location.update` permission. | [permissions.ts:13-37](src/lib/auth/permissions.ts#L13-L37) |
| G13 | The search box and status select are `useState`-only, wired to nothing. | [locations/page.tsx:204-220](src/app/(app)/locations/page.tsx#L204-L220) |
| G14 | Table rows are not navigable; there is no per-location screen. | [locations/page.tsx:237-244](src/app/(app)/locations/page.tsx#L237-L244) |
| G15 | `inactive` is labelled "Paused". Nothing in the codebase branches on location status except two portfolio roll-ups. | [labels.ts:186-191](src/lib/labels.ts#L186-L191) |
| G16 | `setup`, `review`, `inactive` have no defined meaning. `review` is used by nothing. | — |

**Database and security**

| # | Gap | Where |
| --- | --- | --- |
| G17 | `locations_insert` / `locations_update` use `can_write_in_organization`, admitting **location_manager and approver** as well. A location manager can update any location, including reassigning `manager_user_id` to themselves — the exact widening `location.update_manager` exists to prevent. | [20260801000200:188-197](supabase/migrations/20260801000200_row_level_security.sql#L188-L197) |
| G18 | `locations.manager_user_id` references `public.users (id)`. No database requirement of membership, active or otherwise. | [initial_schema.sql:197](supabase/migrations/20260801000100_initial_schema.sql#L197) |
| G19 | `platform_profiles.location_id` and `monitoring_queries.location_id` are plain FKs to `locations (id)`. | [initial_schema.sql:286](supabase/migrations/20260801000100_initial_schema.sql#L286), [news_monitoring.sql:26](supabase/migrations/20260806000500_news_monitoring.sql#L26) |
| G20 | `mentions.platform_profile_id` is also a plain FK. **Closed here** (D208). | [initial_schema.sql:326](supabase/migrations/20260801000100_initial_schema.sql#L326) |
| G21 | A `locations_delete` policy exists with no repository method behind it, and `delete` on `locations` has never been revoked from `authenticated` at table level. | [20260801000200:196](supabase/migrations/20260801000200_row_level_security.sql#L196) |
| G22 | `provision_organization` is revoked from `public` and granted to `authenticated` ([20260805000200:64-65](supabase/migrations/20260805000200_membership_provisioning_rls.sql#L64-L65)) — but **not** from `anon` or `service_role`. Supabase's bootstrap issues `alter default privileges … grant all on functions to postgres, anon, authenticated, service_role`, and revoking `PUBLIC` does not remove those, exactly as [20260807000600](supabase/migrations/20260807000600_oauth_helpers_default_privilege_revoke.sql) documents. The function is callable with the anon key today — safe *by body* (`auth.uid()` is null → `28000`), not *by grant*. | — |

### 1.4 What must not break

- Cross-tenant reads already fail safely: a foreign location id returns `null`
  and every detail route calls `notFound()`. Foreign and missing are already
  indistinguishable, and every new route and function must preserve that.
- A forged `lia_active_organization` cookie already buys nothing.
- `provision_organization` takes its actor from `auth.uid()` and writes `owner`
  literally. Nothing may parameterise either.
- `audit_events` accepts no inserts from `authenticated` (D162).

---

## 2. Product model

- **Organization** — tenant, team, policy, and future billing boundary. Any
  authenticated user may create one regardless of their role elsewhere, and
  becomes its owner.
- **Location** — a physical operating unit belonging to exactly one
  organization. Slugs unique per organization, never globally.
- A new organization becomes active immediately and starts its own onboarding
  at step 1. Existing organizations and their onboarding rows are untouched.
- **Manual location creation and administrative editing are owner/admin only,
  in the application *and* in the database.** A communications lead can bring a
  location into existence only as an *inseparable part of* binding a Google
  profile to it — never as a standalone create.
- Locations are never hard-deleted. `inactive` is the retirement state and
  every record survives it. **It does not pause data collection or
  processing** (D202).

---

## 3. Design decisions

Numbered continuing from D190 in `docs/architecture/current-state.md`.

### Organizations

**D191 — `/organizations/new` lives at `src/app/organizations/new/page.tsx`, outside both route groups, and is added to `PRODUCT_PATHS`.**
It cannot live inside `(app)`: that layout calls `redirectIfOnboarding()` and
`getOrganizationContext()` before rendering anything, and both require an
organization the caller may not have. It must not live inside `(site)`: it is
signed-in-only. `/onboarding/*` already occupies this exact position and this
route reuses its chrome (`OnboardingShell`, Geist, `robots: noindex`) because it
is the same moment in the same journey. The `PRODUCT_PATHS` entry is what makes
an anonymous request redirect to `/sign-in?next=/organizations/new` (C1);
`matchesSegment` means the single entry `/organizations` covers everything
under it.

**D192 — The `organization.created` audit event is written inside `provision_organization`.**
Three independent reasons. (a) `insert` on `audit_events` is revoked from
`authenticated` (D162), so the action cannot write it; going through the
service-role adapter would be an ambient privilege escalation inside a request
path — the mechanism `current-state.md` already flags as a defect in
`requestsSpentSince`. (b) `recordAuditEvent` needs an `OrganizationScope`, which
does not exist until the organization does. (c) An organization existing with no
`organization.created` row is a hole in the trail. Follows `raise_escalation`
(D159).

The row carries every column the table requires and every column a reader needs:
`organization_id` (the new organization — `not null`, and the column RLS
resolves through, so omitting it both fails the constraint and hides the row
from the tenant it describes), `actor_type = 'user'`,
`actor_user_id = auth.uid()`, `event_type`, `entity_type = 'organization'`,
`entity_id`, `previous_state = null`, `new_state` carrying name and slug, and
`metadata` carrying the validated `source`. **Only the invocation that actually
created the organization writes it** (D195), so a replay produces no second row.

**D193 — One `setActiveOrganizationCookie(organizationId)` helper**, used by
switching, creation, and both acceptance paths. Five attributes duplicated four
ways is four chances for one to drift, and a missing `httpOnly` or wrong `path`
is a security regression no test notices because the feature keeps working.

**D194 — Every organization switch navigates to `/overview` from the client.**
The action cannot `redirect()` (C2), so `OrgSwitcher` calls
`router.push("/overview")`. Not "stay put if the route is tenant-agnostic": the
safe set is not stable — `/mentions`, `/responses`, and `/escalations` all carry
record ids in query params — and a rule re-derived every time a screen gains a
selection parameter will be wrong within a workflow or two. One destination
always is a rule that cannot rot.

**D195 — `provision_organization` is dropped and recreated with one canonical six-argument signature, and its idempotency is atomic.**

*(a) The signature cannot change in place.* `CREATE OR REPLACE FUNCTION` cannot
alter an input signature; adding parameters produces an **overload**, leaving
the four-argument function alive with a divergent body and PostgREST resolving
whichever matches the argument names a client sends. So the migration confirms
no database dependency exists (`pg_depend`, and `pg_proc.prosrc` scanned for
other bodies naming it), captures the current owner from `proowner`, then
`drop function if exists public.provision_organization(text, text, text, text) restrict;`
— exact types, `RESTRICT` spelled out so a missed dependency aborts rather than
being cascaded away — and creates exactly one function:

```sql
public.provision_organization(
  organization_name     text,
  organization_industry text default 'Restaurant group',
  organization_timezone text default 'UTC',
  organization_language text default 'en-US',
  p_request_key         uuid default null,
  p_source              text default 'self_serve'
) returns uuid
```

Every existing four-argument call resolves through the defaults — which is what
makes the expand phase of D209 backward-compatible. There is no five-argument
variant anywhere. `p_source` is validated against exactly
`('self_serve', 'in_app')`, raising `22023` otherwise: it reaches
`audit_events.metadata`, and caller-authored free text in an audit trail is a
trail somebody can write anything into.

*(b) Read-then-insert is not idempotent.* Two concurrent invocations can both
miss a replay lookup; one wins the unique index and the other gets `23505`
instead of the existing id. The insert itself must be the decision:

```sql
insert into public.organizations (…, provision_request_key)
values (…, p_request_key)
on conflict (provision_request_key) where provision_request_key is not null
do nothing
returning id into new_organization_id;
```

A null return means this invocation created nothing and **must create nothing
else** — no membership, no onboarding row, no audit event. It then resolves the
winner with an **actor-scoped** lookup joining `memberships` on
`user_id = actor and role = 'owner'`; finding nothing raises `42501`, so another
actor's organization id is never returned and nothing is disclosed about which
organization it is. The join is safe against uncommitted state because
`ON CONFLICT DO NOTHING` waits on the conflicting tuple's transaction before
reporting zero rows — by the time the lookup runs, the winner has committed its
membership row or rolled everything back. That ordering is load-bearing and is
stated in the function's own comment.

*(c) The unique index is the lock*, as D12 made the `WHERE` clause the lock for
OAuth state and D24 a partial unique index the lock for sync runs. The client
generates the key once per mounted form with `crypto.randomUUID()`; a retry
reuses it, a fresh page load gets a new one. A disabled submit button ships as a
courtesy, not the guarantee.

*Considered and rejected:* a constraint trigger refusing two same-named
organizations owned by one person. It closes the race but refuses a legitimate
case — one operator running "Bond Street" as two tenants — and inventing a
naming rule to solve a double-click is the wrong trade.

**D196 — Slug collisions need no change.** The function already derives, caps at
40 characters, and appends `-2`, `-3`, … to 500 before `23505`. What changes is
that collisions become *expected* rather than exceptional, so the behaviour gets
a test rather than remaining an untested loop.

**D197 — Zero-membership users go to `/organizations/new`**, and
`postAuthDestination`'s comment is rewritten to say what actually happens
instead of describing a message the error boundary swallows (G2).

### Locations

**D198 — `/locations/new` and `/locations/[locationId]` inside `(app)`.**
`/rules/new` and `/rules/[ruleId]` are the established convention for this
shape, down to `generateMetadata` reading the record and `notFound()` on a
missing or foreign id. Following it means the loading state, error boundary,
header, and permission-denied rendering are already solved.

**D199 — New permissions `location.create` and `location.update`, both owner/admin, matching RLS exactly after the contraction phase.**
Not a reuse of `location.update_manager`: assigning a manager is a decision
about *who holds authority over a site*, which is why it is narrower than the
general write gate. Not a reuse of `onboarding.manage`: first-run setup and
ongoing administration are different authorities, and an organization that has
finished onboarding still needs its eleventh restaurant. Same roles as
`location.update_manager` today, so the split costs nothing now and gives a
future "regional director may edit their sites" role somewhere to attach.

**D200 — `create_and_map_location`: creation is a side effect of binding, not a capability granted alongside it.**

*Round 1 rejected leaving `locations_insert` open to communications leads while
the product claimed owner/admin-only. Round 2 rejected the first fix — a
`create_location_for_mapping` that took only a connection id and location
fields, which a communications lead could call repeatedly to mint arbitrary
orphaned `setup` locations. Restricting status and manager narrows what the row
looks like; it does not make creation a side effect of mapping. The function has
to actually perform the mapping.*

```sql
public.create_and_map_location(
  p_connection_id uuid,
  p_profiles      jsonb,   -- [{ externalProfileId, externalProfileName, profileUrl,
                           --    externalAccountId, verificationState, providerMetadata }]
  p_name          text,
  p_address_line1 text, p_address_line2 text,
  p_city          text, p_region        text,
  p_postal_code   text, p_country_code  text,
  p_timezone      text
) returns table (location_id uuid, profile_id uuid, profile_created boolean, replayed boolean)
security definer, set search_path = public, pg_temp
```

The contract, property by property:

- **At least one profile is required.** An empty or absent `p_profiles` raises
  `22023`. There is no shape of call that creates a location and binds nothing.
- **The tenant is derived, never supplied.** `organization_id` comes from the
  named `platform_connections` row. A caller cannot aim this at another
  organization by passing an id, and no organization id is a parameter.
- **Authority is checked against that derived organization**:
  `has_organization_role(org, array['owner','admin','communications_lead'])`,
  matching `integration.manage_profiles` exactly. A non-member gets `42501` —
  the same code and message an unknown connection id produces, so the function
  is not a probe for which connections exist.
- **Profiles are upserted and locked inside the transaction.** Platform profiles
  are not persisted before mapping (§1.1) — they are fetched live from Google
  and written at save time — so this function must be able to create the row,
  not merely reference one. It upserts on
  `platform_profiles_unique_external (platform_connection_id, external_profile_id)`
  with `on conflict … do update … returning`, then re-reads the affected rows
  `order by id for update`. The explicit lock is what makes two concurrent
  submissions for the same listing converge instead of minting two locations;
  the deterministic ordering is what keeps two concurrent multi-profile calls
  from deadlocking against each other.
- **Every locked row is verified** to carry the resolved `organization_id` and
  `platform_connection_id`, and the locked count must equal the input
  cardinality. Mixed-organization sets are structurally impossible — one
  connection belongs to one organization, and the natural key is scoped to the
  connection, so an external id that also exists under another organization's
  connection is a different row this call can neither read nor touch. The
  explicit check is defence in depth against corrupt data and against a future
  caller shape, not the primary mechanism; both are asserted (T-25, T-27).
- **Replay is defined, not incidental.** Over the locked set's
  `distinct location_id`: all null → create and bind; a single non-null value →
  **replay**, return that location with `replayed = true` and write **nothing**
  — no second location, no second audit event; mixed or several distinct values
  → a deterministic conflict (`23505`, fixed message), because a profile set
  half-bound to one location and half to another is a state no retry should
  silently resolve.
- **An unbound location can never commit.** The insert into `locations`, the
  `update platform_profiles set location_id = …`, and the audit rows are one
  function body, which is one transaction. Any failure discards all of it.
- **Status and manager are written literally** (`'setup'`, `null`) and the slug
  is derived and de-duplicated inside the function. None of the three is a
  parameter, so the function is structurally incapable of producing an active
  or managed location, or of choosing a slug.
- **It writes its own audit events, in the same transaction as the writes they
  describe**: `location.created_from_integration`, plus
  `integration.profile_connected` for each profile row it newly created, plus
  `integration.profile_mapped` for each binding. Those are exactly the three
  events `google-mapping.ts` writes for this branch today; moving them inside is
  what makes "the application performs no second, non-atomic binding step"
  literally true rather than nearly true. The `map_existing` branch is untouched
  and keeps writing its own events, because it creates no location and needs no
  RPC.
- **Grants are explicit and complete**: revoked from `public`, `anon`, **and
  `service_role`**; granted to `authenticated` only (D210).

`locations_insert` and `locations_update` then narrow to owner/admin — in the
**contraction** release, not alongside the RPC (D209). A communications lead's
direct `INSERT` is refused `42501`, their direct `UPDATE` matches zero rows, and
mapping keeps working through a function that cannot produce a location without
producing a mapping for it.

**This narrows D17 rather than reversing it.** D17 refused a Postgres function
wrapping the whole mapping *batch*, on the grounds that the demo adapter has no
transaction and each decision should be independent and idempotent. That still
holds: the batch stays a loop of independent, per-row-reported decisions. What
becomes atomic is one decision's create-and-bind, which was never independent —
a location without its profile was always a half-applied decision, and D17's
own reasoning ("each decision is independent and idempotent") is what this
delivers rather than what it trades away.
`docs/integrations/google-business-profile.md` records the D17 trade and is
updated accordingly.

`locations_delete` is dropped **and** `delete` is revoked from `authenticated`
at table level, matching how `audit_events` is protected
([20260801000200:314](supabase/migrations/20260801000200_row_level_security.sql#L314),
[20260812000200:10](supabase/migrations/20260812000200_audit_events_no_client_inserts.sql#L10)).
Dropping a policy without revoking the privilege leaves the grant for whatever
policy somebody adds next; the revoke is what makes "no hard deletes"
structural.

**D201 — `manager_user_id` gets a composite FK to `memberships` in the existing key order, and suspension keeps the assignment.**

```sql
foreign key (organization_id, manager_user_id)
  references public.memberships (organization_id, user_id)
  on delete set null (manager_user_id)
```

Column order matches the existing `memberships_unique_user_per_org unique
(organization_id, user_id)`, so **no reversed unique constraint is added** —
the first draft proposed one, nothing needs it, and an index nothing queries is
a write cost with no reader.

| Event | Result | Why |
| --- | --- | --- |
| Membership **suspended** | Assignment survives. The location screen and portfolio table label the manager "access suspended". | Suspension is the reversible option for somebody on leave. Silently unassigning their six restaurants and making an owner reconstruct the mapping on their return is a worse surprise than a label. RLS already ignores a non-active membership, so the suspended person reaches nothing. |
| Membership **removed** | `manager_user_id` becomes null; `organization_id` untouched. | Matches the column's existing comment and the rule that removal deletes the membership, not the account. No `location.manager_changed` event: no actor decided it about this location, `membership.removed` is the record, and a second event would attribute a machine consequence to a person. |
| Membership **role** changes | Nothing. | Any role may manage a site; the assignment is not a role. |

**D202 — The four statuses get defined meanings, `inactive` stops being "Paused", and nothing gates processing on status.**

*Round 1 rejected making `inactive` skip Google review sync: a lifecycle status
must not silently control one ingestion system while news polling, analysis, and
rule execution carry on. A partial pause is harder to reason about than no
pause, and it would have meant editing the Google service while unrelated GBP
work is in flight.*

| Status | Label | Meaning — what is true, and nothing more |
| --- | --- | --- |
| `setup` | Onboarding | Exists, not yet in service. Excluded from roll-ups and the comparison card (already true). Every manually created and every mapped location starts here. |
| `active` | Active | In service. Counted in every roll-up. |
| `review` | Under review | An operator flag meaning "watch this one". A badge and a filter. **Counted in roll-ups exactly like `active`**, because it describes attention, not service. |
| `inactive` | **Inactive** (was "Paused") | Retired. Excluded from roll-ups. Every historical record retained; reactivating restores service with history intact. |

**None of the four changes what any pipeline does**, and the interface says so:
*"Status is a lifecycle and reporting state. It does not pause data collection
or processing."* Pausing is a real operational control and deserves to be built
as one, covering every applicable pipeline, with its own name and audit event —
§6 records it as deferred.

**D203 — Manual creation is a new action, never a reuse of `createOnboardingLocationAction`.**
That action completes onboarding step 3, seeds monitoring queries, and returns
the wizard's next path; calling it from `/locations/new` would mark a
three-month-old organization's setup complete because somebody added a
restaurant. The two share the repository method and the field component and
nothing else. Three creation sources stay distinguishable:
`location.created` + `metadata.source: "manual"`, `location.created` +
`"onboarding_manual"` (already emitted), and
`location.created_from_integration`.

**D204 — `location.updated` and `location.status_changed` are new vocabulary, and the three update events are mutually exclusive by field.**

| Event | Fires for | Never fires for |
| --- | --- | --- |
| `location.updated` | `name`, `slug`, `addressLine1`, `addressLine2`, `city`, `region`, `postalCode`, `countryCode`, `timezone` | `status`, `managerUserId` |
| `location.status_changed` | `status` | anything else |
| `location.manager_changed` | `managerUserId` | anything else |

The exclusion is the part worth stating: a manager-only edit must **not** also
emit a generic `location.updated`, or every query for "who changed this
restaurant's address" returns manager reassignments too and the specific events
stop being worth having. A submission changing address and status emits two
events; one changing only a manager emits one. Both new literals land in
`src/domain/enums.ts` and the migration **in the same change**, because
`tests/audit-vocabulary-migrations.test.ts` parses the real SQL and fails in
both directions.

**D205 — Search and status filtering move into the URL, via `?q=` and `?status=`.**
`RuleStatusTabs` is the precedent: shareable, survives a refresh, and
`router.replace(..., { scroll: false })` avoids a history entry per keystroke.
`src/lib/locations/search-params.ts` mirrors `src/lib/rules/search-params.ts`
and falls back to "all" for anything that is not an exact `LocationStatus` — the
URL is untrusted input. Search matches name, city, and region,
case-insensitively; slug is excluded, because somebody searching "soho" means
the neighbourhood, not the URL fragment.

### Tenant integrity

**D206 — Every composite foreign key on a nullable column uses a column-specific `ON DELETE SET NULL`, and the superseded simple FK is dropped.**

A plain `on delete set null` on a composite key nulls **every** referencing
column. `organization_id` is `not null` on all four referencing tables, so a
membership or location deletion would fail with `23502` rather than clearing the
optional reference. PostgreSQL 15 added the column list for exactly this shape:
`on delete set null (manager_user_id)`, `(location_id)`,
`(platform_profile_id)`. **This requires PostgreSQL ≥ 15**; the migration
asserts it and the hosted preflight checks `server_version` rather than assuming.

The superseded simple FK is dropped in the same migration, by name resolved from
`pg_constraint` rather than hard-coded — auto-generated names are not guaranteed
stable across environments. Dropping it is not optional: leaving both means the
composite carries the tenant invariant while the simple one carries the delete
action, which is how `mentions.location_id` currently works and why nobody
noticed its composite has no `ON DELETE` clause at all. That arrangement is
correct today and is left alone (§4), but it is not a pattern to reproduce.

**D207 — A trigger enforces active membership on new manager assignments, and only on new ones.**

The composite FK proves same-organization membership, not *active* membership —
and criterion 13 requires active. Without this, an owner or admin can directly
assign a suspended member and the database accepts it, contradicting both the
criterion and `assertActiveMember`.

`before insert or update of manager_user_id, organization_id on public.locations`.
The function returns early — permitting the write — when `manager_user_id` is
null, and, on `UPDATE`, when neither `manager_user_id` nor `organization_id`
actually changed. That second guard is the design:

- **It fires on assignment**, so a new manager must hold an active
  same-organization membership. `23514` otherwise.
- **It does not fire on suspension**, which writes to `memberships`, not
  `locations` — and a later unrelated update of the location's address does not
  re-validate a manager who was legitimate when assigned. D201's lifecycle
  survives intact.
- **It does not fight the FK's `SET NULL`.** Membership deletion produces an
  update with `manager_user_id = null`, taking the first early return.
- **`update of <columns>` fires when a column is in the `SET` list even if
  unchanged**, which is why the `is not distinct from` guard lives in the body
  rather than being trusted to the trigger clause.

The rule now holds below the application layer for every path, present and
future — the argument that put the email match inside `accept_invitation`
rather than the server action (D56).

**D208 — `mentions.platform_profile_id` is closed here, and every cross-table foreign key is inventoried from the catalog.**

The first draft deferred this. Wrong: the prerequisite
(`platform_profiles (id, organization_id)` unique) is being added anyway, the
defect is identified and real, and deferring a known tenant-integrity hole
inside the stage whose purpose is tenant integrity defeats the stage.

Beyond the four closed here, the workflow produces a **catalog-driven
inventory** — a `pg_constraint` query, not a reading of migrations, so nothing
is missed — with one of three verdicts per row: **composite** (structural,
nothing to do), **intentionally global** (the referenced table is not
organization-owned, recorded so nobody "fixes" it), or **still defective** (a
same-organization reference the database does not enforce). The static reading
in §4 is the starting point; the query is what gets recorded. The still-defective
set becomes **SEC-1** (§6.1) — a named, prioritized follow-up, not a gap-list
entry.

**D209 — The rollout is expand-contract across three releases and five migrations.**

*Round 2 rejected "push the migrations immediately before or at deploy". It has
no safe side. Database-first breaks communications-lead mapping the moment
`locations_insert` narrows, because the deployed application still inserts
directly. Application-first calls an RPC and a six-argument function that do not
exist. And rolling the application back after the database change restores a
version whose mapping path is now blocked. Shortening the window is not
eliminating it: a database migration and an application deploy are not one
atomic operation, and pretending otherwise is how a five-minute outage becomes
an unrecoverable one.*

| Release | Contents | Old application still works because |
| --- | --- | --- |
| **R1 — expansion** | `20260814000100` provisioning (six-arg function, request key, audit writer), `…000200` tenant integrity (FKs, trigger), `…000300` `create_and_map_location`, `…000400` audit vocabulary. **`locations_insert`/`update` deliberately unchanged.** | Four-argument `provision_organization` calls resolve through the new defaults (D195a). The wide `locations_insert` policy is still in place, so direct mapping inserts still succeed. The new FKs reject only cross-tenant writes, which the preflights prove do not occur. The manager trigger fires only on assignment, and every existing write path already validates active membership in application code. The new RPC and the new audit literals are additive — nothing calls or emits them yet. |
| **R2 — application** | Deploy the branch: organization provisioning switches to six arguments with a request key; Google mapping switches to `create_and_map_location`; all new routes and screens. | — |
| **R3 — contraction** | `20260814000500`: narrow `locations_insert`/`locations_update` to owner/admin, drop `locations_delete`, revoke `delete` from `authenticated`. **After the R2 rollback window closes.** | — |

The property this buys, and the reason it is worth five migrations: **after R1,
the application can be rolled back to the previous version and still work**, and
**after R2, it can be rolled back to the previous version and still work**,
because R3 has not run. Only after R3 does rollback become one-way, which is why
R3 waits for the rollback window to close and why the compatibility verification
between R1 and R2 is a gate rather than a formality. Every phase carries written
rollback SQL or instructions (plan, §"Rollout and rollback").

Intra-branch task sequencing is **not** a substitute for this. A branch that is
internally consistent still deploys as two independent events against
production.

**D210 — Privileges revoke `service_role` as well as `public` and `anon`, and the claims match the SQL.**

Supabase's project bootstrap issues `alter default privileges in schema public
grant all on functions to postgres, anon, authenticated, service_role`. A newly
created function therefore picks up `EXECUTE` for all four plus `PUBLIC`.
Revoking `public` and `anon` — the first draft's SQL — leaves `service_role`
holding execute while the prose said "authenticated only" and "not granted to
`service_role`". The SQL and the documentation cannot disagree, so the SQL
changes:

```sql
revoke all on function <fn> from public, anon, service_role;
grant execute on function <fn> to authenticated;
```

applied to **both** `provision_organization` and `create_and_map_location`, with
T-21 asserting `has_function_privilege('service_role', …, 'execute')` is false
for each. Both are request-path functions that take their actor from
`auth.uid()`; a service-role caller has no `auth.uid()` and would fail inside
the body anyway, so the grant bought nothing and cost a surface. The plan
verifies no service-role caller exists before revoking — `getServiceDataSource()`
shares the same adapter, so a future service-role call to `organizations.provision`
would fail loudly rather than silently, which is the intended behaviour.

The trigger function `assert_location_manager_is_active_member` is revoked from
`public`, `anon`, `authenticated`, **and** `service_role`. PostgreSQL checks
`EXECUTE` on a trigger function at `CREATE TRIGGER` time, not at fire time, so
the trigger continues to fire for every role afterwards — but rather than assert
that from documentation, the harness proves it: T-9a exercises the trigger as an
`authenticated` user under `set role` **after** the revoke has run.

Closing G22 is the same change applied to the pre-existing function, which has
carried the `anon` grant since workflow 05.

---

## 4. Database contracts

Five migrations across two phases. Every one carries a preflight `DO` block that
raises on existing violations, in the wording `20260811000100` established: a
violation is a live cross-tenant defect to investigate, never data to grandfather
or rewrite.

**Expansion (R1)**

| Version | File | Contract |
| --- | --- | --- |
| `20260814000100` | `organization_provisioning_idempotency.sql` | Dependency preflight; owner capture; `drop function … (text,text,text,text) restrict`; `organizations.provision_request_key` + partial unique index; the canonical six-argument function with an atomic conflict arm, actor-scoped replay lookup, `p_source` validation, and an in-transaction `organization.created` insert; owner, comment, and `public`/`anon`/`service_role` revokes plus the `authenticated` grant (D192, D195, D210, closes G22). |
| `20260814000200` | `location_tenant_integrity.sql` | PG ≥ 15 assertion; four violation preflights; `platform_profiles (id, organization_id)` unique; composite FKs with column-specific `SET NULL` on `locations.manager_user_id`, `platform_profiles.location_id`, `monitoring_queries.location_id`, `mentions.platform_profile_id`; drop of each superseded simple FK by resolved name; the active-manager trigger and its revokes (D201, D206, D207, D208). |
| `20260814000300` | `location_mapping_rpc.sql` | `create_and_map_location` with its lock ordering, replay arm, verification checks, three audit inserts, and explicit revokes/grant (D200, D210). **No policy changes.** |
| `20260814000400` | `location_audit_vocabulary.sql` | Redefines `audit_events_known_event_type` adding `location.updated` and `location.status_changed` (D204). Must remain the last word on that constraint. |

**Contraction (R3)**

| Version | File | Contract |
| --- | --- | --- |
| `20260814000500` | `location_write_roles_contraction.sql` | `locations_insert`/`locations_update` narrowed to owner/admin; `locations_delete` dropped; `delete` revoked from `authenticated` (D200, D209). Ships in a later release, with its own rollback SQL. |

Versions start at `20260814` because `20260813000500` is taken and this
repository has been bitten twice by same-day collisions breaking
`supabase db reset`. Order within the day is load-bearing: `…0400` must sort
after every other redefinition of the audit check constraint, and `…0200` must
follow `…0100` because both touch `organizations`.

**Static FK reading, as the inventory's starting point.** The authoritative
version is the `pg_constraint` query in the plan.

| Referencing column | References | Verdict |
| --- | --- | --- |
| `mentions.location_id` | `locations (id, organization_id)` | **Composite.** Its delete action is carried by the *retained* simple FK, since `20260811000100`'s composite has no `ON DELETE` clause. Correct as it stands; deliberately not harmonised (§6). |
| `mention_analyses.mention_id`, `escalations.mention_id`, `escalations.trigger_analysis_id`, `automation_rule_executions.*`, `generation_attempts.*` | various `(id, organization_id[, …])` | **Composite.** |
| `locations.manager_user_id` | `users (id)` | **Defective → closed here** (D201). |
| `platform_profiles.location_id` | `locations (id)` | **Defective → closed here** (G19). |
| `monitoring_queries.location_id` | `locations (id)` | **Defective → closed here** (G19). |
| `mentions.platform_profile_id` | `platform_profiles (id)` | **Defective → closed here** (G20, D208). |
| `platform_profiles.platform_connection_id`, `mentions.platform_connection_id` | `platform_connections (id)`, `not null` | **Still defective → SEC-1 P1.** |
| `mentions.monitoring_query_id` | `monitoring_queries (id)`, nullable | **Still defective → SEC-1 P1.** |
| `response_drafts.mention_id`, `approvals.response_draft_id` | `not null` | **Still defective → SEC-1 P2.** |
| `platform_sync_runs.*`, `news_poll_runs.monitoring_query_id`, `news_rejected_candidates.*` | `not null` | **Still defective → SEC-1 P3.** |
| `mention_analyses.analysis_run_id` | `analysis_runs (id)` | **Still defective → SEC-1 P3.** Hardened to `on delete restrict` by D160 for a different reason; tenant match unenforced. |
| Anything referencing `public.users` | `users (id)` | **Intentionally global.** `users` is not organization-owned. |

---

## 5. Acceptance criteria → coverage

| # | Criterion | Proven by |
| --- | --- | --- |
| 1 | One user owns A, holds another role in B, creates C, sees all three | `tests/organization-creation.test.ts` — `USER_DANIEL` |
| 2 | Creating C does not modify A or B | same file — byte-identical snapshots either side |
| 3 | C becomes active and starts its own onboarding | same file + `tests/organization-selection.test.ts` |
| 4 | A user with no memberships reaches organization creation | `tests/organization-selection.test.ts` |
| 5 | An existing user accepting an invitation lands in the joined organization | same file, asserted for a user who already belonged elsewhere |
| 6 | A forged organization cookie grants no access | same file + harness |
| 7 | Switching from a record-detail route lands safely on `/overview` | **Browser flow (plan Task F2).** The source-text assertion is a static guard, not the proof. |
| 8 | Owners and admins can create and update locations | `tests/location-actions.test.ts`, `tests/permissions.test.ts`, harness T-6 |
| 9 | Unauthorized roles cannot use the actions or bypass them through RLS | `tests/location-actions.test.ts` + harness T-1…T-5, T-18, T-21, T-26 |
| 10 | Multiple locations can exist in one organization | `tests/location-repositories.test.ts` |
| 11 | Same slug across organizations, not within one | same file + harness T-13 |
| 12 | Foreign location ids cannot be read, updated, assigned, or mapped | `tests/location-actions.test.ts`, `tests/organization-isolation.test.ts`, harness T-11, T-12, T-20, T-22, T-25 |
| 13 | A manager must be an active member of the same organization | `tests/location-repositories.test.ts` + harness T-7, T-8, T-9a |
| 14 | Suspending or removing a manager produces the designed result | same file + harness T-9, T-10 |
| 15 | Manual creation does not complete or advance onboarding | `tests/location-actions.test.ts`, against an organization whose onboarding is deliberately incomplete |
| 16 | Google-created locations continue working | `tests/google-integration.test.ts` staying green through the RPC swap + harness T-19, T-23, T-24, T-27, T-28 |
| 17 | Location search and status filters affect the rendered table | `tests/location-filters.test.ts` + browser flow |
| 18 | Inactivation preserves historical records and mappings | `tests/location-repositories.test.ts` + harness T-17 |
| 19 | Audit events for org creation, location creation, updates, manager, status | `tests/location-actions.test.ts`, `tests/organization-creation.test.ts`, `tests/audit-vocabulary-migrations.test.ts`, harness T-15, T-23 |
| 20 | `npm run verify` and the full database harness pass | CI `verify` + `database` jobs; four `db:verify-*` scripts locally |

---

## 6. Decisions deliberately deferred

- **Organization deletion, ownership relinquishment, leaving an organization.**
  Out of scope by instruction. Consequence: a user who creates an organization
  by mistake cannot remove it, and the last-owner trigger means they cannot
  demote themselves out of it either.
- **A global organization directory, billing limits, or any cap** on how many
  organizations one account may create. D195 stops accidents; nothing stops
  deliberate volume.
- **A unified pause-processing capability** covering Google sync, news polling,
  analysis, and rule execution, with its own control, audit event, and name —
  separate from lifecycle status (D202).
- **Harmonising `mentions.location_id`** onto a single composite FK carrying its
  own column-specific `SET NULL`. Correct today via two constraints; changing it
  means dropping and recreating `mentions_location_same_org`, which the
  execution harness names as a proof target. Not worth the risk for tidiness.
- **Optimistic concurrency on location edits.** `locations.update` is
  read-then-write; the loser of two simultaneous edits is not told. Same
  position `brand_voice_profiles` is in. A `revision` column is the fix.
- **Per-location brand-voice override** (D61 left the shape open) and a
  **`phone` column on `locations`** (workflow 02's strongest unavailable
  location-matching signal). Both would surface on the new location screen;
  the second changes the matcher's weights, so it is not a form field alone.
- **Restoring a hard-delete path for locations.** Policy dropped and privilege
  revoked deliberately.
- **Organization-switch destination beyond `/overview`** (D194).

### 6.1 SEC-1 — Cross-tenant foreign-key closure (named security follow-up)

Not a deferred nicety and not a gap-list entry. The still-defective foreign keys
in §4 are places where the database permits a row in organization A to reference
a row in organization B; today each is held only by application scoping. **This
workflow changes the risk profile, which is why it gets a name and a
priority.** Until now, one account belonging to two organizations was an edge
case — the seed has exactly one such user and the product had no way to create
another. After this workflow, holding memberships in several organizations and
switching between them is ordinary product behaviour, so "a request carrying
organization A's scope while the caller also legitimately holds ids from
organization B" stops being unlikely and starts being routine.

| Priority | Foreign keys | Blast radius if the application guard is ever missed |
| --- | --- | --- |
| **P1** | `mentions.platform_connection_id`, `platform_profiles.platform_connection_id` | A mention or profile attributed to another tenant's connection. Connection rows drive credential lookup and sync targeting; misattribution here is the closest any of these gets to the credential boundary. |
| **P1** | `mentions.monitoring_query_id` | A news mention attributed to another tenant's monitoring query, and therefore surfaced in their poll history and rejection diagnostics. |
| **P2** | `response_drafts.mention_id`, `approvals.response_draft_id` | A draft or an approval decision recorded against another tenant's mention — customer-facing text in the wrong approval queue. |
| **P3** | `platform_sync_runs.platform_connection_id` / `platform_profile_id`, `news_poll_runs.monitoring_query_id`, `news_rejected_candidates.*` | Diagnostic history attributed to the wrong tenant. Misleading rather than harmful, but it is the evidence trail operators reason from. |
| **P3** | `mention_analyses.analysis_run_id` | Run attribution. Run ids are internal and unreachable from a request path today. |

**Exit criteria for SEC-1:** every P1 and P2 row is either composite or has a
written decision explaining why it cannot be, with a hosted preflight run and a
harness assertion apiece — the same treatment the four closed here receive.
Recorded in `docs/architecture/current-state.md` under a heading that reads as
an open security item, not as a gap. Each is `not null`, so the fix is a plain
composite FK with no `SET NULL` clause; what makes them a separate pass rather
than a widening of this one is that each touches an ingest or approval path with
its own test surface, and several have never run against real Google.

---

## 7. Risks

| Risk | Why it is real here | Mitigation |
| --- | --- | --- |
| **A location commits without its mapping.** The whole point of D200. | Two writes that must both land, in a codebase whose repository layer has no transaction (D17). | One function body is one transaction; the location insert, the profile bind, and three audit inserts all discard together. T-23 and T-24 assert no orphan location survives an injected failure. |
| **Two concurrent submissions mint two locations for one listing.** | The setup screen is re-renderable and re-submittable, and serverless means two clicks are routinely two processes. | Upsert-and-lock on the profile's natural key, `order by id for update`, replay arm returning the bound location. Proven by a two-session FIFO race script, not a sequential test. |
| **Dropping and recreating `provision_organization` loses privileges silently.** | New functions get `PUBLIC` plus Supabase's grants to `anon`, `authenticated`, `service_role`. This is exactly how G22 happened, and `20260807000600` exists because it happened twice before. | Explicit revoke from all three, explicit grant to `authenticated`, owner captured and reapplied, and T-21 reading `has_function_privilege` directly rather than trusting the migration. |
| **The idempotency race is not reproducible sequentially.** | The first draft's T-14 was sequential and would have passed a read-then-insert implementation — the bug it existed to catch. | Two psql sessions over FIFOs, with `pg_stat_activity` proving the parked session is genuinely parked. |
| **A composite `ON DELETE SET NULL` fails on `organization_id`'s `NOT NULL`.** | Without the column list, membership and location deletion raise `23502` — and only when somebody actually deletes, which no test does by accident. | Column-specific `SET NULL` (D206) plus harness assertions that perform the deletion and inspect the surviving row. |
| **`ON DELETE SET NULL (column)` needs PostgreSQL 15.** | A migration that parses locally and fails on hosted is discovered mid-push. | Version assertion inside the migration; `show server_version` in the hosted preflight. |
| **Adding a composite FK to a table with existing violations fails mid-deploy.** | `platform_profiles`, `monitoring_queries`, and `mentions` have never had this constraint; hosted data has never been checked. | Read-only violation counts against hosted **before** the migration is written, and preflight `DO` blocks inside each migration. |
| **Rollback after a one-shot deploy has no safe side.** | Database and application deploys are not one atomic operation, and the contraction migration blocks the previous application's mapping path. | Expand-contract across three releases (D209), with written rollback for each phase and a compatibility gate between R1 and R2. |
| **Active-organization selection silently regresses.** | The `available[0]` fallback makes almost every selection bug invisible for single-organization users — how G4 survived. | Every selection test uses `USER_DANIEL`, for whom `available[0]` is the *wrong* answer. |
| **Invitation acceptance lands in the wrong tenant.** | Silent; reads as "the invitation did not work". | Cookie write inside both acceptance paths (D193), pinned by criterion 5. |
| **The audit drift-guard blocks a half-finished change.** | It has caught this three times. | B1 and A4 land in one commit. |
| **The dirty worktree.** Uncommitted GBP work sits on `master` right now, touching `enums.ts`, `labels.ts`, and the GBP doc this workflow also edits. | A stash, reset, or careless commit destroys work this plan did not author — and `git status --short` cannot detect a content change that leaves the path list identical. | A separate git worktree from a recorded base commit, plus a content fingerprint (diff hash + untracked manifest hashes) captured in A00 and re-verified in F2. |

---

## 8. Decision delta

| Decision | First draft | After round 1 | After round 2 | Driver |
| --- | --- | --- | --- | --- |
| D195 | `CREATE OR REPLACE` + a fifth parameter, sixth appearing mid-body; read-then-insert replay | `DROP … RESTRICT` + one canonical six-argument function; atomic `ON CONFLICT … DO NOTHING RETURNING` with actor-scoped fallback; `p_source` validated | unchanged | R1 |
| D200 | `locations_insert` open to comms leads while the product claimed owner/admin | `create_location_for_mapping` — narrow, but create-only | **`create_and_map_location`** — takes the profile set, upserts and locks it, verifies connection and organization, replay-or-conflict, binds before commit, writes all three audit events; no second application binding step | R1, **R2** |
| D201 | `(manager_user_id, organization_id)` → `memberships (user_id, organization_id)` + a new reversed unique; plain `set null` | existing key order `(organization_id, manager_user_id)`; no new unique; `set null (manager_user_id)` | unchanged | R1 |
| D202 | `inactive` gates Google review sync; Stage E2 edits the Google service | lifecycle and reporting only; Stage E2 removed; unified pause deferred | unchanged | R1 |
| D204 | `location.updated` on any non-status field | excludes `status` **and** `managerUserId`; field partition as one named constant | unchanged | R1 |
| D206 | — | column-specific `ON DELETE SET NULL`; superseded simple FKs dropped by resolved name; PG ≥ 15 asserted | unchanged | R1 |
| D207 | — | trigger enforcing active membership on assignment only | + revoked from all four roles, with the trigger's continued firing **proven** by T-9a after the revoke rather than asserted from documentation | R1, **R2** |
| D208 | G20 deferred | closed here; catalog-driven inventory with per-row verdicts | + the still-defective set becomes **SEC-1**, a named and prioritized security follow-up with exit criteria (§6.1) | R1, **R2** |
| D209 | "push immediately before or at deploy" | unchanged | **replaced** by expand-contract: three releases, five migrations, written rollback per phase, compatibility gate between R1 and R2 | **R2** |
| D210 | revoke `public` only | revoke `public`, `anon` | **+ `service_role`**, on both RPCs, with T-21 asserting it; trigger function revoked from all four | R1, **R2** |
| Criterion 7 proof | source-text assertion | browser flow; source assertion demoted to a static guard | unchanged | R1 |
| Demo parity | unstated | demo `provision` emits `organization.created` once, only when it wins | + demo `createAndMapFromIntegration` mirrors the whole create-and-bind contract including the profile write and all three audit rows | R1, **R2** |
| Dirty-tree guard | "branch before touching anything" | worktree + `git status --short` recorded | **content fingerprint**: `git diff --binary` hash, untracked manifest with per-file hashes, HEAD and branch; re-verified in F2, Git metadata excluded | R1, **R2** |
