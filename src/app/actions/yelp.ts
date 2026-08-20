"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  captureYelpReviewInputSchema,
  type PlatformProfile,
  type YelpActivityOccurrence,
} from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { notFound } from "@/lib/data/errors";
import { captureYelpReview, type CaptureYelpReviewResult } from "@/lib/yelp/capture";
import { checkYelpListing, type YelpCheckOutcome } from "@/lib/yelp/check-service";
import {
  connectYelpListing,
  connectYelpListingInputSchema,
  disconnectYelpListing,
  searchYelpListings,
  searchYelpListingsInputSchema,
  type YelpSearchResult,
} from "@/lib/yelp/connect";
import { getYelpProvider } from "@/yelp/registry";

/**
 * Yelp Assisted server actions.
 *
 * Every one of these goes through `authorize()` before touching the data
 * source, and none of them is the only check: the repositories are
 * organization-scoped by type, and row-level security restates the role lists
 * underneath. The permissions used here are deliberate choices rather than
 * conveniences:
 *
 * - **`integration.manage_profiles`** for connecting and disconnecting a
 *   listing. Mapping a listing to a restaurant is the same class of decision as
 *   mapping a Google location — consequential, reversible, and the day-to-day
 *   work of running the integration. Not `integration.connect`, which is about
 *   granting Lia standing authority over an account; there is no account here.
 *
 * - **`monitoring.poll_now`** for checking a listing on demand. It spends a
 *   request against the shared Yelp budget and fills the queue these roles are
 *   accountable for, exactly as a manual news poll does.
 *
 * - **`mention.capture_manual`** for adding a review and for resolving the
 *   activity that prompted it. Both are the same act from the customer's point
 *   of view — dealing with a detected change — and splitting them would mean a
 *   person could add the review but not clear the notice about it.
 */

/* -------------------------------------------------------------------------- */
/* Connecting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Find candidate Yelp listings for one location.
 *
 * Read-only against Yelp and writes nothing, but still permission-gated: it
 * spends a request against a budget shared by every tenant, and it reads a
 * location's address out of the database.
 */
export async function searchYelpListingsAction(
  input: unknown,
): Promise<ActionResult<YelpSearchResult>> {
  return runAction("yelp.search", async () => {
    const parsed = searchYelpListingsInputSchema.parse(input);
    const context = await authorize("integration.manage_profiles");

    return searchYelpListings(
      context.dataSource,
      context.scope,
      getYelpProvider(),
      parsed,
    );
  });
}

export async function connectYelpListingAction(
  input: unknown,
): Promise<ActionResult<PlatformProfile>> {
  return runAction("yelp.connect", async () => {
    const parsed = connectYelpListingInputSchema.parse(input);
    const context = await authorize("integration.manage_profiles");

    const profile = await connectYelpListing(
      context.dataSource,
      context.scope,
      getYelpProvider(),
      parsed,
      context.userId,
      new Date().toISOString(),
    );

    revalidatePath("/integrations");
    revalidatePath("/locations");

    return profile;
  });
}

export async function disconnectYelpListingAction(
  input: unknown,
): Promise<ActionResult<PlatformProfile>> {
  return runAction("yelp.disconnect", async () => {
    const { profileId } = z
      .object({ profileId: z.uuid() })
      .parse(input);
    // Disconnecting stops the checks and destroys nothing: mentions,
    // snapshots, occurrences, drafts, and audit rows all stay. Held at
    // `manage_profiles` rather than `integration.disconnect` for that reason —
    // this unmaps one listing, it does not withdraw an authorization.
    const context = await authorize("integration.manage_profiles");

    const profile = await disconnectYelpListing(
      context.dataSource,
      context.scope,
      profileId,
    );

    revalidatePath("/integrations");
    revalidatePath("/locations");

    return profile;
  });
}

/* -------------------------------------------------------------------------- */
/* Checking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Check one connected listing now.
 *
 * The interactive counterpart to the scheduled sweep, and the *only* way a
 * check runs until the deployment has a cron slot for it — see the rollout note
 * in `docs/integrations/yelp-assisted.md`. Same service, same lock, same
 * idempotency; only the trigger differs.
 */
export async function checkYelpListingAction(
  input: unknown,
): Promise<ActionResult<YelpCheckOutcome>> {
  return runAction("yelp.check", async () => {
    const { profileId } = z.object({ profileId: z.uuid() }).parse(input);
    const context = await authorize("monitoring.poll_now");

    const profiles = await context.dataSource.platformProfiles.list(context.scope);
    const profile = profiles.find((row) => row.id === profileId);
    if (!profile) throw notFound("Connected listing");

    const outcome = await checkYelpListing({
      dataSource: context.dataSource,
      scope: context.scope,
      profile,
      provider: getYelpProvider(),
      trigger: "manual",
      actorUserId: context.userId,
      now: new Date().toISOString(),
    });

    revalidatePath("/integrations");

    return outcome;
  });
}

/* -------------------------------------------------------------------------- */
/* Capturing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Add a Yelp review to Lia by hand.
 *
 * Returns the duplicate outcome rather than failing on one, so the interface
 * can show the review Lia already holds and offer the deliberate override. That
 * is the whole of the deduplication contract's user-facing half: nothing merges
 * silently, and nothing is refused without an explanation and a way forward.
 */
export async function captureYelpReviewAction(
  input: unknown,
): Promise<ActionResult<CaptureYelpReviewResult>> {
  return runAction("yelp.capture", async () => {
    const parsed = captureYelpReviewInputSchema.parse(input);
    const context = await authorize("mention.capture_manual");

    const result = await captureYelpReview({
      dataSource: context.dataSource,
      scope: context.scope,
      input: parsed,
      actorUserId: context.userId,
      now: new Date().toISOString(),
    });

    if (result.outcome === "captured") {
      // The captured review is an ordinary mention from here on: it appears in
      // the inbox, the analysis sweep picks it up, and the rest of the pipeline
      // treats it exactly as it treats an imported one.
      revalidatePath("/mentions");
      revalidatePath("/integrations");
    }

    return result;
  });
}

/**
 * Dismiss a detected change without adding a review.
 *
 * A real and common outcome rather than an edge case: a review count can move
 * because Yelp reclassified something, or because a review was removed, and
 * neither is a thing to answer. Dismissing records that somebody looked.
 */
export async function dismissYelpActivityAction(
  input: unknown,
): Promise<ActionResult<YelpActivityOccurrence>> {
  return runAction("yelp.dismiss_activity", async () => {
    const { occurrenceId } = z.object({ occurrenceId: z.uuid() }).parse(input);
    const context = await authorize("mention.capture_manual");

    const occurrence = await context.dataSource.yelpActivityOccurrences.resolve(
      context.scope,
      {
        occurrenceId,
        status: "dismissed",
        capturedMentionId: null,
        resolvedByUserId: context.userId,
        resolvedAt: new Date().toISOString(),
      },
    );

    revalidatePath("/integrations");

    return occurrence;
  });
}
