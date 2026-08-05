import Link from "next/link";
import { LogoMark } from "@/components/site/logo-mark";
import { SITE_FOOTER } from "@/lib/site/routes";

/**
 * Rendered from the route table, so a page added to the table appears here
 * without a second edit — and cannot appear here while missing from the
 * middleware allowlist.
 *
 * `data-surface="dark"` switches the focus ring to white, reusing the rule the
 * product already defines for its navy surfaces.
 */
export function SiteFooter() {
  return (
    <footer className="bg-site-ink text-white" data-surface="dark">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-10 px-[clamp(24px,6vw,106px)] pt-[clamp(56px,6vw,84px)] pb-9 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:gap-[clamp(40px,6vw,110px)]">
        <div>
          <div className="mb-4 text-[#f3efe6]">
            <LogoMark className="text-[34px]" />
          </div>
          <p className="mb-2 max-w-[260px] text-[18px] leading-[1.4] text-[#e6eaf0]">
            Public feedback, handled with care.
          </p>
          <p className="text-[13px] text-site-muted-dark">Lia.bond</p>
        </div>

        {SITE_FOOTER.map((column) => (
          <div key={column.heading}>
            <h2 className="mb-4 text-[12px] font-semibold tracking-[0.12em] text-site-muted-dark uppercase">
              {column.heading}
            </h2>
            <div className="flex flex-col gap-3">
              {column.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-[14px] text-[#e6eaf0] transition-colors hover:text-white"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-4 border-t border-[#3a4454] px-[clamp(24px,6vw,106px)] pt-4.5 pb-7">
        <span className="text-[12.5px] text-site-muted-dark">
          © 2026 Lia Bond. All rights reserved.
        </span>
        <span className="text-[12.5px] text-site-muted-dark">
          Respond with care, clarity, and control.
        </span>
      </div>
    </footer>
  );
}
