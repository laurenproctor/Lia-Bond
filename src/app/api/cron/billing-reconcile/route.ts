import { NextResponse } from "next/server";
import { getServiceDataSource } from "@/lib/data";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize";
import { reconcileBilling } from "@/lib/billing/reconcile";
import { getStripeGateway, isBillingAvailable } from "@/lib/billing/registry";

/**
 * Billing reconciliation.
 *
 * **Not on a schedule in `vercel.ts`, deliberately.** The hosting account is
 * on Vercel's Hobby plan, which already carries two crons and rejects a
 * deploy that exceeds its limits at config validation — the same constraint
 * `vercel.ts` records for the hourly poll it had to degrade to daily. Adding a
 * third schedule would fail the deploy rather than fail at runtime.
 *
 * So this is a manual trigger, in the shape `news-poll` already documents: an
 * on-call `curl -X POST`, a deploy hook, or a scheduled call from outside
 * Vercel. The runbook in `docs/billing.md` calls for it after any webhook
 * outage and before enabling enforcement, which are the two moments it
 * actually matters. Add the schedule when the account moves to Pro; nothing
 * else needs to change.
 *
 * Guarded by the shared cron secret rather than a session, like every other
 * scheduled route, and it carries its own tenancy discipline: the service is
 * handed a service-role data source and constructs a scope per row from that
 * row's own organization id (D88).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Bounded so one run has a predictable cost, like every other sweep. */
const DEFAULT_LIMIT = 200;

async function handleReconcile(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isBillingAvailable()) {
    // 200, not 500: a deployment with no Stripe configuration is an expected
    // state, not a failure of this route, and a scheduler that alerts on every
    // 200 stays quiet for it.
    return NextResponse.json({ status: "not_configured", examined: 0 }, { status: 200 });
  }

  try {
    const outcome = await reconcileBilling({
      dataSource: await getServiceDataSource(),
      gateway: getStripeGateway(),
      limit: DEFAULT_LIMIT,
    });

    // `reported` is returned rather than swallowed: a run that repaired three
    // projections and reported two duplicate subscriptions must not read as a
    // clean sweep.
    return NextResponse.json({ status: "ok", ...outcome }, { status: 200 });
  } catch {
    // `reconcileBilling` isolates every per-organization failure internally, so
    // reaching here means something failed outside that loop — most likely the
    // initial listing. No error detail: it can be a driver message, and a
    // driver message can quote a connection string.
    console.error("[billing:reconcile] sweep failed outside the per-row loop");
    return NextResponse.json({ error: "reconcile_failed" }, { status: 500 });
  }
}

export function GET(request: Request): Promise<Response> {
  return handleReconcile(request);
}

export function POST(request: Request): Promise<Response> {
  return handleReconcile(request);
}
