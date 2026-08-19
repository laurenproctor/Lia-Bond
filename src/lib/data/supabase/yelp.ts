import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { conflict, DataError, notFound } from "@/lib/data/errors";
import type {
  YelpActivityOccurrenceRepository,
  YelpListingSnapshotRepository,
} from "@/lib/data/types";
import {
  toYelpActivityOccurrence,
  toYelpListingSnapshot,
} from "@/lib/data/supabase/mappers";

/**
 * The Supabase adapter for Yelp Assisted.
 *
 * Its own file rather than more lines in `supabase/index.ts`, which is already
 * the largest module in the data layer — the same decision `supabase/
 * monitoring.ts` made, and this mirrors `demo/yelp.ts` behaviourally.
 *
 * Two things here are load-bearing and differ from the demo twin:
 *
 * 1. **The occurrence insert absorbs a unique violation rather than checking
 *    first.** `yelp_activity_occurrences_unique_transition` is the
 *    deduplication; a read-then-insert would be two statements with a race
 *    between them, and two concurrent checks observing the same transition is
 *    precisely that race (D24). The `23505` arm re-reads and returns the
 *    winner's row with `created: false`.
 *
 * 2. **The confirmation update is guarded in its own WHERE clause.** Filtering
 *    on `status = 'approved'` means a second click matches no rows and reports
 *    `already_confirmed` — the compare-and-set discipline
 *    `complete_generation_attempt` established, rather than reading the status
 *    and then writing.
 *
 * NOTE: this adapter's write paths have been exercised against a local Postgres
 * through the SQL harness, not through PostgREST. See the note at the top of
 * `index.ts`.
 */

type Row = Record<string, unknown>;

/**
 * `rows` and `fail` are duplicated from `index.ts` rather than imported from
 * it, for the same reason `supabase/monitoring.ts` duplicates them: `index.ts`
 * imports this module to wire it into the returned data source, so importing
 * back would be a circular dependency.
 */
function rows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

function fail(error: { message: string; code?: string }, action: string): never {
  if (error.code === "23505") {
    throw conflict("That record already exists.");
  }
  if (error.code === "42501" || error.code === "PGRST301") {
    throw new DataError("forbidden", "You don't have permission to do that.");
  }
  throw new DataError("unavailable", `Could not ${action}. Please try again.`);
}

