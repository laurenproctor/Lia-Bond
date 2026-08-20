"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { useRouter } from "next/navigation";
import { Newspaper, Plus, RotateCw, X } from "lucide-react";
import { saveOnboardingNewsMonitoringAction } from "@/app/actions/onboarding";
import { SaveStatus } from "@/components/autosave/save-status";
import { useAutosave, type FlushOutcome } from "@/components/autosave/use-autosave";
import {
  usePostalLookup,
  type Locality,
  type PostalLookup,
} from "@/components/monitoring/use-postal-lookup";
import { OnboardingError } from "@/components/onboarding/onboarding-actions";
import type { MonitoringQuery } from "@/domain";
import type { ActionResult } from "@/lib/actions/result";
import { cn } from "@/lib/cn";
import { MONITORING_COUNTRIES } from "@/lib/geo/countries";

/**
 * The simplified News configuration step 2 offers.
 *
 * A presentation around the real monitoring model, not a second model: what
 * this saves goes through `saveOnboardingNewsMonitoringAction` into the same
 * `monitoring_queries` row the News & Media screen edits, and the fields
 * shown are the answerable half of `onboardingNewsMonitoringInputSchema` —
 * name, keywords, exclusions, country, language. The tuning controls
 * (thresholds, poll intervals, publisher lists) stay on the full integration
 * screen; the server fills their documented defaults.
 *
 * Monitoring is on: a query configured here is created enabled, and there is
 * no pause control in the wizard. `enabled` is still carried on the form so
 * a query somebody paused on the News & Media screen is not silently
 * switched back on the next time step 2 saves.
 *
 * There is no Save button. Edits save themselves after a short settling
 * window (`useAutosave`), the status line says whether what is on screen is
 * on the server, and the two ways out of the panel — closing it, or the
 * step's own "Save and continue" — flush anything outstanding first. Nothing
 * is held back, so there is nothing to discard and nothing to forget to
 * press.
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
  postalCode: string | null;
  localityCity: string | null;
  localityRegion: string | null;
  language: string | null;
  /** Carried, not edited — the wizard shows no pause control. */
  enabled: boolean;
}

/** What "Save and continue" asks before navigating away. */
export interface NewsConfiguratorHandle {
  /**
   * Persist anything the settling window has not sent yet. Resolves
   * `"clean"` when the server already has everything, `"saved"` after a
   * write, `"failed"` when the input is invalid or the write failed — the
   * configurator is already showing why, and navigation must not discard the
   * form over it.
   */
  flush(): Promise<FlushOutcome>;
}

/**
 * Every country GNews filters on, from `MONITORING_COUNTRIES` rather than a
 * second list here — the codes and the labels have one home, and the postal
 * lookup reads the same rows to decide where it can help. Empty means anywhere.
 */
const COUNTRY_OPTIONS = [
  { value: "", label: "Anywhere" },
  ...MONITORING_COUNTRIES.map((country) => ({
    value: country.code,
    label: country.label,
  })),
];

