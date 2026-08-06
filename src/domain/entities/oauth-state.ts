import { z } from "zod";
import { platformSchema } from "@/domain/enums";
import { timestampSchema, uuidSchema } from "@/domain/primitives";

/**
 * A single-use OAuth handshake record.
 *
 * The state value itself is never stored. What is stored is its SHA-256 hash,
 * for the same reason a password is not stored in the clear: read access to the
 * table — a backup, a log shipper, a mis-scoped query — must not be enough to
 * forge a callback. The callback hashes what the provider sent and looks the
 * hash up, so a match proves the caller holds the original value.
 *
 * Everything the callback needs to authorise is bound into the row at creation:
 * which provider, which Lia user, which organization, and where to land
 * afterwards. None of it comes back from the provider, so none of it can be
 * tampered with in transit.
 */
export const oauthStateSchema = z.object({
  id: uuidSchema,
  provider: platformSchema,
  organizationId: uuidSchema,
  userId: uuidSchema,
  /** Internal path only. Never a full URL — see `isAllowedRedirectPath`. */
  redirectPath: z.string().min(1).max(200),
  /** Whether this handshake is refreshing an existing connection. */
  reauthorization: z.boolean(),
  expiresAt: timestampSchema,
  consumedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});

export type OAuthState = z.infer<typeof oauthStateSchema>;

/**
 * Post-authorization destinations a caller may ask for.
 *
 * A closed list, because "where should we send the user after Google" is
 * exactly the parameter an open-redirect attack wants control of. The connect
 * route accepts a path only if it appears here.
 */
export const ALLOWED_REDIRECT_PATHS = [
  "/integrations",
  "/integrations/google-business-profile",
  "/integrations/google-business-profile/setup",
  // Onboarding. Connecting Google is step 2 and choosing locations is step 3,
  // so a successful grant returns straight to step 3 rather than dropping the
  // person back on the screen they just finished. Both are listed: the callback
  // re-checks the stored path against this list on the way out, and a
  // reauthorization started from step 2 must be able to return there.
  "/onboarding/connect-sources",
  "/onboarding/locations",
] as const;

export type AllowedRedirectPath = (typeof ALLOWED_REDIRECT_PATHS)[number];

export function isAllowedRedirectPath(value: unknown): value is AllowedRedirectPath {
  return (
    typeof value === "string" &&
    (ALLOWED_REDIRECT_PATHS as readonly string[]).includes(value)
  );
}

/** How long a handshake stays valid. Long enough to consent, short enough to matter. */
export const OAUTH_STATE_TTL_MINUTES = 10;
