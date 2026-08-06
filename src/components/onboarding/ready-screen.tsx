"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  Inbox,
  MapPin,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { startOnboardingImportAction } from "@/app/actions/onboarding";
import {
  OnboardingError,
  PrimaryAction,
} from "@/components/onboarding/onboarding-actions";
import {
  OnboardingCard,
  OnboardingStatusItem,
} from "@/components/onboarding/onboarding-card";
import type { ImportStatus } from "@/lib/onboarding/import-status";
import type { QuickWin } from "@/lib/onboarding/quick-win";

/**
 * The Workspace Ready screen's card.
 *
 * The hierarchy is deliberate and it is the opposite of the obvious one: the
 * **quick win comes first**, the setup summary is a compact strip beneath it,
 * and "Go to Overview" is a quiet secondary link. A checklist of five things
 * somebody has just done is a receipt; the point of this screen is the first
 * thing worth doing next.
 *
 * `Go to Overview` never displaces the quick win, even though it is the
 * destination everything eventually leads to. Somebody with a real draft
 * waiting should be handed the draft.
 */

export interface ReadySummary {
  organizationName: string;
  googleConnected: boolean;
  googleAccountName: string | null;
  locationCount: number;
  brandVoiceSaved: boolean;
  invitationCount: number;
  sourceSkipped: boolean;
}

