import type { Mention } from "@/domain";
import { safeHttpUrl } from "@/lib/widgets/html";

/**
 * Which news coverage the press widget may publish.
 *
 * The press equivalent of `src/lib/widgets/eligibility.ts`, and separate from
 * it on purpose. The two predicates share only their posture: a named list of
 * rules rather than a boolean expression, every rule reusing a meaning the
 * repository already has, and nothing inventing a new mention state.
 *
 * **It has a twin.** The anonymous render path cannot run TypeScript — it goes
 * through `public.press_widget_render`, a `SECURITY DEFINER` function, because
 * an embed request carries no session and no row-level-security policy would
 * return the row. That function's `where` clause is the SQL mirror of the list
 * below, clause for clause, and its comment says so. When a rule changes here
 * it must change there in the same commit;
 * `tests/press-widget-eligibility.test.ts` pins the rule identifiers and the
 * migration quotes them.
 *
 * The rules:
 *
 * | id | rule | why |
 * | --- | --- | --- |
 * | `organization` | belongs to the widget's organization | tenancy, restated at the point of the read |
 * | `source` | `source_type = 'news_article'` | a Reddit thread or a review is not press |
 * | `query` | matches `monitoring_query_id` when the widget selects one | the widget's only filter |
 * | `query_enabled` | that query is enabled | see below |
 * | `headline` | non-empty `title` | the card is a headline; there is nothing to draw without one |
 * | `source_url` | a non-empty, valid HTTP(S) `source_url` | "Read article" is the whole point of the card |
 * | `published` | a publication timestamp exists | the list is ordered by it and the card shows it |
 * | `not_dismissed` | `status <> 'dismissed'` | the existing "dealt with and put away" |
 * | `not_escalated` | `status <> 'escalated'` | Lia routed it to a person as a risk |
 * | `present_at_source` | `source_removed_at is null` | withdrawn coverage stops being republished |
 * | `not_syndicated` | `is_syndicated = false` | three copies of one wire story is not three stories |
 * | `provider_returned` | `capture_method = 'provider_api'` | a typed article is unverifiable by construction |
 *
 * Four deserve the argument in full.
 *
 * **`query_enabled`** is not a property of the article; it is a property of the
 * watch that found it. A customer who disables a monitoring query has said
 * "stop watching this", and continuing to publish what it found — on their own
 * homepage, indefinitely — would be Lia deciding that "stop" meant "stop
 * fetching". It applies only when the widget selects a query: the "all press"
 * mode draws on everything already ingested, and retro-actively hiding an
 * article because the watch that found it was later switched off would empty
 * widgets for a reason nobody could see.
 *
 * **`not_syndicated`** has no review equivalent. `is_syndicated` is set by
 * Lia's own gate (D86) when the same headline reappears inside the syndication
 * window — a wire story picked up by four outlets. In the inbox that is a
 * useful signal; in a three-item press strip it is the difference between
 * "three publications covered us" and "one wire service did, and we printed it
 * three times".
 *
 * **`source_url`** is a rule rather than a rendering detail because a press
 * card *is* a link. A review widget with no "Read on Google" link still shows
 * the review; a press card with no destination is a headline a reader cannot
 * check, which is exactly the shape of a fabricated one. The URL is validated
 * again at the rendering boundary — a stored value was validated by different
 * code at a different time — and a story that fails there is dropped rather
 * than emitted as an unsafe anchor.
 *
 * **What is deliberately not a rule.** `responded`, `monitoring`, and
 * `no_action_recommended` are all mention statuses that say something about
 * Lia's internal workflow and nothing about whether the article exists. An
 * article Lia has "no action recommended" on is very often the best coverage
 * the customer has. Internal workflow state and public existence are different
 * facts, and only the second one belongs here.
 */

/** The rule identifiers, in the order the predicate applies them. */
export const PRESS_WIDGET_ELIGIBILITY_RULES = [
  "organization",
  "source",
  "query",
  "query_enabled",
  "headline",
  "source_url",
  "published",
  "not_dismissed",
  "not_escalated",
  "present_at_source",
  "not_syndicated",
  "provider_returned",
] as const;

export type PressWidgetEligibilityRule =
  (typeof PRESS_WIDGET_ELIGIBILITY_RULES)[number];

/** The mention statuses a press widget will not publish, and nothing else. */
export const INELIGIBLE_PRESS_STATUSES = ["dismissed", "escalated"] as const;

export interface PressWidgetEligibilityInput {
  organizationId: string;
  /** Null means every eligible article in the organization. */
  monitoringQueryId: string | null;
  /**
   * Whether the selected query is enabled.
   *
   * Only consulted when `monitoringQueryId` is set. Passed in rather than
   * looked up so this module stays pure and so the caller — which has already
   * loaded the query, or has been told by SQL — cannot end up asking twice
   * and getting two answers.
   */
  selectedQueryEnabled?: boolean;
}

/**
 * The first rule a mention fails, or null when it passes every one.
 *
 * Returning the rule rather than a boolean is what lets the configuration
 * screen tell somebody *why* an article they can plainly see in their media
 * queue is not on their website — the single most likely support question this
 * feature generates.
 */
export function firstFailedPressRule(
  mention: Mention,
  input: PressWidgetEligibilityInput,
): PressWidgetEligibilityRule | null {
  if (mention.organizationId !== input.organizationId) return "organization";
  if (mention.sourceType !== "news_article") return "source";

  if (input.monitoringQueryId !== null) {
    if (mention.monitoringQueryId !== input.monitoringQueryId) return "query";
    if (input.selectedQueryEnabled !== true) return "query_enabled";
  }

  if ((mention.title ?? "").trim().length === 0) return "headline";
  if (safeHttpUrl(mention.sourceUrl) === null) return "source_url";
  if (mention.publishedAt.trim().length === 0) return "published";
  if (mention.status === "dismissed") return "not_dismissed";
  if (mention.status === "escalated") return "not_escalated";
  if (mention.sourceRemovedAt !== null) return "present_at_source";
  if (mention.isSyndicated) return "not_syndicated";
  if (mention.captureMethod !== "provider_api") return "provider_returned";

  return null;
}

export function isPressEligibleArticle(
  mention: Mention,
  input: PressWidgetEligibilityInput,
): boolean {
  return firstFailedPressRule(mention, input) === null;
}

/**
 * The newest eligible stories, capped at the widget's item limit.
 *
 * Sorted by `publishedAt` — when the outlet published it — rather than by
 * `receivedAt`. A poll that catches up after an outage ingests a fortnight of
 * coverage in one run, and ordering by arrival would put a two-week-old piece
 * at the top for as long as it took the next poll to run. `id` breaks ties
 * descending so the choice is stable across renders: a widget that reshuffles
 * two same-minute stories on every page load looks broken.
 *
 * The tiebreaker matches `press_widget_render`'s `order by published_at desc,
 * id desc` exactly. A different tiebreaker on either side would make the
 * preview and the live page disagree about the order of two stories filed in
 * the same minute — the least visible way for the two implementations to
 * drift, and therefore the one worth pinning.
 */
export function selectPressStories(
  mentions: readonly Mention[],
  input: PressWidgetEligibilityInput & { itemLimit: number },
): Mention[] {
  return mentions
    .filter((mention) => isPressEligibleArticle(mention, input))
    .sort((left, right) => {
      if (left.publishedAt !== right.publishedAt) {
        return left.publishedAt < right.publishedAt ? 1 : -1;
      }
      return left.id < right.id ? 1 : -1;
    })
    .slice(0, Math.max(0, input.itemLimit));
}
