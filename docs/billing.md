# Billing

Stripe subscription billing, a 14-day card-required trial, and purchased
location capacity.

Companion documents:

- `docs/billing-stripe-runbook.md` — the Dashboard steps, done twice (sandbox
  and live), and what is owner or accountant work rather than engineering work.
- `src/lib/pricing/schedule.ts` — the rate card itself, which this feature
  reads rather than restates.

---

## 0. The one idea

**Stripe owns money. Lia owns access. One pure function translates.**

Every Stripe-derived column in this schema is a *projection* — a copy of an
object Lia re-retrieved from Stripe's API after a signed webhook said something
had changed. None of it is authoritative, none of it is written from a browser
request, and no screen, redirect, or client-supplied value ever grants access.

What an organization may actually *do* is decided by one pure function,
`resolveEntitlement`, from that projection plus a rollout flag. It has no I/O,
no framework imports, and no clock of its own, so every state it can produce is
reachable from a unit test rather than only from a Stripe account in the right
condition.

Everything below follows from those two sentences.

---

## 1. The commercial model, and where it lives

Lia's rate card is **graduated**, the way tax brackets work: a location is
charged at the rate of the band it falls in, and an eleventh location does not
reprice the ten below it.

| Band | Per location, per month |
| --- | --- |
| Location 1 | $59 |
| Locations 2–10 | $49 |
| Locations 11–25 | $44 |
| Locations 26–50 | $39 |
| Locations 51–100 | $34 |
| 101+ | Quoted |

Annual billing charges **ten months**, not twelve — the two free months are the
whole discount, and `ANNUAL_MONTHS_BILLED` is the only place that number
appears.

So: one location is $59/month or $590/year. Two are $108/month or $1,080/year.
Ten are $500/month or $5,000/year. A hundred are $3,835/month or $38,350/year.

### One declaration, two readers

`src/lib/pricing/schedule.ts` is the source of truth, and both the marketing
page and the Stripe catalog read it. That is not tidiness — it is the only
defence against the failure mode that matters here, which is a price quoted on
a page and a different price charged to a card. Nobody notices that until a
customer reconciles an invoice.

`tests/billing-catalog.test.ts` walks Stripe's tier table the way Stripe walks
it and compares the result against the page's own arithmetic **at every group
size from 1 to 100, in both intervals** — two hundred independent comparisons,
plus literal assertions on the figures the runbook asks an operator to check by
eye. Two implementations agreeing beats one agreeing with itself.

### The tier Lia can never reach

Stripe requires the last tier of a tiered price to be unbounded (`up_to:
"inf"`). Lia's schedule is not unbounded — above 100 locations the price is
quoted, not listed. Those two facts cannot both be expressed in one price, so
the catalog closes with an `inf` tier at the lowest listed rate and **Lia
refuses to sell into it**, in four places:

- the Checkout action (`isSelfServiceQuantity`),
- the capacity action (the same predicate),
- the `purchased_location_quantity` check constraint (`between 1 and 100`),
- and the capacity trigger on `locations`.

Stripe's job is to price a quantity, and it will price any quantity correctly.
Deciding that a hundred-and-first location is a conversation rather than a
transaction is a commercial rule, and commercial rules live in Lia.

---

## 2. Two ways to buy

| | Immediate | Card-required 14-day trial |
| --- | --- | --- |
| Checkout | `mode=subscription` | `+ trial_period_days=14` |
| First status | `incomplete` → `active` | `trialing` |
| Money moves | At Checkout | On day 14 |
| Access granted on | `invoice.paid` + `active` | `subscription.created` with `trialing` |
| Eligibility | Always | `trial_eligible` on the projection |

**The server decides which.** The browser sends a billing period and a number
of locations. It cannot send `trialDays`, `trialEligible`, `trialEnd`, a price
id, a customer id, a subscription id, or an organization id — and
`startCheckoutInputSchema` is `.strict()`, so a payload carrying one of them is
*rejected* rather than silently ignored. That distinction is the difference
between "we did not read that field" and "we noticed you sent it".

