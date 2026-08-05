import { NextResponse } from "next/server";
import { isAiAvailable } from "@/ai/registry";
import { SYSTEM_ACTOR_ID } from "@/lib/cron/system-actor";
import { getServiceDataSource } from "@/lib/data";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize";
import { DataError } from "@/lib/data/errors";
import type { OrganizationScope } from "@/lib/data/types";
import { analyzeMentions } from "@/lib/analysis/analyze";

/**
 * Scheduled mention analysis.
 *
 * `analyzeMentions` (workflow 04) analyses one organization at a time — it
 * takes an `AnalysisContext` carrying a single `OrganizationScope`, and the
 * repository layer deliberately has no `listAll()` for anything
 * organization-owned. Cron has no session and no organization of its own, so
 * this route has to answer which organizations it sweeps before it can call
 * the service at all.
 *
 * `organizations.listWithUnanalyzedMentions()` answers that: the one
 * deliberately unscoped read added for this route, documented in `types.ts`
 * in the same terms as `MonitoringQueryRepository.listDue`. Deriving the
 * swept set from monitoring queries instead — narrower, and available with no
 * new repository method — was rejected: analysis covers every mention
 * source, not just news, so an organization with only a Google connection
 * would never be picked up. A dedicated `listAll()`-style read, scoped to
 * exactly what this route needs (ids of organizations with unanalysed work),
 * is the narrower exception, matching how `listDue` was justified.
 *
 * Each organization gets its own `OrganizationScope`, built from that
 * organization's own id rather than anything ambient (D70), and its own call
 * to `analyzeMentions` — so one organization's already-running analysis, or
 * one organization's unexpected failure, costs the sweep that organization
 * and nothing else, the same isolation `pollDueQueries` applies per query.
 */

export const dynamic = "force-dynamic";

interface SweepTotals {
  organizations: number;
  /** Organizations whose analysis lock was already held; not attempted. */
  skipped: number;
  analyzed: number;
  heuristic: number;
  escalated: number;
  /** Organizations where the call threw outside `analyzeMentions`'s own handling. */
  failed: number;
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isAiAvailable()) {
    // 200, not 500: no ANTHROPIC_API_KEY yet is an expected deployment state,
    // not a failure of this route — mirrors the news-poll route's
    // `not_configured` response for the same reason.
    return NextResponse.json({ status: "not_configured", organizations: 0 }, { status: 200 });
  }

  const totals: SweepTotals = {
    organizations: 0,
    skipped: 0,
    analyzed: 0,
    heuristic: 0,
    escalated: 0,
    failed: 0,
  };

  try {
    // Service-role, not `getDataSource()`, for the same reason as news-poll:
    // cron carries no session, so a session-bound client would be rejected by
    // every policy resolving through auth.uid(). Every method reached below
    // therefore enforces its own tenancy discipline rather than relying on
    // RLS (D70).
    const dataSource = await getServiceDataSource();
    const organizationIds = await dataSource.organizations.listWithUnanalyzedMentions();

    for (const organizationId of organizationIds) {
      // Built from the row's own id, not from any ambient organization —
      // there is none. `SYSTEM_ACTOR_ID` satisfies `OrganizationScope`'s
      // `userId: string` and must never reach the database; `analyzeMentions`
      // records audit with `actorType: "ai"` for a non-manual trigger, which
      // is why the sentinel stays out of `actorUserId` regardless (see
      // `recordAuditEvent`).
      const scope: OrganizationScope = {
        organizationId,
        userId: SYSTEM_ACTOR_ID,
        role: "owner",
      };

      try {
        const result = await analyzeMentions(
          { dataSource, scope },
          { trigger: "scheduled" },
        );

        totals.organizations += 1;
        totals.analyzed += result.counts.analyzed;
        totals.heuristic += result.counts.heuristic;
        totals.escalated += result.counts.escalated;
      } catch (error) {
        // A conflict means another process already holds this organization's
        // analysis lock — not a failure of the sweep, the same reasoning
        // `pollMonitoringQuery`'s lock conflict gets. Anything else is one
        // organization's unexpected failure, which must not cost every other
        // tenant its own analysis run.
        if (error instanceof DataError && error.code === "conflict") {
          totals.skipped += 1;
        } else {
          totals.failed += 1;
        }
      }
    }

    return NextResponse.json(
      {
        status: "ok",
        organizations: totals.organizations,
        skipped: totals.skipped,
        analyzed: totals.analyzed,
        heuristic: totals.heuristic,
        escalated: totals.escalated,
        failed: totals.failed,
      },
      { status: 200 },
    );
  } catch (error) {
    // Reached only when something outside the per-organization loop failed —
    // most likely `listWithUnanalyzedMentions` itself. No error detail in the
    // response or the log: this can be a driver message.
    console.error(
      "[cron:analyze-mentions] sweep failed",
      error instanceof Error ? error.name : "unknown",
    );
    return NextResponse.json(
      { status: "error", error: "Mention analysis could not complete." },
      { status: 500 },
    );
  }
}
