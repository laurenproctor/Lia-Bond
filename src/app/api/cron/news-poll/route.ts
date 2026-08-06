import { NextResponse } from "next/server";
import { getServiceDataSource } from "@/lib/data";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize";
import { getNewsMonitor, isNewsMonitorAvailable } from "@/news/registry";
import { pollDueQueries } from "@/lib/monitoring/poll-service";

/**
 * Scheduled news polling.
 *
 * Guarded by a shared secret rather than a session: cron has no user. That
 * makes this the first write path in the codebase where RLS is not the
 * backstop, which is why the poll service constructs a scope per query row
 * rather than relying on anything ambient (D88).
 *
 * Exported as both GET and POST. Vercel Cron invokes scheduled routes with
 * GET — see "Secure Cron Jobs with Next.js Route Handlers" in Vercel's own
 * docs, where every example is `export function GET(...)` — so GET is the
 * one that actually matters in production; without it every scheduled
 * invocation 405s and this route never runs. POST stays exported too, for a
 * manual trigger (a deploy hook, an on-call `curl -X POST`, or a future
 * "poll now for every tenant" admin action) that should not have to imitate
 * a GET to reach the same, equally side-effect-bearing handler. Both share
 * one function so the two methods cannot drift in behaviour.
 */

export const dynamic = "force-dynamic";

async function handleNewsPoll(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isNewsMonitorAvailable()) {
    // 200, not 500: an unconfigured deployment is an expected state (no
    // GNews key yet), not a failure of this route, and a scheduler that
    // alerts on every 200 stays quiet for it.
    return NextResponse.json({ status: "not_configured", polled: 0 }, { status: 200 });
  }

  try {
    // Service-role, not `getDataSource()`. Cron carries no session, so a
    // session-bound client would be rejected by every policy resolving
    // through auth.uid(). RLS is therefore not the backstop on this path —
    // the poll service constructs a scope per query row instead (D88).
    const dataSource = await getServiceDataSource();
    const outcome = await pollDueQueries({
      dataSource,
      monitor: getNewsMonitor(),
      now: new Date().toISOString(),
      limit: 25,
    });

    // `skippedForBudget` is returned rather than swallowed: a sweep that
    // polled eight of forty queries must not read as full coverage.
    return NextResponse.json(
      {
        status: "ok",
        polled: outcome.polled,
        accepted: outcome.accepted,
        rejected: outcome.rejected,
        skippedForBudget: outcome.skippedForBudget,
      },
      { status: 200 },
    );
  } catch (error) {
    // `pollDueQueries` isolates every per-query failure internally; reaching
    // here means something failed outside that loop entirely — most likely
    // the initial `listDue` read or the budget check. No error detail in the
    // response or the log: this can be a driver message, and a driver
    // message can quote a connection string.
    console.error("[cron:news-poll] sweep failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json(
      { status: "error", error: "News polling could not complete." },
      { status: 500 },
    );
  }
}

export const GET = handleNewsPoll;
export const POST = handleNewsPoll;
