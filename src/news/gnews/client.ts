import "server-only";

import { z } from "zod";
import { NewsError } from "@/news/errors";
import type { NewsSearchQuery } from "@/news/monitor";
import { buildGNewsQuery } from "@/news/gnews/normalise";

/**
 * The GNews HTTP boundary.
 *
 * Every request Lia makes to GNews is issued from this file, and it is the
 * only file in the news layer that touches the network or reads the API key.
 * That split is what makes `GNewsMonitor` testable by stubbing one function
 * (`fetch`) instead of intercepting calls elsewhere.
 *
 * No provider error text, request URL, or key ever reaches a thrown error. The
 * wording a person sees comes from Lia (see `classifyError`), not from GNews.
 */

const GNEWS_SEARCH_URL = "https://gnews.io/api/v4/search";

/**
 * Only the shape this layer relies on. Individual articles are left as
 * `unknown` — `normaliseGNewsArticle` is responsible for validating and
 * shaping each one, and re-validating them here would just duplicate that
 * work under a different schema.
 */
const gnewsResponseSchema = z.object({
  totalArticles: z.number(),
  articles: z.array(z.unknown()),
});

export interface GNewsSearchResult {
  articles: unknown[];
  totalArticles: number;
}

/**
 * Status → `NewsError`. GNews's own error bodies are never interpolated: they
 * quote the request back (including, on a 400, the malformed query) and are
 * not written for a Lia user to read.
 */
function classifyError(status: number): NewsError {
  if (status === 401 || status === 403) {
    return new NewsError(
      "unauthorized",
      "News monitoring's provider credentials were rejected. Reconnect the GNews API key.",
      false,
    );
  }
  if (status === 429) {
    return new NewsError(
      "rate_limited",
      "News monitoring has reached the provider's request limit. It will resume automatically.",
      true,
    );
  }
  if (status === 400) {
    return new NewsError(
      "invalid_query",
      "News monitoring sent a search the provider could not run.",
      false,
    );
  }
  if (status >= 500) {
    return new NewsError(
      "provider_error",
      "News monitoring's provider is temporarily unavailable.",
      true,
    );
  }
  return new NewsError(
    "provider_error",
    "News monitoring received an unexpected error from the provider.",
    true,
  );
}

/**
 * One search against GNews's `/search` endpoint.
 *
 * `fetchImpl` is a required parameter rather than a module-level default so
 * this file never has to guess whether it is running under a test stub — that
 * decision belongs to `GNewsMonitor`, which is the one place a real `fetch`
 * default is declared.
 */
export async function searchGNews(
  query: NewsSearchQuery,
  fetchImpl: typeof fetch,
): Promise<GNewsSearchResult> {
  // Task 8 moves this into the validated environment schema in `src/lib/env.ts`.
  // Read directly here for now, at call time, so a build with no key configured
  // still succeeds — only an actual search attempt fails.
  const apiKey = process.env.GNEWS_API_KEY;
  if (!apiKey) {
    throw new NewsError(
      "not_configured",
      "News monitoring is not configured. Add a GNews API key to enable it.",
      false,
    );
  }

  const url = new URL(GNEWS_SEARCH_URL);
  url.searchParams.set("q", buildGNewsQuery(query));
  url.searchParams.set("token", apiKey);
  url.searchParams.set("max", String(query.maxResults));
  // Newest first: an incremental poll cares about what changed since its last
  // cursor, not what GNews considers most relevant.
  url.searchParams.set("sortby", "publishedAt");
  if (query.sourceCountry) url.searchParams.set("country", query.sourceCountry);
  if (query.language) url.searchParams.set("lang", query.language);
  if (query.publishedAfter) url.searchParams.set("from", query.publishedAfter);

  let response: Response;
  try {
    response = await fetchImpl(url.toString());
  } catch {
    // A DNS failure or reset connection is indistinguishable from GNews being
    // down, from the caller's point of view.
    throw new NewsError(
      "provider_error",
      "News monitoring could not reach the provider. It will retry automatically.",
      true,
    );
  }

  if (!response.ok) throw classifyError(response.status);

  const payload = await response.json().catch(() => null);
  const parsed = gnewsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new NewsError(
      "provider_error",
      "News monitoring received an unreadable response from the provider.",
      true,
    );
  }

  return parsed.data;
}
