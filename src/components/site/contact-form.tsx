"use client";

import { useState } from "react";
import { submitContactMessageAction } from "@/app/actions/contact";
import { SpeechBubble } from "@/components/site/speech-bubble";
import { Lede, SectionHeading } from "@/components/site/section";
import { MAX_CONTACT_MESSAGE_LENGTH } from "@/lib/site/contact-message";

/**
 * The one interactive element on the marketing site.
 *
 * It used to capture an address alone and promise a reply. That made the
 * contact page a waiting room: a stranger could say *that* they wanted
 * something but not *what*, so every conversation started a round trip behind
 * where it could have. It now takes the question itself and mails it to the
 * support inbox, where hitting reply reaches the person who asked.
 *
 * The address is still recorded, so leads keep landing where they did. What
 * changed is which step is load-bearing — see the note in
 * `@/app/actions/contact`.
 *
 * The success message never distinguishes a first message from a repeat one.
 * It could — the action knows whether the row was new — but a form that says
 * "you have written before" is an oracle a stranger can query for whether a
 * given address uses Lia. One sentence for both cases costs nothing and
 * closes that.
 */

const FIELD =
  "w-full rounded-[10px] border border-site-field px-4 py-3 text-[15px] text-site-ink outline-none placeholder:text-site-muted focus:border-site-blue disabled:opacity-60";

const LABEL = "mb-1.5 block text-[13.5px] font-semibold text-site-ink";

