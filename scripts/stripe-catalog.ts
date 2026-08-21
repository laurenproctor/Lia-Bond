/**
 * Creates or verifies Lia's Stripe product and prices.
 *
 * The catalog is derived from `PRICING_BANDS` in `@/lib/pricing/schedule` —
 * the same declaration the marketing page renders — rather than typed into the
 * Stripe Dashboard by hand. Hand-entering six tiers twice (sandbox and live)
 * is six chances each to transpose a digit, and the failure is silent: a wrong
 * tier does not error, it charges the wrong amount to a real card and keeps
 * doing so until somebody reconciles an invoice against the pricing page.
 *
 * Three properties, in order of how much they matter:
 *
 * 1. **Dry run by default.** Nothing is created unless `--apply` is passed.
 * 2. **Live mode needs saying twice.** `--apply` against an `sk_live_` key is
 *    refused unless `--live --confirm` are both present. A live price cannot
 *    be edited once a subscription uses it, so a mistake here is permanent.
 * 3. **It verifies rather than assumes.** An existing price whose tiers do not
 *    match the schedule is reported and the script **stops**. It does not
 *    "fix" it, because a price in use cannot be changed and quietly creating a
 *    replacement would leave two live prices with the same lookup key and no
 *    way to tell which subscriptions are on which.
 *
 * No secret is ever printed. Ids and lookup keys are, because they are what
 * somebody needs to find these objects in the Dashboard.
 *
 * Run with:
 *   npm run stripe:catalog                    # dry run against the configured key
 *   npm run stripe:catalog -- --apply         # create what is missing (sandbox)
 *   npm run stripe:catalog -- --apply --live --confirm
 */

import Stripe from "stripe";
// Resolved by scripts/tsconfig-paths-hook.mjs, which the npm script preloads.
import { PRICE_LOOKUP_KEYS, PRODUCT_LOOKUP_KEY, tiersFor } from "@/lib/billing/catalog";
import { STRIPE_API_VERSION } from "@/lib/billing/stripe-gateway";
import {
  ANNUAL_MONTHS_BILLED,
  LISTED_LOCATION_LIMIT,
  annualTotal,
  monthlyTotal,
  type BillingPeriod,
} from "@/lib/pricing/schedule";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const APPLY = hasFlag("apply");
const LIVE = hasFlag("live");
const CONFIRM = hasFlag("confirm");

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("STRIPE_SECRET_KEY is not set. Nothing to do.");
  process.exit(1);
}

const isLiveKey = secretKey.startsWith("sk_live_");

if (isLiveKey && APPLY && !(LIVE && CONFIRM)) {
  console.error(
    "Refusing to write to live mode without --live --confirm.\n" +
      "A live price cannot be edited once a subscription uses it, so this is deliberate friction.",
  );
  process.exit(1);
}
if (!isLiveKey && LIVE) {
  console.error("--live was passed but the configured key is a sandbox key. Stopping.");
  process.exit(1);
}

const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });

const mode = isLiveKey ? "LIVE" : "sandbox";
console.log(`Stripe catalog — ${mode} mode, API ${STRIPE_API_VERSION}`);
console.log(APPLY ? "Applying changes.\n" : "Dry run. Pass --apply to create.\n");

/** Stripe wants `up_to: "inf"` spelled exactly that way. */
function tierParams(period: BillingPeriod) {
  return tiersFor(period).map((tier) => ({
    up_to: tier.upTo,
    unit_amount: tier.unitAmount,
  }));
}

/** Whether a live price already matches what the schedule says it should be. */
function tiersMatch(price: Stripe.Price, period: BillingPeriod): boolean {
  const expected = tiersFor(period);
  const actual = price.tiers ?? [];
  if (actual.length !== expected.length) return false;

  return expected.every((tier, index) => {
    const found = actual[index];
    if (!found) return false;
    const upTo = tier.upTo === "inf" ? null : tier.upTo;
    return found.up_to === upTo && found.unit_amount === tier.unitAmount;
  });
}

