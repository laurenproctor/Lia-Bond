import { z } from "zod";

/**
 * Google API response shapes.
 *
 * Everything crossing the network is parsed before it is used. Google's REST
 * responses omit fields freely — a location with no phone number simply has no
 * `phoneNumbers` key — so the schemas are permissive about absence and strict
 * about type. Anything that does not parse becomes an `unexpected_response`
 * error rather than an `undefined` surfacing three layers up as a blank row.
 *
 * `.catchall`/passthrough is avoided: only named fields are carried forward, so
 * a future Google field cannot slip unreviewed into `providerMetadata` and from
 * there into an audit record.
 */

/* -------------------------------------------------------------------------- */
/* OAuth                                                                       */
/* -------------------------------------------------------------------------- */

export const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  /** Absent on re-consent when Google has already issued one for this client. */
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  /** Space-delimited. Reports what was granted, not what was asked for. */
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
});

export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

/** Google's OAuth failures: `{ error, error_description }`. */
export const googleOAuthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/**
 * One entry in a Google error's `details` array.
 *
 * Only `ErrorInfo` is modelled, and only the two fields that matter. The
 * quota metadata is the point: a `RESOURCE_EXHAUSTED` response carries the
 * limit that was hit, and a limit of **zero** means the project was never
 * granted quota in the first place rather than having spent it. That is the
 * one signal that separates "slow down" from "your API access application has
 * not been approved" — two failures Google reports identically at the status
 * line and which need completely different things from the reader.
 *
 * `metadata` values are strings, including the numeric ones. Google sends
 * `"quota_limit_value": "0"`, not `0`.
 */
