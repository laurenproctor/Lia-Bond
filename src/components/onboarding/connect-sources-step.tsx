"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, ShieldCheck } from "lucide-react";
import {
  completeOnboardingSourceAction,
  skipOnboardingSourceAction,
} from "@/app/actions/onboarding";
import {
  OnboardingActions,
  OnboardingError,
  PrimaryAction,
  SecondaryLink,
  TertiaryAction,
} from "@/components/onboarding/onboarding-actions";
import {
  OnboardingCard,
  OnboardingNote,
  OnboardingStepHeader,
} from "@/components/onboarding/onboarding-card";
import { GoogleSourceCard } from "@/components/onboarding/google-source-card";
import {
  NewsMonitoringConfigurator,
  type NewsConfiguratorHandle,
  type NewsConfiguratorValues,
} from "@/components/onboarding/news-monitoring-configurator";
import {
  NewsSourceCard,
  type NewsCardSummary,
} from "@/components/onboarding/news-source-card";
import { RedditSourceCard } from "@/components/onboarding/reddit-source-card";

/**
 * Step 2 — the three-source screen.
 *
 * Google is the prerequisite: the step completes when it is connected, or
 * when the person deliberately confirms continuing without it. News & Media
 * is optional configuration against the real monitoring-query system, and
 * Reddit is presented exactly as capable as it is — which today is not at
 * all (`reddit-source-card.tsx` explains).
 *
 * The News panel autosaves, so there is normally nothing outstanding by the
 * time anyone leaves. "Save and continue" still flushes it: it covers the
 * settling window, and it is what confirms an untouched panel of defaults —
 * pressing the page's main button with News open means those defaults, and
 * the step never navigates away from a configuration that failed to save.
 */

export interface ConnectSourcesViewModel {
  google: {
    available: boolean;
    connected: boolean;
    accountName: string | null;
    /** The OAuth callback just returned. Worth announcing once. */
    justConnected: boolean;
  };
  news: NewsCardSummary & {
    /** Prefill for the configurator: the persisted query, or real-data suggestions. */
    initialValues: NewsConfiguratorValues;
    /** True when `initialValues` came from a row rather than from defaults. */
    initialValuesPersisted: boolean;
    keywordSuggestions: string[];
  };
  reddit: {
    capability: "available" | "unavailable";
    configured: boolean;
    operational: boolean;
    keywordCount: number;
    priorityCommunityCount: number;
    lastSuccessfulPollAt: string | null;
  };
}

