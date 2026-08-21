import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { cn } from "@/lib/cn";

export interface AppShellProps {
  children: ReactNode;
  sidebar: Omit<Parameters<typeof Sidebar>[0], "children">;
  /**
   * A strip above the page content. Billing uses it, and nothing else does
   * yet — a slot rather than a `BillingBanner` import so the shell keeps
   * knowing nothing about billing.
   */
  banner?: ReactNode;
}

/**
 * One shell for every route.
 *
 * The sidebar is fixed, the content column scrolls, and pages that need a
 * split view opt into a full-height layout with `PageBody variant="fill"`.
 */
export function AppShell({ children, sidebar, banner }: AppShellProps) {
  return (
    <div className="flex min-h-dvh flex-col md:h-dvh md:flex-row md:overflow-hidden">
      <Sidebar {...sidebar} />
      <main
        id="main"
        className="lia-scroll flex min-w-0 flex-1 flex-col md:overflow-y-auto"
      >
        {/* Above the scroll container's content but inside it, so a long page
            scrolls the banner away rather than pinning it. A billing notice
            that follows somebody down every screen is the kind of thing people
            learn to stop seeing. */}
        {banner}
        {children}
      </main>
    </div>
  );
}

export interface PageBodyProps {
  children: ReactNode;
  /**
   * `scroll` lets the page grow and the content column scroll — the default
   * for dashboards and tables. `fill` pins the page to the viewport so a split
   * view can scroll its two halves independently.
   */
  variant?: "scroll" | "fill";
  className?: string;
}

export function PageBody({
  children,
  variant = "scroll",
  className,
}: PageBodyProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-5 px-5 py-5 lg:px-7 lg:py-6",
        variant === "fill" ? "min-h-0 flex-1 md:overflow-hidden" : "",
        className,
      )}
    >
      {children}
    </div>
  );
}
