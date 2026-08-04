import { z } from "zod";
import {
  HELP_TOPICS,
  HELP_TOPIC_LABELS,
  type HelpTopic,
} from "@/lib/support/help-topics";

/**
 * Help request validation and composition.
 *
 * Pure: no I/O, no session, no provider. The action supplies the identity and
 * the transport; everything about *what the message says* is decided here so it
 * can be tested without sending anything.
 *
 * The rule that shapes the composer: the requester's identity comes from the
 * session, never from the form. The email field is a reply-to — someone may
 * legitimately want answers in a shared inbox — so it is editable, and the
 * signed-in account is stamped into the body regardless. Otherwise the form
 * would be a way to send mail from Lia over somebody else's name.
 */

export const MAX_HELP_MESSAGE_LENGTH = 4000;
export const MIN_HELP_MESSAGE_LENGTH = 10;
export const MAX_CC_RECIPIENTS = 3;

/** Splits a free-typed CC field on the separators people actually use. */
export function parseAddressList(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const ccSchema = z
  .string()
  .max(400)
  .optional()
  .transform((value) => parseAddressList(value ?? ""))
  .superRefine((addresses, ctx) => {
    if (addresses.length > MAX_CC_RECIPIENTS) {
      ctx.addIssue({
        code: "custom",
        message: `Copy in up to ${MAX_CC_RECIPIENTS} people.`,
      });
      return;
    }

    for (const address of addresses) {
      if (!z.email().safeParse(address).success) {
        ctx.addIssue({
          code: "custom",
          message: `"${address}" is not a valid email address.`,
        });
      }
    }
  });

export const helpRequestSchema = z.object({
  // The picker starts unselected, so "" and undefined both arrive here. Neither
  // is a topic, and both get the same sentence rather than Zod's default.
  topic: z.enum(HELP_TOPICS, { error: "Choose the topic that fits best." }),
  replyTo: z.email("Enter a valid email address."),
  cc: ccSchema,
  message: z
    .string()
    .trim()
    .min(MIN_HELP_MESSAGE_LENGTH, "Tell us a little more about what you need.")
    .max(MAX_HELP_MESSAGE_LENGTH, "That message is too long to send."),
});

export type HelpRequestInput = z.infer<typeof helpRequestSchema>;

export interface HelpRequestSender {
  fullName: string;
  /** The signed-in account. Not the reply-to field. */
  email: string;
  roleLabel: string;
}

export interface HelpRequestOrganization {
  name: string;
  slug: string;
}

export interface ComposeHelpRequestInput {
  request: HelpRequestInput;
  sender: HelpRequestSender;
  organization: HelpRequestOrganization;
  /** Absolute origin of the deployment the request came from. */
  origin: string;
  /** True when the sender was looking at demo records, not their own data. */
  demoMode: boolean;
  sentAt: Date;
}

export interface ComposedHelpRequest {
  subject: string;
  text: string;
}

/**
 * Turn a validated request into the message support receives.
 *
 * Everything a first reply needs is above the fold — who, which organization,
 * which deployment, and whether they were looking at demo data, which is the
 * single most common reason a report describes numbers nobody else can see.
 */
export function composeHelpRequest({
  request,
  sender,
  organization,
  origin,
  demoMode,
  sentAt,
}: ComposeHelpRequestInput): ComposedHelpRequest {
  const topicLabel = HELP_TOPIC_LABELS[request.topic satisfies HelpTopic];

  const subject = `Lia help — ${topicLabel} — ${organization.name}`;

  const header: Array<[string, string]> = [
    ["Topic", topicLabel],
    ["From", `${sender.fullName} <${sender.email}>`],
    ["Role", sender.roleLabel],
    ["Organization", `${organization.name} (${organization.slug})`],
    ["Reply to", request.replyTo],
  ];

  if (request.cc.length > 0) {
    header.push(["Copied", request.cc.join(", ")]);
  }

  header.push(["Deployment", origin]);
  if (demoMode) {
    header.push(["Data", "Demo dataset — no database connected"]);
  }
  header.push(["Sent", sentAt.toISOString()]);

  const width = Math.max(...header.map(([label]) => label.length));
  const headerBlock = header
    .map(([label, value]) => `${label.padEnd(width)}  ${value}`)
    .join("\n");

  const text = [
    headerBlock,
    "",
    "-".repeat(56),
    "",
    request.message,
    "",
    "-".repeat(56),
    "Sent from the help form in Lia. Replying to this message reaches the",
    "person who asked.",
    "",
  ].join("\n");

  return { subject, text };
}
