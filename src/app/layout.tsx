import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

/**
 * The application-wide default, set here rather than per route group.
 *
 * Six routes — /sign-in, /sign-up, /forgot-password, /reset-password, /invite,
 * and /auth — sit directly under `src/app` with no layout of their own, so this
 * is the only place that can give them a typeface. Moving Inter down into
 * `(app)` would silently drop them onto the system stack.
 *
 * The marketing site overrides this in `(site)/layout.tsx`, which declares
 * Geist and re-applies `font-family` via the `font-site` utility. Re-applying
 * is required, not decorative: `body` resolves `var(--font-sans)` here, and
 * descendants inherit that computed value rather than re-resolving the
 * variable.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "Lia — reputation intelligence for restaurants",
    template: "%s · Lia",
  },
  description:
    "Monitor reviews, discussions, and media coverage, draft brand-aware responses, and route sensitive issues from one workspace.",
};

export const viewport: Viewport = {
  themeColor: "#0b1830",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-purple-600 focus:px-3 focus:py-2 focus:text-[13px] focus:font-medium focus:text-white"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
