import {
  analysisRunSchema,
  approvalSchema,
  auditEventSchema,
  automationRuleExecutionSchema,
  automationRuleSchema,
  automationSweepSchema,
  brandVoiceProfileSchema,
  escalationSchema,
  generationAttemptSchema,
  invitationSchema,
  locationSchema,
  membershipSchema,
  mentionAnalysisSchema,
  mentionSchema,
  monitoringQuerySchema,
  newsPollRunSchema,
  newsRejectedCandidateSchema,
  oauthStateSchema,
  organizationOnboardingSchema,
  organizationSchema,
  platformConnectionSchema,
  platformProfileSchema,
  platformSyncRunSchema,
  responseDraftSchema,
  userSchema,
  type AnalysisRun,
  type Approval,
  type AuditEvent,
  type AutomationRule,
  type AutomationRuleExecution,
  type AutomationSweep,
  type BrandVoiceProfile,
  type Escalation,
  type GenerationAttempt,
  type Invitation,
  type Location,
  type Membership,
  type Mention,
  type MentionAnalysis,
  type MonitoringQuery,
  type NewsPollRun,
  type NewsRejectedCandidate,
  type OAuthState,
  type Organization,
  type OrganizationOnboarding,
  type PlatformConnection,
  type PlatformProfile,
  type PlatformSyncRun,
  type ResponseDraft,
  type User,
} from "@/domain";
import { DataError } from "@/lib/data/errors";
import type { SimulationCandidate } from "@/lib/data/types";

/**
 * Row mapping between PostgreSQL and the domain.
 *
 * Two jobs. First, snake_case to camelCase. Second — and the reason this is not
 * a one-line rename helper — every row is re-validated against its domain
 * schema on the way in. A column that drifts from the migration, a null that
 * should not be, a numeric that arrives as a string: all of it surfaces here
 * with a clear message instead of as a strange render three layers up.
 */

type Row = Record<string, unknown>;

function parseOrThrow<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  value: unknown,
  table: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw new DataError(
      "unavailable",
      `A ${table} row from the database did not match the expected shape.`,
    );
  }
  return result.data;
}

/** Postgres `numeric` arrives as a string over PostgREST. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * A short, single-line preview of a mention's content.
 *
 * Used only by `toSimulationCandidate`: the simulator's sample carries no
 * full mention body, just enough to recognise the match by eye. Mirrors the
 * demo adapter's `truncateExcerpt` exactly — same limit, same ellipsis rule.
 */
function truncateExcerpt(content: string, limit = 140): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

