"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, Lock, RefreshCw, Store } from "lucide-react";
import { discoverGoogleLocationsAction } from "@/app/actions/integrations";
import {
  saveOnboardingLocationsAction,
  skipOnboardingLocationsAction,
} from "@/app/actions/onboarding";
import {
  OnboardingActions,
  OnboardingError,
  PrimaryAction,
  SecondaryLink,
  TertiaryAction,
} from "@/components/onboarding/onboarding-actions";
import {
  OnboardingCard,
  OnboardingNote,
  OnboardingStepHeader,
} from "@/components/onboarding/onboarding-card";
import { GoogleGlyph } from "@/components/onboarding/platform-tile";
import type { LiaLocationOption, RowChoice } from "@/components/integrations/mapping-types";
import type { LocationCandidate } from "@/lib/integrations/google-service";
import { cn } from "@/lib/cn";

/**
 * Step 3, connected path.
 *
 * The rule that shapes this whole component: **a suggestion is never applied.**
 * `buildCandidates` computes a fuzzy match between a Google listing and a Lia
 * location, and the temptation is to pre-tick it. This does not. A wrong
 * mapping sends one restaurant's complaints to another's queue, where somebody
 * answers them in good faith about a meal that was never served there — and the
 * damage is invisible until it is public. Every suggestion is rendered as a
 * proposal with its own explicit control, and the default for an unmapped row
 * is "create a new location", which is always safe.
 *
 * Nothing here is trusted by the server either. The action re-fetches every
 * selected listing from Google and re-checks every Lia location id against the
 * organization, so the ids in this form are claims rather than evidence.
 */

type RowState = {
  selected: boolean;
  choice: RowChoice;
};

/**
 * One decision, as `mappingDecisionSchema` expects it.
 *
 * Restated here rather than imported from `@/lib/integrations/google-mapping`,
 * which is a `server-only` module: a `import type` from it would be erased at
 * build time and work, but it would put a server module's name in a client
 * component's import list, which is exactly the mistake `server-only` exists to
 * make loud. The action re-parses whatever arrives, so this shape is checked
 * against the real schema on every submission.
 */
type MappingDecisionInput =
  | { action: "map_existing"; externalProfileId: string; locationId: string }
  | {
      action: "create_location";
      externalProfileId: string;
      name: string;
      timezone: string;
    };

function initialRowState(
  candidate: LocationCandidate,
  organizationTimezone: string,
): RowState {
  void organizationTimezone;

  // Already mapped and connected: shown as settled, not offered again.
  if (candidate.state === "already_connected" && candidate.mappedLocationId) {
    return {
      selected: false,
      choice: { kind: "existing", locationId: candidate.mappedLocationId },
    };
  }

  // Unmapped. Defaults to creating a location, never to the suggestion — see
  // the note on this component.
  return {
    selected: false,
    choice: { kind: "create", name: candidate.profile.displayName },
  };
}

export interface GoogleAccountOption {
  externalAccountId: string;
  name: string;
}

