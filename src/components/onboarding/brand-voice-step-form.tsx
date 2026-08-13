"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, Plus, Star, X } from "lucide-react";
import { updateBrandVoiceAction } from "@/app/actions/brand-voice";
import { completeOnboardingBrandVoiceAction } from "@/app/actions/onboarding";
import { SaveStatus } from "@/components/autosave/save-status";
import { useAutosave } from "@/components/autosave/use-autosave";
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
  isCoveredByPhrases,
  MAX_PHRASE_LENGTH,
  MAX_PHRASES,
  SUGGESTED_APPROVED_PHRASES,
  SUGGESTED_PROHIBITED_PHRASES,
  type BrandVoiceAxisKey,
  type BrandVoiceProfile,
  type UpdateBrandVoiceInput,
} from "@/domain";
import { summarizeBrandVoice } from "@/lib/brand-voice/summary";
import {
  buildVoicePreview,
  PREVIEW_REVIEW,
  prohibitedPhraseMatchesInPreview,
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
 *
 * Edits save themselves through the same `useAutosave` primitive and the same
 * `updateBrandVoiceAction` the `/brand-voice` screen uses — a slider on release,
 * a phrase immediately, then an idle window so a burst of edits is one request.
 * That is only ever the **voice**: autosave never advances the wizard, because
 * settling step 4 is the person pressing the button, not them touching a slider.
 * The button still writes both, so a step reached without any autosave landing
 * behaves exactly as it did before.
 */

/**
 * States the matching rule where the phrases are typed.
 *
 * A list that matches around extra words is not something anybody guesses from
 * an empty text box, and the difference decides what they type: somebody who
 * assumes exact matching writes out every variation by hand.
 */
const PHRASE_LIMIT_HINT = `Extra words are allowed inside a phrase — “made our day” also covers “really made our day”. Up to ${MAX_PHRASES} phrases, ${MAX_PHRASE_LENGTH} characters each.`;

export function BrandVoiceStepForm({ initial }: { initial: UpdateBrandVoiceInput }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [value, setValue] = useState<UpdateBrandVoiceInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const preview = useMemo(() => buildVoicePreview(value), [value]);
  const summary = useMemo(() => summarizeBrandVoice(value.axes), [value.axes]);
  const conflicts = useMemo(
    () => prohibitedPhraseMatchesInPreview(preview, value.prohibitedPhrases),
    [preview, value.prohibitedPhrases],
  );
  const conflictSummary = useMemo(
    () =>
      conflicts
        .map((match) =>
          match.matchedText.toLowerCase() === match.phrase.toLowerCase()
            ? `“${match.matchedText}”`
            : `“${match.matchedText}” (matching “${match.phrase}”)`,
        )
        .join(", "),
    [conflicts],
  );

  // The saved profile is deliberately ignored rather than re-seeded into the
  // form. The form already applies the schema's own trim and case-insensitive
  // dedupe rules as phrases are added, so there is nothing to reconcile — and
  // re-seeding would overwrite an adjustment made while the request was in
  // flight.
  const handleSaved = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  const handleFailed = useCallback(
    (message: string, fields: Record<string, string>) => {
      setError(message);
      setFieldErrors(fields);
    },
    [],
  );

  const { status, commit, flush } = useAutosave<UpdateBrandVoiceInput, BrandVoiceProfile>(
    value,
    {
      save: updateBrandVoiceAction,
      onSaved: handleSaved,
      onFailed: handleFailed,
      // Every role the wizard admits may write the voice, so there is no
      // read-only case to turn this off for.
      enabled: true,
    },
  );

  function setAxis(key: BrandVoiceAxisKey, next: number) {
    setValue((current) => ({
      ...current,
      axes: { ...current.axes, [key]: next },
    }));
  }

  /** Change the value and treat the edit as complete. */
  function edit(update: (current: UpdateBrandVoiceInput) => UpdateBrandVoiceInput) {
    setValue(update);
    commit();
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      // Settle autosave before writing the same profile again. `flush` resolves
      // only once nothing is in flight, so the two cannot interleave on a save
      // that reads the current version and writes the next one.
      //
      // Its outcome is deliberately not a gate: the action below saves the voice
      // itself, so a flush that failed on a dropped connection is retried by
      // this submission rather than costing a second press.
      await flush();

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
          description="Choose the tone and phrases that help Lia sound like you. Your changes save as you make them."
        />

        {/* Whether what is on screen is on the server. Sits above the controls
            rather than beside the button, because the saving it reports is not
            the button's. */}
        <SaveStatus status={status} className="-mt-4" />

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
                  // Three, because each covers a gap the others leave.
                  // `pointerup` ends a drag; `keyup` ends an arrow-key
                  // adjustment; `blur` catches a keyboard user who tabs away,
                  // which fires no `keyup` on this control. The preview follows
                  // every frame of the drag; only the release starts a save.
                  onPointerUp={commit}
                  onKeyUp={commit}
                  onBlur={commit}
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
          legend="Use these types of phrases"
          description="The types of phrases Lia would be likely to include in responses."
          tone="approved"
          phrases={value.approvedPhrases}
          counterpartPhrases={value.prohibitedPhrases}
          suggestions={SUGGESTED_APPROVED_PHRASES}
          error={fieldErrors.approvedPhrases}
          onChange={(next) => edit((current) => ({ ...current, approvedPhrases: next }))}
        />

        <PhraseField
          id="prohibited"
          legend="Avoid these phrases"
          description="Phrases Lia will never write."
          tone="prohibited"
          phrases={value.prohibitedPhrases}
          counterpartPhrases={value.approvedPhrases}
          suggestions={SUGGESTED_PROHIBITED_PHRASES}
          error={fieldErrors.prohibitedPhrases}
          onChange={(next) =>
            edit((current) => ({ ...current, prohibitedPhrases: next }))
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
              {/* Names the words the example actually used, and the phrase they
                  matched when the two differ. A phrase list that matches around
                  extra words has to show its working, or a warning about
                  wording nobody typed looks like a mistake. */}
              This example says {conflictSummary}, which you asked Lia to avoid.
              Real replies will not — the example sentences are fixed.
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

        {/* A failure keeps the edits on screen, and says so: this screen's whole
            purpose is accumulating small adjustments, and losing them to a
            failed request is not acceptable. Pressing the button below sends
            them again. */}
        {error ? (
          <OnboardingError>{error} Your changes are still here.</OnboardingError>
        ) : null}

        <OnboardingActions
          primary={
            <PrimaryAction pending={pending} pendingLabel="Saving…">
              Save and continue
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
 *
 * `suggestions` are offered as buttons and are never applied on their own — see
 * `SUGGESTED_APPROVED_PHRASES`. One disappears once it is on the list, once an
 * existing phrase already covers it, or once it appears on `counterpartPhrases`,
 * where pressing it would only produce the use/avoid contradiction error.
 */
function PhraseField({
  id,
  legend,
  description,
  tone,
  phrases,
  counterpartPhrases = [],
  suggestions = [],
  error,
  onChange,
}: {
  id: string;
  legend: string;
  description: string;
  tone: "approved" | "prohibited";
  phrases: string[];
  counterpartPhrases?: readonly string[];
  suggestions?: readonly string[];
  error?: string;
  onChange: (phrases: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const full = phrases.length >= MAX_PHRASES;

  function addPhrase(raw: string) {
    const phrase = raw.trim();
    if (!phrase || full) return;
    // Case-insensitive, matching the schema's own dedupe rule. Doing it here
    // too means somebody does not add a chip and watch it vanish on save.
    if (phrases.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) {
      return;
    }
    onChange([...phrases, phrase]);
  }

  function add() {
    addPhrase(draft);
    setDraft("");
  }

  const available = full
    ? []
    : suggestions.filter(
        (suggestion) =>
          !isCoveredByPhrases(suggestion, phrases) &&
          !isCoveredByPhrases(suggestion, counterpartPhrases),
      );

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

      {available.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p id={`${id}-suggestions`} className="text-[12px] font-semibold text-site-body">
            {tone === "approved" ? "Suggestions to use" : "Suggestions to avoid"}
          </p>
          <ul aria-labelledby={`${id}-suggestions`} className="flex flex-wrap gap-2">
            {available.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  onClick={() => addPhrase(suggestion)}
                  // The visible phrase is inside the accessible name rather
                  // than replaced by it, so speech input can act on what is on
                  // screen (WCAG 2.5.3).
                  aria-label={`Add suggested phrase: ${suggestion}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-site-field bg-white px-2.5 py-1.5 text-[13px] text-site-body transition-colors hover:border-site-blue hover:bg-site-blue-tint hover:text-site-blue-ink"
                >
                  <Plus className="size-3.5 shrink-0" aria-hidden />
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
