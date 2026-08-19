import "server-only";

import {
  EMPTY_SYNC_COUNTS,
  isSuccessfulSyncRun,
  NON_DISCUSSION_INGEST_FIELDS,
  type IngestMentionInput,
  type JsonObject,
  type PlatformConnection,
  type PlatformProfile,
  type PlatformSyncRun,
  type SyncCounts,
  type SyncTrigger,
} from "@/domain";
import type { ExternalReview } from "@/integrations/connector";
import { IntegrationError, toIntegrationMessage } from "@/integrations/errors";
import { getGoogleConnector } from "@/integrations/registry";
import { recordAuditEvent } from "@/lib/audit/record";
import { DataError, notFound } from "@/lib/data/errors";
import {
  SyncRunInProgressError,
  type ProfileSyncState,
} from "@/lib/data/types";
import { credentialSession, loadCredentials } from "@/lib/integrations/credentials";
import {
  GOOGLE_PLATFORM,
  recordConnectionFailureHealth,
  type ServiceContext,
} from "@/lib/integrations/google-service";

/**
 * Google review synchronisation.
 *
 * One connected Google location in, one recorded run out. Everything that has
 * to happen in a particular order — take the lock, decrypt, refresh, fetch,
 * normalise, upsert, release the lock, audit — happens here once, so no route
 * handler, action, or future scheduler can get the order wrong or skip a step.
 *
 * Three properties are worth stating plainly, because they are what the rest of
 * the product will depend on:
 *
 * 1. **It is idempotent.** Every review is upserted on its natural key, so
 *    running this twice imports nothing twice. Correctness is not conditional
 *    on a cursor being right.
 * 2. **It never overwrites Lia's work.** The ingest input has no field for
 *    status, sentiment, risk, or assignment, so a re-import cannot move a
 *    mention somebody has escalated back into the new queue.
 * 3. **It publishes nothing.** The owner reply it stores is what Google already
 *    shows. Lia has posted no reply and this module contains no code that
 *    could.
 */

/** The only resource this workflow synchronises. */
const REVIEW_RESOURCE = "reviews" as const;

/** Cap on stored error text, matching the column and the health model. */
const MAX_ERROR_LENGTH = 400;

export interface SyncReviewsInput {
  /** The connected Google location. A `platform_profiles` row id. */
  platformProfileId: string;
  /** Manual now; the same service is what a scheduled job will call. */
  trigger?: SyncTrigger;
}

export interface SyncReviewsResult {
  syncRunId: string;
  platformProfileId: string;
  status: PlatformSyncRun["status"];
  counts: SyncCounts;
  /** Google's own total, when it reported one. Never inferred from the array. */
  totalReviewCount: number | null;
  /** End of the last run that refreshed this location, including this one. */
  lastSuccessfulSyncAt: string | null;
  /** Null on success; a sentence a person can act on otherwise. */
  errorMessage: string | null;
  errorCode: string | null;
}

/* -------------------------------------------------------------------------- */
/* Preconditions                                                               */
/* -------------------------------------------------------------------------- */

interface SyncTarget {
  connection: PlatformConnection;
  profile: PlatformProfile;
  externalAccountId: string;
}

/**
 * Resolve and check everything before a run is opened.
 *
 * Deliberately ahead of `platformSyncRuns.start`: a refusal that happens after
 * the lock is taken leaves a failed run in the history for a request that never
 * had any business syncing, and the history is what an operator reads to decide
 * whether the integration is healthy.
 *
 * Every lookup is scoped, so a profile id belonging to another organization is
 * simply not found. A forged id buys nothing.
 */
