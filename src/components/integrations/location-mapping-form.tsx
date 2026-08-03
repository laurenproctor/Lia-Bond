"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  MapPin,
  RefreshCw,
} from "lucide-react";
import {
  discoverGoogleLocationsAction,
  saveGoogleMappingsAction,
} from "@/app/actions/integrations";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import type { ExternalAccount } from "@/integrations/connector";
import type { LocationCandidate } from "@/lib/integrations/google-service";
import type { MappingDecision } from "@/lib/integrations/google-mapping";
import { CandidateRow } from "@/components/integrations/candidate-row";
import type {
  LiaLocationOption,
  RowChoice,
} from "@/components/integrations/mapping-types";

/**
 * Choosing which Google locations Lia monitors, and which restaurant each one is.
 *
 * The screen's whole job is to make one thing impossible: a mapping applied
 * without somebody deciding it. Suggestions appear with their evidence and a
 * separate Use button; nothing is pre-selected, nothing auto-confirms, and a
 * row with no decision saves nothing.
 *
 * A client component because the choices are interdependent — picking a Lia
 * location in one row removes it from the others — and a server round trip per
 * checkbox would make a twelve-location group unusable.
 */

export interface LocationMappingFormProps {
  connectionId: string;
  accounts: ExternalAccount[];
  initialAccountId: string | null;
  initialCandidates: LocationCandidate[];
  locations: LiaLocationOption[];
  organizationTimezone: string;
  /** A discovery failure from the server render, shown instead of an empty list. */
  discoveryError: string | null;
}

