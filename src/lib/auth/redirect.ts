/**
 * Where to send someone after signing in.
 *
 * Its own module, not a helper inside the sign-in action, for two reasons.
 * Every export from a `"use server"` file must be an async function, so a pure
 * helper cannot live there — and this is security-relevant enough to want
 * direct tests rather than coverage through a form submission.
 */

export const DEFAULT_SIGN_IN_DESTINATION = "/overview";

/**
 * A `next` parameter, made safe.
 *
 * `next` is the parameter an open-redirect attack wants control of. Anything
 * that fails a check is replaced with the overview rather than rejected: a
 * redirect is not the place to explain a security decision, and someone who
 * followed a stale link should still end up somewhere useful.
 *
 * The rule is that the value must be a *relative path*. An open redirect
 * requires reaching another origin, and a string that cannot express an origin
 * cannot do it. The OAuth flow's `ALLOWED_REDIRECT_PATHS` is deliberately not
 * reused here — it names three integration screens, so signing in from a
 * review workspace would silently discard where the person was going.
 */
export function safeDestination(next: string | undefined | null): string {
  if (!next) return DEFAULT_SIGN_IN_DESTINATION;

  // Absolute URL, or no leading slash at all.
  if (!next.startsWith("/")) return DEFAULT_SIGN_IN_DESTINATION;
  // Protocol-relative: `//evil.com` is a different origin.
  if (next.startsWith("//")) return DEFAULT_SIGN_IN_DESTINATION;
  // Some browsers normalise a backslash to a slash, so `/\evil.com` can become
  // protocol-relative after parsing.
  if (next.includes("\\")) return DEFAULT_SIGN_IN_DESTINATION;
  // A colon before the first inner slash would smuggle a scheme past the above.
  if (/^\/[^/]*:/.test(next)) return DEFAULT_SIGN_IN_DESTINATION;
  // Control characters, which can truncate or split a header.
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_SIGN_IN_DESTINATION;

  return next;
}
