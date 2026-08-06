import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ResponseComposer } from "@/components/responses/response-composer";
import {
  DetailField,
  DetailPanel,
  DetailSection,
} from "@/components/ui/detail-panel";
import { Timeline, type TimelineEntry } from "@/components/ui/timeline";
import { formatDateTime, formatRelativeShort } from "@/lib/format";
import { GENERATED_BY_LABELS, RESPONSE_TYPE_LABELS } from "@/lib/labels";
import { hasHumanEdit } from "@/lib/view-models/response";
import { excerptFrom, workspacePathFor } from "@/lib/view-models/mention";
import type { Mention, PublishingMode, ResponseDraft } from "@/domain";

export interface ResponseDetailPaneProps {
  draft: ResponseDraft;
  /** Undefined when the mention behind the draft no longer exists. */
  mention: Mention | undefined;
  publishing: PublishingMode;
  canDecide: boolean;
  assigneeName: string | null;
  approvalEntries: TimelineEntry[];
  className?: string;
}

/**
 * The detail half of the responses library.
 *
 * Approve/reject runs through the embedded composer and its audited server
 * action; everything else here is a read. Publishing metadata renders
 * honestly — publishing is not built, and the pane says so (D104).
 */
export function ResponseDetailPane({
  draft,
  mention,
  publishing,
  canDecide,
  assigneeName,
  approvalEntries,
  className,
}: ResponseDetailPaneProps) {
  return (
    <DetailPanel className={className} label="Selected response">
      <div className="flex flex-col gap-4">
        <DetailSection title="Original mention">
          {mention ? (
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12.5px] text-gray-700">
                <span className="font-medium text-gray-950">
                  {mention.authorName ?? "Unknown author"}
                </span>{" "}
                — {excerptFrom(mention.content, 180)}
              </p>
              <Link
                href={workspacePathFor(mention)}
                className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-purple-600 hover:underline"
              >
                Open workspace
                <ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          ) : (
            <p className="text-[12.5px] text-gray-400">Mention unavailable</p>
          )}
        </DetailSection>

        <DetailSection title="Response">
          <ResponseComposer
            draft={draft}
            publishing={publishing}
            canDecide={canDecide}
          />
        </DetailSection>

        {hasHumanEdit(draft) ? (
          <DetailSection title="Original AI draft">
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] whitespace-pre-line text-gray-700">
              {draft.draftText}
            </p>
          </DetailSection>
        ) : null}

        <DetailSection title="Details">
          <dl className="grid grid-cols-2 gap-3">
            <DetailField label="Type">
              {RESPONSE_TYPE_LABELS[draft.responseType]}
            </DetailField>
            <DetailField label="Author">
              {GENERATED_BY_LABELS[draft.generatedBy]}
            </DetailField>
            <DetailField label="Assigned to">
              {assigneeName ?? <span className="text-gray-400">Unassigned</span>}
            </DetailField>
            <DetailField label="Updated">
              {formatRelativeShort(draft.updatedAt)}
            </DetailField>
          </dl>
        </DetailSection>

        <DetailSection title="Approvals">
          {approvalEntries.length > 0 ? (
            <Timeline entries={approvalEntries} />
          ) : (
            <p className="text-[12.5px] text-gray-500">No approvals yet.</p>
          )}
        </DetailSection>

        <DetailSection title="Publishing">
          {draft.publishedAt ? (
            <dl className="grid grid-cols-2 gap-3">
              <DetailField label="Published">
                {formatDateTime(draft.publishedAt)}
              </DetailField>
              <DetailField label="External id">
                {draft.externalResponseId ?? "—"}
              </DetailField>
            </dl>
          ) : (
            <p className="text-[12.5px] text-gray-500">
              Not published. Lia cannot post replies to sources yet; approved
              text is published by a person.
            </p>
          )}
        </DetailSection>
      </div>
    </DetailPanel>
  );
}
