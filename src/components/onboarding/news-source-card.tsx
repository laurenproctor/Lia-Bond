"use client";

import type { Ref } from "react";
import { Globe } from "lucide-react";
import { OnboardingSourceCard } from "@/components/onboarding/onboarding-source-card";

/**
 * The News & Media source card.
 *
 * Every value on it is derived from persisted monitoring queries and poll
 * runs — the counts arrive from the server view model, which read the real
 * tables. When nothing is configured the card says "Not configured" rather
 * than showing sample names, and the badge says "Configured" rather than
 * "Active": configured is what a saved row proves, and active would claim a
 * poll outcome this card has not verified.
 *
 * The configure button controls the expanded section rendered beneath the
 * card grid (`news-monitoring-configurator.tsx`), announced through
 * `aria-expanded` / `aria-controls`.
 */

export interface NewsCardSummary {
  capability: "available" | "unavailable";
  configured: boolean;
  /**
   * Configured *and* the monitor and `news_media` connection actually exist,
   * so polling can run. Stricter than `configured`; the badge says
   * "Configured" either way because that is all a saved row proves.
   */
  operational: boolean;
  enabledQueryCount: number;
  keywordCount: number;
  language: string | null;
  country: string | null;
  lastSuccessfulPollAt: string | null;
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
};

const COUNTRY_LABELS: Record<string, string> = {
  us: "United States",
  gb: "United Kingdom",
  ca: "Canada",
  au: "Australia",
  ie: "Ireland",
  de: "Germany",
  fr: "France",
  es: "Spain",
};

export function NewsSourceCard({
  summary,
  expanded,
  onToggle,
  buttonRef,
}: {
  summary: NewsCardSummary;
  expanded: boolean;
  onToggle: () => void;
  /** Owned by the parent, so focus can return here when the section closes. */
  buttonRef: Ref<HTMLButtonElement>;
}) {
  return (
    <OnboardingSourceCard
      glyph={
        <span
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-site-blue-tint"
          aria-hidden
        >
          <Globe className="size-6 text-site-blue" strokeWidth={1.7} />
        </span>
      }
      title="News & Media"
      status={summary.configured ? "configured" : "optional"}
      footer={
        summary.capability === "available" ? (
          <button
            ref={buttonRef}
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls="news-monitoring-configurator"
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl border border-site-blue-edge bg-white px-4 py-2.5 text-[13.5px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
          >
            {expanded
              ? "Hide monitoring settings"
              : summary.configured
                ? "Edit monitoring"
                : "Configure monitoring"}
          </button>
        ) : (
          // Not configured on this deployment. Honest, and actionable only by
          // an operator — same treatment the Google card gives its missing
          // connector.
          <p className="rounded-xl border border-site-border bg-site-tint px-3 py-2 text-[12.5px] leading-relaxed text-site-body">
            News monitoring is not configured on this server yet. Ask your
            administrator to finish setup, then configure it from the News
            &amp; Media screen.
          </p>
        )
      }
    >
      <p className="text-[13px] leading-relaxed text-site-body">
        Monitor articles and media coverage mentioning your organization,
        locations, and important people.
      </p>

      {summary.configured ? (
        <dl className="flex flex-col gap-1 rounded-xl bg-site-tint/60 p-3 text-[12.5px] leading-snug">
          <SummaryRow
            label="Monitoring"
            value={`${summary.enabledQueryCount} ${summary.enabledQueryCount === 1 ? "query" : "queries"}, ${summary.keywordCount} ${summary.keywordCount === 1 ? "keyword" : "keywords"}`}
          />
          {summary.country ? (
            <SummaryRow
              label="Market"
              value={COUNTRY_LABELS[summary.country] ?? summary.country.toUpperCase()}
            />
          ) : null}
          {summary.language ? (
            <SummaryRow
              label="Language"
              value={LANGUAGE_LABELS[summary.language] ?? summary.language}
            />
          ) : null}
          <SummaryRow
            label="Last checked"
            value={
              summary.lastSuccessfulPollAt
                ? formatCheckedAt(summary.lastSuccessfulPollAt)
                : "Not checked yet"
            }
          />
        </dl>
      ) : (
        <p className="text-[12.5px] font-semibold text-site-muted">Not configured</p>
      )}
    </OnboardingSourceCard>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 font-semibold text-site-muted">{label}</dt>
      <dd className="min-w-0 text-right text-site-ink">{value}</dd>
    </div>
  );
}

/** A real timestamp, formatted plainly. Never rendered when there is none. */
function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
