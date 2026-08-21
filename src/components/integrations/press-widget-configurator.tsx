"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Check, Loader2, Moon, Save, Sun } from "lucide-react";
import { savePressWidgetAction } from "@/app/actions/press-widget";
import { PressWidgetPreview } from "@/components/integrations/press-widget-preview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { splitDomainInput } from "@/lib/widgets/domains";
import type { PressWidgetTheme } from "@/domain";
import type { PressWidgetEligibilityRule } from "@/lib/widgets/press/eligibility";

/**
 * The press widget configuration form.
 *
 * Holds the draft in local state and feeds it to the preview on every change,
 * so the customer sees the consequence of a decision before committing to it.
 * Nothing here is auto-saved: a widget is published on a public website, and
 * an autosave would put a half-finished thought on a restaurant's homepage
 * between two keystrokes.
 *
 * Ineligible articles are listed and marked rather than hidden, each carrying
 * the reason it cannot be shown. Hiding them produces the support question
 * this feature is most likely to generate — "why is this piece in my media
 * queue but not on my website" — with nowhere for the person to find the
 * answer.
 *
 * The list is read-only, unlike the review widget's. There is no pinning here,
 * so it is not a picker; it is the answer to "what will appear", in order,
 * with everything that will not and why.
 */

/** Why an article cannot be shown, in the customer's vocabulary rather than Lia's. */
const REFUSAL_LABELS: Record<PressWidgetEligibilityRule, string> = {
  organization: "Belongs to another organization",
  source: "Not a news article",
  query: "Found by a different news watch",
  query_enabled: "That news watch is switched off",
  headline: "No headline",
  source_url: "No usable link to the original story",
  published: "No publication date",
  not_dismissed: "Dismissed",
  not_escalated: "Escalated for review",
  present_at_source: "No longer published",
  not_syndicated: "A syndicated copy of another story",
  provider_returned: "Added by hand, so Lia cannot verify it",
};

export interface PressStoryView {
  id: string;
  headline: string | null;
  publisherName: string | null;
  publisherDomain: string | null;
  publishedAt: string;
  eligible: boolean;
  refusedBy: PressWidgetEligibilityRule | null;
}

export interface QueryOption {
  id: string;
  name: string;
  enabled: boolean;
  /** The location this watch is scoped to, or null for organization-wide. */
  locationName: string | null;
}

export interface PressWidgetConfiguratorProps {
  initial: {
    theme: PressWidgetTheme;
    monitoringQueryId: string | null;
    itemLimit: number;
    allowedDomains: string[];
  };
  queries: QueryOption[];
  stories: PressStoryView[];
  canManage: boolean;
}

const ITEM_LIMITS = [1, 2, 3];

