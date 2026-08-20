"use client";

import { useMemo } from "react";
import { Star } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import {
  buildVoicePreview,
  describePreviewConflicts,
  PREVIEW_REVIEW,
  prohibitedPhraseMatchesInPreview,
} from "@/lib/brand-voice/preview";
import { cn } from "@/lib/cn";
import type { UpdateBrandVoiceInput } from "@/domain";

/**
 * The voice, illustrated.
 *
 * Replaces the `SectionPlaceholder` that used to sit here saying "available
 * once response drafting arrives". Drafting has since shipped
 * (`src/lib/responses/generate.ts`), so that sentence had become false — but the
 * fix is not to call the model. This renders `buildVoicePreview`, the same
 * deterministic illustration onboarding step 4 has always shown, so the two
 * screens now agree and neither needs a provider configured to be useful.
 *
 * A client component because it has to follow the form's live state: the point
 * of a preview on a screen full of sliders is that it moves while you drag one.
 * That is also why it is rendered by `VoiceForm` rather than passed in from the
 * server page, which is what the placeholder was.
 *
 * Every claim on screen is bounded. The heading itself says illustration — not
 * fine print underneath — because the claim it must never make is that this
 * reply exists or was sent to anybody.
 */
export function VoicePreview({ value }: { value: UpdateBrandVoiceInput }) {
  const preview = useMemo(() => buildVoicePreview(value), [value]);
  const conflicts = useMemo(
    () => prohibitedPhraseMatchesInPreview(preview, value.prohibitedPhrases),
    [preview, value.prohibitedPhrases],
  );

  return (
    <Card>
      <CardHeader
        title="5. Preview — an illustration, not a published reply"
        description="Built from the settings on this page. The review is a made-up example, and nothing here has been sent to anyone."
      />

      <div className="mt-4 flex flex-col gap-3">
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-[12px] font-medium tracking-wide text-gray-500 uppercase">
            Example review
          </p>
          <p
            className="mt-1.5 flex items-center gap-0.5"
            aria-label={`${PREVIEW_REVIEW.rating} out of 5 stars`}
          >
            {Array.from({ length: 5 }, (_, index) => (
              <Star
                key={index}
                className={cn(
                  "size-4",
                  index < PREVIEW_REVIEW.rating
                    ? "fill-amber-600 text-amber-600"
                    : "text-gray-300",
                )}
                aria-hidden
              />
            ))}
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-gray-700">
            “{PREVIEW_REVIEW.text}”
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="text-[12px] font-medium tracking-wide text-gray-500 uppercase">
            Lia&rsquo;s reply, in your voice
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-gray-950">{preview}</p>
        </div>

        {conflicts.length > 0 ? (
          <p
            role="alert"
            className="rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2 text-[12.5px] text-gray-950"
          >
            {/*
              Same sentence the wizard shows, from the same builder. A customer
              who met this warning during setup and then met different wording
              for the same condition here would reasonably read it as a
              different problem.
            */}
            This example says {describePreviewConflicts(conflicts)}, which you asked
            Lia to avoid. Real replies will not — the example sentences are fixed.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
