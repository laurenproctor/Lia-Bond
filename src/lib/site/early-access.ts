import { z } from "zod";
import { honeypot, optionalText, sitePath } from "@/lib/site/form-text";
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

  /** Which page converted. See `@/lib/site/form-text`. */
  sourcePath: sitePath(),

  /** Honeypot. See `@/lib/site/form-text`. */
  website: honeypot(),
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
