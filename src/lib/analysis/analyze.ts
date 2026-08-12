import "server-only";

import {
  EMPTY_ANALYSIS_COUNTS,
  HEURISTIC_MODEL_NAME,
  HEURISTIC_MODEL_PROVIDER,
  isHeuristicAnalysis,
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
import { toAnalysisInput, toEscalationDecision } from "@/lib/analysis/normalize";
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
 * 1. **It never overwrites a person's decision.** The final status is derived
 *    inside the escalation contract from the mention's current state, not
 *    supplied from here, and no source-owned column is reachable at all.
 * 2. **It is safe to re-run.** Every classification is recorded as an
 *    occurrence keyed on (organization, run, mention) and applied in one
 *    transaction. Selection is "no analysis row **or** a pending one", so a
 *    crash between the two is recovered without a second model call, and a
 *    replay after success has no effects. See `analyzeOne` for the crash
 *    matrix.
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
   * One entry per occurrence this run **applied** — including one it recovered
   * from an earlier run, whose analysis id is that earlier occurrence's.
   * `failed` mentions do not appear: whatever they left behind, this run did
   * not finish it, so there is nothing a rule may act on yet.
   *
   * The rule engine's input: each pair is a (mention, trigger occurrence) a
   * rule run can evaluate against.
   */
  processed: { mentionId: string; analysisId: string }[];
}

/* -------------------------------------------------------------------------- */
/* One mention                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `calledModel` is on **both** variants, and that is the point of the shape.
 *
 * Whether this run paid the provider for this mention is independent of whether
 * anything came of it: a classification that lands and then fails to apply has
 * still been billed. Carrying the fact only on the successful variant is what
 * let a crashed run report `modelName: null` while the analysis row it wrote
 * named the model perfectly well.
 */
type ItemOutcome =
  | {
      kind: "applied";
      mentionId: string;
      analysisId: string;
      /** From the stored row's own provenance, not from what this run did. */
      heuristic: boolean;
      /** Whether this run actually spent a provider call on this mention. */
      calledModel: boolean;
      /** True only when this application is what brought the case into being. */
      escalationCreated: boolean;
    }
  | {
      kind: "failed";
      code: string;
      message: string;
      fatal: boolean;
      /**
       * True when the provider returned a classification and something after it
       * failed. False when the provider itself threw — a rejected credential or
       * a refused request computed nothing and bought nothing, so naming the
       * model would invent a cost rather than record one.
       */
      calledModel: boolean;
    };

/**
 * Take one mention through the occurrence lifecycle.
 *
 *   record (insert-or-load on the event key) -> apply (one transaction)
 *
 * This replaces the old write-order reasoning entirely. That version ordered
 * three independent writes to make the last one recoverable, which is the best
 * anyone can do without a transaction and is not good enough: whichever write
 * goes last, some crash leaves a mention that looks finished and never comes
 * back. The lifecycle removes the choice instead of optimising it.
 *
 * A *logical analysis event* is (organization, run, mention). Recording it is
 * idempotent on that key, so a repeated recorder is handed the stored row and
 * discards its own output. The recording is pending until
 * `applyAnalysisOccurrence` stamps it, and the escalation, the mention
 * transition, the denormalised columns, the completion stamp, and the
 * escalation's audit event all happen inside that one call — in Postgres, one
 * transaction. Selection is "no analysis row **or** a pending one", so a
 * pending occurrence is re-picked rather than skipped.
 *
 * What each crash costs:
 *
 * - **Before the recording** — nothing durable exists. The mention is still in
 *   the queue and there is nothing to duplicate; the next run classifies it.
 * - **Between recording and apply** — the classification is durable and the
 *   outcome is not. The next run re-picks the mention, finds its latest
 *   occurrence pending, skips classification entirely (the model call is
 *   already paid for and its answer is stored), and applies that occurrence
 *   under its original id. The case, if any, is created once.
 * - **Mid-apply** — the transaction rolls back whole. There is no state where
 *   the escalation exists and the transition does not, or where the occurrence
 *   is stamped and the case is missing. The occurrence stays pending and is
 *   recoverable exactly as above.
 * - **After apply** — replaying answers `alreadyApplied` with zero effects and
 *   zero events, whatever a person has done to the mention since.
 *
 * One deliberate cosmetic difference on the recovery path: `mention_analyses`
 * stores no escalation title, so a case raised from a recovered occurrence
 * carries the derived title rather than the model's phrasing.
 *
 * The escalation's audit event is **not** written here. It belongs to the apply
 * transaction, so no failure can separate a case from its trail.
 */
