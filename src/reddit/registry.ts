import "server-only";

import { ConfigurationError, resolveRedditDeployment, resolveRedditMode } from "@/lib/env";
import type { RedditConnector } from "@/reddit/connector";
import { MockRedditConnector, type RedditMockFaults } from "@/reddit/mock-connector";

/**
 * Which Reddit connector this process should use.
 *
 * Two gates, checked in this order, and the order is the point. A deployment
 * can be perfectly configured — client id, secret, redirect, user agent, vault
 * — and still have no right to call Reddit, because commercial access is an
 * agreement rather than a credential. So the rollout gate is checked *first*:
 * an unapproved deployment is refused before anybody looks at whether its
 * credentials would have worked.
 *
 * The live client is deliberately absent. Building it before Gate 0 is signed
 * would mean shipping code whose only purpose is to make unauthorized requests
 * to Reddit, and leaving it one environment variable away from running. When
 * the agreement exists, `client.ts` implements `RedditConnector` and is
 * returned from the `live` branch below; until then that branch says so.
 */
export function getRedditConnector(
  faults: RedditMockFaults = {},
): RedditConnector {
  const deployment = resolveRedditDeployment();

  if (deployment.effectiveStage === "off") {
    throw new ConfigurationError(
      redditUnavailableReason(deployment.blockers),
      deployment.blockers.slice(),
    );
  }

  const mode = resolveRedditMode();
  if (mode === "mock") return new MockRedditConnector(faults);

  throw new ConfigurationError(
    "Live Reddit access is not implemented on this deployment yet. The connector's live client lands with the signed Reddit agreement; until then only mock mode runs.",
    ["LIA_REDDIT_MODE"],
  );
}

/** Whether Reddit is usable at all here, for callers that must not throw. */
export function isRedditAvailable(): boolean {
  return resolveRedditDeployment().effectiveStage !== "off";
}

/**
 * Why Reddit is unavailable, in a sentence somebody can act on.
 *
 * The blockers are ordered hardest-to-fix first, so the reason reported is the
 * one that actually has to be resolved: telling an operator to generate an
 * encryption key when the real problem is an unsigned agreement sends them
 * down a path that ends where it started.
 */
function redditUnavailableReason(blockers: readonly string[]): string {
  if (blockers.includes("approval_not_recorded")) {
    return "Reddit has not granted this deployment access. Commercial Reddit API access is an agreement, not a setting — see docs/integrations/reddit-access-approval.md.";
  }
  if (blockers.includes("deployment_not_configured")) {
    return "Reddit is not configured on this server.";
  }
  if (blockers.includes("credential_encryption_missing")) {
    return "Credential encryption is not configured, so Reddit tokens cannot be stored.";
  }
  return "Reddit is turned off on this deployment.";
}
