import { NO_CAPABILITIES, type ConnectorCapabilities, type Platform } from "@/domain";
import type { ExternalArticle, NewsMonitor, NewsSearchBatch, NewsSearchQuery } from "@/news/monitor";
import { searchGNews } from "@/news/gnews/client";
import { normaliseGNewsArticle } from "@/news/gnews/normalise";

/**
 * GNews's free tier is search-only: no webhook push, no way to publish or edit
 * a response, no comment surface at all. `canReadMentions` is the only
 * capability turned on — everything else, including approval, stays at
 * `NO_CAPABILITIES`'s conservative default so the UI never implies a
 * publishing path this connector cannot honour.
 */
const GNEWS_CAPABILITIES: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  canReadMentions: true,
};

export class GNewsMonitor implements NewsMonitor {
  readonly platform: Platform = "news_media";

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  capabilities(): ConnectorCapabilities {
    return GNEWS_CAPABILITIES;
  }

  async search(query: NewsSearchQuery): Promise<NewsSearchBatch> {
    const result = await searchGNews(query, this.fetchImpl);

    const articles: ExternalArticle[] = [];
    let malformedCount = 0;

    for (const raw of result.articles) {
      const article = normaliseGNewsArticle(raw);
      if (article === null) {
        malformedCount += 1;
        continue;
      }
      articles.push(article);
    }

    return {
      articles,
      // One `fetch` call per `search()`, always — this client has no retry
      // loop, so the count is never anything but 1.
      requestsSpent: 1,
      // The free tier has no paging. A page as full as what was asked for
      // means there may be more articles this poll never saw.
      truncated: result.articles.length >= query.maxResults,
      malformedCount,
    };
  }
}
