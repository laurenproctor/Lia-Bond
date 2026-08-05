/**
 * What Lia can actually do on each platform.
 *
 * Every value here is derived from `ConnectorCapabilities` in
 * `src/domain/entities/platform.ts` and the connections in
 * `src/lib/seed/dataset.ts` — not from marketing copy. CLAUDE.md rule 6:
 * never imply direct publishing where the source does not support it.
 *
 * `resolvePublishingMode` in the platform entity is the same rule expressed in
 * code: `canPublishResponses` means "direct", readable-but-not-publishable
 * means "manual", and neither means "unavailable".
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
    note: "Reviews across every location, with replies posted from Lia once approved.",
    publishing: "direct",
    available: true,
  },
  {
    name: "Reddit",
    note: "Threads and comments that name your brand, with replies from your own account.",
    publishing: "direct",
    available: true,
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
