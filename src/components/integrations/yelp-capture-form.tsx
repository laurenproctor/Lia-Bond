"use client";

import { useId, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { captureYelpReviewAction } from "@/app/actions/yelp";
import { Button } from "@/components/ui/button";
import type { YelpActivityOccurrence } from "@/domain";

/**
 * Adding a Yelp review to Lia by hand.
 *
 * The form is short on purpose. Every field beyond the rating and the text is
 * optional, because the person filling this in is copying from another tab and
 * each required field is another reason to give up halfway — and a review that
 * never gets added is a customer who never gets answered.
 *
 * Two things the copy has to carry, and they pull against each other:
 *
 * - This is the *customer's* transcription. Lia cannot verify a word of it, and
 *   the form says so rather than implying an import.
 * - It is nonetheless about to drive classification, risk assessment, possibly
 *   an escalation, and a public reply. So it asks for the review as written
 *   rather than a summary, and says why.
 */

export interface YelpCaptureFormProps {
  platformProfileId: string;
  /** The detected change this is answering, when there is one. */
  occurrence?: YelpActivityOccurrence | null;
  onCaptured?: () => void;
  onCancel?: () => void;
}

export function YelpCaptureForm({
  platformProfileId,
  occurrence,
  onCaptured,
  onCancel,
}: YelpCaptureFormProps) {
  const fieldId = useId();
  const [pending, startTransition] = useTransition();

  const [rating, setRating] = useState(3);
  const [content, setContent] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [reviewUrl, setReviewUrl] = useState("");
  const [reviewedOn, setReviewedOn] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ basis: string } | null>(null);

  function submit(confirmDistinct: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await captureYelpReviewAction({
        platformProfileId,
        sourceType: "yelp_review",
        rating,
        content: content.trim(),
        authorName: authorName.trim() || undefined,
        reviewUrl: reviewUrl.trim() || undefined,
        reviewedOn: reviewedOn || undefined,
        activityOccurrenceId: occurrence?.id,
        confirmDistinct,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // A duplicate is an outcome, not a failure: Lia already holds a review
      // that matches. The person is shown what matched and offered the
      // override, rather than being blocked or silently merged into a row that
      // may be a different review.
      if (result.data.outcome === "duplicate") {
        setDuplicate({ basis: result.data.duplicateBasis ?? "fingerprint" });
        return;
      }

      setDuplicate(null);
      onCaptured?.();
    });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <p className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] text-gray-700">
        Copy the review from Yelp as it is written. Lia cannot read your Yelp
        reviews, so this is the only way it sees one — and it will be classified,
        routed, and answered on the strength of what you paste here.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label
          htmlFor={`${fieldId}-rating`}
          className="text-[12.5px] font-medium text-gray-950"
        >
          Star rating
          <select
            id={`${fieldId}-rating`}
            value={rating}
            onChange={(event) => setRating(Number(event.target.value))}
            className="mt-1 h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] font-normal text-gray-950"
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value} {value === 1 ? "star" : "stars"}
              </option>
            ))}
          </select>
        </label>

        <label
          htmlFor={`${fieldId}-date`}
          className="text-[12.5px] font-medium text-gray-950"
        >
          Review date <span className="font-normal text-gray-500">(optional)</span>
          <input
            id={`${fieldId}-date`}
            type="date"
            value={reviewedOn}
            onChange={(event) => setReviewedOn(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] font-normal text-gray-950"
          />
        </label>
      </div>

      <label
        htmlFor={`${fieldId}-content`}
        className="block text-[12.5px] font-medium text-gray-950"
      >
        Review text
        <textarea
          id={`${fieldId}-content`}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={5}
          required
          maxLength={5000}
          placeholder="Paste the review exactly as it appears on Yelp."
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] font-normal text-gray-950 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label
          htmlFor={`${fieldId}-author`}
          className="text-[12.5px] font-medium text-gray-950"
        >
          Reviewer name <span className="font-normal text-gray-500">(optional)</span>
          <input
            id={`${fieldId}-author`}
            value={authorName}
            onChange={(event) => setAuthorName(event.target.value)}
            maxLength={200}
            className="mt-1 h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] font-normal text-gray-950"
          />
        </label>

        <label
          htmlFor={`${fieldId}-url`}
          className="text-[12.5px] font-medium text-gray-950"
        >
          Link to the review{" "}
          <span className="font-normal text-gray-500">(optional)</span>
          <input
            id={`${fieldId}-url`}
            value={reviewUrl}
            onChange={(event) => setReviewUrl(event.target.value)}
            placeholder="https://www.yelp.com/biz/…"
            maxLength={2048}
            className="mt-1 h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] font-normal text-gray-950"
          />
        </label>
      </div>

      <p className="text-[12px] text-gray-500">
        A link helps Lia recognise the same review if it is added twice, and gives
        the response screen somewhere to send you when you post the reply.
      </p>

      {duplicate ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-[12.5px] font-medium text-amber-900">
            Lia already has a review that matches this one
            {duplicate.basis === "review_url"
              ? " — same Yelp link."
              : " — same rating, text, reviewer, and date."}
          </p>
          <p className="mt-1 text-[12px] text-amber-900">
            If these really are two different reviews, add it anyway. Nothing has
            been changed on the review Lia already holds.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            disabled={pending}
            onClick={() => submit(true)}
          >
            Add it anyway
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          icon={pending ? Loader2 : undefined}
          disabled={pending || content.trim().length === 0}
        >
          Add review
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
