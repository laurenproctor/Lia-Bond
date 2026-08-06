"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, Plug, RefreshCw, X } from "lucide-react";

/**
 * A short-lived prompt for a workspace that has just been set up.
 *
 * Three states, and every one of them is derived from real repository data by
 * the page that renders this — no "getting started" checklist, no progress
 * meter, and no second wizard. The overview is the product; this is one line
 * above it that disappears on its own.
 *
 * It is dismissible, and the dismissal is client-side and for this session
 * only. Persisting it would need a column, and the banner already removes
 * itself the moment the condition behind it stops being true — which is the
 * outcome a stored dismissal is trying to approximate.
 */

export type ActivationState = "no_source" | "importing" | "no_mentions";

const CONTENT: Record<
  ActivationState,
  { title: string; body: string; href: string; action: string; icon: typeof Plug }
> = {
  no_source: {
    title: "No source is connected yet",
    body: "Lia has nothing to monitor until a review platform is connected. Google Business Profile takes a couple of minutes.",
    href: "/integrations/google-business-profile",
    action: "Connect a source",
    icon: Plug,
  },
  importing: {
    title: "Your first import is running",
    body: "Reviews are being brought in now. The numbers below will fill in as it finishes — you can keep working.",
    href: "/integrations/google-business-profile",
    action: "Watch the import",
    icon: Loader2,
  },
  no_mentions: {
    title: "Nothing has been imported yet",
    body: "Your locations are connected but no reviews have arrived. Start an import to bring in what is already published.",
    href: "/integrations/google-business-profile",
    action: "Start an import",
    icon: RefreshCw,
  },
};

export function ActivationBanner({ state }: { state: ActivationState }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const content = CONTENT[state];
  const Icon = content.icon;

  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-card border border-blue-600/30 bg-blue-100 px-4 py-3"
    >
      <Icon
        className={`mt-0.5 size-[18px] shrink-0 text-blue-600 ${
          state === "importing" ? "animate-spin" : ""
        }`}
        strokeWidth={2}
        aria-hidden
      />

      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold text-navy-950">{content.title}</p>
        <p className="mt-0.5 text-[13px] text-gray-700">{content.body}</p>
      </div>

      <div className="flex items-center gap-2">
        <Link
          href={content.href}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-[13px] font-medium text-navy-950 transition-colors hover:bg-gray-50"
        >
          {content.action}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss this message"
          className="inline-flex size-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white hover:text-gray-950"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