async function resolveSyncTarget(
  context: ServiceContext,
  platformProfileId: string,
): Promise<SyncTarget> {
  const profiles = await context.dataSource.platformProfiles.list(context.scope);
  const profile = profiles.find((row) => row.id === platformProfileId);
  if (!profile) throw notFound("Connected location");

  const connection = await context.dataSource.platformConnections.get(
    context.scope,
    profile.platformConnectionId,
  );
  if (!connection) throw notFound("Google connection");

  if (connection.platform !== GOOGLE_PLATFORM) {
    throw new DataError(
      "invalid_input",
      "That location is not a Google Business Profile location, so Google reviews cannot be imported for it.",
    );
  }

  if (connection.status === "disconnected") {
    throw new DataError(
      "conflict",
      "This Google connection is disconnected. Reconnect it before importing reviews.",
    );
  }

  if (profile.status === "disconnected") {
    throw new DataError(
      "conflict",
      "This location is disconnected from Google. Reconnect it in the setup screen before importing reviews.",
    );
  }

  // Google nests reviews under the account that owns the location, so without
  // an account id there is no address to fetch from. Falling back to the
  // connection's own account is right for every mapping made by workflow 02;
  // failing outright when neither exists is right because the alternative is
  // guessing at a URL and reporting Google's 404 as a permissions problem.
  const externalAccountId =
    profile.externalAccountId ?? connection.externalAccountId ?? null;

  if (!externalAccountId) {
    throw new DataError(
      "conflict",
      "Lia does not know which Google account owns this location. Reconnect Google and map this location again.",
    );
  }

  return { connection, profile, externalAccountId };
}

/* -------------------------------------------------------------------------- */
/* Normalisation into the canonical model                                      */
/* -------------------------------------------------------------------------- */

/**
 * A Google review as a row in the unified mentions model.
 *
 * Pure, and separated from the sync loop so the mapping can be asserted on
 * directly rather than only through a run that happened to include the case.
 *
 * `content` is the one field that has to be invented, and it is invented as an
 * empty string rather than as prose. A rating-only review genuinely has no
 * text; writing "No comment provided" would put words in a customer's mouth
 * that a drafting workflow could later quote back at them.
 */
export function reviewToMentionInput(
  review: ExternalReview,
  target: { profile: PlatformProfile; connectionId: string },
  syncedAt: string,
): IngestMentionInput {
  const sourceMetadata: JsonObject = {
    ...review.metadata,
    ...(review.ownerReply?.updatedAt
      ? { ownerReplyUpdatedAt: review.ownerReply.updatedAt }
      : {}),
  };

  return {
    locationId: target.profile.locationId,
    platformConnectionId: target.connectionId,
    platformProfileId: target.profile.id,
    sourceType: "google_review",
    externalId: review.externalId,
    externalParentId: null,
    // Google returns no per-review permalink and Lia does not fabricate one.
    sourceUrl: review.sourceUrl,
    // A review has no title. Leaving it null lets the inbox fall back to the
    // content, which is what it already does for every other untitled source.
    title: null,
    content: review.comment ?? "",
    authorName: review.authorName,
    authorExternalId: review.authorExternalId,
    rating: review.rating,
    // Google does not report the review's language on this endpoint, and
    // guessing from the text would mis-route the multilingual reviews that
    // matter most to a hospitality group.
    language: null,
    publishedAt: review.publishedAt,
    // Deliberately empty. The normalised fields above carry everything Lia
    // uses, and a verbatim Google payload would put a reviewer's photo URL and
    // display name into a second, unmanaged copy — more personal data in more
    // places, for no capability gained.
    rawPayload: {},
    externalResourceName: review.externalResourceName,
    authorAvatarUrl: review.authorAvatarUrl,
    authorIsAnonymous: review.authorIsAnonymous,
    sourceUpdatedAt: review.sourceUpdatedAt,
    sourceReplyText: review.ownerReply?.comment ?? null,
    sourceReplyUpdatedAt: review.ownerReply?.updatedAt ?? null,
    sourceMetadata,
    syncedAt,
    // A Google review has no publisher or monitoring query — those concepts
    // belong to news.
    publisherName: null,
    publisherDomain: null,
    monitoringQueryId: null,
    // Nor is it a threaded discussion: no community, no score, no lock state.
    ...NON_DISCUSSION_INGEST_FIELDS,
  };
}

/* -------------------------------------------------------------------------- */
/* The sync                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Import every review for one connected Google location.
 *
 * The whole history, every time. There is no incremental cursor, and that is a
 * decision rather than an omission: Google orders by `updateTime desc`, so a
 * "stop at the first review we have already seen" rule would skip an older
 * review whose *edit* pushed it up the list — exactly the review most worth
 * noticing, because somebody changed their mind in public. The upsert makes
 * refetching free of consequence, so correctness is bought with bandwidth
 * rather than with a cursor that can silently lose data. Recorded as decision
 * D23 in docs/architecture/current-state.md.
 */