export function toOrganization(row: Row): Organization {
  return parseOrThrow(
    organizationSchema,
    {
      id: row.id,
      name: row.name,
      slug: row.slug,
      industry: row.industry,
      websiteUrl: row.website_url ?? null,
      defaultTimezone: row.default_timezone,
      defaultLanguage: row.default_language,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "organization",
  );
}

export function toOrganizationOnboarding(row: Row): OrganizationOnboarding {
  return parseOrThrow(
    organizationOnboardingSchema,
    {
      organizationId: row.organization_id,
      status: row.status,
      currentStep: row.current_step,
      organizationCompletedAt: isoOrNull(row.organization_completed_at),
      sourceCompletedAt: isoOrNull(row.source_completed_at),
      sourceSkippedAt: isoOrNull(row.source_skipped_at),
      locationsCompletedAt: isoOrNull(row.locations_completed_at),
      locationsSkippedAt: isoOrNull(row.locations_skipped_at),
      brandVoiceCompletedAt: isoOrNull(row.brand_voice_completed_at),
      teamCompletedAt: isoOrNull(row.team_completed_at),
      teamSkippedAt: isoOrNull(row.team_skipped_at),
      completedAt: isoOrNull(row.completed_at),
      readyViewedAt: isoOrNull(row.ready_viewed_at),
      organizationSize: row.organization_size ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "onboarding progress",
  );
}

export function toUser(row: Row): User {
  return parseOrThrow(
    userSchema,
    {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName: row.full_name,
      avatarUrl: row.avatar_url ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "user",
  );
}

export function toInvitation(row: Row): Invitation {
  return parseOrThrow(
    invitationSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      role: row.role,
      status: row.status,
      invitedByUserId: row.invited_by_user_id ?? null,
      expiresAt: iso(row.expires_at),
      acceptedAt: row.accepted_at ? iso(row.accepted_at) : null,
      acceptedByUserId: row.accepted_by_user_id ?? null,
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "invitation",
  );
}

export function toMembership(row: Row): Membership {
  return parseOrThrow(
    membershipSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "membership",
  );
}

export function toLocation(row: Row): Location {
  return parseOrThrow(
    locationSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      slug: row.slug,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2 ?? null,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      countryCode: row.country_code,
      timezone: row.timezone,
      status: row.status,
      managerUserId: row.manager_user_id ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "location",
  );
}

/**
 * Note what is absent: no credential field is read here.
 *
 * Tokens live in `platform_connection_secrets`, and even if a future migration
 * put one on `platform_connections` by mistake, this mapper names its fields
 * explicitly and `platformConnectionSchema.parse()` strips everything else — so
 * a credential could not ride a connection object into a client component.
 */
export function toPlatformConnection(row: Row): PlatformConnection {
  return parseOrThrow(
    platformConnectionSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      platform: row.platform,
      externalAccountId: row.external_account_id ?? null,
      externalAccountName: row.external_account_name ?? null,
      status: row.status,
      capabilities: row.capabilities,
      tokenExpiresAt: isoOrNull(row.token_expires_at),
      lastSyncedAt: isoOrNull(row.last_synced_at),
      grantedScopes: stringArray(row.granted_scopes),
      providerMetadata: row.provider_metadata ?? {},
      lastHealthCheckAt: isoOrNull(row.last_health_check_at),
      lastHealthStatus: row.last_health_status ?? null,
      lastErrorCode: row.last_error_code ?? null,
      lastErrorMessage: row.last_error_message ?? null,
      connectedByUserId: row.connected_by_user_id ?? null,
      connectedAt: isoOrNull(row.connected_at),
      disconnectedAt: isoOrNull(row.disconnected_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "platform connection",
  );
}

export function toPlatformProfile(row: Row): PlatformProfile {
  return parseOrThrow(
    platformProfileSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      locationId: row.location_id ?? null,
      platformConnectionId: row.platform_connection_id,
      externalProfileId: row.external_profile_id,
      externalProfileName: row.external_profile_name,
      externalAccountId: row.external_account_id ?? null,
      profileUrl: row.profile_url ?? null,
      status: row.status,
      verificationState: row.verification_state ?? null,
      providerMetadata: row.provider_metadata ?? {},
      lastConfirmedAt: isoOrNull(row.last_confirmed_at),
      syncCursor: row.sync_cursor ?? null,
      lastSyncedAt: isoOrNull(row.last_synced_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "platform profile",
  );
}

/**
 * Note what is absent here too: `state_hash`.
 *
 * The hash is a lookup key for a live handshake. It is used inside the
 * repository and deliberately not carried onto the domain object, so nothing
 * that logs or serialises an `OAuthState` can reveal one.
 */
export function toOAuthState(row: Row): OAuthState {
  return parseOrThrow(
    oauthStateSchema,
    {
      id: row.id,
      provider: row.provider,
      organizationId: row.organization_id,
      userId: row.user_id,
      redirectPath: row.redirect_path,
      reauthorization: row.reauthorization ?? false,
      expiresAt: iso(row.expires_at),
      consumedAt: isoOrNull(row.consumed_at),
      createdAt: iso(row.created_at),
    },
    "OAuth state",
  );
}

export function toMention(row: Row): Mention {
  return parseOrThrow(
    mentionSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      locationId: row.location_id ?? null,
      platformConnectionId: row.platform_connection_id,
      platformProfileId: row.platform_profile_id ?? null,
      sourceType: row.source_type,
      externalId: row.external_id,
      externalParentId: row.external_parent_id ?? null,
      sourceUrl: row.source_url ?? null,
      title: row.title ?? null,
      content: row.content,
      authorName: row.author_name ?? null,
      authorExternalId: row.author_external_id ?? null,
      rating: num(row.rating),
      language: row.language ?? null,
      publishedAt: iso(row.published_at),
      receivedAt: iso(row.received_at),
      status: row.status,
      sentiment: row.sentiment,
      riskLevel: row.risk_level,
      relevanceScore: num(row.relevance_score),
      engagementScore: num(row.engagement_score),
      rawPayload: row.raw_payload ?? {},
      externalResourceName: row.external_resource_name ?? null,
      authorAvatarUrl: row.author_avatar_url ?? null,
      authorIsAnonymous: row.author_is_anonymous ?? false,
      sourceUpdatedAt: isoOrNull(row.source_updated_at),
      sourceReplyText: row.source_reply_text ?? null,
      sourceReplyUpdatedAt: isoOrNull(row.source_reply_updated_at),
      sourceMetadata: row.source_metadata ?? {},
      lastSyncedAt: isoOrNull(row.last_synced_at),
      publisherName: row.publisher_name ?? null,
      publisherDomain: row.publisher_domain ?? null,
      isSyndicated: row.is_syndicated ?? false,
      monitoringQueryId: row.monitoring_query_id ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "mention",
  );
}

/**
 * The slim read `mentions.listSimulationCandidates` returns.
 *
 * Not a domain entity, so there is no Zod schema to re-parse against — this
 * is a narrow, deliberately incomplete projection of a mentions row (see the
 * doc comment on `SimulationCandidate` itself for why `excerpt` replaces the
 * full `content` column).
 */
export function toSimulationCandidate(row: Row): SimulationCandidate {
  return {
    id: String(row.id),
    platformConnectionId: String(row.platform_connection_id),
    locationId: row.location_id ? String(row.location_id) : null,
    sourceType: row.source_type as SimulationCandidate["sourceType"],
    rating: num(row.rating),
    status: row.status as SimulationCandidate["status"],
    sentiment: row.sentiment as SimulationCandidate["sentiment"],
    riskLevel: row.risk_level as SimulationCandidate["riskLevel"],
    relevanceScore: num(row.relevance_score),
    publishedAt: iso(row.published_at),
    excerpt: truncateExcerpt(String(row.content ?? "")),
  };
}

/**
 * A sync run.
 *
 * The counts arrive as five separate columns and are folded into one object,
 * because five loose integers on a domain type invite reading four of them.
 */
/**
 * An analysis run.
 *
 * The five counts arrive as separate columns and are folded into one object,
 * for the same reason a sync run's are: five loose integers on a domain type
 * invite reading four of them.
 */
export function toAnalysisRun(row: Row): AnalysisRun {
  return parseOrThrow(
    analysisRunSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      trigger: row.trigger,
      actorUserId: row.actor_user_id ?? null,
      status: row.status,
      startedAt: iso(row.started_at),
      completedAt: isoOrNull(row.completed_at),
      counts: {
        analyzed: Number(row.analyzed_count ?? 0),
        heuristic: Number(row.heuristic_count ?? 0),
        escalated: Number(row.escalated_count ?? 0),
        failed: Number(row.failed_count ?? 0),
        remaining: Number(row.remaining_count ?? 0),
      },
      modelProvider: row.model_provider ?? null,
      modelName: row.model_name ?? null,
      promptVersion: row.prompt_version ?? null,
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "analysis run",
  );
}

export function toPlatformSyncRun(row: Row): PlatformSyncRun {
  return parseOrThrow(
    platformSyncRunSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      platformConnectionId: row.platform_connection_id,
      platformProfileId: row.platform_profile_id,
      resource: row.resource,
      trigger: row.trigger,
      actorUserId: row.actor_user_id ?? null,
      status: row.status,
      startedAt: iso(row.started_at),
      completedAt: isoOrNull(row.completed_at),
      counts: {
        fetched: Number(row.fetched_count ?? 0),
        created: Number(row.created_count ?? 0),
        updated: Number(row.updated_count ?? 0),
        unchanged: Number(row.unchanged_count ?? 0),
        failed: Number(row.failed_count ?? 0),
      },
      pagesFetched: Number(row.pages_fetched ?? 0),
      totalReviewCount:
        row.total_review_count === null || row.total_review_count === undefined
          ? null
          : Number(row.total_review_count),
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "sync run",
  );
}

export function toMentionAnalysis(row: Row): MentionAnalysis {
  return parseOrThrow(
    mentionAnalysisSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      mentionId: row.mention_id,
      modelProvider: row.model_provider,
      modelName: row.model_name,
      promptVersion: row.prompt_version,
      relevanceScore: num(row.relevance_score) ?? 0,
      relevanceExplanation: row.relevance_explanation ?? null,
      sentiment: row.sentiment,
      sentimentScore: num(row.sentiment_score),
      riskLevel: row.risk_level,
      riskCategories: stringArray(row.risk_categories),
      riskExplanation: row.risk_explanation ?? null,
      topics: stringArray(row.topics),
      factsNeedingVerification: stringArray(row.facts_needing_verification),
      recommendedAction: row.recommended_action,
      recommendationExplanation: row.recommendation_explanation ?? null,
      analyzedAt: iso(row.analyzed_at),
      analysisRunId: row.analysis_run_id ?? null,
      inputTokens:
        row.input_tokens === null || row.input_tokens === undefined
          ? null
          : Number(row.input_tokens),
      outputTokens:
        row.output_tokens === null || row.output_tokens === undefined
          ? null
          : Number(row.output_tokens),
      outcomeAppliedAt: isoOrNull(row.outcome_applied_at),
      createdAt: iso(row.created_at),
    },
    "mention analysis",
  );
}

export function toResponseDraft(row: Row): ResponseDraft {
  return parseOrThrow(
    responseDraftSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      mentionId: row.mention_id,
      responseType: row.response_type,
      draftText: row.draft_text,
      finalText: row.final_text ?? null,
      status: row.status,
      generatedBy: row.generated_by,
      generationProvider: row.generation_provider ?? null,
      generationModel: row.generation_model ?? null,
      promptVersion: row.prompt_version ?? null,
      brandVoiceVersion: row.brand_voice_version ?? null,
      policyVersion: row.policy_version ?? null,
      assignedUserId: row.assigned_user_id ?? null,
      approvedByUserId: row.approved_by_user_id ?? null,
      approvedAt: isoOrNull(row.approved_at),
      publishedAt: isoOrNull(row.published_at),
      externalResponseId: row.external_response_id ?? null,
      publicationError: row.publication_error ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "response draft",
  );
}

/**
 * A generation attempt, from `generation_attempts`.
 *
 * Deliberately never reads `row.claim_token`: the column is excluded from
 * `authenticated`'s grant (see the migration's comment on
 * `generation_attempts_select`), and the domain schema has no field for it
 * either (`GenerationAttempt`'s doc comment) — issued once, by `claim`,
 * never read back.
 */
export function toGenerationAttempt(row: Row): GenerationAttempt {
  return parseOrThrow(
    generationAttemptSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      mentionId: row.mention_id,
      status: row.status,
      failureCategory: row.failure_category ?? null,
      claimedByUserId: row.claimed_by_user_id,
      claimedAt: iso(row.claimed_at),
      expiresAt: iso(row.expires_at),
      finishedAt: isoOrNull(row.finished_at),
      responseDraftId: row.response_draft_id ?? null,
      promptVersion: row.prompt_version,
      brandVoiceSource: row.brand_voice_source,
      brandVoiceVersion: row.brand_voice_version ?? null,
      analysisIncluded: row.analysis_included,
      dedupHits: row.dedup_hits,
      modelProvider: row.model_provider ?? null,
      modelName: row.model_name ?? null,
      inputTokens: row.input_tokens ?? null,
      outputTokens: row.output_tokens ?? null,
      latencyMs: row.latency_ms ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "generation attempt",
  );
}

export function toApproval(row: Row): Approval {
  return parseOrThrow(
    approvalSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      responseDraftId: row.response_draft_id,
      requestedByUserId: row.requested_by_user_id ?? null,
      assignedToUserId: row.assigned_to_user_id ?? null,
      status: row.status,
      decisionNote: row.decision_note ?? null,
      decidedAt: isoOrNull(row.decided_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "approval",
  );
}

export function toEscalation(row: Row): Escalation {
  return parseOrThrow(
    escalationSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      mentionId: row.mention_id,
      category: row.category,
      severity: row.severity,
      status: row.status,
      title: row.title,
      summary: row.summary ?? null,
      assignedUserId: row.assigned_user_id ?? null,
      dueAt: isoOrNull(row.due_at),
      resolvedAt: isoOrNull(row.resolved_at),
      resolutionNote: row.resolution_note ?? null,
      triggerAnalysisId: row.trigger_analysis_id ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "escalation",
  );
}

export function toAutomationRule(row: Row): AutomationRule {
  return parseOrThrow(
    automationRuleSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      description: row.description ?? null,
      status: row.status,
      priority: row.priority,
      conditions: row.conditions ?? [],
      actions: row.actions ?? [],
      lastEvaluatedAt: isoOrNull(row.last_evaluated_at),
      lastMatchedAt: isoOrNull(row.last_matched_at),
      lastAppliedAt: isoOrNull(row.last_applied_at),
      revision: row.revision,
      lastSimulatedAt: isoOrNull(row.last_simulated_at),
      simulatedRevision: row.simulated_revision ?? null,
      archivedAt: isoOrNull(row.archived_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "automation rule",
  );
}

/**
 * One (rule, mention) decision inside a sweep.
 *
 * `outcomes` is jsonb on the row; the schema's `superRefine` (not repeated
 * here) is what actually confirms a dry-run row never claims an apply-mode
 * status and vice versa — this mapper only reshapes columns.
 */
export function mapAutomationRuleExecution(row: Row): AutomationRuleExecution {
  return parseOrThrow(
    automationRuleExecutionSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      sweepId: row.sweep_id,
      automationRuleId: row.automation_rule_id,
      ruleRevision: row.rule_revision,
      mentionId: row.mention_id,
      triggerAnalysisId: row.trigger_analysis_id,
      locationId: row.location_id ?? null,
      mode: row.mode,
      status: row.status,
      outcomes: row.outcomes ?? [],
      outcomeSchemaVersion: row.outcome_schema_version,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code ?? null,
      errorClass: row.error_class ?? null,
      startedAt: iso(row.started_at),
      completedAt: isoOrNull(row.completed_at),
    },
    "rule execution",
  );
}

/**
 * One sweep's counters and lifecycle status.
 *
 * `counters` folds eight flat integer columns back into `SweepCounters` — the
 * columns are separate in Postgres (each one is what `execute_automation_rule`
 * and the sweep runner increment individually), the domain groups them
 * because every consumer reads them together.
 */
export function mapAutomationSweep(row: Row): AutomationSweep {
  return parseOrThrow(
    automationSweepSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      mode: row.mode,
      status: row.status,
      startedAt: iso(row.started_at),
      completedAt: isoOrNull(row.completed_at),
      counters: {
        mentionsEvaluated: Number(row.mentions_evaluated ?? 0),
        rulesMatched: Number(row.rules_matched ?? 0),
        actionsApplied: Number(row.actions_applied ?? 0),
        actionsBlocked: Number(row.actions_blocked ?? 0),
        actionsSkipped: Number(row.actions_skipped ?? 0),
        actionsFailed: Number(row.actions_failed ?? 0),
        retryableFailures: Number(row.retryable_failures ?? 0),
        terminalFailures: Number(row.terminal_failures ?? 0),
      },
      errorCode: row.error_code ?? null,
    },
    "automation sweep",
  );
}

/**
 * Five axis columns fold back into one object.
 *
 * The columns are separate in Postgres so each carries its own range check;
 * the domain groups them because every consumer wants them together.
 */
export function toBrandVoiceProfile(row: Row): BrandVoiceProfile {
  return parseOrThrow(
    brandVoiceProfileSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      axes: {
        warmth: row.axis_warmth,
        detail: row.axis_detail,
        formality: row.axis_formality,
        confidence: row.axis_confidence,
        hospitality: row.axis_hospitality,
      },
      approvedPhrases: row.approved_phrases ?? [],
      prohibitedPhrases: row.prohibited_phrases ?? [],
      version: row.version,
      updatedByUserId: row.updated_by_user_id ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "brand voice profile",
  );
}

export function toAuditEvent(row: Row): AuditEvent {
  return parseOrThrow(
    auditEventSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      actorUserId: row.actor_user_id ?? null,
      actorType: row.actor_type,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      previousState: row.previous_state ?? null,
      newState: row.new_state ?? null,
      metadata: row.metadata ?? {},
      occurredAt: iso(row.occurred_at),
    },
    "audit event",
  );
}

export function toMonitoringQuery(row: Row): MonitoringQuery {
  return parseOrThrow(
    monitoringQuerySchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      locationId: row.location_id ?? null,
      name: row.name,
      queryType: row.query_type,
      keywords: stringArray(row.keywords),
      exclusions: stringArray(row.exclusions),
      allowedDomains: stringArray(row.allowed_domains),
      deniedDomains: stringArray(row.denied_domains),
      sourceCountry: row.source_country ?? null,
      language: row.language ?? null,
      relevanceThreshold: num(row.relevance_threshold) ?? 0,
      enabled: row.enabled,
      pollIntervalMinutes: Number(row.poll_interval_minutes),
      // `?? "user"` covers a row read before the origin migration applied.
      origin: row.origin ?? "user",
      lastPolledAt: isoOrNull(row.last_polled_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "monitoring query",
  );
}

/**
 * A poll run.
 *
 * Mirrors `toPlatformSyncRun` and `toAnalysisRun`: the counts and the gate
 * score summary are separate columns on the row, folded together only by the
 * domain schema they are parsed through.
 */
export function toNewsPollRun(row: Row): NewsPollRun {
  return parseOrThrow(
    newsPollRunSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      monitoringQueryId: row.monitoring_query_id,
      trigger: row.trigger,
      actorUserId: row.actor_user_id ?? null,
      status: row.status,
      startedAt: iso(row.started_at),
      completedAt: isoOrNull(row.completed_at),
      candidatesEvaluated: Number(row.candidates_evaluated ?? 0),
      acceptedCount: Number(row.accepted_count ?? 0),
      rejectedCount: Number(row.rejected_count ?? 0),
      requestsSpent: Number(row.requests_spent ?? 0),
      truncated: row.truncated ?? false,
      gateScoreMin: num(row.gate_score_min),
      gateScoreMean: num(row.gate_score_mean),
      gateScoreMax: num(row.gate_score_max),
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "poll run",
  );
}

export function toNewsRejectedCandidate(row: Row): NewsRejectedCandidate {
  return parseOrThrow(
    newsRejectedCandidateSchema,
    {
      id: row.id,
      organizationId: row.organization_id,
      monitoringQueryId: row.monitoring_query_id,
      newsPollRunId: row.news_poll_run_id,
      externalId: row.external_id,
      url: row.url,
      title: row.title ?? "",
      publisherDomain: row.publisher_domain ?? "",
      reason: row.reason,
      score: num(row.score) ?? 0,
      publishedAt: iso(row.published_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    },
    "rejected candidate",
  );
}
