import { cn } from "@/lib/cn";

export interface SparklineProps {
  points: number[];
  /** Semantic tone of the direction, not of the series. */
  tone: "good" | "bad" | "neutral";
  className?: string;
  width?: number;
  height?: number;
}

const TONE_STROKE: Record<SparklineProps["tone"], string> = {
  good: "var(--color-green-600)",
  bad: "var(--color-red-600)",
  neutral: "var(--color-purple-600)",
};

/**
 * A bare trend shape for KPI cards: no axes, no labels, no tooltip. The number
 * beside it carries the value and the delta chip carries the direction, so the
 * line only has to show shape.
 */
export function Sparkline({
  points,
  tone,
  className,
  width = 76,
  height = 26,
}: SparklineProps) {
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const padding = 2;
  const usableHeight = height - padding * 2;

  const path = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = padding + usableHeight - ((value - min) / range) * usableHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      className={cn("shrink-0 overflow-visible", className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden
      focusable="false"
    >
      <path
        d={path}
        stroke={TONE_STROKE[tone]}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
