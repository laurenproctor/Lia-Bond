"use client";

import { useState } from "react";
import { submitEarlyAccessAction } from "@/app/actions/early-access";
import { SpeechBubble } from "@/components/site/speech-bubble";
import { Lede, SectionHeading } from "@/components/site/section";
import type { IndustrySlug } from "@/lib/site/routes";

/**
 * The one interactive element on the marketing site.
 *
 * The success message never distinguishes a new address from one already on the
 * list. It could — the action knows — but a form that says "you are already
 * registered" is an oracle a stranger can query for whether a given address
 * uses Lia. One sentence for both cases costs nothing and closes that.
 */
export function AccessForm({
  industry,
  sourcePath,
  className,
}: {
  industry?: IndustrySlug;
  /** Which page this instance sits on, recorded with the lead. */
  sourcePath: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setState("sending");
    setError(null);

    const result = await submitEarlyAccessAction({
      email: formData.get("email"),
      businessName: formData.get("businessName"),
      industry: industry ?? null,
      sourcePath,
      website: formData.get("website"),
    });

    if (result.ok) {
      setState("sent");
      return;
    }

    setState("idle");
    setError(result.error);
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
          Thanks — you are on the list.
        </p>
        <p className="mt-1.5 text-[14px] text-site-body">
          We will be in touch about connecting your first location.
        </p>
      </div>
    );
  }

  return (
    <form action={onSubmit} className={className}>
      <div className="mx-auto flex max-w-[520px] flex-wrap gap-3">
        <label htmlFor="access-email" className="sr-only">
          Your work email
        </label>
        <input
          id="access-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="Your work email"
          disabled={state === "sending"}
          aria-describedby={error ? "access-error" : undefined}
          aria-invalid={error ? true : undefined}
          className="min-w-[220px] flex-1 rounded-[10px] border border-site-field px-4 py-3.5 text-[15px] text-site-ink outline-none placeholder:text-site-muted focus:border-site-blue disabled:opacity-60"
        />

        {/* Honeypot. Hidden from people, tempting to form-fillers. Not
            `display:none`, which some bots skip; off-screen and untabbable. */}
        <div className="absolute left-[-9999px]" aria-hidden="true">
          <label htmlFor="access-website">Website</label>
          <input
            id="access-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </div>

        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded-[10px] bg-site-orange px-6 py-3.5 text-[15px] font-semibold whitespace-nowrap text-site-ink transition-colors hover:bg-site-orange-hover disabled:opacity-70"
        >
          {state === "sending" ? "Sending…" : "Request access"}
        </button>
      </div>

      {error ? (
        // `red-600` rather than a hand-written hex: the site palette defines
        // no error/risk hue of its own, and this is the same red every other
        // form error in the app already uses — reusing it beats inventing a
        // one-off value that would drift from that convention.
        <p id="access-error" role="alert" className="mt-3 text-[13px] text-red-600">
          {error}
        </p>
      ) : null}

      <p className="mt-3.5 text-[12.5px] text-site-muted">
        No spam. We will only use this to talk about your reputation workflow.
      </p>
    </form>
  );
}

/**
 * The closing call to action, with the bubbles that frame it on every page.
 * `id="access"` is the target the navigation button and every in-page CTA
 * scroll to.
 */
export function AccessSection({
  industry,
  sourcePath,
}: {
  industry?: IndustrySlug;
  sourcePath: string;
}) {
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
          <SectionHeading>
            Know what to say when your reputation is public.
          </SectionHeading>
          <Lede className="mt-4.5 mb-7">
            Tell us a little about your business and we will set you up with your
            Google reviews to start.
          </Lede>
          <AccessForm industry={industry} sourcePath={sourcePath} />
        </div>
      </div>
    </section>
  );
}
