import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-7 text-[11px]",
  md: "size-9 text-[13px]",
  lg: "size-11 text-sm",
} as const;

export interface AvatarProps {
  initials: string;
  name?: string;
  size?: keyof typeof SIZES;
  tone?: "light" | "dark";
  className?: string;
}

export function Avatar({
  initials,
  name,
  size = "md",
  tone = "light",
  className,
}: AvatarProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        tone === "light"
          ? "bg-gray-100 text-gray-700 ring-1 ring-gray-200 ring-inset"
          : "bg-purple-600 text-white",
        SIZES[size],
        className,
      )}
      role="img"
      aria-label={name ?? initials}
    >
      {initials}
    </span>
  );
}
