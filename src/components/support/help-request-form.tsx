"use client";

import { useId, useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Send } from "lucide-react";
import {
  submitHelpRequestAction,
  type HelpRequestReceipt,
} from "@/app/actions/support";
import { AttachmentDropzone } from "@/components/support/attachment-dropzone";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ATTACHMENT_LIMITS_HINT } from "@/lib/support/help-attachments";
import {
  MAX_CC_RECIPIENTS,
  MAX_HELP_MESSAGE_LENGTH,
} from "@/lib/support/help-request";
import {
  HELP_TOPICS,
  HELP_TOPIC_HINTS,
  HELP_TOPIC_LABELS,
  HELP_TOPIC_PLACEHOLDER,
  HELP_TOPIC_PLACEHOLDER_HINT,
  type HelpTopic,
} from "@/lib/support/help-topics";

const FIELD_CLASSES =
  "w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none placeholder:text-gray-400 focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20 disabled:bg-gray-50 disabled:text-gray-500";

const INVALID_CLASSES = "border-red-600 focus-visible:border-red-600";

export interface HelpRequestFormProps {
  /** The signed-in account. Prefills the reply-to field. */
  defaultEmail: string;
}

/**
 * Ask the Lia team for help.
 *
 * The email field is prefilled from the session but left editable — replies
 * often need to reach a shared inbox rather than the person clicking send. It
 * is a reply-to, not an identity: the server stamps the signed-in account into
 * every message regardless of what is typed here.
 *
 * Submission is one-way. Nothing is stored — attachments included; they ride
 * along on the message and Lia keeps no copy — so the confirmation is the only
 * receipt, and it names the address the message went to rather than saying
 * "sent" and leaving the person to wonder where.
 */