export async function syncGoogleReviews(
  context: ServiceContext,
  input: SyncReviewsInput,
): Promise<SyncReviewsResult> {
  const target = await resolveSyncTarget(context, input.platformProfileId);
  const trigger = input.trigger ?? "manual";
  const startedAt = new Date().toISOString();

  // The lock. Enforced by a partial unique index, so two concurrent requests
  // cannot both open a run — see platform_sync_runs_one_active.
  let run: PlatformSyncRun;
  try {
    run = await context.dataSource.platformSyncRuns.start(context.scope, {
      platformConnectionId: target.connection.id,
      platformProfileId: target.profile.id,
      resource: REVIEW_RESOURCE,
      trigger,
      // A scheduled run has no person behind it, and attributing one to whoever
      // happened to connect Google months ago would be a lie in the audit trail.
      actorUserId: trigger === "manual" ? context.scope.userId : null,
      startedAt,
    });
  } catch (error) {
    // Losing this race is the system working, not a failure. It is translated
    // into a conflict so the caller renders a sentence rather than a generic
    // "something went wrong" — and deliberately *before* a run is opened, so
    // the refused attempt leaves no failed row in a history an operator reads
    // to judge whether the integration is healthy.
    if (error instanceof SyncRunInProgressError) {
      throw new DataError(
        "conflict",
        "A sync is already running for this location. Wait for it to finish before starting another.",
      );
    }
    throw error;
  }

  const counts: SyncCounts = { ...EMPTY_SYNC_COUNTS };
  let totalReviewCount: number | null = null;
  let pagesFetched = 0;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let fetchFailed = false;

  try {
    const credentials = await loadCredentials(
      context.dataSource,
      context.scope,
      target.connection.id,
    );

    if (!credentials) {
      throw new DataError(
        "unavailable",
        "This Google connection has no stored credentials. Reauthorize to reconnect it.",
      );
    }

    // The session carries a write-back closure, so a token refreshed on the
    // way into the first page is persisted immediately rather than being
    // refreshed again on the next sync.
    const session = credentialSession(
      context.dataSource,
      context.scope,
      target.connection.id,
      credentials.credentials,
    );

    const batch = await getGoogleConnector().listExternalReviews(
      session,
      target.externalAccountId,
      target.profile.externalProfileId,
    );

    totalReviewCount = batch.totalReviewCount;
    pagesFetched = batch.pagesFetched;
    counts.fetched = batch.reviews.length + batch.malformedCount;
    // Items Google sent that could not be normalised. Counted, not thrown: one
    // unusable review must not cost a location its other nine hundred.
    counts.failed = batch.malformedCount;

    const syncedAt = new Date().toISOString();

    for (const review of batch.reviews) {
      try {
        const result = await context.dataSource.mentions.ingest(
          context.scope,
          reviewToMentionInput(
            review,
            { profile: target.profile, connectionId: target.connection.id },
            syncedAt,
          ),
        );

        if (result.outcome === "created") counts.created += 1;
        else if (result.outcome === "updated") counts.updated += 1;
        else counts.unchanged += 1;
      } catch (error) {
        // Per item, for the same reason. The review id is not recorded in the
        // error text: it is Google's identifier for a customer's review, and it
        // does not belong in a message a browser renders.
        counts.failed += 1;
        if (!errorCode) {
          errorCode = error instanceof DataError ? error.code : "ingest_failed";
          errorMessage =
            "Some reviews could not be stored. Try the sync again, and let your administrator know if it keeps happening.";
        }
      }
    }
  } catch (error) {
    fetchFailed = true;
    errorCode = codeFor(error);
    errorMessage = messageFor(error).slice(0, MAX_ERROR_LENGTH);

    // A credential or permission failure is a fact about the connection, not
    // about this one sync, so it moves connection health too. Otherwise the
    // integrations screen would keep showing "healthy" beside a location that
    // has not imported anything for a week.
    if (error instanceof IntegrationError) {
      await recordConnectionFailureHealth(context, target.connection, error);
    }
  }

  // Nothing was fetched, so nothing about this location's data is fresher than
  // it was. Some reviews landed and some did not, so it partly is.
  const status = fetchFailed
    ? "failed"
    : counts.failed > 0
      ? "partial"
      : "completed";

  const completedAt = new Date().toISOString();

  const finished = await context.dataSource.platformSyncRuns.finish(
    context.scope,
    run.id,
    {
      status,
      completedAt,
      counts,
      pagesFetched,
      totalReviewCount,
      errorCode,
      errorMessage: errorMessage ? errorMessage.slice(0, MAX_ERROR_LENGTH) : null,
    },
  );

  // Only a run that actually refreshed the data moves the profile's
  // last-synced marker. A failed run leaving it alone is what stops the screen
  // saying "synced a minute ago" beside an error.
  if (isSuccessfulSyncRun(finished)) {
    await context.dataSource.platformProfiles.markSynced(
      context.scope,
      target.profile.id,
      completedAt,
    );
  }

  await recordAuditEvent(context, {
    eventType: fetchFailed
      ? "integration.review_sync_failed"
      : "integration.reviews_synced",
    entityType: "platform_profile",
    entityId: target.profile.id,
    previousState: { lastSyncedAt: target.profile.lastSyncedAt },
    newState: {
      lastSyncedAt: isSuccessfulSyncRun(finished)
        ? completedAt
        : target.profile.lastSyncedAt,
      status,
    },
    // Counts and a normalised code. No review text, no reviewer name, no
    // provider message, no token — an auditor needs the shape of what moved,
    // not a second copy of the customer's words.
    metadata: {
      platform: GOOGLE_PLATFORM,
      syncRunId: finished.id,
      trigger,
      fetched: counts.fetched,
      created: counts.created,
      updated: counts.updated,
      unchanged: counts.unchanged,
      failed: counts.failed,
      errorCode: errorCode ?? "",
    },
    // A scheduled run is not a person doing something.
    actorType: trigger === "manual" ? "user" : "integration",
  });

  return {
    syncRunId: finished.id,
    platformProfileId: target.profile.id,
    status: finished.status,
    counts,
    totalReviewCount,
    lastSuccessfulSyncAt: isSuccessfulSyncRun(finished)
      ? completedAt
      : target.profile.lastSyncedAt,
    errorMessage: finished.errorMessage,
    errorCode: finished.errorCode,
  };
}

