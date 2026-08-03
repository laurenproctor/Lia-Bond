import { MessageSquare, MessagesSquare, Newspaper } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { PLATFORM_LABELS, PLATFORM_SHORT_LABELS } from "@/lib/labels";
import type { Platform } from "@/domain";

/**
 * Platform identity.
 *
 * Marks are drawn locally — no remote logo assets — using a neutral glyph plus
 * the platform's own accent so a source is recognisable at a glance without
 * relying on colour alone (the label is always available to assistive tech).
 */

/**
 * Review platforms get a letter mark: they would otherwise all share the same
 * star glyph and be told apart by colour alone. Everything else gets an icon
 * that already reads as its medium.
 */
type PlatformStyle =
  | { kind: "letter"; letter: string; className: string }
  | { kind: "icon"; icon: LucideIcon; className: string };

const PLATFORM_STYLES: Record<Platform, PlatformStyle> = {
  google_business_profile: {
    kind: "letter",
    letter: "G",
    className: "bg-blue-100 text-blue-600",
  },
  yelp: { kind: "letter", letter: "Y", className: "bg-red-100 text-red-600" },
  trustpilot: {
    kind: "letter",
    letter: "T",
    className: "bg-green-100 text-green-600",
  },
  tripadvisor: {
    kind: "letter",
    letter: "Ta",
    className: "bg-green-100 text-green-600",
  },
  reddit: {
    kind: "icon",
    icon: MessagesSquare,
    className: "bg-amber-100 text-amber-600",
  },
  news_media: {
    kind: "icon",
    icon: Newspaper,
    className: "bg-purple-100 text-purple-600",
  },
  disqus: {
    kind: "icon",
    icon: MessageSquare,
    className: "bg-gray-100 text-gray-700",
  },
  facebook: {
    kind: "icon",
    icon: MessageSquare,
    className: "bg-blue-100 text-blue-600",
  },
  instagram: {
    kind: "icon",
    icon: MessageSquare,
    className: "bg-red-100 text-red-600",
  },
};

const GLYPH_SIZES = {
  sm: "size-5 rounded-md",
  md: "size-7 rounded-lg",
  lg: "size-9 rounded-[10px]",
} as const;

const GLYPH_ICON_SIZES = {
  sm: "size-3",
  md: "size-3.5",
  lg: "size-4",
} as const;

const GLYPH_TEXT_SIZES = {
  sm: "text-[11px]",
  md: "text-[12.5px]",
  lg: "text-[14px]",
} as const;

export function PlatformGlyph({
  platform,
  size = "md",
  className,
}: {
  platform: Platform;
  size?: keyof typeof GLYPH_SIZES;
  className?: string;
}) {
  const style = PLATFORM_STYLES[platform];

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        GLYPH_SIZES[size],
        style.className,
        className,
      )}
      role="img"
      aria-label={PLATFORM_LABELS[platform]}
    >
      {style.kind === "letter" ? (
        <span className={cn("font-bold", GLYPH_TEXT_SIZES[size])} aria-hidden>
          {style.letter}
        </span>
      ) : (
        <style.icon className={GLYPH_ICON_SIZES[size]} aria-hidden />
      )}
    </span>
  );
}

export interface SourceBadgeProps {
  platform: Platform;
  /** Secondary context, typically the location or subreddit. */
  context?: string;
  short?: boolean;
  size?: keyof typeof GLYPH_SIZES;
  className?: string;
}

export function SourceBadge({
  platform,
  context,
  short = false,
  size = "sm",
  className,
}: SourceBadgeProps) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <PlatformGlyph platform={platform} size={size} />
      <span className="truncate text-[13px] font-medium text-gray-700">
        {short ? PLATFORM_SHORT_LABELS[platform] : PLATFORM_LABELS[platform]}
      </span>
      {context ? (
        <>
          <span className="text-gray-300" aria-hidden>
            •
          </span>
          <span className="truncate text-[13px] text-gray-500">{context}</span>
        </>
      ) : null}
    </span>
  );
}
