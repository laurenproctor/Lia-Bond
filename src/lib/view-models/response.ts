import type { TimelineEntry, TimelineTone } from "@/components/ui/timeline";
import { formatDateTime } from "@/lib/format";
import { APPROVAL_STATUS_LABELS } from "@/lib/labels";
import type { Approval, ApprovalStatus, ResponseDraft } from "@/domain";

/** True when a person changed the model's text before it went out. */
export function hasHumanEdit(draft: ResponseDraft): boolean {
  return draft.finalText !== null && draft.finalText !== draft.draftText;
}

const APPROVAL_TONES: Record<ApprovalStatus, TimelineTone> = {
  pending: "amber",
  approved: "green",
  rejected: "red",
  canceled: "neutral",
};

/**
 * Approvals as timeline entries.
 *
 * An undecided approval has no `decidedAt`, so the entry timestamps when it
 * was requested — the honest reading of "what happened when".
 */
export function approvalTimelineEntries(
  approvals: Approval[],
  namesById: Map<string, string>,
): TimelineEntry[] {
  return approvals.map((approval) => {
    const deciderName = approval.assignedToUserId
      ? (namesById.get(approval.assignedToUserId) ?? null)
      : null;
    const meta = [deciderName, approval.decisionNote]
      .filter((part): part is string => part !== null)
      .join(" — ");

    return {
      id: approval.id,
      title: APPROVAL_STATUS_LABELS[approval.status],
      meta: meta.length > 0 ? meta : undefined,
      timestamp: formatDateTime(approval.decidedAt ?? approval.createdAt),
      tone: APPROVAL_TONES[approval.status],
    };
  });
}
