import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteNav } from "@/components/site/site-nav";
import { BubbleFilters } from "@/components/site/speech-bubble";
import { appOrigin } from "@/lib/env";

/**
 * The public marketing shell.
 *
 * Declared here rather than in the root layout so Next preloads Geist only on
 * marketing routes; the product loads Inter the same way in `(app)/layout.tsx`.
 *
 * `font-site` alongside the variable is not redundant — `body` resolves its
 * font-family above this element, where `--font-geist` is undefined, and
 * descendants inherit that computed value. The utility re-declares the family
 * where the variable is in scope.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
});

export const metadata: Metadata = {
  metadataBase: new URL(appOrigin()),
  title: {
    default: "Lia — know what to say when your reputation is public",
    template: "%s · Lia",
  },
  description:
    "Lia monitors your reviews, forums, and press from one workspace, drafts replies in your voice, and holds the sensitive ones for a person to approve.",
  openGraph: {
    siteName: "Lia",
    type: "website",
    locale: "en_US",
  },
};

export const viewport: Viewport = {
  // Overrides the product's navy. The marketing site is white.
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div
      // `data-surface="site"` scopes the blue focus ring and selection colour
      // defined in globals.css, leaving the product's purple untouched.
      data-surface="site"
      className={`${geist.variable} font-site flex min-h-dvh flex-col bg-white text-[15px] leading-normal text-site-body`}
    >
      {/* Rendered once here rather than per page. Every page reaches the
          speech bubbles through `AccessSection` at minimum, and a page that
          used a bubble without these definitions in the document would
          reference a filter id that resolves to nothing. */}
      <BubbleFilters />
      <SiteNav />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
