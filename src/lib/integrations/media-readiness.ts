import type { MonitoringQuery } from "@/domain";

/**
 * Why the news and media workspace has nothing to open.
 *
 * The sibling of `reviews-readiness.ts`, and it exists for the same reason:
 * `/media` used to raise `notFound()` whenever no article had been imported,
 * so the most ordinary state a new account can be in — setup not finished —
 * was reported as a broken link.
 *
 * The ladder is different from Google's because news is configured
 * differently. There is no OAuth handshake and no listing to map; the unit of
 * configuration is the monitoring query, and the connection row is provisioned
 * implicitly the first time one is saved (`createMonitoringQuery` in
 * `query-service.ts`). So a connection's absence says nothing here, and these
 * states are read off the queries instead.
 */
export type MediaReadinessState =
  /** No GNews key on this deployment, so no query can ever be polled. */
  | "not_configured"
  /** Nothing is being watched yet. */
  | "no_queries"
  /** Queries exist, but every one of them is switched off. */
  | "all_paused"
  /** An enabled query exists that has never been polled. */
  | "never_polled"
  /** Polled, and nothing has cleared the relevance gate yet. */
  | "no_articles";

export interface MediaReadiness {
  state: MediaReadinessState;
  title: string;
  description: string;
}

export interface MediaReadinessInput {
  /** `isNewsMonitorAvailable()` — whether the server is configured. */
  monitorAvailable: boolean;
  /** Every monitoring query in the organization, enabled or not. */
  queries: MonitoringQuery[];
}

/**
 * Resolved most-blocking-first, like `reviewsReadiness`: there is no point
 * asking somebody to wait for a first poll on a deployment that has no API key
 * to poll with, and no point mentioning the relevance gate to an organization
 * that has not written a query yet.
 */
export function mediaReadiness({
  monitorAvailable,
  queries,
}: MediaReadinessInput): MediaReadiness {
  if (!monitorAvailable) {
    return {
      state: "not_configured",
      title: "News monitoring is not set up",
      description:
        "This deployment has no news provider configured, so no monitoring query can be polled. Your administrator needs to set the GNews API key before coverage can be imported.",
    };
  }

  if (queries.length === 0) {
    return {
      state: "no_queries",
      title: "Nothing is being monitored yet",
      description:
        "News and media coverage lands here once you add a monitoring query — the brand names, locations, and terms Lia should watch for. Lia searches a news index on a schedule; it does not see everything published, and it never comments on an article itself.",
    };
  }

  const enabled = queries.filter((query) => query.enabled);

  if (enabled.length === 0) {
    return {
      state: "all_paused",
      title: "Every monitoring query is paused",
      description:
        queries.length === 1
          ? "The one monitoring query on this organization is switched off, so nothing is being searched for. Enable it to start importing coverage again."
          : `All ${queries.length} monitoring queries on this organization are switched off, so nothing is being searched for. Enable at least one to start importing coverage again.`,
    };
  }

  if (enabled.every((query) => query.lastPolledAt === null)) {
    return {
      state: "never_polled",
      title: "No poll has run yet",
      description:
        "Monitoring is set up, but no search has run, so there is nothing to show. Polls run on each query's own schedule — run one now rather than waiting for the next interval.",
    };
  }

  return {
    state: "no_articles",
    title: "No coverage imported yet",
    description:
      "Monitoring has run, but no article has cleared the relevance threshold for your queries. Widen the keywords or lower the threshold if you expected coverage — the poll history records what was found and rejected.",
  };
}
