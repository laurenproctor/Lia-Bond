import "server-only";

import {
  deriveYelpActivityChange,
  type PlatformProfile,
  type SyncTrigger,
  type YelpActivityOccurrence,
  type YelpListingSnapshot,
} from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import { DataError } from "@/lib/data/errors";
import {
  SyncRunInProgressError,
  type LiaDataSource,
  type OrganizationScope,
} from "@/lib/data/types";
import { YELP_ERROR_MESSAGES, YelpError } from "@/yelp/errors";
import type { YelpPlacesProvider } from "@/yelp/places";

/**
 * Checking one connected Yelp listing for review activity.
 *
 * The whole feature in one function, and the properties worth stating up front
 * are the ones that keep it honest. Each is pinned by a test in
 * `tests/yelp-check-service.test.ts`:
 *
 * 1. **A first check establishes a baseline and reports nothing.** There is no
 *    previous observation to compare against, so there is no change — and
 *    manufacturing one out of Lia's own arrival is the most obvious way this
 *    feature could lie to a customer on day one.
 *
 * 2. **An unchanged listing writes a snapshot and no occurrence.** The snapshot
 *    is the evidence that Lia was checking; the absence of an occurrence is the
 *    honest report.
 *
 * 3. **A provider failure never becomes activity.** The run is recorded as
 *    failed, the last successful snapshot is left exactly where it was, and no
 *    occurrence is written. An outage must not be able to produce a "review
 *    activity detected" notice, and it must not be able to move the baseline
 *    either — a moved baseline would make the *next* successful check report a
 *    change that never happened.
 *
 * 4. **Null counters are not a change.** Yelp omitting a review count is Lia
 *    failing to observe, not the listing moving. `deriveYelpActivityChange`
 *    refuses to compare a null on either side.
 *
 * 5. **Repeated and concurrent checks are idempotent.** The run insert is the
 *    lock (`platform_sync_runs_one_active` on profile + resource), and the
 *    occurrence insert is deduplicated by
 *    `yelp_activity_occurrences_unique_transition`. Neither is a check-then-act.
 *
 * 6. **No provider text is ever stored.** `error_message` on a run is a
 *    Lia-authored sentence chosen from `YELP_ERROR_MESSAGES` by code, never
 *    `error.message` — the same discipline the news poll service keeps.
 */

/** The resource name this check locks on. Never `reviews`: nothing is synced. */
export const YELP_CHECK_RESOURCE = "listing_activity" as const;

/** Cap on stored error text, matching the column and the news poll service. */
const MAX_ERROR_LENGTH = 400;

function codeFor(error: unknown): string {
  if (error instanceof YelpError) return error.code;
  if (error instanceof DataError) return error.code;
  return "unknown";
}

function messageFor(error: unknown): string {
  if (error instanceof YelpError) return YELP_ERROR_MESSAGES[error.code];
  if (error instanceof DataError) return error.message;
  return "Lia could not finish checking this Yelp listing. It will try again.";
}

export interface CheckYelpListingOptions {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
  /** The connected listing. `externalProfileId` is the Yelp business id. */
  profile: PlatformProfile;
  provider: YelpPlacesProvider;
  trigger: SyncTrigger;
  /** Null on a scheduled run — no person is behind it. */
  actorUserId: string | null;
  now: string;
}

export interface YelpCheckOutcome {
  status: "completed" | "failed" | "skipped";
  /** Null only when the run never opened — a lock conflict. */
  runId: string | null;
  /** The observation this check recorded, if it got that far. */
  snapshot: YelpListingSnapshot | null;
  /**
   * The change this check detected, if any.
   *
   * Null covers three genuinely different situations — a first baseline,
   * nothing moved, and a failure — which the caller distinguishes by `status`
   * and `baselineEstablished` rather than by overloading this field.
   */
  occurrence: YelpActivityOccurrence | null;
  /** True when this was the listing's first successful check. */
  baselineEstablished: boolean;
  /** False when the occurrence was already recorded by a concurrent check. */
  occurrenceCreated: boolean;
  requestsSpent: number;
  errorCode: string | null;
  /** Lia's own sentence. Never Yelp's. Null on a clean check. */
  errorMessage: string | null;
}

