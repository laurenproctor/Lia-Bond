"use client";

import { AlertTriangle, CheckCircle2, Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { LocationCandidate } from "@/lib/integrations/google-service";
import type { LiaLocationOption, RowChoice } from "@/components/integrations/mapping-types";

/**
 * One Google location, and the decision waiting on it.
 *
 * Split out of the form so the form reads as the flow (pick an account, decide,
 * save) and this file reads as the row. The row is where the product's central
 * caution lives: a suggestion appears with its evidence beside it and a separate
 * button, and the select defaults to "Skip this location" — so a person who
 * scrolls past a row has decided nothing, rather than accepted a guess.
 */
export function CandidateRow({
  candidate,
  choice,
  onChange,
  locations,
  claimedLocationIds,
  error,
  disabled,
}: {
  candidate: LocationCandidate;
  choice: RowChoice;
  onChange: (choice: RowChoice) => void;
  locations: LiaLocationOption[];
  claimedLocationIds: ReadonlySet<string>;
  error: string | undefined;
  disabled: boolean;
}) {
  const { profile, state, suggestion } = candidate;
  const address = [
    profile.address?.addressLine1,
    profile.address?.city,
    profile.address?.region,
    profile.address?.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

  const selectId = `map-${profile.externalProfileId.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const alreadyConnected = state === "already_connected";
  const mappedLocation = locations.find(
    (location) => location.id === candidate.mappedLocationId,
  );

  return (
    <li className="flex flex-col gap-2.5 px-5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-gray-950">
            {profile.displayName}
          </p>
          <p className="mt-0.5 text-[12.5px] text-gray-500">
            {address || "No address on the Google listing"}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {profile.verificationState === "VERIFIED" ? (
            <Badge tone="green">Verified</Badge>
          ) : profile.verificationState === "UNVERIFIED" ? (
            <Badge tone="amber">Unverified on Google</Badge>
          ) : null}

          {alreadyConnected ? (
            <Badge tone="purple">Already connected</Badge>
          ) : state === "unavailable" ? (
            <Badge tone="neutral">Disconnected</Badge>
          ) : state === "mapped" ? (
            <Badge tone="blue">Connected, no location</Badge>
          ) : (
            <Badge tone="neutral">Not connected</Badge>
          )}
        </div>
      </div>

      {alreadyConnected && mappedLocation ? (
        <p className="text-[12.5px] text-gray-500">
          Currently mapped to{" "}
          <span className="font-medium text-gray-950">{mappedLocation.name}</span>.
          Choosing a different location below will move it.
        </p>
      ) : null}

      {/*
        A suggestion, never an application. The evidence is spelled out so the
        user can check the claim against the address on the left, and accepting
        it takes a deliberate click.
      */}
      {suggestion ? (
        <SuggestionRow
          suggestion={suggestion}
          locations={locations}
          accepted={
            choice.kind === "existing" && choice.locationId === suggestion.locationId
          }
          onAccept={() =>
            onChange({ kind: "existing", locationId: suggestion.locationId })
          }
          disabled={disabled}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-[12.5px] text-gray-500">
          Map to
        </label>
        <select
          id={selectId}
          value={
            choice.kind === "existing"
              ? choice.locationId
              : choice.kind === "create"
                ? "__create__"
                : ""
          }
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "") onChange({ kind: "none" });
            else if (value === "__create__")
              onChange({ kind: "create", name: profile.displayName });
            else onChange({ kind: "existing", locationId: value });
          }}
          className={cn(
            "h-8 min-w-56 rounded-lg border border-gray-300 bg-white px-2 text-[13px] text-gray-950",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600",
          )}
        >
          <option value="">Skip this location</option>
          <option value="__create__">Create a new Lia location</option>
          {locations.map((location) => {
            const taken =
              claimedLocationIds.has(location.id) &&
              !(choice.kind === "existing" && choice.locationId === location.id) &&
              candidate.mappedLocationId !== location.id;

            return (
              <option key={location.id} value={location.id} disabled={taken}>
                {location.name} — {location.city}, {location.region}
                {taken ? " (already mapped)" : ""}
              </option>
            );
          })}
        </select>

        {choice.kind === "create" ? (
          <label className="flex items-center gap-2 text-[12.5px] text-gray-500">
            <span>Name</span>
            <input
              value={choice.name}
              disabled={disabled}
              onChange={(event) =>
                onChange({ kind: "create", name: event.target.value })
              }
              className={cn(
                "h-8 w-56 rounded-lg border border-gray-300 bg-white px-2 text-[13px] text-gray-950",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600",
              )}
            />
          </label>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-[12.5px] text-red-600"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
    </li>
  );
}

function SuggestionRow({
  suggestion,
  locations,
  accepted,
  onAccept,
  disabled,
}: {
  suggestion: NonNullable<LocationCandidate["suggestion"]>;
  locations: LiaLocationOption[];
  accepted: boolean;
  onAccept: () => void;
  disabled: boolean;
}) {
  const location = locations.find((entry) => entry.id === suggestion.locationId);
  if (!location) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-2">
      <Lightbulb className="size-3.5 shrink-0 text-purple-600" aria-hidden />
      <span className="text-[12.5px] text-gray-700">
        This might be{" "}
        <span className="font-medium text-gray-950">{location.name}</span> —{" "}
        {suggestion.reasons.join(", ").toLowerCase()}.
      </span>
      {accepted ? (
        <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-green-600">
          <CheckCircle2 className="size-3.5" aria-hidden />
          Confirmed
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={onAccept} disabled={disabled}>
          Use this match
        </Button>
      )}
    </div>
  );
}
