import type { TimelineEntry, TimelineTone } from "@/components/ui/timeline";
import { formatDateTime, humanize } from "@/lib/format";
import { AUDIT_EVENT_LABELS } from "@/lib/labels";
import type { AuditEvent } from "@/domain";

const EVENT_TONES: Partial<Record<AuditEvent["eventType"], TimelineTone>> = {
  "escalation.created_from_analysis": "red",
  "escalation.assigned": "purple",
};

/**
 * An escalation's audit trail as timeline entries.
 *
 * Titles come from the shared audit vocabulary so the pane can never invent
 * an event name the trail does not use.
 */
export function escalationTimelineEntries(
  events: AuditEvent[],
  namesById: Map<string, string>,
): TimelineEntry[] {
  return events.map((event) => ({
    id: event.id,
    title: AUDIT_EVENT_LABELS[event.eventType],
    meta: event.actorUserId
      ? (namesById.get(event.actorUserId) ?? humanize(event.actorType))
      : humanize(event.actorType),
    timestamp: formatDateTime(event.occurredAt),
    tone: EVENT_TONES[event.eventType] ?? "neutral",
  }));
}
