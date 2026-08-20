"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Check, Loader2, Moon, Save, Sun } from "lucide-react";
import { saveReviewWidgetAction } from "@/app/actions/review-widget";
import { ReviewWidgetPreview } from "@/components/integrations/review-widget-preview";
import { Button } from "@/components/ui/button";
import { RatingStars } from "@/components/ui/rating-stars";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { splitDomainInput } from "@/lib/widgets/domains";
import type { ReviewWidgetSelectionMode, ReviewWidgetTheme } from "@/domain";
import type { ReviewWidgetEligibilityRule } from "@/lib/widgets/eligibility";

/**
 * The widget configuration form.
 *
 * Holds the draft in local state and feeds it to the preview on every change,
 * so the customer sees the consequence of a decision before committing to it.
 * Nothing here is auto-saved: a widget is published on a public website, and
 * an autosave would put a half-finished thought on a restaurant's homepage
 * between two keystrokes.
 *
 * Ineligible reviews are listed and disabled rather than hidden, each carrying
 * the reason it cannot be shown. Hiding them produces the support question
 * this feature is most likely to generate — "why is this review in my inbox
 * but not in the widget list" — with nowhere for the person to find the
 * answer.
 */

/** Why a review cannot be shown, in the customer's vocabulary rather than Lia's. */
const REFUSAL_LABELS: Record<ReviewWidgetEligibilityRule, string> = {
  location: "Belongs to another location",
  source: "Not a Google review",
  text: "No written review, only a rating",
  rating: "No star rating",
  not_dismissed: "Dismissed",
  not_escalated: "Escalated for review",
  present_at_source: "No longer on Google",
  provider_returned: "Added by hand, so Lia cannot verify it",
  minimum_rating: "Below the minimum rating",
};

export interface ReviewChoiceView {
  id: string;
  rating: number | null;
  authorName: string | null;
  excerpt: string;
  publishedAt: string;
  eligible: boolean;
  refusedBy: ReviewWidgetEligibilityRule | null;
}

export interface ReviewWidgetConfiguratorProps {
  locationId: string;
  locationName: string;
  initial: {
    theme: ReviewWidgetTheme;
    selectionMode: ReviewWidgetSelectionMode;
    selectedMentionId: string | null;
    minimumRating: number;
    allowedDomains: string[];
  };
  choices: ReviewChoiceView[];
  canManage: boolean;
}

const RATING_OPTIONS = [5, 4.5, 4, 3.5, 3, 2, 1];

