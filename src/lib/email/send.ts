import "server-only";

import { DataError } from "@/lib/data/errors";
import {
  ConfigurationError,
  requireResendApiKey,
  resolveEmailMode,
  supportFromAddress,
  type EmailMode,
} from "@/lib/env";

/**
 * Outbound mail.
 *
 * One function, one provider, one shape. Lia sends very little email — today
 * only the help form — so this is a thin call against the Resend REST API
 * rather than a dependency and an abstraction layer.
 *
 * `server-only` is imported at the top: an API key that reached a client bundle
 * would be readable by every visitor, so the build fails instead.
 *
 * The provider's error text never leaves this module. Resend echoes the
 * envelope back in validation failures, and a rendered page is the wrong place
 * for an address the sender did not choose.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Long enough for a cold Lambda at Resend, short enough to fail a form fast. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  /** Base64. Resend takes attachment bodies inline, not as uploads. */
  content: string;
}

export interface OutboundEmail {
  to: string[];
  cc?: string[];
  /** Where a reply goes — the person who asked, not the sending identity. */
  replyTo?: string[];
  subject: string;
  /** Plain text. Lia sends no HTML mail; there is nothing to lay out. */
  text: string;
  attachments?: OutboundAttachment[];
}

export interface EmailDelivery {
  mode: EmailMode;
  /** The provider's message id, or null when nothing was actually sent. */
  id: string | null;
}

/**
 * Send one message.
 *
 * Throws `ConfigurationError` when no sender is configured — an operator
 * problem, which `runAction` renders differently from a user one — and
 * `DataError("unavailable")` when the provider refused or could not be reached.
 */
export async function sendEmail(message: OutboundEmail): Promise<EmailDelivery> {
  const mode = resolveEmailMode();

  if (mode === "unconfigured") {
    // Names, never values. Matches the wording the UI shows for this case.
    throw new ConfigurationError("Email is not configured on this server.", [
      "RESEND_API_KEY",
    ]);
  }

  if (mode === "log") {
    console.info(
      [
        "[email:log] not delivered — LIA_EMAIL_MODE=log",
        `to: ${message.to.join(", ")}`,
        message.cc?.length ? `cc: ${message.cc.join(", ")}` : null,
        message.replyTo?.length ? `reply-to: ${message.replyTo.join(", ")}` : null,
        `subject: ${message.subject}`,
        // Names and sizes only. The bodies are megabytes of base64 and would
        // bury the message they were sent to explain.
        message.attachments?.length
          ? `attachments: ${message.attachments
              .map((file) => `${file.filename} (${attachedBytes(file)} bytes)`)
              .join(", ")}`
          : null,
        "",
        message.text,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    );
    return { mode: "log", id: null };
  }

  const apiKey = requireResendApiKey();
  const response = await post(apiKey, {
    from: supportFromAddress(),
    to: message.to,
    ...(message.cc?.length ? { cc: message.cc } : {}),
    ...(message.replyTo?.length ? { reply_to: message.replyTo } : {}),
    subject: message.subject,
    text: message.text,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((file) => ({
            filename: file.filename,
            content: file.content,
            content_type: file.contentType,
          })),
        }
      : {}),
  });

  return { mode: "live", id: response.id };
}

/** Decoded size of a base64 body, for the log line. */
function attachedBytes(file: OutboundAttachment): number {
  const padding = file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((file.content.length * 3) / 4) - padding);
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                    */
/* -------------------------------------------------------------------------- */

async function post(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  let response: Response;

  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    console.error("[email] transport failure:", error);
    throw new DataError(
      "unavailable",
      "We couldn't reach the mail service. Try again shortly.",
    );
  }

  if (!response.ok) {
    // Status and provider reason to the log; a sentence to the user. A 4xx here
    // is almost always the sending domain or the recipient list — an operator
    // problem the sender cannot fix by rewording their message, so the copy
    // points them at an administrator instead of inviting a pointless retry.
    console.error(
      `[email] provider refused: ${response.status} ${await safeBody(response)}`,
    );

    const transient = response.status === 429 || response.status >= 500;
    throw new DataError(
      "unavailable",
      transient
        ? "The mail service is busy right now. Try again in a minute."
        : "The mail service rejected that message. Your administrator will need to check Lia's email settings.",
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  const id =
    payload && typeof payload === "object" && "id" in payload
      ? String((payload as { id: unknown }).id)
      : null;

  if (!id) {
    console.error("[email] provider returned no message id");
    throw new DataError(
      "unavailable",
      "We couldn't confirm that message was sent. Try again shortly.",
    );
  }

  return { id };
}

/** Response text for the log, bounded and never thrown from. */
async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "<unreadable>";
  }
}
