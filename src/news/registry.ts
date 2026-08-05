import "server-only";

import { resolveNewsMode } from "@/lib/env";
import { GNewsMonitor } from "@/news/gnews/monitor";
import { MockNewsMonitor } from "@/news/mock-monitor";
import { NewsError } from "@/news/errors";
import type { NewsMonitor } from "@/news/monitor";

/**
 * News monitor resolution.
 *
 * Mirrors `src/integrations/registry.ts`: the only place that decides whether
 * a caller gets the real GNews monitor or the deterministic mock. Callers ask
 * for a monitor and get a `NewsMonitor`; nothing above this file can tell
 * which implementation it received.
 */

export function getNewsMonitor(): NewsMonitor {
  const mode = resolveNewsMode();

  if (mode === "mock") return new MockNewsMonitor();
  if (mode === "live") return new GNewsMonitor();

  throw new NewsError(
    "not_configured",
    "News monitoring is not configured for this deployment.",
    false,
  );
}

/** True when news monitoring can be started at all on this deployment. */
export function isNewsMonitorAvailable(): boolean {
  try {
    return resolveNewsMode() !== "unconfigured";
  } catch {
    // resolveNewsMode throws only on mock-in-production, which is a
    // misconfiguration, not an availability answer.
    return false;
  }
}
