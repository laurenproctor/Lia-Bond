"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Loader2, Save } from "lucide-react";
import { updateBrandVoiceAction } from "@/app/actions/brand-voice";
import { AxisSlider } from "@/components/brand-voice/axis-slider";
import { PhraseEditor } from "@/components/brand-voice/phrase-editor";
import { VoiceSummary } from "@/components/brand-voice/voice-summary";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { BRAND_VOICE_AXES, type UpdateBrandVoiceInput } from "@/domain";

export interface VoiceFormProps {
  initial: UpdateBrandVoiceInput;
  /** True when the caller's role cannot change the voice. */
  readOnly: boolean;
  /** Server-rendered cards that sit inside the form's layout. */
  channels: ReactNode;
  preview: ReactNode;
}

function isDirty(a: UpdateBrandVoiceInput, b: UpdateBrandVoiceInput): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * The editable brand voice.
 *
 * Save lives in a sticky bar inside the form rather than in the page header,
 * because the header cannot observe this component's dirty state without
 * lifting it out of the one place that uses it. A configuration screen that
 * cannot say "you have unsaved changes" is the more common failure anyway.
 *
 * On failure the edits stay on screen. Losing somebody's tuning because a
 * request failed is not an acceptable outcome for a screen whose whole purpose
 * is accumulating small adjustments.
 */
export function VoiceForm({ initial, readOnly, channels, preview }: VoiceFormProps) {
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const dirty = isDirty(value, saved);

  function submit() {
    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await updateBrandVoiceAction(value);

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      const next: UpdateBrandVoiceInput = {
        name: result.data.name,
        axes: result.data.axes,
        approvedPhrases: result.data.approvedPhrases,
        prohibitedPhrases: result.data.prohibitedPhrases,
      };
      setSaved(next);
      setValue(next);
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <Card>
            <CardHeader
              title="1. How should Lia sound?"
              description="Five paired sliders set the register of every generated response."
            />
            <ul className="mt-4 space-y-4">
              {BRAND_VOICE_AXES.map((axis) => (
                <AxisSlider
                  key={axis.key}
                  axis={axis}
                  value={value.axes[axis.key]}
                  disabled={readOnly || pending}
                  onChange={(next) =>
                    setValue((current) => ({
                      ...current,
                      axes: { ...current.axes, [axis.key]: next },
                    }))
                  }
                />
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="2. Use these phrases"
              description="Phrases Lia may include in responses."
            />
            <PhraseEditor
              id="approved-phrase"
              legend="Add an approved phrase"
              tone="approved"
              phrases={value.approvedPhrases}
              disabled={readOnly || pending}
              error={fieldErrors.approvedPhrases}
              onChange={(next) =>
                setValue((current) => ({ ...current, approvedPhrases: next }))
              }
            />
          </Card>

          <Card>
            <CardHeader
              title="3. Avoid these phrases"
              description="Phrases Lia will never write."
            />
            <PhraseEditor
              id="prohibited-phrase"
              legend="Add a prohibited phrase"
              tone="prohibited"
              phrases={value.prohibitedPhrases}
              disabled={readOnly || pending}
              error={fieldErrors.prohibitedPhrases}
              onChange={(next) =>
                setValue((current) => ({ ...current, prohibitedPhrases: next }))
              }
            />
          </Card>

          {channels}
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          {preview}
          <VoiceSummary axes={value.axes} />
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-600/30 bg-red-100 px-3 py-2 text-[13px] text-red-600"
        >
          {error}
        </p>
      ) : null}

      {!readOnly && dirty ? (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-card">
          <span className="text-[13px] text-gray-700">Unsaved changes</span>
          <span className="flex items-center gap-2">
            <Button type="button" disabled={pending} onClick={() => setValue(saved)}>
              Discard
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={pending ? Loader2 : Save}
              disabled={pending}
            >
              {pending ? "Saving" : "Save changes"}
            </Button>
          </span>
        </div>
      ) : null}
    </form>
  );
}