/** The PostgREST code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

export function createYelpRepositories(client: SupabaseClient): {
  yelpListingSnapshots: YelpListingSnapshotRepository;
  yelpActivityOccurrences: YelpActivityOccurrenceRepository;
} {
  return {
    yelpListingSnapshots: {
      async record(scope, input) {
        const { data, error } = await client
          .from("yelp_listing_snapshots")
          .insert({
            organization_id: scope.organizationId,
            platform_profile_id: input.platformProfileId,
            sync_run_id: input.syncRunId,
            observed_at: input.observedAt,
            review_count: input.reviewCount,
            rating: input.rating,
            is_closed: input.isClosed,
          })
          .select()
          .single();

        if (error) fail(error, "record what Yelp reported");
        return toYelpListingSnapshot(data as Row);
      },

      async latestForProfile(scope, profileId) {
        const { data, error } = await client
          .from("yelp_listing_snapshots")
          .select()
          .eq("organization_id", scope.organizationId)
          .eq("platform_profile_id", profileId)
          // Ordered by what Lia *saw*, not by insertion, so a backfilled
          // observation cannot be mistaken for the latest.
          .order("observed_at", { ascending: false })
          .limit(1);

        if (error) fail(error, "read the last Yelp listing check");
        const row = rows(data)[0];
        return row ? toYelpListingSnapshot(row) : null;
      },

      async listForProfile(scope, profileId, limit = 50) {
        const { data, error } = await client
          .from("yelp_listing_snapshots")
          .select()
          .eq("organization_id", scope.organizationId)
          .eq("platform_profile_id", profileId)
          .order("observed_at", { ascending: false })
          .limit(limit);

        if (error) fail(error, "read Yelp listing history");
        return rows(data).map(toYelpListingSnapshot);
      },
    },

    yelpActivityOccurrences: {
      async record(scope, input) {
        const { data, error } = await client
          .from("yelp_activity_occurrences")
          .insert({
            organization_id: scope.organizationId,
            platform_profile_id: input.platformProfileId,
            location_id: input.locationId,
            from_snapshot_id: input.fromSnapshotId,
            to_snapshot_id: input.toSnapshotId,
            detected_at: input.detectedAt,
            change_kind: input.changeKind,
            previous_review_count: input.previousReviewCount,
            current_review_count: input.currentReviewCount,
            previous_rating: input.previousRating,
            current_rating: input.currentRating,
            status: "open",
          })
          .select()
          .single();

        if (!error) {
          return { occurrence: toYelpActivityOccurrence(data as Row), created: true };
        }

        // Somebody else recorded this same transition first. That is the
        // index doing its job, not a failure: re-read and hand back their row.
        // Absorbed only for this specific code — any other error is a real
        // problem and must not be swallowed into a silent "already existed".
        if (error.code !== UNIQUE_VIOLATION) {
          fail(error, "record the Yelp review activity");
        }

        const { data: existing, error: readError } = await client
          .from("yelp_activity_occurrences")
          .select()
          .eq("organization_id", scope.organizationId)
          .eq("platform_profile_id", input.platformProfileId)
          .eq("from_snapshot_id", input.fromSnapshotId)
          .eq("to_snapshot_id", input.toSnapshotId)
          .limit(1);

        if (readError) fail(readError, "read the Yelp review activity");
        const row = rows(existing)[0];
        // The insert said this row exists and the read says it does not. That
        // is not a race this code can resolve by guessing — it means the two
        // statements disagree about the tenant or the index, and reporting it
        // is better than fabricating an occurrence or silently doing nothing.
        if (!row) {
          throw new DataError(
            "unavailable",
            "Could not record the Yelp review activity. Please try again.",
          );
        }

        return { occurrence: toYelpActivityOccurrence(row), created: false };
      },

      async get(scope, occurrenceId) {
        const { data, error } = await client
          .from("yelp_activity_occurrences")
          .select()
          .eq("organization_id", scope.organizationId)
          .eq("id", occurrenceId)
          .limit(1);

        if (error) fail(error, "read the Yelp review activity");
        const row = rows(data)[0];
        return row ? toYelpActivityOccurrence(row) : null;
      },

      async list(scope, filter = {}) {
        let query = client
          .from("yelp_activity_occurrences")
          .select()
          .eq("organization_id", scope.organizationId);

        if (filter.platformProfileId) {
          query = query.eq("platform_profile_id", filter.platformProfileId);
        }
        if (filter.locationId) query = query.eq("location_id", filter.locationId);
        if (filter.statuses && filter.statuses.length > 0) {
          query = query.in("status", filter.statuses);
        }

        const offset = filter.offset ?? 0;
        const limit = filter.limit ?? 50;
        const { data, error } = await query
          .order("detected_at", { ascending: false })
          .range(offset, offset + limit - 1);

        if (error) fail(error, "list Yelp review activity");
        return rows(data).map(toYelpActivityOccurrence);
      },

      async countOpen(scope) {
        const { count, error } = await client
          .from("yelp_activity_occurrences")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", scope.organizationId)
          .eq("status", "open");

        if (error) fail(error, "count open Yelp review activity");
        return count ?? 0;
      },

      async resolve(scope, input) {
        const { data, error } = await client
          .from("yelp_activity_occurrences")
          .update({
            status: input.status,
            // The pairing `yelp_activity_capture_pairing` enforces: only a
            // captured resolution names a review.
            captured_mention_id:
              input.status === "captured" ? input.capturedMentionId : null,
            resolved_by_user_id: input.resolvedByUserId,
            resolved_at: input.resolvedAt,
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", input.occurrenceId)
          // The guard, in the WHERE clause rather than in a prior read. Two
          // people resolving the same item means the second matches no rows,
          // instead of silently overwriting who dealt with it and how.
          .eq("status", "open")
          .select()
          .maybeSingle();

        if (error) fail(error, "record how this review activity was handled");

        if (!data) {
          // No row matched. Either the occurrence does not exist for this
          // tenant, or it was already resolved — distinguished by a second read
          // so the person is told which, rather than "something went wrong".
          const { data: existing } = await client
            .from("yelp_activity_occurrences")
            .select("id")
            .eq("organization_id", scope.organizationId)
            .eq("id", input.occurrenceId)
            .limit(1);

          if (rows(existing).length === 0) throw notFound("Yelp review activity");
          throw conflict("This review activity has already been handled.");
        }

        return toYelpActivityOccurrence(data as Row);
      },
    },
  };
}
