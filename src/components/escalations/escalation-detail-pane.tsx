import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  DetailField,
  DetailPanel,
  DetailSection,
} from "@/components/ui/detail-panel";
import {
  EscalationStatusBadge,
  RiskBadge,
} from "@/components/ui/status-badge";
import { Timeline, type TimelineEntry } from "@/components/ui/timeline";
import { formatDateTime, formatSlaRemaining } from "@/lib/format";
import { ESCALATION_CATEGORY_LABELS } from "@/lib/labels";
import { excerptFrom, workspacePathFor } from "@/lib/view-models/mention";
import type { Escalation, Mention } from "@/domain";

export interface EscalationDetailPaneProps {
  escalation: Escalation;
  /** Undefined when the mention behind the case no longer exists. */
  mention: Mention | undefined;
  ownerName: string | null;
  timelineEntries: TimelineEntry[];
  className?: string;
}

/**
 * The detail half of the escalations centre. Read-only in this pass (D105):
 * status and assignment changes have no server actions yet, and the pane
 * must not invent authority the backend does not have.
 */
export function EscalationDetailPane({
  escalation,
  mention,
  ownerName,
  timelineEntries,
  className,
}: EscalationDetailPaneProps) {
  const sla = escalation.dueAt ? formatSlaRemaining(escalation.dueAt) : null;

  return (
    <DetailPanel
      className={className}
      label="Selected case"
      header={
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-[14px] font-semibold text-gray-950">
            {escalation.title}
          </p>
          <span className="flex shrink-0 items-center gap-1.5">
            <RiskBadge risk={escalation.severity} short />
            <EscalationStatusBadge status={escalation.status} />
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <DetailSection title="Case overview">
          {escalation.summary ? (
            <p className="text-[12.5px] leading-relaxed text-gray-700">
              {escalation.summary}
            </p>
          ) : null}
          <dl className="mt-2.5 grid grid-cols-2 gap-3">
            <DetailField label="Category">
              {ESCALATION_CATEGORY_LABELS[escalation.category]}
            </DetailField>
            <DetailField label="Owner">
              {ownerName ?? <span className="text-gray-400">Unassigned</span>}
            </DetailField>
            <DetailField label="SLA">
              {sla ? (
                <span
                  className={
                    sla.overdue ? "font-semibold text-red-600" : "text-gray-700"
                  }
                >
                  {sla.label}
                </span>
              ) : (
                <span className="text-gray-400">No deadline</span>
              )}
            </DetailField>
            <DetailField label="Raised">
              {formatDateTime(escalation.createdAt)}
            </DetailField>
          </dl>
        </DetailSection>

        {escalation.resolutionNote ? (
          <DetailSection title="Resolution">
            <p className="text-[12.5px] leading-relaxed text-gray-700">
              {escalation.resolutionNote}
            </p>
            {escalation.resolvedAt ? (
              <p className="mt-1 text-[12px] text-gray-400">
                Resolved {formatDateTime(escalation.resolvedAt)}
              </p>
            ) : null}
          </DetailSection>
        ) : null}

        <DetailSection title="Source evidence">
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

        <DetailSection title="Activity">
          {timelineEntries.length > 0 ? (
            <Timeline entries={timelineEntries} />
          ) : (
            <p className="text-[12.5px] text-gray-500">
              No recorded activity yet.
            </p>
          )}
        </DetailSection>
      </div>
    </DetailPanel>
  );
}
