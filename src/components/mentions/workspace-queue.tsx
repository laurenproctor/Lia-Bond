import type { ReactNode } from "react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MentionListItem } from "@/components/mentions/mention-list-item";
import { cn } from "@/lib/cn";
import type { MentionView } from "@/lib/view-models/mention";

export interface WorkspaceQueueProps {
  title: string;
  mentions: MentionView[];
  selectedId: string;
  /** Overrides the view model's own route, when a workspace pins its prefix. */
  hrefFor?: (mention: MentionView) => string;
  /** Filter chips or a sort control, rendered under the title. */
  controls?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

/**
 * The left-hand queue shared by all three workspaces.
 *
 * It sticks to the top of the viewport and caps its own height so the list
 * scrolls independently — selecting a row never scrolls the detail column, and
 * a long queue never pushes the rest of the page out of the way.
 */
export function WorkspaceQueue({
  title,
  mentions,
  selectedId,
  hrefFor,
  controls,
  emptyTitle = "Nothing in this queue",
  emptyDescription = "Adjust the filters, or wait for the next sync.",
  className,
}: WorkspaceQueueProps) {
  return (
    <Card flush className={cn("xl:sticky xl:top-6 xl:self-start", className)}>
      <CardHeader className="p-4 pb-3" title={title} />
      {controls ? <div className="px-4 pb-3">{controls}</div> : null}

      {mentions.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} size="sm" />
      ) : (
        <ul className="lia-scroll max-h-[26rem] divide-y divide-gray-200 overflow-y-auto border-t border-gray-200 xl:max-h-[calc(100dvh-13rem)]">
          {mentions.map((mention) => (
            <MentionListItem
              key={mention.id}
              mention={mention}
              href={hrefFor?.(mention)}
              selected={mention.id === selectedId}
              density="compact"
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
