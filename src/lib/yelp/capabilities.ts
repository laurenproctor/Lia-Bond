import type { PlatformConnection, PlatformProfile } from "@/domain";
import type { IntegrationCapability } from "@/integrations/connector";

/**
 * What the Yelp Assisted integration can actually do, right now.
 *
 * Modelled on `src/lib/integrations/capabilities.ts` and
 * `src/lib/monitoring/capabilities.ts`, and the honesty requirement in
 * `CLAUDE.md` has a particular shape here that neither of those faced.
 *
 * Google's risk is that a successful OAuth handshake implies reviews are
 * flowing. News's risk is that the word "monitoring" implies completeness.
 * Yelp's risk is sharper than both: a connected listing genuinely does produce
 * notifications that say "review activity detected", and every instinct a
 * customer has will read that as "Lia is watching my Yelp reviews". It is not.
 * Lia is watching two numbers and telling them when the numbers move.
 *
 * So the copy below states the limitation in the *enabled* state, not only in
 * the unconfigured one. A capability card that says "Enabled — review activity
 * detection" and explains itself only when switched off would be doing exactly
 * what this file exists to prevent.
 *
 * `available` is whether Yelp is configured on this deployment at all
 * (`isYelpAvailable`); `connected` is whether this organization has mapped a
 * listing. Unlike Google there is no OAuth handshake whose success could stand
 * in for either.
 */

export interface YelpCapabilityInput {
  /** `isYelpAvailable()` — whether the server holds a Places key. */
  readonly available: boolean;
  readonly connection: PlatformConnection | null;
  /** Listings mapped to locations under this connection. */
  readonly profiles: readonly PlatformProfile[];
}

export function yelpCapabilities(input: YelpCapabilityInput): IntegrationCapability[] {
  const { available, connection, profiles } = input;
  const connected = available && connection?.status === "connected";
  const mapped = profiles.filter((profile) => profile.status !== "disconnected");
  const live = connected && mapped.length > 0;

  return [
    {
      id: "listing_matching",
      label: "Listing matching",
      state: available ? "enabled" : "not_configured",
      detail: available
        ? "Lia can search Yelp for the business matching a location's name, address, and phone number, and you confirm which listing is which restaurant."
        : "Yelp is not configured on this server, so listings cannot be searched. An administrator needs to add a Yelp API key.",
    },
    {
      id: "listing_connection",
      label: "Listing connected",
      state: live ? "enabled" : "not_configured",
      detail: live
        ? `Lia holds the Yelp listing for ${mapped.length === 1 ? "1 location" : `${mapped.length} locations`}. This is a mapping you confirmed, not proof of ownership — Lia's Yelp access does not verify who runs a business.`
        : "Connect a location's Yelp listing to start checking it for review activity.",
    },
    {
      id: "activity_detection",
      label: "Checking for review activity",
      state: live ? "enabled" : "not_configured",
      // The sentence this whole feature is most likely to be misread on, so the
      // limit is in the enabled copy rather than in a footnote below it.
      detail: live
        ? "Lia checks each connected listing's review count and star rating on a schedule, and tells you when either changes. It does not read your Yelp reviews — a count can change because a review was added, removed, or reclassified, so a change is a prompt to go and look, not a report of what happened."
        : "Once a listing is connected, Lia checks its review count and rating on a schedule and tells you when either changes.",
    },
    {
      id: "review_retrieval",
      label: "Review retrieval",
      // Unqualified by connection status on purpose, exactly like Google's
      // `review_publishing`: connecting a listing changes nothing about whether
      // Lia can read a review from it. It cannot.
      state: "unavailable",
      detail:
        "Not available. Lia's Yelp access does not include review content, so reviews cannot be imported. When Lia detects activity you add the review yourself, and it then goes through the same analysis, routing, and drafting as every other source.",
    },
    {
      id: "review_webhooks",
      label: "Review notifications from Yelp",
      state: "unavailable",
      detail:
        "Not available. Yelp offers new-review webhooks only to licensed partners, so Lia learns about activity by checking the listing on a schedule rather than being told.",
    },
    {
      id: "response_publishing",
      label: "Response publishing",
      state: "unavailable",
      detail:
        "Not available. Lia cannot post to Yelp. An approved response is copied, you post it on Yelp yourself, and you mark it as posted here afterwards — Lia records that you said so, and never claims Yelp confirmed it.",
    },
  ];
}

/**
 * Warnings to surface on the connection.
 *
 * Each one is something a person can act on, and nothing here restates a status
 * badge already visible beside it — the same rule `connectionWarnings` follows
 * for Google.
 */
export function yelpConnectionWarnings(input: YelpCapabilityInput): string[] {
  const { available, connection, profiles } = input;
  if (!connection || connection.status === "disconnected") return [];

  const warnings: string[] = [];

  if (!available) {
    warnings.push(
      "Yelp is no longer configured on this server, so connected listings are not being checked. An administrator needs to restore the Yelp API key.",
    );
  }

  if (connection.lastErrorMessage) warnings.push(connection.lastErrorMessage);

  const mapped = profiles.filter((profile) => profile.status !== "disconnected");
  if (available && mapped.length === 0) {
    warnings.push(
      "No Yelp listing is connected to a location yet, so there is nothing to check.",
    );
  }

  return warnings;
}
