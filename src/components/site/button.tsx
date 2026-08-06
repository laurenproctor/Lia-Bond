import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The two marketing buttons.
 *
 * The primary carries an ink label on the brand orange, not a white one. White
 * on #FF7A2E measures 2.60:1 — below AA and below even the 3:1 large-text
 * floor — and darkening the fill instead would replace the signature colour on
 * every page's main action. `tests/site-palette.test.ts` holds this in place.
 */

export function PrimaryButton({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-[10px] bg-site-orange px-5 py-3 text-[14px] font-semibold text-site-ink transition-colors hover:bg-site-orange-hover ${className ?? ""}`}
    >
      {children}
    </Link>
  );
}

export function SecondaryButton({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-[10px] border border-site-blue-edge px-5 py-3 text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint ${className ?? ""}`}
    >
      {children}
    </Link>
  );
}
