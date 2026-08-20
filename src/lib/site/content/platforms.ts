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

export const PLATFORM_ROWS: readonly PlatformRow[] = [
  {
    name: "Google Business Profile",
    note: "Reviews across every location. Lia drafts the reply; you post it from Google once you approve it.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Reddit",
    note: "Threads and comments that name your brand. Lia drafts a reply for you to post from your own account.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Yelp",
    note: "Reviews are read through a partner agreement; replies are drafted for you to post.",
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
