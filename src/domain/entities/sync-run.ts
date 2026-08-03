import { z } from "zod";
import { syncRunStatusSchema, syncTriggerSchema } from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * One synchronisation attempt.
 *
 * A run is a record, not a log line. It exists because "last synced two days
 * ago" is only half an answer — the other half is what has happened since, and
 * a sync that failed silently looks exactly like a location with no new
 * reviews. Recording every attempt, successful or not, is what makes those two
 * distinguishable to someone who has to support this.
 *
 * The row is also the concurrency control. A `running` run holds a partial
 * unique index on (profile, resource), so a second sync of the same location
 * cannot start; see `platform_sync_runs_one_active` in the migration.
 */

/** What was synchronised. Named so posts and questions can follow later. */
export const syncResourceSchema = z.enum(["reviews"]);
export type SyncResource = z.infer<typeof syncResourceSchema>;

/**
 * The tallies a run reports.
 *
 * `unchanged` is separate from `updated` on purpose: a second sync that reports
 * everything unchanged is the visible proof that the import is idempotent.
 */
export const syncCountsSchema = z.object({
  fetched: z.number().int().min(0),
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  unchanged: z.number().int().min(0),
  failed: z.number().int().min(0),
});

export type SyncCounts = z.infer<typeof syncCountsSchema>;

export const EMPTY_SYNC_COUNTS: SyncCounts = {
  fetched: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
};

export const platformSyncRunSchema = z
  .object({
    platformConnectionId: uuidSchema,
    platformProfileId: uuidSchema,
    resource: syncResourceSchema,
    trigger: syncTriggerSchema,
    /** Null for a scheduled run, and for a run whose actor has been offboarded. */
    actorUserId: uuidSchema.nullable(),
    status: syncRunStatusSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    counts: syncCountsSchema,
    pagesFetched: z.number().int().min(0),
    /** What the provider says the true total is, when it says. */
    totalReviewCount: z.number().int().min(0).nullable(),
    /** Normalised code, never a provider status string. */
    errorCode: z.string().max(80).nullable(),
    /** Lia's own sentence. Never the provider's message. */
    errorMessage: z.string().max(400).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type PlatformSyncRun = z.infer<typeof platformSyncRunSchema>;

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
export const startSyncRunInputSchema = z.object({
  platformConnectionId: uuidSchema,
  platformProfileId: uuidSchema,
  resource: syncResourceSchema,
  trigger: syncTriggerSchema,
  actorUserId: uuidSchema.nullable(),
  startedAt: timestampSchema,
});

export type StartSyncRunInput = z.infer<typeof startSyncRunInputSchema>;

/**
 * Closing a run.
 *
 * `status` cannot be `running`: a run is finished exactly once, and allowing a
 * finish that leaves it open would leave the lock held forever.
 */
export const finishSyncRunInputSchema = z
  .object({
    status: z.enum(["completed", "partial", "failed"]),
    completedAt: timestampSchema,
    counts: syncCountsSchema,
    pagesFetched: z.number().int().min(0),
    totalReviewCount: z.number().int().min(0).nullable(),
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

export type FinishSyncRunInput = z.infer<typeof finishSyncRunInputSchema>;

/* -------------------------------------------------------------------------- */
/* Derived state                                                               */
/* -------------------------------------------------------------------------- */

/** Whether the run refreshed the data, whatever else went wrong along the way. */
export function isSuccessfulSyncRun(run: PlatformSyncRun): boolean {
  return run.status === "completed" || run.status === "partial";
}

export function isSyncRunActive(run: PlatformSyncRun): boolean {
  return run.status === "running";
}

/**
 * A run that started long enough ago that it is almost certainly dead.
 *
 * A serverless function that is killed mid-sync leaves its row `running`, and
 * that row holds the lock. Without a reclaim window, one crash would block a
 * location's syncs permanently — the operator's only remedy being a support
 * ticket. The window is generously longer than any real sync: Google caps a
 * page at 50 reviews and a location with thousands still finishes in minutes.
 */
export const SYNC_RUN_STALE_AFTER_MS = 30 * 60 * 1000;

export function isSyncRunStale(run: PlatformSyncRun, now: number): boolean {
  if (run.status !== "running") return false;
  const startedAt = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > SYNC_RUN_STALE_AFTER_MS;
}
