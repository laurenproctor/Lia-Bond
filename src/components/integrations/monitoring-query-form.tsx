"use client";

import { useId, useState, useTransition } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Plus, X } from "lucide-react";
import {
  createMonitoringQueryAction,
  updateMonitoringQueryAction,
} from "@/app/actions/monitoring";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { MIN_POLL_INTERVAL_MINUTES } from "@/domain";
import type { MonitoringQuery, MonitoringQueryType } from "@/domain";

/**
 * Creating a monitoring query.
 *
 * A client component because the keyword, exclusion, and allowed-publisher
 * chip inputs are inherently interactive — add on Enter, remove one at a
 * time — and because a create can fail in ways a person needs to read (a
 * duplicate name, a malformed domain) without losing the form's contents to a
 * round trip.
 *
 * `QueryEditor` — the actual field set and submit logic — is exported and
 * reused by `monitoring-query-row-actions.tsx` for editing an existing query
 * in place, so there is exactly one implementation of "what a monitoring
 * query's fields are and how they validate," not two that can drift apart.
 * This file owns the "add a new one" affordance around it; the manage
 * affordances (toggle, poll now, edit, delete) live in their own file,
 * following the codebase's one-client-concern-per-file convention
 * (`rule-toggle.tsx`, `connection-actions.tsx`) rather than bundling every
 * interactive concern on this screen into one file.
 */

const QUERY_TYPE_OPTIONS: { value: MonitoringQueryType; label: string }[] = [
  { value: "brand", label: "Brand" },
  { value: "location", label: "Location" },
  { value: "person", label: "Person" },
  { value: "topic", label: "Topic" },
];

const FIELD_CLASSES =
  "h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-[13px] text-gray-950 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600";

/**
 * The gate's ambiguity rule, restated for the person choosing keywords.
 *
 * Mirrors `AMBIGUOUS_TERM_MAX_LENGTH`'s doc comment in `gate.ts`: a short,
 * single-word keyword ("Nobu", "Zuma", "Bond") is rejected on its own unless
 * a second distinct keyword also matches, or the article's publisher is
 * listed under allowed publishers. Stated here, not just in the rejection
 * log, because a keyword list built without knowing this rule will produce
 * rejections nobody can explain until they read that log.
 */
const KEYWORDS_HINT =
  "Required terms, pushed straight to the search. At least one. A short, single-word term of 8 characters or fewer (\"Nobu\", \"Zuma\") is treated as ambiguous and needs a second distinct keyword — or a publisher listed under allowed publishers below — before Lia admits a match on it alone.";

// The final sentence used to claim "Also narrows results to these
// publishers when set" — false at every layer: gate.ts uses allowedDomains
// only additively (as corroboration and a scoring bonus), no code path
// rejects a candidate for an absent publisher, poll-service.ts never
// forwards it to the search request, NewsSearchQuery has no domain field at
// all, and buildGNewsQuery sends no publisher parameter. A customer listing
// eater.com expecting Eater-only results got every publisher clearing
// threshold instead, with nothing in the rejection log explaining why.
// Deleted; the corroboration sentence is the only one that is true.
const ALLOWED_DOMAINS_HINT =
  "Optional. A publisher listed here counts as corroboration for a short, single-word keyword on its own, so it does not need a second keyword to be admitted.";

const DENIED_DOMAINS_HINT =
  "Optional. A candidate from one of these publishers is rejected outright, with \"Publisher domain not allowed\" recorded against it below.";

/** Sensible default for a new query. Matches the seed data's own default. */
const DEFAULT_RELEVANCE_THRESHOLD = 0.35;

export interface MonitoringLocationOption {
  id: string;
  name: string;
}

/* -------------------------------------------------------------------------- */
/* Chip input, shared by keywords, exclusions, and allowed publishers         */
/* -------------------------------------------------------------------------- */

