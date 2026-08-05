import { z } from "zod";

/**
 * Lifecycle vocabularies.
 *
 * Each list is declared once here, exported as a `const` tuple (so TypeScript
 * infers a literal union), and wrapped in a Zod enum for runtime validation.
 * The same names appear as PostgreSQL enum types in
 * `supabase/migrations/0001_initial_schema.sql` — keep the two in step.
 */

function vocabulary<const T extends readonly [string, ...string[]]>(values: T) {
  return { values, schema: z.enum(values) } as const;
}

/* -------------------------------------------------------------------------- */
/* Membership                                                                  */
/* -------------------------------------------------------------------------- */

export const MEMBERSHIP_ROLES = [
  "owner",
  "admin",
  "communications_lead",
  "location_manager",
  "approver",
  "analyst",
  "viewer",
] as const;
export const membershipRoleSchema = vocabulary(MEMBERSHIP_ROLES).schema;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const MEMBERSHIP_STATUSES = ["invited", "active", "suspended"] as const;
export const membershipStatusSchema = vocabulary(MEMBERSHIP_STATUSES).schema;
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Location                                                                    */
/* -------------------------------------------------------------------------- */

export const LOCATION_STATUSES = ["setup", "active", "review", "inactive"] as const;
export const locationStatusSchema = vocabulary(LOCATION_STATUSES).schema;
export type LocationStatus = z.infer<typeof locationStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Platform                                                                    */
/* -------------------------------------------------------------------------- */

export const PLATFORMS = [
  "google_business_profile",
  "yelp",
  "reddit",
  "news_media",
  "disqus",
  "trustpilot",
  "tripadvisor",
  "facebook",
  "instagram",
] as const;
export const platformSchema = vocabulary(PLATFORMS).schema;
export type Platform = z.infer<typeof platformSchema>;

export const PLATFORM_CONNECTION_STATUSES = [
  "pending",
  "connected",
  "action_required",
  "disconnected",
  "error",
] as const;
export const platformConnectionStatusSchema = vocabulary(
  PLATFORM_CONNECTION_STATUSES,
).schema;
export type PlatformConnectionStatus = z.infer<
  typeof platformConnectionStatusSchema
>;

export const PLATFORM_PROFILE_STATUSES = [
  "pending",
  "active",
  "action_required",
  "disconnected",
] as const;
export const platformProfileStatusSchema = vocabulary(
  PLATFORM_PROFILE_STATUSES,
).schema;
export type PlatformProfileStatus = z.infer<typeof platformProfileStatusSchema>;

/**
 * The outcome of a connection health check.
 *
 * Deliberately finer-grained than `PlatformConnectionStatus`. A quota error and
 * a revoked refresh token both leave a connection unusable *right now*, but only
 * one of them needs a person to re-authorize — collapsing them into "error"
 * would send users to re-consent screens that fix nothing.
 */
export const CONNECTION_HEALTH_STATUSES = [
  "healthy",
  "token_expiring",
  "authorization_required",
  "insufficient_permissions",
  "quota_limited",
  "provider_unavailable",
  "unknown_error",
] as const;
export const connectionHealthStatusSchema = vocabulary(
  CONNECTION_HEALTH_STATUSES,
).schema;
export type ConnectionHealthStatus = z.infer<typeof connectionHealthStatusSchema>;

/** Health states that a person has to act on. Everything else resolves itself. */
export const HEALTH_STATUSES_NEEDING_ACTION: readonly ConnectionHealthStatus[] = [
  "authorization_required",
  "insufficient_permissions",
];

/**
 * The outcome of one synchronisation run.
 *
 * `partial` is deliberately not folded into `failed`. Some reviews imported and
 * some did not is a different thing to tell an operator than "nothing worked",
 * and it needs a different next action — look at what failed, rather than fix
 * the connection.
 */
export const SYNC_RUN_STATUSES = [
  "running",
  "completed",
  "partial",
  "failed",
] as const;
export const syncRunStatusSchema = vocabulary(SYNC_RUN_STATUSES).schema;
export type SyncRunStatus = z.infer<typeof syncRunStatusSchema>;

