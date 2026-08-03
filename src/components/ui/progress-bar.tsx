import { cn } from "@/lib/cn";

export type ProgressTone = "purple" | "green" | "amber" | "red" | "neutral";

const TONE_CLASSES: Record<ProgressTone, string> = {
  purple: "bg-purple-600",
  green: "bg-green-600",
  amber: "bg-amber-600",
  red: "bg-red-600",
  neutral: "bg-gray-400",
};

export interface ProgressBarProps {
  /** 0–100. */
  value: number;
  tone?: ProgressTone;
  label: string;
  className?: string;
}

export function ProgressBar({
  value,
  tone = "purple",
  label,
  className,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <span
      className={cn(
        "block h-1.5 w-full overflow-hidden rounded-full bg-gray-200",
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span
        className={cn("block h-full rounded-full", TONE_CLASSES[tone])}
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}
