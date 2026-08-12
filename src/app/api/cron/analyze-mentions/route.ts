import { NextResponse } from "next/server";
import { isAiAvailable } from "@/ai/registry";
import { SYSTEM_ACTOR_ID } from "@/lib/cron/system-actor";
import { getServiceDataSource } from "@/lib/data";
import { isAuthorizedCronRequest } from "@/lib/cron/authorize";
import { DataError } from "@/lib/data/errors";
import type { OrganizationScope } from "@/lib/data/types";
import { analyzeMentions } from "@/lib/analysis/analyze";
import { zeroSweepCounters, type SweepCounters } from "@/domain";
import { resolveRulesExecutionMode, rulesExecutionAllowlist } from "@/lib/env";
import { executeRules } from "@/lib/rules/execute";

/**
 * Scheduled mention analysis, and the rules execution sweep that follows it.
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
 * organization's own id rather than anything ambient (D88), and its own call
 * to `analyzeMentions` — so one organization's already-running analysis, or
 * one organization's unexpected failure, costs the sweep that organization
 * and nothing else, the same isolation `pollDueQueries` applies per query.
 *
 * Rules execution rides the same loop, one organization at a time and with
 * the same isolation. It runs only after that organization's `analyzeMentions`
 * returned — it consumes the `processed` pairs that call produced, so there is
 * nothing to sweep before it — and it is wrapped in its own try/catch because
 * `executeRules` rethrows when the sweep loop itself dies (it finalizes its
 * `automation_sweeps` row first, so the failure is already recorded where it
 * belongs). Without that catch one organization's broken sweep would cost
 * every later organization both its execution and its place in the response.
 *
 * Two gates decide whether a sweep runs at all, both fail-closed: the mode
 * (`off` means zero calls, not a call that does nothing) and the rollout
 * allowlist. An organization refused by either is reported rather than
 * silently absent — `organizationsNotAllowlisted` for the allowlist, and an
 * `execution.reason` when nothing ran at all.
 *
 * Exported as both GET and POST. Vercel Cron invokes scheduled routes with
 * GET, so GET is the one that matters in production — without it every
 * scheduled invocation 405s and this route never runs, the same defect the
 * news-poll route carried. POST stays exported for a manual trigger. Both
 * share one function so the two methods cannot drift in behaviour.
 */

export const dynamic = "force-dynamic";

interface SweepTotals {
  /** Organizations `analyzeMentions` actually ran for — the call did not throw. */
  organizations: number;
  /** Organizations whose analysis lock was already held; not attempted. */
  skipped: number;
  analyzed: number;
  heuristic: number;
  escalated: number;
  /**
   * Mentions that failed to classify, summed from `result.counts.failed`
   * across every organization the sweep actually ran. Distinct from
   * `erroredOrganizations`: a run can complete without throwing and still
   * have failed some mentions (status `partial` or, if every mention failed,
   * `failed`) — `organizations` increments either way, since the call itself
   * succeeded and recorded a run. Reporting this separately is what stops an
   * organization where every mention failed from reading identical to a
   * clean sweep, the same principle `skippedForBudget` applies on the poll
   * route.
   */
  mentionsFailed: number;
  /** Organizations where the call threw something other than a lock conflict. */
  erroredOrganizations: number;
  /**
   * Runs that returned *normally* carrying an `errorCode`.
   *
   * `analyzeMentions` has a run-level catch of its own: a repository read that
   * fails outside the per-mention path is recorded on the analysis run and
   * returned, not thrown. Such a run can report zero counts and a status of
   * `completed` — nothing failed per mention because nothing was ever
   * attempted — so reading `counts` alone, as this route first did, renders a
   * total analysis outage indistinguishable from an organization that simply
   * had no backlog. This counter is what keeps that honest.
   */
  analysisRunsWithErrors: number;
  /**
   * Of those, the runs that also got nothing through: no mention analysed, no
   * heuristic fallback. They are the ones that did not succeed at anything and
   * so count against the 503 clause.
   *
   * Deliberately not in the response body: it is a decision input, and a
   * second, nearly identical number next to `analysisRunsWithErrors` would
   * invite being read as an additional class of failure rather than a subset
   * of one. A partial run — an error code and some mentions through — is
   * counted above and not here, which is what keeps it `degraded` and not
   * `failed`.
   */
  analysisRunsWithoutProgress: number;
}

/**
 * One organization's execution sweep, as the response reports it.
 *
 * `status` is the route's own reading of what came back, not a database
 * column:
 *
 * - `completed` — `executeRules` returned having claimed and finalized a sweep.
 * - `not_claimed` — it returned without a claim. Either another scheduler
 *   already holds this organization's sweep, or there was nothing to sweep
 *   (no processed mentions, no active rules). The engine's `idleResult` does
 *   not distinguish those, and neither does this, rather than guessing.
 * - `failed` — it threw. The sweep row was already finalized as `failed` by
 *   the engine before it rethrew; that row, not this summary, is the record.
 */