`payment_method_collection` is `always`, including for trials. A card-required
trial is the v1 design, and `if_required` would silently make it cardless.

### Cardless trials, and why they are not built

A cardless trial converts worse and is abused more, and it needs an entire
payment-collection workflow that does not exist here — `trial_will_end` →
notify → portal → resume. If it is ever adopted, use
`trial_settings.end_behavior.missing_payment_method = pause` rather than
`cancel`: pause keeps the subscription so the same one resumes when a card
arrives, and the entitlement matrix already maps `paused` to read-only.
`cancel` throws away the record and makes "did they ever trial?" harder to
answer. Limit it to invitation or sales-issued offers.

---

## 3. Where Checkout sits

**After onboarding, as a separate activation gate. Not a sixth step, and not
before.**

Onboarding stays five steps plus the Workspace Ready screen, exactly as
`CLAUDE.md` and `docs/onboarding.md` fix it. Four reasons, in order of weight:

1. **The quantity is unknowable before step 3.** Locations are mapped from
   Google or typed by hand at step 3. Asking for a location count before
   onboarding asks the customer to guess a number they are about to discover.
2. **A trial must not burn during administrative setup.**
   `docs/onboarding.md` §4 records that setup "is not a single sitting" — it
   involves an OAuth round trip and people routinely start on a laptop and
   finish on a phone. Starting a 14-day clock at the front of that spends the
   trial on configuration.
3. **A sixth step is expensive and contradicts the documented design.** It
   would touch `ONBOARDING_STEPS`, the `onboarding_step` Postgres enum,
   `firstIncompleteStep()`, the prerequisites table, and both route guards —
   which are load-bearing precisely because they point in opposite directions
   and cannot loop.
4. **The Ready screen has a job.** §11 makes it a quick-win hierarchy: "the
   point of the screen is the first thing worth doing next." A paywall there
   displaces the one thing it exists to do.

The tradeoff accepted: activation is a step a customer can walk past, so
conversion depends on the banner rather than on a wall. That is the right trade
for a product whose value is only visible after reviews have been imported.

`onboarding.manage` is marked as **not** requiring paid access for this reason —
gating it would be a deadlock, not a policy: an organization that could not
finish onboarding without paying could never reach the screen that asks it to
pay.

---

## 4. The schema

Two tables. `20260821000400_billing.sql`, `…000200_billing_rls.sql`,
`…000300_billing_functions.sql`, `…000400_billing_audit_vocabulary.sql`.

### `organization_billing`

One row per organization, primary-keyed on `organization_id` — the same shape
as `organization_onboarding`, and for the same reason: "one subscription per
organization" stops being a rule the application has to remember and becomes
something the schema cannot express otherwise.

It holds **no card, bank, or payment-method data of any kind**. Not a number,
not a fingerprint, not a brand, not an expiry, not a payment-method id. Lia has
no use for any of it, and holding it would put this schema in scope for
obligations it is nowhere near ready for.

Four constraints carry the invariants:

| Constraint | Prevents |
| --- | --- |
| `organization_billing_trial_is_once` | A second free trial. A row with `trial_started_at` cannot be `trial_eligible`. |
| `organization_billing_trial_pairing` | A trial nobody can date or attribute. |
| `organization_billing_subscription_pairing` | A half-projected row — a status with no period, a price with no quantity. |
| `organization_billing_disposition_expiry` | An expiry on `standard`, which would read as paid access running out. |

**The trial constraint is the most important line in the schema.** Cancelling,
replaying a webhook, deleting and recreating a Checkout Session, and restoring
a backup all leave `trial_started_at` set, so none of them can restore
eligibility. Only `grant_billing_trial()` can, by clearing the start date, and
it is service-role only and always audited.

### `stripe_webhook_events`