function skipped(): YelpCheckOutcome {
  return {
    status: "skipped",
    runId: null,
    snapshot: null,
    occurrence: null,
    baselineEstablished: false,
    occurrenceCreated: false,
    requestsSpent: 0,
    errorCode: "check_in_progress",
    errorMessage: "Another check for this listing is already running.",
  };
}

/**
 * Check one listing.
 *
 * Structured as one outer try/finally around an opened run, mirroring
 * `syncGoogleReviews` and `pollMonitoringQuery`: from the moment the run row
 * exists, exactly one `finish` closes it on every path. Without that, an
 * unexpected error leaves the row `running` and holds the lock until the stale
 * window reclaims it, which looks to an operator like a listing that stopped
 * being checked for no reason.
 */
export async function checkYelpListing(
  options: CheckYelpListingOptions,
): Promise<YelpCheckOutcome> {
  const { dataSource, scope, profile, provider, trigger, actorUserId, now } = options;

  let run;
  try {
    run = await dataSource.platformSyncRuns.start(scope, {
      platformConnectionId: profile.platformConnectionId,
      platformProfileId: profile.id,
      resource: YELP_CHECK_RESOURCE,
      trigger,
      actorUserId,
      startedAt: now,
    });
  } catch (error) {
    // The insert *is* the lock. A concurrent check losing this race is an
    // ordinary outcome, not a failure of the sweep — it is reported as skipped
    // and never rethrown, so one busy listing cannot fail a whole pass.
    if (error instanceof SyncRunInProgressError) return skipped();
    throw error;
  }

  let requestsSpent = 0;

  try {
    // The previous observation, read *before* the provider call so a failure
    // below cannot be confused about what the baseline was.
    const previous = await dataSource.yelpListingSnapshots.latestForProfile(
      scope,
      profile.id,
    );

    const listing = await provider.getBusiness(profile.externalProfileId);
    requestsSpent = 1;

    const snapshot = await dataSource.yelpListingSnapshots.record(scope, {
      platformProfileId: profile.id,
      syncRunId: run.id,
      observedAt: now,
      reviewCount: listing.reviewCount,
      rating: listing.rating,
      isClosed: listing.isClosed,
    });

    // A first check has nothing to compare against. Recording the baseline and
    // stopping is the whole of the correct behaviour here — the alternative,
    // treating "no previous observation" as a change from zero, would announce
    // that every review on the listing had just arrived.
    if (!previous) {
      await finishRun(dataSource, scope, run.id, now, "completed", null, null);
      await auditCheck(dataSource, scope, profile, snapshot, trigger, null);
      return {
        status: "completed",
        runId: run.id,
        snapshot,
        occurrence: null,
        baselineEstablished: true,
        occurrenceCreated: false,
        requestsSpent,
        errorCode: null,
        errorMessage: null,
      };
    }

    const changeKind = deriveYelpActivityChange(
      { reviewCount: previous.reviewCount, rating: previous.rating },
      { reviewCount: snapshot.reviewCount, rating: snapshot.rating },
    );

    if (!changeKind) {
      await finishRun(dataSource, scope, run.id, now, "completed", null, null);
      await auditCheck(dataSource, scope, profile, snapshot, trigger, null);
      return {
        status: "completed",
        runId: run.id,
        snapshot,
        occurrence: null,
        baselineEstablished: false,
        occurrenceCreated: false,
        requestsSpent,
        errorCode: null,
        errorMessage: null,
      };
    }

    const { occurrence, created } = await dataSource.yelpActivityOccurrences.record(
      scope,
      {
        platformProfileId: profile.id,
        locationId: profile.locationId,
        fromSnapshotId: previous.id,
        toSnapshotId: snapshot.id,
        detectedAt: now,
        changeKind,
        previousReviewCount: previous.reviewCount,
        currentReviewCount: snapshot.reviewCount,
        previousRating: previous.rating,
        currentRating: snapshot.rating,
      },
    );

    await finishRun(dataSource, scope, run.id, now, "completed", null, null);
    await auditCheck(dataSource, scope, profile, snapshot, trigger, occurrence);

    // Only a genuine first detection is announced. A replay — a concurrent
    // check that observed the same transition — records nothing further, so one
    // change produces one audit event however many workers noticed it.
    if (created) {
      await recordAuditEvent(
        { dataSource, scope },
        {
          eventType: "yelp_activity.detected",
          entityType: "yelp_activity_occurrence",
          entityId: occurrence.id,
          previousState: {
            reviewCount: previous.reviewCount,
            rating: previous.rating,
          },
          newState: {
            reviewCount: snapshot.reviewCount,
            rating: snapshot.rating,
          },
          // `changeKind` and the counters, and deliberately no count of new
          // reviews: the numbers cannot support one.
          metadata: {
            changeKind,
            platformProfileId: profile.id,
            locationId: profile.locationId,
          },
          actorType: actorUserId ? "user" : "system",
        },
      );
    }

    return {
      status: "completed",
      runId: run.id,
      snapshot,
      occurrence,
      baselineEstablished: false,
      occurrenceCreated: created,
      requestsSpent,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    const errorCode = codeFor(error);
    const errorMessage = messageFor(error).slice(0, MAX_ERROR_LENGTH);

    // No snapshot, no occurrence, and the previous baseline untouched. An
    // outage is a gap in Lia's observation, not an event on the listing.
    await finishRun(dataSource, scope, run.id, now, "failed", errorCode, errorMessage);

    await recordAuditEvent(
      { dataSource, scope },
      {
        eventType: "integration.listing_check_failed",
        entityType: "platform_profile",
        entityId: profile.id,
        previousState: null,
        newState: null,
        metadata: { errorCode, trigger },
        actorType: actorUserId ? "user" : "system",
      },
    );

    return {
      status: "failed",
      runId: run.id,
      snapshot: null,
      occurrence: null,
      baselineEstablished: false,
      occurrenceCreated: false,
      requestsSpent,
      errorCode,
      errorMessage,
    };
  }
}

async function finishRun(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  runId: string,
  now: string,
  status: "completed" | "failed",
  errorCode: string | null,
  errorMessage: string | null,
): Promise<void> {
  await dataSource.platformSyncRuns.finish(scope, runId, {
    status,
    completedAt: now,
    // The review-import counters mean nothing on this path and are reported as
    // zero rather than repurposed. `totalReviewCount` is the one field that
    // genuinely applies: it is what Yelp says the listing's total is, which is
    // exactly what this check reads.
    counts: { fetched: 0, created: 0, updated: 0, unchanged: 0, failed: 0 },
    pagesFetched: 0,
    totalReviewCount: null,
    errorCode,
    errorMessage,
  });
}

/**
 * Record that a check ran.
 *
 * Attributed to the profile, matching `integration.reviews_synced`'s
 * reasoning: "which restaurant's listing was checked" is the question an
 * auditor has. The metadata is the two counters and whether anything moved —
 * never a claim about reviews.
 */
async function auditCheck(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  profile: PlatformProfile,
  snapshot: YelpListingSnapshot,
  trigger: SyncTrigger,
  occurrence: YelpActivityOccurrence | null,
): Promise<void> {
  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "integration.listing_checked",
      entityType: "platform_profile",
      entityId: profile.id,
      previousState: null,
      newState: {
        reviewCount: snapshot.reviewCount,
        rating: snapshot.rating,
      },
      metadata: {
        trigger,
        changeDetected: occurrence !== null,
        ...(occurrence ? { changeKind: occurrence.changeKind } : {}),
      },
      actorType: "system",
    },
  );
}
