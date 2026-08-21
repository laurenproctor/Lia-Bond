import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { BillingBanner } from "@/components/billing/billing-banner";
import { requireSession } from "@/lib/auth/session";
import { getBillingProjection, getEntitlement } from "@/lib/billing/context";
import { getDataSource } from "@/lib/data";
import { isUnintentionalDemoMode } from "@/lib/env";
import { redirectIfOnboarding } from "@/lib/onboarding/context";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { initialsFor } from "@/lib/view-models/mention";

/**
 * The one shell every route renders inside.
 *
 * Resolves the active organization once per request — `getOrganizationContext`
 * is memoised for the request, so the pages beneath share this lookup rather
 * than repeating it. Sidebar counts come from the repository so the badges stay
 * honest as records change.
 *
 * The onboarding check runs **first**, before the sidebar queries and before
 * anything renders. An owner whose workspace has no source connected and no
 * locations mapped must not be shown a dashboard implying setup is finished —
 * and the counts below would all read zero, which looks like a broken product
 * rather than an unconfigured one.
 *
 * `/onboarding` is outside this route group, so the redirect leaves this layout
 * entirely. It cannot loop with the wizard's own guard: this one diverts
 * organizations that are *not* finished, and that one diverts organizations
 * that *are*.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await redirectIfOnboarding();

  const [session, context, dataSource, billing, entitlement] = await Promise.all([
    requireSession(),
    getOrganizationContext(),
    getDataSource(),
    // Both are request-cached, so the page beneath and every server action on
    // this request share these two reads rather than repeating them.
    getBillingProjection(),
    getEntitlement(),
  ]);

  const [openMentions, escalations] = await Promise.all([
    dataSource.mentions.listNeedingAttention(context.scope),
    dataSource.escalations.list(context.scope, {
      statuses: ["open", "in_progress", "pending_approval"],
    }),
  ]);

  return (
    <AppShell
      banner={<BillingBanner entitlement={entitlement} billing={billing} />}
      sidebar={{
        organizations: context.available,
        activeOrganizationId: context.organization.id,
        user: {
          name: session.fullName || session.email,
          email: session.email,
          initials: initialsFor(session.fullName || session.email),
          avatarUrl: session.avatarUrl,
          role: context.role,
        },
        badgeCounts: {
          mentions: openMentions.length,
          escalations: escalations.length,
        },
        demoMode: isUnintentionalDemoMode(),
      }}
    >
      {children}
    </AppShell>
  );
}
