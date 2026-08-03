/**
 * Google OAuth scopes.
 *
 * Exactly one scope is requested, and that is not a simplification — it is what
 * Google offers. The Business Profile APIs are gated behind a single scope
 * rather than a per-API family, so there is no narrower grant available for
 * "read accounts only" or "read locations only".
 *
 * Verified against Google's current documentation (August 2026):
 * https://developers.google.com/my-business/content/implement-oauth
 * https://developers.google.com/my-business/content/basic-setup
 *
 * The older `https://www.googleapis.com/auth/plus.business.manage` is
 * deprecated and kept alive by Google only for backward compatibility. Lia does
 * not request it. If an earlier version of this repository referenced it, that
 * reference has been replaced rather than carried forward.
 */

export const GOOGLE_BUSINESS_MANAGE_SCOPE =
  "https://www.googleapis.com/auth/business.manage";

/** Every scope Lia asks Google for. */
export const GOOGLE_REQUIRED_SCOPES: readonly string[] = [
  GOOGLE_BUSINESS_MANAGE_SCOPE,
];

export interface ScopeRationale {
  scope: string;
  grants: string;
  whyLiaNeedsIt: string;
  usedByInWorkflow02: string[];
}

/**
 * Why each scope is requested.
 *
 * Rendered on the integration detail screen and reproduced in
 * `docs/integrations/google-business-profile.md`, so a customer's
 * administrator can see the justification in the product rather than having to
 * take it on trust from a consent screen.
 */
export const GOOGLE_SCOPE_RATIONALE: readonly ScopeRationale[] = [
  {
    scope: GOOGLE_BUSINESS_MANAGE_SCOPE,
    grants:
      "Read and manage the Business Profile accounts and locations the signed-in Google user administers.",
    whyLiaNeedsIt:
      "Google exposes account discovery, location discovery, and review management behind this one scope. There is no narrower scope that grants only reading — requesting less is not an option Google offers.",
    usedByInWorkflow02: [
      "Listing the Business Profile accounts the user may manage",
      "Listing the locations under a selected account",
      "Confirming the connection is still authorised during a health check",
    ],
  },
];

/**
 * Scopes deliberately NOT requested.
 *
 * Documented because "we did not ask for this" is only checkable if it is
 * written down. Lia never asks for the user's Google profile, email address,
 * Drive, or Gmail: the connected Google identity is established from the
 * Business Profile account listing itself, which the granted scope already
 * covers, so an identity scope would add access without adding capability.
 */
export const GOOGLE_SCOPES_DELIBERATELY_OMITTED: readonly string[] = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/plus.business.manage",
];

/**
 * Did the grant cover everything Lia needs?
 *
 * Google's consent screen lets a user decline individual scopes, and the token
 * response reports what was actually granted. Checking is what turns a silent
 * "no results" into an honest "reauthorize and accept this permission".
 */
export function missingScopes(granted: readonly string[]): string[] {
  const held = new Set(granted);
  return GOOGLE_REQUIRED_SCOPES.filter((scope) => !held.has(scope));
}

export function hasRequiredScopes(granted: readonly string[]): boolean {
  return missingScopes(granted).length === 0;
}
