import type { IntegrationCapabilityState } from "@/integrations/connector";
import type {
  ApprovalStatus,
  AuditEventType,
  AutomationRuleStatus,
  ConnectionHealthStatus,
  EscalationCategory,
  EscalationStatus,
  GateRejectionReason,
  GeneratedBy,
  LocationStatus,
  MembershipRole,
  MembershipStatus,
  MentionSourceType,
  MentionStatus,
  MonitoringQueryType,
  Platform,
  PlatformConnectionStatus,
  PublicationAttemptStatus,
  RedditCommunityPostureValue,
  RedditPollRunKind,
  RecommendedAction,
  ResponseDraftStatus,
  ResponseType,
  RiskLevel,
  Sentiment,
  SyncRunStatus,
  SyncTrigger,
} from "@/domain";

/**
 * Human labels for every enum in the domain.
 *
 * Sentence case throughout, per `CLAUDE.md`. Keeping them in one place is what
 * stops the same status being called two different things on two screens.
 */

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  mixed: "Mixed",
  unknown: "Not analyzed",
};

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical risk",
};

export const RISK_LEVEL_SHORT_LABELS: Record<RiskLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const MENTION_STATUS_LABELS: Record<MentionStatus, string> = {
  new: "New",
  analyzed: "Analyzed",
  draft_ready: "Draft ready",
  needs_approval: "Needs approval",
  escalated: "Escalated",
  responded: "Responded",
  monitoring: "Monitoring",
  no_action_recommended: "No action recommended",
  dismissed: "Dismissed",
};

export const RECOMMENDED_ACTION_LABELS: Record<RecommendedAction, string> = {
  respond_publicly: "Respond publicly",
  respond_privately: "Respond privately",
  contact_journalist: "Contact the journalist",
  publish_owned_statement: "Publish a statement",
  monitor: "Monitor",
  escalate: "Escalate",
  do_not_engage: "Do not engage",
  dismiss: "Dismiss",
};

export const ESCALATION_CATEGORY_LABELS: Record<EscalationCategory, string> = {
  food_safety: "Food safety",
  injury: "Injury",
  discrimination: "Discrimination",
  employee_misconduct: "Employee misconduct",
  legal_threat: "Legal threat",
  privacy: "Privacy",
  refund_dispute: "Refund or chargeback dispute",
  media_inquiry: "Media inquiry",
  viral_discussion: "Viral discussion",
  misinformation: "Material misinformation",
  other: "Other",
};

export const ESCALATION_STATUS_LABELS: Record<EscalationStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  pending_approval: "Pending approval",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  google_business_profile: "Google Business Profile",
  yelp: "Yelp",
  reddit: "Reddit",
  news_media: "News and media",
  disqus: "Article comments",
  trustpilot: "Trustpilot",
  tripadvisor: "Tripadvisor",
  facebook: "Facebook",
  instagram: "Instagram",
};

export const PLATFORM_SHORT_LABELS: Record<Platform, string> = {
  google_business_profile: "Google",
  yelp: "Yelp",
  reddit: "Reddit",
  news_media: "News and media",
  disqus: "Article comments",
  trustpilot: "Trustpilot",
  tripadvisor: "Tripadvisor",
  facebook: "Facebook",
  instagram: "Instagram",
};

export const SOURCE_TYPE_LABELS: Record<MentionSourceType, string> = {
  google_review: "Google review",
  yelp_review: "Yelp review",
  trustpilot_review: "Trustpilot review",
  tripadvisor_review: "Tripadvisor review",
  reddit_post: "Reddit post",
  reddit_comment: "Reddit comment",
  news_article: "News article",
  article_comment: "Article comment",
  facebook_comment: "Facebook comment",
  instagram_comment: "Instagram comment",
};

export const RESPONSE_DRAFT_STATUS_LABELS: Record<ResponseDraftStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Needs approval",
  approved: "Approved",
  publishing: "Publishing",
  submitted: "Submitted",
  published: "Published",
  rejected_by_platform: "Rejected by platform",
  failed: "Failed",
  deleted: "Deleted",
  dismissed: "Dismissed",
};

export const RESPONSE_TYPE_LABELS: Record<ResponseType, string> = {
  public_reply: "Public reply",
  private_reply: "Private reply",
  journalist_email: "Journalist email",
  article_comment: "Article comment",
  social_statement: "Social statement",
  internal_briefing: "Internal briefing",
};

export const GENERATED_BY_LABELS: Record<GeneratedBy, string> = {
  ai: "Written by Lia",
  user: "Written by a person",
  imported: "Imported",
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  canceled: "Canceled",
};

