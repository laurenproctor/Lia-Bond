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

/**
 * Invitation lifecycle.
 *
 * Expiry is deliberately absent. It is derived from `expiresAt` rather than
 * stored, because a stored `expired` needs a scheduled job to write it and the
 * table is wrong in the meantime — every read would have to check the clock as
 * well as the column, which is the check on its own.
 */
export const INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const;
export const invitationStatusSchema = vocabulary(INVITATION_STATUSES).schema;
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

/** What an invitation looks like to somebody holding the link, expiry included. */
export const INVITATION_STATES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
  "unknown",
] as const;
export const invitationStateSchema = vocabulary(INVITATION_STATES).schema;
export type InvitationState = z.infer<typeof invitationStateSchema>;

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
  /**
   * Distinct from `quota_limited`, and the distinction is the whole point: a
   * rate limit clears by itself and this never does. Google allows the
   * Business Profile APIs zero quota until an access application is approved,
   * so the connection is authorised, healthy-looking, and completely unable to
   * fetch anything.
   */
  "quota_not_provisioned",
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

/**
 * How a mention's content got into Lia.
 *
 * Platform-neutral, and named for the next source rather than for Yelp: manual
 * capture is what any provider without a readable review feed will need, and
 * `yelp_manual` would have to be renamed the first time Trustpilot arrived.
 *
 * The distinction is not cosmetic. `provider_api` content was returned by a
 * provider and can be re-fetched, re-verified, and overwritten by a later sync.
 * `manual_entry` content is what a customer typed: nothing can confirm it, no
 * sync will ever refresh it, and the interface must never describe it as
 * imported. That is a different epistemic status, so it is a column rather than
 * a convention — and it is deliberately absent from `IngestMentionInput`, so no
 * synchronisation can relabel a typed review as retrieved, or the reverse.
 */
export const MENTION_CAPTURE_METHODS = ["provider_api", "manual_entry"] as const;
export const mentionCaptureMethodSchema = vocabulary(MENTION_CAPTURE_METHODS).schema;
export type MentionCaptureMethod = z.infer<typeof mentionCaptureMethodSchema>;

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

/**
 * How a published response actually reached the public.
 *
 * `published` on its own cannot answer the question that matters when somebody
 * disputes a reply months later: did Lia watch this happen, or did a person
 * tell us it had? Those carry very different evidentiary weight, and collapsing
 * them would let a user-confirmed publication be defended as if a provider had
 * acknowledged it.
 *
 * - `provider_api` — a provider accepted the response and returned an
 *   identifier for it. Nothing writes this yet; no connector can publish.
 * - `manual_external` — a person posted the response themselves on the
 *   provider's own surface and confirmed it here afterwards. Lia has the
 *   confirming actor and the time they confirmed, and **no** independent
 *   verification. `external_response_id` stays null on this path, permanently,
 *   because there is no provider-assigned identifier to hold.
 *
 * A third value for "we asked the provider and it agreed" is deliberately
 * absent: that is what `provider_api` means, and inventing a
 * `provider_verified` alongside it would imply the plain one is unverified.
 */
export const RESPONSE_PUBLICATION_METHODS = ["provider_api", "manual_external"] as const;
export const responsePublicationMethodSchema = vocabulary(
  RESPONSE_PUBLICATION_METHODS,
).schema;
export type ResponsePublicationMethod = z.infer<
  typeof responsePublicationMethodSchema
>;

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `changes_requested` is the live decision outcome (Task 1 of the
 * response-generation plan): choosing "changes_requested" returns a draft to
 * editable `draft` status instead of terminating it, which "rejected" never
 * did. `rejected` stays in this vocabulary for history — existing rows and
 * the SQL enum still carry it — but nothing writes it going forward. The SQL
 * `approval_status` enum gains `changes_requested` in Task 4; until then only
 * the demo (in-memory) adapter can write it.
 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
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
/* Onboarding                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether an organization is still being set up.
 *
 * Two values, and there is deliberately no `abandoned`. Somebody who signs up
 * and closes the tab has not abandoned anything — they come back and resume,
 * which is the whole point of persisting progress. A third value would need a
 * scheduled job to write it and would change nothing about what the wizard does.
 */