export function PressWidgetConfigurator({
  initial,
  queries,
  stories,
  canManage,
}: PressWidgetConfiguratorProps) {
  const [pending, startTransition] = useTransition();
  const [theme, setTheme] = useState(initial.theme);
  const [monitoringQueryId, setMonitoringQueryId] = useState(initial.monitoringQueryId);
  const [itemLimit, setItemLimit] = useState(initial.itemLimit);
  const [domainText, setDomainText] = useState(initial.allowedDomains.join("\n"));

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);

  const previewSrc = useMemo(() => {
    const params = new URLSearchParams({
      theme,
      itemLimit: String(itemLimit),
    });
    if (monitoringQueryId) params.set("monitoringQueryId", monitoringQueryId);
    return `/embed/press-widget/preview?${params.toString()}`;
  }, [theme, monitoringQueryId, itemLimit]);

  function save() {
    setError(null);
    setSaved(false);
    setRejected([]);

    startTransition(async () => {
      const result = await savePressWidgetAction({
        theme,
        layout: "recent_press_list",
        monitoringQueryId,
        itemLimit,
        allowedDomains: splitDomainInput(domainText),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setSaved(true);
      setRejected(result.data.rejectedDomains);
      // Normalised server-side — "https://example.com/" comes back as
      // "example.com" — so the field is rewritten from the saved value rather
      // than left showing what was typed.
      setDomainText(result.data.widget.allowedDomains.join("\n"));
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Field label="Theme" hint="Pick the one that suits the page it sits on.">
          <div className="flex gap-2">
            {(["light", "dark"] as const).map((option) => {
              const Icon = option === "light" ? Sun : Moon;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!canManage}
                  onClick={() => setTheme(option)}
                  aria-pressed={theme === option}
                  className={cn(
                    "inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[13px] font-medium capitalize transition-colors disabled:opacity-45",
                    theme === option
                      ? "border-purple-600 bg-purple-50 text-purple-600"
                      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {option}
                </button>
              );
            })}
          </div>
        </Field>

        <Field
          label="How many stories"
          hint="Three is usually right. One is a single, strong piece of coverage."
        >
          <div className="flex gap-2" role="group" aria-label="How many stories">
            {ITEM_LIMITS.map((value) => (
              <button
                key={value}
                type="button"
                disabled={!canManage}
                onClick={() => setItemLimit(value)}
                aria-pressed={itemLimit === value}
                className={cn(
                  "inline-flex h-9 flex-1 items-center justify-center rounded-lg border text-[13px] font-medium tabular-nums transition-colors disabled:opacity-45",
                  itemLimit === value
                    ? "border-purple-600 bg-purple-50 text-purple-600"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
                )}
              >
                {value}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="Which coverage"
          hint="All of your press, or one news watch. A watch scoped to a location is how you show one restaurant's coverage."
        >
          <select
            value={monitoringQueryId ?? ""}
            disabled={!canManage}
            onChange={(event) => setMonitoringQueryId(event.target.value || null)}
            className="h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] text-gray-950 disabled:opacity-45"
          >
            <option value="">All press coverage</option>
            {queries.map((query) => (
              <option key={query.id} value={query.id} disabled={!query.enabled}>
                {query.name}
                {query.locationName ? ` — ${query.locationName}` : ""}
                {query.enabled ? "" : " (switched off)"}
              </option>
            ))}
          </select>
          {queries.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-gray-500">
              You have no news watches yet, so this widget will show all press
              coverage Lia finds.
            </p>
          ) : null}
        </Field>

        <Field
          label="Approved domains"
          hint="One per line. Leave empty to allow the widget anywhere."
        >
          <textarea
            value={domainText}
            disabled={!canManage}
            onChange={(event) => setDomainText(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={"example.com\n*.example.com"}
            className="w-full rounded-lg border border-gray-300 px-2 py-1.5 font-mono text-[12.5px] text-gray-950 disabled:opacity-45"
          />
          <p className="mt-1.5 text-[12px] text-gray-500">
            Browsers refuse to display the widget on any other site. This stops
            somebody framing your coverage on their page — it does not make the
            articles private, since they are already published.
          </p>
        </Field>

        {error ? <Notice tone="error">{error}</Notice> : null}
        {rejected.length > 0 ? (
          <Notice tone="warning">
            Saved, but these could not be used as domains: {rejected.join(", ")}.
          </Notice>
        ) : null}
        {saved && rejected.length === 0 && !error ? (
          <Notice tone="success">Saved. Live pages update within a minute.</Notice>
        ) : null}

        {canManage ? (
          <Button
            variant="primary"
            icon={pending ? Loader2 : Save}
            disabled={pending}
            onClick={save}
          >
            {pending ? "Saving…" : "Save widget"}
          </Button>
        ) : (
          <p className="text-[12.5px] text-gray-500">
            Your role can view this widget but not change it.
          </p>
        )}
      </div>

      <div className="space-y-5">
        <PressWidgetPreview src={previewSrc} theme={theme} />
        <StoryList stories={stories} itemLimit={itemLimit} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[13px] font-semibold text-gray-950">{label}</p>
      <p className="mt-0.5 mb-2 text-[12.5px] text-gray-500">{hint}</p>
      {children}
    </div>
  );
}

/**
 * What the widget will show, and what it will not.
 *
 * Read-only. There is nothing to click because selection is automatic, so this
 * is an explanation rather than a control — which is precisely why the
 * ineligible rows stay: an explanation that only listed the successes would
 * not answer the question somebody came here with.
 *
 * `showing` is computed against the *saved* order and the *current* item
 * limit, so moving the count from three to one immediately greys out the two
 * that will drop off. The preview above is the authority; this list is the
 * reasoning underneath it.
 */
function StoryList({
  stories,
  itemLimit,
}: {
  stories: PressStoryView[];
  itemLimit: number;
}) {
  if (stories.length === 0) {
    return (
      <div>
        <p className="mb-2 text-[13px] font-semibold text-gray-950">
          Coverage Lia has found
        </p>
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[12.5px] text-gray-500">
          No news articles have been found for this selection yet.
        </p>
      </div>
    );
  }

  // Derived before the map rather than counted inside it. The eligible
  // stories are already in the order the widget will draw them, so the ones
  // that make the cut are simply the first `itemLimit` of them — and computing
  // that up front keeps the render pure, which is what the JSX below has to be.
  const showingIds = new Set(
    stories
      .filter((story) => story.eligible)
      .slice(0, itemLimit)
      .map((story) => story.id),
  );

  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold text-gray-950">
        Coverage Lia has found
      </p>
      <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {stories.map((story) => {
          const showing = showingIds.has(story.id);

          return (
            <li
              key={story.id}
              className={cn(
                "rounded-lg border p-2.5",
                showing ? "border-purple-600 bg-purple-50" : "border-gray-200 bg-white",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="truncate text-[12.5px] font-medium text-gray-950">
                  {story.publisherName ?? story.publisherDomain ?? "Unnamed publication"}
                </span>
                <span className="ml-auto shrink-0 text-[11.5px] text-gray-500">
                  {formatDate(story.publishedAt)}
                </span>
              </span>
              <span className="mt-1 block line-clamp-2 text-[12.5px] text-gray-700">
                {story.headline ?? "No headline"}
              </span>
              {showing ? (
                <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-purple-100 px-1.5 py-0.5 text-[11.5px] font-medium text-purple-600">
                  Showing on your site
                </span>
              ) : null}
              {story.refusedBy ? (
                <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[11.5px] text-gray-950">
                  <AlertTriangle className="size-3 text-amber-600" aria-hidden />
                  {REFUSAL_LABELS[story.refusedBy]}
                </span>
              ) : null}
              {!story.refusedBy && !showing ? (
                <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11.5px] text-gray-500">
                  Next in line
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "error" | "warning" | "success";
  children: React.ReactNode;
}) {
  const classes = {
    error: "border-red-600/25 bg-red-100",
    warning: "border-amber-600/25 bg-amber-100",
    success: "border-green-600/25 bg-green-100",
  } as const;

  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] text-gray-950",
        classes[tone],
      )}
    >
      {tone === "success" ? (
        <Check className="mt-px size-4 shrink-0 text-green-600" aria-hidden />
      ) : (
        <AlertTriangle
          className={cn(
            "mt-px size-4 shrink-0",
            tone === "error" ? "text-red-600" : "text-amber-600",
          )}
          aria-hidden
        />
      )}
      {children}
    </p>
  );
}