export const PLATFORM_CONNECTION_STATUS_LABELS: Record<
  PlatformConnectionStatus,
  string
> = {
  pending: "Pending setup",
  connected: "Connected",
  action_required: "Action required",
  disconnected: "Not connected",
  error: "Connection error",
};

export const LOCATION_STATUS_LABELS: Record<LocationStatus, string> = {
  setup: "Onboarding",
  active: "Active",
  review: "Under review",
  inactive: "Paused",
};

export const MEMBERSHIP_ROLE_LABELS: Record<MembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  communications_lead: "Communications lead",
  location_manager: "Location manager",
  approver: "Approver",
  analyst: "Analyst",
  viewer: "Read-only",
};

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  invited: "Invited",
  active: "Active",
  suspended: "Suspended",
};

export const AUTOMATION_RULE_STATUS_LABELS: Record<AutomationRuleStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  draft: "Draft",
};

export const AUDIT_EVENT_LABELS: Record<AuditEventType, string> = {
  "mention.status_changed": "Mention status changed",
  "response.assigned": "Response assigned",
  "response.approved": "Response approved",
  "response.rejected": "Response rejected",
  "response.generated": "Response generated",
  "response.changes_requested": "Changes requested",
  "response.edited": "Response edited",
  "escalation.assigned": "Escalation assigned",
  "escalation.status_changed": "Escalation status changed",
  "automation_rule.enabled": "Automation rule enabled",
  "automation_rule.disabled": "Automation rule disabled",
  "automation_rule.created": "Rule created",
  "automation_rule.updated": "Rule updated",
  "automation_rule.duplicated": "Rule duplicated",
  "automation_rule.archived": "Rule archived",
  "automation_rule.simulated": "Rule simulated",
  "automation_rule.activation_refused": "Rule activation refused",
  "automation_rule.executed": "Rule executed",
  "automation_rule.execution_failed": "Rule execution failed",
  "automation_sweep.completed": "Automation sweep completed",
  "location.manager_changed": "Location manager changed",
  "location.created": "Location added",
  "integration.oauth_started": "Authorization started",
  "integration.oauth_completed": "Authorization completed",
  "integration.connected": "Integration connected",
  "integration.reauthorization_started": "Reauthorization started",
  "integration.reauthorized": "Integration reauthorized",
  "integration.health_checked": "Connection tested",
  "integration.health_degraded": "Connection needs attention",
  "integration.profile_connected": "Profile connected",
  "integration.profile_mapped": "Profile mapped to a location",
  "location.created_from_integration": "Location created from an integration",
  "integration.disconnected": "Integration disconnected",
  "integration.credentials_revoked": "Credentials revoked",
  // Named for what actually happened. "Revocation failed" is the honest label:
  // the local credentials are gone, but the provider never confirmed its side.
  "integration.credentials_revocation_failed": "Credential revocation unconfirmed",
  "integration.reviews_synced": "Reviews synced",
  "integration.review_sync_failed": "Review sync failed",
  "mention.analyzed": "Mention analyzed",
  "mention.analysis_failed": "Analysis failed",
  // Named for who raised it. An escalation nobody chose to raise is a
  // different thing to explain than one a person opened.
  "escalation.created_from_analysis": "Escalation raised by analysis",
  "organization.created": "Organization created",
  "membership.invited": "Member invited",
  "membership.invitation_revoked": "Invitation revoked",
  "membership.joined": "Member joined",
  "membership.role_changed": "Member role changed",
  "membership.status_changed": "Member status changed",
  "membership.removed": "Member removed",
  "brand_voice.updated": "Brand voice updated",
  "monitoring_query.polled": "News query polled",
  "monitoring_query.poll_failed": "News poll failed",
  "monitoring_query.created": "News query created",
  "monitoring_query.updated": "News query updated",
  "monitoring_query.deleted": "News query deleted",
  // Onboarding. "Skipped" is named as such rather than folded into a neutral
  // "step finished": whether somebody connected a source or declined to is the
  // fact that explains an empty inbox six weeks later.
  "onboarding.started": "Setup started",
  "onboarding.organization_completed": "Organization details saved",
  "onboarding.source_connected": "First source connected",
  "onboarding.source_skipped": "Source setup skipped",
  "onboarding.locations_completed": "Locations selected",
  "onboarding.locations_skipped": "Location setup skipped",
  "onboarding.brand_voice_completed": "Brand voice set during setup",
  "onboarding.team_completed": "Teammates invited during setup",
  "onboarding.team_skipped": "Team invitations skipped",
  "onboarding.completed": "Setup completed",
  "onboarding.ready_viewed": "Workspace ready screen opened",
  "reddit_monitor.created": "Reddit monitor created",
  "reddit_monitor.updated": "Reddit monitor updated",
  "reddit_monitor.deleted": "Reddit monitor deleted",
  "reddit_monitor.polled": "Reddit monitor polled",
  "reddit_monitor.poll_failed": "Reddit poll failed",
  "reddit_community.decision_recorded": "Community reply policy decided",
  "reddit_community.review_required": "Community rules changed, needs review",
  "reddit_content.removed": "Reddit content removed at source",
  "reddit_content.reconciled": "Reddit content re-verified",
  "response.published": "Response published",
  "response.publish_failed": "Response publishing failed",
  // Not "failed". Lia does not know whether the reply was posted, and saying
  // it failed would invite exactly the retry this state exists to prevent.
  "response.publish_reconciled": "Response publishing checked with the platform",
  "response.retracted": "Response retracted",
};

