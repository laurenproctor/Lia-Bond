import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/lib/auth/session";
import { getDataSource } from "@/lib/data";
import { isUnintentionalDemoMode } from "@/lib/env";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { initialsFor } from "@/lib/view-models/mention";

/**
 * The one shell every route renders inside.
 *
 * Resolves the active organization once per request — `getOrganizationContext`
 * is memoised for the request, so the pages beneath share this lookup rather
 * than repeating it. Sidebar counts come from the repository so the badges stay
 * honest as records change.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [session, context, dataSource] = await Promise.all([
    requireSession(),
    getOrganizationContext(),
    getDataSource(),
  ]);

  const [openMentions, escalations] = await Promise.all([
    dataSource.mentions.listNeedingAttention(context.scope),
    dataSource.escalations.list(context.scope, {
      statuses: ["open", "in_progress", "pending_approval"],
    }),
  ]);

  return (
    <AppShell
      sidebar={{
        organizations: context.available,
        activeOrganizationId: context.organization.id,
        user: {
          name: session.fullName || session.email,
          email: session.email,
          initials: initialsFor(session.fullName || session.email),
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
