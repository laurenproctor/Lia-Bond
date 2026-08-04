import "server-only";

import { createAnthropicProvider } from "@/ai/anthropic/client";
import { createMockAiProvider } from "@/ai/mock-provider";
import type { AiProvider } from "@/ai/provider";
import {
  ConfigurationError,
  requireAnthropicApiKey,
  resolveAiMode,
} from "@/lib/env";

/**
 * Provider resolution.
 *
 * The only place that decides whether a caller gets the real model or the
 * deterministic mock. Callers ask for a provider and get an `AiProvider`;
 * nothing above this file can tell which implementation it received, which is
 * what stops "is this mocked?" leaking into the analysis service and from
 * there into a screen.
 *
 * Mirrors `src/integrations/registry.ts` exactly, including the failure mode:
 * an unconfigured deployment throws a `ConfigurationError` naming the variable
 * rather than silently falling back to fixtures.
 */
export function getAiProvider(): AiProvider {
  const mode = resolveAiMode();

  if (mode === "mock") return createMockAiProvider();

  if (mode === "unconfigured") {
    throw new ConfigurationError(
      "Mention analysis is not configured on this server.",
      ["ANTHROPIC_API_KEY"],
    );
  }

  return createAnthropicProvider({ apiKey: requireAnthropicApiKey() });
}

/** True when analysis can be run at all on this deployment. */
export function isAiAvailable(): boolean {
  try {
    return resolveAiMode() !== "unconfigured";
  } catch {
    // resolveAiMode throws only on mock-in-production, which is a
    // misconfiguration, not an availability answer.
    return false;
  }
}
