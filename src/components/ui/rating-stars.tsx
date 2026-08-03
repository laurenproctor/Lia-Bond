import { Star } from "lucide-react";
import { cn } from "@/lib/cn";

const SIZES = {
  sm: "size-3.5",
  md: "size-4",
} as const;

export interface RatingStarsProps {
  rating: number;
  max?: number;
  size?: keyof typeof SIZES;
  className?: string;
}

export function RatingStars({
  rating,
  max = 5,
  size = "sm",
  className,
}: RatingStarsProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      role="img"
      aria-label={`${rating} out of ${max} stars`}
    >
      {Array.from({ length: max }, (_, index) => (
        <Star
          key={index}
          className={cn(
            SIZES[size],
            index < Math.round(rating)
              ? "fill-amber-600 text-amber-600"
              : "fill-gray-200 text-gray-200",
          )}
          aria-hidden
        />
      ))}
    </span>
  );
}