export const googleErrorDetailSchema = z.object({
  "@type": z.string().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

/** Google's REST failures: `{ error: { code, message, status, details } }`. */
export const googleApiErrorSchema = z.object({
  error: z.object({
    code: z.number().int().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    // Unknown detail shapes are dropped rather than rejected: `details` is an
    // open union at Google, and an unrecognised entry must not turn a
    // classifiable error into an `unexpected_response`.
    details: z.array(z.unknown()).optional(),
  }),
});

/* -------------------------------------------------------------------------- */
/* Account Management API v1                                                   */
/* -------------------------------------------------------------------------- */

export const googleAccountSchema = z.object({
  /** Resource name, e.g. "accounts/1122334455". */
  name: z.string().min(1),
  accountName: z.string().optional(),
  type: z.string().optional(),
  role: z.string().optional(),
  verificationState: z.string().optional(),
  vettedState: z.string().optional(),
  accountNumber: z.string().optional(),
  permissionLevel: z.string().optional(),
  organizationInfo: z
    .object({
      registeredDomain: z.string().optional(),
      postalAddress: z.unknown().optional(),
      phoneNumber: z.string().optional(),
    })
    .optional(),
});

export type GoogleAccount = z.infer<typeof googleAccountSchema>;

export const googleAccountsResponseSchema = z.object({
  accounts: z.array(googleAccountSchema).optional(),
  nextPageToken: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Business Information API v1                                                 */
/* -------------------------------------------------------------------------- */

const googlePostalAddressSchema = z.object({
  regionCode: z.string().optional(),
  languageCode: z.string().optional(),
  postalCode: z.string().optional(),
  administrativeArea: z.string().optional(),
  locality: z.string().optional(),
  addressLines: z.array(z.string()).optional(),
});

const googleLocationMetadataSchema = z.object({
  mapsUri: z.string().optional(),
  newReviewUri: z.string().optional(),
  placeId: z.string().optional(),
  hasVoiceOfMerchant: z.boolean().optional(),
  canOperateLocalPost: z.boolean().optional(),
});

export const googleLocationSchema = z.object({
  /** Resource name, e.g. "locations/1234567890". */
  name: z.string().min(1),
  title: z.string().optional(),
  storeCode: z.string().optional(),
  websiteUri: z.string().optional(),
  phoneNumbers: z
    .object({
      primaryPhone: z.string().optional(),
      additionalPhones: z.array(z.string()).optional(),
    })
    .optional(),
  storefrontAddress: googlePostalAddressSchema.optional(),
  metadata: googleLocationMetadataSchema.optional(),
  openInfo: z
    .object({
      status: z.string().optional(),
      canReopen: z.boolean().optional(),
    })
    .optional(),
  /** Present only when the caller asked for it in the read mask. */
  latlng: z
    .object({ latitude: z.number().optional(), longitude: z.number().optional() })
    .optional(),
});

export type GoogleLocation = z.infer<typeof googleLocationSchema>;

export const googleLocationsResponseSchema = z.object({
  locations: z.array(googleLocationSchema).optional(),
  nextPageToken: z.string().optional(),
  totalSize: z.number().int().optional(),
});

/* -------------------------------------------------------------------------- */
/* My Business API v4 — reviews                                                */
/*                                                                             */
/* Reviews are the one Business Profile resource Google never migrated off the */
/* legacy v4 endpoint. The v1 family covers accounts and locations only, so    */
/* `mybusiness.googleapis.com/v4` is not an oversight here — it is where the   */
/* data is. The scope is the same one workflow 02 already holds.               */
/* -------------------------------------------------------------------------- */

/**
 * Google's star rating.
 *
 * A word, not a number, and `STAR_RATING_UNSPECIFIED` is a real value Google
 * returns rather than a placeholder — so it is parsed and then rejected at
 * normalisation rather than being coerced into a rating nobody gave.
 */
export const googleStarRatingSchema = z.enum([
  "STAR_RATING_UNSPECIFIED",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
]);

export type GoogleStarRating = z.infer<typeof googleStarRatingSchema>;

/**
 * The reviewer.
 *
 * Every field is optional, and that is Google's behaviour rather than caution:
 * an anonymous review arrives with `isAnonymous: true` and no display name at
 * all. Lia records the anonymity separately from the missing name, because
 * "they chose not to be named" and "Google did not tell us" are different facts
 * and only one of them should stop a response addressing someone by name.
 */
export const googleReviewerSchema = z.object({
  profilePhotoUrl: z.string().optional(),
  displayName: z.string().optional(),
  isAnonymous: z.boolean().optional(),
});

/** The business owner's published reply, when one exists. */
export const googleReviewReplySchema = z.object({
  comment: z.string().optional(),
  updateTime: z.string().optional(),
});

export const googleReviewSchema = z.object({
  /** Resource name: accounts/{account}/locations/{location}/reviews/{review}. */
  name: z.string().optional(),
  reviewId: z.string().optional(),
  reviewer: googleReviewerSchema.optional(),
  starRating: googleStarRatingSchema.optional(),
  /**
   * The written review. Absent on a rating-only review, which is the majority
   * of them — a review with no comment is still a review and still counts.
   */
  comment: z.string().optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
  reviewReply: googleReviewReplySchema.optional(),
});

export type GoogleReview = z.infer<typeof googleReviewSchema>;

/**
 * A page of reviews.
 *
 * `reviews` is optional because Google omits the key entirely for a location
 * with none, rather than sending an empty array. Treating that as a failure
 * would make every new listing look broken.
 */
export const googleReviewsResponseSchema = z.object({
  reviews: z.array(googleReviewSchema).optional(),
  nextPageToken: z.string().optional(),
  /** Google's own count. Absent on some responses; never inferred when it is. */
  totalReviewCount: z.number().int().optional(),
  averageRating: z.number().optional(),
});

export type GoogleReviewsResponse = z.infer<typeof googleReviewsResponseSchema>;

/**
 * Google's star words, as integers.
 *
 * `STAR_RATING_UNSPECIFIED` maps to null rather than to zero. Zero is a rating
 * a person could plausibly have given; "Google did not say" is not, and
 * averaging a fabricated zero into a location's score would drag it down for
 * reasons no reviewer is responsible for.
 */
export const GOOGLE_STAR_RATING_VALUES: Record<GoogleStarRating, number | null> = {
  STAR_RATING_UNSPECIFIED: null,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

/**
 * Fields requested from the Business Information API.
 *
 * `readMask` is required by Google — omitting it is an error, not a default —
 * so this list is the definition of what Lia knows about a location. Only what
 * the mapping screen renders and what a later review sync will need to address
 * a location is requested; no coordinates, no hours, no attributes.
 */
export const GOOGLE_LOCATION_READ_MASK = [
  "name",
  "title",
  "storeCode",
  "websiteUri",
  "phoneNumbers",
  "storefrontAddress",
  "metadata",
  "openInfo",
].join(",");
