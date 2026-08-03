import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

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
