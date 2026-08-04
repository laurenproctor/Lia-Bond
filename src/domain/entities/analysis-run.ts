import { z } from "zod";
import { syncRunStatusSchema, syncTriggerSchema } from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * One attempt to analyse an organization's unanalysed mentions.
 *
 * The same shape as a platform sync run, and for the same reasons: a run that
 * failed has to be a row rather than an absence, because "the queue stopped
 * moving" and "nothing new arrived" look identical otherwise. The row is also
 * the lock — a `running` run holds a partial unique index on the organization,
 * so a second run cannot start. See `analysis_runs_one_active`.
 *
 * Scoped to the organization rather than to a mention: analysis walks a shared
 * backlog, so two concurrent runs would race over the same rows and pay twice
 * for the overlap.
 */

/**
 * What a run did.
 *
 * `analyzed` and `heuristic` are separate because they cost differently and
 * mean differently: a rating-only review is genuinely analysed, but by a pure
 * function rather than by a model. Folding them together would make both the
 * cost and the coverage unreadable.
 */
export const analysisCountsSchema = z.object({
  /** Analysed by the model. */
  analyzed: z.number().int().min(0),
  /** Analysed by the rating heuristic, with no model call. */
  heuristic: z.number().int().min(0),
  escalated: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** Unanalysed mentions still left when the run hit its cap. */
  remaining: z.number().int().min(0),
});

export type AnalysisCounts = z.infer<typeof analysisCountsSchema>;

export const EMPTY_ANALYSIS_COUNTS: AnalysisCounts = {
  analyzed: 0,
  heuristic: 0,
  escalated: 0,
  failed: 0,
  remaining: 0,
};

export const analysisRunSchema = z
  .object({
    trigger: syncTriggerSchema,
    /** Null for a scheduled run, and for one whose actor has been offboarded. */
    actorUserId: uuidSchema.nullable(),
    status: syncRunStatusSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    counts: analysisCountsSchema,
    /** Null until the first model call; a heuristic-only run never sets them. */
    modelProvider: z.string().max(80).nullable(),
    modelName: z.string().max(120).nullable(),
    promptVersion: z.string().max(40).nullable(),
    /** Normalised code, never a provider status string. */
    errorCode: z.string().max(80).nullable(),
    /** Lia's own sentence. Never the provider's message, never the prompt. */
    errorMessage: z.string().max(400).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type AnalysisRun = z.infer<typeof analysisRunSchema>;

/* -------------------------------------------------------------------------- */
/* Write inputs                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Opening a run.
 *
 * `startedAt` is supplied rather than defaulted in the adapter so the demo
 * store (which runs on a fixed seed clock) and Postgres record the instant the
 * service decided on, not two different ones.
 */
export const startAnalysisRunInputSchema = z.object({
  trigger: syncTriggerSchema,
  actorUserId: uuidSchema.nullable(),
  startedAt: timestampSchema,
});

export type StartAnalysisRunInput = z.infer<typeof startAnalysisRunInputSchema>;

/** Closing a run. `running` is absent: a run finishes exactly once. */
export const finishAnalysisRunInputSchema = z
  .object({
    status: z.enum(["completed", "partial", "failed"]),
    completedAt: timestampSchema,
    counts: analysisCountsSchema,
    modelProvider: z.string().max(80).nullable(),
    modelName: z.string().max(120).nullable(),
    promptVersion: z.string().max(40).nullable(),
    errorCode: z.string().max(80).nullable(),
    errorMessage: z.string().max(400).nullable(),
  })
  .refine((value) => value.errorMessage === null || value.errorCode !== null, {
    message: "An error message needs an error code",
    path: ["errorCode"],
  })
  .refine((value) => value.status !== "failed" || value.errorCode !== null, {
    message: "A failed run must say why",
    path: ["errorCode"],
  });

export type FinishAnalysisRunInput = z.infer<typeof finishAnalysisRunInputSchema>;

/* -------------------------------------------------------------------------- */
/* Derived state                                                               */
/* -------------------------------------------------------------------------- */

export function isSuccessfulAnalysisRun(run: AnalysisRun): boolean {
  return run.status === "completed" || run.status === "partial";
}

/**
 * A run that started long enough ago that its process is almost certainly gone.
 *
 * Without a reclaim window a single killed function would hold the lock
 * forever and the only remedy would be editing the database. The window is
 * generously longer than any real run: a capped batch of fifty is minutes.
 */
export const ANALYSIS_RUN_STALE_AFTER_MS = 30 * 60 * 1000;

export function isAnalysisRunStale(run: AnalysisRun, now: number): boolean {
  if (run.status !== "running") return false;
  const startedAt = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > ANALYSIS_RUN_STALE_AFTER_MS;
}
