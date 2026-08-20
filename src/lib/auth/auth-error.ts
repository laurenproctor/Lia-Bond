/**
 * Turning a provider failure into a sentence somebody can act on.
 *
 * Supabase returns a machine-readable `code` alongside its own English message.
 * The message is not shown: it is written for whoever integrated the API, it
 * changes without notice, and in at least one case ("Database error saving new
 * user") it describes our schema to the public. The code is stable, so the
 * mapping lives here and the copy stays ours.
 *
 * The rule that shapes the table: say what the person can do next. "That
 * account could not be created" is true of every branch below and useful in
 * none of them — someone whose password was rejected, someone who hit a rate
 * limit, and someone who already has an account all need different next moves,
 * and a single sentence covering all three sends every one of them to support.
 *
 * What is deliberately *not* said is whether an address is registered. See
 * `DUPLICATE_ACCOUNT` below.
 */

/** The subset of `AuthError` this reads. Structural, so tests need no provider. */
export interface ProviderAuthError {
  code?: string;
  status?: number;
  message?: string;
}

/**
 * Reported instead of "an account with that email already exists".
 *
 * The direct sentence is what most products show, and it is an account-
 * enumeration oracle: sign-up is reachable without a session, so anyone could
 * walk a list of addresses through it and learn which ones belong to our
 * customers. This form is conditional — it never confirms the address is
 * registered — while still naming the exact recovery for the person who is
 * simply signing up twice, which is the only case that matters in practice.
 *
 * Note that this closes the oracle at our endpoint only. Supabase distinguishes
 * the case at its own API, which is precisely why the distinction must not be
 * forwarded here.
 */
const DUPLICATE_ACCOUNT =
  "If you already have an account with this email, sign in instead — or reset your password if you have forgotten it.";

/**
 * Code to message.
 *
 * Only codes reachable from a password sign-up are listed. Anything else falls
 * through to the status-based defaults, which is the correct behaviour for a
 * code Supabase adds after this was written.
 */
const SIGN_UP_MESSAGES = {
  // Reachable when email confirmation is switched off for the project. With it
  // on, Supabase returns a success-shaped response for a duplicate instead, and
  // this branch is never taken.
  user_already_exists: DUPLICATE_ACCOUNT,
  email_exists: DUPLICATE_ACCOUNT,

  // Length is checked before the request is made, so reaching this means
  // Supabase's own policy rejected it — usually the breached-password check.
  weak_password:
    "That password is too easy to guess. Choose a longer one that you do not use on another site.",

  email_address_invalid:
    "That email address was not accepted. Check it for a typo, and use a real work address rather than a placeholder domain.",

  // The project's mail sender will not deliver to this address. On Supabase's
  // built-in SMTP that means the allow-list; on a custom provider, a block.
  email_address_not_authorized:
    "We could not send email to that address. Try another address, or get in touch at lia.bond/contact.",

  over_email_send_rate_limit:
    "Too many emails have gone to that address in the last hour. Wait an hour and try again.",
  over_request_rate_limit:
    "Too many attempts from this device. Wait a few minutes and try again.",

  signup_disabled: "New accounts are not being accepted right now. Get in touch at lia.bond/contact.",
  email_provider_disabled:
    "Signing up with an email address is switched off right now. Get in touch at lia.bond/contact.",
  provider_disabled:
    "Signing up with an email address is switched off right now. Get in touch at lia.bond/contact.",

  user_banned: "That account is suspended. Get in touch at lia.bond/contact.",

  captcha_failed: "The security check did not pass. Reload the page and try again.",

  // A 500 from Supabase — most often the profile trigger throwing. Nothing the
  // person did, and nothing they can fix, so it says so instead of implying
  // their input was at fault.
  unexpected_failure:
    "Something went wrong on our side while creating your account. Try again in a moment — if it keeps happening, get in touch at lia.bond/contact.",

  validation_failed: "Check the form and try again.",
  // `as const` rather than an annotation: with `noUncheckedIndexedAccess`, an
  // annotated `Record<string, string>` widens every direct read below to
  // `string | undefined`, which is false for the keys written right here.
} as const satisfies Record<string, string>;

/** A lookup that keeps the missing case visible instead of asserting it away. */
function lookup(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return Object.hasOwn(SIGN_UP_MESSAGES, code)
    ? SIGN_UP_MESSAGES[code as keyof typeof SIGN_UP_MESSAGES]
    : undefined;
}

/**
 * The message for a sign-up failure.
 *
 * Falls back on the HTTP status rather than on one catch-all, because 429 and
 * 5xx are the two shapes most likely to arrive under a code this does not know,
 * and both have a better answer than "try again".
 */
export function signUpErrorMessage(error: ProviderAuthError): string {
  const mapped = lookup(error.code);
  if (mapped) return mapped;

  if (error.status === 429) {
    return "Too many attempts. Wait a few minutes and try again.";
  }

  if (error.status !== undefined && error.status >= 500) {
    return SIGN_UP_MESSAGES.unexpected_failure;
  }

  return "That account could not be created. Check your details and try again — if it keeps happening, get in touch at lia.bond/contact.";
}

/**
 * The message for a sign-up made from an invitation.
 *
 * Identical but for the duplicate case. There the address is not supplied by
 * the form — it is read back off the invitation on the server — so naming it
 * enumerates nothing: an administrator already sent an invitation to that
 * address, and the only person who can reach this screen is holding the token.
 * The sentence can therefore be plain, and points at the acceptance path rather
 * than at sign-up.
 */
export function invitationSignUpErrorMessage(error: ProviderAuthError): string {
  if (error.code === "user_already_exists" || error.code === "email_exists") {
    return "You already have an account with this email. Sign in, then open this invitation link again to join.";
  }

  return signUpErrorMessage(error);
}

/**
 * The message for a failed password change.
 *
 * Shares the table because the interesting failures are the same ones — a
 * rejected password, a rate limit, a provider outage — and a second table would
 * have drifted from this one.
 */
export function updatePasswordErrorMessage(error: ProviderAuthError): string {
  switch (error.code) {
    case "weak_password":
      return SIGN_UP_MESSAGES.weak_password;
    case "same_password":
      return "That is already your password. Choose a different one.";
    case "over_request_rate_limit":
      return SIGN_UP_MESSAGES.over_request_rate_limit;
    default:
      if (error.status === 429) return SIGN_UP_MESSAGES.over_request_rate_limit;
      return "That password could not be saved. Try again, or request a new link.";
  }
}
