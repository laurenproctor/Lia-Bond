"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Link2, ShieldCheck } from "lucide-react";
import {
  completeOnboardingSourceAction,
  skipOnboardingSourceAction,
} from "@/app/actions/onboarding";
import {
  OnboardingActions,
  OnboardingError,
  PrimaryAction,
  TertiaryAction,
} from "@/components/onboarding/onboarding-actions";
import {
  OnboardingCard,
  OnboardingNote,
  OnboardingStepHeader,
} from "@/components/onboarding/onboarding-card";
import { GoogleGlyph, PlatformTile } from "@/components/onboarding/platform-tile";

/**
 * Step 2's card.
 *
 * The Google button is a real `<form method="post">` to the existing connect
 * route rather than a client-side call, and that is a security decision carried
 * over from `ConnectGoogleForm`: a GET that mints OAuth state and redirects to
 * a consent screen can be fired by an `<img>` tag on any page on the internet,
 * and the browser has to follow a cross-origin redirect that `fetch` cannot.
 *
 * `redirectPath` is `/onboarding/locations` — a successful grant lands on step
 * 3 rather than returning here, because returning to a step somebody has just
 * completed reads as a failure. The value is validated against
 * `ALLOWED_REDIRECT_PATHS` twice by the server (when the state is issued, and
 * again when it is consumed), so the hidden field is a preference rather than
 * an instruction.
 *
 * Yelp, Tripadvisor, and Trustpilot are rendered as genuinely inert tiles. They
 * are not buttons that do nothing — there is no fake connector behind them, and
 * a control that looks live and is not is worse than one that plainly is not.
 */

const SECONDARY_PLATFORMS = [
  {
    name: "Yelp",
    description: "Connect Yelp to monitor reviews and respond from Lia.",
    tint: "bg-red-100 text-red-600",
    initial: "Y",
  },
  {
    name: "Tripadvisor",
    description: "See and respond to Tripadvisor reviews in one place.",
    tint: "bg-green-100 text-green-600",
    initial: "T",
  },
  {
    name: "Trustpilot",
    description: "Track Trustpilot reviews and protect your online reputation.",
    tint: "bg-green-100 text-green-600",
    initial: "★",
  },
] as const;

export function ConnectSourcesStep({
  connected,
  accountName,
  connectorAvailable,
  alreadySkipped,
}: {
  connected: boolean;
  accountName: string | null;
  connectorAvailable: boolean;
  alreadySkipped: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string; data?: { nextPath: string } }>) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok || !result.data) {
        setError(result.error ?? "That did not work. Try again shortly.");
        return;
      }
      router.push(result.data.nextPath);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <OnboardingCard className="flex flex-col gap-6">
        <OnboardingStepHeader
          icon={Link2}
          title="Connect your first source"
          description="Connect the profiles Lia will monitor and respond through."
        />

        {/* The primary integration. */}
        <div className="rounded-2xl border-2 border-site-blue-edge bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 gap-4">
              <GoogleGlyph />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[16px] font-bold text-site-ink">
                    Google Business Profile
                  </h3>
                  <span className="rounded-full bg-site-blue-tint px-2.5 py-0.5 text-[11px] font-bold text-site-blue">
                    Core integration
                  </span>
                  {connected ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-[11px] font-bold text-green-600">
                      <CheckCircle2 className="size-3.5" aria-hidden />
                      Connected
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 max-w-[52ch] text-[13.5px] leading-relaxed text-site-body">
                  {connected
                    ? accountName
                      ? `Connected as ${accountName}. Lia can read this account's reviews and post replies you approve.`
                      : "Connected. Lia can read this account's reviews and post replies you approve."
                    : "Monitor, respond to, and grow your Google reviews. This is the foundation of your reputation workflow."}
                </p>
              </div>
            </div>

            <div className="shrink-0">
              {connected ? (
                // Already connected: continue rather than reconnect. Starting a
                // second OAuth flow here would not create a duplicate — the
                // connection is upserted on (organization, platform) — but it
                // would send somebody through a consent screen for a grant they
                // already gave.
                <PrimaryAction
                  type="button"
                  pending={pending}
                  pendingLabel="Continuing…"
                  onClick={() => run(completeOnboardingSourceAction)}
                >
                  Continue
                </PrimaryAction>
              ) : connectorAvailable ? (
                <form
                  action="/api/integrations/google-business-profile/connect"
                  method="post"
                >
                  <input
                    type="hidden"
                    name="redirectPath"
                    value="/onboarding/locations"
                  />
                  <button
                    type="submit"
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-site-orange px-6 py-3 text-[15px] font-bold text-site-ink transition-colors hover:bg-site-orange-hover"
                  >
                    Continue with Google
                  </button>
                </form>
              ) : (
                // The connector is not configured on this server. Saying so is
                // the only honest option: a button here would fail with an
                // operator error the customer cannot act on.
                <p className="max-w-[28ch] rounded-xl border border-site-border bg-site-tint px-3 py-2 text-[12.5px] text-site-body">
                  Google is not configured on this server yet. Continue without
                  connecting, and ask your administrator to finish setup.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Available later. Not controls. */}
        <ul className="grid gap-4 sm:grid-cols-3">
          {SECONDARY_PLATFORMS.map((platform) => (
            <PlatformTile key={platform.name} {...platform} />
          ))}
        </ul>

        <OnboardingNote title="You're always in control">
          Lia drafts responses, but nothing goes public until you approve it. You can
          require human approval for any or all responses.
        </OnboardingNote>

        {error ? <OnboardingError>{error}</OnboardingError> : null}

        <OnboardingActions
          primary={
            connected ? (
              <PrimaryAction
                type="button"
                pending={pending}
                pendingLabel="Continuing…"
                onClick={() => run(completeOnboardingSourceAction)}
              >
                Continue
              </PrimaryAction>
            ) : (
              <span className="text-[13px] text-site-muted">
                Connect Google above to continue
              </span>
            )
          }
          tertiary={
            <TertiaryAction
              type="button"
              disabled={pending}
              onClick={() => setConfirmingSkip(true)}
            >
              {alreadySkipped ? "Continue without connecting" : "Continue without connecting"}
            </TertiaryAction>
          }
        />
      </OnboardingCard>

      {confirmingSkip ? (
        <SkipConfirmation
          pending={pending}
          onCancel={() => setConfirmingSkip(false)}
          onConfirm={() => run(skipOnboardingSourceAction)}
        />
      ) : null}
    </div>
  );
}

/**
 * The deliberate confirmation for skipping.
 *
 * Rendered inline rather than in a modal, and it states the two things that
 * actually stop working — there is no vague "are you sure". Skipping is a real
 * choice; it is just one somebody should make knowing that their workspace will
 * start empty.
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
            Continue without connecting a source?
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
