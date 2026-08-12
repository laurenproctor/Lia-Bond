import "server-only";

import {
  EMPTY_ANALYSIS_COUNTS,
  HEURISTIC_MODEL_NAME,
  HEURISTIC_MODEL_PROVIDER,
  isSuccessfulAnalysisRun,
  type AnalysisCounts,
  type AnalysisRun,
  type Location,
  type Mention,
  type SyncTrigger,
} from "@/domain";
import { aiErrorCode, isFatalToRun, toAiMessage } from "@/ai/errors";
import type { AiProvider } from "@/ai/provider";
import { getAiProvider } from "@/ai/registry";
import { recordAuditEvent } from "@/lib/audit/record";
import { DataError } from "@/lib/data/errors";
import {
  AnalysisRunInProgressError,
  type LiaDataSource,
  type OrganizationScope,
} from "@/lib/data/types";
import { analysisBatchSize } from "@/lib/env";
import { analyzeByRating, isRatingOnly } from "@/lib/analysis/heuristic";
import { toAnalysisInput, toEscalationInput } from "@/lib/analysis/normalize";
import { ANALYSIS_PROMPT_VERSION } from "@/lib/analysis/prompt";

/**
 * Mention analysis.
 *
 * One organization's unanalysed backlog in, one recorded run out. Everything
 * that has to happen in a particular order — take the lock, batch, classify,
 * escalate, persist, release, audit — happens here once, so no action, route,
 * or future scheduler can get the order wrong or skip a step.
 *
 * Four properties the rest of the product depends on:
 *
 * 1. **It never overwrites a person's decision.** The mention update advances
 *    `status` only from `new`, and touches no source-owned column at all.
 * 2. **It is safe to re-run.** Selection is "mentions with no analysis", and
 *    the analysis insert is the commit point, so a crash costs a repeated call
 *    rather than a silently unanalysed mention.
 * 3. **It never hides a backlog.** A capped run records what it left.
 * 4. **It writes no customer-facing text.** Analysis produces classifications;
 *    drafting is workflow 05, and there is no code here that could generate a
 *    response.
 */

/** Cap on stored error text, matching the column and the health model. */
const MAX_ERROR_LENGTH = 400;

/**
 * How many mentions are classified at once after the cache is warm.
 *
 * Small deliberately. The ceiling here is not Lia's — it is the provider's
 * rate limit, and a burst large enough to trip it turns a working run into a
 * partial one for no gain in wall-clock time.
 */
const CONCURRENCY = 4;

export interface AnalysisContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

export interface AnalyzeMentionsInput {
  /** Defaults to `LIA_ANALYSIS_BATCH_SIZE`. */
  limit?: number;
  /** Manual now; the same service is what a scheduled job will call. */
  trigger?: SyncTrigger;
  /** Injectable so tests substitute a provider without touching the registry. */
  provider?: AiProvider;
}

export interface AnalyzeMentionsResult {
  analysisRunId: string;
  status: AnalysisRun["status"];
  counts: AnalysisCounts;
  /** Null on success; a sentence a person can act on otherwise. */
  errorMessage: string | null;
  errorCode: string | null;
  /**
   * One entry per mention whose analysis row was written this run — both the
   * `analyzed` (model) and `heuristic` outcomes create one; `failed` mentions
   * do not appear, since no row was written for them.
   *
   * The rule engine's input: each pair is a (mention, trigger occurrence) a
   * rule run can evaluate against.
   */
  processed: { mentionId: string; analysisId: string }[];
}

/* -------------------------------------------------------------------------- */
/* One mention                                                                 */
/* -------------------------------------------------------------------------- */

type ItemOutcome =
  | { kind: "analyzed"; escalated: boolean; mentionId: string; analysisId: string }
  | { kind: "heuristic"; mentionId: string; analysisId: string }
  | { kind: "failed"; code: string; message: string; fatal: boolean };

/**
 * Classify and persist one mention.
 *
 * The write order is the important part and is load-bearing:
 *
 *   escalation -> mention update -> analysis insert
 *
 * There is no transaction available (decision D17: the demo adapter has none
 * and PostgREST exposes none), so the ordering is what makes a partial failure
 * safe. Selection is "mentions with no analysis row", which makes the insert
 * the commit point — die before it and the mention is simply picked up again,
 * where the escalation dedupe and the idempotent mention update absorb the
 * repeat.
 *
 * The reverse order is the tempting one and it is wrong: analysis-first means
 * a failure at the mention update leaves a record that *looks* analysed, never
 * receives its risk level, and is never selected again. That is the guardrail
 * failing silently, which is the exact outcome this workflow exists to prevent.
 */
