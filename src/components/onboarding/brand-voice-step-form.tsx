"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Plus, Star, X } from "lucide-react";
import { completeOnboardingBrandVoiceAction } from "@/app/actions/onboarding";
import {
  OnboardingActions,
  OnboardingError,
  PrimaryAction,
  SecondaryLink,
} from "@/components/onboarding/onboarding-actions";
import {
  OnboardingCard,
  OnboardingNote,
  OnboardingStepHeader,
} from "@/components/onboarding/onboarding-card";
import {
  BRAND_VOICE_AXES,
  MAX_PHRASE_LENGTH,
  MAX_PHRASES,
  type BrandVoiceAxisKey,
  type UpdateBrandVoiceInput,
} from "@/domain";
import { summarizeBrandVoice } from "@/lib/brand-voice/summary";
import {
  buildVoicePreview,
  PREVIEW_REVIEW,
  prohibitedPhrasesInPreview,
} from "@/lib/onboarding/preview";
import { cn } from "@/lib/cn";

/**
 * Step 4's form.
 *
 * The five axes are the **existing** `BRAND_VOICE_AXES` taxonomy, read from the
 * domain rather than restated here — warmth, detail, formality, confidence, and
 * hospitality. Adding a sixth axis is a change in one place and this screen
 * picks it up.
 *
 * The preview is computed synchronously from the form's own state. No model is
 * called, for the reasons on `buildVoicePreview`, and the screen labels it as an
 * illustration rather than implying anything has been published.
 */

const PHRASE_LIMIT_HINT = `Up to ${MAX_PHRASES} phrases, ${MAX_PHRASE_LENGTH} characters each.`;