export function HelpRequestForm({ defaultEmail }: HelpRequestFormProps) {
  const topicId = useId();
  const emailId = useId();
  const ccId = useId();
  const messageId = useId();
  const countId = useId();
  const attachmentsId = useId();

  const formRef = useRef<HTMLFormElement>(null);

  // "" is the unselected state — the picker opens on no topic at all.
  const [topic, setTopic] = useState<HelpTopic | "">("");
  const [messageLength, setMessageLength] = useState(0);
  // Held in React, not in the form: `form.reset()` clears a file input, but a
  // file input cannot be *given* files, so removing one from the list has to
  // work the other way round.
  const [files, setFiles] = useState<File[]>([]);
  const [receipt, setReceipt] = useState<HelpRequestReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      let result;

      try {
        result = await submitHelpRequestAction(
          {
            topic: formData.get("topic"),
            replyTo: formData.get("replyTo"),
            cc: formData.get("cc"),
            message: formData.get("message"),
          },
          files,
        );
      } catch {
        // Attachments make the request big enough that it can fail before the
        // action runs — a dropped connection, or a proxy with a smaller body
        // limit than ours. The action's own failures come back as values, so
        // anything thrown here is the transport.
        setError(
          files.length > 0
            ? "We couldn't upload that. Check your connection, or send the message with fewer attachments."
            : "We couldn't reach the server. Check your connection and try again.",
        );
        return;
      }

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      setReceipt(result.data);
      formRef.current?.reset();
      setTopic("");
      setMessageLength(0);
      setFiles([]);
    });
  }

  if (receipt) {
    return (
      <Confirmation receipt={receipt} onDismiss={() => setReceipt(null)} />
    );
  }

  return (
    <form ref={formRef} action={submit} className="flex flex-col gap-4">
      <Field
        id={topicId}
        label="Topic"
        hint={topic === "" ? HELP_TOPIC_PLACEHOLDER_HINT : HELP_TOPIC_HINTS[topic]}
        error={fieldErrors.topic}
      >
        <select
          id={topicId}
          name="topic"
          required
          value={topic}
          onChange={(event) => setTopic(event.target.value as HelpTopic | "")}
          disabled={pending}
          aria-invalid={fieldErrors.topic ? true : undefined}
          aria-describedby={`${topicId}-hint`}
          className={cn(
            FIELD_CLASSES,
            "h-10",
            // A native select gives the placeholder the same weight as a real
            // answer. Graying it keeps "nothing chosen yet" readable at a
            // glance, which is the whole point of opening unselected.
            topic === "" && "text-gray-400",
            fieldErrors.topic && INVALID_CLASSES,
          )}
        >
          {/* Selectable only until something else is picked: `required` then
              blocks submission, so nobody sends a request nobody can route. */}
          <option value="" disabled>
            {HELP_TOPIC_PLACEHOLDER}
          </option>
          {HELP_TOPICS.map((option) => (
            <option key={option} value={option} className="text-gray-950">
              {HELP_TOPIC_LABELS[option]}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={emailId}
          label="Your email"
          hint="Where the reply goes. Change it to reach a shared inbox instead."
          error={fieldErrors.replyTo}
        >
          <input
            id={emailId}
            name="replyTo"
            type="email"
            required
            defaultValue={defaultEmail}
            disabled={pending}
            aria-invalid={fieldErrors.replyTo ? true : undefined}
            aria-describedby={`${emailId}-hint`}
            className={cn(
              FIELD_CLASSES,
              "h-10",
              fieldErrors.replyTo && INVALID_CLASSES,
            )}
          />
        </Field>

        <Field
          id={ccId}
          label="Copy someone (optional)"
          hint={`Up to ${MAX_CC_RECIPIENTS}, separated by commas. They see the request and every reply.`}
          error={fieldErrors.cc}
        >
          <input
            id={ccId}
            name="cc"
            type="text"
            inputMode="email"
            placeholder="colleague@restaurant.com"
            disabled={pending}
            aria-invalid={fieldErrors.cc ? true : undefined}
            aria-describedby={`${ccId}-hint`}
            className={cn(FIELD_CLASSES, "h-10", fieldErrors.cc && INVALID_CLASSES)}
          />
        </Field>
      </div>

      <Field
        id={messageId}
        label="How can we help?"
        error={fieldErrors.message}
      >
        <textarea
          id={messageId}
          name="message"
          required
          rows={8}
          maxLength={MAX_HELP_MESSAGE_LENGTH}
          disabled={pending}
          onChange={(event) => setMessageLength(event.target.value.length)}
          aria-invalid={fieldErrors.message ? true : undefined}
          aria-describedby={cn(fieldErrors.message && `${messageId}-hint`, countId)}
          placeholder={
            topic === "bug"
              ? "What you were doing, what you expected, and what happened instead. A location or mention name helps us find it."
              : "The more context you can give us, the faster we can help."
          }
          className={cn(
            FIELD_CLASSES,
            "resize-y py-2.5 leading-6",
            fieldErrors.message && INVALID_CLASSES,
          )}
        />
        <p id={countId} className="text-right text-[12px] text-gray-400 tabular-nums">
          {messageLength} / {MAX_HELP_MESSAGE_LENGTH}
        </p>
      </Field>

      <Field
        id={attachmentsId}
        label="Attach a screenshot or video (optional)"
        hint={ATTACHMENT_LIMITS_HINT}
        error={fieldErrors.attachments}
      >
        <AttachmentDropzone
          id={attachmentsId}
          files={files}
          onChange={setFiles}
          disabled={pending}
          error={fieldErrors.attachments}
        />
      </Field>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle
            className="mt-px size-4 shrink-0 text-red-600"
            aria-hidden
          />
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
        <p className="text-[12px] text-gray-500">
          We usually reply within one business day.
        </p>
        <Button type="submit" variant="primary" icon={Send} disabled={pending}>
          {pending ? "Sending…" : "Send message"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-gray-950">
        {label}
      </label>
      {children}
      {/* One slot, one id: the hint is replaced by the error rather than sitting
          beside it, so a control's description is whichever of the two applies
          and `aria-describedby` never has to change. */}
      {error ? (
        <p
          id={`${id}-hint`}
          role="alert"
          className="text-[12px] font-medium text-red-600"
        >
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12px] text-gray-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The receipt.
 *
 * Says where the message went. When the server is in log mode it says that
 * instead of claiming a delivery — a confirmation for mail that was never sent
 * is worse than an error.
 */
function Confirmation({
  receipt,
  onDismiss,
}: {
  receipt: HelpRequestReceipt;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-start gap-3 rounded-[10px] border border-green-600/25 bg-green-50 px-4 py-5"
    >
      <span className="inline-flex items-center gap-2 text-[15px] font-semibold text-gray-950">
        <CheckCircle2 className="size-5 text-green-600" aria-hidden />
        {receipt.delivered ? "Message sent" : "Message recorded"}
      </span>

      {receipt.delivered ? (
        <p className="text-[13.5px] leading-6 text-gray-700">
          Your request is on its way to{" "}
          <span className="font-medium text-gray-950">{receipt.sentTo}</span>
          {receipt.attached > 0
            ? `, with ${receipt.attached === 1 ? "your attachment" : `all ${receipt.attached} attachments`}`
            : ""}
          . We usually reply within one business day, and the reply will come
          straight back to you
          {receipt.cc.length > 0 ? ` and to ${receipt.cc.join(", ")}` : ""}.
        </p>
      ) : (
        <p className="text-[13.5px] leading-6 text-gray-700">
          This server is running with email delivery turned off, so the request
          was written to the server log instead of being sent. Set{" "}
          <code className="rounded bg-white px-1 py-0.5 font-mono text-[12px] text-gray-950">
            RESEND_API_KEY
          </code>{" "}
          to deliver it for real.
        </p>
      )}

      <Button type="button" variant="secondary" onClick={onDismiss}>
        Send another request
      </Button>
    </div>
  );
}