/** Who asked for the sync. `scheduled` exists before any scheduler does. */
export const SYNC_TRIGGERS = ["manual", "scheduled"] as const;
export const syncTriggerSchema = vocabulary(SYNC_TRIGGERS).schema;
export type SyncTrigger = z.infer<typeof syncTriggerSchema>;

/** Sync-run states that are over, whatever the outcome. */
export const TERMINAL_SYNC_RUN_STATUSES: readonly SyncRunStatus[] = [
  "completed",
  "partial",
  "failed",
];

/** Sync-run states that count as having refreshed the data. */
export const SUCCESSFUL_SYNC_RUN_STATUSES: readonly SyncRunStatus[] = [
  "completed",
  "partial",
];

/* -------------------------------------------------------------------------- */
/* Mention                                                                     */
/* -------------------------------------------------------------------------- */

export const MENTION_SOURCE_TYPES = [
  "google_review",
  "yelp_review",
  "trustpilot_review",
  "tripadvisor_review",
  "reddit_post",
  "reddit_comment",
  "news_article",
  "article_comment",
  "facebook_comment",
  "instagram_comment",
] as const;
export const mentionSourceTypeSchema = vocabulary(MENTION_SOURCE_TYPES).schema;
export type MentionSourceType = z.infer<typeof mentionSourceTypeSchema>;

export const MENTION_STATUSES = [
  "new",
  "analyzed",
  "draft_ready",
  "needs_approval",
  "escalated",
  "responded",
  "monitoring",
  "no_action_recommended",
  "dismissed",
] as const;
export const mentionStatusSchema = vocabulary(MENTION_STATUSES).schema;
export type MentionStatus = z.infer<typeof mentionStatusSchema>;

export const SENTIMENTS = [
  "positive",
  "neutral",
  "negative",
  "mixed",
  "unknown",
] as const;
export const sentimentSchema = vocabulary(SENTIMENTS).schema;
export type Sentiment = z.infer<typeof sentimentSchema>;

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const riskLevelSchema = vocabulary(RISK_LEVELS).schema;
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** Ordered worst-first. Used for queue ranking, not for storage. */
export const RISK_LEVEL_SEVERITY: Record<RiskLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

export const RECOMMENDED_ACTIONS = [
  "respond_publicly",
  "respond_privately",
  "contact_journalist",
  "publish_owned_statement",
  "monitor",
  "escalate",
  "do_not_engage",
  "dismiss",
] as const;
export const recommendedActionSchema = vocabulary(RECOMMENDED_ACTIONS).schema;
export type RecommendedAction = z.infer<typeof recommendedActionSchema>;

/* -------------------------------------------------------------------------- */
/* Response drafts                                                             */
/* -------------------------------------------------------------------------- */

export const RESPONSE_DRAFT_STATUSES = [
  "draft",
  "awaiting_approval",
  "approved",
  "publishing",
  "submitted",
  "published",
  "rejected_by_platform",
  "failed",
  "deleted",
  "dismissed",
] as const;
export const responseDraftStatusSchema = vocabulary(
  RESPONSE_DRAFT_STATUSES,
).schema;
export type ResponseDraftStatus = z.infer<typeof responseDraftStatusSchema>;

export const RESPONSE_TYPES = [
  "public_reply",
  "private_reply",
  "journalist_email",
  "article_comment",
  "social_statement",
  "internal_briefing",
] as const;
export const responseTypeSchema = vocabulary(RESPONSE_TYPES).schema;
export type ResponseType = z.infer<typeof responseTypeSchema>;

export const GENERATED_BY = ["ai", "user", "imported"] as const;
export const generatedBySchema = vocabulary(GENERATED_BY).schema;
export type GeneratedBy = z.infer<typeof generatedBySchema>;

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "canceled",
] as const;
export const approvalStatusSchema = vocabulary(APPROVAL_STATUSES).schema;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Escalations                                                                 */
/* -------------------------------------------------------------------------- */

export const ESCALATION_CATEGORIES = [
  "food_safety",
  "injury",
  "discrimination",
  "employee_misconduct",
  "legal_threat",
  "privacy",
  "refund_dispute",
  "media_inquiry",
  "viral_discussion",
  "misinformation",
  "other",
] as const;
export const escalationCategorySchema = vocabulary(ESCALATION_CATEGORIES).schema;
export type EscalationCategory = z.infer<typeof escalationCategorySchema>;

