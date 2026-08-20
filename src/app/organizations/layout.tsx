import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";

/**
 * The organization-creation route group.
 *
 * Sits directly under `src/app`, outside both `(app)` and `(site)`, and each of
 * those exclusions is load-bearing.
 *
 * It cannot live in `(app)`: that layout calls `redirectIfOnboarding()` and
 * `getOrganizationContext()` before it renders anything, and both require an
 * organization. The whole point of this route is the case where the caller has
 * none — or wants one they do not have yet — so the shell would throw on the
 * screen that exists to fix it.
 *
 * It must not live in `(site)`: the marketing pages are public and this is
 * signed-in-only. `src/proxy.ts` lists `/organizations` in `PRODUCT_PATHS` so an
 * anonymous request redirects to `/sign-in?next=…` rather than falling through
 * to a page that would throw.
 *
 * `/onboarding` already occupies exactly this position, and this reuses its
 * chrome deliberately: naming your organization is the same moment in the same
 * journey as configuring it, and the two screens are adjacent in the flow —
 * this one hands straight to `/onboarding/organization`. Geist is declared here
 * for the same reason both other groups declare it: Next then preloads it only
 * on the routes that use it, and the product keeps loading Inter.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
});

export const metadata: Metadata = {
  title: {
    default: "Create an organization",
    template: "%s · Lia",
  },
  // This screen carries a company name and is reachable only with a session.
  // Nothing here belongs in an index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Matches onboarding's light surface rather than the product's navy.
  themeColor: "#f6f9fd",
  width: "device-width",
  initialScale: 1,
};

export default function OrganizationsLayout({ children }: { children: ReactNode }) {
  return <div className={geist.variable}>{children}</div>;
}
