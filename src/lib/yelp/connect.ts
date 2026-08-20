import "server-only";

import { z } from "zod";
import type { JsonObject, Location, PlatformProfile } from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import { conflict, notFound } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { ensureYelpConnection } from "@/lib/yelp/connection";
import { rankYelpCandidates, type YelpCandidateMatch } from "@/lib/yelp/matching";
import type { YelpPlacesProvider } from "@/yelp/places";
import { canonicalYelpBusinessUrl, normalizeYelpUrl } from "@/yelp/urls";

/**
 * Connecting a Yelp listing to a Lia location.
 *
 * The failure this module is arranged around is the same one
 * `google-mapping.ts` names: a wrong mapping routes one restaurant's review
 * activity into another's queue, and the damage is invisible until it is
 * embarrassing. So nothing here auto-applies, every candidate is shown with the
 * evidence a person can check, and the confirmation step re-fetches the chosen
 * listing server-side rather than trusting the id the browser sent.
 *
 * **This is a mapping, not an authorization.** A Yelp Places key authenticates
 * Lia and proves nothing about who owns the listing. There is no
 * business-owner OAuth in this integration, and no copy above this layer calls
 * the result a connected *account*.
 */

/* -------------------------------------------------------------------------- */
/* Searching                                                                   */
/* -------------------------------------------------------------------------- */

export const searchYelpListingsInputSchema = z.object({
  locationId: z.uuid(),
  /**
   * A wider free-text search, for when the address match found nothing.
   *
   * The term is the only user-supplied string that reaches Yelp, and it is
   * bounded here. The address never is: it is read from the location row
   * server-side, so a crafted request cannot use Lia's key to enumerate Yelp.
   */
  term: z.string().min(1).max(128).optional(),
});

export type SearchYelpListingsInput = z.infer<typeof searchYelpListingsInputSchema>;

export interface YelpSearchResult {
  location: Location;
  matches: YelpCandidateMatch[];
  /** True when the address match found nothing and this is the wider search. */
  usedFallback: boolean;
  requestsSpent: number;
}

/**
 * Candidates for one location, ranked.
 *
 * Tries the address match first — Yelp's `/matches` endpoint answers "is this
 * exact business on Yelp" and is the right question when the address is known.
 * Falls back to a term search only when it returns nothing, because a strict
 * match that silently comes back empty reads to a customer as "my restaurant
 * is not on Yelp" when it plainly is.
 */
export async function searchYelpListings(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  provider: YelpPlacesProvider,
  input: SearchYelpListingsInput,
): Promise<YelpSearchResult> {
  const location = await dataSource.locations.get(scope, input.locationId);
  if (!location) throw notFound("Location");

  const matched = await provider.matchBusinesses({
    name: location.name,
    addressLine1: location.addressLine1,
    addressLine2: location.addressLine2,
    city: location.city,
    region: location.region,
    postalCode: location.postalCode,
    countryCode: location.countryCode,
    // `locations` has no phone column yet — see the note in
    // `src/lib/integrations/matching.ts`. Passed as null rather than omitted so
    // the day the column exists, this is a one-line change.
    phone: null,
    limit: 10,
  });

  if (matched.candidates.length > 0) {
    return {
      location,
      matches: rankYelpCandidates(matched.candidates, location),
      usedFallback: false,
      requestsSpent: matched.requestsSpent,
    };
  }

  const searched = await provider.searchBusinesses({
    term: input.term?.trim() || location.name,
    location: `${location.city}, ${location.region} ${location.postalCode}`.trim(),
    limit: 10,
  });

  return {
    location,
    matches: rankYelpCandidates(searched.candidates, location),
    usedFallback: true,
    requestsSpent: matched.requestsSpent + searched.requestsSpent,
  };
}

/* -------------------------------------------------------------------------- */
/* Connecting                                                                  */
/* -------------------------------------------------------------------------- */

export const connectYelpListingInputSchema = z.object({
  locationId: z.uuid(),
  /** Yelp's opaque business id. Re-fetched server-side before anything is written. */
  businessId: z.string().min(1).max(200),
});

export type ConnectYelpListingInput = z.infer<typeof connectYelpListingInputSchema>;

/**
 * Persist the mapping.
 *
 * Re-fetches the chosen listing from Yelp before writing, for the reason
 * `saveMappings` states: a form field naming a business id is a claim, not
 * evidence. The re-fetch also supplies the display metadata and the canonical
 * URL, so nothing the browser sent is stored.
 */