const LANGUAGE_OPTIONS = [
  { value: "", label: "Any language" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
] as const;

const FIELD_CLASSES =
  "min-h-[46px] w-full rounded-xl border border-site-field bg-white px-3.5 text-[14px] text-site-ink placeholder:text-site-muted";

/**
 * Longer than the hook's default, on purpose.
 *
 * Every way out of this panel flushes — Done, the close control, and the
 * step's own "Save and continue" — so unlike the brand voice screen the timer
 * is not the only thing standing between an edit and the database, and it can
 * be tuned for coalescing rather than for safety. Coalescing is the only lever
 * there is on audit volume: `audit_events` is append-only, so a first-run
 * session that fires nine `monitoring_query.updated` events leaves nine in the
 * trail forever. Two seconds folds the way people actually fill this in — one
 * keyword, then the next, then the next — into a single write, and costs
 * nothing, because nobody leaves this panel without a flush.
 */
const SETTLING_MS = 2_000;

/**
 * The two rules the server would reject on anyway, checked here so autosave
 * spends no request finding out and the message names the field.
 */
function validate(values: NewsConfiguratorValues): string | null {
  if (values.name.trim().length === 0) {
    return "Name this monitoring, so it can be recognised later.";
  }
  if (values.keywords.length === 0) {
    return "Add at least one name or keyword to monitor.";
  }
  return null;
}

export function NewsMonitoringConfigurator({
  initial,
  suggestions,
  persisted,
  onClose,
  handleRef,
}: {
  initial: NewsConfiguratorValues;
  /** Real organization facts offered as one-press keywords. Never fabricated. */
  suggestions: string[];
  /** True when a monitoring query already exists for this organization. */
  persisted: boolean;
  onClose: () => void;
  handleRef: Ref<NewsConfiguratorHandle>;
}) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [value, setValue] = useState<NewsConfiguratorValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  /**
   * Whether a row exists to edit. Held in a ref as well as the prop because a
   * save here is believed immediately, while the prop only catches up after
   * `router.refresh` re-renders the page — and in that gap the flush below
   * would otherwise write the same defaults a second time.
   */
  const written = useRef(persisted);
  useEffect(() => {
    if (persisted) written.current = true;
  }, [persisted]);

  // Focus the heading on open, so a keyboard or screen-reader user lands on
  // "what just appeared" rather than staying on a button that now controls an
  // expanded region somewhere below.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const save = useCallback(
    async (next: NewsConfiguratorValues): Promise<ActionResult<MonitoringQuery>> => {
      const problem = validate(next);
      if (problem) return { ok: false, error: problem };

      const result = await saveOnboardingNewsMonitoringAction({
        name: next.name.trim(),
        keywords: next.keywords,
        exclusions: next.exclusions,
        sourceCountry: next.sourceCountry,
        postalCode: next.postalCode,
        localityCity: next.localityCity,
        localityRegion: next.localityRegion,
        language: next.language,
        enabled: next.enabled,
      });

      if (result.ok) {
        written.current = true;
        // Re-derive the card's summary from what was actually persisted.
        router.refresh();
      }
      return result;
    },
    [router],
  );

  /**
   * Deliberately does not re-seed the form from the response. The server
   * trims the name, and adopting that mid-sentence would delete characters
   * typed while the request was in flight. The card beside the panel is
   * re-read from the database instead, so what is *reported* stays true to
   * the row either way.
   */
  const handleSaved = useCallback(() => setError(null), []);
  const handleFailed = useCallback((message: string) => setError(message), []);

  const { status, commit, retry, flush } = useAutosave<
    NewsConfiguratorValues,
    MonitoringQuery
  >(value, {
    save,
    onSaved: handleSaved,
    onFailed: handleFailed,
    enabled: true,
    idleMs: SETTLING_MS,
  });

  /** Change one field and treat the edit as complete. */
  function edit(patch: Partial<NewsConfiguratorValues>) {
    setValue((current) => ({ ...current, ...patch }));
    commit();
  }

  /**
   * The country, postal code, and the city and region it resolves to.
   *
   * Every change routes through `edit`, so an auto-filled city is an edit like
   * any other: the settling window starts, the status line says "saving", and
   * the value is on the server two seconds later without anybody pressing
   * anything.
   */
  const locality = usePostalLookup({
    value: {
      sourceCountry: value.sourceCountry,
      postalCode: value.postalCode,
      localityCity: value.localityCity,
      localityRegion: value.localityRegion,
    },
    onChange: edit,
  });

  useImperativeHandle(
    handleRef,
    () => ({
      async flush() {
        const outcome = await flush();
        if (outcome !== "clean") return outcome;
        if (written.current) return "clean";

        // Open, untouched, and nothing persisted: the panel is showing
        // defaults nobody has disagreed with, and pressing the step's own
        // save button is the confirmation of them. Closing the panel is not,
        // which is why this lives here rather than in `requestClose`.
        commit();
        return flush();
      },
    }),
    [flush, commit],
  );

  /** Closing must not drop an edit the settling window has not sent yet. */
  function requestClose() {
    if (closing) return;
    setClosing(true);
    void flush().then((outcome) => {
      setClosing(false);
      // The panel stays open on a failure, showing what is wrong. Closing
      // would throw the input away over it.
      if (outcome === "failed") {
        headingRef.current?.focus();
        return;
      }
      onClose();
    });
  }

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
              its relevance checks. Changes save as you make them. Thresholds,
              poll schedules, and publisher lists can be tuned later on the
              News &amp; Media screen.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={requestClose}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-site-muted transition-colors hover:bg-site-tint hover:text-site-ink"
        >
          <X className="size-5" aria-hidden />
          <span className="sr-only">Close News &amp; Media configuration</span>
        </button>
      </div>

      <SaveStatus status={status} />

      {error ? (
        <OnboardingError>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error} Your changes are still here.</span>
            <button
              type="button"
              onClick={retry}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-red-600/30 bg-white px-3 text-[13px] font-semibold text-red-600 transition-colors hover:bg-red-50"
            >
              <RotateCw className="size-3.5" aria-hidden />
              Retry
            </button>
          </div>
        </OnboardingError>
      ) : null}

      <NameField value={value.name} onChange={(name) => edit({ name })} />

      <ChipField
        label="Names and keywords"
        hint="What Lia searches coverage for — your organization, common abbreviations, important people. At least one."
        values={value.keywords}
        onChange={(keywords) => edit({ keywords })}
        suggestions={suggestions}
        placeholder="Add a name and press Enter"
      />

      <ChipField
        label="Excluded terms"
        hint="Optional. Coverage matching one of these is filtered out."
        values={value.exclusions}
        onChange={(exclusions) => edit({ exclusions })}
        placeholder="Add an exclusion and press Enter"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Country or market"
          value={value.sourceCountry}
          onChange={locality.setCountry}
          options={COUNTRY_OPTIONS}
        />
        <SelectField
          label="Language"
          value={value.language}
          onChange={(language) => edit({ language })}
          options={LANGUAGE_OPTIONS}
        />
      </div>

      <LocalityFields
        value={{
          sourceCountry: value.sourceCountry,
          postalCode: value.postalCode,
          localityCity: value.localityCity,
          localityRegion: value.localityRegion,
        }}
        lookup={locality}
      />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={requestClose}
          aria-disabled={closing ? true : undefined}
          className={cn(
            "inline-flex min-h-[44px] items-center justify-center rounded-xl border border-site-blue-edge bg-white px-5 py-2.5",
            "text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint",
            closing && "cursor-progress opacity-80",
          )}
        >
          {closing ? "Saving…" : "Done"}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Nothing here disables itself while a save runs. Autosave fires on a timer
 * the user did not choose, and freezing the fields underneath them every time
 * it does is the quickest way to make the panel feel broken. Requests are
 * serialised in `useAutosave` instead.
 */

function NameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
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
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. Brand name watch"
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
  suggestions = [],
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
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
              onClick={() => onChange(values.filter((value) => value !== term))}
              className="inline-flex size-6 items-center justify-center rounded-md hover:bg-site-blue/15"
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
              onClick={() => onChange([...values, suggestion])}
              className="inline-flex items-center gap-1 rounded-lg border border-site-border bg-site-tint px-2.5 py-1 text-[12.5px] font-semibold text-site-body transition-colors hover:bg-site-blue-tint hover:text-site-blue"
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

/** Empty option means "no preference", which the query stores as null. */
function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  options: readonly { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-semibold text-site-ink">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
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

/**
 * Where this organization is, inside the market it just chose.
 *
 * Sits under the country because it depends on it: the postal field is
 * disabled until a country is set, which is how the "a postal code needs a
 * country" invariant is enforced — `monitoringQuerySchema` deliberately does
 * not enforce it, because a partial update has no country to check against.
 *
 * The city and region are editable in every country, including the ones the
 * lookup covers. Auto-fill is a convenience, not an assertion: the lookup
 * resolves an area rather than a precise town in several markets, and the
 * person filling this in knows their own city better than a free postal API
 * does. What is *never* done is filling them with a guess — a lookup that
 * fails leaves them empty and says so.
 */
function LocalityFields({
  value,
  lookup,
}: {
  value: Locality;
  lookup: PostalLookup;
}) {
  const postalId = useId();
  const cityId = useId();
  const regionId = useId();
  const statusId = `${postalId}-status`;

  const hasCountry = value.sourceCountry !== null;

  return (
    <div>
      <p className="text-[13px] font-semibold text-site-ink">
        Where you are
      </p>
      <p className="mt-0.5 max-w-[62ch] text-[12.5px] leading-relaxed text-site-muted">
        Optional. Lia searches the whole market you chose above. This is the
        local anchor it will use when regional coverage becomes available —
        it changes nothing about what is monitored today.
      </p>

      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={postalId} className="text-[13px] font-semibold text-site-ink">
            {lookup.postalLabel}
          </label>
          <input
            id={postalId}
            type="text"
            inputMode="text"
            autoComplete="postal-code"
            maxLength={12}
            disabled={!hasCountry}
            aria-describedby={statusId}
            value={value.postalCode ?? ""}
            onChange={(event) => lookup.setPostalCode(event.target.value)}
            placeholder={hasCountry ? "" : "Choose a country first"}
            className={cn(
              FIELD_CLASSES,
              "mt-1.5",
              !hasCountry && "cursor-not-allowed bg-site-tint text-site-muted",
            )}
          />
        </div>

        <div>
          <label htmlFor={cityId} className="text-[13px] font-semibold text-site-ink">
            City
          </label>
          <input
            id={cityId}
            type="text"
            autoComplete="address-level2"
            maxLength={120}
            disabled={!hasCountry}
            value={value.localityCity ?? ""}
            onChange={(event) => lookup.setCity(event.target.value)}
            className={cn(
              FIELD_CLASSES,
              "mt-1.5",
              !hasCountry && "cursor-not-allowed bg-site-tint text-site-muted",
            )}
          />
        </div>

        <div>
          <label htmlFor={regionId} className="text-[13px] font-semibold text-site-ink">
            State or region
          </label>
          <input
            id={regionId}
            type="text"
            autoComplete="address-level1"
            maxLength={120}
            disabled={!hasCountry}
            value={value.localityRegion ?? ""}
            onChange={(event) => lookup.setRegion(event.target.value)}
            className={cn(
              FIELD_CLASSES,
              "mt-1.5",
              !hasCountry && "cursor-not-allowed bg-site-tint text-site-muted",
            )}
          />
        </div>
      </div>

      {/*
        Polite rather than assertive, and never a role="alert": the lookup runs
        on a debounce nobody asked for, and interrupting a screen reader
        mid-word to announce that a third-party service is slow would be worse
        than the problem. A failure here costs two fields of typing.
      */}
      <p
        id={statusId}
        aria-live="polite"
        className={cn(
          "mt-1.5 text-[12.5px] leading-relaxed",
          lookup.status === "failed" ? "text-red-600" : "text-site-muted",
        )}
      >
        <LocalityStatusText value={value} lookup={lookup} />
      </p>
    </div>
  );
}

/** One sentence about what the lookup is doing, or nothing at all. */
function LocalityStatusText({
  value,
  lookup,
}: {
  value: Locality;
  lookup: PostalLookup;
}) {
  if (value.sourceCountry === null) return null;
  if (lookup.status === "looking-up") return <>Looking up that {lookup.postalLabel.toLowerCase()}…</>;
  if (lookup.status === "failed") return <>{lookup.message}</>;
  if (lookup.status === "filled") {
    return <>City and region filled in from the {lookup.postalLabel.toLowerCase()}. Edit either if it is not right.</>;
  }
  if (!lookup.lookupSupported) {
    return <>Lia cannot look up postal codes in this country yet — enter the city and region yourself.</>;
  }
  return null;
}