export const ONBOARDING_STATUSES = ["in_progress", "completed"] as const;
export const onboardingStatusSchema = vocabulary(ONBOARDING_STATUSES).schema;
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

/**
 * Where the wizard resumes.
 *
 * `ready` is in this list even though the Workspace Ready screen is not one of
 * the five steps: it is where progress points once the wizard is finished, and
 * naming it is what keeps "finished setup" distinguishable from "has seen the
 * result". Mirrors the `onboarding_step` enum in
 * `supabase/migrations/20260808000100_organization_onboarding.sql`.
 */
export const ONBOARDING_STEPS = [
  "organization",
  "connect_sources",
  "locations",
  "brand_voice",
  "team",
  "ready",
] as const;
export const onboardingStepSchema = vocabulary(ONBOARDING_STEPS).schema;
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

/** The five wizard steps, in order. Excludes `ready`, which is not a step. */
export const ONBOARDING_WIZARD_STEPS = [
  "organization",
  "connect_sources",
  "locations",
  "brand_voice",
  "team",
] as const;

export type OnboardingWizardStep = (typeof ONBOARDING_WIZARD_STEPS)[number];

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
  "brand_voice",
  "monitoring_query",
  // A detected change in a connected Yelp listing's counters. Its own subject
  // rather than `platform_profile`, because "what happened to this listing
  // connection" and "what did Lia observe about it on Tuesday" are different
  // questions, and an auditor asking the second one would otherwise have to
  // read every event on the profile to find the observations among them.
  "yelp_activity_occurrence",
  // Three new subjects, because "which thing did this happen to" has three
  // genuinely different answers, and collapsing any of them would make the
  // trail unqueryable in exactly the case somebody needs it. A Reddit monitor
  // is not a `monitoring_query` — different table, different lifecycle. A
  // community posture is not a `platform_connection` — it is a decision about
  // somebody else's rules, not about Lia's access. A publication attempt is
  // not a `response_draft` — the draft is the words, the attempt is the act of
  // publishing them, and one draft can have several attempts.
  "reddit_monitoring_query",
  "reddit_community_posture",
  "response_publication_attempt",
  // The embedded website widget. Its own subject rather than `location`: the
  // location is a restaurant and the widget is a thing published on the
  // internet under that restaurant's name, and an auditor asking "when did
  // this stop appearing on our homepage" must not have to read every event
  // about the restaurant to find out.
  "review_widget",
  // Billing. Its own subject rather than `organization`, and the distinction
  // is the one an auditor actually needs: "what happened to this company"
  // and "what happened to what this company pays" are different questions,
  // and the second one is the one somebody asks with a lawyer present. The
  // entity id is the organization id — the table is keyed on it — but the
  // subject is the billing relationship, not the tenant.
  "organization_billing",
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
  // Generation. Metadata carries counts, a model name, a prompt version, and
  // a normalised error/failure category — never review text, never the
  // response text, and never the prompt.
  "response.generated",
  // The live decision outcome for "not approved" (Task 1): a draft returned
  // to the writer with a decision note, as opposed to the old terminal
  // `response.rejected`, which nothing emits anymore.
  "response.changes_requested",
  // A person changed a draft's final text. `previousState`/`newState` carry
  // text lengths only — response text embeds customer situations, and the
  // trail records that an edit happened, not the prose.
  "response.edited",
  "escalation.assigned",
  "escalation.status_changed",
  "automation_rule.enabled",
  "automation_rule.disabled",
  // Rule authoring. previousState/newState carry the rule's own
  // configuration — conditions, actions, priority — never mention content.
  // automation_rule.simulated metadata carries counts only.
  "automation_rule.created",
  "automation_rule.updated",
  "automation_rule.duplicated",
  "automation_rule.archived",
  "automation_rule.simulated",
  "automation_rule.activation_refused",
  // Rule execution (G1). These are written by the automation execution
  // functions and subsume the rule's effect on a mention batch, as
  // opposed to rule edits.
  "automation_rule.executed",
  "automation_rule.execution_failed",
  // Sweep lifecycle: recording that an execution pass ran (once per hour,
  // typically), regardless of whether any rules executed.
  "automation_sweep.completed",
  "location.manager_changed",
  // A location somebody typed in, as opposed to one discovered through an
  // integration. Kept apart from `location.created_from_integration` because
  // "where did this restaurant record come from" is the question, and one
  // answer is a person and the other is Google.
  "location.created",
  // The three location-change events partition the editable fields between
  // them, and the partition is the point. `location.updated` covers identity,
  // address, slug, and timezone; it is deliberately **not** emitted for a
  // status or manager change, because those have their own events. A generic
  // event that also fired for them would make "who changed this restaurant's
  // address" return manager reassignments too, and the specific events would
  // stop being worth having. An edit touching two partitions emits two events;
  // a manager-only edit emits one.
  "location.updated",
  // Lifecycle: setup / active / review / inactive. A reporting and retirement
  // state, not a processing switch — nothing in the product pauses collection,
  // analysis, or rule execution on the strength of it.
  "location.status_changed",
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
  // Membership. Metadata carries roles, statuses, and email addresses — never
  // an invitation token, which would turn the audit trail into a way in.
  "organization.created",
  "membership.invited",
  "membership.invitation_revoked",
  "membership.joined",
  "membership.role_changed",
  "membership.status_changed",
  "membership.removed",
  "brand_voice.updated",
  // News polling. Metadata carries counts and a normalised error code —
  // never an article title, a URL, or a publisher name.
  "monitoring_query.polled",
  "monitoring_query.poll_failed",
  // Monitoring query lifecycle — creating, editing, and removing what Lia
  // watches. `newState`/`previousState` carry the query's own fields (keywords,
  // domains, thresholds), never article content, which the query has no
  // relationship to until a poll runs.
  "monitoring_query.created",
  "monitoring_query.updated",
  "monitoring_query.deleted",
  // Onboarding. Recorded against entity type `organization` with the
  // organization's own id — onboarding is a property of an organization, not a
  // thing in its own right. Metadata carries step names, skip flags, and counts
  // only: never an OAuth token, an invitation token, a Google account name, or
  // any review text.
  "onboarding.started",
  "onboarding.organization_completed",
  "onboarding.source_connected",
  "onboarding.source_skipped",
  "onboarding.locations_completed",
  "onboarding.locations_skipped",
  "onboarding.brand_voice_completed",
  "onboarding.team_completed",
  "onboarding.team_skipped",
  "onboarding.completed",
  "onboarding.ready_viewed",
  // Yelp Assisted — listing checks. Attributed to the platform_profile that was
  // checked, matching `integration.reviews_synced`'s reasoning: "which
  // restaurant's listing moved" is the question an auditor has. Metadata
  // carries the two counters, a normalised error code, and nothing else.
  // Deliberately *not* named `reviews_synced`: nothing was synced, and a
  // shared event name would make the two indistinguishable in a query.
  "integration.listing_checked",
  "integration.listing_check_failed",
  // A change Lia observed between two listing checks. Metadata carries the
  // before and after counters and the kind of change — never a claim about how
  // many reviews were written, which the counters cannot support.
  "yelp_activity.detected",
  // A review a customer typed into Lia. Metadata carries the source, the
  // rating, the derived deduplication key, and whether a duplicate warning was
  // deliberately overridden — never the review text, which is the same rule
  // every other event on a mention already keeps.
  "mention.captured_manually",
  // Assisted posting. `confirmed` is a person stating they posted an approved
  // response on the provider's own surface; `unconfirmed` is the correction
  // path for somebody who said so by mistake. Neither claims provider
  // verification, and the metadata says which method was recorded so a reader
  // cannot mistake one for an API publication.
  "response.publication_confirmed",
  "response.publication_unconfirmed",
  // Reddit monitoring. Metadata carries counts, identifiers, and normalised
  // codes. Two Reddit-specific exclusions are named because they are not
  // obviously "content" and would otherwise look safe to record: a monitor's
  // search terms are the customer's own words about their brand, so a trail of
  // them is a trail of what a restaurant is worried about; and a subreddit
  // name, while not Reddit's content, is still a fact about the customer that
  // the monitor row already holds.
  "reddit_monitor.created",
  "reddit_monitor.updated",
  "reddit_monitor.deleted",
  "reddit_monitor.polled",
  "reddit_monitor.poll_failed",
  // A person's recorded decision about whether Lia may reply in one community,
  // and the automatic return to review when its rules change underneath a
  // previously granted approval.
  "reddit_community.decision_recorded",
  "reddit_community.review_required",
  // Content that stopped existing at the source. Lia's own row ids and a
  // reason code only — an audit row about deleted content that quoted it would
  // defeat itself.
  "reddit_content.removed",
  "reddit_content.reconciled",
  // Publication: the response lifecycle's public half. Claiming the right to
  // post, the outcome, the uncertain outcome that must be reconciled against
  // the connected account's own history rather than retried, and a retraction.
  // No draft text, no provider message, no Reddit content.
  "response.published",
  "response.publish_failed",
  "response.publish_reconciled",
  "response.retracted",
  // The website review widget. Five names rather than a `created`/`updated`
  // pair, because three of these change what a stranger sees on a customer's
  // own website and the other two do not, and a trail that cannot separate
  // them is a trail nobody can answer "when did our homepage change" from.
  //
  // Metadata carries widget configuration only — theme, layout, selection
  // mode, approved domains, and the id of the pinned review. Never the review
  // text and never the reviewer's name: the widget publishes those, but the
  // audit trail is not where a copy of them belongs, which is the same rule
  // every other event about a mention already keeps.
  "review_widget.created",
  "review_widget.updated",
  // Reversible, and the public id survives. What a customer taking a page down
  // for a fortnight is actually asking for.
  "review_widget.disabled",
  "review_widget.enabled",
  // The irreversible one: every snippet already pasted into a website stops
  // resolving. Its own event because it is the only widget act that cannot be
  // undone from Lia, and the only one whose blast radius is somebody else's
  // published HTML.
  "review_widget.embed_id_rotated",
  // Billing.
  //
  // Every one of these is written from a verified Stripe webhook or an
  // authorized operator action, never from a browser round trip, and the
  // actor type says which: `integration` for Stripe, `system` for the
  // reconciliation job, `user` only where a person pressed something in Lia.
  //
  // **No event here may carry a card number, a bank detail, a payment-method
  // payload, a Stripe secret, or a provider error message.** Metadata carries
  // Lia-authored words from closed vocabularies, Stripe object ids, amounts in
  // cents, and counts. That is the same rule the Anthropic and GNews paths
  // already keep, applied to the one integration where breaking it would be a
  // compliance incident rather than an embarrassment.
  "billing.checkout_started",
  // The trial lifecycle, spelled out rather than collapsed into one
  // `billing.trial_changed`. Each of these is a different commercial fact and
  // somebody will one day count them separately: how many trials started, how
  // many were abandoned before the charge, how many converted.
  "billing.trial_started",
  "billing.trial_canceled",
  "billing.trial_converted",
  "billing.trial_expired",
  // An authorized operator granting or extending a trial by hand. Deliberately
  // not the same name as `billing.trial_started`: one is a customer taking an
  // offer the product made, the other is a person deciding to make one, and
  // the difference is the whole point of auditing it. Metadata names the
  // operator and the grant source.
  "billing.trial_granted",
  "billing.subscription_activated",
  "billing.subscription_updated",
  "billing.subscription_ended",
  // Scheduled, not yet ended. Kept apart from `subscription_ended` because a
  // customer who cancelled in March for a subscription that runs to December
  // is a retention question in March, and a support question in December.
  "billing.cancellation_scheduled",
  // Purchased location capacity moved. Metadata carries the before and after
  // quantity and which side asked for it.
  "billing.capacity_changed",
  "billing.payment_failed",
  "billing.payment_recovered",
  // A person opened Stripe's hosted portal. Recorded because everything that
  // happens inside it is invisible to Lia until a webhook arrives, so this is
  // the only entry that ties a later subscription change back to whoever went
  // looking for it.
  "billing.portal_opened",
  // Complimentary, grandfathered, internal, or sales-managed access being set
  // or cleared. The brief's requirement that free access be explicit,
  // auditable, and explainable is this row.
  "billing.access_disposition_set",
  // The reconciliation job found Lia's projection disagreeing with Stripe.
  // Written even when the job repairs it, because a projection that drifted
  // once will drift again and the pattern is the diagnosis.
  "billing.projection_drift_detected",
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
export const MONITORING_QUERY_TYPES = [
  "brand",
  "location",
  "person",
  "topic",
] as const;
export const monitoringQueryTypeSchema = vocabulary(MONITORING_QUERY_TYPES).schema;
export type MonitoringQueryType = z.infer<typeof monitoringQueryTypeSchema>;

