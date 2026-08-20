import { z } from "zod";

/**
 * Text handling shared by the public site's two unauthenticated forms.
 *
 * These were written for the early-access capture and are now used by the
 * contact form as well. They live here rather than being duplicated because
 * the guarantee they provide — nothing a stranger types can bend the shape of
 * the notification it lands in — has to be identical on both paths, and two
 * copies of a security-relevant transform drift.
 */

/**
 * Collapses embedded control characters — CR, LF, tab, and the rest of the
 * C0/DEL range — to a single space per run, rather than deleting them.
 * Deleting would silently weld "Real Cafe" and the next word together;
 * collapsing keeps the text readable while guaranteeing that nothing a
 * stranger types can introduce a line break into a value a composer
 * interpolates unquestioningly.
 */
export const stripControlCharacters = (value: string) =>
  value.replace(/[\u0000-\u001F\u007F]+/g, " ");

/** Empty strings arrive from unfilled inputs; they mean "absent", not "". */
export const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform(stripControlCharacters)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .default(null);

/**
 * A required single-line field: sanitised, trimmed, and bounded, with the
 * empty case reported in the form's own words rather than Zod's.
 */
export const requiredText = (max: number, message: string) =>
  z
    .string()
    .max(max, message)
    .transform(stripControlCharacters)
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message });

/**
 * Which page a submission came from. A path, never an absolute URL or a
 * protocol-relative host — it is rendered into a notification prefixed with
 * `origin`, and a link someone else chose has no business appearing there.
 * The leading "//" that would make a value protocol-relative is rejected
 * outright rather than left inert only because today's single caller happens
 * to compose it with an origin prefix.
 */
export const sitePath = () =>
  z
    .string()
    .max(120)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .default(null)
    .refine((value) => value === null || /^\/(?!\/)[\w\-/]*$/.test(value), {
      message: "Not a site path.",
    });

/**
 * The hidden field naive bots fill in. A non-empty value fails validation, and
 * the visitor is told nothing about why — a bot that learns which field
 * betrayed it simply stops filling that one.
 */
export const honeypot = () =>
  z
    .string()
    .max(200)
    .refine((value) => value.trim().length === 0, { message: "Rejected." });
