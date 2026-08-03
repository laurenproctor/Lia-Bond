import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { cn } from "@/lib/cn";

export interface AppShellProps {
  children: ReactNode;
  sidebar: Omit<Parameters<typeof Sidebar>[0], "children">;
}

/**
 * One shell for every route.
 *
 * The sidebar is fixed, the content column scrolls, and pages that need a
 * split view opt into a full-height layout with `PageBody variant="fill"`.
 */
export function AppShell({ children, sidebar }: AppShellProps) {
  return (
    <div className="flex min-h-dvh flex-col md:h-dvh md:flex-row md:overflow-hidden">
      <Sidebar {...sidebar} />
      <main
        id="main"
        className="lia-scroll flex min-w-0 flex-1 flex-col md:overflow-y-auto"
      >
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