`stripe_event_id text primary key` — **deduplication is the primary key**, not
a check somebody has to remember. Two concurrent deliveries race on a unique
index and exactly one wins.

No tenant column, deliberately: an event arrives before the organization is
known, which is the whole job of resolving one. `oauth_states` is not
organization-scoped for the same reason.

Never stored: request bodies, card or bank details, payment-method payloads,
Stripe secrets, or provider error text. `error_category` is a Lia-authored word
from a closed list — the rule `docs/architecture/current-state.md` already
states for GNews and Anthropic, applied where breaking it would be a compliance
incident rather than an embarrassment.

### Row-level security

Both tables are **unwritable through a session**, which is a departure from
every other configuration table in the schema and a deliberate one. Neither
holds configuration: one holds what Stripe told Lia, the other holds what
Stripe sent. A member who could `update` either could grant themselves the
product — one statement setting `subscription_status` to `active`, or
`trial_eligible` back to true, and the entitlement function would hand over
full access with nothing amiss anywhere in the trail.

| Table | `authenticated` |
| --- | --- |
| `organization_billing` | `select` only, `is_organization_member`. Insert/update/delete revoked. |
| `stripe_webhook_events` | RLS on, **zero policies**, all grants revoked from `authenticated` **and** `anon`. |

Read is deliberately not narrowed to the `billing.manage` roles: the trial
countdown and the payment warning render in the app shell for every signed-in
person, and an analyst about to lose write access on Thursday is entitled to
know why.

### The functions, and why they are functions

Writes go through `SECURITY DEFINER` functions because **a function body is a
transaction, and it is the only place this codebase has that guarantee** (D17).
The Supabase client cannot express "write the projection, mark the event
processed, and record the audit entry, or do none of them" — and that is
exactly the guarantee a webhook needs. An event marked processed before its
effects are durable is an event Stripe will never send again and Lia will never
have acted on: a silent, permanent divergence that no retry can repair.

> **Every revoke list includes `public`.** Postgres attaches an implicit
> `EXECUTE` grant to `PUBLIC` on every new function, and Supabase's bootstrap
> adds a second explicit grant to `anon` and `authenticated`. Revoking only the
> latter pair leaves the function callable over PostgREST with no session at
> all. The first draft of this feature had exactly that hole —
> `apply_stripe_billing_projection` was reachable by anyone holding the anon
> key, who could have granted their own organization a subscription. Section 6
> of the verification harness is what caught it. This is the same gap
> `20260807000600` fixed for the OAuth helpers.

---

## 5. Entitlement

| Stripe state | Access | What the customer sees |
| --- | --- | --- |
| no subscription, not enforced | full | Activation invitation |
| no subscription, enforced | read-only | "Choose a plan" |
| `trialing` | full | Countdown, trial end, first charge date and amount |
| `active` | full | Renewal date and amount |
| `past_due` | **full + warning** | Payment banner. No Lia-invented deadline. |
| `incomplete` | **full + warning** | "One more step" + recovery |
| `incomplete_expired` | read-only | Start again |
| `unpaid` | read-only | Payment recovery |
| `canceled`, trial never converted | read-only | "Nothing was charged" |
| `canceled`, period still running | full until that date | "Access continues until…" |
| `canceled`, period ended | read-only | — |
| `paused` | read-only | "Add a payment method to resume" |
| non-standard disposition | full | "Complimentary access until…" |

`past_due` keeps working on purpose. Stripe's Smart Retries decide when
recovery is over and then move the subscription to `unpaid` or `canceled`
itself; a second, Lia-authored clock would contradict it, and the copy
therefore names no cut-off date because Lia does not know one.

### What read-only means

**Still available**: every read surface, the full audit trail, and
`/settings/billing` and every payment-recovery path — always, in every state.

**Blocked**: response generation and publication, approvals, escalation status
changes, rules, brand voice, monitoring, integrations, manual capture, the
review widget, location creation, invitations.

