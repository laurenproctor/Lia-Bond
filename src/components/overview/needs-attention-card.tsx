import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MentionListItem } from "@/components/mentions/mention-list-item";
import type { MentionView } from "@/lib/view-models/mention";

export interface NeedsAttentionCardProps {
  mentions: MentionView[];
  totalOpen: number;
  className?: string;
}

/** The overview's queue: the highest-risk unresolved work, newest first. */
export function NeedsAttentionCard({
  mentions,
  totalOpen,
  className,
}: NeedsAttentionCardProps) {
  return (
    <Card flush className={className}>
      <CardHeader
        className="p-5 pb-3"
        title={
          <span className="inline-flex items-center gap-2">
            Needs attention
            <span className="rounded-md bg-red-100 px-1.5 py-0.5 text-[12px] font-semibold text-red-600 tabular-nums">
              {totalOpen}
            </span>
          </span>
        }
        actions={
          <Link
            href="/mentions"
            className="text-[13px] font-medium text-purple-600 hover:underline"
          >
            View all
          </Link>
        }
      />

      {mentions.length === 0 ? (
        <EmptyState
          title="Nothing needs attention"
          description="Every mention has been answered, escalated, or dismissed."
          size="sm"
        />
      ) : (
        <ul className="divide-y divide-gray-200 border-t border-gray-200">
          {mentions.map((mention) => (
            <MentionListItem key={mention.id} mention={mention} density="compact" />
          ))}
        </ul>
      )}

      <CardFooter>
        <span className="text-gray-500">
          Showing {mentions.length} of {totalOpen}
        </span>
        <Link
          href="/mentions"
          className="inline-flex items-center gap-0.5 font-medium text-purple-600 hover:underline"
        >
          Go to mentions
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardFooter>
    </Card>
  );
}