export function ReviewWidgetConfigurator({
  locationId,
  locationName,
  initial,
  choices,
  canManage,
}: ReviewWidgetConfiguratorProps) {
  const [pending, startTransition] = useTransition();
  const [theme, setTheme] = useState(initial.theme);
  const [selectionMode, setSelectionMode] = useState(initial.selectionMode);
  const [selectedMentionId, setSelectedMentionId] = useState(initial.selectedMentionId);
  const [minimumRating, setMinimumRating] = useState(initial.minimumRating);
  const [domainText, setDomainText] = useState(initial.allowedDomains.join("\n"));

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);

  const previewSrc = useMemo(() => {
    const params = new URLSearchParams({
      locationId,
      theme,
      selectionMode,
      minimumRating: String(minimumRating),
    });
    if (selectionMode === "specific" && selectedMentionId) {
      params.set("selectedMentionId", selectedMentionId);
    }
    return `/embed/review-widget/preview?${params.toString()}`;
  }, [locationId, theme, selectionMode, selectedMentionId, minimumRating]);

  const missingSelection = selectionMode === "specific" && selectedMentionId === null;

  function save() {
    setError(null);
    setSaved(false);
    setRejected([]);

    startTransition(async () => {
      const result = await saveReviewWidgetAction({
        locationId,
        theme,
        layout: "single_review_text",
        selectionMode,
        selectedMentionId: selectionMode === "specific" ? selectedMentionId : null,
        minimumRating,
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
          label="Which review"
          hint="Follow the feed, or pin one review you want to keep showing."
        >
          <div className="space-y-2">
            <Radio
              name="selection"
              checked={selectionMode === "most_recent"}
              disabled={!canManage}
              onChange={() => setSelectionMode("most_recent")}
              label="Most recent eligible review"
              description="Updates on its own as new reviews arrive."
            />
            <Radio
              name="selection"
              checked={selectionMode === "specific"}
              disabled={!canManage}
              onChange={() => setSelectionMode("specific")}
              label="Choose a specific review"
              description="Stays put until you change it."
            />
          </div>
        </Field>

        {selectionMode === "most_recent" ? (
          <Field
            label="Minimum rating"
            hint="Reviews below this are never picked automatically."
          >
            <select
              value={String(minimumRating)}
              disabled={!canManage}
              onChange={(event) => setMinimumRating(Number(event.target.value))}
              className="h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] text-gray-950 disabled:opacity-45"
            >
              {RATING_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value} stars and above
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field
            label={`Reviews at ${locationName}`}
            hint="Reviews that cannot be shown are listed with the reason."
          >
            <ChoiceList
              choices={choices}
              selectedId={selectedMentionId}
              disabled={!canManage}
              onSelect={setSelectedMentionId}
            />
          </Field>
        )}

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
            Browsers refuse to display the widget on any other site. This protects
            your reviews from being reused elsewhere — it does not make them
            private, since they are already public on Google.
          </p>
        </Field>

        {error ? <Notice tone="error">{error}</Notice> : null}
        {missingSelection && !error ? (
          <Notice tone="warning">Choose which review to show before saving.</Notice>
        ) : null}
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
            disabled={pending || missingSelection}
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

      <div>
        {missingSelection ? (
          // Not the preview, deliberately. Asked for a pinned review with none
          // chosen, the renderer honestly answers "the selected review is not
          // available" — which is right on a live website and wrong here,
          // where nothing has been selected yet and nothing is broken.
          <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6">
            <p className="max-w-64 text-center text-[13px] text-gray-500">
              Pick a review on the left and it will appear here, exactly as your
              website visitors will see it.
            </p>
          </div>
        ) : (
          <ReviewWidgetPreview src={previewSrc} theme={theme} />
        )}
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

function Radio({
  name,
  checked,
  disabled,
  onChange,
  label,
  description,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-2.5 rounded-lg border p-2.5 transition-colors",
        checked ? "border-purple-600 bg-purple-50" : "border-gray-300 hover:bg-gray-50",
        disabled && "cursor-default opacity-45",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 size-4 accent-purple-600"
      />
      <span>
        <span className="block text-[13px] font-medium text-gray-950">{label}</span>
        <span className="block text-[12.5px] text-gray-500">{description}</span>
      </span>
    </label>
  );
}

function ChoiceList({
  choices,
  selectedId,
  disabled,
  onSelect,
}: {
  choices: ReviewChoiceView[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  if (choices.length === 0) {
    return (
      <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[12.5px] text-gray-500">
        No Google reviews have been imported for this location yet.
      </p>
    );
  }

  return (
    <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
      {choices.map((choice) => {
        const selectable = choice.eligible && !disabled;
        return (
          <li key={choice.id}>
            <button
              type="button"
              disabled={!selectable}
              onClick={() => onSelect(choice.id)}
              aria-pressed={selectedId === choice.id}
              className={cn(
                "w-full rounded-lg border p-2.5 text-left transition-colors",
                selectedId === choice.id
                  ? "border-purple-600 bg-purple-50"
                  : "border-gray-200 bg-white",
                selectable ? "hover:bg-gray-50" : "cursor-default opacity-60",
              )}
            >
              <span className="flex items-center gap-2">
                {choice.rating === null ? (
                  <span className="text-[12px] text-gray-400">No rating</span>
                ) : (
                  <RatingStars rating={choice.rating} />
                )}
                <span className="truncate text-[12.5px] font-medium text-gray-950">
                  {choice.authorName ?? "A Google user"}
                </span>
                <span className="ml-auto shrink-0 text-[11.5px] text-gray-500">
                  {formatDate(choice.publishedAt)}
                </span>
              </span>
              <span className="mt-1 block line-clamp-2 text-[12.5px] text-gray-700">
                {choice.excerpt}
              </span>
              {choice.refusedBy ? (
                <span className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[11.5px] text-gray-950">
                  <AlertTriangle className="size-3 text-amber-600" aria-hidden />
                  {REFUSAL_LABELS[choice.refusedBy]}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
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
