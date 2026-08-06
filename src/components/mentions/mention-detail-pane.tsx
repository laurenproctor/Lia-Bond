import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import {
  DetailField,
  DetailPanel,
  DetailSection,
} from "@/components/ui/detail-panel";
import { RatingStars } from "@/components/ui/rating-stars";
import { PlatformGlyph } from "@/components/ui/source-badge";
import {
  MentionStatusBadge,
  RecommendedActionBadge,
  ResponseStatusBadge,
  RiskBadge,
  SentimentBadge,
} from "@/components/ui/status-badge";
import { formatRelativeLong, formatRelativeShort } from "@/lib/format";
import { PLATFORM_LABELS, RESPONSE_TYPE_LABELS } from "@/lib/labels";
import type { MentionView } from "@/lib/view-models/mention";
import type { ResponseDraft } from "@/domain";

export interface MentionDetailPaneProps {
  mention: MentionView;
  /** Existing drafts for this mention; the pane lists them, never creates one. */
  drafts: ResponseDraft[];
  className?: string;
}

/**
 * The right half of the mentions split view.
 *
 * Read-only by design: triage happens here, acting happens in the source's
 * workspace, which stays one click away in the header and footer (D100).
 */
export function MentionDetailPane({
  mention,
  drafts,
  className,
}: MentionDetailPaneProps) {
  const hasAnalysis =
    mention.recommendedAction !== null ||
    mention.topics.length > 0 ||
    mention.summary !== null;

  // Source types with no dedicated workspace resolve `workspacePath` back to
  // `/mentions` (see `workspacePathFor`) — this pane IS their workspace, so a
  // link to it would just be a self-referential no-op. Only source types with
  // a real, separate workspace screen (Google review, Reddit, news) get the
  // "Open workspace" affordance.
  const hasWorkspace = !mention.workspacePath.startsWith("/mentions");

  return (
    <DetailPanel
      className={className}
      label="Selected mention"
      header={
        <div className="flex items-center gap-3">
          <PlatformGlyph platform={mention.platform} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-gray-950">
              {mention.title}
            </p>
            <p className="truncate text-[12.5px] text-gray-500">
              {PLATFORM_LABELS[mention.platform]} • {mention.contextLabel} •{" "}
              {formatRelativeLong(mention.publishedAt)}
            </p>
          </div>
          {hasWorkspace ? (
            <Link
              href={mention.workspacePath}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-purple-600 hover:underline"
            >
              Open workspace
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
      }
      footer={
        hasWorkspace ? (
          <Link
            href={mention.workspacePath}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-purple-600 bg-purple-600 px-3 text-[13px] font-medium text-white transition-colors hover:bg-purple-500"
          >
            Open workspace
            <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2.5">
          <Avatar
            initials={mention.authorInitials}
            name={mention.authorName}
            size="xs"
          />
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-gray-700">
              {mention.authorName}
            </p>
            <p className="mt-1 text-[13.5px] leading-relaxed whitespace-pre-line text-gray-950">
              {mention.content}
            </p>
          </div>
        </div>

        <DetailSection title="AI analysis">
          {hasAnalysis ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <SentimentBadge sentiment={mention.sentiment} />
                <RiskBadge risk={mention.riskLevel} />
                {mention.recommendedAction ? (
                  <RecommendedActionBadge action={mention.recommendedAction} />
                ) : null}
              </div>
              {mention.topics.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {mention.topics.map((topic) => (
                    <li
                      key={topic}
                      className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[12px] text-gray-700"
                    >
                      {topic}
                    </li>
                  ))}
                </ul>
              ) : null}
              {mention.summary ? (
                <p className="text-[12.5px] text-gray-700">{mention.summary}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-[12.5px] text-gray-500">
              Not analysed yet. Analysis runs from the panel above the queue.
            </p>
          )}
        </DetailSection>

        <DetailSection title="Details">
          <dl className="grid grid-cols-2 gap-3">
            <DetailField label="Location">{mention.locationLabel}</DetailField>
            <DetailField label="Status">
              <MentionStatusBadge status={mention.status} />
            </DetailField>
            {mention.rating !== null ? (
              <DetailField label="Rating">
                <RatingStars rating={mention.rating} />
              </DetailField>
            ) : null}
          </dl>
        </DetailSection>

        {drafts.length > 0 ? (
          <DetailSection title="Responses">
            <ul className="flex flex-col gap-2">
              {drafts.map((draft) => (
                <li
                  key={draft.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2"
                >
                  <span className="text-[12.5px] text-gray-700">
                    {RESPONSE_TYPE_LABELS[draft.responseType]}
                  </span>
                  <span className="flex items-center gap-2">
                    <ResponseStatusBadge status={draft.status} />
                    <span className="text-[12px] text-gray-400">
                      {formatRelativeShort(draft.updatedAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </DetailSection>
        ) : null}
      </div>
    </DetailPanel>
  );
}
