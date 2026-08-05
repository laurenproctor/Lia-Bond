"use client";

import { useEffect } from "react";
import { SecondaryButton } from "@/components/site/button";
import { Lede, Section, SectionHeading } from "@/components/site/section";

/**
 * The marketing site's error boundary.
 *
 * These pages are static and have almost nothing to fail, so this is a
 * genuinely rare screen. It stays on-brand and offers the one action that is
 * always safe — go back to the top of the site — rather than a reload loop.
 */
export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is what correlates this with the server log. The message
    // itself is never rendered: it can carry internals a visitor should not see.
    console.error("Marketing site error", error.digest);
  }, [error]);

  return (
    <Section>
      <div className="mx-auto max-w-[560px] text-center">
        <SectionHeading>Something went wrong on our end.</SectionHeading>
        <Lede className="mt-4">
          The page did not load. Trying again usually works; if it does not, the
          rest of the site is unaffected.
        </Lede>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {/* Not a PrimaryButton: that renders a Link, and this needs a real
              button to call `reset`. The classes are the same by hand. */}
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center rounded-[10px] bg-site-orange px-5 py-3 text-[14px] font-semibold text-site-ink transition-colors hover:bg-site-orange-hover"
          >
            Try again
          </button>
          <SecondaryButton href="/">Back to home</SecondaryButton>
        </div>
      </div>
    </Section>
  );
}
