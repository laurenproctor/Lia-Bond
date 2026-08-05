"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { MAX_PHRASE_LENGTH, MAX_PHRASES } from "@/domain";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface PhraseEditorProps {
  /** Distinguishes the two instances for label association. */
  id: string;
  legend: string;
  tone: "approved" | "prohibited";
  phrases: string[];
  disabled?: boolean;
  error?: string;
  onChange: (phrases: string[]) => void;
}

const TONE_CLASSES: Record<PhraseEditorProps["tone"], string> = {
  approved: "bg-green-100 text-green-600",
  prohibited: "bg-red-100 text-red-600",
};

/**
 * A editable list of phrases.
 *
 * Used for both the approved and prohibited lists — they differ only in colour
 * and wording, so one component with a `tone` beats two that drift apart.
 *
 * Duplicates and blanks are dropped by the schema on save; this only guards the
 * count, so somebody cannot add a 21st chip and discover on submit that it was
 * never going to be accepted.
 */
export function PhraseEditor({
  id,
  legend,
  tone,
  phrases,
  disabled = false,
  error,
  onChange,
}: PhraseEditorProps) {
  const [draft, setDraft] = useState("");
  const full = phrases.length >= MAX_PHRASES;

  function add() {
    const phrase = draft.trim();
    if (!phrase || full) return;
    if (phrases.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...phrases, phrase]);
    setDraft("");
  }

  return (
    <div className="mt-4">
      <ul className="flex flex-wrap gap-2">
        {phrases.map((phrase) => (
          <li
            key={phrase}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px]",
              TONE_CLASSES[tone],
            )}
          >
            {phrase}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(phrases.filter((value) => value !== phrase))}
              aria-label={`Remove ${phrase}`}
              className="rounded-sm hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
        {phrases.length === 0 ? (
          <li className="text-[13px] text-gray-500">None yet.</li>
        ) : null}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          {legend}
        </label>
        <input
          id={id}
          type="text"
          value={draft}
          maxLength={MAX_PHRASE_LENGTH}
          disabled={disabled || full}
          placeholder={full ? `Limit of ${MAX_PHRASES} reached` : "Add a phrase"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the phrase rather than submitting the form. A form
            // submit here would save the whole profile from a half-typed chip.
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className="h-9 min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 text-[13px] text-gray-950 placeholder:text-gray-400 focus:border-purple-600 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
        />
        <Button
          type="button"
          size="sm"
          icon={Plus}
          disabled={disabled || full || draft.trim().length === 0}
          onClick={add}
        >
          Add
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
