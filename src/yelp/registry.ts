import "server-only";

import { resolveYelpMode } from "@/lib/env";
import { YelpFusionClient } from "@/yelp/client";
import { YelpError } from "@/yelp/errors";
import { MockYelpProvider, type YelpMockFaults } from "@/yelp/mock-provider";
import type { YelpPlacesProvider } from "@/yelp/places";

/**
 * Yelp provider resolution.
 *
 * Mirrors `src/news/registry.ts` and `src/integrations/registry.ts`: the only
 * place that decides whether a caller gets the real Fusion client or the
 * deterministic mock. Callers ask for a provider and get a
 * `YelpPlacesProvider`; nothing above this file can tell which implementation
 * it received, which is what stops "is this mocked?" leaking into route
 * handlers and screens.
 *
 * Unlike Reddit's registry there is no rollout gate here, and the asymmetry is
 * deliberate rather than an omission. Reddit's commercial agreement governs
 * whether Lia may make the calls at all, so a configured deployment can still
 * have no right to run. Yelp's Places API is a published, self-service product:
 * holding a key *is* the permission. What Lia does not hold is the Partner API,
 * and that is expressed as a permanently-false capability
 * (`YELP_ASSISTED_CAPABILITIES`) rather than as a stage somebody could turn up.
 */

export function getYelpProvider(faults: YelpMockFaults = {}): YelpPlacesProvider {
  const mode = resolveYelpMode();

  if (mode === "mock") return new MockYelpProvider(faults);
  if (mode === "live") return new YelpFusionClient();

  throw new YelpError(
    "not_configured",
    "Yelp is not configured for this deployment.",
    false,
  );
}

/** True when Yelp can be used at all here, for callers that must not throw. */
export function isYelpAvailable(): boolean {
  try {
    return resolveYelpMode() !== "unconfigured";
  } catch {
    // resolveYelpMode throws only on mock-in-production, which is a
    // misconfiguration, not an availability answer.
    return false;
  }
}
