"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FilterBar } from "@/components/ui/filter-bar";
import { SearchInput } from "@/components/ui/search-input";
import { SelectFilter } from "@/components/ui/select-filter";
import { LOCATION_STATUSES } from "@/domain";
import { LOCATION_STATUS_LABELS } from "@/lib/labels";
import type { LocationStatusFilter } from "@/lib/locations/search-params";

/**
 * Search and status filtering for the locations list, backed by the URL.
 *
 * `?q=` and `?status=` rather than component state, matching `RuleStatusTabs`:
 * the filtered view is then shareable, survives a refresh, and — because the
 * filtering happens on the server over rows it already has — needs no client
 * copy of the location list.
 *
 * `router.replace(..., { scroll: false })` rather than `push`: a filter is not a
 * place, so it should not fill the back button with one entry per keystroke, and
 * the page should not jump to the top while somebody is typing.
 */
export function LocationFilters({
  query,
  status,
}: {
  query: string;
  status: LocationStatusFilter;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(query);
  const [syncedQuery, setSyncedQuery] = useState(query);

  // Adjusting state when a prop changes, during render rather than in an
  // effect.
  //
  // The box has to follow the URL, or "Clear filters" leaves the old text
  // sitting there and the debounce below immediately navigates back to it. The
  // obvious way to write that — `useEffect(() => setDraft(query), [query])` —
  // is a cascading render and is what React's own guidance (and this repo's
  // lint rule) refuses: an effect is for synchronising with something *outside*
  // React, and a prop is not outside React. Comparing during render is the
  // documented alternative; it re-renders before committing anything, so the
  // stale value is never painted.
  if (query !== syncedQuery) {
    setSyncedQuery(query);
    setDraft(query);
  }

  // Debounced, because a navigation per keystroke is a request per keystroke.
  // 300ms is the same order as the postal-lookup hook's settling window; the
  // cleanup is what makes it a debounce rather than a queue of stale writes.
  useEffect(() => {
    if (draft === query) return;

    const timer = setTimeout(() => {
      router.replace(hrefFor(draft, status), { scroll: false });
    }, 300);

    return () => clearTimeout(timer);
  }, [draft, query, status, router]);

  return (
    <FilterBar label="Location filters">
      <SearchInput
        label="Search locations"
        placeholder="Search locations…"
        // Controlled, so clearing the filter clears the box.
        value={draft}
        onChange={setDraft}
        className="w-full max-w-64"
      />
      <SelectFilter
        label="Status"
        defaultValue={status}
        onChange={(next) => {
          // Not debounced: a select is one deliberate choice, not a stream.
          router.replace(hrefFor(draft, next as LocationStatusFilter), {
            scroll: false,
          });
        }}
        options={[
          { value: "all", label: "All statuses" },
          ...LOCATION_STATUSES.map((value) => ({
            value,
            label: LOCATION_STATUS_LABELS[value],
          })),
        ]}
      />
    </FilterBar>
  );
}

/**
 * The URL for a filter combination.
 *
 * A param at its default is dropped rather than written as an empty value, so
 * the unfiltered view is `/locations` and not `/locations?q=&status=all` — the
 * URL somebody might copy should be the short one.
 */
function hrefFor(query: string, status: LocationStatusFilter): string {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed !== "") params.set("q", trimmed);
  if (status !== "all") params.set("status", status);

  const search = params.toString();
  return search === "" ? "/locations" : `/locations?${search}`;
}
