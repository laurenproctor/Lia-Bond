"use client";

import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type Ref,
} from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Newspaper, Plus, X } from "lucide-react";
import { saveOnboardingNewsMonitoringAction } from "@/app/actions/onboarding";
import { OnboardingError } from "@/components/onboarding/onboarding-actions";
import { cn } from "@/lib/cn";

/**
 * The simplified News configuration step 2 offers.
 *
 * A presentation around the real monitoring model, not a second model: what
 * this saves goes through `saveOnboardingNewsMonitoringAction` into the same
 * `monitoring_queries` row the News & Media screen edits, and the fields
 * shown are exactly `onboardingNewsMonitoringInputSchema` — name, keywords,
 * exclusions, country, language, enabled. The tuning controls (thresholds,
 * poll intervals, publisher lists) stay on the full integration screen; the
 * server fills their documented defaults.
 *
 * Rendered as an expanded section beneath the source cards rather than a
 * dialog: the repository has no modal primitive on the onboarding surface,
 * and an expander needs no focus trap to get right. Focus lands on the
 * heading when it opens; the parent returns focus to the triggering button
 * when it closes.
 */

export interface NewsConfiguratorValues {
  name: string;
  keywords: string[];
  exclusions: string[];
  sourceCountry: string | null;
  language: string | null;
  enabled: boolean;
}

/** What "Save and continue" asks before navigating away. */
export interface NewsConfiguratorHandle {
  /**
   * Persist unsaved input. Resolves `"clean"` when there is nothing to save,
   * `"saved"` on success, `"invalid"` when the input fails validation or the
   * save fails — the configurator is already showing why, and navigation
   * must not discard the form over it.
   */
  flush(): Promise<"clean" | "saved" | "invalid">;
}

/**
 * Curated to what GNews actually filters on. Two-letter codes, lowercase,
 * matching `monitoringQuerySchema.sourceCountry`. Empty means anywhere.
 */
const COUNTRY_OPTIONS = [
  { value: "", label: "Anywhere" },
  { value: "us", label: "United States" },
  { value: "gb", label: "United Kingdom" },
  { value: "ca", label: "Canada" },
  { value: "au", label: "Australia" },
  { value: "ie", label: "Ireland" },
  { value: "de", label: "Germany" },
  { value: "fr", label: "France" },
  { value: "es", label: "Spain" },
] as const;

const LANGUAGE_OPTIONS = [
  { value: "", label: "Any language" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
] as const;

const FIELD_CLASSES =
  "min-h-[46px] w-full rounded-xl border border-site-field bg-white px-3.5 text-[14px] text-site-ink placeholder:text-site-muted";

export function NewsMonitoringConfigurator({
  initial,
  suggestions,
  onClose,
  handleRef,
}: {
  initial: NewsConfiguratorValues;
  /** Real organization facts offered as one-press keywords. Never fabricated. */
  suggestions: string[];
  onClose: () => void;
  handleRef: Ref<NewsConfiguratorHandle>;
}) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [name, setName] = useState(initial.name);
  const [keywords, setKeywords] = useState(initial.keywords);
  const [exclusions, setExclusions] = useState(initial.exclusions);
  const [sourceCountry, setSourceCountry] = useState(initial.sourceCountry ?? "");
  const [language, setLanguage] = useState(initial.language ?? "");
  const [enabled, setEnabled] = useState(initial.enabled);

  // Focus the heading on open, so a keyboard or screen-reader user lands on
  // "what just appeared" rather than staying on a button that now controls an
  // expanded region somewhere below.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  function touch<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setSaved(false);
    };
  }

  function validate(): string | null {
    if (name.trim().length === 0) return "Name this monitoring, so it can be recognised later.";
    if (keywords.length === 0) return "Add at least one name or keyword to monitor.";
    return null;
  }

  /** One save path, shared by the Save button and the parent's flush. */
  function save(): Promise<"saved" | "invalid"> {
    const problem = validate();
    if (problem) {
      setError(problem);
      return Promise.resolve("invalid");
    }
    setError(null);

    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await saveOnboardingNewsMonitoringAction({
          name: name.trim(),
          keywords,
          exclusions,
          sourceCountry: sourceCountry === "" ? null : sourceCountry,
          language: language === "" ? null : language,
          enabled,
        });

        if (!result.ok) {
          setError(result.error);
          resolve("invalid");
          return;
        }

        setSaved(true);
        setDirty(false);
        // Re-derive the card's summary from what was actually persisted.
        router.refresh();
        resolve("saved");
      });
    });
  }

  useImperativeHandle(handleRef, () => ({
    async flush() {
      if (!dirty) return "clean";
      return save();
    },
  }));

  return (
    <section
      id="news-monitoring-configurator"
      aria-labelledby="news-configurator-heading"
      className="flex flex-col gap-4 rounded-2xl border border-site-blue-edge bg-white p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="hidden size-10 shrink-0 items-center justify-center rounded-full bg-site-blue-tint sm:flex">
            <Newspaper className="size-5 text-site-blue" strokeWidth={1.8} aria-hidden />
          </span>
          <div>
            <h4
              id="news-configurator-heading"
              ref={headingRef}
              tabIndex={-1}
              className="text-[16px] font-bold text-site-ink outline-none"
            >
              News &amp; Media monitoring
            </h4>
            <p className="mt-0.5 max-w-[52ch] text-[13px] leading-relaxed text-site-body">
              Lia searches news coverage for these names and keeps what clears
              its relevance checks. Thresholds, poll schedules, and publisher
              lists can be tuned later on the News &amp; Media screen.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-site-muted transition-colors hover:bg-site-tint hover:text-site-ink"
        >
          <X className="size-5" aria-hidden />
          <span className="sr-only">Close News &amp; Media configuration</span>
        </button>
      </div>

      {error ? <OnboardingError>{error}</OnboardingError> : null}
      {saved && !error ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl border border-green-600/20 bg-green-100 px-4 py-3 text-[13.5px] text-green-700"
        >
          <CheckCircle2 className="mt-0.5 size-[18px] shrink-0" strokeWidth={2} aria-hidden />
          News monitoring saved. You can keep editing, or continue to the next
          step.
        </p>
      ) : null}

      <NameField value={name} onChange={touch(setName)} disabled={pending} />

      <ChipField
        label="Names and keywords"
        hint="What Lia searches coverage for — your organization, common abbreviations, important people. At least one."
        values={keywords}
        onChange={touch(setKeywords)}
        suggestions={suggestions}
        placeholder="Add a name and press Enter"
        disabled={pending}
      />

      <ChipField
        label="Excluded terms"
        hint="Optional. Coverage matching one of these is filtered out."
        values={exclusions}
        onChange={touch(setExclusions)}
        placeholder="Add an exclusion and press Enter"
        disabled={pending}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Country or market"
          value={sourceCountry}
          onChange={touch(setSourceCountry)}
          options={COUNTRY_OPTIONS}
          disabled={pending}
        />
        <SelectField
          label="Language"
          value={language}
          onChange={touch(setLanguage)}
          options={LANGUAGE_OPTIONS}
          disabled={pending}
        />
      </div>

      <EnabledField value={enabled} onChange={touch(setEnabled)} disabled={pending} />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className="inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 py-2.5 text-[14px] font-semibold text-site-blue underline-offset-4 transition-colors hover:underline disabled:opacity-60"
        >
          Close
        </button>
        <button
          type="button"
          onClick={() => void save()}
          aria-disabled={pending ? true : undefined}
          className={cn(
            "inline-flex min-h-[44px] items-center justify-center rounded-xl border border-site-blue-edge bg-white px-5 py-2.5",
            "text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint",
            pending && "cursor-progress opacity-80",
          )}
        >
          {pending ? "Saving…" : "Save monitoring"}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

