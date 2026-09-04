# Repository audit

Audit of the `laurenproctor/Lia-Bond` GitHub repository — branches, pull
requests, CI, dependencies, and process — as of 2026-09-04.

## What is working

| Signal | State |
| --- | --- |
| Default branch protection | `master` is protected |
| Merge gate | `verify.yml` runs two jobs (`verify`, `database`); both green on the current head |
| Workflow history | 96 runs; the latest run on `master` succeeded in both jobs |
| Pull requests | 51 opened, 48 merged, all through PRs rather than direct pushes |
| Open PRs / open issues | 0 / 0 |
| Commit messages | Consistently excellent — they record the reasoning, the rejected alternatives, and what was actually verified |

The `database` job is unusually good for a project this size: it starts a real
Supabase stack and runs seven SQL harnesses against freshly migrated Postgres.
That job has already earned its keep — PR #50's own commit message records it
catching a live security hole (definer functions still reachable through the
implicit `PUBLIC` execute grant) and a runtime enum-cast bug, neither of which
any TypeScript test could have found.

## Findings

### 1. The billing SQL harness is never run by CI — High

`package.json` defines eleven `db:verify-*` commands. `verify.yml` wires seven
of them. The one it does not wire is `db:verify-billing`, and billing is the
newest, most recently changed, and most financially sensitive subsystem in the
repository: Stripe subscriptions, trial eligibility, and location capacity.

This is a repeat of a failure the project has already diagnosed once. PR #48's
commit message says, of the widget harness:

> `db:verify-review-widget` has been a local-only command since the review
> widget shipped, so the SQL mirror of its eligibility predicate has never run
> in CI.

That gap was closed for the widgets and reopened for billing three days later.
The consequence is specific rather than theoretical: trial eligibility is
enforced by a **check constraint**, and capacity by a **trigger**. Neither is
reachable from vitest. `billing-verification.sql` is the only thing that
executes them, and nothing runs it automatically.

Verified during this audit: the harness passes 38/38 against a fresh database,
so wiring it is a low-risk change.

**Recommendation.** Add a `db:verify-billing` step to the `database` job,
alongside the seven already there.

### 2. A live product-accuracy fix is stranded on an unmerged branch — High

`claude/reddit-api-rejection-nwcke0` holds one commit — *"fix(site): stop
selling Reddit monitoring the product cannot do"* — touching 11 files and
adding a 137-line guard test. It is **50 commits behind `master`** and has no
pull request.

The problem it fixes is still live on `master`:

- Reddit is named as a monitored platform in **seven** marketing surfaces
  (home hero, product page ×2, pricing FAQ, `home.ts`, `industries.ts` ×2).
- `src/lib/site/content/platforms.ts` still carries Reddit with
  `available: true` and the note *"Lia drafts a reply for you to post from
  your own account."*
- Meanwhile Reddit's API application was rejected, and
  `resolveRedditDeployment()` defaults to `off` — there is no code path behind
  any of those claims.

The file's own header comment cites CLAUDE.md rule 6 ("never imply a capability
the source does not support") and warns about this exact drift. The data
contradicts the comment sitting above it.

The branch also makes `PlatformRow.available` load-bearing — on `master` the
field is declared and read by nothing, which is *why* the table could hold the
honest answer while the page contradicted it.

**Recommendation.** Decide it, either way, this week. Rebase and merge it, or
delete the branch and fix `master` directly. Leaving it is the worst option:
it drifts further behind every day, and the inaccurate copy stays published
meanwhile.

**Resolved.** Carried across onto this branch rather than merged as it stood —
three later commits had rewritten the copy it touches, and a clean auto-merge
silently reverted them. See the commit for the specific reconciliations. The
original branch is now redundant and can be deleted.

### 3. Four high-severity dependency vulnerabilities, and nothing watching — High

`npm audit --omit=dev` reports 4 high-severity advisories in production
dependencies: `sharp` below 0.35.0 inheriting four libvips CVEs
(CVE-2026-33327, -33328, -35590, -35591), reached through `next`. A fix is
available — `next` 16.2.12 → 16.3.4.