**Never touched**: memberships stay active, the organization is not deleted,
and no location, review, response, report, rule, or configuration is removed.
The worst outcome this function can produce is read-only, and read-only means
every record the customer ever made is still there and still exportable.

### How it is enforced

`REQUIRES_PAID_ACCESS` in `src/lib/auth/permissions.ts` — a second table beside
the permission matrix, `Record<Permission, boolean>`, exhaustive. A new
permission does not compile until somebody has decided, which is the point: the
failure worth engineering against is a new mutation shipping without anyone
thinking about it.

Five permissions do not require payment, and none is an oversight:

| Permission | Why |
| --- | --- |
| `response.retract` | The emergency stop. A billing problem must never be why a defamatory reply stays up. |
| `integration.disconnect` | Consent being revoked. Consent that can only be revoked by paying first is not consent. |
| `organization.manage_members` | Offboarding is a security act. |
| `onboarding.manage` | Setup precedes the gate (§3). |
| `billing.manage` | An organization that cannot reach its billing cannot fix what is blocking it. |

`billing.manage` is held by **owners and admins**. Nothing in the permission
table is owner-only today, and a single unavailable owner must not mean a
company that cannot pay its bill — the judgement `response.retract` already
records, applied to money instead of roles.

---

## 6. The webhook

`POST /api/webhooks/stripe`. Sessionless — Stripe carries a signature, not a
cookie — which makes it the second write path where RLS is not the backstop
(the first being cron, D88), so it carries its own tenancy discipline.

```
raw body (request.text(), before anything parses it)
  ├─ bad/missing signature ────► 400, nothing stored
  ├─ livemode ≠ key mode ──────► 400, ALERT, nothing stored
  ▼
claim_stripe_webhook_event()
  ├─ already processed ────────► 200  (Stripe stops retrying)
  ├─ in progress ──────────────► 409  (retry later, then sees a duplicate)
  ▼
unknown but verified type ─────► mark ignored, 200
  ▼
resolve tenant by stripe_customer_id      (metadata compared, never trusted)
  ▼
re-retrieve the subscription from Stripe
  ▼
apply_stripe_billing_projection()   ← projection + audit + event, ONE transaction
  ▼
200
```

Three properties this is arranged around:

**An event is never acknowledged before its effects are durable.** Marking
processed happens inside the same transaction as the projection. A crash
between the two is not a state this code can reach, because there is no
"between".

**The event says what changed; Stripe says what is true.** Every
subscription-bearing event triggers a fresh `retrieveSubscription`. That is
what makes out-of-order delivery harmless — an `updated` arriving after the
`deleted` that followed it still projects the deleted state, because both
re-read the same current object. There is no ordering assumption anywhere.

**Metadata is correlation, not authorization.** The tenant is resolved by
looking up the Stripe customer in `organization_billing`. `lia_organization_id`
on the event is compared against that answer and a mismatch is refused and
alerted — it never decides anything.

Handled: `checkout.session.completed`, `customer.subscription.created` /
`.updated` / `.deleted` / `.paused` / `.resumed` / `.trial_will_end`,
`invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`,
`invoice.finalization_failed`.

Whether an invoice ends a trial is decided from **Lia's projection**, not the
invoice: a trial-ending charge and an ordinary renewal both carry
`subscription_cycle`, so the payload cannot tell them apart. A trial that
started and has not converted can.

### Two Stripe API traps

The API version is pinned to `2026-07-29.dahlia`, typed as the SDK's own
`LatestApiVersion` so an SDK bump fails to compile rather than silently sending
a version the installed types do not describe. Two field paths moved in Basil,
and both are handled once, in `stripe-gateway.ts`:

- `Subscription.current_period_start`/`_end` **do not exist**. They live on the
  subscription *item*.
- `Invoice.subscription` **does not exist**. It is
  `Invoice.parent.subscription_details.subscription`.

Both failures are silent — the field returns `undefined`, which projects as
"no period" and reads on screen as a subscription that renews never.