/**
 * Why the gate refused a candidate.
 *
 * Lia's own vocabulary. No provider ever supplies one of these, and the reason
 * is what makes the gate tunable rather than a black box (D82).
 */
export const GATE_REJECTION_REASONS = [
  "excluded_term",
  "probable_syndication",
  "domain_denied",
  // Nothing in the query matched. The score is always 0, and the keywords —
  // not the threshold — are what an operator would change.
  "no_keyword_match",
  // Scored, and scored too low. The only reason of the three for which the
  // threshold is the lever.
  "below_threshold",
  // A lone short brand name with nothing corroborating it. Rejected
  // regardless of score, so a high score here is expected rather than
  // contradictory — see AMBIGUOUS_TERM_MAX_LENGTH in gate.ts.
  "ambiguous_uncorroborated",
] as const;
export const gateRejectionReasonSchema = vocabulary(GATE_REJECTION_REASONS).schema;
export type GateRejectionReason = z.infer<typeof gateRejectionReasonSchema>;

/* -------------------------------------------------------------------------- */
/* Website review widget                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How the embedded widget looks.
 *
 * Two values, and no `auto`. A widget lives inside somebody else's page, where
 * `prefers-color-scheme` describes the *visitor's* operating system and says
 * nothing about the site around it — a light restaurant homepage would render
 * a black card for every visitor who runs their laptop in dark mode. The
 * customer picks, because the customer is the only party who can see the page.
 */
