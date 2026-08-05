"use client";

import { useId, useState, useTransition } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Plus, RotateCw, Trash2, X } from "lucide-react";
import {
  createMonitoringQueryAction,
  deleteMonitoringQueryAction,
  pollMonitoringQueryAction,
  updateMonitoringQueryAction,
} from "@/app/actions/monitoring";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/cn";
import { MIN_POLL_INTERVAL_MINUTES } from "@/domain";
import type { MonitoringQuery, MonitoringQueryType } from "@/domain";

/**
 * Everything a monitoring query needs a browser for.
 *
 * The one client component on this screen. Two things need it: creating a
 * query needs the keyword and exclusion chip inputs, which are inherently
 * interactive (add on Enter, remove one at a time); and managing an existing
 * query needs to show the result of an action — a poll's own sentence about
 * what it found, a toggle that can be refused by the server, a delete that
 * needs to be confirmed — none of which a server-rendered page can do without
 * a round trip that loses the message. Both concerns live in this one file so
 * that stays true: everything else on the screen is a server component.
 */

const QUERY_TYPE_OPTIONS: { value: MonitoringQueryType; label: string }[] = [
  { value: "brand", label: "Brand" },
  { value: "location", label: "Location" },
  { value: "person", label: "Person" },
  { value: "topic", label: "Topic" },
];

const FIELD_CLASSES =
  "h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-[13px] text-gray-950 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600";

export interface MonitoringLocationOption {
  id: string;
  name: string;
}

/* -------------------------------------------------------------------------- */
/* Chip input, shared by keywords and exclusions                              */
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
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export interface MonitoringQueryFormProps {
  locations: MonitoringLocationOption[];
}

/** Sensible defaults for the fields this form does not expose directly. */
const DEFAULT_RELEVANCE_THRESHOLD = 0.35;

export function MonitoringQueryForm({ locations }: MonitoringQueryFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [queryType, setQueryType] = useState<MonitoringQueryType>("brand");
  const [locationId, setLocationId] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(
    String(MIN_POLL_INTERVAL_MINUTES * 4),
  );

  function reset() {
    setName("");
    setQueryType("brand");
    setLocationId("");
    setKeywords([]);
    setExclusions([]);
    setPollIntervalMinutes(String(MIN_POLL_INTERVAL_MINUTES * 4));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (keywords.length === 0) {
      setError("Add at least one keyword.");
      return;
    }

    startTransition(async () => {
      const result = await createMonitoringQueryAction({
        locationId: locationId === "" ? null : locationId,
        name,
        queryType,
        keywords,
        exclusions,
        allowedDomains: [],
        deniedDomains: [],
        sourceCountry: "us",
        language: null,
        relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
        enabled: true,
        pollIntervalMinutes: Number(pollIntervalMinutes),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setSuccess(`"${result.data.name}" was added and will poll on its own schedule.`);
      reset();
      setOpen(false);
      router.refresh();
    });
  }

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
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4">
          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950"
            >
              <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
              {error}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>

          <ChipField
            label="Keywords"
            hint="Required terms, pushed straight to the search. At least one."
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

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setError(null);
                reset();
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Adding…" : "Add query"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

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

/* -------------------------------------------------------------------------- */
/* Manage: toggle, poll now, delete                                           */
/* -------------------------------------------------------------------------- */

export interface MonitoringQueryRowActionsProps {
  query: MonitoringQuery;
  canManage: boolean;
  canPoll: boolean;
  /** False when news monitoring is not configured on this deployment. */
  connectorAvailable: boolean;
}

interface RowFeedback {
  tone: "success" | "warning";
  message: string;
}

export function MonitoringQueryRowActions({
  query,
  canManage,
  canPoll,
  connectorAvailable,
}: MonitoringQueryRowActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [feedback, setFeedback] = useState<RowFeedback | null>(null);
  const [enabled, setEnabled] = useState(query.enabled);

  function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    setFeedback(null);

    startTransition(async () => {
      const result = await updateMonitoringQueryAction({ queryId: query.id, enabled: next });

      if (!result.ok) {
        setEnabled(!next);
        setFeedback({ tone: "warning", message: result.error });
        return;
      }
      router.refresh();
    });
  }

  function pollNow() {
    setFeedback(null);
    startTransition(async () => {
      const result = await pollMonitoringQueryAction({ queryId: query.id });

      setFeedback(
        result.ok
          ? { tone: result.data.degraded ? "warning" : "success", message: result.data.message }
          : { tone: "warning", message: result.error },
      );
      router.refresh();
    });
  }

  function runDelete() {
    setConfirmOpen(false);
    setFeedback(null);

    startTransition(async () => {
      const result = await deleteMonitoringQueryAction({ queryId: query.id });

      if (!result.ok) {
        setFeedback({ tone: "warning", message: result.error });
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} ${query.name}`}
          disabled={!canManage || pending}
          onClick={toggleEnabled}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
            enabled ? "bg-purple-600" : "bg-gray-300",
            (!canManage || pending) && "cursor-not-allowed opacity-50",
          )}
        >
          <span
            className={cn(
              "inline-block size-4 rounded-full bg-white transition-transform",
              enabled ? "translate-x-4.5" : "translate-x-0.5",
            )}
          />
        </button>

        {canPoll ? (
          <Button
            size="sm"
            icon={pending ? RotateCw : undefined}
            onClick={pollNow}
            disabled={pending || !connectorAvailable}
            title={
              connectorAvailable
                ? "Poll this query now"
                : "News monitoring is not configured on this server"
            }
          >
            {pending ? "Polling…" : "Poll now"}
          </Button>
        ) : null}

        {canManage ? (
          <Button
            size="sm"
            variant="destructive"
            icon={Trash2}
            iconOnly
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
          >
            Delete {query.name}
          </Button>
        ) : null}
      </div>

      {feedback ? (
        <p
          role="status"
          className={cn(
            "max-w-64 text-right text-[12px]",
            feedback.tone === "success" ? "text-green-600" : "text-amber-600",
          )}
        >
          {feedback.message}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        destructive
        title={`Delete "${query.name}"?`}
        description="Lia stops polling this query immediately. Mentions it already found are kept; nothing already in the inbox is removed."
        confirmLabel="Delete query"
        onConfirm={runDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
