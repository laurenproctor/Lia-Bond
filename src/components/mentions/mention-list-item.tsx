import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { RatingStars } from "@/components/ui/rating-stars";
import { PlatformGlyph } from "@/components/ui/source-badge";
import {
  MentionStatusBadge,
  RecommendedActionBadge,
  RiskBadge,
  SentimentBadge,
} from "@/components/ui/status-badge";
import { cn } from "@/lib/cn";
import { formatRelativeShort } from "@/lib/format";
import { PLATFORM_LABELS } from "@/lib/labels";
import type { MentionView } from "@/lib/view-models/mention";

export interface MentionListItemProps {
  mention: MentionView;
  href?: string;
  selected?: boolean;
  /** Trims the row to title, source, and time for dense sidebars. */
  density?: "comfortable" | "compact";
}

/**
 * One row in every mention queue.
 *
 * Takes a view model rather than a domain record: the queue needs an excerpt,
 * initials, and a route, none of which belong on the stored row.
 *
 * The whole row is a single link so keyboard and pointer targets match, and the
 * selected row keeps a visible marker so split-view context is never lost.
 */
export function MentionListItem({
  mention,
  href,
  selected = false,
  density = "comfortable",
}: MentionListItemProps) {
  return (
    <li>
      <Link
        href={href ?? mention.workspacePath}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "relative block border-l-2 px-4 transition-colors",
          density === "compact" ? "py-3" : "py-3.5",
          selected
            ? "border-l-purple-600 bg-purple-50"
            : "border-l-transparent hover:bg-gray-50",
        )}
      >
        <div className="flex items-center gap-2">
          <PlatformGlyph platform={mention.platform} size="sm" />
          <span className="truncate text-[12.5px] font-medium text-gray-700">
            {PLATFORM_LABELS[mention.platform]}
          </span>
          <span className="text-gray-300" aria-hidden>
            •
          </span>
          <span className="truncate text-[12.5px] text-gray-500">
            {mention.contextLabel}
          </span>
          <span className="ml-auto shrink-0 text-[12px] text-gray-400">
            {formatRelativeShort(mention.publishedAt)}
          </span>
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-gray-950">
            {mention.title}
          </p>
          {mention.rating !== null ? <RatingStars rating={mention.rating} /> : null}
        </div>

        {density === "comfortable" ? (
          <p className="mt-1 line-clamp-2 text-[13px] text-gray-500">{mention.excerpt}</p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1.5">
            <Avatar
              initials={mention.authorInitials}
              name={mention.authorName}
              size="xs"
            />
            <span className="max-w-[10rem] truncate text-[12.5px] text-gray-700">
              {mention.authorName}
            </span>
          </span>
          <SentimentBadge sentiment={mention.sentiment} />
          <RiskBadge risk={mention.riskLevel} short />
          {/* The recommended action is the widest badge and it repeats in the
              detail panel, so a narrow queue drops it rather than wrapping. */}
          {density === "comfortable" && mention.recommendedAction ? (
            <RecommendedActionBadge action={mention.recommendedAction} />
          ) : null}
          <span className="ml-auto">
            <MentionStatusBadge status={mention.status} />
          </span>
        </div>
      </Link>
    </li>
  );
}