export const REVIEW_WIDGET_THEMES = ["light", "dark"] as const;
export const reviewWidgetThemeSchema = vocabulary(REVIEW_WIDGET_THEMES).schema;
export type ReviewWidgetTheme = z.infer<typeof reviewWidgetThemeSchema>;

/**
 * Which arrangement the widget draws.
 *
 * Three arrangements of the same single review: the words alone, the words
 * with photographs, the words with a video. They are variations on one card
 * rather than three cards — the Google wordmark, the stars, the attribution
 * and the footer are identical in all three, because those are what make it a
 * review widget rather than a media embed.
 *
 * **This is the vocabulary the renderer accepts, not the one a customer may
 * save.** See `SAVABLE_REVIEW_WIDGET_LAYOUTS` below for why those are two
 * lists today and what has to be true before they become one.
 */
export const REVIEW_WIDGET_LAYOUTS = [
  "single_review_text",
  "single_review_photo",
  "single_review_video",
] as const;
export const reviewWidgetLayoutSchema = vocabulary(REVIEW_WIDGET_LAYOUTS).schema;
export type ReviewWidgetLayout = z.infer<typeof reviewWidgetLayoutSchema>;

/**
 * Which of those a customer may actually store against their widget.
 *
 * One, and the gap is deliberate rather than unfinished. **Google's review API
 * returns no photographs and no video** — the payload Lia parses is the
 * reviewer, the rating, the comment, the timestamps and the owner's reply, and
 * nothing else (`googleReviewSchema` in
 * `@/integrations/google-business-profile/schemas`). There is no per-review
 * media of any kind to put in a media-led layout, so the two are rendered from
 * sample content in Lia's own preview surfaces and cannot be pointed at a real
 * website until media has a real source — a customer's own upload being the
 * obvious candidate, and a decision nobody has made yet.
 *
 * The narrow list is what makes that structural. It mirrors the check
 * constraint on `review_widgets.layout` exactly, so the schema rejects a
 * layout the column would reject anyway, at the edge of the application rather
 * than as a database error under a save button. When media ships, this list
 * and that constraint widen together — and the type checker will point at
 * every place that has to change, because nothing else narrows.
 */
