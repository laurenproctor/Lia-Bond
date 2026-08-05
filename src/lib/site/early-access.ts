import { z } from "zod";
import { INDUSTRIES, type IndustrySlug } from "@/lib/site/routes";

/**
 * Early-access request validation and composition.
 *
 * Pure: no I/O, no session, no provider. The action supplies the transport;
 * everything about *what the message says* is decided here so it can be tested
 * without sending anything — the same split `@/lib/support/help-request` uses.
 *
 * The rule that shapes this module: it is the application's only public,
 * unauthenticated write. Every field is therefore either constrained to a known
 * vocabulary or bounded in length, and nothing is interpolated into the
 * notification without having passed through the schema first.
 */

export const MAX_BUSINESS_NAME_LENGTH = 200;

const INDUSTRY_SLUGS = INDUSTRIES.map((industry) => industry.slug) as [
  IndustrySlug,
  ...IndustrySlug[],
];

const INDUSTRY_LABELS = new Map<IndustrySlug, string>(
  INDUSTRIES.map((industry) => [industry.slug, industry.label]),
);

/**
 * Collapses embedded control characters — CR, LF, tab, and the rest of the
 * C0/DEL range — to a single space per run, rather than deleting them.
 * Deleting would silently weld "Real Cafe" and the next word together;
 * collapsing keeps the text readable while guaranteeing that nothing a
 * stranger types can introduce a line break into a value the composer below
 * interpolates unquestioningly. That guarantee — "nothing a stranger types
 * can bend the shape of the notification" — is the whole point of this
 * module, so it has to hold here, not just at the mailer boundary.
 */
const stripControlCharacters = (value: string) =>
  value.replace(/[\u0000-\u001F\u007F]+/g, " ");

/** Empty strings arrive from unfilled inputs; they mean "absent", not "". */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform(stripControlCharacters)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .default(null);

export const earlyAccessSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    // `z.email()` rejects the embedded CR/LF that begins a header injection,
    // so the address needs no separate sanitising before it reaches the mailer.
    .pipe(z.email({ message: "Enter a valid email address." }))
    .pipe(z.string().max(320)),

  businessName: optionalText(MAX_BUSINESS_NAME_LENGTH),

  /**
   * Constrained to the vocabulary rather than stored free-form. The value is
   * echoed into an email and written to a column; an open string would be a
   * place for a stranger to put anything.
   */
  industry: z.enum(INDUSTRY_SLUGS).nullable().default(null),

  /**
   * Which page converted. A path, never an absolute URL or a protocol-relative
   * host — it is rendered into the notification, prefixed with `origin`, and
   * a link someone else chose has no business appearing there. The leading
   * "//" that would make a value protocol-relative (e.g. "//evil") is
   * rejected outright by the pattern below, rather than left inert only
   * because this field always happens to be composed with an origin prefix
   * today; a future caller that renders it bare should not inherit that risk.
   *
   * An empty string means "absent," the same as the other optional fields —
   * a browser `FormData` yields "" rather than `undefined` for an unset
   * field, so treating only `undefined` as absent would reject the common
   * case rather than accept it as "no page recorded."
   */
  sourcePath: z
    .string()
    .max(120)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .default(null)
    .refine((value) => value === null || /^\/(?!\/)[\w\-/]*$/.test(value), {
      message: "Not a site path.",
    }),

  /**
   * Honeypot. Hidden from people, filled by naive bots. A non-empty value fails
   * validation, and the visitor is told nothing about why — a bot that learns
   * which field betrayed it simply stops filling that one.
   */
  website: z
    .string()
    .max(200)
    .refine((value) => value.trim().length === 0, { message: "Rejected." }),
});

export type EarlyAccessRequest = z.infer<typeof earlyAccessSchema>;

export function composeEarlyAccessNotification({
  request,
  sentAt,
  origin,
}: {
  request: EarlyAccessRequest;
  sentAt: Date;
  origin: string;
}): { subject: string; text: string } {
  const industry = request.industry
    ? (INDUSTRY_LABELS.get(request.industry) ?? request.industry)
    : null;

  const lines = [
    "Someone asked for early access to Lia.",
    "",
    `Email:     ${request.email}`,
    `Business:  ${request.businessName ?? "Not given"}`,
    `Industry:  ${industry ?? "Not given"}`,
    `From page: ${request.sourcePath ? `${origin}${request.sourcePath}` : "Not given"}`,
    `Received:  ${sentAt.toISOString()}`,
    "",
    "Reply to the address above to start the conversation.",
  ];

  return {
    // Single line by construction: the address cannot contain CR or LF, having
    // passed `z.email()` above.
    subject: `Early access request — ${request.email}`,
    text: lines.join("\n"),
  };
}
