"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { OrgSwitcher } from "@/components/shell/org-switcher";
import { UserMenu, type UserMenuUser } from "@/components/shell/user-menu";
import { cn } from "@/lib/cn";
import { NAV_SECTIONS, isNavItemActive } from "@/lib/navigation";
import type { OrganizationMembership } from "@/domain";

export interface SidebarProps {
  organizations: OrganizationMembership[];
  activeOrganizationId: string;
  user: UserMenuUser;
  badgeCounts: { mentions: number; escalations: number };
  /** True when the app is serving the demo fixture rather than a database. */
  demoMode: boolean;
}

/**
 * Primary navigation.
 *
 * Three widths, one component: a full rail at `xl`, an icon rail from `md`, and
 * an off-canvas drawer below that. The drawer is the only piece that holds
 * state, so the shell stays server-rendered everywhere else.
 */
export function Sidebar({
  organizations,
  activeOrganizationId,
  user,
  badgeCounts,
  demoMode,
}: SidebarProps) {
  const pathname = usePathname() ?? "";
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpen]);

  return (
    <>
      {/* Compact header, below md only. */}
      <header className="bg-navy-950 sticky top-0 z-30 flex h-14 items-center gap-3 px-4 md:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-expanded={drawerOpen}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-white/10 text-white"
        >
          <Menu className="size-4.5" aria-hidden />
          <span className="sr-only">Open navigation</span>
        </button>
        <Logo compact />
      </header>

      {drawerOpen ? (
        <button
          type="button"
          className="bg-navy-950/50 fixed inset-0 z-40 md:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <span className="sr-only">Close navigation</span>
        </button>
      ) : null}

      <nav
        aria-label="Primary"
        data-surface="dark"
        className={cn(
          "bg-navy-950 flex shrink-0 flex-col",
          // Off-canvas below md, static from md up.
          "fixed inset-y-0 left-0 z-50 w-60 -translate-x-full transition-transform duration-200 md:static md:z-auto md:translate-x-0 md:transition-none",
          "md:w-16 xl:w-60",
          drawerOpen && "translate-x-0",
        )}
      >
        <div className="flex h-14 items-center justify-between px-4 md:h-16 md:justify-center xl:justify-start xl:px-5">
          <Logo className="md:hidden xl:block" />
          <Logo compact className="hidden md:block xl:hidden" />
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="inline-flex size-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 md:hidden"
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Close navigation</span>
          </button>
        </div>

        {/* Two renders of the same control: the icon rail cannot fit the full
            one, and a CSS-only collapse would leave the labels in the DOM. */}
        <div className="px-3 pb-3 md:hidden xl:block xl:px-3">
          <OrgSwitcher
            organizations={organizations}
            activeOrganizationId={activeOrganizationId}
          />
          {demoMode ? <DemoBadge /> : null}
        </div>
        <div className="hidden px-2 pb-3 md:block xl:hidden">
          <OrgSwitcher
            organizations={organizations}
            activeOrganizationId={activeOrganizationId}
            compact
          />
        </div>

        <div className="lia-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4 md:px-2 xl:px-3">
          {NAV_SECTIONS.map((section) => (
            <div key={section.id} className="mb-4 last:mb-0">
              {section.label ? (
                <p className="px-2.5 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-white/35 uppercase md:hidden xl:block">
                  {section.label}
                </p>
              ) : null}
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const active = isNavItemActive(item, pathname);
                  const badge = item.badgeKey ? badgeCounts[item.badgeKey] : 0;

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        title={item.label}
                        // A navigation is a dismissal — never leave the drawer
                        // covering the page the user just asked for.
                        onClick={() => setDrawerOpen(false)}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                          "md:justify-center md:px-0 xl:justify-start xl:px-2.5",
                          active
                            ? "bg-purple-600 text-white"
                            : "text-white/65 hover:bg-white/8 hover:text-white",
                        )}
                      >
                        <span className="relative shrink-0">
                          <item.icon className="size-4.5" aria-hidden />
                          {/* The icon rail has no room for the count, so it
                              keeps a dot to show there is work waiting. */}
                          {badge > 0 ? (
                            <span
                              className={cn(
                                "absolute -top-0.5 -right-0.5 hidden size-2 rounded-full ring-2 md:block xl:hidden",
                                item.badgeKey === "escalations"
                                  ? "bg-red-600"
                                  : "bg-purple-400",
                                active ? "ring-purple-600" : "ring-navy-950",
                              )}
                              aria-hidden
                            />
                          ) : null}
                        </span>
                        <span className="flex-1 truncate md:hidden xl:block">
                          {item.label}
                        </span>
                        {badge > 0 ? (
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                              "md:hidden xl:inline-block",
                              item.badgeKey === "escalations"
                                ? "bg-red-600 text-white"
                                : active
                                  ? "bg-white/25 text-white"
                                  : "bg-purple-600 text-white",
                            )}
                          >
                            {badge}
                            <span className="sr-only"> needing attention</span>
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-white/10 p-3 md:hidden xl:block">
          <UserMenu user={user} />
        </div>
        <div className="hidden border-t border-white/10 p-2 md:block xl:hidden">
          <UserMenu user={user} compact />
        </div>
      </nav>
    </>
  );
}

/**
 * Marks the shell when no database is configured.
 *
 * Demo records look exactly like real ones, and mistaking the two is the only
 * genuinely dangerous thing about the fallback mode — so it says so.
 */
function DemoBadge() {
  return (
    <p className="mt-2 rounded-md bg-amber-600/15 px-2 py-1 text-[11px] font-medium text-amber-100">
      Demo data — no database connected
    </p>
  );
}
