import "server-only";

import { cache } from "react";
import { emptyBilling, type OrganizationBilling } from "@/domain";
import { getDataSource } from "@/lib/data";
import {
  billingOrganizationAllowlist,
  resolveBillingEnforcementMode,
} from "@/lib/env";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { resolveEntitlement, type Entitlement } from "@/lib/billing/entitlement";

/**
 * The active organization's billing state and entitlement, once per request.
 *
 * Wrapped in React's `cache` for the same reason `getOrganizationContext` is:
 * the app shell, the billing banner, the page beneath, and every server action
 * on that request all need the answer, and each paying for its own query would
 * turn one read into five.
 *
 * The clock is read here rather than passed in, and this is the one place that
 * is right: `resolveEntitlement` itself takes `now` precisely so every state is
 * reachable from a test, and this function is the production caller that
 * supplies it.
 */

export const getBillingProjection = cache(
  async (): Promise<OrganizationBilling> => {
    const context = await getOrganizationContext();
    const dataSource = await getDataSource();
    const stored = await dataSource.billing.get(context.scope);

    // Absence is an ordinary state — every organization that predates billing
    // and every one that has not reached Checkout — so it resolves to an
    // unwritten row rather than to null. What "unbilled" then *means* is
    // decided by the enforcement mode, not here.
    return stored ?? emptyBilling(context.organization.id, new Date().toISOString());
  },
);

export const getEntitlement = cache(async (): Promise<Entitlement> => {
  const billing = await getBillingProjection();

  return resolveEntitlement({
    billing,
    enforcement: resolveBillingEnforcementMode(),
    allowlist: billingOrganizationAllowlist(),
    now: new Date().toISOString(),
  });
});
