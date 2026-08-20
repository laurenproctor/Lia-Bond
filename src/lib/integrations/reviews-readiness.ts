import type { PlatformConnection, PlatformProfile } from "@/domain";

/**
 * Why the review workspace has nothing to open.
 *
 * `/reviews` used to raise `notFound()` whenever the queue came back empty,
 * which put "we couldn't find that page" in front of every organization that
 * had simply not connected Google yet — a 404 for the most ordinary state a new
 * account can be in. The queue being empty is not a missing page; it is a step
 * that has not happened. This names which step, so the screen can ask for that
 * one thing instead of apologising for a broken link.
 */
export type ReviewsReadinessState =
  /** No Google OAuth client on this deployment, so nobody can connect at all. */
  | "not_configured"
  /** Nothing connected, or the connection was removed. */
  | "not_connected"
  /** Connected once, but Google has withdrawn consent and wants it again. */
  | "action_required"
  /** Connected, but the last exchange with Google failed for some other reason. */
  | "error"
  /** Connected, but no Google location is mapped onto a Lia location. */
  | "no_locations"
  /** Connected and mapped — a sync has just never imported anything. */
  | "no_reviews";

export interface ReviewsReadiness {
  state: ReviewsReadinessState;
  title: string;
  description: string;
}

export interface ReviewsReadinessInput {
  /** `isGoogleConnectorAvailable()` — whether the server is configured. */
  connectorAvailable: boolean;
  connection: PlatformConnection | null;
  /** Profiles on the connection, mapped or not. */
  profiles: PlatformProfile[];
}

/**
 * Resolved most-blocking-first: there is no point telling somebody to map a
 * location while the connection needs re-consent, and no point offering a
 * connect button on a deployment where the OAuth client is missing.
 */
export function reviewsReadiness({
  connectorAvailable,
  connection,
  profiles,
}: ReviewsReadinessInput): ReviewsReadiness {
  if (connection === null || connection.status === "disconnected") {
    if (!connectorAvailable) {
      return {
        state: "not_configured",
        title: "Google Business Profile is not set up",
        description:
          "This deployment has no Google OAuth client configured, so a Business Profile cannot be connected yet. Your administrator needs to set the Google credentials before reviews can be imported.",
      };
    }

    return {
      state: "not_connected",
      title: "No Google Business Profile is connected",
      description:
        "Google reviews will land here once you connect a Google account that administers your Business Profile listings. Lia reads the locations that account manages, imports reviews for the ones you map, and prepares replies for a person to post — it never posts to Google itself.",
    };
  }

  if (connection.status === "action_required") {
    return {
      state: "action_required",
      title: "Google needs to be reauthorized",
      description:
        "The connection to Google is no longer accepted, so no reviews can be imported. Reauthorize it to start importing again — nothing already in Lia is lost.",
    };
  }

  if (connection.status === "error") {
    return {
      state: "error",
      // Reauthorizing does not fix a quota or API error, so this does not ask
      // for it. The connection page is where the recorded error and the
      // connection test live.
      title: "The Google connection is not working",
      description: connection.lastErrorMessage
        ? `Reviews cannot be imported right now. Google last reported: ${connection.lastErrorMessage}`
        : "Reviews cannot be imported right now because the last exchange with Google failed. Open the connection to see what it reported and to test it again.",
    };
  }

  const active = profiles.filter((profile) => profile.status !== "disconnected");
  const mapped = active.filter((profile) => profile.locationId !== null);

  if (mapped.length === 0) {
    return {
      state: "no_locations",
      title: "No Google locations are mapped yet",
      description:
        active.length > 0
          ? `Google is connected and Lia can see ${active.length === 1 ? "1 location" : `${active.length} locations`}, but none are mapped onto a Lia location yet. Map at least one to start importing its reviews.`
          : "Google is connected, but no Business Profile locations have been mapped onto your Lia locations yet. Map at least one to start importing its reviews.",
    };
  }

  return {
    state: "no_reviews",
    title: "No Google reviews imported yet",
    description:
      "Google is connected and your locations are mapped, but no reviews have been imported. Lia does not watch Google continuously — run a sync to pull in the reviews each location has today.",
  };
}
