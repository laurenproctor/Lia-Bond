import type { PressWidgetRenderRow, PressWidgetTheme } from "@/domain";

/**
 * The example press widget shown on the Website widgets landing page.
 *
 * A person choosing between the two widgets cannot be shown their own
 * coverage — they may have none, and the whole point of the page is to decide
 * whether the feature is worth configuring. So they are shown the thing
 * itself, filled with invented coverage, rather than a screenshot or a
 * hand-built imitation.
 *
 * It is a `PressWidgetRenderRow` rather than markup for the reason the review
 * widget's sample is one: the sample then travels the identical path the
 * public embed does — `resolveRenderedPressWidget` →
 * `renderPressWidgetDocument` — and so cannot promise a card that differs from
 * the one a customer's website will get. A React imitation would look right on
 * the day it was written and would drift the first time a padding changed on
 * one side and not the other.
 *
 * **Everything in it is fiction, and the page that renders it says so.**
 *
 * - The three publications do not exist. Their logos are original artwork
 *   drawn for this repository (`public/widget-logos/README.md`), so no
 *   trademark is reproduced and nobody's masthead is used to advertise Lia.
 * - Their domains are under `.example`, which RFC 2606 reserves. A real
 *   customer can therefore never be covered by one of them, and the sample
 *   registry entries can never shadow a real publication's.
 * - The headlines name no real restaurant, no real city, and no real person.
 * - The links point at `example.com`, which IANA maintains for exactly this
 *   purpose. A fabricated link into a real publisher's domain would 404 on
 *   somebody else's server and read as a broken product.
 *
 * Nothing here is ever served under a public id: the sample branch of
 * `/embed/press-widget/preview` is its only caller, and that route is framed
 * by Lia's own pages only.
 */

/** Recent enough to read as current coverage, spread so the ordering is visible. */
const SAMPLE_AGES_MS = [
  6 * 24 * 60 * 60 * 1000,
  19 * 24 * 60 * 60 * 1000,
  41 * 24 * 60 * 60 * 1000,
];

interface SampleStory {
  headline: string;
  excerpt: string;
  publisherName: string;
  publisherDomain: string;
  sourceUrl: string;
}

/**
 * Three stories, chosen to exercise three different shapes of coverage —
 * a feature, a list, and a short news item — because a sample of three
 * near-identical headlines tells somebody nothing about how their own mixed
 * coverage will look.
 */
const SAMPLE_STORIES: readonly SampleStory[] = [
  {
    headline: "The dining room that taught a neighbourhood to book early",
    excerpt:
      "A long look at how one kitchen rebuilt its lunch service around the people who work nearby, and why the queue starts before noon.",
    publisherName: "The Harbour Ledger",
    publisherDomain: "harbourledger.example",
    sourceUrl: "https://example.com/press/the-dining-room-that-taught-a-neighbourhood",
  },
  {
    headline: "Twelve tables worth planning a week around",
    excerpt:
      "An annual round-up of the rooms that changed how the city eats this year, with notes on what to order and when to go.",
    publisherName: "Meridian Table",
    publisherDomain: "meridiantable.example",
    sourceUrl: "https://example.com/press/twelve-tables-worth-planning-a-week-around",
  },
  {
    headline: "Group opens a second kitchen on the north side",
    excerpt:
      "The team confirmed the lease this week and said the new room will keep the original's supper menu through the winter.",
    publisherName: "Northside Dispatch",
    publisherDomain: "northsidedispatch.example",
    sourceUrl: "https://example.com/press/group-opens-a-second-kitchen",
  },
];

export function samplePressWidgetRow(
  theme: PressWidgetTheme,
  now: number,
  itemLimit = SAMPLE_STORIES.length,
): PressWidgetRenderRow {
  return {
    theme,
    layout: "recent_press_list",
    status: "active",
    attributionSuppressed: false,
    // Framed by Lia's own screens only; the route pins `frame-ancestors` to
    // `'self'` regardless of what this list says.
    allowedDomains: [],
    stories: SAMPLE_STORIES.slice(0, itemLimit).map((story, index) => ({
      headline: story.headline,
      excerpt: story.excerpt,
      publisherName: story.publisherName,
      publisherDomain: story.publisherDomain,
      sourceUrl: story.sourceUrl,
      publishedAt: new Date(now - (SAMPLE_AGES_MS[index] ?? 0)).toISOString(),
    })),
  };
}

/** The publications the sample draws, for tests and for the documentation. */
export const SAMPLE_PRESS_PUBLISHER_DOMAINS = SAMPLE_STORIES.map(
  (story) => story.publisherDomain,
);
