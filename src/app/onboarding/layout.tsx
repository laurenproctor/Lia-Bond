import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";

/**
 * The onboarding route group.
 *
 * Sits directly under `src/app` rather than inside `(app)`, which is the whole
 * point: `(app)/layout.tsx` renders the navy sidebar and queries badge counts,
 * and both would be wrong here — the counts would read zero for a workspace
 * that has not been configured yet, and a sidebar full of empty screens is a
 * worse first impression than no sidebar at all.
 *
 * Geist is declared here for the same reason `(site)/layout.tsx` declares it:
 * Next then preloads it only on the routes that use it, and the product keeps
 * loading Inter. The `font-site` utility is applied by `OnboardingShell`, where
 * `--font-geist` is in scope — `body` resolves its font-family above this
 * element, where the variable is undefined, and descendants inherit that
 * computed value rather than re-resolving it.
 *
 * No guard runs here. Each page calls `requireOnboardingStep` for its own step,
 * because the answer depends on which step it is — a layout could only ask
 * "is this person onboarding at all", which is not the question that keeps
 * somebody from typing their way to step 4.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
});

export const metadata: Metadata = {
  title: {
    default: "Set up your workspace",
    template: "%s · Lia",
  },
  // Setup screens carry an organization name and a Google account. Nothing here
  // belongs in an index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Overrides the product's navy: onboarding is a light surface.
  themeColor: "#f6f9fd",
  width: "device-width",
  initialScale: 1,
};

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <div className={geist.variable}>{children}</div>;
}