export function ContactForm({
  sourcePath,
  className,
}: {
  /** Which page this instance sits on, recorded with the message. */
  sourcePath: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: a failure can be generic (a honeypot rejection, a
  // mail provider that refused) with nothing wrong with what was typed. Only a
  // message keyed to a field in `fieldErrors` should mark that input invalid.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(formData: FormData) {
    setState("sending");
    setError(null);
    setFieldErrors({});

    const result = await submitContactMessageAction({
      name: formData.get("name"),
      email: formData.get("email"),
      businessName: formData.get("businessName"),
      message: formData.get("message"),
      sourcePath,
      website: formData.get("website"),
    });

    if (result.ok) {
      setState("sent");
      return;
    }

    setState("idle");
    setError(result.error);
    setFieldErrors(result.fieldErrors ?? {});
  }

  if (state === "sent") {
    return (
      <div
        // `site-blue-tint` rather than a one-off hex: the palette has no
        // dedicated "success" hue, and this pale blue already reads as an
        // affirmative, low-alarm surface everywhere else it appears.
        className={`rounded-[14px] border border-site-blue-edge bg-site-blue-tint px-6 py-5 text-center ${className ?? ""}`}
        // Announced because the form it replaces is gone by the time a screen
        // reader would reach it.
        role="status"
      >
        <p className="text-[15px] font-semibold text-site-ink">
          Thanks — your message is with us.
        </p>
        <p className="mt-1.5 text-[14px] text-site-body">
          Someone who works on Lia will reply to you directly, usually within a
          working day.
        </p>
      </div>
    );
  }

  const sending = state === "sending";

  return (
    <form action={onSubmit} className={className}>
      {/* `relative`: the honeypot below is positioned `absolute` against the
          nearest positioned ancestor, and this component should not depend on
          an ancestor elsewhere in the tree happening to supply one — that
          would make its off-screen placement, and so its effectiveness,
          coincidental to wherever it is mounted. */}
      <div className="relative mx-auto flex max-w-[560px] flex-col gap-4 text-left">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="contact-name" className={LABEL}>
              Your name
            </label>
            <input
              id="contact-name"
              name="name"
              type="text"
              required
              autoComplete="name"
              disabled={sending}
              aria-describedby={
                fieldErrors.name ? "contact-name-error" : undefined
              }
              aria-invalid={fieldErrors.name ? true : undefined}
              className={FIELD}
            />
            <FieldError id="contact-name-error" message={fieldErrors.name} />
          </div>

          <div>
            <label htmlFor="contact-email" className={LABEL}>
              Work email
            </label>
            <input
              id="contact-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              disabled={sending}
              aria-describedby={
                fieldErrors.email ? "contact-email-error" : undefined
              }
              aria-invalid={fieldErrors.email ? true : undefined}
              className={FIELD}
            />
            <FieldError id="contact-email-error" message={fieldErrors.email} />
          </div>
        </div>

        <div>
          <label htmlFor="contact-business" className={LABEL}>
            Business{" "}
            <span className="font-normal text-site-muted">(optional)</span>
          </label>
          <input
            id="contact-business"
            name="businessName"
            type="text"
            autoComplete="organization"
            disabled={sending}
            aria-describedby={
              fieldErrors.businessName ? "contact-business-error" : undefined
            }
            aria-invalid={fieldErrors.businessName ? true : undefined}
            className={FIELD}
          />
          <FieldError
            id="contact-business-error"
            message={fieldErrors.businessName}
          />
        </div>

        <div>
          <label htmlFor="contact-message" className={LABEL}>
            What can we help with?
          </label>
          <textarea
            id="contact-message"
            name="message"
            required
            rows={5}
            maxLength={MAX_CONTACT_MESSAGE_LENGTH}
            disabled={sending}
            placeholder="How many locations you run, which platforms you are on, and what you are trying to fix."
            aria-describedby={
              fieldErrors.message ? "contact-message-error" : undefined
            }
            aria-invalid={fieldErrors.message ? true : undefined}
            className={`${FIELD} resize-y leading-[1.6]`}
          />
          <FieldError
            id="contact-message-error"
            message={fieldErrors.message}
          />
        </div>

        {/* Honeypot. Hidden from people, tempting to form-fillers. Not
            `display:none`, which some bots skip; off-screen and untabbable. */}
        <div className="absolute left-[-9999px]" aria-hidden="true">
          <label htmlFor="contact-website">Website</label>
          <input
            id="contact-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </div>

        <button
          type="submit"
          disabled={sending}
          className="rounded-[10px] bg-site-orange px-6 py-3.5 text-[15px] font-semibold text-site-ink transition-colors hover:bg-site-orange-hover disabled:opacity-70"
        >
          {sending ? "Sending…" : "Send message"}
        </button>

        {error ? (
          // `red-600` rather than a hand-written hex: the site palette defines
          // no error/risk hue of its own, and this is the same red every other
          // form error in the app already uses — reusing it beats inventing a
          // one-off value that would drift from that convention.
          <p role="alert" className="text-[13px] text-red-600">
            {error}
          </p>
        ) : null}

        <p className="text-[12.5px] text-site-muted">
          No spam. We will only use this to reply to you.
        </p>
      </div>
    </form>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[12.5px] text-red-600">
      {message}
    </p>
  );
}

/**
 * The closing section on `/contact`, with the bubbles that frame it.
 *
 * Every other page closes on `ClosingCta` instead, which sends people to
 * `/sign-up`. `id="access"` is kept for the same reason it is kept there: it
 * was the fragment every in-page CTA pointed at for the life of the site.
 */
export function ContactSection() {
  return (
    <section id="access" className="relative bg-white">
      <div className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] py-[clamp(64px,8vw,110px)]">
        <div className="pointer-events-none absolute -top-7 left-[clamp(8px,4vw,54px)] z-10 hidden lg:block">
          <SpeechBubble
            quote="Live in an afternoon."
            attribution="New customer"
            tone="amber"
            className="w-[186px] -rotate-[5deg]"
          />
        </div>
        <div className="pointer-events-none absolute -bottom-7 right-[clamp(8px,4vw,50px)] z-10 hidden lg:block">
          <SpeechBubble
            quote="Worth every penny."
            attribution="Owner"
            tone="plain"
            className="w-[172px] rotate-[5deg]"
          />
        </div>

        <div className="mx-auto max-w-[620px] text-center">
          <SectionHeading>Tell us what you need.</SectionHeading>
          <Lede className="mt-4.5 mb-7">
            Write what you are trying to fix and we will come back with an
            answer, not a sequence.
          </Lede>
          <ContactForm sourcePath="/contact" />
        </div>
      </div>
    </section>
  );
}