export async function connectYelpListing(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  provider: YelpPlacesProvider,
  input: ConnectYelpListingInput,
  actorUserId: string,
  now: string,
): Promise<PlatformProfile> {
  const location = await dataSource.locations.get(scope, input.locationId);
  // The scope filter is what stops a caller mapping a listing onto another
  // organization's location by supplying its id.
  if (!location) throw notFound("Location");

  const connection = await ensureYelpConnection(dataSource, scope, actorUserId, now);
  if (!connection) throw notFound("Yelp connection");

  const existing = await dataSource.platformProfiles.listForConnection(
    scope,
    connection.id,
  );
  const active = existing.filter((profile) => profile.status !== "disconnected");

  // One listing per location. An application check rather than a constraint —
  // see the note in `20260818000100_yelp_assisted.sql` §5 for why an index is
  // unavailable without denormalising a shared table. The database *does*
  // guarantee the direction that matters (one external listing per connection,
  // via `platform_profiles_unique_external`); this is the reverse.
  const conflicting = active.find(
    (profile) =>
      profile.locationId === input.locationId &&
      profile.externalProfileId !== input.businessId,
  );
  if (conflicting) {
    throw conflict(
      "This location already has a Yelp listing connected. Disconnect it before connecting a different one.",
    );
  }

  // Evidence, not a claim: this is what Yelp says the listing is, right now.
  const listing = await provider.getBusiness(input.businessId);

  const profileUrl = resolveListingUrl(listing.profileUrl, listing.alias);
  const providerMetadata: JsonObject = {
    ...listing.metadata,
    ...(listing.alias ? { alias: listing.alias } : {}),
    // The counters at the moment of connection, recorded as display metadata
    // only. The *baseline* that activity detection compares against is the
    // first snapshot a check writes — deliberately not this, so the baseline
    // always has a check behind it and an observed-at instant of its own.
    ...(listing.reviewCount !== null ? { reviewCountAtConnection: listing.reviewCount } : {}),
    ...(listing.rating !== null ? { ratingAtConnection: listing.rating } : {}),
  };

  const profile = await dataSource.platformProfiles.upsert(scope, {
    platformConnectionId: connection.id,
    locationId: input.locationId,
    externalProfileId: listing.businessId,
    externalProfileName: listing.name,
    externalAccountId: connection.externalAccountId ?? "",
    profileUrl,
    status: "active",
    // No verification state, and that is the honest value: Yelp's Places API
    // tells Lia nothing about whether this customer owns the listing.
    verificationState: null,
    providerMetadata,
    lastConfirmedAt: now,
  });

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "integration.profile_mapped",
      entityType: "platform_profile",
      entityId: profile.id,
      previousState: null,
      newState: {
        platform: "yelp",
        externalProfileId: listing.businessId,
        locationId: input.locationId,
      },
      metadata: { isClosed: listing.isClosed },
    },
  );

  return profile;
}

/**
 * Yelp's own URL, or one built from the alias, or nothing.
 *
 * Validated rather than trusted even though it came from the provider: this is
 * the value that becomes an "Open in Yelp" destination, and it is the one place
 * provider data turns into somewhere a customer's browser goes.
 */
function resolveListingUrl(
  candidateUrl: string | null,
  alias: string | null,
): string | null {
  if (candidateUrl) {
    const normalized = normalizeYelpUrl(candidateUrl);
    if (normalized) return normalized;
  }
  return alias ? canonicalYelpBusinessUrl(alias) : null;
}

/* -------------------------------------------------------------------------- */
/* Disconnecting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Stop checking a listing, without destroying anything.
 *
 * Marks the profile `disconnected` and leaves every mention, snapshot,
 * occurrence, draft, and audit row exactly where it is. A captured Yelp review
 * with an escalation and an approved response attached is not something to
 * delete because somebody unmapped a listing — the same posture workflow 03
 * took for deleted Google reviews, and the same posture `automation_rules`
 * takes with archiving (D142).
 *
 * Reconnecting later reuses the same profile row (the upsert keys on
 * `externalProfileId`), so the history reattaches rather than forking.
 */
export async function disconnectYelpListing(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  profileId: string,
): Promise<PlatformProfile> {
  const profiles = await dataSource.platformProfiles.list(scope);
  const profile = profiles.find((row) => row.id === profileId);
  if (!profile) throw notFound("Connected listing");

  const updated = await dataSource.platformProfiles.upsert(scope, {
    platformConnectionId: profile.platformConnectionId,
    locationId: profile.locationId,
    externalProfileId: profile.externalProfileId,
    externalProfileName: profile.externalProfileName,
    externalAccountId: profile.externalAccountId ?? "",
    profileUrl: profile.profileUrl,
    status: "disconnected",
    verificationState: profile.verificationState,
    providerMetadata: profile.providerMetadata,
    lastConfirmedAt: profile.lastConfirmedAt ?? new Date(0).toISOString(),
  });

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "integration.disconnected",
      entityType: "platform_profile",
      entityId: profile.id,
      previousState: { status: profile.status },
      newState: { status: "disconnected" },
      metadata: { platform: "yelp" },
    },
  );

  return updated;
}
