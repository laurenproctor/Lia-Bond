import "server-only";

import type { Platform } from "@/domain";
import type { PlatformConnector } from "@/integrations/connector";
import { createGoogleBusinessProfileConnector } from "@/integrations/google-business-profile/connector";
import { createMockGoogleConnector } from "@/integrations/google-business-profile/mock-connector";
import {
  ConfigurationError,
  requireGoogleOAuthConfig,
  resolveGoogleIntegrationMode,
} from "@/lib/env";

/**
 * Connector resolution.
 *
 * The only place that decides whether a caller gets the real Google connector
 * or the deterministic mock. Callers ask for a platform and get a
 * `PlatformConnector`; nothing above this file can tell which implementation it
 * received, which is what stops "is this mocked?" leaking into route handlers
 * and screens.
 */

export function getConnector(platform: Platform): PlatformConnector {
  if (platform === "google_business_profile") return getGoogleConnector();

  throw new ConfigurationError(
    `No connector is implemented for ${platform.replace(/_/g, " ")} yet.`,
  );
}

export function getGoogleConnector(): PlatformConnector {
  const mode = resolveGoogleIntegrationMode();

  if (mode === "mock") return createMockGoogleConnector();

  if (mode === "unconfigured") {
    throw new ConfigurationError(
      "Google Business Profile is not configured on this server.",
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"],
    );
  }

  // Throws a ConfigurationError naming exactly what is missing, which is what
  // an operator needs — "Google is not configured" alone sends them hunting.
  return createGoogleBusinessProfileConnector(requireGoogleOAuthConfig());
}

/** True when the Google integration can be started at all on this deployment. */
export function isGoogleConnectorAvailable(): boolean {
  try {
    return resolveGoogleIntegrationMode() !== "unconfigured";
  } catch {
    // resolveGoogleIntegrationMode throws only on mock-in-production, which is
    // a misconfiguration, not an availability answer.
    return false;
  }
}
