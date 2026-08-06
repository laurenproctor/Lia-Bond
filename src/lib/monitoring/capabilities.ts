import { MAX_ARTICLES_PER_POLL } from "@/domain";
import type { IntegrationCapability } from "@/integrations/connector";

/**
 * What the news and media integration can actually do, right now.
 *
 * Modelled closely on `src/lib/integrations/capabilities.ts`, but the honesty
 * requirement in `CLAUDE.md` is sharper here: "monitoring" sounds like
 * completeness, and this feature is not that. Task 10 shipped a connection
 * with `canReadFullText: true` and `supportsWebhooks: true` — both false — and
 * a review caught it before it reached a screen. This is the screen. Three
 * limits appear here in plain sentence-case English, not buried in a tooltip:
 *
 * - coverage can be up to 12 hours behind, because the free GNews tier delays
 *   what it returns;
 * - Lia holds only the headline and description GNews returns for a match —
 *   never the article body, which the free tier truncates and the connector
 *   deliberately discards rather than store as if it were complete;
 * - one poll returns at most `MAX_ARTICLES_PER_POLL` articles.
 *
 * `available` is whether news monitoring is configured on this deployment at
 * all (`isNewsMonitorAvailable`), not a per-organization connection status —
 * unlike Google, a news connection is provisioned implicitly on first query
 * save, so there is no OAuth handshake whose success would otherwise stand in
 * for "this works."
 */
export function newsCapabilities(available: boolean): IntegrationCapability[] {
  return [
    {
      id: "article_monitoring",
      label: "Article monitoring",
      state: available ? "enabled" : "not_configured",
      detail: available
        ? "Lia searches news coverage for each monitoring query's keywords and holds the headline and description returned for every match. It does not hold the article body."
        : "Configure news monitoring to search coverage for your monitoring queries.",
    },
    {
      id: "scheduled_polling",
      label: "Scheduled polling",
      state: available ? "enabled" : "not_configured",
      detail: available
        ? `Each query is polled on its own interval. Coverage can be up to 12 hours behind, because the free GNews tier delays what it returns, and a single poll returns at most ${MAX_ARTICLES_PER_POLL} articles.`
        : "Configure news monitoring to poll your queries on a schedule.",
    },
    {
      id: "relevance_filtering",
      label: "Relevance filtering",
      state: available ? "enabled" : "not_configured",
      detail: available
        ? "A deterministic gate scores every candidate against the query's keywords, exclusions, allowed publishers, and admission threshold — all four are yours to set when you create or edit a query. Candidates the gate refuses are kept, with the reason, so the gate can be checked and tuned rather than trusted blindly."
        : "Configure news monitoring to filter candidates before they reach the inbox.",
    },
    {
      id: "full_text",
      label: "Full article text",
      state: "unavailable",
      detail:
        "Not available on the current plan. The free GNews tier truncates the article body it returns, and Lia discards that truncated text rather than store a partial article as if it were complete. Only the headline and description are held.",
    },
    {
      id: "media_publishing",
      label: "Media publishing",
      // Unqualified by `available` on purpose, exactly like `review_publishing`
      // in the Google capabilities: monitoring the news changes nothing about
      // whether Lia can write to a newspaper. It cannot, connected or not.
      state: "unavailable",
      // The third sentence used to read "Responses are prepared in Lia and
      // sent by a person through their own channel" — true of Google's
      // review_publishing, where it was copied from, but false here: there
      // is no composer or draft generation on the media detail screen, and
      // D72 says there never will be on this surface. Cut rather than
      // reworded, because the two sentences above already say everything
      // true about this capability.
      detail:
        "Not built, and there is no publishing API to build it against. Lia cannot post or submit anything to a publication.",
    },
    {
      id: "comment_monitoring",
      label: "Comment monitoring",
      state: "unavailable",
      detail:
        "Not part of this integration. Reader comments left under an article are covered by the article-comments connector, not this one.",
    },
  ];
}
