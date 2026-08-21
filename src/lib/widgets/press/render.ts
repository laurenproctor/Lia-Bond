import type {
  PressWidgetRenderRow,
  PressWidgetStory,
  RenderedPressWidget,
} from "@/domain";
import { resolveWidgetAttribution } from "@/lib/widgets/attribution";
import { safeHttpUrl } from "@/lib/widgets/html";
import { normalizePublisherDomain } from "@/lib/widgets/press/publisher-logos";

/**
 * The row a press widget resolved to, turned into what the document draws.
 *
 * Its own module, between the repository and the renderer, because three
 * decisions have to be made in one place or they will be made twice and
 * differently:
 *
 * 1. **Which unavailable state applies.** Both adapters return "nothing
 *    resolved" the same way — an empty `stories` array — and the reason is
 *    derived rather than stored.
 *
 * 2. **Whether each story's link may be drawn.** The stored URL is validated
 *    here, at the last point before it becomes a destination in a stranger's
 *    browser, exactly as the review widget re-validates its Google profile URL
 *    and `resolveYelpDestination` re-validates a stored Yelp URL. It was
 *    validated when it was written, by different code, at a different time; a
 *    validator at the boundary holds regardless of what has changed upstream
 *    since. A story whose URL does not survive is **dropped**, not linked and
 *    not rendered dead — for a press card the link is the claim.
 *
 * 3. **Whether the attribution line renders.** One call to the plan policy,
 *    never a boolean threaded through the render path.
 *
 * It also does the one thing the review path has no equivalent for: it
 * normalises `publisherDomain` before the renderer sees it. The renderer looks
 * a logo up by that value, so normalising anywhere else would mean a provider
 * string reaching the registry unaltered.
 *
 * The function is total: every input produces something drawable. A public
 * embed that could throw is a public embed that shows a stack trace on a
 * restaurant's homepage.
 */
export function resolveRenderedPressWidget(
  row: PressWidgetRenderRow | null,
): RenderedPressWidget {
  // Unknown public id. The theme has to come from somewhere and there is no
  // widget to ask, so the light card is used — it is the one that disappears
  // into a page rather than punching a black rectangle into it.
  if (row === null) {
    return {
      state: "unavailable",
      reason: "unknown_widget",
      theme: "light",
      layout: "recent_press_list",
      showAttribution: true,
      allowedDomains: [],
    };
  }

  const attribution = resolveWidgetAttribution({
    attributionSuppressed: row.attributionSuppressed,
  });

  const shell = {
    theme: row.theme,
    layout: row.layout,
    showAttribution: attribution.visible,
    allowedDomains: row.allowedDomains,
  } as const;

  if (row.status === "disabled") {
    return { state: "unavailable", reason: "disabled", ...shell };
  }

  const stories = row.stories.flatMap((story) => {
    const headline = story.headline?.trim() ?? "";
    const sourceUrl = safeHttpUrl(story.sourceUrl);
    const publishedAt = story.publishedAt?.trim() ?? "";

    // The same three rules the resolver already applied, applied again because
    // this is the boundary that matters. A row that reached here without a
    // headline, a destination, or a date is a row the resolver should not have
    // returned — and one bad story costs the widget that story, never the
    // other two and never an exception on a public route.
    if (headline.length === 0 || sourceUrl === null || publishedAt.length === 0) {
      return [];
    }

    const excerpt = story.excerpt?.trim();

    return [
      {
        headline,
        excerpt: excerpt && excerpt.length > 0 ? excerpt : null,
        publisherName: story.publisherName?.trim() || null,
        // Normalised here, once, so the logo registry is never handed a raw
        // provider value.
        publisherDomain: normalizePublisherDomain(story.publisherDomain),
        sourceUrl,
        publishedAt,
      } satisfies PressWidgetStory,
    ];
  });

  if (stories.length === 0) {
    return { state: "unavailable", reason: "no_eligible_press", ...shell };
  }

  return { state: "ready", ...shell, stories };
}