async function analyzeOne(
  context: AnalysisContext,
  provider: AiProvider,
  mention: Mention,
  location: Location | null,
  runId: string,
  analyzedAt: string,
): Promise<ItemOutcome> {
  // Outside the `try` so the failure path can still report it. The provider is
  // billed at the moment it answers, not at the moment Lia manages to store
  // what it said.
  let calledModel = false;

  try {
    // Recovery check, before any spending. A mention reaches this function
    // because it needs analysis work, which is either "never classified" or
    // "classified but never applied" — and only the second has a row to read.
    //
    // A mention has at most one pending occurrence, and nothing records a new
    // one while that is true, so "the latest row is pending" is the whole
    // recovery condition. If the read is ambiguous under a tie and returns an
    // applied row instead, the recorder below still hands back the pending one
    // (`created: false`): the cost is one wasted classification, never a
    // duplicate occurrence.
    const latest = await context.dataSource.mentions.latestAnalysis(
      context.scope,
      mention.id,
    );

    let stored = latest?.outcomeAppliedAt === null ? latest : null;
    // The model's own case title, which is not a stored column. Null on every
    // path that reads a stored row, including a recorder that lost the race.
    let escalationTitle: string | null = null;

    if (!stored) {
      const heuristic = isRatingOnly(mention);

      // Null on the heuristic path rather than a fabricated provider result:
      // token counts feed a cost record, and a plausible-looking zero from a
      // call that never happened is worse than an honest absence.
      const called = heuristic
        ? null
        : await provider.analyzeMention({ mention, location });

      calledModel = called !== null;
      const output = called ? called.analysis : analyzeByRating(mention);

      const recorded = await context.dataSource.mentions.recordAnalysisOccurrence(
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
          // The heuristic uses no prompt, so claiming a prompt version would
          // put a fiction into the field a later comparison relies on.
          promptVersion: heuristic ? null : ANALYSIS_PROMPT_VERSION,
        }),
      );

      stored = recorded.analysis;
      // `created: false` means this event was already recorded, or an older
      // event is still pending for this mention. Either way the stored row is
      // the authority and this run's fresh output is discarded — including its
      // title, which is why this is set only on the created branch.
      if (recorded.created) escalationTitle = output.escalationTitle ?? null;
    }

    // Computed from the stored row, never from the fresh output: on the
    // recovery and the lost-race paths there is no fresh output, and on the
    // created path the two are the same reading.
    const decision = toEscalationDecision(stored, location, escalationTitle);

    const applied = await context.dataSource.mentions.applyAnalysisOccurrence(
      context.scope,
      {
        mentionId: mention.id,
        analysisId: stored.id,
        ...decision,
        sentiment: stored.sentiment,
        riskLevel: stored.riskLevel,
        relevanceScore: stored.relevanceScore,
      },
    );

    return {
      kind: "applied",
      mentionId: mention.id,
      analysisId: stored.id,
      heuristic: isHeuristicAnalysis(stored),
      calledModel,
      // Only a creation counts. A refusal (an open case already, a dismissed
      // mention, one awaiting re-triage) and a replay each leave the number
      // where it was, because neither of them raised anything.
      escalationCreated: applied.escalationCreated,
    };
  } catch (error) {
    return {
      kind: "failed",
      code: error instanceof DataError ? error.code : aiErrorCode(error),
      // Lia's own sentence. Never the provider's, which can echo the prompt —
      // and the prompt contains the review and the reviewer's name.
      message:
        error instanceof DataError ? error.message : toAiMessage(error),
      fatal: isFatalToRun(error),
      // Still true when the classification succeeded and the apply is what
      // threw: the run has spent that money whether or not it kept the answer.
      calledModel,
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
      // Provenance first, and for every outcome including a failed one. This is
      // the run's cost record, and it answers one question only: did this run
      // call the model? A recovery applies a model analysis without calling
      // one, so it must not claim the spend; a run that called the model and
      // then crashed did spend it, so it must not deny it. Both directions
      // matter, and neither follows from which bucket the mention landed in.
      if (outcome.calledModel) usedModel = true;

      if (outcome.kind === "applied") {
        // Which bucket comes from the occurrence's own provenance, so a
        // recovered occurrence is reported as the kind of analysis it actually
        // is rather than as whatever this run would have done.
        if (outcome.heuristic) counts.heuristic += 1;
        else counts.analyzed += 1;

        if (outcome.escalationCreated) counts.escalated += 1;
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
  /**
   * Mentions a run would pick up: no analysis row, or one whose outcome was
   * never applied. The card says "waiting on analysis", and a mention whose
   * apply crashed is still waiting.
   */
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