async function analyzeOne(
  context: AnalysisContext,
  provider: AiProvider,
  mention: Mention,
  location: Location | null,
  runId: string,
  analyzedAt: string,
): Promise<ItemOutcome> {
  const heuristic = isRatingOnly(mention);

  try {
    // Null on the heuristic path rather than a fabricated provider result:
    // token counts feed a cost record, and a plausible-looking zero from a
    // call that never happened is worse than an honest absence.
    const called = heuristic
      ? null
      : await provider.analyzeMention({ mention, location });

    const output = called ? called.analysis : analyzeByRating(mention);

    const escalationInput = toEscalationInput(output, mention, location);
    let escalated = false;

    if (escalationInput) {
      const { escalation, created } = await context.dataSource.escalations.create(
        context.scope,
        escalationInput,
      );
      escalated = created;

      if (created) {
        await recordAuditEvent(context, {
          eventType: "escalation.created_from_analysis",
          entityType: "escalation",
          entityId: escalation.id,
          previousState: null,
          // Category and severity only. The title can quote the review, so it
          // is deliberately not carried into the audit trail.
          newState: {
            category: escalation.category,
            severity: escalation.severity,
          },
          metadata: { mentionId: mention.id, analysisRunId: runId },
          actorType: "ai",
        });
      }
    }

    await context.dataSource.mentions.applyAnalysisOutcome(
      context.scope,
      mention.id,
      {
        sentiment: output.sentiment,
        riskLevel: output.riskLevel,
        relevanceScore: output.relevanceScore,
        // An escalated mention says so in the queue rather than reading as
        // routine triage.
        status: escalationInput ? "escalated" : "analyzed",
      },
    );

    const analysis = await context.dataSource.mentions.createAnalysis(
      context.scope,
      toAnalysisInput({
        output,
        mentionId: mention.id,
        analysisRunId: runId,
        modelProvider: called ? called.modelProvider : HEURISTIC_MODEL_PROVIDER,
        modelName: called ? called.modelName : HEURISTIC_MODEL_NAME,
        inputTokens: called?.inputTokens ?? null,
        outputTokens: called?.outputTokens ?? null,
        analyzedAt,
        // The heuristic uses no prompt, so claiming a prompt version would put
        // a fiction into the field a later comparison relies on.
        promptVersion: heuristic ? null : ANALYSIS_PROMPT_VERSION,
      }),
    );

    return heuristic
      ? { kind: "heuristic", mentionId: mention.id, analysisId: analysis.id }
      : { kind: "analyzed", escalated, mentionId: mention.id, analysisId: analysis.id };
  } catch (error) {
    return {
      kind: "failed",
      code: error instanceof DataError ? error.code : aiErrorCode(error),
      // Lia's own sentence. Never the provider's, which can echo the prompt —
      // and the prompt contains the review and the reviewer's name.
      message:
        error instanceof DataError ? error.message : toAiMessage(error),
      fatal: isFatalToRun(error),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

export async function analyzeMentions(
  context: AnalysisContext,
  input: AnalyzeMentionsInput = {},
): Promise<AnalyzeMentionsResult> {
  const trigger = input.trigger ?? "manual";
  const limit = input.limit ?? analysisBatchSize();
  const startedAt = new Date().toISOString();

  // Resolved before the lock so an unconfigured deployment fails without
  // leaving a failed run in a history somebody reads to judge health.
  const provider = input.provider ?? getAiProvider();

  let run: AnalysisRun;
  try {
    run = await context.dataSource.analysisRuns.start(context.scope, {
      trigger,
      // A scheduled run has no person behind it, and attributing one to
      // whoever last clicked would be a lie in the audit trail.
      actorUserId: trigger === "manual" ? context.scope.userId : null,
      startedAt,
    });
  } catch (error) {
    // Losing this race is the system working, not a failure. Translated into a
    // conflict so the caller renders a sentence, and raised before a run row
    // exists so the refused attempt leaves no trace in the history.
    if (error instanceof AnalysisRunInProgressError) {
      throw new DataError(
        "conflict",
        "An analysis is already running. Wait for it to finish before starting another.",
      );
    }
    throw error;
  }

  const counts: AnalysisCounts = { ...EMPTY_ANALYSIS_COUNTS };
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let usedModel = false;
  const processed: AnalyzeMentionsResult["processed"] = [];

  try {
    const [pending, backlog, locations] = await Promise.all([
      context.dataSource.mentions.listUnanalyzed(context.scope, limit),
      context.dataSource.mentions.countUnanalyzed(context.scope),
      context.dataSource.locations.list(context.scope),
    ]);

    // What the cap left behind. Recorded rather than dropped: a run that
    // analysed 50 of 2,000 and reported success reads as "the inbox is
    // triaged" when it is not.
    counts.remaining = Math.max(0, backlog - pending.length);

    const locationsById = new Map(locations.map((location) => [location.id, location]));
    const analyzedAt = new Date().toISOString();

    const apply = (outcome: ItemOutcome): void => {
      if (outcome.kind === "heuristic") {
        counts.heuristic += 1;
        processed.push({ mentionId: outcome.mentionId, analysisId: outcome.analysisId });
        return;
      }
      if (outcome.kind === "analyzed") {
        counts.analyzed += 1;
        usedModel = true;
        if (outcome.escalated) counts.escalated += 1;
        processed.push({ mentionId: outcome.mentionId, analysisId: outcome.analysisId });
        return;
      }

      counts.failed += 1;
      if (!errorCode) {
        errorCode = outcome.code;
        errorMessage = outcome.message;
      }
    };

    const run1 = (mention: Mention) =>
      analyzeOne(
        context,
        provider,
        mention,
        mention.locationId ? (locationsById.get(mention.locationId) ?? null) : null,
        run.id,
        analyzedAt,
      );

    // Rating-only mentions first, and separately. They cost nothing and cannot
    // fail on the provider, so getting them out of the way means a provider
    // outage still leaves the free work done.
    const ratingOnly = pending.filter(isRatingOnly);
    const needModel = pending.filter((mention) => !isRatingOnly(mention));

    for (const mention of ratingOnly) apply(await run1(mention));

    // The first model call goes alone to write the prompt cache; the rest read
    // it. Parallel requests cannot read an entry another is still writing, so
    // firing them all at once would pay full price for every one.
    let index = 0;
    let fatal = false;

    if (needModel.length > 0) {
      const first = await run1(needModel[0]!);
      apply(first);
      fatal = first.kind === "failed" && first.fatal;
      index = 1;
    }

    while (index < needModel.length && !fatal) {
      const slice = needModel.slice(index, index + CONCURRENCY);
      const outcomes = await Promise.all(slice.map(run1));

      for (const outcome of outcomes) {
        apply(outcome);
        if (outcome.kind === "failed" && outcome.fatal) fatal = true;
      }

      index += slice.length;
    }

    if (fatal) {
      // The rest of the batch was never attempted, so it is still backlog.
      counts.remaining += needModel.length - index;
    }
  } catch (error) {
    // Reached only when something outside the per-item path failed — a
    // repository read, most likely. The per-item path catches its own.
    errorCode = error instanceof DataError ? error.code : aiErrorCode(error);
    errorMessage =
      error instanceof DataError ? error.message : toAiMessage(error);
  }

  const attempted = counts.analyzed + counts.heuristic;
  const status =
    attempted === 0 && counts.failed > 0
      ? "failed"
      : counts.failed > 0
        ? "partial"
        : "completed";

  const completedAt = new Date().toISOString();

  const finished = await context.dataSource.analysisRuns.finish(
    context.scope,
    run.id,
    {
      status,
      completedAt,
      counts,
      // Null on a heuristic-only run: naming a model that was never called
      // would put a fiction in the provenance a cost review reads.
      modelProvider: usedModel ? provider.provider : null,
      modelName: usedModel ? provider.model : null,
      promptVersion: usedModel ? ANALYSIS_PROMPT_VERSION : null,
      errorCode,
      errorMessage: errorMessage
        ? errorMessage.slice(0, MAX_ERROR_LENGTH)
        : null,
    },
  );

  await recordAuditEvent(context, {
    eventType: isSuccessfulAnalysisRun(finished)
      ? "mention.analyzed"
      : "mention.analysis_failed",
    // Attributed to the organization: a run spans many mentions, so pinning it
    // to one of them would misfile it for every other.
    entityType: "organization",
    entityId: context.scope.organizationId,
    previousState: null,
    newState: { status },
    // Counts, provenance, and a normalised code. No review text, no reviewer
    // name, no prompt — the prompt contains both.
    metadata: {
      analysisRunId: finished.id,
      trigger,
      analyzed: counts.analyzed,
      heuristic: counts.heuristic,
      escalated: counts.escalated,
      failed: counts.failed,
      remaining: counts.remaining,
      modelName: finished.modelName ?? "",
      promptVersion: finished.promptVersion ?? "",
      errorCode: errorCode ?? "",
    },
    actorType: trigger === "manual" ? "user" : "ai",
  });

  return {
    analysisRunId: finished.id,
    status: finished.status,
    counts,
    errorMessage: finished.errorMessage,
    errorCode: finished.errorCode,
    processed,
  };
}

/* -------------------------------------------------------------------------- */
/* Status for the UI                                                           */
/* -------------------------------------------------------------------------- */

export interface AnalysisStatus {
  /** Mentions with no analysis at all. */
  unanalyzedCount: number;
  latest: AnalysisRun | null;
  lastSuccessful: AnalysisRun | null;
  /** True while a run holds the lock, so the UI can disable the button. */
  running: boolean;
}

export async function getAnalysisStatus(
  context: AnalysisContext,
): Promise<AnalysisStatus> {
  const [unanalyzedCount, state] = await Promise.all([
    context.dataSource.mentions.countUnanalyzed(context.scope),
    context.dataSource.analysisRuns.latest(context.scope),
  ]);

  return {
    unanalyzedCount,
    latest: state.latest,
    lastSuccessful: state.lastSuccessful,
    running: state.latest?.status === "running",
  };
}
