"use client";

import { useCallback, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { updateBrandVoiceAction } from "@/app/actions/brand-voice";
import { AxisSlider } from "@/components/brand-voice/axis-slider";
import { PhraseEditor } from "@/components/brand-voice/phrase-editor";
import { SaveStatus } from "@/components/autosave/save-status";
import { useAutosave } from "@/components/autosave/use-autosave";
import { VoicePreview } from "@/components/brand-voice/voice-preview";
import { VoiceSummary } from "@/components/brand-voice/voice-summary";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  BRAND_VOICE_AXES,
  SUGGESTED_APPROVED_PHRASES,
  SUGGESTED_PROHIBITED_PHRASES,
  type UpdateBrandVoiceInput,
} from "@/domain";

export interface VoiceFormProps {
  initial: UpdateBrandVoiceInput;
  /** True when the caller's role cannot change the voice. */
  readOnly: boolean;
  /**
   * Server-rendered cards that sit inside the form's layout.
   *
   * `channels` stays a prop because it renders the organization's *connected
   * platforms* — server data this component has no business fetching. The
   * preview used to arrive the same way and no longer does: it is derived
   * entirely from the state held here, and a preview that cannot follow a
   * slider is not a preview.
   */
  channels: ReactNode;
}

/**
 * The editable brand voice.
 *
 * Changes save themselves: a slider on release, a phrase immediately, then an
 * idle window so a burst of edits becomes one request. There is no Save button
 * and no Discard — with nothing held back there is nothing to discard, and the
 * screen says whether the current state is on the server instead.
 *
 * Controls are never disabled while a save runs. Disabling them would freeze
 * the form every time it autosaved, which is the quickest way to make this feel
 * broken; the request is serialised in `useAutosave` instead.
 *
 * A failure keeps the edits on screen. Losing somebody's tuning because a
 * request failed is not acceptable on a screen whose whole purpose is
 * accumulating small adjustments.
 */
export function VoiceForm({ initial, readOnly, channels }: VoiceFormProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSaved = useCallback((saved: UpdateBrandVoiceInput) => {
    setError(null);
    setFieldErrors({});
    // Re-seeded from the server so its normalisation — trimming, dedupe — is
    // what the form holds. Without this the screen keeps a value the database
    // does not have.
    setValue({
      name: saved.name,
      axes: saved.axes,
      approvedPhrases: saved.approvedPhrases,
      prohibitedPhrases: saved.prohibitedPhrases,
    });
  }, []);

  const handleFailed = useCallback(
    (message: string, fields: Record<string, string>) => {
      setError(message);
      setFieldErrors(fields);
    },
    [],
  );

  const { status, commit, retry } = useAutosave(value, {
    save: updateBrandVoiceAction,
    onSaved: handleSaved,
    onFailed: handleFailed,
    enabled: !readOnly,
  });

  /** Change the value and treat the edit as complete. */
  function edit(update: (current: UpdateBrandVoiceInput) => UpdateBrandVoiceInput) {
    setValue(update);
    commit();
  }

  return (
    <div className="flex flex-col gap-4">
      {readOnly ? null : <SaveStatus status={status} />}

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
                  disabled={readOnly}
                  // The summary follows every frame of the drag; only the
                  // release starts a save.
                  onChange={(next) =>
                    setValue((current) => ({
                      ...current,
                      axes: { ...current.axes, [axis.key]: next },
                    }))
                  }
                  onCommit={commit}
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
              counterpartPhrases={value.prohibitedPhrases}
              suggestions={SUGGESTED_APPROVED_PHRASES}
              disabled={readOnly}
              error={fieldErrors.approvedPhrases}
              onChange={(next) =>
                edit((current) => ({ ...current, approvedPhrases: next }))
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
              counterpartPhrases={value.approvedPhrases}
              suggestions={SUGGESTED_PROHIBITED_PHRASES}
              disabled={readOnly}
              error={fieldErrors.prohibitedPhrases}
              onChange={(next) =>
                edit((current) => ({ ...current, prohibitedPhrases: next }))
              }
            />
          </Card>

          {channels}
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          <VoicePreview value={value} />
          <VoiceSummary axes={value.axes} />
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-600/30 bg-red-100 px-3 py-2 text-[13px] text-red-600"
        >
          <span>{error} Your changes are still here.</span>
          <Button type="button" size="sm" icon={RotateCw} onClick={retry}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
