"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-7 text-[11px]",
  md: "size-9 text-[13px]",
  lg: "size-11 text-sm",
} as const;

export interface AvatarProps {
  initials: string;
  /** A profile photo. Initials render when absent — or when it fails to load. */
  imageUrl?: string | null;
  name?: string;
  size?: keyof typeof SIZES;
  tone?: "light" | "dark";
  className?: string;
}

export function Avatar({
  initials,
  imageUrl,
  name,
  size = "md",
  tone = "light",
  className,
}: AvatarProps) {
  // Tracks which URL failed rather than a boolean, so a new upload gets a
  // fresh attempt without an effect to reset state.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(imageUrl) && imageUrl !== failedUrl;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        tone === "light"
          ? "bg-gray-100 text-gray-700 ring-1 ring-gray-200 ring-inset"
          : "bg-purple-600 text-white",
        SIZES[size],
        className,
      )}
      role="img"
      aria-label={name ?? initials}
    >
      {showImage ? (
        // avatar URLs are user uploads from storage (or data URLs in demo
        // mode), not assets next/image should be optimizing and licensing
        // dimensions for.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl ?? undefined}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedUrl(imageUrl ?? null)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
