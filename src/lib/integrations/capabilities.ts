import type { PlatformConnection } from "@/domain";
import type { IntegrationCapability } from "@/integrations/connector";

/**
 * What the Google integration can actually do, right now.
 *
 * The honesty requirement in `CLAUDE.md` — never imply direct publishing where
 * the source does not support it — has a sharper form here, and workflow 03
 * moved the line rather than erasing it. Reviews are now genuinely imported, so
 * "Review sync" says so. Nothing else changed: Lia still publishes no reply,
 * and still learns about a new review only when somebody runs a sync.
 *
 * That last point is the one most likely to be misread. A connection that
 * imports reviews on demand is not monitoring, and an operator who assumed it
 * was would find out from a customer. So the sync capability states the manual
 * trigger explicitly rather than leaving "enabled" to imply a feed.
 */
export function googleCapabilities(
  connection: PlatformConnection | null,
): IntegrationCapability[] {
  const live = connection?.status === "connected";

  return [
    {
      id: "account_access",
      label: "Account access",
      state: live ? "enabled" : "not_configured",
      detail: live
        ? "Lia can read the Business Profile accounts this Google user administers."
        : "Connect Google to read the Business Profile accounts this Google user administers.",
    },
    {
      id: "location_discovery",
      label: "Location discovery",
      state: live ? "enabled" : "not_configured",
      detail: live
        ? "Lia can list the locations under each connected account."
        : "Connect Google to list the locations under each account.",
    },
    {
      id: "location_mapping",
      label: "Location mapping",
      state: live ? "enabled" : "not_configured",
      detail: live
        ? "Google locations can be mapped to Lia locations, or used to create new ones."
        : "Connect Google to map its locations onto your Lia locations.",
    },
    {
      id: "review_sync",
      label: "Review sync",
      state: live ? "enabled" : "not_configured",
      detail: live
        ? "Reviews for each connected location are imported into the unified inbox when a sync is run. Lia does not watch Google continuously — a location is as current as its last sync."
        : "Connect Google to import reviews for each mapped location.",
    },
    {
      id: "review_publishing",
      label: "Review publishing",
      state: "not_configured",
      // Unqualified by connection status on purpose: importing reviews changes
      // nothing about whether Lia can answer one. It cannot.
      detail:
        "Not built yet. Lia cannot post replies to Google. Responses are prepared in Lia and posted by a person.",
    },
    {
      id: "webhook_notifications",
      label: "Webhook notifications",
      state: "not_configured",
      detail:
        "Not built yet. Google delivers new-review notifications over Pub/Sub, which Lia does not subscribe to, so new reviews arrive only when a sync runs.",
    },
  ];
}

/**
 * Warnings to surface on the connection.
 *
 * Each one is something a person can act on. Nothing here restates a status
 * badge that is already visible next to it.
 */
export function connectionWarnings(connection: PlatformConnection | null): string[] {
  if (!connection || connection.status === "disconnected") return [];

  const warnings: string[] = [];

  if (connection.lastErrorMessage) warnings.push(connection.lastErrorMessage);

  if (connection.status === "connected" && connection.lastHealthCheckAt === null) {
    warnings.push(
      "This connection has not been tested since it was authorized. Run a connection test to confirm Google still accepts it.",
    );
  }

  if (connection.grantedScopes.length === 0 && connection.status === "connected") {
    warnings.push(
      "No Google permissions are recorded for this connection. Reauthorize to refresh them.",
    );
  }

  return warnings;
}
