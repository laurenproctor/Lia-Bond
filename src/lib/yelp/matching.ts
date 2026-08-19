import type { Location } from "@/domain";
import {
  nameSimilarity,
  normalizeName,
  normalizePostalCode,
  normalizeStreet,
} from "@/lib/integrations/matching";
import type { YelpBusinessCandidate } from "@/yelp/places";

/**
 * Ranking Yelp candidates against the Lia location being connected.
 *
 * Reuses the normalisers from `src/lib/integrations/matching.ts` rather than
 * writing a second set: "118 Prince St" and "118 Prince Street" differ the same
 * way whichever provider returned them, and two copies of that knowledge would
 * drift.
 *
 * The shape differs from `suggestLocation` in one deliberate way. That function
 * returns **at most one** suggestion and refuses when two candidates score
 * close together, because there the user is confirming which Lia location a
 * Google listing belongs to and a ranked menu invites skimming. Here the user
 * is choosing among *external businesses they may never have seen in Lia*, and
 * withholding the list would leave them with nothing to choose from. So this
 * ranks and returns everything, and the confirmation step carries the weight —
 * every candidate is shown with its address and phone number, and nothing is
 * ever auto-applied.
 */

export interface YelpCandidateMatch {
  candidate: YelpBusinessCandidate;
  /** 0–1. Higher is a stronger match, never a licence to skip confirmation. */
  score: number;
  /** Why it scored, in words a person can check against the row in front of them. */
  reasons: string[];
  /**
   * Nothing distinguished this from the next candidate.
   *
   * Set when the runner-up scores within `AMBIGUITY_MARGIN`. The UI uses it to
   * warn rather than to hide: a restaurant group's two nearby branches are
   * exactly this case, and the person choosing is the only one who can tell
   * them apart.
   */
  ambiguous: boolean;
}

/** Two candidates this close have not actually been separated by the signals. */
const AMBIGUITY_MARGIN = 0.1;

/**
 * Digits only, last ten.
 *
 * Yelp returns E.164 (`+15555550101`) and a location's number, when Lia ever
 * stores one, will not be normalised at all. Comparing the last ten digits is
 * what makes `+1 (555) 555-0101` and `555-555-0101` the same number without
 * needing a phone library or a country-code table.
 */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "").slice(-10);
}

/**
 * Score one Yelp candidate against the location being connected.
 *
 * The weights encode how much each signal is worth as *evidence*, and they are
 * not the same as `scoreCandidate`'s for Google — because Yelp returns a phone
 * number and Google's connector had none to compare.
 *
 * A phone number is close to an identifier for a restaurant: two venues rarely
 * share a line, and a group's branches never do. So where it matches, it
 * carries more than the street address. Where it is absent on either side it
 * simply scores nothing, rather than penalising a listing Yelp happened not to
 * publish a number for.
 *
 * The name is capped below the suggestion threshold on its own, for the reason
 * `scoreCandidate` states: every site in a restaurant group shares one.
 */
export function scoreYelpCandidate(
  candidate: YelpBusinessCandidate,
  location: Location,
  /** The location's phone number, when the product ever records one. */
  locationPhone: string | null = null,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const similarity = nameSimilarity(candidate.name, location.name);
  if (similarity >= 0.99) {
    score += 0.3;
    reasons.push("Name matches exactly");
  } else if (similarity >= 0.6) {
    score += 0.18;
    reasons.push("Name is similar");
  }

  // The strongest available signal, and the one Google's matcher could not use.
  // `locations` still has no phone column — see the note in
  // `src/lib/integrations/matching.ts` — so this scores only when a caller can
  // supply one. It is wired now rather than later because the weight is the
  // part that needs deciding, and deciding it against a real provider response
  // is better than guessing at it during a future migration.
  if (locationPhone && candidate.phone) {
    const left = normalizePhone(locationPhone);
    const right = normalizePhone(candidate.phone);
    if (left.length === 10 && left === right) {
      score += 0.4;
      reasons.push("Phone number matches");
    }
  }

  const street = candidate.addressLines[0];
  if (street && normalizeStreet(street) === normalizeStreet(location.addressLine1)) {
    score += 0.3;
    reasons.push("Street address matches");
  }

  if (
    candidate.postalCode &&
    normalizePostalCode(candidate.postalCode) === normalizePostalCode(location.postalCode)
  ) {
    score += 0.12;
    reasons.push("Postal code matches");
  }

  if (candidate.city && normalizeName(candidate.city) === normalizeName(location.city)) {
    score += 0.08;
    reasons.push("City matches");
  }

  // Not a match signal — a demotion. A permanently closed listing is almost
  // never the one a working restaurant wants connected, and it is a common
  // duplicate. Ranked last rather than hidden, because occasionally it *is*
  // the right listing and hiding it would leave somebody unable to connect
  // anything.
  if (candidate.isClosed) {
    score = Math.max(0, score - 0.5);
    reasons.push("Yelp reports this listing as closed");
  }

  return { score: Math.min(score, 1), reasons };
}

/**
 * Every candidate, ranked, with the ambiguous ones flagged.
 *
 * Returns them all rather than filtering by a threshold: a customer whose
 * restaurant scores badly — a renamed venue, an address Yelp records
 * differently — still has to be able to find and connect it, and an empty list
 * would read as "your restaurant is not on Yelp" when it plainly is.
 */
export function rankYelpCandidates(
  candidates: readonly YelpBusinessCandidate[],
  location: Location,
  locationPhone: string | null = null,
): YelpCandidateMatch[] {
  const scored = candidates
    .map((candidate) => {
      const { score, reasons } = scoreYelpCandidate(candidate, location, locationPhone);
      return { candidate, score, reasons, ambiguous: false };
    })
    .sort((a, b) => b.score - a.score);

  // Flag each candidate that its neighbour did not separate itself from. Done
  // pairwise rather than only for the top two, because three near-identical
  // branches is a real shape and only warning about the first pair would imply
  // the third was distinguishable.
  for (let index = 0; index < scored.length; index += 1) {
    const current = scored[index];
    const next = scored[index + 1];
    if (!current || !next) continue;
    if (Math.abs(current.score - next.score) < AMBIGUITY_MARGIN) {
      current.ambiguous = true;
      next.ambiguous = true;
    }
  }

  return scored;
}