export function BrandVoiceStepForm({ initial }: { initial: UpdateBrandVoiceInput }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [value, setValue] = useState<UpdateBrandVoiceInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const preview = useMemo(() => buildVoicePreview(value), [value]);
  const summary = useMemo(() => summarizeBrandVoice(value.axes), [value.axes]);
  const conflicts = useMemo(
    () => prohibitedPhrasesInPreview(preview, value.prohibitedPhrases),
    [preview, value.prohibitedPhrases],
  );

  function setAxis(key: BrandVoiceAxisKey, next: number) {
    setValue((current) => ({
      ...current,
      axes: { ...current.axes, [key]: next },
    }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await completeOnboardingBrandVoiceAction(value);

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      router.push(result.data.nextPath);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <OnboardingCard className="flex flex-col gap-6">
        <OnboardingStepHeader
          icon={Megaphone}
          title="Brand voice"
          description="Choose the tone and phrases that help Lia sound like you."
        />

        <fieldset className="flex flex-col gap-3">
          <legend className="text-[14px] font-bold text-site-ink">
            How should Lia sound?
          </legend>
          <ul className="flex flex-col gap-2.5">
            {BRAND_VOICE_AXES.map((axis) => (
              <li
                key={axis.key}
                className="grid grid-cols-[minmax(5rem,auto)_1fr_minmax(5rem,auto)] items-center gap-3 rounded-xl border border-site-border px-3 py-2.5"
              >
                <label
                  htmlFor={`voice-${axis.key}`}
                  className="text-[13px] font-semibold text-site-ink"
                >
                  {axis.leftLabel}
                </label>
                {/* A real range input, so keyboard operation, focus, and
                    screen-reader announcement come from the platform rather
                    than from a reimplementation of them. */}
                <input
                  id={`voice-${axis.key}`}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={value.axes[axis.key]}
                  aria-label={`${axis.leftLabel} to ${axis.rightLabel}`}
                  // Read as "62 of 100, warm to formal" rather than "62", which
                  // on its own means nothing.
                  aria-valuetext={`${value.axes[axis.key]} of 100, ${axis.leftLabel} to ${axis.rightLabel}`}
                  onChange={(event) => setAxis(axis.key, Number(event.target.value))}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-site-border accent-[color:var(--color-site-blue)]"
                />
                <span className="text-right text-[13px] text-site-body">
                  {axis.rightLabel}
                </span>
              </li>
            ))}
          </ul>
        </fieldset>

        <PhraseField
          id="approved"
          legend="Use these phrases"
          description="Phrases Lia may include in responses."
          tone="approved"
          phrases={value.approvedPhrases}
          error={fieldErrors.approvedPhrases}
          onChange={(next) =>
            setValue((current) => ({ ...current, approvedPhrases: next }))
          }
        />

        <PhraseField
          id="prohibited"
          legend="Avoid these phrases"
          description="Phrases Lia will never write."
          tone="prohibited"
          phrases={value.prohibitedPhrases}
          error={fieldErrors.prohibitedPhrases}
          onChange={(next) =>
            setValue((current) => ({ ...current, prohibitedPhrases: next }))
          }
        />

        {/* The preview. Labelled as an illustration in the heading itself, not
            in fine print, because the claim it must not make is that this reply
            exists or has been sent. */}
        <section
          aria-labelledby="voice-preview-heading"
          className="rounded-2xl border border-site-border bg-site-tint p-4"
        >
          <h3
            id="voice-preview-heading"
            className="text-[14px] font-bold text-site-ink"
          >
            Preview — an illustration, not a published reply
          </h3>
          <p className="mt-1 text-[12.5px] text-site-body">
            Built from your settings on this page. The review below is a made-up
            example, and nothing here has been sent to anyone.
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-site-border bg-white p-3.5">
              <p className="text-[12px] font-bold text-site-muted uppercase">
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
                        ? "fill-site-orange text-site-orange"
                        : "text-site-border",
                    )}
                    aria-hidden
                  />
                ))}
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-site-body">
                “{PREVIEW_REVIEW.text}”
              </p>
            </div>

            <div className="rounded-xl border border-site-border bg-white p-3.5">
              <p className="text-[12px] font-bold text-site-muted uppercase">
                Lia&rsquo;s reply, in your voice
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-site-ink">
                {preview}
              </p>
            </div>
          </div>

          {conflicts.length > 0 ? (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-site-amber-edge/40 bg-site-amber-tint px-3 py-2 text-[12.5px] text-site-amber-ink"
            >
              This example uses {conflicts.join(", ")}, which you asked Lia to
              avoid. Real replies will not — the example sentences are fixed.
            </p>
          ) : null}

          <div className="mt-4">
            <p className="text-[12px] font-bold text-site-muted uppercase">
              In plain language
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {summary.map((line) => (
                <li key={line} className="text-[12.5px] text-site-body">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <OnboardingNote title="You can change these settings anytime">
          Brand voice lives in your workspace under Brand voice, and every change is
          recorded.
        </OnboardingNote>

        {error ? <OnboardingError>{error}</OnboardingError> : null}

        <OnboardingActions
          primary={
            <PrimaryAction pending={pending} pendingLabel="Saving…">
              Save voice
            </PrimaryAction>
          }
          secondary={<SecondaryLink href="/onboarding/locations">Back</SecondaryLink>}
          note="Your data is secure and never shared"
        />
      </OnboardingCard>
    </form>
  );
}

/**
 * An editable list of phrase chips.
 *
 * The remove control on each chip is a real button with an accessible name
 * naming the phrase it removes, so a screen-reader user hears "Remove thank you
 * for your feedback" rather than five identical "Remove" buttons.
 */
function PhraseField({
  id,
  legend,
  description,
  tone,
  phrases,
  error,
  onChange,
}: {
  id: string;
  legend: string;
  description: string;
  tone: "approved" | "prohibited";
  phrases: string[];
  error?: string;
  onChange: (phrases: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const full = phrases.length >= MAX_PHRASES;

  function add() {
    const phrase = draft.trim();
    if (!phrase || full) return;
    // Case-insensitive, matching the schema's own dedupe rule. Doing it here
    // too means somebody does not add a chip and watch it vanish on save.
    if (phrases.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...phrases, phrase]);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-[14px] font-bold text-site-ink">{legend}</p>
        <p className="text-[12.5px] text-site-body">{description}</p>
      </div>

      <ul className="flex flex-wrap gap-2">
        {phrases.map((phrase) => (
          <li
            key={phrase}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px]",
              tone === "approved"
                ? "border-site-blue-edge bg-site-blue-tint text-site-blue-ink"
                : "border-site-amber-edge/40 bg-site-amber-tint text-site-amber-ink",
            )}
          >
            {phrase}
            <button
              type="button"
              onClick={() => onChange(phrases.filter((value) => value !== phrase))}
              aria-label={`Remove ${phrase}`}
              className="rounded-sm p-0.5 transition-opacity hover:opacity-60"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
        {phrases.length === 0 ? (
          <li className="text-[13px] text-site-muted">None yet.</li>
        ) : null}
      </ul>

      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-phrase`} className="sr-only">
          {legend}
        </label>
        <input
          id={`${id}-phrase`}
          type="text"
          value={draft}
          maxLength={MAX_PHRASE_LENGTH}
          disabled={full}
          placeholder={full ? `Limit of ${MAX_PHRASES} reached` : "Add a phrase"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the phrase rather than submitting the form. A submit
            // here would save the whole step from a half-typed chip.
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-site-field bg-white px-3 text-[14px] text-site-ink placeholder:text-site-muted focus:border-site-blue focus:outline-none disabled:bg-site-tint"
        />
        <button
          type="button"
          onClick={add}
          disabled={full || draft.trim().length === 0}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-site-blue-edge bg-white px-4 text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden />
          Add
        </button>
      </div>

      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12.5px] font-medium text-red-600">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="text-[12px] text-site-muted">
          {PHRASE_LIMIT_HINT}
        </p>
      )}
    </div>
  );
}