export const SAVABLE_REVIEW_WIDGET_LAYOUTS = ["single_review_text"] as const;
export const savableReviewWidgetLayoutSchema = vocabulary(
  SAVABLE_REVIEW_WIDGET_LAYOUTS,
).schema;
export type SavableReviewWidgetLayout = z.infer<
  typeof savableReviewWidgetLayoutSchema
>;

/** Whether the widget follows the feed or is pinned to one review. */
export const REVIEW_WIDGET_SELECTION_MODES = ["most_recent", "specific"] as const;
export const reviewWidgetSelectionModeSchema = vocabulary(
  REVIEW_WIDGET_SELECTION_MODES,
).schema;
export type ReviewWidgetSelectionMode = z.infer<
  typeof reviewWidgetSelectionModeSchema
>;

/**
 * Whether the embed serves a review at all.
 *
 * `disabled` is reversible and keeps the public id, which is what a customer
 * taking a page down for a week wants. Revocation — making an existing snippet
 * permanently dead — is rotation of the public id, not a status, because the
 * two questions ("is it on" and "which id is live") have independent answers.
 */
export const REVIEW_WIDGET_STATUSES = ["active", "disabled"] as const;
export const reviewWidgetStatusSchema = vocabulary(REVIEW_WIDGET_STATUSES).schema;
export type ReviewWidgetStatus = z.infer<typeof reviewWidgetStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Billing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stripe's subscription statuses, mirrored exactly.
 *
 * Lia does not invent, rename, or collapse any of them. That is deliberate and
 * it is the whole posture of this feature: Stripe owns what a subscription
 * *is*, Lia owns what an organization may *do*, and the translation between
 * the two happens in one pure function (`resolveEntitlement`) rather than
 * being smuggled into the vocabulary.
 *
 * Collapsing `past_due` and `unpaid` would be the tempting one — both mean a
 * payment did not land — and it would be wrong. `past_due` means Stripe is
 * still retrying and the customer keeps working; `unpaid` means it has given
 * up and access stops. Same cause, opposite answers.
 *
 * Check-constrained text in the database rather than a Postgres enum, for the
 * reason the Reddit and Yelp schemas recorded: an enum value cannot be
 * dropped, and this list belongs to somebody else's API.
 */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "canceled",
  "paused",
] as const;
export const subscriptionStatusSchema = vocabulary(SUBSCRIPTION_STATUSES).schema;
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/**
 * How often the subscription bills.
 *
 * Stripe's own words (`month`, `year`), not Lia's (`monthly`, `annual`). The
 * marketing site uses the second pair and always has — `BillingPeriod` in
 * `@/lib/pricing/schedule`. Keeping them as two vocabularies with an explicit
 * mapping is the smaller evil: this one is written by a webhook projecting a
 * Stripe object, and silently rewriting a provider's value on the way into the
 * database is how a column stops meaning what its source means.
 */
