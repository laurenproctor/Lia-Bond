"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { LogoMark } from "@/components/site/logo-mark";
import { SITE_NAV } from "@/lib/site/routes";

/**
 * The one navigation every public page renders.
 *
 * A client component solely for the mobile disclosure. The links themselves are
 * static and the sign-in link needs no session check: `/sign-in` already
 * forwards an authenticated visitor to `/overview` (see `src/middleware.ts`),
 * so the marketing site never reads a session and every page stays statically
 * renderable.
 */
export function SiteNav() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-40 border-b border-site-border bg-white/85 backdrop-blur-[12px] backdrop-saturate-[140%]">
      <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-6 px-[clamp(24px,6vw,106px)] py-3.5">
        <Link
          href="/"
          className="flex items-center text-site-ink"
          aria-label="Lia, home"
        >
          <LogoMark />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <div className="flex items-center gap-7">
            {SITE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[14.5px] font-medium text-site-body transition-colors hover:text-site-ink"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/sign-in"
              className="text-[14.5px] font-medium text-site-body transition-colors hover:text-site-ink"
            >
              Sign in
            </Link>
          </div>
          <PrimaryNavCta />
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-site-border text-site-ink md:hidden"
          aria-expanded={open}
          aria-controls="site-nav-mobile"
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
      </div>

      {open ? (
        <div
          id="site-nav-mobile"
          className="border-t border-site-border bg-white px-[clamp(24px,6vw,106px)] py-4 md:hidden"
        >
          <div className="flex flex-col gap-4">
            {SITE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="text-[15px] font-medium text-site-body"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/sign-in"
              onClick={() => setOpen(false)}
              className="text-[15px] font-medium text-site-body"
            >
              Sign in
            </Link>
            <PrimaryNavCta onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </nav>
  );
}

function PrimaryNavCta({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/#access"
      onClick={onNavigate}
      className="inline-flex items-center justify-center rounded-[9px] bg-site-orange px-5 py-2.5 text-[14px] font-semibold whitespace-nowrap text-site-ink transition-colors hover:bg-site-orange-hover"
    >
      Request early access
    </Link>
  );
}
