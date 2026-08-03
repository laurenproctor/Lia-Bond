import { cn } from "@/lib/cn";

/** Lia wordmark. The sparkle is decorative; the text carries the name. */
export function Logo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-0.5 font-semibold tracking-tight text-white select-none",
        compact ? "text-lg" : "text-[26px]",
        className,
      )}
    >
      Lia
      <svg
        viewBox="0 0 12 12"
        className={cn("self-start", compact ? "size-2" : "size-2.5")}
        aria-hidden
        focusable="false"
      >
        <path
          d="M6 0 7.3 4.7 12 6 7.3 7.3 6 12 4.7 7.3 0 6l4.7-1.3z"
          fill="var(--color-purple-400)"
        />
      </svg>
      <span className="sr-only">Lia</span>
    </span>
  );
}