export const BILLING_INTERVALS = ["month", "year"] as const;
export const billingIntervalSchema = vocabulary(BILLING_INTERVALS).schema;
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

/**
 * Who decided this organization gets a trial.
 *
 * Recorded on the row rather than left to the audit trail alone, because
 * "can this organization have another trial" is a question the Checkout action
 * asks on every call, and a query that has to read the trail to answer it
 * would be one join away from being skipped.
 */
export const TRIAL_GRANT_SOURCES = ["self_service", "operator", "sales"] as const;
export const trialGrantSourceSchema = vocabulary(TRIAL_GRANT_SOURCES).schema;
export type TrialGrantSource = z.infer<typeof trialGrantSourceSchema>;

/**
 * Why an organization has access it is not paying for.
 *
 * `standard` is the ordinary case and means nothing special is going on:
 * entitlement comes from the subscription, or from nowhere. The other four
 * exist so that free access is never a silent absence of a row — the brief's
 * requirement that complimentary access be explicit, auditable, explainable,
 * and optionally time-limited is enforced by this column plus
 * `access_disposition_expires_at`.
 *
 * `internal` is Lia's own organizations and the demo dataset. `grandfathered`
 * is for organizations that predate billing and carries an expiry.
 * `sales_managed` means an invoice exists outside Stripe Checkout.
 */
export const ACCESS_DISPOSITIONS = [
  "standard",
  "internal",
  "complimentary",
  "grandfathered",
  "sales_managed",
] as const;
export const accessDispositionSchema = vocabulary(ACCESS_DISPOSITIONS).schema;
export type AccessDisposition = z.infer<typeof accessDispositionSchema>;

