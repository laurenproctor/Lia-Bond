import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  Eye,
  FileText,
  ShieldAlert,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import {
  AUTOMATION_RULE_STATUS_LABELS,
  ESCALATION_STATUS_LABELS,
  LOCATION_STATUS_LABELS,
  MENTION_STATUS_LABELS,
  PLATFORM_CONNECTION_STATUS_LABELS,
  RECOMMENDED_ACTION_LABELS,
  RESPONSE_DRAFT_STATUS_LABELS,
  RISK_LEVEL_LABELS,
  RISK_LEVEL_SHORT_LABELS,
  SENTIMENT_LABELS,
} from "@/lib/labels";
import type {
  AutomationRuleStatus,
  EscalationStatus,
  LocationStatus,
  MentionStatus,
  PlatformConnectionStatus,
  RecommendedAction,
  ResponseDraftStatus,
  RiskLevel,
  Sentiment,
} from "@/domain";

/**
 * The single place a domain state becomes a colour.
 *
 * Every variant carries a word as well as a colour, and the risk variants carry
 * an icon too, so state is never communicated by hue alone.
 */

const MENTION_STATUS_TONES: Record<MentionStatus, BadgeTone> = {
  new: "blue",
  analyzed: "neutral",
  draft_ready: "purple",
  needs_approval: "amber",
  escalated: "red",
  responded: "green",
  monitoring: "neutral",
  no_action_recommended: "neutral",
  dismissed: "neutral",
};

const MENTION_STATUS_ICONS: Partial<Record<MentionStatus, LucideIcon>> = {
  new: CircleDashed,
  draft_ready: Sparkles,
  needs_approval: Clock,
  escalated: ShieldAlert,
  responded: CheckCircle2,
  monitoring: Eye,
  no_action_recommended: CircleSlash,
  dismissed: XCircle,
};

export function MentionStatusBadge({ status }: { status: MentionStatus }) {
  return (
    <Badge tone={MENTION_STATUS_TONES[status]} icon={MENTION_STATUS_ICONS[status]}>
      {MENTION_STATUS_LABELS[status]}
    </Badge>
  );
}

const SENTIMENT_TONES: Record<Sentiment, BadgeTone> = {
  positive: "green",
  neutral: "neutral",
  negative: "red",
  mixed: "amber",
  unknown: "neutral",
};

export function SentimentBadge({ sentiment }: { sentiment: Sentiment }) {
  return <Badge tone={SENTIMENT_TONES[sentiment]}>{SENTIMENT_LABELS[sentiment]}</Badge>;
}

const RISK_TONES: Record<RiskLevel, BadgeTone> = {
  low: "green",
  medium: "amber",
  high: "red",
  critical: "red",
};

export function RiskBadge({ risk, short = false }: { risk: RiskLevel; short?: boolean }) {
  const icon = risk === "high" || risk === "critical" ? AlertTriangle : undefined;
  return (
    <Badge tone={RISK_TONES[risk]} icon={icon}>
      {short ? RISK_LEVEL_SHORT_LABELS[risk] : RISK_LEVEL_LABELS[risk]}
    </Badge>
  );
}

const ACTION_TONES: Record<RecommendedAction, BadgeTone> = {
  respond_publicly: "purple",
  respond_privately: "blue",
  contact_journalist: "amber",
  publish_owned_statement: "blue",
  monitor: "neutral",
  escalate: "red",
  do_not_engage: "neutral",
  dismiss: "neutral",
};

export function RecommendedActionBadge({ action }: { action: RecommendedAction }) {
  return <Badge tone={ACTION_TONES[action]}>{RECOMMENDED_ACTION_LABELS[action]}</Badge>;
}

const RESPONSE_STATUS_TONES: Record<ResponseDraftStatus, BadgeTone> = {
  draft: "neutral",
  awaiting_approval: "amber",
  approved: "purple",
  publishing: "blue",
  submitted: "blue",
  published: "green",
  rejected_by_platform: "red",
  failed: "red",
  deleted: "neutral",
  dismissed: "neutral",
};

export function ResponseStatusBadge({ status }: { status: ResponseDraftStatus }) {
  const icon =
    status === "published"
      ? CheckCircle2
      : status === "failed" || status === "rejected_by_platform"
        ? XCircle
        : status === "draft"
          ? FileText
          : status === "awaiting_approval"
            ? Clock
            : undefined;

  return (
    <Badge tone={RESPONSE_STATUS_TONES[status]} icon={icon}>
      {RESPONSE_DRAFT_STATUS_LABELS[status]}
    </Badge>
  );
}

const ESCALATION_STATUS_TONES: Record<EscalationStatus, BadgeTone> = {
  open: "red",
  in_progress: "amber",
  pending_approval: "purple",
  resolved: "green",
  dismissed: "neutral",
};

export function EscalationStatusBadge({ status }: { status: EscalationStatus }) {
  return (
    <Badge tone={ESCALATION_STATUS_TONES[status]}>
      {ESCALATION_STATUS_LABELS[status]}
    </Badge>
  );
}

const CONNECTION_STATUS_TONES: Record<PlatformConnectionStatus, BadgeTone> = {
  pending: "neutral",
  connected: "green",
  action_required: "amber",
  disconnected: "neutral",
  error: "red",
};

export function ConnectionStatusBadge({ status }: { status: PlatformConnectionStatus }) {
  const icon =
    status === "connected"
      ? CheckCircle2
      : status === "error"
        ? AlertTriangle
        : status === "action_required"
          ? Clock
          : undefined;

  return (
    <Badge tone={CONNECTION_STATUS_TONES[status]} icon={icon}>
      {PLATFORM_CONNECTION_STATUS_LABELS[status]}
    </Badge>
  );
}

const LOCATION_STATUS_TONES: Record<LocationStatus, BadgeTone> = {
  setup: "blue",
  active: "green",
  review: "amber",
  inactive: "neutral",
};

export function LocationStatusBadge({ status }: { status: LocationStatus }) {
  return (
    <Badge tone={LOCATION_STATUS_TONES[status]}>{LOCATION_STATUS_LABELS[status]}</Badge>
  );
}

const RULE_STATUS_TONES: Record<AutomationRuleStatus, BadgeTone> = {
  active: "green",
  inactive: "neutral",
  draft: "amber",
};

export function AutomationRuleStatusBadge({ status }: { status: AutomationRuleStatus }) {
  return (
    <Badge tone={RULE_STATUS_TONES[status]}>
      {AUTOMATION_RULE_STATUS_LABELS[status]}
    </Badge>
  );
}
