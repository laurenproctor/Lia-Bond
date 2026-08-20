/**
 * What Lia can actually do on each platform.
 *
 * Every value here must be derived from a real connector's declared
 * `ConnectorCapabilities` — today that is `GOOGLE_CONNECTOR_CAPABILITIES` in
 * `src/integrations/google-business-profile/connector.ts` — or, for a
 * platform with no connector at all, from the plain fact that nothing has
 * been built yet. CLAUDE.md rule 6: never imply a capability the source does
 * not support.
 *
 * `src/lib/seed/dataset.ts` is NOT a source for this file. It is demo
 * fixture data for populating the product UI with plausible-looking records,
 * and it sets `canPublishResponses: true` on connections — Google included —
 * that no real connector grants. Deriving a public claim from it is exactly
 * how this file previously ended up promising direct publishing to Google and
 * Reddit that the product cannot do. If a row here cannot be justified by
 * pointing at a connector file under `src/integrations/`, it is wrong.
 *
 * `resolvePublishingMode` in `src/domain/entities/platform.ts` is the same
 * rule expressed in code: `canPublishResponses` means "direct",
 * readable-but-not-publishable means "manual", and neither means
 * "unavailable". No connector in this codebase sets `canPublishResponses`,
 * so no row below may be `"direct"`.
 *
 * The design reference also advertised Booking.com. It is not in the `PLATFORMS`
 * vocabulary and is deliberately absent rather than promised.
 *
 * `available` is the second half of the same rule, and it is load-bearing:
 * every renderer and every derived list below filters on it, so a row turned
 * off here goes quiet everywhere at once rather than in the one place somebody
 * remembered to edit. It was previously declared and read by nothing, which
 * meant the honest answer could be recorded in this file and still be
 * contradicted by the page rendering it.
 *
 * A row with `available: false` keeps its `publishing` mode. That mode is what
 * Lia *would* do once the source is reachable, not a claim about today —
 * availability overrides it, and nothing may present a publishing answer for a
 * platform that is switched off.
 */

export type Publishing = "direct" | "manual" | "monitor";

export interface PlatformRow {
  name: string;
  /** What Lia does with it, in a sentence. */
  note: string;
  publishing: Publishing;
  available: boolean;
}

export const PUBLISHING_LABELS: Record<Publishing, string> = {
  direct: "Publish from Lia",
  manual: "Copy to publish",
  monitor: "Monitoring only",
};

export const PUBLISHING_NOTES: Record<Publishing, string> = {
  direct: "Approved replies post straight to the platform.",
  manual:
    "Lia drafts the reply and hands it to you to post, because the platform offers no reply API.",
  monitor:
    "There is nothing to reply to. Lia reads these to tell you what is being said.",
};

/** What an unavailable row shows instead of a publishing answer. */
export const UNAVAILABLE_LABEL = "Not available";

export const UNAVAILABLE_NOTE =
  "Lia cannot reach this source yet, so it is not monitored and there is nothing to draft from.";

export const PLATFORM_ROWS: readonly PlatformRow[] = [
  {
    name: "Google Business Profile",
    note: "Reviews across every location. Lia drafts the reply; you post it from Google once you approve it.",
    publishing: "manual",
    available: true,
  },
  {
    /*
     * Off, because Reddit rejected this deployment's API application.
     * Commercial Reddit access is a negotiated agreement rather than a
     * registration, so there is no tier to fall back to and no date to
     * promise — see `docs/integrations/reddit-access-approval.md`. The row
     * stays visible and says so: people ask about Reddit, and an honest "not
     * available" answers them better than a silent deletion that leaves them
     * assuming it works.
     */
    name: "Reddit",
    note: "Not available. Reddit grants commercial API access by private agreement and has not granted one to Lia, so Reddit threads are not monitored today.",
    publishing: "manual",
    available: false,
  },
  {
    name: "Yelp",
    note: "Reviews are read through a partner agreement; replies are drafted for you to post.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Tripadvisor",
    note: "Reviews and traveller ratings, with drafted replies for manual posting.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Trustpilot",
    note: "Reviews and ratings, with drafted replies for manual posting.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Facebook",
    note: "Page reviews and recommendations, with drafted replies for manual posting.",
    publishing: "manual",
    available: true,
  },
  {
    name: "News and media",
    note: "Local and national coverage, food and trade publications, and blogs.",
    publishing: "monitor",
    available: true,
  },
  {
    name: "Article comments",
    note: "Supported comment systems on articles that cover you.",
    publishing: "monitor",
    available: true,
  },
] as const;

/**
 * The rows a public claim may be built from, and the rows it may not.
 *
 * Derived rather than hand-listed so a platform cannot be switched off in the
 * table and still be named in a sentence somewhere else. Every consumer —
 * the platforms table, the pricing FAQ — reads these rather than
 * `PLATFORM_ROWS` directly.
 */
export const AVAILABLE_PLATFORM_ROWS: readonly PlatformRow[] =
  PLATFORM_ROWS.filter((row) => row.available);

export const UNAVAILABLE_PLATFORM_ROWS: readonly PlatformRow[] =
  PLATFORM_ROWS.filter((row) => !row.available);

/** The names of the available platforms answering a given publishing mode. */
export function availablePlatformNames(mode: Publishing): readonly string[] {
  return AVAILABLE_PLATFORM_ROWS.filter((row) => row.publishing === mode).map(
    (row) => row.name,
  );
}