/**
 * What an organization may do right now.
 *
 * Three values, and the middle one is the one that matters. A failed payment
 * must not read the same as an expired trial: one is a customer who wants to
 * keep paying and hit a declined card, the other is somebody who decided not
 * to buy. Collapsing them into a boolean would make the product treat the
 * first like the second, which is how you lose a customer over an expired
 * card.
 */
export const ENTITLEMENT_ACCESS = ["full", "full_with_warning", "read_only"] as const;
export const entitlementAccessSchema = vocabulary(ENTITLEMENT_ACCESS).schema;
export type EntitlementAccess = z.infer<typeof entitlementAccessSchema>;

/**
 * Why the entitlement is what it is.
 *
 * Closed, because every one of these is rendered as a sentence to a customer
 * and an unlisted reason would be a screen with nothing on it. The banner, the
 * billing page, and the refusal message on a blocked action all switch on this
 * and nothing else.
 */
export const ENTITLEMENT_REASONS = [
  /** No subscription, and enforcement is not switched on for this organization. */
  "unbilled_not_enforced",
  /** No subscription, and enforcement is on. */
  "no_subscription",
  "trialing",
  "active",
  "payment_past_due",
  "billing_setup_incomplete",
  "billing_setup_expired",
  "payment_unpaid",
  "trial_canceled",
  "trial_expired",
  "subscription_canceled",
  /** Cancelled, but the period already paid for has not ended yet. */
  "canceled_paid_through",
  "subscription_paused",
  /** Access granted by disposition rather than by payment. */
  "complimentary",
] as const;
export const entitlementReasonSchema = vocabulary(ENTITLEMENT_REASONS).schema;
export type EntitlementReason = z.infer<typeof entitlementReasonSchema>;

/**
 * Where one Stripe event is in Lia's processing.
 *
 * `ignored` is not a failure: a verified event of a type Lia does not handle
 * is a successful outcome, and recording it as such is what keeps the failure
 * count meaningful. Without it, every unhandled type would either look like an
 * error or leave no trace at all, and the first is noise while the second
 * makes "did we ever receive that" unanswerable.
 */
export const WEBHOOK_PROCESSING_STATUSES = [
  "received",
  "processing",
  "processed",
  "failed",
  "ignored",
] as const;
export const webhookProcessingStatusSchema = vocabulary(
  WEBHOOK_PROCESSING_STATUSES,
).schema;
export type WebhookProcessingStatus = z.infer<
  typeof webhookProcessingStatusSchema
>;

/**
 * Why processing an event failed — Lia's word for it, never Stripe's.
 *
 * The stored value is one of these and nothing else. A driver message can
 * quote a connection string and a Stripe error can quote a request URL, so
 * neither is ever written to this table, logged, or returned. The same rule
 * `news_poll_runs.errorMessage` already keeps.
 *
 * Each one implies a different response, which is why there are eight rather
 * than one: `signature` is an attack or a misconfigured secret,
 * `mode_mismatch` is a sandbox key pointed at live data, `unmatched_customer`
 * is a Stripe object Lia has never heard of, `organization_mismatch` is
 * metadata disagreeing with the customer mapping and is the one that means
 * somebody may be trying something, and `duplicate_subscription` is the
 * invariant that an organization has exactly one.
 */
export const WEBHOOK_ERROR_CATEGORIES = [
  "signature",
  "mode_mismatch",
  "unmatched_customer",
  "unmatched_subscription",
  "organization_mismatch",
  "duplicate_subscription",
  "stripe_api_error",
  "database_error",
  "unhandled",
] as const;
export const webhookErrorCategorySchema = vocabulary(
  WEBHOOK_ERROR_CATEGORIES,
).schema;
export type WebhookErrorCategory = z.infer<typeof webhookErrorCategorySchema>;

/**
 * Subscription statuses that mean an organization already has one.
 *
 * The guard the Checkout action reads before creating a session: an
 * organization in any of these states must not be able to start a second
 * subscription. `canceled`, `incomplete_expired`, and `unpaid` are absent
 * because all three are terminal — buying again is exactly what those
 * customers should be able to do.
 */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "incomplete",
  "paused",
];

/** How many days a self-service trial runs. Stated once, read everywhere. */
export const TRIAL_PERIOD_DAYS = 14;