export const ESCALATION_STATUSES = [
  "open",
  "in_progress",
  "pending_approval",
  "resolved",
  "dismissed",
] as const;
export const escalationStatusSchema = vocabulary(ESCALATION_STATUSES).schema;
export type EscalationStatus = z.infer<typeof escalationStatusSchema>;

/** Escalations reuse the risk vocabulary for severity. */
export const ESCALATION_SEVERITIES = RISK_LEVELS;
export const escalationSeveritySchema = riskLevelSchema;
export type EscalationSeverity = RiskLevel;

/* -------------------------------------------------------------------------- */
/* Automation                                                                  */
/* -------------------------------------------------------------------------- */

export const AUTOMATION_RULE_STATUSES = ["active", "inactive", "draft"] as const;
export const automationRuleStatusSchema = vocabulary(
  AUTOMATION_RULE_STATUSES,
).schema;
export type AutomationRuleStatus = z.infer<typeof automationRuleStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export const ACTOR_TYPES = ["user", "system", "ai", "integration"] as const;
export const actorTypeSchema = vocabulary(ACTOR_TYPES).schema;
export type ActorType = z.infer<typeof actorTypeSchema>;

export const AUDIT_ENTITY_TYPES = [
  "organization",
  "membership",
  "location",
  "platform_connection",
  "platform_profile",
  "mention",
  "mention_analysis",
  "response_draft",
  "approval",
  "escalation",
  "automation_rule",
] as const;
export const auditEntityTypeSchema = vocabulary(AUDIT_ENTITY_TYPES).schema;
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;

/**
 * Audit event names.
 *
 * Closed on purpose: an event name that is not listed here is a typo, and a
 * typo in an audit trail is worse than a compile error.
 */
export const AUDIT_EVENT_TYPES = [
  "mention.status_changed",
  "response.assigned",
  "response.approved",
  "response.rejected",
  "escalation.assigned",
  "escalation.status_changed",
  "automation_rule.enabled",
  "automation_rule.disabled",
  "location.manager_changed",
  // Integration lifecycle. Every consequential connection change appears here;
  // none of these events may carry tokens, authorization codes, or state values.
  "integration.oauth_started",
  "integration.oauth_completed",
  "integration.connected",
  "integration.reauthorization_started",
  "integration.reauthorized",
  "integration.health_checked",
  "integration.health_degraded",
  "integration.profile_connected",
  "integration.profile_mapped",
  "location.created_from_integration",
  "integration.disconnected",
  "integration.credentials_revoked",
  "integration.credentials_revocation_failed",
  // Review synchronisation. Attributed to the platform_profile that was synced,
  // because "which restaurant's reviews moved" is the question an auditor has.
  // Metadata carries counts and a normalised error code — never review text,
  // never a reviewer's name, never a token.
  "integration.reviews_synced",
  "integration.review_sync_failed",
  // Analysis. Metadata carries counts, a model name, a prompt version, and a
  // normalised error code — never review text, never a reviewer's name, and
  // never the prompt, which contains both.
  "mention.analyzed",
  "mention.analysis_failed",
  "escalation.created_from_analysis",
] as const;
export const auditEventTypeSchema = vocabulary(AUDIT_EVENT_TYPES).schema;
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

/* -------------------------------------------------------------------------- */
/* Monitoring                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a monitoring query is looking for.
 *
 * Not decoration: the relevance gate weights signals differently per type. A
 * location query weights publisher locality heavily; a brand query does not.
 */
export const monitoringQueryTypeSchema = z.enum([
  "brand",
  "location",
  "person",
  "topic",
]);
export type MonitoringQueryType = z.infer<typeof monitoringQueryTypeSchema>;

/**
 * Why the gate refused a candidate.
 *
 * Lia's own vocabulary. No provider ever supplies one of these, and the reason
 * is what makes the gate tunable rather than a black box (D64).
 */
export const gateRejectionReasonSchema = z.enum([
  "excluded_term",
  "probable_syndication",
  "domain_denied",
  "below_threshold",
]);
export type GateRejectionReason = z.infer<typeof gateRejectionReasonSchema>;
