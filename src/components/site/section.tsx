import type { ReactNode } from "react";

/**
 * Page rhythm.
 *
 * The gutter and vertical clamps come from the design reference and are the
 * single reason every marketing page lines up. Pages set content; they do not
 * set spacing.
 */

const SHELL = "mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)]";

export function Section({
  children,
  tinted = false,
  className,
  id,
}: {
  children: ReactNode;
  /** The alternating pale fill, with hairlines top and bottom. */
  tinted?: boolean;
  className?: string;
  id?: string;
}) {
  const band = tinted
    ? "bg-site-tint border-y border-site-border"
    : "bg-white";

  return (
    <section id={id} className={band}>
      <div
        className={`${SHELL} py-[clamp(56px,8vw,100px)] ${className ?? ""}`}
      >
        {children}
      </div>
    </section>
  );
}

/** The dot-and-tracked-caps label that opens a section. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 inline-flex items-center gap-2.5">
      <span className="size-1.5 rounded-full bg-site-blue-mark shadow-[0_0_0_4px_rgb(13_136_255_/_0.16)]" />
      <span className="text-[12.5px] font-semibold tracking-[0.16em] text-site-muted uppercase">
        {children}
      </span>
    </div>
  );
}

export function PageHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={`text-[clamp(38px,5vw,64px)] leading-[1.04] font-bold tracking-[-0.022em] text-site-ink ${className ?? ""}`}
    >
      {children}
    </h1>
  );
}

export function SectionHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={`text-[clamp(26px,3.4vw,40px)] leading-[1.12] font-bold tracking-[-0.018em] text-site-ink ${className ?? ""}`}
    >
      {children}
    </h2>
  );
}

export function Lede({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={`text-[19px] leading-[1.58] text-site-body ${className ?? ""}`}>
      {children}
    </p>
  );
}
