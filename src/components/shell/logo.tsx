import Image from "next/image";
import { cn } from "@/lib/cn";

import mark from "../../../public/lia-logo.png";

/**
 * Lia mark: the wordmark with the speech bubble standing in for the dot on the i.
 *
 * The supplied artwork is neon line art, whose stroke falls below a pixel at the
 * sizes the shell actually renders it, so the asset is the filled silhouette of
 * that mark rather than its outline. `alt` carries the name; there is no
 * separate text beside it.
 */
export function Logo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <Image
      src={mark}
      alt="Lia"
      priority
      className={cn("w-auto select-none", compact ? "h-7" : "h-10", className)}
    />
  );
}