There is no `.github/dependabot.yml`, so nothing opens these as PRs and nothing
would have surfaced them. `@supabase/supabase-js`, `stripe`, `@supabase/ssr`
and `eslint-config-next` are also behind within their existing ranges.

**Recommendation.** Bump `next`, then add a `dependabot.yml` (weekly, grouped
minor/patch). The audit gate itself is worth adding to `npm run verify` only
if you are willing to have a new advisory block merges — otherwise Dependabot
alone is the right level.

### 4. The `database` job's required-check status is unconfirmed — Medium

`verify.yml` carries this note:

> Runbook (owner action, tracked separately): once this workflow is green on
> `master`, mark the `database` job a required status check in branch
> protection so a TypeScript matrix change can never merge with stale SQL
> behavior.

The API confirms `master` is protected but does not expose which checks are
required, so I could not verify this from here. It is also not "tracked
separately" anywhere I can find — the repository has never had an issue (see
finding 6).

**Recommendation.** Confirm in Settings → Branches whether `database` is
required. If it is not, make it so; the job takes seven minutes and is the only
thing standing between a schema change and a silent behavioural regression.

### 5. Process depends on a single person, with CI as the only reviewer — Medium

All 51 pull requests were authored, approved, and merged by the same account.
That is normal for a solo project, and worth naming because of what it implies:
**CI is the only reviewer this repository has.** Every finding above about a
missing check is therefore a finding about the only review mechanism in place.

Three PRs (#7, #12, #20) were closed without merging and without a recorded
reason. #12 in particular was *"ci: verify + database harness as merge gates"* —
the work landed by another route, but nothing in the PR says so.

**Recommendation.** No process ceremony for a team of one. Do close the loop on
findings 1 and 4, since they are the review capacity you actually have.

### 6. The issue tracker has never been used — Medium

Zero issues, ever. Decisions and open items live in commit messages and in
`docs/architecture/current-state.md` as D-numbers. That is genuinely good
documentation, and it is not a work queue: it cannot carry an owner, a state,
or a due date, which is exactly why the "tracked separately" runbook item in
finding 4 is tracked nowhere.

**Recommendation.** Open issues for the deferred items already written down in
comments — the required-check runbook, the Postgres 17.6 CLI pin and its
segfault workaround, the Reddit reapplication decision, and Stripe live-mode
verification (which `docs/billing.md` explicitly lists as never run).

### 7. Repository hygiene files are absent — Medium to Low

No `LICENSE`, `SECURITY.md`, `CODEOWNERS`, PR template, or issue templates.

`CODEOWNERS` is not worth adding for one maintainer. The absence of a `LICENSE`
means default copyright — all rights reserved — which is probably intended for
a commercial product, but it should be a decision rather than an omission. A PR
template would be the one with real value here, because it could carry the
deploy runbook's step 0 (the migration-collision check that PR #50 credits with
catching a shipped-broken state).

### 8. Stale branches accumulate — Low

Seven merged branches remain: `copy-live-in-minutes`,
`google-quota-not-provisioned`, `press-widget`,
`review-widget-layout-carousel`, `reviews-empty-state`,
`website-widgets-layout-carousel`, plus older ones.

**Recommendation.** Enable "Automatically delete head branches" in repository
settings, then delete the existing seven. This also makes finding 2 visible:
once merged branches disappear on their own, a branch that is still there is a
branch with unmerged work in it.

### 9. Two weeks of no activity — Low, context only

The last commit to `master` is 2026-08-21; today is 2026-09-04. Not a defect,
but it is the reason findings 2 and 3 have gone unnoticed: the Reddit copy has
been inaccurate and the advisories unpatched for that whole window.

## Suggested order

1. Wire `db:verify-billing` into CI (finding 1) — one file, closes a known gap.
2. Decide the Reddit branch (finding 2) — inaccurate published copy.
3. Bump `next`, add Dependabot (finding 3).
4. Confirm `database` is a required check (finding 4) — owner action.
5. Open issues for the deferred items (finding 6); enable branch auto-delete (8).

Findings 5 and 7 are judgement calls about how much process a one-person
project should carry, and are worth a decision rather than a default.
