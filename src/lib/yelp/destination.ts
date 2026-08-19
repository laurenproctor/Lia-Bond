import type { Mention, PlatformProfile } from "@/domain";
import { isTrustedYelpUrl } from "@/yelp/urls";

/**
 * Where "Open in Yelp" should send somebody.
 *
 * Resolved on the server and re-validated here, even though both candidate
 * URLs were already validated when they were stored. That is not redundancy
 * for its own sake: this is the last point before a stored string becomes a
 * destination in somebody's browser, and the two stores it can come from were
 * written at different times by different code paths — a captured review URL by
 * the capture service, a listing URL by the connect service. A validator at the
 * boundary holds regardless of what changed upstream since.
 *
 * Preference order is most-specific-first, because the whole point of the
 * handoff is to land the person on the review they are answering:
 *
 * 1. the review's own URL, when the customer supplied one at capture;
 * 2. the connected listing's page;
 * 3. nothing — and the UI says so plainly rather than offering a dead control.
 */

export type YelpDestinationKind = "review" | "listing";

export interface YelpDestination {
  url: string | null;
  kind: YelpDestinationKind;
}

export function resolveYelpDestination(
  mention: Pick<Mention, "sourceUrl">,
  profile: Pick<PlatformProfile, "profileUrl"> | null,
): YelpDestination {
  if (mention.sourceUrl && isTrustedYelpUrl(mention.sourceUrl)) {
    return { url: mention.sourceUrl, kind: "review" };
  }

  if (profile?.profileUrl && isTrustedYelpUrl(profile.profileUrl)) {
    return { url: profile.profileUrl, kind: "listing" };
  }

  // No trusted destination. Returning null rather than falling back to a search
  // URL or a guessed page: sending somebody to the wrong restaurant's Yelp page
  // to post a reply is worse than sending them nowhere and saying so.
  return { url: null, kind: "listing" };
}
