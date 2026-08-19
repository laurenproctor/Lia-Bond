"use client";

import { useState, useTransition } from "react";
import { ArrowDownRight, ArrowUpRight, Star, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { dismissYelpActivityAction } from "@/app/actions/yelp";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelativeShort } from "@/lib/format";
import type { YelpActivityChangeKind, YelpActivityOccurrence } from "@/domain";

/**
 * Detected changes on connected Yelp listings.
 *
 * Every sentence here is written against one specific misreading: that a
 * review-count change is a review. It is not, and it cannot be — Yelp's count
 * moves when reviews are added, removed, *or* reclassified by its
 * recommendation software, and Lia sees only the number.
 *
 * So the list states the two numbers and lets the change speak for itself
 * ("128 → 129"), the supporting line names all three possible causes, and no
 * copy anywhere says "new review". A person reads this and goes to look.
 */

const CHANGE_ICONS: Record<YelpActivityChangeKind, LucideIcon> = {
  count_increased: ArrowUpRight,
  count_decreased: ArrowDownRight,
  count_and_rating: ArrowUpRight,
  rating_only: Star,
};

/**
 * The headline for each kind of change.
 *
 * Deliberately describes the counter, not the reviews behind it. "Review count
 * increased" is a fact Lia observed; "a new review arrived" is an inference it
 * cannot support.
 */
const CHANGE_HEADLINES: Record<YelpActivityChangeKind, string> = {
  count_increased: "Review count increased",
  count_decreased: "Review count decreased",
  count_and_rating: "Review count and rating changed",
  rating_only: "Rating changed",
};

function formatCount(value: number | null): string {
  return value === null ? "not reported" : String(value);
}

function formatRating(value: number | null): string {
  return value === null ? "not reported" : value.toFixed(1);
}

export interface YelpActivityListProps {
  occurrences: YelpActivityOccurrence[];
  /** Location name by id, so a row can say which restaurant it is about. */
  locationNames: Record<string, string>;
  /** False for roles that may read the activity but not act on it. */
  canResolve: boolean;
  /** Opens the capture form for one occurrence. */
  onAddReview: (occurrence: YelpActivityOccurrence) => void;
}

export function YelpActivityList({
  occurrences,
  locationNames,
  canResolve,
  onAddReview,
}: YelpActivityListProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (occurrences.length === 0) {
    return (
      <EmptyState
        title="No review activity detected"
        description="Lia checks each connected listing's review count and rating on a schedule. When either changes, it appears here so you can go and look."
      />
    );
  }

  function dismiss(occurrenceId: string) {
    setError(null);
    startTransition(async () => {
      const result = await dismissYelpActivityAction({ occurrenceId });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="space-y-2">
      {occurrences.map((occurrence) => {
        const Icon = CHANGE_ICONS[occurrence.changeKind];
        const locationName = occurrence.locationId
          ? locationNames[occurrence.locationId]
          : null;

        return (
          <div
            key={occurrence.id}
            className="rounded-xl border border-gray-200 bg-white p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[13px] font-medium text-gray-950">
                  <Icon className="size-4 shrink-0 text-amber-600" aria-hidden />
                  {CHANGE_HEADLINES[occurrence.changeKind]}
                  {locationName ? (
                    <span className="font-normal text-gray-500">· {locationName}</span>
                  ) : null}
                </p>

                <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-gray-700">
                  <div className="flex gap-1.5">
                    <dt className="text-gray-500">Reviews</dt>
                    <dd>
                      {formatCount(occurrence.previousReviewCount)} →{" "}
                      <span className="font-medium text-gray-950">
                        {formatCount(occurrence.currentReviewCount)}
                      </span>
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-gray-500">Rating</dt>
                    <dd>
                      {formatRating(occurrence.previousRating)} →{" "}
                      <span className="font-medium text-gray-950">
                        {formatRating(occurrence.currentRating)}
                      </span>
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="text-gray-500">Detected</dt>
                    <dd>{formatRelativeShort(occurrence.detectedAt)}</dd>
                  </div>
                </dl>

                {/* The sentence that keeps the whole feature honest. Present on
                    every row rather than once at the top, because a row is what
                    gets screenshotted, quoted, and read in isolation. */}
                <p className="mt-1.5 text-[12px] text-gray-500">
                  A change can mean a review was added, removed, or reclassified by
                  Yelp. Lia cannot read the reviews themselves.
                </p>
              </div>

              {canResolve ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={pending}
                    onClick={() => onAddReview(occurrence)}
                  >
                    Add the Yelp review
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={X}
                    disabled={pending}
                    onClick={() => dismiss(occurrence.id)}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}

      {error ? (
        <p role="alert" className="text-[12.5px] font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
