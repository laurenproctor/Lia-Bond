/**
 * URL search-param parsing for the locations list.
 *
 * The search text and the status filter live in the URL (`?q=`, `?status=`) so
 * the view is shareable and survives a refresh — the same reasoning
 * `src/lib/rules/search-params.ts` records for the rules list. And for the same
 * reason it is parsed rather than trusted: anyone can type `?status=deleted` or
 * `?status=ACTIVE`, and a value that is not an exact `LocationStatus` must fall
 * back to "all" rather than silently matching nothing and looking like an empty
 * portfolio.
 *
 * Pure, and deliberately in its own module rather than inline in the page: the
 * matching rule is the part worth testing, and a page component is not reachable
 * from this repo's node-environment test suite.
 */

import { LOCATION_STATUSES, type Location, type LocationStatus } from "@/domain";

export type LocationStatusFilter = LocationStatus | "all";

/** Longer than any real search; a cap keeps a pathological URL out of the DOM. */
const MAX_QUERY_LENGTH = 120;

export function parseLocationStatusParam(
  value: string | undefined,
): LocationStatusFilter {
  if (value && (LOCATION_STATUSES as readonly string[]).includes(value)) {
    return value as LocationStatus;
  }
  return "all";
}

export function parseLocationSearchParam(value: string | undefined): string {
  if (!value) return "";
  return value.trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * Whether a location matches free-text search.
 *
 * Name, city, and region — the three things somebody has in mind when they
 * think of a restaurant. **Not the slug**, deliberately: somebody typing "soho"
 * means the neighbourhood, and matching the URL fragment as well would only
 * ever add rows they did not ask for, in a way they cannot see. The slug is
 * visible on the location's own screen, where it can be searched for directly.
 *
 * Case-insensitive, and substring rather than word-prefix: "square" should find
 * "Union Square", which a prefix match would miss.
 */
export function matchesLocationSearch(
  location: Pick<Location, "name" | "city" | "region">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;

  return [location.name, location.city, location.region].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** Both filters, applied together. */
export function filterLocations<T extends { location: Location }>(
  rows: T[],
  filters: { query: string; status: LocationStatusFilter },
): T[] {
  return rows.filter((row) => {
    if (filters.status !== "all" && row.location.status !== filters.status) {
      return false;
    }
    return matchesLocationSearch(row.location, filters.query);
  });
}
