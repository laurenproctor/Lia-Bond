# Database audit

Audit of the Postgres/Supabase schema under `supabase/`, performed by executing
every migration against a real PostgreSQL server rather than by reading the SQL.

**Method.** A Supabase-equivalent bootstrap (roles `anon`/`authenticated`/
`service_role`, the `auth` and `storage` schemas, and — critically — the
project-level `alter default privileges ... grant all ... to anon, authenticated,
service_role` that Supabase ships) was applied to an empty database, followed by
all 74 migrations in filename order, then `supabase/seed.sql`, then each
verification suite against a freshly rebuilt database.

**Caveat.** The run used PostgreSQL 16.13; `supabase/config.toml` pins
`major_version = 17` and CI pins 17.6. Nothing observed depends on 16-vs-17
behaviour, but the results are one minor version off the target.

## What holds up

| Check | Result |
| --- | --- |
| Migrations applied from scratch | 74 / 74 clean |
| Files parsed by `npm run db:validate` | 78 / 78 |
| Assertions in the CI chain (rls + execution + matrix-parity) | 609 pass |
| Suites run individually on a fresh DB | execution 201, tenancy 87, generation 85, reddit 50, press-widget 40, billing 38, yelp 33, review-widget 22 — all green |
| Tables with RLS enabled | 39 / 39 |
| `security definer` functions pinning `search_path` | 41 / 41 |
| `security definer` functions revoked from `anon` | 31 / 41 (the other 10 are deliberate or inert — see below) |
| Generated SQL artifacts | `seed.sql` and `matrix-parity.generated.sql` regenerate byte-identical; the audit vocabulary is pinned to `AUDIT_EVENT_TYPES` by `tests/audit-vocabulary-migrations.test.ts` (3 passing) |
| Integrity surface | 176 check constraints, 31 enums, 27 triggers, 163 indexes |
| TypeScript suite (`npx vitest run`) | 2956 tests / 149 files, all passing |

Note that `npm run audit:vocabulary:generate` is a repair tool, not an idempotent
regenerator: it emits a *new* dated migration every time it runs, because Postgres
cannot extend a check constraint. Drift there is caught by the test above, not by
regenerating and diffing.

An empirical probe as `anon` against the seeded database read **0 rows** from
`platform_connection_secrets`, `mentions`, `users`, `organizations`,
`organization_billing` and `audit_events`; `delete from mentions` and
`update organizations` each affected 0 rows, and an `insert` was refused by the
policy. The tenant boundary is real, not merely declared.

The 10 `security definer` functions reachable by `anon` are accounted for:
`review_widget_render` / `press_widget_render` / `invitation_preview` /
`accept_invitation` are the intended public entry points; `is_organization_member`
/ `has_organization_role` / `can_write_in_organization` return false when
`auth.uid()` is null; and the three trigger functions refuse direct invocation
(`trigger functions can only be called as triggers`, verified).

This is a well-tested schema. The findings below are hardening and scale work,
not defect reports.

## Findings

### 1. `pgcrypto` is installed into `public`, and nothing uses it — Medium

`20260801000100_initial_schema.sql:7` runs `create extension if not exists
"pgcrypto";` with no schema, so it lands in `public`. Because `public` is a
PostgREST-exposed schema (`config.toml: schemas = ["public", "graphql_public"]`)
and Supabase's default privileges grant `execute` on new functions to `anon`,
this publishes ~36 extra unauthenticated RPC endpoints — including `crypt` and
`gen_salt`. `crypt(x, gen_salt('bf', 31))` is deliberately expensive, which makes
it a CPU-amplification vector reachable without a session.

The only pgcrypto function referenced anywhere in the repository is
`gen_random_uuid()` (35 call sites), and that has been **core PostgreSQL since
13** — this project targets 17.

Verified: dropping the extension leaves `gen_random_uuid()` working, drops the
`anon`-callable function count from 49 to 13, and leaves the RLS suite passing.

**Recommendation.** Add a migration that drops the extension. It is the rare
change that removes attack surface and dependency at zero cost.

### 2. The schema is default-open, and closes only by explicit revoke — Medium

35 of 39 tables still grant `select, insert, update, delete` to `anon` at the
table-privilege level; only `review_widgets`, `press_widgets`,
`stripe_webhook_events` and `reddit_rate_limit_state` have had those privileges
revoked. This is inherited from Supabase's project-level default privileges, and
the migrations are visibly aware of it — several carry comments explaining the
revoke they perform.

