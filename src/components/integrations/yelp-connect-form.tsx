"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import {
  connectYelpListingAction,
  searchYelpListingsAction,
} from "@/app/actions/yelp";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { YelpCandidateMatch } from "@/lib/yelp/matching";

/**
 * Finding and confirming a location's Yelp listing.
 *
 * Two properties are load-bearing, and both come from the same failure: a wrong
 * mapping routes one restaurant's review activity into another's queue, and
 * nobody notices until somebody answers the wrong customer.
 *
 * 1. **Nothing is auto-applied.** The best-scoring candidate is ranked first
 *    and nothing more — no pre-selection, no "we think this is it, press
 *    continue". A person picks.
 * 2. **Every candidate shows its evidence.** The address, the phone number, and
 *    the reasons it scored are all on the row, because that is what somebody
 *    checks against the restaurant they have in mind. A score on its own is
 *    something to trust rather than something to verify.
 *
 * Ambiguous candidates — a group's two nearby branches — are marked rather than
 * hidden. Hiding them would leave a customer unable to connect the listing they
 * can plainly see; marking them says the signals did not separate these, so
 * look closely.
 */

export interface YelpConnectFormProps {
  locations: { id: string; name: string; city: string }[];
}

export function YelpConnectForm({ locations }: YelpConnectFormProps) {
  const [pending, startTransition] = useTransition();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [term, setTerm] = useState("");
  const [matches, setMatches] = useState<YelpCandidateMatch[] | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);

  function search() {
    setError(null);
    setConnectedName(null);
    startTransition(async () => {
      const result = await searchYelpListingsAction({
        locationId,
        term: term.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        setMatches(null);
        return;
      }
      setMatches(result.data.matches);
      setUsedFallback(result.data.usedFallback);
    });
  }

  function connect(businessId: string, name: string) {
    setError(null);
    startTransition(async () => {
      const result = await connectYelpListingAction({ locationId, businessId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMatches(null);
      setConnectedName(name);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-[12.5px] font-medium text-gray-950">
          Location
          <select
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] font-normal text-gray-950"
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name} — {location.city}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[12.5px] font-medium text-gray-950">
          Business name on Yelp{" "}
          <span className="font-normal text-gray-500">(optional)</span>
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            maxLength={128}
            placeholder="Only needed if the address search finds nothing"
            className="mt-1 h-9 w-full rounded-lg border border-gray-300 px-2 text-[13px] font-normal text-gray-950"
          />
        </label>

        <Button
          variant="primary"
          icon={pending ? Loader2 : Search}
          disabled={pending || !locationId}
          onClick={search}
        >
          Search Yelp
        </Button>
      </div>

      <p className="text-[12px] text-gray-500">
        Lia searches Yelp using this location&rsquo;s saved name and address. It does
        not send anything you type here unless the address search comes back empty.
      </p>

      {connectedName ? (
        <p role="status" className="text-[12.5px] font-medium text-green-800">
          Connected {connectedName}. Lia will check its review count and rating from
          now on.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] font-medium text-red-700">
          {error}
        </p>
      ) : null}

      {matches !== null ? (
        <div className="space-y-2">
          {usedFallback ? (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] text-gray-700">
              Yelp found nothing at this location&rsquo;s exact address, so these are
              results for a wider search. Check each one carefully.
            </p>
          ) : null}

          {matches.length === 0 ? (
            <p className="text-[12.5px] text-gray-700">
              Yelp returned no businesses. Try the business name as it appears on
              Yelp, which is often not the name you use internally.
            </p>
          ) : null}

          {matches.map((match) => (
            <div
              key={match.candidate.businessId}
              className={cn(
                "rounded-xl border p-3",
                match.ambiguous ? "border-amber-300 bg-amber-50" : "border-gray-200",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-gray-950">
                    {match.candidate.name}
                    {match.candidate.isClosed ? (
                      <span className="ml-2 text-[12px] font-normal text-red-700">
                        Yelp reports this as closed
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-gray-700">
                    {match.candidate.addressLines.join(", ") || "No address on Yelp"}
                  </p>
                  {match.candidate.phone ? (
                    <p className="text-[12.5px] text-gray-700">
                      {match.candidate.phone}
                    </p>
                  ) : null}

                  {match.reasons.length > 0 ? (
                    <p className="mt-1 text-[12px] text-gray-500">
                      {match.reasons.join(" · ")}
                    </p>
                  ) : null}

                  {match.ambiguous ? (
                    <p className="mt-1 flex items-start gap-1.5 text-[12px] font-medium text-amber-900">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                      Another result scored almost the same. Check the address before
                      choosing.
                    </p>
                  ) : null}
                </div>

                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    connect(match.candidate.businessId, match.candidate.name)
                  }
                >
                  This is the one
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
