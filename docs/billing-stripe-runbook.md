# Stripe setup runbook

Everything that happens in the Stripe Dashboard rather than in this repository,
plus an explicit split of what is engineering work, what is yours, and what
needs an accountant.

The architecture is in `docs/billing.md`. This document assumes it.

> **Sandbox and live are separate configurations.** Products, prices, portal
> settings, webhook endpoints, branding, and email settings are all per-mode.
> Sections 2 and 3 are done **twice**. A step done once is a step that works in
> testing and is missing in production.

---

## 0. Who does what

| Work | Who |
| --- | --- |
| Migrations, catalog script, webhook, entitlement, UI | Engineering — **done** |
| Creating the Stripe account, business verification, payout bank account | **You** |
| Statement descriptor, branding, support contact details | **You** |
| Running the catalog script; portal configuration; webhook registration | **You**, with the checklists below |
| Deciding tax nexus, registering, filing, remitting | **You + your accountant** |
| Choosing the product tax code | **You + your accountant** |
| Refund and dispute policy | **You** |

Nothing in this repository decides a tax question, and nothing in it should
start to.

---

## 1. Account (live mode only)

- [ ] Create or verify the Stripe account.
- [ ] Complete business verification.
- [ ] Connect the payout bank account; confirm the payout schedule.
- [ ] Set the public business name, support email, support phone, support URL.
- [ ] Set the **statement descriptor** — what appears on a cardholder's
      statement. A descriptor a customer does not recognise is the single
      biggest driver of "I don't recognise this charge" disputes. Max 22
      characters. *Pending your confirmation; `LIA REPUTATION` was proposed.*
- [ ] Upload branding — logo, icon, colours — to match Lia's purple. This is
      what Checkout and the customer portal render, and an unbranded Stripe
      page in the middle of a purchase reads as a phishing attempt.
- [ ] Configure customer emails and receipts.
- [ ] Confirm notification settings for failed payments and disputes.

---

## 2. Catalog (both modes)

The product and its two prices are created by script, not by hand. Six tiers
typed twice is six chances each to transpose a digit, and the failure is
silent: a wrong tier does not error, it charges the wrong amount to a real card
until somebody reconciles an invoice against the pricing page.

- [ ] `npm run stripe:catalog` — dry run. Read what it says it would create.
- [ ] `npm run stripe:catalog -- --apply` (sandbox).
- [ ] Live: `npm run stripe:catalog -- --apply --live --confirm`. Both flags
      are required because a live price **cannot be edited** once a
      subscription uses it.
- [ ] Verify in the Dashboard that the prices charge:

| Locations | Monthly | Annual |
| --- | --- | --- |
| 1 | $59 | $590 |
| 2 | $108 | $1,080 |
| 3 | $157 | $1,570 |
| 10 | $500 | $5,000 |
| 11 | $544 | $5,440 |
| 100 | $3,835 | $38,350 |

If any figure differs, **stop**. The script and the pricing page disagree, and
one of them is charging somebody the wrong amount.

- [ ] Note that the final tier is `up_to: inf` because Stripe requires it. Lia
      enforces the 100-location ceiling in four places (see `docs/billing.md`
      §1); no Lia code path can reach the infinite tier.

---

## 3. Portal, webhook, and emails (both modes)

### Customer portal

| Setting | Value | Why |
| --- | --- | --- |
| Cancel subscription | **On** | Also how a trial is cancelled. |
| Cancellation reason | **On** | Free churn data. |
| **Update quantities** | **Off** | Lia owns capacity, so Stripe quantity and the database limit cannot silently diverge. |
| Switch plan | **On**, restricted to the two Lia prices | Monthly ↔ annual. A price change has no capacity consequence. |
| Prorate subscription updates | On | |
| Retention coupons | Off | Not a v1 concept. |
| Billing address | On | |
| Tax ID | **Off** until §5 says otherwise | |
| Invoice history | On | |
| Headline, terms link, return link | Set | |

### Webhook endpoint

- [ ] Register `https://<host>/api/webhooks/stripe`.
- [ ] API version **2026-07-29.dahlia**. If it differs, events arrive shaped
      for a different version and the Basil field paths in `stripe-gateway.ts`
      are wrong again.
