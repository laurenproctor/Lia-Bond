import type { ConnectorCapabilities } from "@/domain";
import { YELP_ASSISTED_CAPABILITIES } from "@/yelp/capabilities";
import { YelpError, type YelpErrorCode } from "@/yelp/errors";
import type {
  YelpBusinessCandidate,
  YelpBusinessMatchQuery,
  YelpBusinessSearchQuery,
  YelpListingMetadata,
  YelpMatchResult,
  YelpPlacesProvider,
} from "@/yelp/places";
import { canonicalYelpBusinessUrl } from "@/yelp/urls";

/**
 * A Yelp provider that never touches the network.
 *
 * Exists so the connection flow, the activity-detection service, manual
 * capture, and the assisted-posting handoff can be exercised end to end with no
 * Yelp API key — including by anyone picking this repository up for the first
 * time. Mirrors `MockNewsMonitor`'s three properties:
 *
 * - **Isolated.** Nothing outside `src/yelp/registry.ts` knows this exists.
 * - **Deterministic.** No `Math.random()`, no `Date.now()`, no bare `new
 *   Date()`. The same query returns the same candidates in the same order,
 *   forever, so a test asserting on this fixture set is asserting on a
 *   contract rather than on today's date.
 * - **Refused in production.** `resolveYelpMode()` throws when
 *   `NODE_ENV=production`, so this can never be what serves a customer a
 *   fabricated review count.
 *
 * ## Why the counters are scriptable
 *
 * `MockNewsMonitor` returns one fixed fixture set, which is enough because a
 * news poll's interesting behaviour is in the gate that reads it. Activity
 * detection is the opposite: the whole feature is *the difference between two
 * observations of the same listing*, and a provider that returns a constant can
 * only ever exercise the "nothing changed" branch. So `getBusiness` walks a
 * per-listing script — a caller stages the sequence of observations it wants,
 * and every branch (first baseline, unchanged, count up, count down, rating
 * only, missing counters, listing gone) is reachable without a network stub.
 *
 * A listing with no script returns its baseline every time, which is the
 * behaviour somebody clicking around in demo mode should see: a connected
 * listing that is quiet.
 */

/** One staged observation. `null` counters model Yelp omitting a field. */
export interface MockYelpObservation {
  readonly reviewCount?: number | null;
  readonly rating?: number | null;
  /** Raise instead of answering, to exercise the failure paths. */
  readonly failWith?: YelpErrorCode;
}

export interface YelpMockFaults {
  /** Every call raises this. For "the key was rotated" style tests. */
  readonly failEveryCallWith?: YelpErrorCode;
  /** Address matching finds nothing, so the search fallback is exercised. */
  readonly matchReturnsNothing?: boolean;
}

/** Deterministic: the same name always yields the same id and alias. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "business"
  );
}

function errorFor(code: YelpErrorCode): YelpError {
  const retryable = code === "rate_limited" || code === "provider_error";
  return new YelpError(code, `Mock Yelp provider raised ${code}.`, retryable);
}

/**
 * The candidate set for one location.
 *
 * Deliberately awkward rather than tidy, for the same reason the news fixtures
 * are: a single perfect match would leave the disambiguation step — the one
 * thing standing between a customer and a mis-mapped listing — untested by
 * anyone developing against the mock.
 *
 * - the genuine listing, at the address asked for;
 * - a **second branch of the same restaurant** two streets away, which is the
 *   real failure mode a group of restaurants hits and the reason the flow
 *   refuses to auto-apply anything;
 * - a permanently closed listing for the same business, which is what an old
 *   duplicate looks like and which the UI has to mark rather than hide.
 */
