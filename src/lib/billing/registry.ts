import "server-only";

import { ConfigurationError, resolveBillingMode } from "@/lib/env";
import { createMockStripeGateway } from "@/lib/billing/mock-gateway";
import { createStripeGateway } from "@/lib/billing/stripe-gateway";
import type { StripeGateway } from "@/lib/billing/gateway";

/**
 * Gateway resolution.
 *
 * Mirrors `src/news/registry.ts` and `src/integrations/registry.ts`: the one
 * place that decides whether a caller gets real Stripe or the deterministic
 * fake. Callers ask for a `StripeGateway` and nothing above this file can tell
 * which they received.
 *
 * The mock is process-wide rather than per-request, because it *is* the
 * store: a session created by one request has to be completable by the next,
 * exactly as a real Stripe session would be. Same reasoning as the demo data
 * source singleton.
 */

let mockSingleton: StripeGateway | null = null;

export function getStripeGateway(): StripeGateway {
  const mode = resolveBillingMode();

  if (mode === "mock") {
    mockSingleton ??= createMockStripeGateway();
    return mockSingleton;
  }
  if (mode === "live") return createStripeGateway();

  // Not an exception path so much as the ordinary state of a deployment
  // nobody has set Stripe up on. `runAction` renders this as "ask your
  // administrator", which is the truthful thing to show.
  throw new ConfigurationError(
    "Billing is not configured on this server.",
    ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  );
}

/** Whether billing can be operated at all on this deployment. */
export function isBillingAvailable(): boolean {
  try {
    return resolveBillingMode() !== "unconfigured";
  } catch {
    // resolveBillingMode throws only on mock-in-production, which is a
    // misconfiguration rather than an availability answer.
    return false;
  }
}

/** Test seam: replaces the process-wide mock between cases. */
export function __setMockGatewayForTests(gateway: StripeGateway | null): void {
  mockSingleton = gateway;
}
