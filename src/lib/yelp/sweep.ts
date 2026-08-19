import "server-only";

import { SYSTEM_ACTOR_ID } from "@/lib/cron/system-actor";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { yelpMaxChecksPerSweep } from "@/lib/env";
import { checkYelpListing } from "@/lib/yelp/check-service";
import { YelpError } from "@/yelp/errors";
import type { YelpPlacesProvider } from "@/yelp/places";

/**
 * One scheduled pass over every connected Yelp listing.
 *
 * Carries its own tenancy discipline, because there is no verified human behind
 * it and `getOrganizationContext()` has no request session to resolve (D88).
 * The scope handed to each check is built from that organization's own id,
 * never from anything ambient.
 *
 * The request budget is enforced **above** the tenant loop, following D85's
 * reasoning applied to Yelp: the Places allowance is metered per API key and
 * the key is Lia's, so one organization with forty connected listings can
 * otherwise exhaust the day for every other customer. A sweep that stops early
 * reports how many listings it did not reach rather than reading as full
 * coverage.
 */

export interface YelpSweepOptions {
  dataSource: LiaDataSource;
  provider: YelpPlacesProvider;
  now: string;
  /** Overrides the configured budget. Tests use it; nothing else should. */
  limit?: number;
}

export interface YelpSweepResult {
  checked: number;
  /** Listings whose counters moved. Never a count of reviews. */
  changesDetected: number;
  failed: number;
  /** A check was already running for the listing. Not an error. */
  skipped: number;
  /**
   * Listings the budget did not reach.
   *
   * Reported rather than swallowed, for the reason the news sweep reports its
   * own: a pass that checked eight of forty listings must not read as a quiet
   * day across all forty.
   */
  skippedForBudget: number;
  /**
   * True when the provider refused in a way that will refuse again.
   *
   * An exhausted rate limit or a rejected key means every remaining check would
   * fail the same way, so the sweep stops rather than burning the rest of the
   * pass — and rather than writing forty identical failure rows an operator has
   * to read through.
   */
  abortedEarly: boolean;
}

/**
 * Organizations with at least one connected Yelp listing, and their listings.
 *
 * A deliberate cross-tenant read, in the same narrow shape as
 * `MonitoringQueryRepository.listDue` and
 * `OrganizationRepository.listWithUnanalyzedMentions`: cron holds no membership
 * and cannot construct a scope any other way. It is service-role only, it is
 * unreachable from a request path, and what carries tenancy from here is the
 * per-row `OrganizationScope` built below.
 */
export async function sweepYelpListings(
  options: YelpSweepOptions,
): Promise<YelpSweepResult> {
  const { dataSource, provider, now } = options;
  const budget = options.limit ?? yelpMaxChecksPerSweep();

  const result: YelpSweepResult = {
    checked: 0,
    changesDetected: 0,
    failed: 0,
    skipped: 0,
    skippedForBudget: 0,
    abortedEarly: false,
  };

  const organizationIds = await dataSource.organizations.listWithYelpListings();

  for (const organizationId of organizationIds) {
    // Built from the row's own organization id, never from anything ambient.
    // `userId` is the system sentinel: it never reaches a foreign key, because
    // a scheduled check writes no actor onto a run (D88).
    const scope: OrganizationScope = {
      organizationId,
      userId: SYSTEM_ACTOR_ID,
      role: "owner",
    };

    const connection = await dataSource.platformConnections.getByPlatform(
      scope,
      "yelp",
    );
    if (!connection || connection.status === "disconnected") continue;

    const profiles = await dataSource.platformProfiles.listForConnection(
      scope,
      connection.id,
    );

    for (const profile of profiles) {
      if (profile.status === "disconnected") continue;

      if (result.checked + result.failed >= budget) {
        result.skippedForBudget += 1;
        continue;
      }

      const outcome = await checkYelpListing({
        dataSource,
        scope,
        profile,
        provider,
        trigger: "scheduled",
        actorUserId: null,
        now,
      });

      if (outcome.status === "skipped") {
        result.skipped += 1;
        continue;
      }

      if (outcome.status === "failed") {
        result.failed += 1;
        // A rejected key or an exhausted allowance will refuse every remaining
        // check identically. Stopping is both cheaper and kinder to whoever
        // reads the run history afterwards.
        if (isTerminalForSweep(outcome.errorCode)) {
          result.abortedEarly = true;
          return result;
        }
        continue;
      }

      result.checked += 1;
      if (outcome.occurrence && outcome.occurrenceCreated) {
        result.changesDetected += 1;
      }
    }
  }

  return result;
}

/** Failures that will repeat for every remaining listing this pass. */
function isTerminalForSweep(errorCode: string | null): boolean {
  return (
    errorCode === "rate_limited" ||
    errorCode === "unauthorized" ||
    errorCode === "plan_restricted" ||
    errorCode === "quota_exhausted" ||
    errorCode === "not_configured"
  );
}

export { YelpError };