function buildCandidates(
  name: string,
  city: string,
  region: string,
  postalCode: string,
  countryCode: string,
  addressLine1: string,
): YelpBusinessCandidate[] {
  const slug = slugify(name);
  const citySlug = slugify(city);

  return [
    {
      businessId: `mock-yelp-${slug}-${citySlug}`,
      alias: `${slug}-${citySlug}`,
      name,
      profileUrl: canonicalYelpBusinessUrl(`${slug}-${citySlug}`),
      addressLines: [addressLine1, `${city}, ${region} ${postalCode}`.trim()],
      city,
      region,
      postalCode,
      countryCode,
      phone: "+15555550101",
      isClosed: false,
      metadata: { categories: ["Restaurants"], price: "$$" },
    },
    {
      businessId: `mock-yelp-${slug}-${citySlug}-2`,
      alias: `${slug}-${citySlug}-2`,
      name: `${name} — ${city} East`,
      profileUrl: canonicalYelpBusinessUrl(`${slug}-${citySlug}-2`),
      addressLines: ["412 Second Avenue", `${city}, ${region} ${postalCode}`.trim()],
      city,
      region,
      postalCode,
      countryCode,
      phone: "+15555550102",
      isClosed: false,
      metadata: { categories: ["Restaurants"], price: "$$" },
    },
    {
      businessId: `mock-yelp-${slug}-${citySlug}-closed`,
      alias: `${slug}-${citySlug}-closed`,
      name: `${name} (closed)`,
      profileUrl: canonicalYelpBusinessUrl(`${slug}-${citySlug}-closed`),
      addressLines: ["9 Old Market Street", `${city}, ${region} ${postalCode}`.trim()],
      city,
      region,
      postalCode,
      countryCode,
      // A listing Yelp returns with no phone at all. Explicit null, not an
      // omission — the same discipline the news fixtures keep.
      phone: null,
      isClosed: true,
      metadata: { categories: ["Restaurants"] },
    },
  ];
}

/** What an unscripted listing reports. Quiet, and quietly plausible. */
const BASELINE_REVIEW_COUNT = 128;
const BASELINE_RATING = 4.5;

export class MockYelpProvider implements YelpPlacesProvider {
  readonly platform = "yelp" as const;

  /** businessId → the observations still to be handed out, in order. */
  private readonly scripts = new Map<string, MockYelpObservation[]>();

  constructor(private readonly faults: YelpMockFaults = {}) {}

  capabilities(): ConnectorCapabilities {
    return YELP_ASSISTED_CAPABILITIES;
  }

  /**
   * Stage the observations one listing will report, in order.
   *
   * Returns `this` so a test can set up several listings in one expression.
   * Once the script is exhausted the listing reverts to its baseline, which
   * keeps "and then nothing else changed" from needing an explicit tail.
   */
  scriptListing(businessId: string, observations: MockYelpObservation[]): this {
    this.scripts.set(businessId, [...observations]);
    return this;
  }

  matchBusinesses(query: YelpBusinessMatchQuery): Promise<YelpMatchResult> {
    if (this.faults.failEveryCallWith) {
      return Promise.reject(errorFor(this.faults.failEveryCallWith));
    }

    if (this.faults.matchReturnsNothing) {
      return Promise.resolve({ candidates: [], requestsSpent: 1, malformedCount: 0 });
    }

    const candidates = buildCandidates(
      query.name,
      query.city,
      query.region,
      query.postalCode,
      query.countryCode,
      query.addressLine1,
    ).slice(0, Math.max(1, query.limit));

    return Promise.resolve({ candidates, requestsSpent: 1, malformedCount: 0 });
  }

  searchBusinesses(query: YelpBusinessSearchQuery): Promise<YelpMatchResult> {
    if (this.faults.failEveryCallWith) {
      return Promise.reject(errorFor(this.faults.failEveryCallWith));
    }

    // The free-text fallback deliberately returns the same shape from thinner
    // input: a term and a locality string, with no address to place them at.
    const candidates = buildCandidates(
      query.term,
      query.location,
      "",
      "",
      "US",
      "1 Example Street",
    ).slice(0, Math.max(1, query.limit));

    return Promise.resolve({ candidates, requestsSpent: 1, malformedCount: 0 });
  }

  getBusiness(businessId: string): Promise<YelpListingMetadata> {
    if (this.faults.failEveryCallWith) {
      return Promise.reject(errorFor(this.faults.failEveryCallWith));
    }

    const next = this.scripts.get(businessId)?.shift();
    if (next?.failWith) return Promise.reject(errorFor(next.failWith));

    const alias = businessId.startsWith("mock-yelp-")
      ? businessId.slice("mock-yelp-".length)
      : slugify(businessId);

    return Promise.resolve({
      businessId,
      alias,
      name: "Mock Yelp listing",
      profileUrl: canonicalYelpBusinessUrl(alias),
      // `undefined` means the script said nothing about this field, so the
      // baseline stands; an explicit `null` means Yelp omitted it, which is a
      // different thing and one the check service has to refuse to read as a
      // change.
      reviewCount: next?.reviewCount === undefined ? BASELINE_REVIEW_COUNT : next.reviewCount,
      rating: next?.rating === undefined ? BASELINE_RATING : next.rating,
      isClosed: false,
      metadata: { categories: ["Restaurants"], price: "$$" },
    });
  }
}
