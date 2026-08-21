import Link from "next/link";
import {
  ChevronRight,
  Code2,
  Megaphone,
  CreditCard,
  MessagesSquare,
  Newspaper,
  PencilLine,
  Plug,
  Send,
  ShieldAlert,
  Sparkles,
  UserRound,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Timeline, type TimelineEntry, type TimelineTone } from "@/components/ui/timeline";
import { formatRelativeShort } from "@/lib/format";
import { AUDIT_EVENT_LABELS } from "@/lib/labels";
import type { AuditEntityType, AuditEvent } from "@/domain";

const ENTITY_ICONS: Record<AuditEntityType, LucideIcon> = {
  organization: UserRound,
  membership: UserRound,
  location: UserRound,
  platform_connection: Plug,
  platform_profile: Plug,
  mention: UserRound,
  mention_analysis: UserRound,
  response_draft: Send,
  approval: PencilLine,
  escalation: ShieldAlert,
  automation_rule: Workflow,
  brand_voice: Sparkles,
  monitoring_query: Newspaper,
  yelp_activity_occurrence: Plug,
  reddit_monitoring_query: MessagesSquare,
  reddit_community_posture: ShieldAlert,
  response_publication_attempt: Send,
  review_widget: Code2,
  press_widget: Megaphone,
  organization_billing: CreditCard,
};

const ENTITY_TONES: Record<AuditEntityType, TimelineTone> = {
  organization: "neutral",
  membership: "neutral",
  location: "neutral",
  platform_connection: "neutral",
  platform_profile: "neutral",
  mention: "neutral",
  mention_analysis: "neutral",
  response_draft: "purple",
  approval: "purple",
  escalation: "red",
  automation_rule: "amber",
  brand_voice: "purple",
  monitoring_query: "neutral",
  // Amber rather than neutral: a detected change is something to go and look
  // at, which is what this tone means everywhere else it is used.
  yelp_activity_occurrence: "amber",
  reddit_monitoring_query: "neutral",
  // A community decision gates whether Lia may speak in public at all, so it
  // reads with the same weight as an escalation rather than as configuration.
  reddit_community_posture: "amber",
  response_publication_attempt: "purple",
  // Neutral: a widget change is configuration, not something that needs
  // attention. The one act that does — regenerating the embed code — is
  // guarded by a confirmation where it happens, not by a colour here.
  review_widget: "neutral",
  press_widget: "neutral",
  // Neutral by default, and deliberately so even for a failed payment. This
  // card is a history of what happened, not the place a billing problem gets
  // raised — that is the shell banner and the billing page, both of which say
  // it in words. Colouring a past `billing.payment_failed` red here would keep
  // shouting about a card that was fixed weeks ago.
  organization_billing: "neutral",
};

export interface RecentActivityCardProps {
  events: AuditEvent[];
  /** Resolves an actor id to a display name. */
  actorNames: Map<string, string>;
  className?: string;
}

/**
 * The audit trail, newest first.
 *
 * Reads straight from `audit_events` — this is not a separate activity feed
 * that could drift from the record of what actually happened.
 */
export function RecentActivityCard({
  events,
  actorNames,
  className,
}: RecentActivityCardProps) {
  const entries: TimelineEntry[] = events.map((event) => {
    const actor =
      event.actorUserId !== null
        ? (actorNames.get(event.actorUserId) ?? "A team member")
        : event.actorType === "ai"
          ? "Lia"
          : event.actorType === "integration"
            ? "Integration"
            : "Automation";

    return {
      id: event.id,
      title: AUDIT_EVENT_LABELS[event.eventType],
      meta: actor,
      timestamp: formatRelativeShort(event.occurredAt),
      icon: ENTITY_ICONS[event.entityType],
      tone: ENTITY_TONES[event.entityType],
    };
  });

  return (
    <Card flush className={className}>
      <CardHeader
        className="p-5 pb-3"
        title="Recent activity"
        hint="Every automated and human action, newest first."
      />
      <div className="px-5 pb-4">
        {entries.length === 0 ? (
          <EmptyState
            title="No activity yet"
            description="Actions appear here as soon as anyone acts on a mention."
            size="sm"
          />
        ) : (
          <Timeline entries={entries} />
        )}
      </div>
      <CardFooter>
        <span className="text-gray-500">Audit events are append-only</span>
        <Link
          href="/responses"
          className="inline-flex items-center gap-0.5 font-medium text-purple-600 hover:underline"
        >
          View responses
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardFooter>
    </Card>
  );
}
