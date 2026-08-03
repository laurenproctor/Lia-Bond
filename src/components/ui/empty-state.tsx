import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
  size?: "sm" | "md";
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
  size = "md",
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "md" ? "px-6 py-14" : "px-4 py-8",
        className,
      )}
    >
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-gray-100 text-gray-500">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-semibold text-gray-950">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-[13px] text-gray-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