---

## 7. Location capacity

**Billable = `status <> 'inactive'`.** Everything except inactive counts:
`setup` is where every location created through the product starts *and stays*
— nothing in the product requires moving it on — so a definition counting only
`active` would bill almost every real customer for nothing.

Enforcement is a **trigger**, not a check in the server action. Three paths can
consume a seat (`createLocationAction`, `createAndMapFromIntegration`,
`updateLocationAction` moving a location off `inactive`), and a check in each
is three chances to forget. More importantly, none of them can be made safe
against concurrency from application code: two requests that both read "4 of 5
used" both proceed, and the organization ends up with 6. The trigger takes
`select … for update` on the billing row, so concurrent writers serialise.

It **fails open** wherever capacity is not a settled question — no billing row,
no purchased quantity, or a non-standard disposition — so organizations that
predate billing and complimentary accounts are unaffected by construction.

### Changing capacity

Always two steps: preview, then confirm. A customer increasing capacity during
a trial is charged nothing today and a larger amount when the trial ends, and
that is a sentence they read before agreeing rather than discover on an
invoice.

**Lia writes nothing.** `changeCapacity` calls Stripe and stops; the projection
lands from `customer.subscription.updated`. That is what makes a Stripe success
followed by a Lia failure a *stale projection* rather than a divergence — there
is no second write to fail. In the opposite direction, the trigger reads Lia's
projection and therefore fails **closed**, blocking creation rather than
granting a free location.

Portal quantity editing stays **off**, so Stripe quantity and the database
limit cannot silently diverge.

---

## 8. Trial abuse

Layered, and each layer is independent:

| Layer | Mechanism |
| --- | --- |
| Schema | The check constraint. Not application logic. |
| Write surface | No repository method sets `trial_eligible = true`. Only `grant_billing_trial()`, service-role, audited. |
| Input | `.strict()` schema; every authoritative value resolved server-side. |
| Duplicate submission | Stripe idempotency key — a double-clicked button returns the *same* session. |
| Duplicate subscription | Projection guard, then a live Stripe read to close the webhook-lag window, then the projection function refusing a second live id. |
| Cancellation | Cannot restore eligibility — the constraint forbids it. |
| Session churn | Eligibility flips on `subscription.created`, not on session creation. |

### What this does not solve

**Organization-level prevention does not solve identity-level abuse.**
`provision_organization` runs for any account belonging to no organization, and
creating an account is free. One person can create N organizations and get N
trials.

Recommended stronger measures, outside v1, in the order I would adopt them:

1. **Connected Google Business Profile identity** — the strongest signal
   available to Lia and nearly free, since a trial is worthless without a
   connected listing anyway and a real listing is much harder to fabricate than
   an email address.
2. **Stripe customer history** — same email or payment-method fingerprint
   across organizations. Stripe computes the fingerprint; Lia would store no
   card data. Worth a lawyer's sentence first.
3. **Verified business domain** on the owner's email.
4. **Manual review** above a threshold.
5. **Sales-issued invitation codes** — the right answer for cardless trials
   specifically, and only those.

---

## 9. Reminders

**Stripe sends the trial-ending email; Lia sends none.** Two systems emailing
about one trial is how a customer gets contradictory dates, and Lia's outbound
mail is paused pending a verified sending domain. Lia shows in-app countdown
states only: nothing for the first week, neutral at seven and three days, amber
on the last day. A strip that is always there is furniture, and furniture is
what people stop reading before the day it matters.

Automatic renewal is disclosed in **every** trial state — card networks require
it, and it is the fact a customer is most likely to feel misled about later.
`tests/billing-view-model.test.ts` asserts it rather than leaving it to review.

---

## 10. Operational runbook

### "A customer says they paid but Lia says no plan"

