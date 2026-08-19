import type { Metadata } from "next";
import { PartyPopper } from "lucide-react";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { OnboardingDoodle } from "@/components/onboarding/onboarding-doodle";
import { ReadyScreen } from "@/components/onboarding/ready-screen";
import { requireOnboardingReady } from "@/lib/onboarding/context";
import { readImportStatus } from "@/lib/onboarding/import-status";
import { resolveQuickWin } from "@/lib/onboarding/quick-win";
import { markReadyViewed } from "@/lib/onboarding/service";

export const metadata: Metadata = { title: "Your workspace is ready" };

/**
 * The Workspace Ready screen.
 *
 * **Not step six.** `OnboardingShell` is given a null step, so no five-step
 * progress strip renders here and there is no current-step badge anywhere on
 * the page. Setup is finished; framing it as an unfinished wizard would be
 * false and would invite somebody to look for a next step that does not exist.
 *
 * Every number on this screen comes from the database. The import panel is
 * built from real `platform_sync_runs` rows and renders no percentage at all —
 * there is no honest denominator, and a progress bar at "68%" with nothing
 * behind the 68 is the most misleading thing this page could show. The quick
 * win is chosen by reading real drafts, mentions, profiles, and connections.
 *
 * The view is recorded here rather than from the client, so it happens once per
 * organization on the server and cannot be lost to a failed fetch.
 */
export default async function OnboardingReadyPage() {
  const context = await requireOnboardingReady();
  const { dataSource, scope } = context;

  const [quickWin, importStatus, locations, connection, pendingInvitations] =
    await Promise.all([
      resolveQuickWin({ dataSource, scope }),
      readImportStatus(dataSource, scope),
      dataSource.locations.list(scope),
      dataSource.platformConnections.getByPlatform(scope, "google_business_profile"),
      dataSource.invitations.listPending(scope),
    ]);

  // Best-effort and after the reads: failing to stamp a "seen it" timestamp
  // must not stop somebody seeing the screen it records.
  await markReadyViewed({ dataSource, scope }).catch(() => undefined);

  const googleConnected =
    Boolean(connection) && connection?.status !== "disconnected";

  return (
    <OnboardingShell
      organizations={context.available}
      activeOrganizationId={context.organization.id}
      step={null}
      state={context.state}
      aside={
        <div className="relative flex flex-col gap-6">
          <OnboardingDoodle
            variant="blue"
            float="b"
            className="absolute -top-3 right-0 hidden h-11 w-auto lg:block"
          />

          <div className="flex flex-col gap-4">
            <p className="inline-flex w-fit items-center gap-2 rounded-full bg-green-100 px-3 py-1 text-[11px] font-bold tracking-[0.08em] text-green-600 uppercase">
              <PartyPopper className="size-3.5" aria-hidden />
              Setup complete
            </p>
            <h1 className="max-w-[13ch] text-[34px] leading-[1.05] font-extrabold tracking-[-0.02em] text-balance text-site-ink sm:text-[40px] lg:text-[44px]">
              Your Lia workspace is ready
            </h1>
            <p className="max-w-[46ch] text-[15px] leading-relaxed text-site-body">
              Setup is complete. Lia can continue importing and analyzing your
              feedback while you start using the workspace.
            </p>
          </div>
        </div>
      }
    >
      <ReadyScreen
        quickWin={quickWin}
        importStatus={importStatus}
        summary={{
          organizationName: context.organization.name,
          googleConnected,
          googleAccountName: connection?.externalAccountName ?? null,
          locationCount: locations.length,
          brandVoiceSaved: context.state.brandVoiceCompletedAt !== null,
          invitationCount: pendingInvitations.length,
          sourceSkipped: context.state.sourceSkippedAt !== null,
        }}
      />
    </OnboardingShell>
  );
}