interface SweepSummary {
  organizationId: string;
  /** null for `not_claimed` and for `failed`: the throw carries no id back. */
  sweepId: string | null;
  status: "completed" | "not_claimed" | "failed";
  claimed: boolean;
  counters: SweepCounters;
  mentionsSkipped: number;
  budgetExhausted: boolean;
}

/**
 * Why no sweep ran, when none did. Null whenever at least one was attempted.
 *
 * Spec §10 requires the nothing-to-do case to state its reason rather than
 * returning an `ok` indistinguishable from a clean sweep of real work.
 */
type ExecutionReason =
  | "mode_off"
  | "allowlist_empty"
  | "no_organizations_due"
  | "no_analysis_succeeded"
  | "no_allowlisted_organizations";

interface ExecutionTotals {
  sweeps: SweepSummary[];
  /** Organizations `executeRules` was called for. */
  organizationsAttempted: number;
  /** Of those, the ones where it returned instead of throwing. */
  organizationsCompleted: number;
  /**
   * Organizations that reached the execution gate — an active mode, and their
   * own analysis already returned — and were refused by the rollout allowlist.
   */
  organizationsNotAllowlisted: number;
}

/**
 * Whether a sweep result describes work that failed rather than work that
 * simply found nothing to do.
 *
 * `actionsSkipped` and `budgetExhausted` are deliberately not here: those are
 * the engine reporting that it stopped at a configured cap, which is the cap
 * working. Blocked and no-op actions are likewise normal operation (spec §10).
 * Failures of any class are not — including `retryableFailures`, which spec
 * §10 names, and `terminalFailures`, which covers a failure with no action
 * outcome at all (a mention the analysis run promised and the sweep could not
 * read), and would otherwise read as a clean sweep.
 */
function sweepHadFailures(summary: SweepSummary): boolean {
  if (summary.status === "failed") return true;
  const { actionsFailed, retryableFailures, terminalFailures } = summary.counters;
  return actionsFailed > 0 || retryableFailures > 0 || terminalFailures > 0;
}

/**
 * Why no sweep was attempted, or null if one was.
 *
 * The gates are reported in the order they are applied, so the reason names
 * the first thing that stopped execution rather than the last: an `off` mode
 * with an empty allowlist reads `mode_off`, because turning the mode on alone
 * would still have run nothing.
 */
function executionReason(
  mode: "off" | "dry_run" | "apply",
  allowlistSize: number,
  organizationsDue: number,
  totals: SweepTotals,
  execution: ExecutionTotals,
): ExecutionReason | null {
  if (execution.organizationsAttempted > 0) return null;
  if (mode === "off") return "mode_off";
  if (allowlistSize === 0) return "allowlist_empty";
  if (organizationsDue === 0) return "no_organizations_due";
  // Organizations were due and admitted in principle, but execution runs only
  // behind a successful analysis. Saying "not allowlisted" here would blame
  // the rollout gate for a sweep the analysis half never reached.
  if (totals.organizations === 0) return "no_analysis_succeeded";
  return "no_allowlisted_organizations";
}

/**
 * The spec §10 status table, in one place so the body and the HTTP code can
 * never disagree about what the sweep did.
 *
 * `failed` here is the 503 row only — "work was attempted and zero attempted
 * units of work succeeded". The two clauses are a disjunction, matching the
 * spec's parenthetical: every attempted organization erroring in analysis, or
 * every execution sweep throwing, is each on its own a systemic failure worth
 * a 503, even when the other half of the pipeline was fine. An execution-wide
 * failure cannot satisfy the analysis clause — a sweep is only attempted after
 * its organization's analysis succeeded — so without the disjunction the
 * execution half could never report systemic breakage at all.
 *
 * "Succeeded" is not the same as "returned": a run that came back with an
 * error code and nothing analysed did not succeed, however politely it
 * returned, and counts against the analysis clause exactly as a throw does.
 *
 * The 500 row (the loop could not run) is not decided here: it is the outer
 * catch, which has no totals to reason about.
 */
function resolveStatus(
  totals: SweepTotals,
  execution: ExecutionTotals,
): "ok" | "degraded" | "failed" {
  const analysisAttempted = totals.organizations + totals.erroredOrganizations;
  const analysisSucceeded = totals.organizations - totals.analysisRunsWithoutProgress;
  const analysisAllFailed = analysisAttempted > 0 && analysisSucceeded === 0;
  const executionAllFailed =
    execution.organizationsAttempted > 0 && execution.organizationsCompleted === 0;

  if (analysisAllFailed || executionAllFailed) return "failed";

  const materialFailure =
    totals.erroredOrganizations > 0 ||
    totals.analysisRunsWithErrors > 0 ||
    totals.mentionsFailed > 0 ||
    execution.sweeps.some(sweepHadFailures);

  return materialFailure ? "degraded" : "ok";
}

