"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { SyncCounts } from "@/domain";
import type { ExternalAccount } from "@/integrations/connector";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import {
  syncGoogleReviews,
  type SyncReviewsResult,
} from "@/lib/integrations/google-reviews";
import {
  saveGoogleLocationMappings,
  saveMappingsInputSchema,
  type SaveMappingsResult,
} from "@/lib/integrations/google-mapping";
import {
  buildCandidates,
  checkGoogleConnectionHealth,
  disconnectGoogle,
  listGoogleBusinessAccounts,
  listGoogleBusinessLocations,
  type LocationCandidate,
} from "@/lib/integrations/google-service";

/**
 * Integration server actions.
 *
 * Each one follows the shape the rest of the application uses: `authorize()`
 * names a permission from the central matrix, the service layer does the work,
 * and `runAction()` turns anything that escapes into a typed failure — including
 * provider and configuration errors, which it renders in Lia's own words.
 *
 * None of these accepts or returns a credential. The mapping action takes
 * Google location ids, and the service re-fetches them from Google rather than
 * trusting what the browser sent.
 */

const INTEGRATION_PATHS = [
  "/integrations",
  "/integrations/google-business-profile",
  "/integrations/google-business-profile/setup",
];

function revalidateIntegrations(): void {
  for (const path of INTEGRATION_PATHS) revalidatePath(path);
}

const connectionIdSchema = z.object({ connectionId: z.uuid() });

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

export async function listGoogleAccountsAction(
  input: unknown,
): Promise<ActionResult<ExternalAccount[]>> {
  return runAction("integration.list_accounts", async () => {
    const { connectionId } = connectionIdSchema.parse(input);
    const context = await authorize("integration.manage_profiles");
    return listGoogleBusinessAccounts(context, connectionId);
  });
}

const discoverSchema = z.object({
  connectionId: z.uuid(),
  externalAccountId: z.string().min(1).max(200),
});

/**
 * Discover the locations under one Google account, annotated with what Lia knows.
 *
 * Returns candidates rather than raw listings. The screen needs to know which
 * are already connected and which have a plausible match, and deriving that on
 * the client would mean shipping the whole location table to the browser.
 */
