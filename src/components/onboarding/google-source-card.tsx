"use client";

import { CheckCircle2 } from "lucide-react";
import { OnboardingSourceCard } from "@/components/onboarding/onboarding-source-card";
import { GoogleGlyph } from "@/components/onboarding/platform-tile";

/**
 * The Google Business Profile source card.
 *
 * The connect button is a real `<form method="post">` to the existing connect
 * route rather than a client-side call, a security decision carried over from
 * `ConnectGoogleForm`: a GET that mints OAuth state and redirects to a consent
 * screen can be fired by an `<img>` tag on any page on the internet, and the
 * browser has to follow a cross-origin redirect that `fetch` cannot.
 *
 * `redirectPath` is `/onboarding/connect-sources` — the grant returns to this
 * screen, so the person can configure the optional News monitoring beside it
 * before moving on. The value is validated against `ALLOWED_REDIRECT_PATHS`
 * twice by the server (when the state is issued, and again when it is
 * consumed), so the hidden field is a preference rather than an instruction.
 *
 * Connected, the card never pushes anybody back through OAuth: the primary
 * affordance becomes the page's own "Save and continue", and "Manage
 * connection" — a deliberate reauthorization, for switching accounts or
 * refreshing a grant — is a quiet secondary. It cannot link to the
 * integrations screen instead, because the product shell diverts an
 * unfinished organization straight back into this wizard.
 */

const BENEFITS = [
  "Import reviews and messages",
  "Add and manage locations",
  "Route feedback for response",
] as const;

export function GoogleSourceCard({
  connected,
  accountName,
  connectorAvailable,
}: {
  connected: boolean;
  accountName: string | null;
  connectorAvailable: boolean;
}) {
  return (
    <OnboardingSourceCard
      glyph={<GoogleGlyph />}
      title="Google Business Profile"
      status={connected ? "connected" : "recommended"}
    >
      <p className="text-[13px] leading-relaxed text-site-body">
        {connected
          ? accountName
            ? `Connected as ${accountName}. Lia can read this account's reviews and post replies you approve.`
            : "Connected. Lia can read this account's reviews and post replies you approve."
          : "Connect your Google account to import reviews and select the locations Lia should monitor."}
      </p>

      {!connected ? (
        <ul className="flex flex-col gap-1.5">
          {BENEFITS.map((benefit) => (
            <li
              key={benefit}
              className="flex items-start gap-2 text-[12.5px] leading-snug text-site-body"
            >
              <CheckCircle2
                className="mt-0.5 size-4 shrink-0 text-green-600"
                strokeWidth={2}
                aria-hidden
              />
              {benefit}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-auto pt-1">
        {connected ? (
          <form
            action="/api/integrations/google-business-profile/connect"
            method="post"
          >
            <input type="hidden" name="redirectPath" value="/onboarding/connect-sources" />
            <input type="hidden" name="reauthorize" value="1" />
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl border border-site-blue-edge bg-white px-4 py-2.5 text-[13.5px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
            >
              Manage connection
            </button>
          </form>
        ) : connectorAvailable ? (
          <form
            action="/api/integrations/google-business-profile/connect"
            method="post"
          >
            <input type="hidden" name="redirectPath" value="/onboarding/connect-sources" />
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-site-orange px-4 py-2.5 text-[14px] font-bold text-site-ink transition-colors hover:bg-site-orange-hover"
            >
              Connect with Google
            </button>
          </form>
        ) : (
          // The connector is not configured on this server. Saying so is the
          // only honest option: a button here would fail with an operator
          // error the customer cannot act on.
          <p className="rounded-xl border border-site-border bg-site-tint px-3 py-2 text-[12.5px] leading-relaxed text-site-body">
            Google is not configured on this server yet. Continue without
            connecting, and ask your administrator to finish setup.
          </p>
        )}
      </div>
    </OnboardingSourceCard>
  );
}