function NameField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-semibold text-site-ink">
        Monitoring name
      </label>
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. Brand watch"
        className={cn(FIELD_CLASSES, "mt-1.5")}
      />
    </div>
  );
}

/**
 * Chip entry, keyboard-first: Enter or comma commits the draft, Backspace on
 * an empty draft removes the last chip, and every chip's remove button names
 * the term it removes. The suggestions row offers real organization facts as
 * one press each — never anything invented.
 */
function ChipField({
  label,
  hint,
  values,
  onChange,
  placeholder,
  disabled,
  suggestions = [],
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled: boolean;
  suggestions?: string[];
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [draft, setDraft] = useState("");

  const remaining = suggestions.filter((suggestion) => !values.includes(suggestion));

  function commit() {
    const term = draft.trim();
    if (term.length === 0) return;
    if (!values.includes(term)) onChange([...values, term]);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft.length === 0 && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-semibold text-site-ink">
        {label}
      </label>
      <p id={hintId} className="mt-0.5 text-[12.5px] leading-relaxed text-site-muted">
        {hint}
      </p>
      <div className="mt-1.5 flex min-h-[46px] flex-wrap items-center gap-1.5 rounded-xl border border-site-field bg-white p-2">
        {values.map((term) => (
          <span
            key={term}
            className="inline-flex items-center gap-1 rounded-lg bg-site-blue-tint py-1 pr-1 pl-2.5 text-[13px] font-semibold text-site-blue"
          >
            {term}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(values.filter((value) => value !== term))}
              className="inline-flex size-6 items-center justify-center rounded-md hover:bg-site-blue/15 disabled:pointer-events-none"
            >
              <X className="size-3.5" aria-hidden />
              <span className="sr-only">Remove {term}</span>
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={draft}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ""}
          className="h-8 min-w-28 flex-1 border-0 bg-transparent px-1.5 text-[14px] text-site-ink placeholder:text-site-muted focus:outline-none"
        />
      </div>
      {remaining.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-semibold text-site-muted">Suggestions:</span>
          {remaining.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={disabled}
              onClick={() => onChange([...values, suggestion])}
              className="inline-flex items-center gap-1 rounded-lg border border-site-border bg-site-tint px-2.5 py-1 text-[12.5px] font-semibold text-site-body transition-colors hover:bg-site-blue-tint hover:text-site-blue disabled:opacity-60"
            >
              <Plus className="size-3.5" aria-hidden />
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-semibold text-site-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_CLASSES, "mt-1.5")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function EnabledField({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-site-blue)]"
      />
      <label htmlFor={id} className="text-[13.5px] leading-snug text-site-ink">
        <span className="font-semibold">Monitoring enabled</span>
        <span className="block text-[12.5px] text-site-muted">
          Unchecked saves the configuration paused — nothing is polled until
          it is enabled.
        </span>
      </label>
    </div>
  );
}