function ChipField({
  label,
  hint,
  values,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");

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
      <label htmlFor={id} className="text-[12.5px] font-medium text-gray-700">
        {label}
      </label>
      {hint ? <p className="mt-0.5 text-[12px] text-gray-500">{hint}</p> : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-300 bg-white p-1.5">
        {values.map((term) => (
          <span
            key={term}
            className="inline-flex items-center gap-1 rounded-md bg-purple-100 py-0.5 pr-1 pl-2 text-[12.5px] font-medium text-purple-600"
          >
            {term}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(values.filter((value) => value !== term))}
              className="inline-flex size-4 items-center justify-center rounded-sm hover:bg-purple-600/15 disabled:pointer-events-none"
            >
              <X className="size-3" aria-hidden />
              <span className="sr-only">Remove {term}</span>
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ""}
          className="h-7 min-w-24 flex-1 border-0 bg-transparent px-1 text-[13px] text-gray-950 placeholder:text-gray-400 focus:outline-none"
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The shared field set: create and edit both go through this                 */
/* -------------------------------------------------------------------------- */

export type QueryEditorProps =
  | {
      mode: "create";
      query?: undefined;
      locations: MonitoringLocationOption[];
      onCancel: () => void;
      onSaved: (query: MonitoringQuery) => void;
    }
  | {
      mode: "edit";
      query: MonitoringQuery;
      locations: MonitoringLocationOption[];
      onCancel: () => void;
      onSaved: (query: MonitoringQuery) => void;
    };

export function QueryEditor(props: QueryEditorProps) {
  const { mode, query, locations, onCancel, onSaved } = props;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(query?.name ?? "");
  const [queryType, setQueryType] = useState<MonitoringQueryType>(query?.queryType ?? "brand");
  const [locationId, setLocationId] = useState(query?.locationId ?? "");
  const [keywords, setKeywords] = useState<string[]>(query?.keywords ?? []);
  const [exclusions, setExclusions] = useState<string[]>(query?.exclusions ?? []);
  const [allowedDomains, setAllowedDomains] = useState<string[]>(query?.allowedDomains ?? []);
  const [deniedDomains, setDeniedDomains] = useState<string[]>(query?.deniedDomains ?? []);
  const [relevanceThreshold, setRelevanceThreshold] = useState(
    String(query?.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD),
  );
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(
    String(query?.pollIntervalMinutes ?? MIN_POLL_INTERVAL_MINUTES * 4),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (keywords.length === 0) {
      setError("Add at least one keyword.");
      return;
    }

    const threshold = Number(relevanceThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      setError("Admission threshold must be a number between 0 and 1.");
      return;
    }

    const interval = Number(pollIntervalMinutes);

    startTransition(async () => {
      const result =
        mode === "create"
          ? await createMonitoringQueryAction({
              locationId: locationId === "" ? null : locationId,
              name,
              queryType,
              keywords,
              exclusions,
              allowedDomains,
              deniedDomains,
              sourceCountry: "us",
              language: null,
              relevanceThreshold: threshold,
              enabled: true,
              pollIntervalMinutes: interval,
            })
          : await updateMonitoringQueryAction({
              queryId: query.id,
              locationId: locationId === "" ? null : locationId,
              name,
              queryType,
              keywords,
              exclusions,
              allowedDomains,
              deniedDomains,
              relevanceThreshold: threshold,
              pollIntervalMinutes: interval,
            });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      onSaved(result.data);
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4"
    >
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
          {error}
        </p>
      ) : null}

      <QueryNameField value={name} onChange={setName} disabled={pending} />
      <QueryTypeField value={queryType} onChange={setQueryType} disabled={pending} />
      <LocationField
        value={locationId}
        onChange={setLocationId}
        locations={locations}
        disabled={pending}
      />
      <PollIntervalField
        value={pollIntervalMinutes}
        onChange={setPollIntervalMinutes}
        disabled={pending}
      />

      <ChipField
        label="Keywords"
        hint={KEYWORDS_HINT}
        values={keywords}
        onChange={setKeywords}
        placeholder="Add a keyword and press Enter"
        disabled={pending}
      />

      <ChipField
        label="Exclusions"
        hint="Optional. Candidates matching one of these are filtered out."
        values={exclusions}
        onChange={setExclusions}
        placeholder="Add an exclusion and press Enter"
        disabled={pending}
      />

      <ChipField
        label="Allowed publishers"
        hint={ALLOWED_DOMAINS_HINT}
        values={allowedDomains}
        onChange={setAllowedDomains}
        placeholder="Add a domain, e.g. eater.com"
        disabled={pending}
      />

      <ChipField
        label="Denied publishers"
        hint={DENIED_DOMAINS_HINT}
        values={deniedDomains}
        onChange={setDeniedDomains}
        placeholder="Add a domain to reject, e.g. spam-aggregator.example"
        disabled={pending}
      />

      <RelevanceThresholdField
        value={relevanceThreshold}
        onChange={setRelevanceThreshold}
        disabled={pending}
      />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Add query" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export interface MonitoringQueryFormProps {
  locations: MonitoringLocationOption[];
}

export function MonitoringQueryForm({ locations }: MonitoringQueryFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {success ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-green-600/20 bg-green-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <CheckCircle2 className="mt-px size-4 shrink-0 text-green-600" aria-hidden />
          {success}
        </p>
      ) : null}

      {!open ? (
        <Button variant="secondary" icon={Plus} onClick={() => setOpen(true)}>
          Add monitoring query
        </Button>
      ) : (
        <QueryEditor
          mode="create"
          locations={locations}
          onCancel={() => setOpen(false)}
          onSaved={(created) => {
            setSuccess(`"${created.name}" was added and will poll on its own schedule.`);
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Field primitives                                                           */
/* -------------------------------------------------------------------------- */

function QueryNameField({
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
      <label htmlFor={id} className="text-[12.5px] font-medium text-gray-700">
        Name
      </label>
      <input
        id={id}
        type="text"
        required
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. Brand watch"
        className={cn(FIELD_CLASSES, "mt-1.5")}
      />
    </div>
  );
}

function QueryTypeField({
  value,
  onChange,
  disabled,
}: {
  value: MonitoringQueryType;
  onChange: (next: MonitoringQueryType) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[12.5px] font-medium text-gray-700">
        What it watches for
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as MonitoringQueryType)}
        className={cn(FIELD_CLASSES, "mt-1.5")}
      >
        {QUERY_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function LocationField({
  value,
  onChange,
  locations,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  locations: MonitoringLocationOption[];
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-[12.5px] font-medium text-gray-700">
        Location
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_CLASSES, "mt-1.5")}
      >
        <option value="">Organization-wide</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function PollIntervalField({
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
      <label htmlFor={id} className="text-[12.5px] font-medium text-gray-700">
        Poll every (minutes)
      </label>
      <input
        id={id}
        type="number"
        min={MIN_POLL_INTERVAL_MINUTES}
        step={30}
        required
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_CLASSES, "mt-1.5")}
      />
    </div>
  );
}

function RelevanceThresholdField({
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
      <label htmlFor={id} className="text-[12.5px] font-medium text-gray-700">
        Admission threshold (0 to 1)
      </label>
      <p className="mt-0.5 text-[12px] text-gray-500">
        How well a candidate has to score before the gate admits it. Lower
        admits more, and more false positives; raise it if the rejected
        candidates below show real coverage being refused too eagerly, or
        lower it if too little is getting through.
      </p>
      <input
        id={id}
        type="number"
        min={0}
        max={1}
        step={0.05}
        required
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_CLASSES, "mt-1.5")}
      />
    </div>
  );
}