export function LocationMappingForm({
  connectionId,
  accounts,
  initialAccountId,
  initialCandidates,
  locations,
  organizationTimezone,
  discoveryError,
}: LocationMappingFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [accountId, setAccountId] = useState(initialAccountId);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [error, setError] = useState<string | null>(discoveryError);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, RowChoice>>({});

  const choiceFor = (id: string): RowChoice => choices[id] ?? { kind: "none" };

  function setChoice(id: string, choice: RowChoice) {
    setChoices((current) => ({ ...current, [id]: choice }));
  }

  /**
   * Lia locations already spoken for.
   *
   * Includes both mappings that exist and ones chosen elsewhere in this form,
   * because a collision the user cannot see until they press Save is a worse
   * error than one they cannot create in the first place.
   */
  const claimedLocationIds = useMemo(() => {
    const claimed = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.mappedLocationId) claimed.add(candidate.mappedLocationId);
    }
    for (const choice of Object.values(choices)) {
      if (choice.kind === "existing") claimed.add(choice.locationId);
    }
    return claimed;
  }, [candidates, choices]);

  function loadAccount(nextAccountId: string) {
    setAccountId(nextAccountId);
    setError(null);
    setSummary(null);
    setRowErrors({});
    setChoices({});

    startTransition(async () => {
      const result = await discoverGoogleLocationsAction({
        connectionId,
        externalAccountId: nextAccountId,
      });

      if (!result.ok) {
        setCandidates([]);
        setError(result.error);
        return;
      }

      setCandidates(result.data);
    });
  }

  function save() {
    if (!accountId) return;
    setError(null);
    setSummary(null);
    setRowErrors({});

    const decisions: MappingDecision[] = candidates.map((candidate) => {
      const externalProfileId = candidate.profile.externalProfileId;
      const choice = choiceFor(externalProfileId);

      if (choice.kind === "existing") {
        return {
          action: "map_existing",
          externalProfileId,
          locationId: choice.locationId,
        };
      }

      if (choice.kind === "create") {
        return {
          action: "create_location",
          externalProfileId,
          name: choice.name.trim() || candidate.profile.displayName,
          timezone: organizationTimezone,
        };
      }

      // Undecided rows are submitted as explicit skips rather than omitted, so
      // the result can report exactly what was left alone.
      return { action: "skip", externalProfileId };
    });

    const actionable = decisions.filter((decision) => decision.action !== "skip");
    if (actionable.length === 0) {
      setError("Choose a Lia location for at least one Google location, or go back.");
      return;
    }

    startTransition(async () => {
      const result = await saveGoogleMappingsAction({
        connectionId,
        externalAccountId: accountId,
        decisions,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      const { createdLocations, mappedProfiles, skipped, failures } = result.data;

      setRowErrors(
        Object.fromEntries(
          failures.map((entry) => [entry.externalProfileId, entry.message]),
        ),
      );

      const parts = [
        `${mappedProfiles.length} ${mappedProfiles.length === 1 ? "location" : "locations"} connected`,
        createdLocations.length > 0
          ? `${createdLocations.length} new Lia ${createdLocations.length === 1 ? "location" : "locations"} created`
          : null,
        skipped.length > 0 ? `${skipped.length} skipped` : null,
        failures.length > 0
          ? `${failures.length} could not be saved`
          : null,
      ].filter((part): part is string => part !== null);

      setSummary(parts.join(" · "));
      setChoices({});
      router.refresh();
    });
  }

  const decidedCount = candidates.filter(
    (candidate) => choiceFor(candidate.profile.externalProfileId).kind !== "none",
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {accounts.length > 1 ? (
        <Card>
          <CardHeader
            title="Google account"
            description="This Google user administers more than one Business Profile account. Locations are listed per account."
            actions={
              accountId ? (
                <Button
                  size="sm"
                  icon={RefreshCw}
                  onClick={() => loadAccount(accountId)}
                  disabled={pending}
                >
                  Refresh
                </Button>
              ) : null
            }
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {accounts.map((account) => {
              const selected = account.externalAccountId === accountId;

              return (
                <button
                  key={account.externalAccountId}
                  type="button"
                  onClick={() => loadAccount(account.externalAccountId)}
                  disabled={pending}
                  aria-pressed={selected}
                  className={cn(
                    "rounded-lg border px-3 py-2.5 text-left transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600",
                    selected
                      ? "border-purple-600 bg-purple-100"
                      : "border-gray-200 bg-white hover:bg-gray-50",
                  )}
                >
                  <span className="block text-[13px] font-medium text-gray-950">
                    {account.name}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-gray-500">
                    {[account.accountType, account.role]
                      .filter(Boolean)
                      .map((value) => humanizeEnum(String(value)))
                      .join(" · ") || account.externalAccountId}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
          {error}
        </p>
      ) : null}

      {summary ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-green-600/20 bg-green-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <CheckCircle2 className="mt-px size-4 shrink-0 text-green-600" aria-hidden />
          {summary}
        </p>
      ) : null}

      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Google locations"
          description="Choose what each Google location is in Lia. Nothing is connected until you save."
          actions={
            <span className="text-[12.5px] text-gray-500 tabular-nums">
              {decidedCount} of {candidates.length} decided
            </span>
          }
        />

        {candidates.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title={
              pending ? "Loading locations…" : "No eligible Google locations found"
            }
            description={
              pending
                ? undefined
                : "This Google account manages no locations Lia can monitor. Try another account, or add the location in Google first."
            }
          />
        ) : (
          <ul className="divide-y divide-gray-200 border-t border-gray-200">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.profile.externalProfileId}
                candidate={candidate}
                choice={choiceFor(candidate.profile.externalProfileId)}
                onChange={(choice) =>
                  setChoice(candidate.profile.externalProfileId, choice)
                }
                locations={locations}
                claimedLocationIds={claimedLocationIds}
                error={rowErrors[candidate.profile.externalProfileId]}
                disabled={pending}
              />
            ))}
          </ul>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-gray-500">
          Locations you create here start as onboarding, not active — they have
          not been set up in Lia yet.
        </p>
        <Button
          variant="primary"
          icon={Link2}
          onClick={save}
          disabled={pending || candidates.length === 0}
        >
          {pending ? "Saving…" : "Save selected locations"}
        </Button>
      </div>
    </div>
  );
}

/** "LOCATION_GROUP" → "Location group". Google shouts its enums. */
function humanizeEnum(value: string): string {
  const spaced = value.toLowerCase().replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