- [ ] Select **only** these eleven events:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
customer.subscription.trial_will_end
invoice.paid
invoice.payment_failed
invoice.payment_action_required
invoice.finalization_failed
```

- [ ] Copy the signing secret into Vercel **for that environment only**.

### Trial messaging

- [ ] Settings → Subscriptions and emails → enable the trial-ending reminder,
      with **"Link to a Stripe-hosted page"**. Stripe owns this email; Lia
      sends none (`docs/billing.md` §9). Note Stripe does not send these in a
      sandbox.
- [ ] Settings → Subscriptions → confirm Smart Retries and the end-of-retry
      behaviour (`past_due` → `canceled` or `unpaid`). Lia's entitlement matrix
      covers all three; **record which one is configured**, because the copy
      deliberately names no deadline of its own.

---

## 4. Environment

Set separately for **development, preview, and production**:

```
STRIPE_SECRET_KEY          sk_test_… in dev and preview, sk_live_… in production
STRIPE_WEBHOOK_SECRET      whsec_… — different per endpoint and per mode
LIA_BILLING_MODE           unset (decides from the keys), or `mock` locally
BILLING_ENFORCEMENT_MODE   off → allowlist → on, across the rollout
BILLING_ORG_ALLOWLIST      required when the mode is allowlist
```

`APP_URL` and `CRON_SECRET` are reused. There is no `NEXT_PUBLIC_` billing
variable and no Stripe.js in the bundle — Checkout and the portal are
server-created redirects, so the browser never holds a Stripe credential.

The environment refuses four pairings at startup rather than at the till: a
sandbox key in production, a live key in development, the mock in production,
and `allowlist` with an empty allowlist.

> A preview deployment holding a live key is the fastest way to charge a real
> card from a branch. The startup refusal covers `NODE_ENV=development`; preview
> builds run as production, so **this one is on you.**

---

## 5. Stripe Tax

Enabling Stripe Tax does **not** resolve Lia's tax obligations. Five distinct
things, and Stripe performs two:

| Step | Who |
| --- | --- |
| Determine nexus | **You + accountant.** Stripe's threshold monitoring reports where you *may* have crossed a threshold, from Stripe transactions only. It does not decide. |
| Register with authorities | **You + accountant.** Stripe can file registrations through partners; the obligation is yours. |
| Choose the product tax code | **You + accountant.** Likely SaaS, but that is a tax determination, not a code change. |
| Calculate and collect | Stripe — only where a registration is recorded. |
| File and remit | **You + accountant**, or a Stripe filing partner. Stripe does not file by default. |

**Enable `automatic_tax` only after at least one registration exists**, and
configure Stripe Tax to collect only where Lia is registered. Until then,
`billing_address_collection: "required"` gathers what a later switch-on needs,
and `invoice.finalization_failed` is monitored because a missing customer
location is the usual cause once tax is on.

---

## 6. Test matrix (sandbox)

- [ ] Immediate purchase, 1 location, monthly.
- [ ] Immediate purchase, 3 locations, annual — confirm $1,570.
- [ ] Trial start: card collected, nothing charged, `trialing` in Lia.
- [ ] Trial cancellation before day 14 — **no charge**.
- [ ] Trial conversion on day 14 (**test clock**) — `active`, invoice paid.
- [ ] First payment fails (card `4000000000000341`) — `past_due`, product still
      works, banner shows.
- [ ] Capacity increase during a trial — preview shows the revised *first
      charge*; nothing charged today.
- [ ] Capacity decrease — refused below the billable count.
- [ ] Portal: change card, download invoice, switch monthly ↔ annual, cancel.
- [ ] Webhook: replay an event from the Dashboard — Lia returns 200 and
      changes nothing.
- [ ] `stripe listen --forward-to localhost:3000/api/webhooks/stripe` for local
      work.

### Then, live mode

- [ ] One real card, one location, monthly.
- [ ] Confirm the charge, the statement descriptor, and the receipt.
- [ ] Cancel and refund it immediately.
- [ ] Confirm the refund procedure and the dispute procedure **before** anybody
      else can reach Checkout.

---

## 7. Rollout

Each step is reversible, and enforcement is off until step 14.

1. Merge schema + webhook + gateway with `BILLING_ENFORCEMENT_MODE` unset.
   Nothing changes for anyone.
2. Configure the Stripe sandbox (§1–§3).
3. Verify sandbox prices, portal, webhook.
4. Test immediate billing.
5. Test the full 14-day lifecycle with a **test clock** — conversion, failure,
   and cancellation as three separate runs.
6. Deploy production webhook support and live secrets (production env only).
7. **Reconcile existing organizations** — see below.
8. Release the billing UI with enforcement still off. It is an invitation.
9. Test one internal organization against the live catalog.
10. `BILLING_ENFORCEMENT_MODE=allowlist` + one organization id.
11. Controlled production payment.
12. Controlled production trial.
13. Review webhook, entitlement, and payment telemetry across a full billing
    cycle boundary.
14. `BILLING_ENFORCEMENT_MODE=on`.
15. Keep the kill switch documented and tested.

### Step 7 — existing organizations

**This is the decision that cannot be inferred and must not be defaulted
silently.** I cannot read the hosted database, so the disposition of each
existing organization has to be an explicit list from you:

| Disposition | Meaning |
| --- | --- |
| `internal` | Lia's own organizations and demo tenants. |
| `complimentary` | Deliberately free. Carries an expiry. |
| `grandfathered` | Predates billing. Carries an expiry. |
| `sales_managed` | An invoice exists outside Stripe Checkout. |
| `standard` | Ordinary — pays, or is trial-eligible. |

The proposed default, pending your list: every existing organization gets
`grandfathered` with a **90-day** expiry and `trial_eligible = true`, written
by migration and audited. Nothing gets silent permanent free access; every
grant is explicit, dated, and explainable, which is what
`set_billing_access_disposition()` exists to guarantee.

Before step 14, run the reconciliation route and read what it reports.

---

## 8. Open decisions

| # | Decision | Default if you say nothing |
| --- | --- | --- |
| 1 | Does `/pricing` advertise the trial, and in what words? | No change; the trial is offered in-app only |
| 2 | **Existing-organization dispositions** (§7) | 90-day grandfathering, trial eligibility intact |
| 3 | End-of-retry behaviour: `past_due` → `unpaid`, or cancel? | Smart Retries → `past_due` → `unpaid` |
| 4 | Statement descriptor text | `LIA REPUTATION` |
| 5 | Enable Stripe Tax at launch? | **No.** Off until a registration exists |
| 6 | Refund and dispute procedure | No self-service refunds; owner-approved in the Dashboard |
| 7 | Confirm `billing.manage` = owners **and** admins | As built |
| 8 | Confirm portal: plan switching on, quantity editing off | As built |
