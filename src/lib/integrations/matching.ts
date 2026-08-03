import type { Location } from "@/domain";
import type { ExternalProfile } from "@/integrations/connector";

/**
 * Suggesting which Lia location a Google listing probably is.
 *
 * This module only ever *suggests*. Nothing here auto-applies a mapping, and
 * the reason is concrete: a restaurant group runs several sites with nearly
 * identical names, and a wrong mapping silently routes one restaurant's reviews
 * into another's queue. The manager who then replies is apologising to the wrong
 * customer about the wrong meal. That failure is invisible until it is
 * embarrassing, so every suggestion carries its evidence and waits for a person.
 *
 * Pure functions, no I/O — the scoring is unit-testable without a database.
 */

export interface MatchSuggestion {
  locationId: string;
  /** 0–1. Higher is a stronger match, never a licence to skip confirmation. */
  score: number;
  /** Why this was suggested, in words a person can check against the row. */
  reasons: string[];
}

/** Strong enough to put in front of someone. Below this, no suggestion is made. */
const SUGGESTION_THRESHOLD = 0.45;

/**
 * Strip everything a restaurant name varies by.
 *
 * "Maison Laurent — Brooklyn Hts." and "Maison Laurent Brooklyn Heights" are the
 * same restaurant written by two different systems. Punctuation, casing,
 * accents, and the handful of words that appear in every hospitality name are
 * all noise for comparison purposes.
 */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizePostalCode(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 5);
}

/**
 * Street-address comparison, reduced to the part that identifies a building.
 *
 * "118 Prince Street" and "118 Prince St" differ only in an abbreviation nobody
 * is consistent about, so the common suffixes are folded together.
 */
const STREET_SUFFIXES: Record<string, string> = {
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  rd: "road",
  blvd: "boulevard",
  dr: "drive",
  ln: "lane",
  pl: "place",
  sq: "square",
  hwy: "highway",
  pkwy: "parkway",
  ct: "court",
  ter: "terrace",
};

export function normalizeStreet(value: string): string {
  return normalizeName(value)
    .split(" ")
    .map((word) => STREET_SUFFIXES[word] ?? word)
    .join(" ");
}

/**
 * Token overlap, as a fraction of the smaller name.
 *
 * Chosen over an edit distance on purpose: "Maison Laurent" versus "Maison
 * Laurent West Village" is a near-total token overlap but a large edit
 * distance, and the token reading is the one that matches how these names
 * actually differ.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = new Set(normalizeName(a).split(" ").filter(Boolean));
  const right = new Set(normalizeName(b).split(" ").filter(Boolean));

  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  return shared / Math.min(left.size, right.size);
}

/**
 * Score one Google listing against one Lia location.
 *
 * The weights encode how much each signal is worth as *evidence*, which is not
 * the same as how easy it is to compare. A street address is close to an
 * identifier for a restaurant, so it carries the most. A postal code narrows to
 * a few blocks in a city and is worth little alone. Names are the most
 * available signal and the least trustworthy — a group's sites all share one —
 * so they are capped below the threshold: a name match on its own can never
 * produce a suggestion.
 */
export function scoreCandidate(
  profile: ExternalProfile,
  location: Location,
): MatchSuggestion | null {
  const reasons: string[] = [];
  let score = 0;

  const similarity = nameSimilarity(profile.displayName, location.name);
  if (similarity >= 0.99) {
    score += 0.4;
    reasons.push("Name matches exactly");
  } else if (similarity >= 0.6) {
    score += 0.25;
    reasons.push("Name is similar");
  }

  // Phone number is deliberately not scored. It is the strongest signal
  // available — two restaurants rarely share a line — but `locations` has no
  // phone column, so there is nothing to compare Google's number against.
  // Scoring it would mean comparing it to something else and pretending; when a
  // migration adds the column, this is the first weight to introduce, above
  // street address.

  const street = profile.address?.addressLine1;
  if (street && normalizeStreet(street) === normalizeStreet(location.addressLine1)) {
    score += 0.35;
    reasons.push("Street address matches");
  }

  const postal = profile.address?.postalCode;
  if (postal && normalizePostalCode(postal) === normalizePostalCode(location.postalCode)) {
    score += 0.15;
    reasons.push("Postal code matches");
  }

  const city = profile.address?.city;
  if (city && normalizeName(city) === normalizeName(location.city)) {
    score += 0.1;
    reasons.push("City matches");
  }

  if (score < SUGGESTION_THRESHOLD) return null;

  return { locationId: location.id, score: Math.min(score, 1), reasons };
}

/**
 * The best suggestion for a listing, if there is one worth showing.
 *
 * Returns at most one. Offering a ranked list would invite someone to skim and
 * pick the top row, which is the behaviour this whole module is arranged to
 * prevent — a single suggestion with its evidence beside it is a claim the user
 * can check, not a menu.
 */
export function suggestLocation(
  profile: ExternalProfile,
  locations: Location[],
  alreadyMappedLocationIds: ReadonlySet<string> = new Set(),
): MatchSuggestion | null {
  const candidates = locations
    .filter((location) => !alreadyMappedLocationIds.has(location.id))
    .flatMap((location) => {
      const suggestion = scoreCandidate(profile, location);
      return suggestion ? [suggestion] : [];
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) return null;

  // Two locations scoring almost identically means the signals did not actually
  // separate them — usually a group with several nearby sites. Showing either
  // one would be a coin toss dressed up as a recommendation.
  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < 0.1) return null;

  return best;
}