/* -------------------------------------------------------------------------- */
/* Status for the UI                                                           */
/* -------------------------------------------------------------------------- */

/** One connected location, with everything the integration screen renders. */
export interface ConnectedLocationStatus {
  profile: PlatformProfile;
  /** The Lia location this profile is mapped to, when it is mapped. */
  locationName: string | null;
  /** Reviews imported into the canonical model for this profile. */
  importedReviewCount: number;
  sync: ProfileSyncState;
  /** True while a run holds the lock, so the UI can disable the button. */
  syncing: boolean;
}

/**
 * The per-location sync state for one connection.
 *
 * Assembled here rather than in the page so the route handler, the action, and
 * the screen all read the same shape — and so "imported review count" means the
 * same thing in each.
 */
export async function listConnectedLocationStatus(
  context: ServiceContext,
  connectionId: string,
): Promise<ConnectedLocationStatus[]> {
  const [profiles, locations] = await Promise.all([
    context.dataSource.platformProfiles.listForConnection(context.scope, connectionId),
    context.dataSource.locations.list(context.scope),
  ]);

  const active = profiles.filter((profile) => profile.status !== "disconnected");
  const profileIds = active.map((profile) => profile.id);

  const [counts, syncState] = await Promise.all([
    context.dataSource.mentions.countByProfile(context.scope, profileIds),
    context.dataSource.platformSyncRuns.latestForProfiles(
      context.scope,
      profileIds,
      REVIEW_RESOURCE,
    ),
  ]);

  const locationsById = new Map(locations.map((location) => [location.id, location]));

  return active.map((profile) => {
    const sync = syncState[profile.id] ?? { latest: null, lastSuccessful: null };

    return {
      profile,
      locationName: profile.locationId
        ? (locationsById.get(profile.locationId)?.name ?? null)
        : null,
      importedReviewCount: counts[profile.id] ?? 0,
      sync,
      syncing: sync.latest?.status === "running",
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Error shaping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A normalised code for the sync record.
 *
 * Lia's own vocabulary throughout. A Google status string stored here would be
 * rendered on a screen and quoted in a support ticket, and it quotes request
 * URLs.
 */
function codeFor(error: unknown): string {
  if (error instanceof IntegrationError) return error.code;
  if (error instanceof DataError) return error.code;
  return "unknown";
}

function messageFor(error: unknown): string {
  if (error instanceof IntegrationError) return toIntegrationMessage(error);
  if (error instanceof DataError) return error.message;
  return "Lia could not import reviews for this location. Try again shortly.";
}
