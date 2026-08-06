import "server-only";

import type { PlatformSyncRun } from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

/**
 * What the Workspace Ready screen may say about importing.
 *
 * Every number here comes from a `platform_sync_runs` row. There is no
 * estimate, no projection, and — most importantly — **no percentage**, because
 * there is no denominator to compute one from: Google does not tell Lia how
 * many reviews a location has until a page has been fetched, and even then
 * `totalReviewCount` is optional. A progress bar at "68%" with nothing behind
 * the 68 is the single most misleading thing this screen could render, so the
 * type below has no field that could hold one.
 *
 * `hasStarted: false` is a real answer, not an empty state to be filled in
 * later. There is no scheduled review sync — `vercel.ts` schedules the news
 * poll and the analysis sweep, and neither touches reviews — so an organization
 * that has just finished setup genuinely has no import running, and the screen
 * offers a button rather than a spinner.
 */

export interface ImportStatus {
  /** Profiles Lia is monitoring. Zero means nothing to import from. */
  connectedProfiles: number;
  /** True once at least one real sync run exists. */
  hasStarted: boolean;
  /** True while any run is open. */
  isRunning: boolean;
  /** Runs that finished in a state other than `completed`. */
  degradedRuns: number;
  failedRuns: number;
  /** Summed from finished runs only. A running run's counts are not final. */
  reviewsFetched: number;
  reviewsCreated: number;
  reviewsUpdated: number;
  /**
   * What the provider says the true totals are, summed across profiles that
   * reported one — or null when none did. Only ever rendered as "of N", never
   * turned into a percentage against a partial numerator.
   */
  totalReviewCount: number | null;
  /** The most recent successful run's completion, across every profile. */
  lastSuccessfulAt: string | null;
}

export const NO_IMPORT_STATUS: ImportStatus = {
  connectedProfiles: 0,
  hasStarted: false,
  isRunning: false,
  degradedRuns: 0,
  failedRuns: 0,
  reviewsFetched: 0,
  reviewsCreated: 0,
  reviewsUpdated: 0,
  totalReviewCount: null,
  lastSuccessfulAt: null,
};

function isFinished(run: PlatformSyncRun): boolean {
  return run.status !== "running";
}

/**
 * Read the real import state for this organization.
 *
 * Reads the latest run per profile rather than every run ever: the question the
 * screen asks is "what is happening now, and did it work", and a full history
 * would answer neither faster.
 */
export async function readImportStatus(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
): Promise<ImportStatus> {
  const profiles = (await dataSource.platformProfiles.list(scope)).filter(
    (profile) => profile.status === "active",
  );

  if (profiles.length === 0) return NO_IMPORT_STATUS;

  const states = await dataSource.platformSyncRuns.latestForProfiles(
    scope,
    profiles.map((profile) => profile.id),
    "reviews",
  );

  const status: ImportStatus = {
    ...NO_IMPORT_STATUS,
    connectedProfiles: profiles.length,
  };

  let totalReviewCount: number | null = null;
  let lastSuccessfulAt: string | null = null;

  for (const profile of profiles) {
    const state = states[profile.id];
    if (!state?.latest) continue;

    status.hasStarted = true;

    const run = state.latest;
    if (run.status === "running") status.isRunning = true;
    if (run.status === "partial") status.degradedRuns += 1;
    if (run.status === "failed") status.failedRuns += 1;

    // Counts come from finished runs only. A run still in flight has partial
    // tallies that would tick backwards on the next read if it were retried.
    if (isFinished(run)) {
      status.reviewsFetched += run.counts.fetched;
      status.reviewsCreated += run.counts.created;
      status.reviewsUpdated += run.counts.updated;

      if (run.totalReviewCount !== null) {
        totalReviewCount = (totalReviewCount ?? 0) + run.totalReviewCount;
      }
    }

    const successful = state.lastSuccessful;
    if (successful?.completedAt) {
      if (
        lastSuccessfulAt === null ||
        Date.parse(successful.completedAt) > Date.parse(lastSuccessfulAt)
      ) {
        lastSuccessfulAt = successful.completedAt;
      }
    }
  }

  status.totalReviewCount = totalReviewCount;
  status.lastSuccessfulAt = lastSuccessfulAt;
  return status;
}