export function ConnectSourcesStep({
  model,
  alreadySkipped,
}: {
  model: ConnectSourcesViewModel;
  alreadySkipped: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newsOpen, setNewsOpen] = useState(false);
  const configuratorRef = useRef<NewsConfiguratorHandle>(null);
  const newsButtonRef = useRef<HTMLButtonElement>(null);

  function closeNews() {
    setNewsOpen(false);
    // Focus returns to the control that opened the section, so a keyboard
    // user is not dropped at the top of the document.
    newsButtonRef.current?.focus();
  }

  function navigate(action: () => Promise<{ ok: boolean; error?: string; data?: { nextPath: string } }>) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      // News input the settling window has not sent yet is persisted before
      // the step advances. "failed" aborts: the configurator is showing
      // exactly what is wrong, and navigating would throw the person's input
      // away over it.
      if (newsOpen) {
        const flushed = await configuratorRef.current?.flush();
        if (flushed === "failed") return;
      }

      const result = await action();
      if (!result.ok || !result.data) {
        setError(result.error ?? "That did not work. Try again shortly.");
        return;
      }
      router.push(result.data.nextPath);
    });
  }

  function saveAndContinue() {
    if (model.google.connected) {
      navigate(completeOnboardingSourceAction);
      return;
    }
    if (alreadySkipped) {
      // The skip is already recorded; repeating it would write a second
      // audit event for a decision already made. The guard lets a settled
      // step move forward, so this is a plain navigation.
      navigate(async () => ({ ok: true, data: { nextPath: "/onboarding/locations" } }));
      return;
    }
    // Not connected and never skipped: continuing without Google is a real
    // decision with consequences, and it gets the same deliberate
    // confirmation whichever button initiated it.
    setConfirmingSkip(true);
  }

  return (
    <div className="flex flex-col gap-6">
      <OnboardingCard className="flex flex-col gap-6">
        <OnboardingStepHeader
          icon={Link2}
          title="Connect and configure your sources"
          description="Start with Google, our core integration for reviews and locations. Then expand your coverage with News & Media and Reddit."
        />

        {model.google.justConnected ? (
          <p
            role="status"
            className="rounded-xl border border-green-600/20 bg-green-100 px-4 py-3 text-[13.5px] text-green-700"
          >
            Google is connected. Configure optional monitoring below, or save
            and continue.
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <GoogleSourceCard
            connected={model.google.connected}
            accountName={model.google.accountName}
            connectorAvailable={model.google.available}
          />
          <NewsSourceCard
            summary={model.news}
            expanded={newsOpen}
            onToggle={() => (newsOpen ? closeNews() : setNewsOpen(true))}
            buttonRef={newsButtonRef}
          />
          <RedditSourceCard />
        </div>

        {newsOpen ? (
          <NewsMonitoringConfigurator
            initial={model.news.initialValues}
            persisted={model.news.initialValuesPersisted}
            suggestions={model.news.keywordSuggestions}
            onClose={closeNews}
            handleRef={configuratorRef}
          />
        ) : null}

        <OnboardingNote title="You stay in control">
          Lia can monitor reviews, news, and supported conversations, but
          nothing is published without your approval.
        </OnboardingNote>

        {error ? <OnboardingError>{error}</OnboardingError> : null}

        <OnboardingActions
          primary={
            <PrimaryAction
              type="button"
              pending={pending}
              pendingLabel="Saving…"
              onClick={saveAndContinue}
            >
              Save and continue
            </PrimaryAction>
          }
          secondary={<SecondaryLink href="/onboarding/organization">Back</SecondaryLink>}
          tertiary={
            model.google.connected ? null : (
              <TertiaryAction
                type="button"
                disabled={pending}
                onClick={() =>
                  alreadySkipped
                    ? navigate(async () => ({
                        ok: true,
                        data: { nextPath: "/onboarding/locations" },
                      }))
                    : setConfirmingSkip(true)
                }
              >
                Continue without connecting
              </TertiaryAction>
            )
          }
        />
      </OnboardingCard>

      {confirmingSkip ? (
        <SkipConfirmation
          pending={pending}
          onCancel={() => setConfirmingSkip(false)}
          onConfirm={() => navigate(skipOnboardingSourceAction)}
        />
      ) : null}
    </div>
  );
}

/**
 * The deliberate confirmation for skipping Google.
 *
 * Rendered inline rather than in a modal, and it states the things that
 * actually stop working — there is no vague "are you sure". Skipping is a
 * real choice; it is just one somebody should make knowing that their
 * workspace will start empty.
 */
function SkipConfirmation({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <OnboardingCard className="flex flex-col gap-4 border-site-amber-edge/40 bg-site-amber-tint">
      <div className="flex gap-3">
        <ShieldCheck
          className="mt-0.5 size-5 shrink-0 text-site-amber-edge"
          strokeWidth={2}
          aria-hidden
        />
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-site-amber-ink">
            Continue without connecting Google?
          </h3>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[13.5px] leading-relaxed text-site-amber-ink">
            <li>Lia cannot import your existing reviews.</li>
            <li>
              Google location discovery is unavailable, so you will add locations by
              hand on the next step.
            </li>
            <li>
              Your workspace starts empty until a source is connected from the
              integrations screen.
            </li>
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-site-blue-edge bg-white px-5 py-3 text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint disabled:opacity-60"
        >
          Go back and connect
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-site-amber-edge bg-white px-5 py-3 text-[14px] font-semibold text-site-amber-ink transition-colors hover:bg-site-amber-tint disabled:opacity-60"
        >
          {pending ? "Continuing…" : "Yes, continue without connecting"}
        </button>
      </div>
    </OnboardingCard>
  );
}
