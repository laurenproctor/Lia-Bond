import { describe, expect, it } from "vitest";
import {
  filterLocations,
  matchesLocationSearch,
  parseLocationSearchParam,
  parseLocationStatusParam,
} from "@/lib/locations/search-params";
import type { Location } from "@/domain";

/**
 * The locations list's filters.
 *
 * These live in their own pure module precisely so they can be tested: the page
 * component that composes them is a server component and is not reachable from
 * this repo's node-environment suite. What is asserted here is therefore the
 * whole of the filtering behaviour, and the page's only remaining job is to pass
 * the parsed values through — which the browser pass covers.
 */

function locationOf(overrides: Partial<Location>): Location {
  return {
    id: "loc-1",
    organizationId: "org-1",
    name: "Union Square Cafe",
    slug: "union-square-cafe",
    addressLine1: "101 E 19th St",
    addressLine2: null,
    city: "New York",
    region: "NY",
    postalCode: "10003",
    countryCode: "US",
    timezone: "America/New_York",
    status: "active",
    managerUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseLocationStatusParam", () => {
  it("accepts every real status", () => {
    for (const status of ["setup", "active", "review", "inactive"] as const) {
      expect(parseLocationStatusParam(status)).toEqual(status);
    }
  });

  it("falls back to all for anything else", () => {
    // The URL is untrusted input. A value that is not a status must widen to
    // everything rather than matching nothing — an empty table would read as an
    // empty portfolio, which is a lie about the data.
    expect(parseLocationStatusParam("ACTIVE")).toEqual("all");
    expect(parseLocationStatusParam("archived")).toEqual("all");
    expect(parseLocationStatusParam("")).toEqual("all");
    expect(parseLocationStatusParam(undefined)).toEqual("all");
    expect(parseLocationStatusParam("'; drop table locations; --")).toEqual("all");
  });
});

describe("parseLocationSearchParam", () => {
  it("trims and survives absence", () => {
    expect(parseLocationSearchParam("  soho ")).toEqual("soho");
    expect(parseLocationSearchParam(undefined)).toEqual("");
    expect(parseLocationSearchParam("")).toEqual("");
  });

  it("caps a pathological query", () => {
    const long = "a".repeat(500);
    expect(parseLocationSearchParam(long).length).toEqual(120);
  });
});

describe("matchesLocationSearch", () => {
  const location = locationOf({});

  it("matches name, city, and region, case-insensitively", () => {
    expect(matchesLocationSearch(location, "union")).toBe(true);
    expect(matchesLocationSearch(location, "UNION")).toBe(true);
    expect(matchesLocationSearch(location, "new york")).toBe(true);
    expect(matchesLocationSearch(location, "ny")).toBe(true);
  });

  it("matches a substring, not just a prefix", () => {
    // "square" must find "Union Square Cafe" — a word-prefix matcher would not.
    expect(matchesLocationSearch(location, "square")).toBe(true);
  });

  it("does not match the slug", () => {
    // Somebody typing "soho" means the neighbourhood. Matching the URL fragment
    // as well would only ever add rows they did not ask for, in a way they
    // cannot see from the table.
    const soho = locationOf({ name: "Downtown", city: "Boston", slug: "soho" });
    expect(matchesLocationSearch(soho, "soho")).toBe(false);
  });

  it("matches everything on an empty query", () => {
    expect(matchesLocationSearch(location, "")).toBe(true);
    expect(matchesLocationSearch(location, "   ")).toBe(true);
  });

  it("does not match an unrelated term", () => {
    expect(matchesLocationSearch(location, "brooklyn")).toBe(false);
  });
});

describe("filterLocations — the row set the table receives", () => {
  const rows = [
    { location: locationOf({ id: "a", name: "SoHo", city: "New York", status: "active" }) },
    { location: locationOf({ id: "b", name: "Tribeca", city: "New York", status: "inactive" }) },
    {
      location: locationOf({
        id: "c",
        name: "Harbourside",
        city: "Boston",
        region: "MA",
        status: "setup",
      }),
    },
    { location: locationOf({ id: "d", name: "West Village", city: "New York", status: "active" }) },
  ];

  const ids = (result: typeof rows) => result.map((row) => row.location.id);

  it("returns everything when nothing is filtered", () => {
    expect(ids(filterLocations(rows, { query: "", status: "all" }))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("filters by status alone", () => {
    expect(ids(filterLocations(rows, { query: "", status: "active" }))).toEqual(["a", "d"]);
    expect(ids(filterLocations(rows, { query: "", status: "inactive" }))).toEqual(["b"]);
  });

  it("filters by search alone", () => {
    expect(ids(filterLocations(rows, { query: "new york", status: "all" }))).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("applies both together", () => {
    // Not the union: "New York" has three, "active" has two, and only two are
    // both. A filter that widened here would be worse than one that did nothing.
    expect(ids(filterLocations(rows, { query: "new york", status: "active" }))).toEqual([
      "a",
      "d",
    ]);
  });

  it("can produce an empty set, which the page renders differently from no locations", () => {
    // The distinction matters on screen: "no locations match" offers a way to
    // clear the filter, "no locations yet" offers a way to add one.
    expect(filterLocations(rows, { query: "nowhere", status: "all" })).toEqual([]);
    expect(filterLocations(rows, { query: "", status: "review" })).toEqual([]);
  });
});