export function GoogleLocationsStep({
  connectionId,
  accountName,
  accounts,
  initialAccountId,
  initialCandidates,
  locations,
  organizationTimezone,
  discoveryError,
}: {
  connectionId: string;
  accountName: string | null;
  accounts: readonly GoogleAccountOption[];
  initialAccountId: string | null;
  initialCandidates: LocationCandidate[];
  locations: readonly LiaLocationOption[];
  organizationTimezone: string;
  discoveryError: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);

  const [accountId, setAccountId] = useState(initialAccountId);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      initialCandidates.map((candidate) => [
        candidate.profile.externalProfileId,
        initialRowState(candidate, organizationTimezone),
      ]),
    ),
  );

  const [error, setError] = useState<string | null>(discoveryError);
  const [rowFailures, setRowFailures] = useState<Record<string, string>>({});

  const selectable = candidates.filter(
    (candidate) => candidate.state !== "already_connected",
  );

  const summary = useMemo(() => {
    let selected = 0;
    let matched = 0;
    let created = 0;

    for (const candidate of selectable) {
      const row = rows[candidate.profile.externalProfileId];
      if (!row?.selected) continue;
      selected += 1;
      if (row.choice.kind === "existing") matched += 1;
      if (row.choice.kind === "create") created += 1;
    }

    return { selected, matched, created };
  }, [rows, selectable]);

  function setRow(externalProfileId: string, update: Partial<RowState>) {
    setRows((current) => {
      const existing = current[externalProfileId];
      if (!existing) return current;
      return { ...current, [externalProfileId]: { ...existing, ...update } };
    });
  }

  function refresh() {
    if (!accountId || refreshing) return;
    setRefreshing(true);
    setError(null);

    startTransition(async () => {
      const result = await discoverGoogleLocationsAction({
        connectionId,
        externalAccountId: accountId,
      });
      setRefreshing(false);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setCandidates(result.data);
      // Selections are rebuilt rather than merged. A listing that disappeared
      // between renders must not leave a selection behind pointing at it, and a
      // new one must not arrive pre-selected.
      setRows(
        Object.fromEntries(
          result.data.map((candidate) => [
            candidate.profile.externalProfileId,
            initialRowState(candidate, organizationTimezone),
          ]),
        ),
      );
    });
  }

  function save() {
    if (pending || !accountId) return;
    setError(null);
    setRowFailures({});

    // Typed explicitly rather than inferred. `flatMap` widens the two branches
    // into a union of arrays, which does not satisfy the action's own schema —
    // and the shape submitted here has to match `mappingDecisionSchema`
    // exactly, because the server parses it before it does anything else.
    const decisions = selectable.flatMap((candidate): MappingDecisionInput[] => {
      const row = rows[candidate.profile.externalProfileId];
      if (!row?.selected) return [];

      if (row.choice.kind === "existing") {
        return [
          {
            action: "map_existing" as const,
            externalProfileId: candidate.profile.externalProfileId,
            locationId: row.choice.locationId,
          },
        ];
      }

      if (row.choice.kind === "create") {
        return [
          {
            action: "create_location" as const,
            externalProfileId: candidate.profile.externalProfileId,
            name: row.choice.name.trim() || candidate.profile.displayName,
            timezone: organizationTimezone,
          },
        ];
      }

      return [];
    });

    if (decisions.length === 0) {
      setError("Select at least one location for Lia to monitor, or skip this step.");
      return;
    }

    startTransition(async () => {
      const result = await saveOnboardingLocationsAction({
        connectionId,
        externalAccountId: accountId,
        decisions,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      if (result.data.failures.length > 0) {
        setRowFailures(
          Object.fromEntries(
            result.data.failures.map((failure) => [
              failure.externalProfileId,
              failure.message,
            ]),
          ),
        );
      }

      // Null means nothing mapped: every row failed, so the step is not
      // complete and the screen stays put with the reasons shown per row.
      if (result.data.nextPath === null) {
        setError(
          "None of the selected locations could be saved. Check the messages below and try again.",
        );
        return;
      }

      router.push(result.data.nextPath);
    });
  }

  function skip() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await skipOnboardingLocationsAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(result.data.nextPath);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <OnboardingCard className="flex flex-col gap-6">
        <OnboardingStepHeader
          icon={Store}
          title="Select locations"
          description="Choose the Google Business Profile locations you want Lia to monitor."
        />

        {/* The connected account, so somebody can confirm they authorised the
            right one before mapping anything to it. */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-site-border bg-white px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <GoogleGlyph />
            <div className="min-w-0">
              <p className="truncate text-[14px] font-bold text-site-ink">
                {accountName ?? "Google Business Profile"}
              </p>
              <p className="inline-flex items-center gap-1 text-[12px] font-semibold text-green-600">
                <CheckCircle2 className="size-3.5" aria-hidden />
                Connected
              </p>
            </div>
          </div>

          {/* Wraps, and the select is allowed to shrink. At 375px an account
              picker and a Refresh button do not fit on one line, and a grid or
              flex child defaults to `min-width: auto` — so without `min-w-0`
              the select refuses to narrow below its longest option and pushes
              the page into a horizontal scroll. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {accounts.length > 1 ? (
              <>
                <label htmlFor="google-account" className="sr-only">
                  Google account
                </label>
                <select
                  id="google-account"
                  value={accountId ?? ""}
                  onChange={(event) => setAccountId(event.target.value)}
                  className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-site-field bg-white px-3 text-[13.5px] text-site-ink"
                >
                  {accounts.map((account) => (
                    <option
                      key={account.externalAccountId}
                      value={account.externalAccountId}
                    >
                      {account.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <button
              type="button"
              onClick={refresh}
              disabled={refreshing || !accountId}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl px-3 py-2 text-[13.5px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint disabled:opacity-60"
            >
              <RefreshCw
                className={cn("size-4", refreshing && "animate-spin")}
                aria-hidden
              />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {error ? <OnboardingError>{error}</OnboardingError> : null}

        {candidates.length === 0 && !error ? (
          <div className="rounded-xl border border-site-border bg-site-tint px-4 py-6 text-center">
            <p className="text-[14px] font-semibold text-site-ink">
              No locations found on this Google account
            </p>
            <p className="mx-auto mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-site-body">
              The connected account does not administer any Business Profile
              locations. Try refreshing, connect a different Google account from
              the integrations screen, or skip this step and add locations by
              hand later.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1">
              <p className="mb-2 text-[13px] font-semibold text-site-body">
                {candidates.length}{" "}
                {candidates.length === 1 ? "location" : "locations"} found
              </p>

              <ul className="divide-y divide-site-border overflow-hidden rounded-xl border border-site-border">
                {candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.profile.externalProfileId}
                    candidate={candidate}
                    row={rows[candidate.profile.externalProfileId]}
                    locations={locations}
                    failure={rowFailures[candidate.profile.externalProfileId]}
                    onChange={(update) =>
                      setRow(candidate.profile.externalProfileId, update)
                    }
                  />
                ))}
              </ul>
            </div>

            <SelectionSummary {...summary} />
          </div>
        )}

        <OnboardingNote title="We'll only monitor the locations you select">
          Nothing is connected until you save, and you can add, remove, or edit
          locations anytime in your workspace settings.
        </OnboardingNote>

        <OnboardingActions
          primary={
            <PrimaryAction
              type="button"
              pending={pending && !refreshing}
              pendingLabel="Saving…"
              onClick={save}
              disabled={summary.selected === 0}
            >
              Save and continue
            </PrimaryAction>
          }
          secondary={
            <SecondaryLink href="/onboarding/connect-sources">Back</SecondaryLink>
          }
          tertiary={
            <TertiaryAction type="button" disabled={pending} onClick={skip}>
              Skip for now
            </TertiaryAction>
          }
        />
      </OnboardingCard>
    </div>
  );
}

/**
 * The live selection summary.
 *
 * Three numbers, and they are counted from the form's own state rather than
 * guessed: how many are selected, how many map onto a location that already
 * exists, and how many will create a new one. The third is the one people check
 * — creating a duplicate location for a restaurant already in Lia is the most
 * common way this screen goes wrong.
 */
function SelectionSummary({
  selected,
  matched,
  created,
}: {
  selected: number;
  matched: number;
  created: number;
}) {
  const rows = [
    { value: selected, label: "Selected", detail: "" },
    { value: matched, label: "Matched", detail: "Existing in Lia" },
    { value: created, label: "New location", detail: "Will be created in Lia" },
  ];

  return (
    <aside
      aria-label="Your selection"
      className="shrink-0 rounded-xl border border-site-border bg-site-tint p-4 xl:w-56"
    >
      <p className="text-[13px] font-bold text-site-ink">Your selection</p>
      <ul className="mt-3 flex flex-row gap-4 xl:flex-col xl:gap-3">
        {rows.map((row) => (
          <li key={row.label} className="flex items-start gap-2.5">
            <Circle
              className="mt-1 size-4 shrink-0 text-site-blue"
              strokeWidth={2.4}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block text-[18px] leading-none font-bold text-site-ink">
                {row.value}
              </span>
              <span className="block text-[12px] font-semibold text-site-body">
                {row.label}
              </span>
              {row.detail ? (
                <span className="block text-[11px] text-site-muted">{row.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * One Google listing.
 *
 * The mapping control is a `<select>` whose default is "Create in Lia". A
 * suggested match appears as an option labelled as a suggestion — it is never
 * the selected value, which is the rule this whole screen exists to hold.
 */
function CandidateRow({
  candidate,
  row,
  locations,
  failure,
  onChange,
}: {
  candidate: LocationCandidate;
  row: RowState | undefined;
  locations: readonly LiaLocationOption[];
  failure?: string;
  onChange: (update: Partial<RowState>) => void;
}) {
  const { profile } = candidate;
  const id = `candidate-${profile.externalProfileId}`;
  const settled = candidate.state === "already_connected";
  const unavailable = candidate.state === "unavailable";

  const address = [
    profile.address?.addressLine1,
    profile.address?.city,
    profile.address?.region,
    profile.address?.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

  const choiceValue =
    row?.choice.kind === "existing" ? row.choice.locationId : "__create__";

  return (
    <li className="flex flex-col gap-3 bg-white p-4 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {settled || unavailable ? (
          // Not a control. An already-connected listing has nothing to decide,
          // and a disabled checkbox would still be reachable by keyboard.
          <Lock
            className="mt-1 size-4 shrink-0 text-site-muted"
            strokeWidth={2}
            aria-hidden
          />
        ) : (
          <input
            id={id}
            type="checkbox"
            checked={row?.selected ?? false}
            onChange={(event) => onChange({ selected: event.target.checked })}
            className="mt-1 size-[18px] shrink-0 accent-[color:var(--color-site-blue)]"
          />
        )}

        <div className="min-w-0">
          <label
            htmlFor={settled || unavailable ? undefined : id}
            className="block text-[14px] font-semibold text-site-ink"
          >
            {profile.displayName}
          </label>
          {address ? (
            <p className="text-[12.5px] text-site-body">{address}</p>
          ) : null}

          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] font-semibold">
            {profile.verificationState ? (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-600">
                {profile.verificationState}
              </span>
            ) : null}

            {settled ? (
              <span className="text-site-muted">
                Already connected — monitored by Lia
              </span>
            ) : unavailable ? (
              <span className="text-site-muted">
                Unavailable — this listing was disconnected
              </span>
            ) : null}
          </p>

          {failure ? (
            <p role="alert" className="mt-1.5 text-[12px] font-medium text-red-600">
              {failure}
            </p>
          ) : null}
        </div>
      </div>

      {settled || unavailable ? null : (
        <div className="min-w-0 sm:w-64">
          <label htmlFor={`${id}-mapping`} className="sr-only">
            Lia mapping for {profile.displayName}
          </label>
          <select
            id={`${id}-mapping`}
            value={choiceValue}
            disabled={!row?.selected}
            onChange={(event) => {
              const value = event.target.value;
              onChange({
                choice:
                  value === "__create__"
                    ? { kind: "create", name: profile.displayName }
                    : { kind: "existing", locationId: value },
              });
            }}
            className="min-h-[44px] w-full rounded-xl border border-site-field bg-white px-3 text-[13.5px] text-site-ink disabled:bg-site-tint disabled:text-site-muted"
          >
            <option value="__create__">Create in Lia — new location</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {candidate.suggestion?.locationId === location.id
                  ? `${location.name} (suggested match)`
                  : location.name}
                {location.city ? ` — ${location.city}` : ""}
              </option>
            ))}
          </select>

          {candidate.suggestion ? (
            <p className="mt-1 text-[11.5px] text-site-muted">
              Lia thinks this may be{" "}
              {locations.find(
                (location) => location.id === candidate.suggestion?.locationId,
              )?.name ?? "an existing location"}
              . Choose it above to confirm — nothing is matched automatically.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
