/**
 * The hard output gate for a drafted response.
 *
 * `DRAFTING_SYSTEM_PROMPT` (`src/ai/anthropic/drafting-prompt.ts`) asks the
 * model for plain prose, no Markdown, no URLs/e-mails/phone numbers, no
 * preamble, and exactly one reply -- under "Length and format". Asking is not
 * enforcing: a model can still return a Markdown list or a second "Option 2"
 * paragraph. This is the check that refuses to let either through regardless
 * of what the prompt asked for, which is why it is a gate on the raw string
 * the model returned rather than another instruction to the model.
 *
 * Every pattern below targets a narrow, well-known shape (a Markdown header,
 * a bare `https://` URL, a US-style phone number) on purpose. A legitimate
 * customer-service reply is unlikely to trip one by accident; a false
 * rejection costs a retry, but a false acceptance publishes a phone number or
 * a bulleted list under the business's own name.
 */

/** The Global Constraints length cap, in Unicode code points, not UTF-16 units. */
export const DRAFT_MAX_CODE_POINTS = 1500;

export type DraftValidationReason =
  | "empty"
  | "too_long"
  | "preamble"
  | "alternatives"
  | "contains_url"
  | "contains_email"
  | "contains_phone"
  | "markdown";

export type DraftValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: DraftValidationReason };

/** `https://…`, `http://…`, or a bare `www.…` host. */
const URL_PATTERN = /(https?:\/\/|www\.)\S+/i;

/** A standard `local@domain.tld` address. */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/;

/** A US/Canada-style 3-3-4 phone number, with optional country code and parens. */
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

/**
 * A Markdown header, bullet, numbered list item, bold/italic run, or link --
 * checked line-by-line (`m`) since a header or bullet is only Markdown at the
 * start of a line.
 */
const MARKDOWN_PATTERN =
  /^ {0,3}#{1,6}\s|^ {0,3}[-*+]\s|^ {0,3}\d+\.\s|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)/m;

/**
 * The model announcing the reply rather than writing it: "Dear reviewer,"
 * (a generic, un-personalised salutation -- not "Dear Priya,", which is a
 * legitimate reply opening) or "here's/here is/sure, here's" framing.
 * Deliberately does not match "Thank you for..." or "Thanks for..." -- those
 * are ordinary, desired reply openings, not preamble.
 */
const PREAMBLE_PATTERN =
  /^dear reviewer\b|^here'?s\s+(?:a\s+|your\s+|my\s+)?(?:draft|reply|response)\b|^here is\s+(?:a\s+|your\s+|my\s+)?(?:draft|reply|response)\b|^sure[,!]?\s*(?:here|,)/i;

/** A second offered option: "Option 1:", "Alternative 2", "Choice A". */
const ALTERNATIVES_PATTERN = /\boption\s*[1-9]\b|\balternative\s*[1-9]\b|\bchoice\s*[1-9]\b/i;

/**
 * Run the Global Constraints gate against one candidate reply.
 *
 * Checks in a fixed order -- length before content, content before the
 * specific leak patterns -- so a string that trips more than one rule always
 * reports the same reason. Unicode-safe throughout: `.trim()` removes only
 * whitespace, and the length cap counts `Array.from(text).length` (code
 * points) rather than `.length` (UTF-16 code units), so a string of astral
 * emoji is not undercounted.
 */
export function validateDraftText(raw: string): DraftValidationResult {
  const text = raw.trim();

  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (Array.from(text).length > DRAFT_MAX_CODE_POINTS) {
    return { ok: false, reason: "too_long" };
  }
  if (MARKDOWN_PATTERN.test(text)) {
    return { ok: false, reason: "markdown" };
  }
  if (PREAMBLE_PATTERN.test(text)) {
    return { ok: false, reason: "preamble" };
  }
  if (ALTERNATIVES_PATTERN.test(text)) {
    return { ok: false, reason: "alternatives" };
  }
  if (URL_PATTERN.test(text)) {
    return { ok: false, reason: "contains_url" };
  }
  if (EMAIL_PATTERN.test(text)) {
    return { ok: false, reason: "contains_email" };
  }
  if (PHONE_PATTERN.test(text)) {
    return { ok: false, reason: "contains_phone" };
  }

  return { ok: true, text };
}
