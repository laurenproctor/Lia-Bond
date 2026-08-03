import { describe, expect, it } from "vitest";
import type { Location } from "@/domain";
import type { ExternalProfile } from "@/integrations/connector";
import {
  nameSimilarity,
  normalizeName,
  normalizePostalCode,
  normalizeStreet,
  scoreCandidate,
  suggestLocation,
} from "@/lib/integrations/matching";

/**
 * Suggesting which Lia location a Google listing probably is.
 *
 * The property under test is restraint. A wrong mapping routes one
 * restaurant's complaints into another's queue, where somebody answers them in
 * good faith about a meal that was never served there — invisible until it is
 * public. So the assertions that matter most are the ones proving a weak signal
 * produces no suggestion at all.
 */

function location(overrides: Partial<Location> = {}): Location {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    name: "SoHo",
    slug: "soho",
    addressLine1: "118 Prince Street",
    addressLine2: null,
    city: "New York",
    region: "NY",
    postalCode: "10012",
    countryCode: "US",
    timezone: "America/New_York",
    status: "active",
    managerUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function profile(overrides: Partial<ExternalProfile> = {}): ExternalProfile {
  return {
    externalProfileId: "locations/1",
    externalAccountId: "accounts/1",
    displayName: "SoHo",
    ...overrides,
  };
}

describe("normalisation", () => {
  it("folds the differences two systems introduce into one name", () => {
    expect(normalizeName("Maison Laurent — Brooklyn Hts.")).toBe(
      "maison laurent brooklyn hts",
    );
    expect(normalizeName("Harbor & Vine")).toBe("harbor and vine");
    expect(normalizeName("CAFÉ  Böhme")).toBe(normalizeName("cafe bohme"));
  });

  it("folds street-suffix abbreviations nobody is consistent about", () => {
    expect(normalizeStreet("118 Prince St")).toBe(normalizeStreet("118 Prince Street"));
    expect(normalizeStreet("20 Hudson Blvd")).toBe(
      normalizeStreet("20 Hudson Boulevard"),
    );
    expect(normalizeStreet("1 Main Ave.")).toBe(normalizeStreet("1 Main Avenue"));
  });

  it("does not fold different streets together", () => {
    expect(normalizeStreet("118 Prince Street")).not.toBe(
      normalizeStreet("119 Prince Street"),
    );
  });

  it("compares postal codes on their significant part", () => {
    expect(normalizePostalCode("10012-1234")).toBe("10012");
    expect(normalizePostalCode("10012")).toBe("10012");
  });
});

describe("name similarity", () => {
  it("scores a shared prefix highly", () => {
    // Token overlap, not edit distance: "Maison Laurent" against "Maison
    // Laurent West Village" is near-total overlap and a large edit distance.
    expect(nameSimilarity("Maison Laurent", "Maison Laurent West Village")).toBe(1);
  });

  it("scores unrelated names at zero", () => {
    expect(nameSimilarity("Maison Laurent", "Harbor House")).toBe(0);
  });

  it("handles an empty name without dividing by zero", () => {
    expect(nameSimilarity("", "SoHo")).toBe(0);
  });
});

describe("scoring", () => {
  it("never suggests on a name match alone", () => {
    // A restaurant group's sites all share a name. This is exactly the case
    // that would misroute reviews, so it is capped below the threshold.
    const result = scoreCandidate(
      profile({ displayName: "SoHo" }),
      location({ name: "SoHo", addressLine1: "999 Other Street", city: "Boston", postalCode: "02108" }),
    );

    expect(result).toBeNull();
  });

  it("never suggests on a street match alone", () => {
    const result = scoreCandidate(
      profile({
        displayName: "Completely Different",
        address: { addressLine1: "118 Prince Street" },
      }),
      location(),
    );

    expect(result).toBeNull();
  });

  it("suggests when name and address agree", () => {
    const result = scoreCandidate(
      profile({
        displayName: "SoHo",
        address: {
          addressLine1: "118 Prince St",
          city: "New York",
          postalCode: "10012",
        },
      }),
      location(),
    );

    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.7);
  });

  it("explains itself in terms a person can check", () => {
    const result = scoreCandidate(
      profile({
        displayName: "SoHo",
        address: { addressLine1: "118 Prince St", city: "New York", postalCode: "10012" },
      }),
      location(),
    );

    expect(result!.reasons).toContain("Name matches exactly");
    expect(result!.reasons).toContain("Street address matches");
    expect(result!.reasons).toContain("Postal code matches");
  });

  it("gives no suggestion for a listing with no address", () => {
    expect(scoreCandidate(profile({ displayName: "Catering" }), location())).toBeNull();
  });
});

describe("choosing a suggestion", () => {
  const soho = location({ id: "aaaaaaaa-1111-4111-8111-111111111111", name: "SoHo" });
  const tribeca = location({
    id: "bbbbbbbb-1111-4111-8111-111111111111",
    name: "Tribeca",
    addressLine1: "205 Hudson Street",
    postalCode: "10013",
  });

  it("returns the strongest match", () => {
    const suggestion = suggestLocation(
      profile({
        displayName: "SoHo",
        address: { addressLine1: "118 Prince Street", city: "New York", postalCode: "10012" },
      }),
      [soho, tribeca],
    );

    expect(suggestion?.locationId).toBe(soho.id);
  });

  it("returns nothing when two locations score almost the same", () => {
    // Usually a group with several nearby sites. Showing either would be a coin
    // toss dressed up as a recommendation.
    const twinA = location({ id: "cccccccc-1111-4111-8111-111111111111", name: "Maison Laurent" });
    const twinB = location({
      id: "dddddddd-1111-4111-8111-111111111111",
      name: "Maison Laurent",
      addressLine1: "118 Prince Street",
    });

    const suggestion = suggestLocation(
      profile({
        displayName: "Maison Laurent",
        address: { addressLine1: "118 Prince Street", city: "New York", postalCode: "10012" },
      }),
      [twinA, twinB],
    );

    expect(suggestion).toBeNull();
  });

  it("never proposes a location that is already mapped", () => {
    // Proposing one the user cannot accept is worse than proposing nothing.
    const suggestion = suggestLocation(
      profile({
        displayName: "SoHo",
        address: { addressLine1: "118 Prince Street", city: "New York", postalCode: "10012" },
      }),
      [soho, tribeca],
      new Set([soho.id]),
    );

    expect(suggestion).toBeNull();
  });

  it("returns nothing when there are no locations at all", () => {
    expect(suggestLocation(profile(), [])).toBeNull();
  });

  it("returns a proposal, not a mapping", () => {
    // The shape is the guarantee: a suggestion carries a target and evidence,
    // and has no way of expressing "applied".
    const suggestion = suggestLocation(
      profile({
        displayName: "SoHo",
        address: { addressLine1: "118 Prince Street", city: "New York", postalCode: "10012" },
      }),
      [soho],
    );

    expect(Object.keys(suggestion ?? {}).sort()).toEqual([
      "locationId",
      "reasons",
      "score",
    ]);
  });
});