/** Sync-run outcomes, as a person would describe them. */
export const SYNC_RUN_STATUS_LABELS: Record<SyncRunStatus, string> = {
  running: "Syncing",
  completed: "Completed",
  // Not "failed": some reviews did import, and telling someone nothing worked
  // when most of it did sends them looking for a problem that is not there.
  partial: "Completed with problems",
  failed: "Failed",
};

export const SYNC_TRIGGER_LABELS: Record<SyncTrigger, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
};

export const CONNECTION_HEALTH_LABELS: Record<ConnectionHealthStatus, string> = {
  healthy: "Healthy",
  token_expiring: "Access expiring",
  authorization_required: "Reauthorization required",
  insufficient_permissions: "Missing permissions",
  quota_limited: "Rate limited by Google",
  provider_unavailable: "Google unavailable",
  unknown_error: "Unknown error",
};

/** Capability states on an integration detail screen. Sentence case, per CLAUDE.md. */
export const INTEGRATION_CAPABILITY_STATE_LABELS: Record<
  IntegrationCapabilityState,
  string
> = {
  enabled: "Enabled",
  not_configured: "Not configured",
  unavailable: "Unavailable",
};

/**
 * Reddit community postures.
 *
 * The three non-permissive labels say what a person has to *do*, not what the
 * database holds. "Unknown" would be accurate and useless — it is the state of
 * a community nobody has looked at, and the label's job is to say that
 * somebody has to.
 */
export const REDDIT_COMMUNITY_POSTURE_LABELS: Record<
  RedditCommunityPostureValue,
  string
> = {
  unknown: "Rules not checked",
  review_required: "Needs a decision",
  allowed: "Approved for replies",
  blocked: "Replies blocked",
};

export const REDDIT_POLL_RUN_KIND_LABELS: Record<RedditPollRunKind, string> = {
  search: "Post search",
  thread_refresh: "Thread refresh",
  deletion_reconcile: "Deletion check",
};

/**
 * Publication attempt states.
 *
 * `reconciliation_required` deliberately does not read as a failure. Lia does
 * not know whether the reply was posted, and telling somebody it failed would
 * invite exactly the retry the state exists to prevent.
 */
export const PUBLICATION_ATTEMPT_STATUS_LABELS: Record<
  PublicationAttemptStatus,
  string
> = {
  pending: "Publishing",
  succeeded: "Published",
  failed: "Failed",
  reconciliation_required: "Checking with Reddit",
  superseded: "Superseded",
};

export const MONITORING_QUERY_TYPE_LABELS: Record<MonitoringQueryType, string> = {
  brand: "Brand",
  location: "Location",
  person: "Person",
  topic: "Topic",
};

/** Why the relevance gate refused a candidate article. Sentence case, per CLAUDE.md. */
export const GATE_REJECTION_REASON_LABELS: Record<GateRejectionReason, string> = {
  excluded_term: "Matched an excluded term",
  probable_syndication: "Probable syndication",
  domain_denied: "Publisher domain not allowed",
  no_keyword_match: "No keyword match",
  below_threshold: "Below relevance threshold",
  ambiguous_uncorroborated: "Ambiguous name, not corroborated",
};

export const CAPABILITY_LABELS: Record<string, string> = {
  canReadMentions: "Read mentions",
  canReadFullText: "Read full text",
  supportsWebhooks: "Webhooks",
  canPublishResponses: "Publish responses",
  canEditResponses: "Edit responses",
  canDeleteResponses: "Delete responses",
  requiresApproval: "Human approval required",
  requiresPartnerAccess: "Partner access required",
};