The webhook has not landed. Check `stripe_webhook_events` for their event id:
`failed` with a category says why; `processing` means it is in flight;
absent means Stripe never delivered. The Stripe Dashboard's webhook log is the
other half. Nothing is lost — run the reconciliation route and the projection
catches up.

### "Reconcile now"

```
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://<host>/api/cron/billing-reconcile
```

Repairs projection fields from Stripe, which owns them. **Never** touches trial
eligibility, trial dates, the access disposition, or anything in Stripe. What
it cannot safely repair — two live subscriptions, a subscription Stripe has
never heard of, capacity below the billable count — it reports and leaves.

Not on a Vercel schedule: the account is on Hobby, which already carries two
crons. Run it after any webhook outage and before enabling enforcement.

### "Somebody needs another trial"

`select public.grant_billing_trial('<org>', 'operator', '<user>', '<why>');`
Service-role only, and it writes `billing.trial_granted` naming who did it. It
clears the start date, which is the only shape the constraint permits.

### "Turn billing off right now"

Set `BILLING_ENFORCEMENT_MODE=off`. Full access returns to every organization
immediately, without cancelling, modifying, or refunding a single Stripe
subscription. It is applied last in `resolveEntitlement` precisely so it can be
reversed without side effects.

It is for deployment safety, not for bypassing payment indefinitely.

### Demo mode

Works with no Stripe configuration at all. `get()` returns null for an
organization nothing has written, enforcement defaults to `off`, and every
Checkout and portal action throws a `ConfigurationError` that renders as "ask
your administrator". Nothing pretends anything has been paid for.

---

## 11. Verifying it

```
npm run lint
npm run typecheck
npm test
npm run build
npm run db:verify-billing     # reset + rls-verification + billing-verification
npm run stripe:catalog        # dry run; --apply to create
```

`SUPABASE_DB_URL` must be exported to the local connection string first — it is
set nowhere in the repository, and two earlier attempts recorded in
`current-state.md` failed for exactly that reason.

### What has been run

- **`supabase db reset`** applied all four migrations cleanly against local
  Postgres.
- **`billing-verification.sql`: 37 checks, all pass.** The trial one-way door
  refuses all three routes round it; the projection function marks the event
  processed in the same transaction as the write; a replayed event cannot move
  a trial's dates; a second live subscription is refused rather than
  overwritten; the capacity trigger refuses the sixth location of five.
- **`rls-verification.sql`: 65 checks, no errors** — unchanged by this feature.
- **2,642 vitest tests**, including the full trial lifecycle against the fake
  Stripe: checkout, conversion, first-charge failure, cancellation, duplicate
  delivery, out-of-order delivery, retried failure.

### What has *not* been run

- **No Stripe sandbox call has ever been made.** Every test runs against
  `mock-gateway.ts`. The catalog script has never created a product or a price.
- **No test clock lifecycle.** The 14-day trial has never actually elapsed;
  the mock advances it instantly.
- **No live-mode anything.**

Those three are the runbook's job and they are gated on a person.

---

## 12. Rollback

| Stage | How to undo |
| --- | --- |
| Enforcement on | `BILLING_ENFORCEMENT_MODE=off`. Instant, no Stripe change. |
| UI released | Revert the commit; the projection keeps updating harmlessly. |
| Webhook live | Disable the endpoint in the Dashboard. Stripe queues and retries for 3 days; reconciliation repairs the gap. |
| Schema | Forward-only. A revert migration drops both tables and the trigger, and **must restate the audit vocabulary without the billing names in the same migration**, or the constraint will reject rows the trail already holds. |

---

## 13. What is not built

Custom payment forms · Stripe Connect · multiple currencies · usage-based or
metered billing · custom or internal invoicing · customer-controlled portal
quantities · automated enterprise pricing above 100 locations · coupons,
promotions, and retention offers · affiliate or reseller billing · **cardless
public trials** · automated tax registration or filing · refunds through the
product · a second subscription per organization · per-location sub-billing ·
proration previews for interval switches (the portal handles those).