export function ReadyScreen({
  quickWin,
  importStatus,
  summary,
}: {
  quickWin: QuickWin;
  importStatus: ImportStatus;
  summary: ReadySummary;
}) {
  return (
    <div className="flex flex-col gap-5">
      <QuickWinCard quickWin={quickWin} />

      {summary.sourceSkipped && !summary.googleConnected ? (
        <ConnectSourcePrompt />
      ) : (
        <ImportPanel status={importStatus} />
      )}

      <SummaryStrip summary={summary} />

      <p className="rounded-xl border border-site-border bg-white px-4 py-3 text-[13px] leading-relaxed text-site-body">
        You can start using Lia now. Remaining imports and analysis continue through
        the normal synchronization workflow.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Quick win                                                                   */
/* -------------------------------------------------------------------------- */

function QuickWinCard({ quickWin }: { quickWin: QuickWin }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function startImport() {
    if (pending) return;
    setError(null);
    setMessage(null);

    startTransition(async () => {
      const result = await startOnboardingImportAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // The real outcome, phrased around counts. Never "importing…" left on
      // screen for a run that already finished with nothing.
      setMessage(result.data.message);
      router.refresh();
    });
  }

  return (
    <OnboardingCard className="flex flex-col gap-4 border-site-orange/40 bg-gradient-to-br from-white to-site-amber-tint/40">
      <div className="flex items-start gap-4">
        <span
          className="hidden size-12 shrink-0 items-center justify-center rounded-full bg-site-amber-tint sm:flex"
          aria-hidden
        >
          <Sparkles className="size-6 text-site-orange" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <p className="text-[12px] font-bold tracking-[0.08em] text-site-orange uppercase">
            Get a quick win
          </p>
          <h2 className="mt-1 text-[21px] leading-tight font-bold tracking-[-0.01em] text-site-ink sm:text-[24px]">
            {quickWin.label}
          </h2>
          <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-site-body">
            {quickWin.description}
          </p>
        </div>
      </div>

      {error ? <OnboardingError>{error}</OnboardingError> : null}

      {message ? (
        <p
          role="status"
          className="rounded-xl border border-site-blue-edge bg-site-blue-tint px-4 py-3 text-[13.5px] text-site-blue-ink"
        >
          {message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {quickWin.href ? (
          <Link
            href={quickWin.href}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-site-orange px-6 py-3 text-[15px] font-bold text-site-ink transition-colors hover:bg-site-orange-hover"
          >
            {quickWin.label}
            <ArrowRight className="size-[18px]" strokeWidth={2.4} aria-hidden />
          </Link>
        ) : (
          <PrimaryAction
            type="button"
            pending={pending}
            pendingLabel="Importing…"
            onClick={startImport}
            icon={false}
          >
            <Download className="size-[18px]" strokeWidth={2.2} aria-hidden />
            {quickWin.label}
          </PrimaryAction>
        )}

        <SecondaryNav />
      </div>
    </OnboardingCard>
  );
}

/** The quieter destinations. Never the primary action. */
function SecondaryNav() {
  const links = [
    { href: "/mentions", label: "Open mentions inbox", icon: Inbox },
    { href: "/locations", label: "View connected locations", icon: MapPin },
    { href: "/overview", label: "Go to Overview", icon: ArrowRight },
  ];

  return (
    <>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-site-blue-edge bg-white px-4 py-3 text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
        >
          <link.icon className="size-4" aria-hidden />
          {link.label}
        </Link>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Import progress                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Real sync state, or nothing.
 *
 * Renders only when there is something true to say. There is **no percentage**
 * anywhere in this component, and no progress bar: Google does not tell Lia how
 * many reviews a location has until a page has been fetched, so any bar drawn
 * here would be filled from a number nobody computed.
 */
function ImportPanel({ status }: { status: ImportStatus }) {
  if (status.connectedProfiles === 0) return null;

  if (!status.hasStarted) {
    return (
      <OnboardingCard className="flex flex-col gap-2">
        <h2 className="text-[16px] font-bold text-site-ink">Import progress</h2>
        <p className="text-[13.5px] leading-relaxed text-site-body">
          No import has run yet. {status.connectedProfiles}{" "}
          {status.connectedProfiles === 1 ? "location is" : "locations are"}{" "}
          connected and ready — use the button above to bring your existing reviews
          into Lia.
        </p>
      </OnboardingCard>
    );
  }

  const stats = [
    { label: "Locations connected", value: status.connectedProfiles },
    { label: "Reviews fetched", value: status.reviewsFetched },
    { label: "Reviews added", value: status.reviewsCreated },
    { label: "Reviews updated", value: status.reviewsUpdated },
  ];

  return (
    <OnboardingCard className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-bold text-site-ink">Import progress</h2>
        {status.isRunning ? (
          <p className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-site-blue">
            <RefreshCw className="size-3.5 animate-spin" aria-hidden />
            Running now
          </p>
        ) : (
          <p className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-green-600">
            <CheckCircle2 className="size-3.5" aria-hidden />
            Last run finished
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-site-border bg-site-tint px-3 py-2.5"
          >
            <dd className="text-[20px] leading-none font-bold text-site-ink">
              {stat.value}
            </dd>
            <dt className="mt-1 text-[11.5px] font-semibold text-site-body">
              {stat.label}
            </dt>
          </div>
        ))}
      </dl>

      {/* Rendered only when the provider actually reported a total. Presented as
          "of N", never divided into a percentage against a numerator that
          counts something else. */}
      {status.totalReviewCount !== null ? (
        <p className="text-[12.5px] text-site-body">
          Google reports {status.totalReviewCount} reviews in total across these
          locations.
        </p>
      ) : null}

      {status.lastSuccessfulAt ? (
        <p className="text-[12.5px] text-site-muted">
          Last successful import{" "}
          {new Date(status.lastSuccessfulAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          .
        </p>
      ) : null}

      {status.failedRuns > 0 ? (
        <p
          role="status"
          className="rounded-xl border border-red-600/30 bg-red-100 px-3 py-2 text-[13px] text-red-600"
        >
          {status.failedRuns}{" "}
          {status.failedRuns === 1 ? "location" : "locations"} could not be imported.
          Check the connection on the integrations screen and try again.
        </p>
      ) : status.degradedRuns > 0 ? (
        <p
          role="status"
          className="rounded-xl border border-site-amber-edge/40 bg-site-amber-tint px-3 py-2 text-[13px] text-site-amber-ink"
        >
          {status.degradedRuns}{" "}
          {status.degradedRuns === 1 ? "location" : "locations"} imported partially.
          The reviews that came through are saved; the rest will be picked up on
          the next run.
        </p>
      ) : null}
    </OnboardingCard>
  );
}

/** Shown instead of the import panel when no source was ever connected. */
function ConnectSourcePrompt() {
  return (
    <OnboardingCard className="flex flex-col gap-3">
      <h2 className="text-[16px] font-bold text-site-ink">
        Connect Google Business Profile
      </h2>
      <p className="max-w-[62ch] text-[13.5px] leading-relaxed text-site-body">
        You finished setup without connecting a source, so there is nothing for Lia
        to monitor yet. Connecting Google brings your existing reviews in and starts
        the monitoring your workspace is built around.
      </p>
      <Link
        href="/integrations/google-business-profile"
        className="inline-flex min-h-[44px] w-fit items-center justify-center gap-2 rounded-xl border border-site-blue-edge bg-white px-5 py-3 text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
      >
        Go to integrations
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </OnboardingCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Setup summary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What setup produced, compactly.
 *
 * A two-column list rather than five large numbered rows: this is confirmation,
 * not the point of the page. Each line reports the truth — a skipped source
 * says so rather than being omitted, which would read as connected.
 */
function SummaryStrip({ summary }: { summary: ReadySummary }) {
  return (
    <OnboardingCard className="flex flex-col gap-3">
      <h2 className="text-[16px] font-bold text-site-ink">What you set up</h2>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        <OnboardingStatusItem
          label="Organization configured"
          value={summary.organizationName}
          done
        />
        <OnboardingStatusItem
          label={summary.googleConnected ? "Google connected" : "No source connected"}
          value={
            summary.googleConnected
              ? (summary.googleAccountName ?? "Google Business Profile")
              : "Connect one from the integrations screen"
          }
          done={summary.googleConnected}
        />
        <OnboardingStatusItem
          label="Locations configured"
          value={
            summary.locationCount === 1
              ? "1 location"
              : `${summary.locationCount} locations`
          }
          done={summary.locationCount > 0}
        />
        <OnboardingStatusItem
          label="Brand voice"
          value={summary.brandVoiceSaved ? "Saved" : "Not set yet"}
          done={summary.brandVoiceSaved}
        />
        <OnboardingStatusItem
          label="Invitation links created"
          value={
            summary.invitationCount === 0
              ? "None — invite people from Settings"
              : summary.invitationCount === 1
                ? "1 link, waiting to be accepted"
                : `${summary.invitationCount} links, waiting to be accepted`
          }
          done={summary.invitationCount > 0}
        />
      </ul>
    </OnboardingCard>
  );
}
