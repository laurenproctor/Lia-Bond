"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { switchOrganizationAction } from "@/app/actions/organization";
import { cn } from "@/lib/cn";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";
import type { OrganizationMembership } from "@/domain";

export interface OrgSwitcherProps {
  /** Every organization the signed-in user actually belongs to. */
  organizations: OrganizationMembership[];
  activeOrganizationId: string;
  compact?: boolean;
}

/**
 * Organization scope for everything downstream.
 *
 * The list only ever contains organizations the caller is a verified member of,
 * and the switch goes through a server action that re-checks membership before
 * writing the cookie. Selecting is therefore a preference, not a privilege.
 */
export function OrgSwitcher({
  organizations,
  activeOrganizationId,
  compact = false,
}: OrgSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const active =
    organizations.find((entry) => entry.organization.id === activeOrganizationId) ??
    organizations[0];

  function select(organizationId: string) {
    setError(null);
    startTransition(async () => {
      const result = await switchOrganizationAction({ organizationId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);

      // Navigate, rather than staying put and re-rendering.
      //
      // Switching used to leave the browser on whatever URL it was on. On
      // `/overview` that is invisible; on any record-detail route it is a 404,
      // because the page re-renders under the new organization's scope and asks
      // it for the old organization's record id. The lookup fails safely — that
      // is the scope working — but `notFound()` is a poor way to learn you
      // changed tenant.
      //
      // `/overview` unconditionally, rather than "stay put when the route is
      // tenant-agnostic": that safe set is not stable. `/mentions`,
      // `/responses`, and `/escalations` all carry record ids in query params
      // today, and a rule that has to be re-derived every time a screen gains a
      // selection parameter will be wrong within a workflow or two. One
      // destination cannot rot.
      router.push("/overview");
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2 rounded-[10px] border border-white/10 bg-white/5 text-left transition-colors hover:bg-white/10",
          compact ? "justify-center p-2" : "px-3 py-2.5",
        )}
      >
        {compact ? (
          <span className="text-[13px] font-semibold text-white">
            {active?.organization.name.slice(0, 1) ?? "L"}
            <span className="sr-only">
              {active?.organization.name}. Change organization
            </span>
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold text-white">
                {active?.organization.name ?? "No organization"}
              </span>
              <span className="block truncate text-[12px] text-white/55">
                {active ? MEMBERSHIP_ROLE_LABELS[active.role] : "—"}
              </span>
            </span>
            {pending ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-white/55" aria-hidden />
            ) : (
              <ChevronsUpDown className="size-4 shrink-0 text-white/55" aria-hidden />
            )}
          </>
        )}
      </button>

      {open ? (
        <div className="absolute top-full left-0 z-30 mt-1.5 w-[min(17rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-gray-200 bg-white shadow-panel">
          <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
            Your organizations
          </p>

          {/* `role="listbox"` belongs on the list, not on the popover.
              Everything a listbox contains is announced as an option, and the
              popover also holds an error line and the create link — neither of
              which is an organization anybody can select. Putting the role here
              keeps the options list honest and leaves the rest as ordinary
              content. */}
          <ul
            role="listbox"
            aria-label="Organization"
            className="max-h-64 overflow-y-auto pb-1.5"
          >
            {organizations.map((entry) => (
              <li key={entry.organization.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={entry.organization.id === activeOrganizationId}
                  disabled={pending}
                  onClick={() => select(entry.organization.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-gray-950">
                      {entry.organization.name}
                    </span>
                    <span className="block truncate text-[12px] text-gray-500">
                      {MEMBERSHIP_ROLE_LABELS[entry.role]}
                    </span>
                  </span>
                  {entry.organization.id === activeOrganizationId ? (
                    <Check className="size-4 shrink-0 text-purple-600" aria-hidden />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {error ? (
            <p role="alert" className="border-t border-gray-200 px-3 py-2 text-[12px] text-red-600">
              {error}
            </p>
          ) : null}

          {/* Outside the listbox, deliberately: it is not one of the caller's
              organizations and must not be announced as a selectable option.
              Rendered for everyone regardless of their role here — creating an
              organization is a property of holding an account, not of any
              standing in the one currently active, so there is no permission to
              check and none should be added. */}
          <div className="border-t border-gray-200 p-1.5">
            <Link
              href="/organizations/new"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
            >
              <Plus className="size-4 shrink-0 text-gray-400" aria-hidden />
              Create organization
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