Today this is safe: RLS closes every one of those tables, as the probe above
confirms. The concern is structural. The safety of 35 tables rests entirely on
RLS being correct forever, and **a new table added without an explicit revoke is
exposed by default** — including tables whose only protection is having no
policies at all (`platform_connection_secrets`, `oauth_states`,
`contact_messages`, `early_access_requests` all currently sit in that state, with
full `anon` privileges and zero policies).

**Recommendation.** Two steps, in order:

1. A migration revoking all privileges on all `public` tables from `anon`, then
   re-granting only where a public path genuinely needs it. Defence in depth
   behind RLS rather than instead of it.
2. More valuable: a CI assertion in the SQL harness that **fails when any table
   grants `anon` a privilege outside a named allowlist**. That converts a
   standing invariant into something a pull request cannot quietly break, which
   is the same technique the repository already uses well elsewhere.

### 3. `monitoring_queries` has no index leading with `organization_id` — Medium

Its three indexes are on `(id)`, `(enabled, last_polled_at) where enabled`, and
`(id, organization_id)`. Every RLS-filtered read is scoped by `organization_id`,
and none of these serve that. Compare `mentions`, which carries 17 indexes with
org-leading composites throughout — the discipline is clearly understood here and
simply did not reach this table.

**Recommendation.** `create index monitoring_queries_org_idx on
public.monitoring_queries (organization_id, enabled);`

### 4. 53 foreign keys have no supporting index — Low to Medium

Most are the composite tenant-integrity constraints
(`execs_mention_same_org`, `mentions_location_same_org`, …) that exist to enforce
that a child row cannot reference a parent in another organization. They are
never traversed in the indexed direction, so the cost is confined to updates and
deletes of the parent row, which the schema largely forbids anyway (locations are
never hard-deleted; `delete` is revoked from `authenticated`).

**Recommendation.** Do not index all 53. Index the ones on hot or growing paths —
`news_rejected_candidates.organization_id`, `reddit_query_matches.organization_id`,
`platform_sync_runs.platform_connection_id`, and the `yelp_activity_occurrences`
snapshot references — and leave the rest documented as intentional.

### 5. Four policies call `auth.uid()` unwrapped — Low

`users_select_self_or_co_member`, `users_update_self`, `invitations_insert_admins`
and `execs_select_location_manager` call `auth.uid()` directly, so it is
re-evaluated per row instead of once as an InitPlan. The other 80 policies avoid
this by going through the helper predicates.

**Recommendation.** Wrap as `(select auth.uid())`. Mechanical, and it is the
documented Supabase idiom.

### 6. RLS helper predicates are per-row by construction — Low, watch item

`is_organization_member(organization_id)` and friends are `stable security
definer` and take the row's own column, so they cannot be hoisted to an InitPlan
and run once per candidate row. They are well supported by
`memberships_unique_user_per_org (organization_id, user_id)`, so each call is a
cheap index probe, and this is the standard Supabase pattern.

**Recommendation.** No change now. If mention list latency degrades at scale, the
lever is to rewrite the hot policies as set membership —
`organization_id in (select organization_id from memberships where user_id =
(select auth.uid()) and status = 'active')` — which evaluates once per query.

### 7. A stale comment misstates the project's own test posture — Low

`scripts/validate-migrations.mjs` states that "this repository's migrations have
never been executed against a server." That has not been true since
`.github/workflows/verify.yml` added the `database` job, which runs the whole
harness against a live stack on every pull request. A new contributor reading
that comment would substantially undersell the safety net they have.

**Recommendation.** Correct the comment to say what the parse adds *on top of* the
executed harness — it is fast, runs without Docker, and catches syntax before CI.

### 8. The CI Postgres pin is a documented hazard — Low, tracking item

`verify.yml` pins Supabase CLI 2.101.0 / Postgres 17.6 and explains at length
that this combination segfaults the cluster on an `execute`-denied call of a
non-immutable function after `set role`, with the harness written to route around
the crash rather than fix it. That is honest and well documented, but it is a pin
the project cannot move without redoing that analysis, and it will age.

**Recommendation.** Track it deliberately — an issue with the reproduction
recorded — rather than letting the comment be the only memory of it.

## Suggested order

1. Drop `pgcrypto` (finding 1) — smallest change, largest surface reduction.
2. Add the `anon`-grant CI assertion (finding 2, step 2) — locks the invariant
   before the table count grows further.
3. Add the `monitoring_queries` index and the short list from finding 4.
4. Wrap the four `auth.uid()` calls; fix the stale comment.
5. File the Postgres pin as a tracked item.

Findings 2 (step 1) and 6 are judgement calls about posture rather than defects,
and are worth a decision rather than a default.
