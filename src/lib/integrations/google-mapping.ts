import "server-only";

import { z } from "zod";
import type { JsonObject, Location, PlatformProfile } from "@/domain";
import type { ExternalProfile } from "@/integrations/connector";
import { recordAuditEvent } from "@/lib/audit/record";
import { conflict, DataError, notFound } from "@/lib/data/errors";
import {
  listGoogleBusinessLocations,
  type ServiceContext,
} from "@/lib/integrations/google-service";

/**
 * Persisting location mappings.
 *
 * A mapping decides which restaurant a Google listing's reviews belong to. Get
 * it wrong and one location's complaints land in another's queue, where someone
 * answers them in good faith about a meal that was never served there. The
 * damage is invisible until it is public, so this module verifies every claim
 * the browser makes rather than trusting the form it came from.
 *
 * Specifically, for each selected profile it re-fetches the live Google listing
 * server-side and confirms the profile is genuinely offered by the connected
 * account. A form field naming a Google location id is a claim, not evidence.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One decision about one Google location.
 *
 * Three shapes rather than a nullable location id, because "map to this
 * location", "create a location for this", and "leave this alone" are genuinely
 * different intentions and a discriminated union makes the caller state which.
 */
export const mappingDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("map_existing"),
    externalProfileId: z.string().min(1).max(200),
    locationId: z.uuid(),
  }),
  z.object({
    action: z.literal("create_location"),
    externalProfileId: z.string().min(1).max(200),
    /** Editable in the form: Google's title is often not what staff call it. */
    name: z.string().min(1).max(160),
    timezone: z.string().min(3).max(64),
  }),
  z.object({
    action: z.literal("skip"),
    externalProfileId: z.string().min(1).max(200),
  }),
]);

export type MappingDecision = z.infer<typeof mappingDecisionSchema>;

export const saveMappingsInputSchema = z.object({
  connectionId: z.uuid(),
  externalAccountId: z.string().min(1).max(200),
  decisions: z.array(mappingDecisionSchema).max(500),
});

export type SaveMappingsInput = z.infer<typeof saveMappingsInputSchema>;

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

export interface MappingFailure {
  externalProfileId: string;
  /** Displayed next to the row that failed. Never a driver message. */
  message: string;
}

export interface SaveMappingsResult {
  createdLocations: Location[];
  mappedProfiles: PlatformProfile[];
  skipped: string[];
  failures: MappingFailure[];
}

/* -------------------------------------------------------------------------- */
/* Address handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Turn a Google address into the columns `locations` requires.
 *
 * Google's fields are all optional; Lia's are not, because a location with no
 * city cannot be shown in a portfolio table or grouped in a report. Rather than
 * refusing to create the location — which would strand a real restaurant the
 * user is trying to onboard — the gaps are filled with an explicit marker.
 * "Not provided by Google" is visible, searchable, and obviously wrong to a
 * human reading the locations screen, which an empty string is not.
 */
const UNKNOWN_FIELD = "Not provided by Google";

function addressFromProfile(profile: ExternalProfile) {
  const address = profile.address;

  return {
    addressLine1: address?.addressLine1?.trim() || UNKNOWN_FIELD,
    addressLine2: address?.addressLine2?.trim() || null,
    city: address?.city?.trim() || UNKNOWN_FIELD,
    region: address?.region?.trim() || UNKNOWN_FIELD,
    postalCode: address?.postalCode?.trim() || "00000",
    // Two-letter uppercase, per the locations schema. Google returns a CLDR
    // region code, which is the same thing for every country Lia supports.
    countryCode: normalizeCountryCode(address?.countryCode),
  };
}

function normalizeCountryCode(value: string | undefined): string {
  const upper = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : "US";
}

function profileMetadata(profile: ExternalProfile): JsonObject {
  return {
    ...(profile.metadata ?? {}),
    ...(profile.storeCode ? { storeCode: profile.storeCode } : {}),
    ...(profile.websiteUrl ? { websiteUrl: profile.websiteUrl } : {}),
    ...(profile.phoneNumber ? { phoneNumber: profile.phoneNumber } : {}),
  };
}

function validProfileUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    // The domain schema requires a URL. Google's mapsUri is one, but a
    // malformed value must not fail the whole save for an unrelated field.
    return new URL(value).toString();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Save                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Apply a set of mapping decisions.
 *
 * There is no database transaction here, and that is a deliberate limitation
 * rather than an oversight. Lia's repository interface is adapter-agnostic —
 * the demo adapter has no transaction to open, and PostgREST does not expose
 * one — so a partial failure is handled by making each decision independent and
 * idempotent instead. Every profile is upserted on its natural key, so re-running
 * the save after a failure converges rather than duplicating, and the failures
 * are returned per-row so the user can see exactly which listings did not take.
 *
 * The alternative — a Postgres function wrapping the whole batch — would work
 * for the Supabase adapter and be untestable in the demo one. The trade is
 * recorded in `docs/integrations/google-business-profile.md`.
 */
export async function saveGoogleLocationMappings(
  context: ServiceContext,
  input: SaveMappingsInput,
): Promise<SaveMappingsResult> {
  const connection = await context.dataSource.platformConnections.get(
    context.scope,
    input.connectionId,
  );
  // Scoped lookup: a connection id belonging to another organization simply is
  // not found, so a forged id buys nothing.
  if (!connection) throw notFound("Google connection");

  if (connection.status === "disconnected") {
    throw new DataError(
      "conflict",
      "This Google connection is disconnected. Reconnect it before mapping locations.",
    );
  }

  // Re-fetched from Google rather than trusted from the form. This is what
  // proves each selected profile is genuinely offered by the connected account,
  // and it is why an attacker cannot map an arbitrary Google location id into
  // someone else's organization.
  const liveProfiles = await listGoogleBusinessLocations(
    context,
    input.connectionId,
    input.externalAccountId,
  );
  const liveById = new Map(
    liveProfiles.map((profile) => [profile.externalProfileId, profile]),
  );

  const existingProfiles =
    await context.dataSource.platformProfiles.listForConnection(
      context.scope,
      input.connectionId,
    );
  const existingByExternalId = new Map(
    existingProfiles.map((profile) => [profile.externalProfileId, profile]),
  );

  const locations = await context.dataSource.locations.list(context.scope);
  const locationIds = new Set(locations.map((location) => location.id));

  const result: SaveMappingsResult = {
    createdLocations: [],
    mappedProfiles: [],
    skipped: [],
    failures: [],
  };

  // Tracks locations claimed within this batch as well as before it. Two rows
  // of one form both pointing at the same Lia location would otherwise pass
  // every individual check and collide at the database.
  const claimedLocationIds = new Set(
    existingProfiles.flatMap((profile) =>
      profile.locationId && profile.status !== "disconnected"
        ? [profile.locationId]
        : [],
    ),
  );
  const seenExternalIds = new Set<string>();
  const confirmedAt = new Date().toISOString();

  for (const decision of input.decisions) {
    if (decision.action === "skip") {
      result.skipped.push(decision.externalProfileId);
      continue;
    }

    try {
      if (seenExternalIds.has(decision.externalProfileId)) {
        throw conflict("This Google location appears twice in the submission.");
      }
      seenExternalIds.add(decision.externalProfileId);

      const live = liveById.get(decision.externalProfileId);
      if (!live) {
        throw conflict(
          "This location is no longer offered by the connected Google account.",
        );
      }

      const existing = existingByExternalId.get(decision.externalProfileId);
      const previousLocationId = existing?.locationId ?? null;

      let locationId: string;
      let profile: PlatformProfile;

      if (decision.action === "map_existing") {
        // Membership of the caller's own organization, re-checked server-side.
        // The list came from a scoped repository call, so an id from another
        // tenant is simply absent.
        if (!locationIds.has(decision.locationId)) {
          throw notFound("Location");
        }

        if (
          claimedLocationIds.has(decision.locationId) &&
          previousLocationId !== decision.locationId
        ) {
          throw conflict(
            "That Lia location is already mapped to a different Google location.",
          );
        }

        locationId = decision.locationId;

        profile = await context.dataSource.platformProfiles.upsert(context.scope, {
          platformConnectionId: input.connectionId,
          locationId,
          externalProfileId: live.externalProfileId,
          externalProfileName: live.displayName,
          externalAccountId: input.externalAccountId,
          profileUrl: validProfileUrl(live.profileUrl),
          status: "active",
          verificationState: live.verificationState ?? null,
          providerMetadata: profileMetadata(live),
          lastConfirmedAt: confirmedAt,
        });

        // Two events, because they answer different questions. "Which external
        // profiles did we start monitoring" is a connection question; "which
        // restaurant is this listing" is a location question, and an auditor
        // chasing a misrouted review needs the second one.
        if (!existing) {
          await recordAuditEvent(context, {
            eventType: "integration.profile_connected",
            entityType: "platform_profile",
            entityId: profile.id,
            previousState: null,
            newState: {
              externalProfileId: profile.externalProfileId,
              externalProfileName: profile.externalProfileName,
            },
            metadata: { platform: connection.platform },
          });
        }

        if (previousLocationId !== locationId) {
          await recordAuditEvent(context, {
            eventType: "integration.profile_mapped",
            entityType: "platform_profile",
            entityId: profile.id,
            previousState: { locationId: previousLocationId },
            newState: { locationId },
            metadata: {
              platform: connection.platform,
              externalProfileId: profile.externalProfileId,
              createdLocation: false,
            },
          });
        }
      } else {
        // Creating the location and binding the listing to it are one call,
        // and one transaction.
        //
        // This used to be four steps out here — create the location, audit it,
        // upsert the profile, audit that — and the location could commit while
        // any of the three that follow it failed, leaving a restaurant in the
        // portfolio that no Google listing pointed at. `createAndMapFromIntegration`
        // makes that unrepresentable: the profile set is required, the binding
        // happens inside, and nothing commits unless all of it does.
        //
        // It is also what lets `locations_insert` narrow to owner/admin while
        // a communications lead keeps mapping listings. The function derives
        // the organization from the connection and checks
        // `integration.manage_profiles`'s own role list, so mapping authority
        // stays where it was without handing anybody the ability to create a
        // location on its own.
        //
        // **No audit events here, deliberately.** All three —
        // `location.created_from_integration`, `integration.profile_connected`
        // for a profile row this call created, and `integration.profile_mapped`
        // — are written inside the same transaction as the writes they
        // describe. Adding them back here would double every one of them.
        const address = addressFromProfile(live);
        const mapped = await context.dataSource.locations.createAndMapFromIntegration(
          context.scope,
          {
            platformConnectionId: input.connectionId,
            profiles: [
              {
                externalProfileId: live.externalProfileId,
                externalProfileName: live.displayName,
                externalAccountId: input.externalAccountId,
                profileUrl: validProfileUrl(live.profileUrl),
                verificationState: live.verificationState ?? null,
                providerMetadata: profileMetadata(live),
              },
            ],
            name: decision.name,
            ...address,
            timezone: decision.timezone,
          },
        );

        const bound = mapped.profiles[0];
        // The function returns one row per profile it bound, and it was given
        // exactly one. An empty result would mean the contract changed.
        if (!bound) throw conflict("That Google location could not be mapped.");

        locationId = mapped.location.id;
        profile = bound;
        result.createdLocations.push(mapped.location);
        locationIds.add(mapped.location.id);
      }

      claimedLocationIds.add(locationId);
      if (previousLocationId && previousLocationId !== locationId) {
        claimedLocationIds.delete(previousLocationId);
      }
      result.mappedProfiles.push(profile);
    } catch (error) {
      // Per-row rather than aborting the batch: a user who mapped nine
      // locations correctly and one that collided should keep the nine.
      result.failures.push({
        externalProfileId: decision.externalProfileId,
        message:
          error instanceof DataError
            ? error.message
            : "This location could not be saved. Try again.",
      });
    }
  }

  return result;
}
