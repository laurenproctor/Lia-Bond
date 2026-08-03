import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cn("skeleton-shimmer block rounded-md bg-gray-100", className)}
      style={style}
      aria-hidden
    />
  );
}

/** Card-shaped placeholder used by route-level `loading.tsx` files. */
export function SkeletonCard({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("lia-card p-5", className)}>
      <Skeleton className="h-4 w-40" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton
            key={index}
            className={cn("h-3", index === lines - 1 ? "w-2/3" : "w-full")}
          />
        ))}
      </div>
    </div>
  );
}

export function SkeletonRows({
  rows = 6,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("divide-y divide-gray-200", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-4">
          <Skeleton className="size-7 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
      ))}
    </div>
  );
}