async function handleAnalyzeMentions(request: Request): Promise<Response> {
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
    mentionsFailed: 0,
    erroredOrganizations: 0,
    analysisRunsWithErrors: 0,
    analysisRunsWithoutProgress: 0,
  };

  const execution: ExecutionTotals = {
    sweeps: [],
    organizationsAttempted: 0,
    organizationsCompleted: 0,
    organizationsNotAllowlisted: 0,
  };

  // Read once for the whole sweep: a mode or allowlist that changed mid-run
  // would otherwise treat two organizations in the same invocation by
  // different rules, and the response could not honestly name one `mode`.
  //
  // `executionEnabled` is also what narrows `mode` to the two modes
  // `executeRules` accepts — an early `continue` on it leaves `off` behind at
  // the type level too, so the engine cannot be called with it by mistake.
  const mode = resolveRulesExecutionMode();
  const allowlist = new Set(rulesExecutionAllowlist());
  const executionEnabled = mode !== "off" && allowlist.size > 0;

  try {
    // Service-role, not `getDataSource()`, for the same reason as news-poll:
    // cron carries no session, so a session-bound client would be rejected by
    // every policy resolving through auth.uid(). Every method reached below
    // therefore enforces its own tenancy discipline rather than relying on
    // RLS (D88).
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
        // Returned, not swallowed — see the field's own doc comment above.
        totals.mentionsFailed += result.counts.failed;

        if (result.errorCode !== null) {
          totals.analysisRunsWithErrors += 1;
          // Heuristic outcomes count as progress: the mention was classified
          // and a row written, model or no model. Only a run that got nothing
          // at all through is treated as having failed outright.
          if (result.counts.analyzed + result.counts.heuristic === 0) {
            totals.analysisRunsWithoutProgress += 1;
          }
        }

        if (!executionEnabled) continue;
        if (!allowlist.has(organizationId)) {
          execution.organizationsNotAllowlisted += 1;
          continue;
        }

        execution.organizationsAttempted += 1;
        try {
          // The organization's own scope — the same one its analysis ran
          // under — and the pairs that analysis just produced. Nothing
          // ambient, and nothing from the previous organization.
          const sweep = await executeRules(
            { dataSource, scope },
            { mode, processed: result.processed },
          );
          execution.organizationsCompleted += 1;
          execution.sweeps.push({
            organizationId,
            sweepId: sweep.sweepId,
            status: sweep.claimed ? "completed" : "not_claimed",
            claimed: sweep.claimed,
            counters: sweep.counters,
            mentionsSkipped: sweep.mentionsSkipped,
            budgetExhausted: sweep.budgetExhausted,
          });
        } catch (error) {
          // Logged, name only, exactly as the outer catch does: an error
          // message here can carry driver detail, and the redaction posture is
          // the same wherever it is written. The organization id is safe — the
          // response already names it.
          //
          // Logged *at all* because the sweep row is not guaranteed to exist:
          // a throw from `listActiveForExecution` or from the claim happens
          // before any row is written, and a throw from the terminal
          // `finalize` leaves one stuck in `running`. Swallowing those
          // silently would leave the failure recorded nowhere at all.
          console.error(
            "[cron:analyze-mentions] sweep failed",
            organizationId,
            error instanceof Error ? error.name : "unknown",
          );
          // `executeRules` rethrows only after finalizing its sweep row as
          // failed, so where that row exists the durable record already does;
          // what is lost is the id, which the throw does not carry. Counters
          // are reported as zero and every handed-over mention as unreached —
          // this summary states what it can verify rather than inventing
          // progress.
          execution.sweeps.push({
            organizationId,
            sweepId: null,
            status: "failed",
            claimed: false,
            counters: zeroSweepCounters(),
            mentionsSkipped: result.processed.length,
            budgetExhausted: false,
          });
        }
      } catch (error) {
        // A conflict means another process already holds this organization's
        // analysis lock — not a failure of the sweep, the same reasoning
        // `pollMonitoringQuery`'s lock conflict gets. Anything else is one
        // organization's unexpected failure, which must not cost every other
        // tenant its own analysis run.
        if (error instanceof DataError && error.code === "conflict") {
          totals.skipped += 1;
        } else {
          totals.erroredOrganizations += 1;
        }
      }
    }

    const status = resolveStatus(totals, execution);
    return NextResponse.json(
      {
        status,
        analysis: {
          organizations: totals.organizations,
          skipped: totals.skipped,
          analyzed: totals.analyzed,
          heuristic: totals.heuristic,
          escalated: totals.escalated,
          mentionsFailed: totals.mentionsFailed,
          erroredOrganizations: totals.erroredOrganizations,
          analysisRunsWithErrors: totals.analysisRunsWithErrors,
        },
        execution: {
          mode,
          reason: executionReason(
            mode,
            allowlist.size,
            organizationIds.length,
            totals,
            execution,
          ),
          sweeps: execution.sweeps,
          organizationsAttempted: execution.organizationsAttempted,
          organizationsCompleted: execution.organizationsCompleted,
          organizationsNotAllowlisted: execution.organizationsNotAllowlisted,
        },
      },
      // 503, not 500: the loop ran, so this is the "nothing succeeded" row of
      // the table rather than a route that could not start. Both say `failed`.
      { status: status === "failed" ? 503 : 200 },
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
      { status: "failed", error: "Mention analysis could not complete." },
      { status: 500 },
    );
  }
}

export const GET = handleAnalyzeMentions;
export const POST = handleAnalyzeMentions;
