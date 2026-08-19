import { NextResponse } from "next/server";
import { getServiceDataSource } from "@/lib/data";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize";
import { sweepYelpListings } from "@/lib/yelp/sweep";
import { getYelpProvider, isYelpAvailable } from "@/yelp/registry";

/**
 * Scheduled Yelp listing checks.
 *
 * Guarded by a shared secret rather than a session: cron has no user. That
 * makes this another write path where RLS is not the backstop, which is why
 * `sweepYelpListings` constructs a scope per organization row rather than
 * relying on anything ambient (D88).
 *
 * Exported as both GET and POST for the reason `news-poll` documents: Vercel
 * Cron invokes scheduled routes with GET, so GET is the one that matters in
 * production, and POST stays exported for a manual trigger that should not have
 * to imitate a GET to reach the same handler. Both share one function so the
 * two methods cannot drift.
 *
 * **This route is deliberately not in `vercel.ts` yet.** The hosting account is
 * on Vercel's Hobby plan, which caps both cron frequency and the number of
 * cron jobs per project, and two are already scheduled. Wiring a third would
 * fail the deploy at config validation rather than at runtime. Until the
 * account moves to Pro, checks run from the "Check for activity" control on the
 * integration screen, which calls the same service with `trigger: "manual"` —
 * so the scheduled and interactive paths cannot drift apart while one of them
 * waits for a billing change. Adding the schedule is a one-line change to
 * `vercel.ts` and nothing else; see the rollout section of
 * `docs/integrations/yelp-assisted.md`.
 */

export const dynamic = "force-dynamic";

async function handleYelpListingCheck(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isYelpAvailable()) {
    // 200, not 500: a deployment with no Yelp key is an expected state, not a
    // failure of this route, and a scheduler that alerts on every 200 stays
    // quiet for it.
    return NextResponse.json({ status: "not_configured", checked: 0 }, { status: 200 });
  }

  try {
    // Service-role, not `getDataSource()`. Cron carries no session, so a
    // session-bound client would be rejected by every policy resolving through
    // auth.uid().
    const dataSource = await getServiceDataSource();
    const outcome = await sweepYelpListings({
      dataSource,
      provider: getYelpProvider(),
      now: new Date().toISOString(),
    });

    // `skippedForBudget` and `abortedEarly` are returned rather than swallowed:
    // a sweep that checked eight of forty listings must not read as full
    // coverage, and one that stopped on a rejected key must say so.
    return NextResponse.json(
      {
        status: outcome.abortedEarly ? "degraded" : "ok",
        checked: outcome.checked,
        changes_detected: outcome.changesDetected,
        failed: outcome.failed,
        skipped: outcome.skipped,
        skipped_for_budget: outcome.skippedForBudget,
        aborted_early: outcome.abortedEarly,
      },
      { status: 200 },
    );
  } catch (error) {
    // Lia's own sentence in the log line, never the provider's: a Yelp error
    // body quotes the request back, and a match request carries an address.
    console.error("[cron:yelp-listing-check] the sweep failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ status: "failed" }, { status: 503 });
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleYelpListingCheck(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleYelpListingCheck(request);
}