export async function discoverGoogleLocationsAction(
  input: unknown,
): Promise<ActionResult<LocationCandidate[]>> {
  return runAction("integration.discover_locations", async () => {
    const { connectionId, externalAccountId } = discoverSchema.parse(input);
    const context = await authorize("integration.manage_profiles");

    const [profiles, existing, locations] = await Promise.all([
      listGoogleBusinessLocations(context, connectionId, externalAccountId),
      context.dataSource.platformProfiles.listForConnection(context.scope, connectionId),
      context.dataSource.locations.list(context.scope),
    ]);

    return buildCandidates(profiles, existing, locations);
  });
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Save location mappings.
 *
 * Succeeds with per-row failures rather than aborting on the first collision:
 * someone who mapped nine locations correctly and one that clashed should keep
 * the nine and be told precisely which one did not take.
 */
export async function saveGoogleMappingsAction(
  input: unknown,
): Promise<ActionResult<SaveMappingsResult>> {
  return runAction("integration.save_mappings", async () => {
    const parsed = saveMappingsInputSchema.parse(input);
    const context = await authorize("integration.manage_profiles");

    const result = await saveGoogleLocationMappings(context, parsed);

    revalidateIntegrations();
    // Creating a location from a Google listing changes the portfolio.
    revalidatePath("/locations");

    return result;
  });
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export interface ConnectionTestOutcome {
  status: string;
  /** Null when healthy; a sentence a person can act on otherwise. */
  message: string | null;
  checkedAt: string;
}

export async function testGoogleConnectionAction(
  input: unknown,
): Promise<ActionResult<ConnectionTestOutcome>> {
  return runAction("integration.test_connection", async () => {
    const { connectionId } = connectionIdSchema.parse(input);
    const context = await authorize("integration.test_connection");

    const { health } = await checkGoogleConnectionHealth(context, connectionId);
    revalidateIntegrations();

    return {
      status: health.status,
      message: health.message,
      checkedAt: health.checkedAt,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Review sync                                                                 */
/* -------------------------------------------------------------------------- */

const syncReviewsSchema = z.object({ platformProfileId: z.uuid() });

export interface ReviewSyncOutcome {
  syncRunId: string;
  status: string;
  counts: SyncCounts;
  totalReviewCount: number | null;
  lastSuccessfulSyncAt: string | null;
  /** What to tell the user. Never claims an import that did not happen. */
  message: string;
  /** True when the outcome needs the amber treatment rather than the green. */
  degraded: boolean;
}

/**
 * Import reviews for one connected Google location.
 *
 * The action is a thin wrapper: authorise, call the service, revalidate. All
 * the ordering — lock, refresh, fetch, upsert, record, audit — lives in
 * `syncGoogleReviews`, so the API route and a future scheduled job get
 * identical behaviour rather than a second implementation of the same sequence.
 *
 * A concurrent sync is reported as information, not as an error. Somebody else
 * pressing the button first is the system working.
 */
export async function syncGoogleReviewsAction(
  input: unknown,
): Promise<ActionResult<ReviewSyncOutcome>> {
  return runAction("integration.sync_reviews", async () => {
    const { platformProfileId } = syncReviewsSchema.parse(input);
    const context = await authorize("integration.sync_reviews");

    const result = await syncGoogleReviews(context, { platformProfileId });

    revalidateIntegrations();
    // Imported reviews land in the unified inbox and every roll-up over it, so
    // a sync that changed nothing on the integrations screen still changes
    // these. Revalidated here rather than in the service: cache invalidation is
    // a framework concern, and the service is what a job will call.
    if (result.counts.created > 0 || result.counts.updated > 0) {
      for (const path of ["/mentions", "/reviews", "/overview", "/insights"]) {
        revalidatePath(path);
      }
    }

    return {
      syncRunId: result.syncRunId,
      status: result.status,
      counts: result.counts,
      totalReviewCount: result.totalReviewCount,
      lastSuccessfulSyncAt: result.lastSuccessfulSyncAt,
      message: describeSyncOutcome(result),
      degraded: result.status !== "completed",
    };
  });
}

/**
 * One sentence about what the sync did.
 *
 * Written here rather than in the component so the API route and the screen
 * cannot describe the same run differently — and phrased around counts rather
 * than status words, because "partial" means nothing to somebody who just
 * wanted their reviews.
 */
function describeSyncOutcome(result: SyncReviewsResult): string {
  if (result.status === "failed") {
    return (
      result.errorMessage ??
      "Lia could not import reviews for this location. Try again shortly."
    );
  }

  const { created, updated, unchanged, failed } = result.counts;

  const parts: string[] = [];
  if (created > 0) parts.push(`${created} new`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (unchanged > 0 && parts.length === 0) parts.push(`${unchanged} already up to date`);

  const summary =
    parts.length > 0
      ? `Imported ${parts.join(", ")}.`
      : "No reviews were found for this location.";

  if (failed > 0) {
    return `${summary} ${failed} could not be imported — the rest were saved.`;
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Disconnect                                                                  */
/* -------------------------------------------------------------------------- */

export interface DisconnectOutcome {
  profilesDeactivated: number;
  remoteRevocationConfirmed: boolean;
  /** What to tell the user. Never claims a revocation Google did not confirm. */
  message: string;
}

/**
 * Disconnect Google.
 *
 * The message distinguishes a confirmed revocation from an unconfirmed one.
 * Saying "revoked" when Google never answered would leave a live credential
 * behind a UI claiming otherwise, and the administrator would have no reason to
 * go and revoke it themselves.
 */
export async function disconnectGoogleAction(): Promise<
  ActionResult<DisconnectOutcome>
> {
  return runAction("integration.disconnect", async () => {
    const context = await authorize("integration.disconnect");
    const result = await disconnectGoogle(context);

    revalidateIntegrations();
    revalidatePath("/locations");

    return {
      profilesDeactivated: result.profilesDeactivated,
      remoteRevocationConfirmed: result.remoteRevocationConfirmed,
      message: result.remoteRevocationConfirmed
        ? "Google is disconnected and its access was revoked. Your locations and mappings were kept."
        : "Google is disconnected and Lia's stored credentials were deleted. Google did not confirm the revocation, so remove Lia from your Google account settings if you want to be certain.",
    };
  });
}