async function findProduct(): Promise<Stripe.Product | null> {
  const search = await stripe.products.search({
    query: `metadata['lia_lookup_key']:'${PRODUCT_LOOKUP_KEY}'`,
    limit: 1,
  });
  return search.data[0] ?? null;
}

async function findPrice(period: BillingPeriod): Promise<Stripe.Price | null> {
  const list = await stripe.prices.list({
    lookup_keys: [PRICE_LOOKUP_KEYS[period]],
    active: true,
    limit: 1,
    expand: ["data.tiers"],
  });
  return list.data[0] ?? null;
}

let drift = false;

async function ensureProduct(): Promise<string | null> {
  const existing = await findProduct();
  if (existing) {
    console.log(`product  ${existing.id}  (${PRODUCT_LOOKUP_KEY}) — exists`);
    return existing.id;
  }

  if (!APPLY) {
    console.log(`product  —  (${PRODUCT_LOOKUP_KEY}) — would create`);
    return null;
  }

  const created = await stripe.products.create({
    name: "Lia",
    description: "Reputation monitoring and response, priced per location.",
    metadata: { lia_lookup_key: PRODUCT_LOOKUP_KEY },
  });
  console.log(`product  ${created.id}  (${PRODUCT_LOOKUP_KEY}) — created`);
  return created.id;
}

async function ensurePrice(period: BillingPeriod, productId: string | null) {
  const lookupKey = PRICE_LOOKUP_KEYS[period];
  const existing = await findPrice(period);

  if (existing) {
    if (tiersMatch(existing, period)) {
      console.log(`price    ${existing.id}  (${lookupKey}) — exists, tiers match`);
    } else {
      drift = true;
      console.error(
        `price    ${existing.id}  (${lookupKey}) — EXISTS BUT TIERS DO NOT MATCH the schedule.\n` +
          "         A price in use cannot be edited. Create a _v2 price and move the lookup key,\n" +
          "         so existing subscribers keep the price they agreed to. Not doing it here.",
      );
    }
    return;
  }

  if (!APPLY || !productId) {
    console.log(`price    —  (${lookupKey}) — would create`);
    return;
  }

  const created = await stripe.prices.create({
    product: productId,
    currency: "usd",
    nickname: `Lia per location, ${period}`,
    billing_scheme: "tiered",
    // Graduated, not volume: an eleventh location must not reprice the ten
    // below it, which is exactly what the published rate card promises.
    tiers_mode: "graduated",
    tiers: tierParams(period),
    recurring: {
      interval: period === "annual" ? "year" : "month",
      usage_type: "licensed",
    },
    lookup_key: lookupKey,
  });
  console.log(`price    ${created.id}  (${lookupKey}) — created`);
}

/** The figures the runbook asks an operator to check against the Dashboard. */
function printVerificationTable(): void {
  console.log("\nWhat these prices should charge:\n");
  console.log("  locations    monthly       annual");
  for (const count of [1, 2, 3, 10, 11, 25, 50, 100]) {
    const monthly = monthlyTotal(count);
    const annual = annualTotal(count);
    console.log(
      `  ${String(count).padStart(9)}  ${`$${monthly?.toLocaleString("en-US")}`.padStart(11)}  ${`$${annual?.toLocaleString("en-US")}`.padStart(11)}`,
    );
  }
  console.log(
    `\n  Annual is ${ANNUAL_MONTHS_BILLED} months at the monthly rate, not 12.`,
  );
  console.log(
    `  Above ${LISTED_LOCATION_LIMIT} locations Stripe's unbounded tier keeps pricing, and Lia refuses to sell.\n`,
  );
}

async function main() {
  const productId = await ensureProduct();
  await ensurePrice("monthly", productId);
  await ensurePrice("annual", productId);

  printVerificationTable();

  if (drift) {
    console.error("Stopped: at least one existing price disagrees with the schedule.");
    process.exit(1);
  }
  if (!APPLY) {
    console.log("Dry run complete. Nothing was created.");
  }
}

main().catch((error: unknown) => {
  // The message only. A Stripe error object carries the request, and the
  // request carries the key.
  console.error(
    "Catalog failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
