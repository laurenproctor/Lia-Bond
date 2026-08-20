import {
  yelpActivityOccurrenceSchema,
  yelpListingSnapshotSchema,
  type YelpActivityOccurrence,
  type YelpListingSnapshot,
} from "@/domain";
import { conflict, notFound } from "@/lib/data/errors";
import { demoRuntimeStore, replaceRow, scoped } from "@/lib/data/demo/store";
import type {
  OrganizationScope,
  YelpActivityOccurrenceRepository,
  YelpListingSnapshotRepository,
} from "@/lib/data/types";
import { REFERENCE_NOW } from "@/lib/seed/clock";
import { seedId } from "@/lib/seed/ids";

/**
 * The demo adapter for Yelp Assisted.
 *
 * Its own file rather than another few hundred lines in `demo/index.ts`,
 * following the precedent `demo/monitoring.ts` set. The behaviour mirrors the
 * Supabase adapter deliberately — in particular the two places where this one
 * has to *simulate* a database guarantee rather than inherit it:
 *
 * 1. **Occurrence idempotency.** Postgres enforces it with
 *    `yelp_activity_occurrences_unique_transition`. Here the lookup on the same
 *    three columns is the equivalent, and it is genuinely equivalent in demo
 *    mode for a reason worth stating: this store is single-threaded and lives
 *    in one process, so the check-then-insert race the index exists to prevent
 *    cannot occur. The Supabase adapter must not reason that way, and does not.
 *
 * 2. **Confirmation idempotency.** The Supabase adapter guards its update on
 *    `status = 'approved'` in the WHERE clause so a second click matches no
 *    rows. Here the status is read and compared, which is the same decision
 *    reached the only way an in-memory store can reach it.
 */

function nowIso(): string {
  // Demo mode runs on the seed clock so timestamps stay reproducible.
  return REFERENCE_NOW;
}

function orgRows<T extends { organizationId: string }>(
  rows: T[],
  scope: OrganizationScope,
): T[] {
  return scoped(rows, scope.organizationId);
}

export function createYelpRepositories(): {
  yelpListingSnapshots: YelpListingSnapshotRepository;
  yelpActivityOccurrences: YelpActivityOccurrenceRepository;
} {
  return {
    yelpListingSnapshots: {
      async record(scope, input) {
        const runtime = demoRuntimeStore();
        runtime.yelpListingSnapshotSequence += 1;

        const snapshot: YelpListingSnapshot = yelpListingSnapshotSchema.parse({
          id: seedId(
            `yelp-snapshot:${scope.organizationId}:${runtime.yelpListingSnapshotSequence}`,
          ),
          organizationId: scope.organizationId,
          platformProfileId: input.platformProfileId,
          syncRunId: input.syncRunId,
          observedAt: input.observedAt,
          reviewCount: input.reviewCount,
          rating: input.rating,
          isClosed: input.isClosed,
          createdAt: nowIso(),
        });

        runtime.yelpListingSnapshots.push(snapshot);
        return snapshot;
      },

      async latestForProfile(scope, profileId) {
        return (
          orgRows(demoRuntimeStore().yelpListingSnapshots, scope)
            .filter((row) => row.platformProfileId === profileId)
            // Newest first, and by `observedAt` rather than insertion order:
            // the check service compares against what Lia last *saw*, and a
            // backfilled observation must not be treated as the latest.
            .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] ?? null
        );
      },

      async listForProfile(scope, profileId, limit = 50) {
        return orgRows(demoRuntimeStore().yelpListingSnapshots, scope)
          .filter((row) => row.platformProfileId === profileId)
          .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
          .slice(0, limit);
      },
    },

    yelpActivityOccurrences: {
      async record(scope, input) {
        const runtime = demoRuntimeStore();

        // The twin of `yelp_activity_occurrences_unique_transition`. Scoped by
        // the same three columns the index names, so a replay of the same
        // observed transition returns the stored row rather than adding a
        // second notice about one change.
        const existing = orgRows(runtime.yelpActivityOccurrences, scope).find(
          (row) =>
            row.platformProfileId === input.platformProfileId &&
            row.fromSnapshotId === input.fromSnapshotId &&
            row.toSnapshotId === input.toSnapshotId,
        );
        if (existing) return { occurrence: existing, created: false };

        runtime.yelpActivityOccurrenceSequence += 1;
        const timestamp = nowIso();

        const occurrence: YelpActivityOccurrence =
          yelpActivityOccurrenceSchema.parse({
            id: seedId(
              `yelp-activity:${scope.organizationId}:${runtime.yelpActivityOccurrenceSequence}`,
            ),
            organizationId: scope.organizationId,
            platformProfileId: input.platformProfileId,
            locationId: input.locationId,
            fromSnapshotId: input.fromSnapshotId,
            toSnapshotId: input.toSnapshotId,
            detectedAt: input.detectedAt,
            changeKind: input.changeKind,
            previousReviewCount: input.previousReviewCount,
            currentReviewCount: input.currentReviewCount,
            previousRating: input.previousRating,
            currentRating: input.currentRating,
            status: "open",
            capturedMentionId: null,
            resolvedByUserId: null,
            resolvedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });

        runtime.yelpActivityOccurrences.push(occurrence);
        return { occurrence, created: true };
      },

      async get(scope, occurrenceId) {
        return (
          orgRows(demoRuntimeStore().yelpActivityOccurrences, scope).find(
            (row) => row.id === occurrenceId,
          ) ?? null
        );
      },

      async list(scope, filter = {}) {
        let rows = orgRows(demoRuntimeStore().yelpActivityOccurrences, scope);

        if (filter.platformProfileId) {
          rows = rows.filter(
            (row) => row.platformProfileId === filter.platformProfileId,
          );
        }
        if (filter.locationId) {
          rows = rows.filter((row) => row.locationId === filter.locationId);
        }
        if (filter.statuses && filter.statuses.length > 0) {
          const statuses = new Set(filter.statuses);
          rows = rows.filter((row) => statuses.has(row.status));
        }

        const sorted = rows.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
        const offset = filter.offset ?? 0;
        return sorted.slice(offset, offset + (filter.limit ?? 50));
      },

      async countOpen(scope) {
        return orgRows(demoRuntimeStore().yelpActivityOccurrences, scope).filter(
          (row) => row.status === "open",
        ).length;
      },

      async resolve(scope, input) {
        const runtime = demoRuntimeStore();
        const existing = orgRows(runtime.yelpActivityOccurrences, scope).find(
          (row) => row.id === input.occurrenceId,
        );
        if (!existing) throw notFound("Yelp review activity");

        // The twin of the Supabase adapter's `status = 'open'` guard. Two
        // people resolving the same item must not both succeed — the second is
        // told it is already handled rather than silently overwriting who dealt
        // with it and how.
        if (existing.status !== "open") {
          throw conflict("This review activity has already been handled.");
        }

        const updated: YelpActivityOccurrence = yelpActivityOccurrenceSchema.parse({
          ...existing,
          status: input.status,
          // The pairing `yelp_activity_capture_pairing` enforces in Postgres:
          // only a captured resolution names a review.
          capturedMentionId:
            input.status === "captured" ? input.capturedMentionId : null,
          resolvedByUserId: input.resolvedByUserId,
          resolvedAt: input.resolvedAt,
          updatedAt: nowIso(),
        });

        return replaceRow(runtime.yelpActivityOccurrences, updated);
      },
    },
  };
}
