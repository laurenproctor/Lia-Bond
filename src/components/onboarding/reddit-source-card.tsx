"use client";

import { useId } from "react";
import { OnboardingSourceCard } from "@/components/onboarding/onboarding-source-card";

/**
 * The Reddit source card — honest about what exists.
 *
 * There is no Reddit connector, monitor, persistence, or polling service in
 * this repository: `reddit` is enum vocabulary, seed fixtures, and a
 * presentation route, and `getConnector("reddit")` throws. So this card
 * states that plainly. No "Active", no "Connected", no monitored-term or
 * community counts — every number on step 2 must come from a persisted
 * operational record, and Reddit has none.
 *
 * The control is a genuinely disabled button rather than the inert tile the
 * old step 2 used for Yelp, because the wording beside it makes a promise
 * the tile never did: Reddit is on the roadmap and configuration will exist.
 * `aria-describedby` binds the explanation to the button, so the reason
 * arrives with the control for assistive technology rather than being loose
 * text nearby.
 */
export function RedditSourceCard() {
  const explanationId = useId();

  return (
    <OnboardingSourceCard
      glyph={<RedditGlyph />}
      title="Reddit"
      status="unavailable"
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled
            aria-describedby={explanationId}
            className="inline-flex min-h-[44px] w-full cursor-not-allowed items-center justify-center rounded-xl border border-site-border bg-site-tint px-4 py-2.5 text-[13.5px] font-semibold text-site-muted"
          >
            Configure after setup
          </button>
          <p id={explanationId} className="text-[12px] leading-relaxed text-site-muted">
            Reddit monitoring is part of Lia&rsquo;s broader monitoring roadmap,
            but this workspace does not have an operational Reddit connection
            yet.
          </p>
        </div>
      }
    >
      <p className="text-[13px] leading-relaxed text-site-body">
        Track relevant Reddit posts and conversations that may affect your
        reputation.
      </p>
    </OnboardingSourceCard>
  );
}

/** Reddit's mark, drawn rather than fetched — no external requests. */
function RedditGlyph() {
  return (
    <span
      className="flex size-12 shrink-0 items-center justify-center rounded-full bg-orange-100"
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="size-7" fill="#FF4500">
        <path d="M14.5 15.41c.08.09.08.22 0 .3-.61.61-1.56.9-2.5.9s-1.89-.29-2.5-.9a.21.21 0 0 1 0-.3c.08-.08.22-.08.3 0 .51.52 1.34.76 2.2.76.85 0 1.69-.24 2.2-.76.08-.08.22-.08.3 0Zm-4.34-2.32c0-.62-.5-1.12-1.11-1.12-.62 0-1.12.5-1.12 1.12s.5 1.11 1.12 1.11c.61 0 1.11-.5 1.11-1.11Zm4.79-1.12c-.61 0-1.11.5-1.11 1.12s.5 1.11 1.11 1.11c.62 0 1.12-.5 1.12-1.11s-.5-1.12-1.12-1.12ZM22 12c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2s10 4.48 10 10Zm-4.06-1.55c-.42 0-.79.17-1.06.44-1.05-.72-2.47-1.18-4.04-1.24l.81-2.56 2.2.52c.03.55.48.99 1.04.99.58 0 1.05-.47 1.05-1.05 0-.58-.47-1.05-1.05-1.05-.41 0-.77.24-.94.59l-2.45-.58a.26.26 0 0 0-.31.17l-.93 2.96c-1.62.03-3.08.5-4.15 1.24a1.53 1.53 0 0 0-1.05-.43c-.85 0-1.54.69-1.54 1.54 0 .6.34 1.11.84 1.37-.03.16-.04.32-.04.49 0 2.29 2.58 4.15 5.76 4.15s5.76-1.86 5.76-4.15c0-.16-.01-.32-.04-.48.51-.26.86-.78.86-1.38 0-.85-.69-1.54-1.54-1.54Z" />
      </svg>
    </span>
  );
}
