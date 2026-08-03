"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, LifeBuoy, LogOut, Settings, UserRound } from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";
import type { MembershipRole } from "@/domain";

export interface UserMenuUser {
  name: string;
  email: string;
  initials: string;
  role: MembershipRole;
}

export function UserMenu({
  user,
  compact = false,
}: {
  user: UserMenuUser;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-[10px] border border-white/10 bg-white/5 transition-colors hover:bg-white/10",
          compact ? "justify-center p-1.5" : "px-2.5 py-2",
        )}
      >
        <Avatar initials={user.initials} name={user.name} size="sm" tone="dark" />
        {compact ? (
          <span className="sr-only">{user.name}. Open account menu</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[13px] font-semibold text-white">
                {user.name}
              </span>
              <span className="block truncate text-[12px] text-white/55">
                {MEMBERSHIP_ROLE_LABELS[user.role]}
              </span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-white/55" aria-hidden />
          </>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-1.5 w-[min(15rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-gray-200 bg-white py-1.5 shadow-panel"
        >
          <p className="px-3 py-1.5 text-[12px] text-gray-500">{user.email}</p>
          <div className="my-1 border-t border-gray-200" />
          {[
            { label: "Your profile", href: "/settings", icon: UserRound },
            { label: "Organization settings", href: "/settings", icon: Settings },
            { label: "Help center", href: "/settings", icon: LifeBuoy },
          ].map((item) => (
            <Link
              key={item.label}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 hover:text-gray-950"
            >
              <item.icon className="size-4 text-gray-500" aria-hidden />
              {item.label}
            </Link>
          ))}
          <div className="my-1 border-t border-gray-200" />
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-50 hover:text-gray-950"
          >
            <LogOut className="size-4 text-gray-500" aria-hidden />
            Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}
