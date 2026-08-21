import type {
  AccessDisposition,
  BillingInterval,
  OrganizationBilling,
  StripeWebhookEvent,
  SubscriptionStatus,
  TrialGrantSource,
  WebhookErrorCategory,
  AnalysisRun,
  Approval,
  AuditEvent,
  AuditEventFilter,
  AutomationExecutionMode,
  AutomationRule,
  AutomationRuleConfig,
  AutomationRuleExecution,
  AutomationRuleFilter,
  AutomationSweep,
  BrandVoiceProfile,
  BrandVoiceSource,
  ConnectionHealthUpdate,
  CreateAndMapLocationInput,
  CreateEscalationInput,
  CreateLocationInput,
  CreateMentionAnalysisInput,
  CreateMentionInput,
  DryRunExecutionStatus,
  Escalation,
  EscalationFilter,
  EscalationRefusalReason,
  ExecutionActionOutcome,
  FinishAnalysisRunInput,
  FinishSyncRunInput,
  GenerationAttempt,
  GenerationFailureCategory,
  IngestMentionInput,
  Invitation,
  InvitationPreview,
  InvitationWithInviter,
  Location,
  Membership,
  MembershipRole,
  MembershipStatus,
  MembershipWithUser,
  CreateMonitoringQueryInput,
  Mention,
  MentionAnalysis,
  MentionFilter,
  MentionIngestOutcome,
  MentionSourceType,
  MentionStatus,
  MonitoringQuery,
  NewsPollRun,
  NewsRejectedCandidate,
  OAuthState,
  Organization,
  OrganizationMembership,
  OrganizationOnboarding,
  OrganizationSize,
  Platform,
  PlatformConnection,
  PlatformProfile,
  PlatformSyncRun,
  PublicationConfirmationOutcome,
  RaiseEscalationResult,
  RecordAuditEventInput,
  ResponseDraft,
  ResponseDraftFilter,
  PressWidget,
  PressWidgetRenderRow,
  PressWidgetStatus,
  ReviewWidget,
  ReviewWidgetRenderRow,
  ReviewWidgetStatus,
  RiskLevel,
  Sentiment,
  StartAnalysisRunInput,
  StartSyncRunInput,
  SweepCounters,
  SyncResource,
  Timestamp,
  UpdateBrandVoiceInput,
  UpdateLocationInput,
  UpdateMonitoringQueryInput,
  UpsertPlatformConnectionInput,
  UpsertPressWidgetInput,
  UpsertReviewWidgetInput,
  UpsertPlatformProfileInput,
  User,
  CreateYelpListingSnapshotInput,
  YelpActivityChangeKind,
  YelpActivityOccurrence,
  YelpActivityOccurrenceFilter,
  YelpActivityStatus,
  YelpListingSnapshot,
} from "@/domain";
import type { DraftingContext } from "@/lib/responses/drafting-context";

/**
 * Repository contracts.
 *
 * Two rules hold across every method here, and they are the reason this file
 * exists:
 *
 * 1. Every organization-owned read and write takes an `OrganizationScope`.
 *    There is no `listAll()`. Forgetting the tenant filter is a type error, not
 *    a data leak.
 * 2. Nothing in this file knows whether it is talking to Postgres or to an
 *    in-memory fixture. Adapters implement it; callers never branch on which.
 */

/**
 * Proof that a caller may act inside an organization.
 *
 * Only `getOrganizationContext()` constructs one, and only after re-reading the
 * membership row. Passing a scope around is therefore passing a verified
 * capability rather than a hint.
 */
export interface OrganizationScope {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Membership["role"];
}

/** What an ingest did, and the record it left behind. */
export interface MentionIngestResult {
  mention: Mention;
  outcome: MentionIngestOutcome;
}

/**
 * What one analysis occurrence asks the contract to apply.
 *
 * The parameter list of `apply_analysis_occurrence`, field for field. Note
 * what is absent: a status. The final status is derived inside the entry point
 * from the mention's current state and the escalation result, so a decision a
 * person made between the recording and the application cannot be overwritten
 * by a caller passing the status it expected.
 *
 * The escalation fields are supplied whether or not `shouldEscalate` is set —
 * as they are in SQL — and are simply unread when it is false.
 *
 * Note what else is absent: `content`, `rating`, `author_name`, `published_at`,
 * and every source-owned column. An analysis owns three denormalised fields —
 * the ones the inbox filters on, the risk index sorts by, and the charts bucket
 * over — and may not touch what a sync imported. That is the mirror of the rule
 * workflow 03 established for syncs, enforced by this type rather than by care
 * at the call site.
 */
export interface ApplyAnalysisOccurrenceInput {
  mentionId: string;
  analysisId: string;
  shouldEscalate: boolean;
  category: Escalation["category"];
  severity: Escalation["severity"];
  title: string;
  summary: string | null;
  sentiment: Mention["sentiment"];
  riskLevel: Mention["riskLevel"];
  relevanceScore: number | null;
}

/**
 * What the contract did with the occurrence.
 *
 * `alreadyApplied` is the replay-after-success answer: zero effects, zero
 * events, and `finalStatus` is simply what the mention says now. `escalationId`
 * is null on a hard refusal and on a replay of a non-escalating occurrence;
 * `reason` names which arm of the ladder answered.
 */
export interface ApplyAnalysisOccurrenceResult {
  escalationId: string | null;
  escalationCreated: boolean;
  reason: EscalationRefusalReason | null;
  alreadyApplied: boolean;
  finalStatus: MentionStatus;
}

/** Insert-or-load on the event key. `created: false` means "this already was". */
export interface RecordAnalysisOccurrenceResult {
  analysis: MentionAnalysis;
  created: boolean;
}

/** Bundles a mention with everything the workspaces render alongside it. */
export interface MentionDetail {
  mention: Mention;
  analysis: MentionAnalysis | null;
  drafts: ResponseDraft[];
  escalation: Escalation | null;
  location: Location | null;
  connection: PlatformConnection | null;
}

export interface MentionStatusCounts {
  total: number;
  byStatus: Record<MentionStatus, number>;
}

/**
 * The slim read the rule simulator runs against.
 *
 * Deliberately not a `Mention`: the simulator evaluates conditions and shows a
 * sample of matches, not the full record, so this carries only what a
 * condition can test plus a short `excerpt` for display — never the full
 * `content` body, an author, or a source URL.
 *
 * That guarantee is about what crosses the repository boundary, not what the
 * database transfers to get there: every adapter truncates to a ≤140-char
 * excerpt before returning, but under Supabase, PostgREST has no `left()` in
 * its select grammar, so the query still pulls the whole `content` column for
 * up to `limit` rows and the truncation happens in the adapter. Acceptable
 * for a bounded preview read (`limit` is capped at 500) — see the comment on
 * the select in the Supabase adapter's `listSimulationCandidates`.
 */
export interface SimulationCandidate {
  id: string;
  platformConnectionId: string;
  locationId: string | null;
  sourceType: MentionSourceType;
  rating: number | null;
  status: MentionStatus;
  sentiment: Sentiment;
  riskLevel: RiskLevel;
  relevanceScore: number | null;
  publishedAt: Timestamp;
  excerpt: string;
}

/** Pre-aggregated numbers for the overview and insights screens. */
export interface OrganizationMetrics {
  totalMentions: number;
  newMentions: number;
  awaitingResponse: number;
  highRiskMentions: number;
  respondedMentions: number;
  responseCoveragePercent: number;
  averageFirstResponseMinutes: number;
  sentimentBreakdown: Record<Mention["sentiment"], number>;
  sourceMix: { platform: PlatformConnection["platform"]; label: string; count: number; share: number }[];
  sentimentTrend: { date: string; positive: number; neutral: number; negative: number }[];
  topTopics: { topic: string; mentions: number; riskLevel: Mention["riskLevel"] }[];
}

/** Per-location roll-ups for the locations and overview tables. */
export interface LocationMetrics {
  locationId: string;
  mentionVolume: number;
  averageRating: number | null;
  sentiment: Mention["sentiment"];
  responseCoveragePercent: number;
  averageResponseMinutes: number;
  riskMentions: number;
}

export interface ProvisionOrganizationInput {
  userId: string;
  name: string;
  industry?: string;
  timezone?: string;
  language?: string;
  /**
   * Idempotency key, generated once per mounted creation form.
   *
   * A retry after a failure reuses it; a fresh page load gets a new one. Supply
   * it and a replay returns the organization the first call created, writing
   * nothing — no second membership, no second onboarding row, no second
   * `organization.created` event. Omit it and every call creates.
   *
   * The uniqueness is the lock, not a check performed before the insert: two
   * clicks are routinely two serverless processes, and a read-then-insert
   * version loses exactly the race it exists to solve.
   */
  requestKey?: string;
  /**
   * Which entry point asked. Reaches `audit_events.metadata`, and is validated
   * against these two values in the database as well — an audit trail whose
   * metadata is caller-authored free text is a trail somebody can write
   * anything into.
   */
  source?: "self_serve" | "in_app";
}

/**
 * The fields onboarding's first step may change on an organization.
 *
 * The id is absent and must stay absent: it is a write-once primary key.
 * The slug is form-editable but collision-checked — it appears in no URL and no
 * route, only on the settings page and as metadata in support correspondence.
 */
export interface UpdateOrganizationInput {
  name: string;
  websiteUrl: string | null;
  industry: string;
  defaultTimezone: string;
  defaultLanguage: string;
  /**
   * Omitted everywhere except the settings form. Globally unique; a collision
   * surfaces as a `conflict` DataError carrying a `slug` field error. Present
   * here since the slug became editable (see the 2026-08-06 settings spec) —
   * it appears in no URL and no route, so renaming it breaks nothing.
   */
  slug?: string;
}

export interface OrganizationRepository {
  /** Organizations where this user holds an active membership. */
  listForUser(userId: string): Promise<OrganizationMembership[]>;
  getBySlug(slug: string, userId: string): Promise<OrganizationMembership | null>;
  getById(organizationId: string, userId: string): Promise<OrganizationMembership | null>;
  /**
   * Create an organization and the caller's owner membership, together.
   *
   * Deliberately **not** scoped, and the reason is worth stating precisely,
   * because it used to be stated wrongly: it is not that the caller holds no
   * membership. Since organizations can be created from inside the product,
   * the caller usually holds several. It is that this method *produces* a
   * scope, so there is none to pass in.
   *
   * Repeated use is supported and expected. Nothing in the function counts
   * memberships, and the person creating their third restaurant group becomes
   * its owner exactly as they did their first.
   *
   * Both rows must exist or neither must — an organization with no owner is
   * unreachable and uneditable by anyone. The Supabase adapter delegates to a
   * SECURITY DEFINER function so the pair is one transaction; there is no
   * two-statement version of this method for that reason.
   *
   * The slug is derived, not supplied. It is globally unique and appears in
   * links, so it is not a field a signing-up stranger chooses.
   */
  provision(input: ProvisionOrganizationInput): Promise<OrganizationMembership>;
  /**
   * Update the organization's own profile fields.
   *
   * Scoped, unlike `provision`: by the time anybody edits an organization they
   * hold a membership in it, so the ordinary capability rule applies. The input
   * type carries no slug and no id, so neither is reachable from a form.
   */
  update(scope: OrganizationScope, input: UpdateOrganizationInput): Promise<Organization>;
  /**
   * Ids of organizations with at least one mention with no analysis row —
   * deliberately not `status = 'new'`, since a mention whose status advanced
   * without an analysis landing must still count, or that organization
   * silently stops being swept for it.
   *
   * Matches `MentionRepository.listUnanalyzed`'s selection exactly: no
   * analysis row, or a mention carrying a pending (outcome not yet applied)
   * row regardless of any settled history. Widened in migration
   * 20260812000600 — before that, the Supabase implementation (the
   * `organizations_with_unanalyzed_mentions` database function) only checked
   * "no analysis row", so an organization whose *only* remaining work was a
   * pending occurrence was not offered to the cron sweep until some other
   * mention arrived with no analysis at all. The two arms are independent,
   * not one predicate with a single `not exists`: a mention can hold an
   * older settled row and a newer pending one at once (re-analysis is
   * schema-legal for an already-settled mention), so "no settled row exists"
   * alone would miss it. The function and the demo twin both check
   * `not exists (settled) or exists (pending)` — never `not exists (settled)`
   * by itself.
   *
   * The one deliberately unscoped read on this repository — mirrors
   * `MonitoringQueryRepository.listDue`. Cron holds no membership and cannot
   * construct a scope, so it cannot enumerate tenants any other way; every
   * other method here answers "what can this user see," which has no meaning
   * for a scheduler. Deriving the swept set from monitoring queries instead
   * was considered and rejected: analysis covers every mention source, not
   * just news, so a Google-only organization would never be analysed.
   * Service-role only. Never call this from a request path.
   */
  listWithUnanalyzedMentions(): Promise<string[]>;
  /**
   * Organization ids holding at least one connected Yelp listing.
   *
   * The second deliberately unscoped read on this repository, and it exists for
   * exactly the reason the first one does: the Yelp sweep runs under cron,
   * holds no membership, and cannot enumerate tenants any other way.
   *
   * Kept narrow in the same way — it returns identifiers, never rows, and the
   * per-organization `OrganizationScope` the sweep builds from each id is what
   * carries tenancy from there (D88). Service-role only. Never call this from
   * a request path.
   *
   * Deriving the swept set from `platform_connections` alone was rejected: a
   * connection row exists as soon as somebody opens the connect flow, so
   * sweeping on it would check organizations that never finished mapping a
   * listing and have nothing to check.
   */
  listWithYelpListings(): Promise<string[]>;
}

export interface UpdateOwnProfileInput {
  firstName: string;
  lastName: string;
}

export interface UserRepository {
  /**
   * Update the caller's own name.
   *
   * `userId` must come from the session, never from a form — under Supabase
   * the RLS `users_update_self` policy enforces that anyway, but the demo
   * adapter has no such backstop, so the contract lives here. `fullName` is
   * derived from the parts (a generated column under Supabase), not accepted.
   */
  updateOwnProfile(userId: string, input: UpdateOwnProfileInput): Promise<User>;
  /**
   * Set or clear the caller's own photo. Same contract as `updateOwnProfile`:
   * `userId` comes from the session, never from a form, and RLS
   * (`users_update_self`) is the backstop under Supabase. The value is a
   * public storage URL, or a data URL in demo mode, or null to remove.
   */
  updateOwnAvatar(userId: string, avatarUrl: string | null): Promise<User>;
}

export interface MembershipRepository {
  /** The caller's own membership. Returns null when there is none, or it is not active. */
  getActiveMembership(organizationId: string, userId: string): Promise<Membership | null>;
  listMembers(scope: OrganizationScope): Promise<MembershipWithUser[]>;
  listAssignableUsers(scope: OrganizationScope): Promise<User[]>;
  /**
   * How many active owners the organization has.
   *
   * Read before any demotion or removal. The database refuses to leave an
   * organization ownerless, but a constraint violation surfaces as an
   * unreadable error — this exists so the interface can say why first.
   */
  countActiveOwners(scope: OrganizationScope): Promise<number>;
  updateRole(
    scope: OrganizationScope,
    userId: string,
    role: MembershipRole,
  ): Promise<Membership>;
  updateStatus(
    scope: OrganizationScope,
    userId: string,
    status: MembershipStatus,
  ): Promise<Membership>;
  remove(scope: OrganizationScope, userId: string): Promise<void>;
}

export interface CreateInvitationInput {
  email: string;
  role: MembershipRole;
  /** SHA-256 of the token. The token itself never reaches a repository. */
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: string;
}

export interface InvitationRepository {
  /**
   * Issue an invitation.
   *
   * Rejects a second live invitation for the same address through a partial
   * unique index rather than a prior read, so two admins inviting the same
   * person at the same moment collide in the database instead of racing.
   */
  create(scope: OrganizationScope, input: CreateInvitationInput): Promise<Invitation>;
  listPending(scope: OrganizationScope): Promise<InvitationWithInviter[]>;
  revoke(scope: OrganizationScope, invitationId: string): Promise<Invitation>;
  /**
   * What the acceptance page shows, keyed by the token hash.
   *
   * Not scoped, and readable while signed out: the invitee is not a member of
   * anything yet. The token hash is the only credential, which is why the raw
   * token must never be logged or persisted.
   */
  preview(tokenHash: string): Promise<InvitationPreview | null>;
  /**
   * Spend an invitation and grant the membership, together.
   *
   * Returns the organization joined. Throws when the invitation is unknown,
   * expired, already spent, revoked, or addressed to a different person —
   * those collapse into one failure on purpose, because by this point the
   * caller has already been told which by `preview`.
   */
  accept(tokenHash: string, userId: string): Promise<{ organizationId: string }>;
}

export interface LocationRepository {
  list(scope: OrganizationScope): Promise<Location[]>;
  get(scope: OrganizationScope, locationId: string): Promise<Location | null>;
  metrics(scope: OrganizationScope): Promise<LocationMetrics[]>;
  updateManager(
    scope: OrganizationScope,
    locationId: string,
    managerUserId: string | null,
  ): Promise<Location>;
  /**
   * Create a location.
   *
   * The slug is optional: a location arriving from a platform integration has
   * nobody to type one, so the repository derives it from the name and
   * de-duplicates within the organization.
   */
  create(scope: OrganizationScope, input: CreateLocationInput): Promise<Location>;
  /**
   * Edit a location's identity, address, timezone, status, and manager.
   *
   * `updateManager` stays separate rather than being folded in here, and it is
   * not redundant: it is reached from the settings panel under
   * `location.update_manager`, writes only `location.manager_changed`, and
   * exists precisely because assigning a manager is a different authority from
   * editing an address. This method is the management screen's superset, and
   * the action above it emits the three audit events separately by field.
   *
   * A manager must hold an *active* membership in the same organization. Both
   * adapters check it and return a field error; the database restates it as a
   * composite foreign key plus a trigger, because a rule that lives only in
   * application code protects only the paths that remember to call it.
   */
  update(scope: OrganizationScope, input: UpdateLocationInput): Promise<Location>;
  /**
   * Create a location and bind platform profiles to it, atomically, or do
   * neither.
   *
   * The **only** path by which a communications lead can bring a location into
   * existence, and it cannot produce one without a mapping: the profile set is
   * required, and the location insert, the binding, and three audit events are
   * one transaction. `status` and `managerUserId` are not parameters — they are
   * written `setup` and null — and the organization is derived from the
   * connection rather than supplied, so this cannot be aimed at another tenant.
   *
   * A repeat call with the same profiles returns the location the first call
   * created (`replayed: true`) and writes nothing. A profile set already split
   * across two locations is a conflict, not something a retry should resolve.
   */
  createAndMapFromIntegration(
    scope: OrganizationScope,
    input: CreateAndMapLocationInput,
  ): Promise<CreateAndMapLocationResult>;
}

/**
 * What `createAndMapFromIntegration` gives back.
 *
 * `profiles` carries the bound rows so the mapping service can build its result
 * without a second read — and, more importantly, without a second *write*: the
 * whole point of the RPC is that the application performs no separate binding
 * step afterwards.
 */
export interface CreateAndMapLocationResult {
  location: Location;
  profiles: PlatformProfile[];
  /** Profiles this call created, as opposed to ones it found and bound. */
  createdProfileIds: string[];
  /** True when an earlier identical call had already done the work. */
  replayed: boolean;
}

export interface PlatformConnectionRepository {
  list(scope: OrganizationScope): Promise<PlatformConnection[]>;
  get(scope: OrganizationScope, connectionId: string): Promise<PlatformConnection | null>;
  /** The organization's connection for one platform. At most one exists. */
  getByPlatform(
    scope: OrganizationScope,
    platform: Platform,
  ): Promise<PlatformConnection | null>;
  /**
   * Create or refresh the connection for a platform.
   *
   * Upsert rather than insert because reauthorizing must not mint a second
   * connection — profile mappings hang off the connection id, and duplicating
   * the row would orphan every one of them.
   */
  upsert(
    scope: OrganizationScope,
    input: UpsertPlatformConnectionInput,
  ): Promise<PlatformConnection>;
  updateHealth(
    scope: OrganizationScope,
    connectionId: string,
    update: ConnectionHealthUpdate,
  ): Promise<PlatformConnection>;
  /**
   * Mark a connection disconnected.
   *
   * The row survives: audit history references it, and the profile mappings it
   * owns are what make reconnecting a two-click job rather than a re-mapping
   * exercise. Idempotent — disconnecting twice is not an error.
   */
  markDisconnected(
    scope: OrganizationScope,
    connectionId: string,
  ): Promise<PlatformConnection>;
}

export interface PlatformProfileRepository {
  list(scope: OrganizationScope): Promise<PlatformProfile[]>;
  listForConnection(scope: OrganizationScope, connectionId: string): Promise<PlatformProfile[]>;
  /** Create or update the mapping for one external profile. */
  upsert(
    scope: OrganizationScope,
    input: UpsertPlatformProfileInput,
  ): Promise<PlatformProfile>;
  /** Move every profile on a connection to `disconnected`. Used by disconnect. */
  deactivateForConnection(
    scope: OrganizationScope,
    connectionId: string,
  ): Promise<PlatformProfile[]>;
  /**
   * Stamp the end of a successful sync.
   *
   * Its own method rather than a field on `upsert`, because `upsert` rewrites
   * the mapping — the location, the display name, the verification state — and
   * a sync has no business touching any of that. Only successful runs call
   * this, which is what keeps `lastSyncedAt` from implying a freshness the data
   * does not have.
   */
  markSynced(
    scope: OrganizationScope,
    profileId: string,
    syncedAt: string,
  ): Promise<PlatformProfile>;
}

/**
 * Sealed OAuth credentials.
 *
 * Deliberately its own repository rather than fields on `PlatformConnection`.
 * A connection is rendered by UI code; credentials are read by exactly two
 * places in the server. Keeping them apart means no screen can accidentally
 * receive one, and the separation is mirrored in the database by a
 * service-role-only table.
 *
 * Even here the values are ciphertext. Only `src/lib/integrations/credentials.ts`
 * unseals them, and what it produces never leaves that module's callers.
 */
export interface SealedCredentialRecord {
  /** AES-256-GCM envelope, or null when no access token is held. */
  accessTokenSealed: string | null;
  refreshTokenSealed: string | null;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  encryptionKeyId: string;
  encryptionVersion: string;
  rotatedAt: string | null;
}

export interface PlatformCredentialRepository {
  load(
    scope: OrganizationScope,
    connectionId: string,
  ): Promise<SealedCredentialRecord | null>;
  save(
    scope: OrganizationScope,
    connectionId: string,
    record: SealedCredentialRecord,
  ): Promise<void>;
  /** Remove stored credentials. Idempotent. */
  clear(scope: OrganizationScope, connectionId: string): Promise<void>;
}

export interface CreateOAuthStateInput {
  provider: Platform;
  /** SHA-256 of the state value, hex. The value itself is never persisted. */
  stateHash: string;
  organizationId: string;
  userId: string;
  redirectPath: string;
  reauthorization: boolean;
  expiresAt: string;
}

/**
 * OAuth handshake records.
 *
 * Not organization-scoped in the usual way, and that is the point: the callback
 * arrives before Lia knows which organization it concerns, so the lookup is by
 * state hash and the row is what *establishes* the organization. Every method
 * here runs server-side under the service role.
 */
export interface OAuthStateRepository {
  create(input: CreateOAuthStateInput): Promise<OAuthState>;
  /**
   * Atomically mark a handshake consumed and return it.
   *
   * Returns null when the state is unknown, already consumed, or expired — the
   * three cases are indistinguishable to the caller on purpose, because
   * distinguishing them would tell an attacker which guesses were close.
   */
  consume(stateHash: string): Promise<OAuthState | null>;
  /** Sweep handshakes that are past expiry. Returns how many were removed. */
  purgeExpired(): Promise<number>;
}

export interface MentionRepository {
  list(scope: OrganizationScope, filter?: MentionFilter): Promise<Mention[]>;
  get(scope: OrganizationScope, mentionId: string): Promise<Mention | null>;
  getDetail(scope: OrganizationScope, mentionId: string): Promise<MentionDetail | null>;
  /** Mentions that still need a decision, most urgent first. */
  listNeedingAttention(scope: OrganizationScope, limit?: number): Promise<Mention[]>;
  counts(scope: OrganizationScope, filter?: MentionFilter): Promise<MentionStatusCounts>;
  metrics(scope: OrganizationScope): Promise<OrganizationMetrics>;
  /**
   * Idempotent ingest.
   *
   * Re-fetching the same review must update rather than duplicate, so this is
   * an upsert on (connection, source type, external id).
   */
  create(scope: OrganizationScope, input: CreateMentionInput): Promise<Mention>;
  /**
   * Idempotent ingest from a synchronisation.
   *
   * Separate from `create` because the two want opposite things on conflict.
   * `create` writes the whole record; an ingest must write only what the source
   * owns and leave Lia's workflow state — status, sentiment, risk, and the
   * `receivedAt` from the first import — exactly as it found them. The input
   * type has no field for any of those, so the guarantee is structural rather
   * than a rule an adapter has to remember.
   *
   * The returned outcome is what a sync reports as created/updated/unchanged.
   */
  ingest(
    scope: OrganizationScope,
    input: IngestMentionInput,
  ): Promise<MentionIngestResult>;
  /** How many mentions each of these profiles has produced. */
  countByProfile(
    scope: OrganizationScope,
    profileIds: string[],
  ): Promise<Record<string, number>>;
  /**
   * Find a mention by the deduplication key a manual capture derives.
   *
   * The read half of the capture contract. `mentions_unique_external` is what
   * actually prevents a duplicate — this exists so the interface can *show*
   * somebody the review Lia already holds and offer the override, rather than
   * answering a deliberate act with a constraint violation.
   *
   * Scoped by connection and source type, matching the unique constraint
   * exactly, so a hit here means the insert would collide and a miss means it
   * would not.
   */
  findByExternalId(
    scope: OrganizationScope,
    platformConnectionId: string,
    sourceType: MentionSourceType,
    externalId: string,
  ): Promise<Mention | null>;
  /**
   * Mentions needing analysis work, oldest first.
   *
   * "Needing analysis work" is **no analysis row, or a latest row whose
   * outcome was never applied** — not simply "never analysed". A recorded
   * occurrence is pending until `applyAnalysisOccurrence` stamps it, so a
   * crash in that window leaves a durable classification whose escalation,
   * transition, and denormalised columns never happened. From the outside that
   * row is indistinguishable from a finished one, and the narrower selection
   * would drop the mention out of the queue forever. Widening here is what
   * makes recovery a property of the system rather than of an operator
   * noticing.
   *
   * A mention carries at most one pending occurrence (the database enforces
   * it), so "the latest row is pending" and "some row is pending" are the same
   * set, and recovery always has exactly one thing to finish.
   *
   * Oldest-first so a backlog drains in arrival order rather than the newest
   * batch being re-analysed while older mentions never surface.
   *
   * `limit` bounds the batch; `countUnanalyzed` reports the whole backlog, so
   * a capped run can say what it left behind instead of implying it finished.
   */
  listUnanalyzed(scope: OrganizationScope, limit: number): Promise<Mention[]>;
  countUnanalyzed(scope: OrganizationScope): Promise<number>;
  /**
   * Record an analysis, unconditionally — **not the pipeline's path.**
   *
   * A raw append with no event key and no lifecycle: it leaves the row pending
   * and takes no part in the one-pending-per-mention invariant, so two calls
   * for one mention produce a state the database's `mention_analyses_one_pending`
   * index forbids. `recordAnalysisOccurrence` is what the analysis service uses
   * and what anything writing a new occurrence should use. This survives as the
   * seam tests use to construct a pending occurrence deliberately.
   *
   * Append-only: re-analysing inserts a new row rather than overwriting, so a
   * prompt or model change stays auditable and readers take the latest.
   */
  createAnalysis(
    scope: OrganizationScope,
    input: CreateMentionAnalysisInput,
  ): Promise<MentionAnalysis>;
  /**
   * Record an analysis occurrence, or load the one already recorded.
   *
   * The mirror of `record_analysis_occurrence`. A logical analysis event is
   * (organization, run, mention): every pipeline recording happens inside a
   * run, so the run id is the identity every recorder of the same event
   * carries. Recording is therefore idempotent under every arrival order,
   * including a recorder arriving after the event already completed —
   * `created: false` with the stored row, whose output the caller uses instead
   * of its own.
   *
   * Separately, a mention may have only one *pending* occurrence (one whose
   * outcome has not been applied), so recovery always has exactly one thing to
   * finish. A later event arriving while one is pending is handed the pending
   * row, and the caller completes that first.
   */
  recordAnalysisOccurrence(
    scope: OrganizationScope,
    input: CreateMentionAnalysisInput,
  ): Promise<RecordAnalysisOccurrenceResult>;
  /**
   * Apply one occurrence's outcome: the atomic analysis entry point.
   *
   * The mirror of `apply_analysis_occurrence`. Eligibility, the escalation
   * decision, the mention transition, the denormalised columns, the
   * occurrence's completion stamp, and the escalation's audit event are one
   * unit. Replaying a completed occurrence has zero effects.
   *
   * Together with `AutomationRuleExecutionRepository.executeUnit` this is one
   * of the only two ways an escalation is created. In Postgres that is
   * enforced by grant — `raise_escalation` is executable by neither the
   * application role nor anything it can call directly.
   */
  applyAnalysisOccurrence(
    scope: OrganizationScope,
    input: ApplyAnalysisOccurrenceInput,
  ): Promise<ApplyAnalysisOccurrenceResult>;
  updateStatus(
    scope: OrganizationScope,
    mentionId: string,
    status: MentionStatus,
  ): Promise<Mention>;
  latestAnalysis(scope: OrganizationScope, mentionId: string): Promise<MentionAnalysis | null>;
  /**
   * A sample the rule simulator can evaluate conditions against.
   *
   * `publishedAfter` bounds the sample to a recent window rather than the
   * whole history — simulating against every mention an organization has ever
   * received would be slow and would not reflect what the rule would see
   * going forward. `limit` bounds the response size the same way `list`'s does.
   */
  listSimulationCandidates(
    scope: OrganizationScope,
    input: { publishedAfter: Timestamp; limit: number },
  ): Promise<SimulationCandidate[]>;
}

export interface ResponseDraftRepository {
  list(scope: OrganizationScope, filter?: ResponseDraftFilter): Promise<ResponseDraft[]>;
  get(scope: OrganizationScope, draftId: string): Promise<ResponseDraft | null>;
  assign(
    scope: OrganizationScope,
    draftId: string,
    assignedUserId: string | null,
  ): Promise<ResponseDraft>;
  /**
   * Persist a human's edit to the draft's final text.
   *
   * Refuses outside the editable statuses (the same set that can be decided
   * on, D108) — an approved response's text is frozen with its approval.
   * Deliberately not a general `update`: every transition is its own method
   * so illegal writes are unrepresentable.
   */
  saveFinalText(
    scope: OrganizationScope,
    draftId: string,
    finalText: string,
  ): Promise<ResponseDraft>;
  /**
   * Applies the decision to both the draft and its open approval record.
   *
   * When `finalText` is provided, it is applied in the same write as the
   * decision — the approver approves exactly what they saw (D107).
   */
  decide(
    scope: OrganizationScope,
    draftId: string,
    decision: "approved" | "changes_requested",
    decidedByUserId: string,
    decisionNote?: string,
    finalText?: string,
  ): Promise<{ draft: ResponseDraft; approval: Approval | null }>;
  listApprovals(scope: OrganizationScope, draftId: string): Promise<Approval[]>;
  /**
   * Record that a person posted an approved response themselves.
   *
   * The assisted-posting confirmation. Not a publish: Lia sent nothing, saw
   * nothing, and holds no provider acknowledgement — it is recording somebody's
   * statement that they carried the approved words to the platform. Every field
   * that would imply otherwise is written by the adapter rather than supplied:
   * the method is `manual_external` literally, and `externalResponseId` stays
   * null, which the database enforces
   * (`response_drafts_external_id_requires_provider`).
   *
   * **Idempotent, and the idempotency is a conditional write rather than a
   * read-then-write.** The update is guarded on the draft still being
   * `approved`, so a second click affects no rows and reports
   * `already_confirmed`. Reading the status first and then updating would be
   * two statements with a race between them (D24's reasoning), and the race
   * here would produce two `response.publication_confirmed` events for one act.
   *
   * Returns the outcome alongside the draft so a caller can tell a fresh
   * confirmation from a repeat without comparing timestamps.
   */
  confirmPublication(
    scope: OrganizationScope,
    draftId: string,
    confirmedByUserId: string,
    confirmedAt: string,
  ): Promise<{ draft: ResponseDraft; outcome: PublicationConfirmationOutcome }>;
  /**
   * Withdraw a confirmation somebody made by mistake.
   *
   * Returns the draft to `approved` and clears the provenance. Deliberately not
   * a retraction: nothing was published, so there is nothing to take down — the
   * record was simply wrong. Guarded on the draft being `published` by
   * `manual_external`, so a provider publication (which Lia would have
   * observed) can never be erased through this path.
   */
  unconfirmPublication(
    scope: OrganizationScope,
    draftId: string,
  ): Promise<ResponseDraft>;
}

/**
 * Response generation's claim/complete/fail lifecycle.
 *
 * The mirror of `claim_generation_attempt` / `complete_generation_attempt` /
 * `fail_generation_attempt` (spec: response-generation v3,
 * `supabase/migrations/20260813000200_generation_functions.sql`). Every
 * method here is the whole transaction — there is no partial-write path a
 * caller can observe.
 *
 * `claim`'s role check is restated here rather than only at the action layer
 * (unlike every other repository in this file): the SQL function checks
 * `response.generate` internally too (defense in depth, the onboarding
 * precedent), and both adapters must mirror that, not just the Postgres one.
 */
export interface GenerationAttemptRepository {
  /** The serialized claim. Mirrors `claim_generation_attempt` exactly. */
  claim(
    scope: OrganizationScope,
    input: {
      mentionId: string;
      context: DraftingContext;
      contextHash: string;
      promptVersion: string;
      brandVoiceSource: BrandVoiceSource;
      brandVoiceVersion: string | null;
      analysisIncluded: boolean;
      leaseSeconds?: number;
    },
  ): Promise<
    | { outcome: "claimed"; attemptId: string; claimToken: string }
    | { outcome: "in_progress"; attemptId: string }
    | { outcome: "draft_exists"; responseDraftId: string }
  >;
  complete(
    scope: OrganizationScope,
    input: {
      attemptId: string;
      claimToken: string;
      draftText: string;
      renderedSystemHash: string;
      renderedUserHash: string;
      outputSchemaVersion: string;
      modelProvider: string;
      modelName: string;
      maxOutputTokens: number;
      temperature: number | null;
      providerRequestId: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
    },
  ): Promise<{ outcome: "completed"; responseDraftId: string } | { outcome: "superseded" }>;
  fail(
    scope: OrganizationScope,
    input: {
      attemptId: string;
      claimToken: string;
      failureCategory: GenerationFailureCategory;
      latencyMs: number;
      providerRequestId: string | null;
    },
  ): Promise<"failed" | "superseded">;
  /** Button state on the workspace: the newest attempt, any status. */
  latestForMention(scope: OrganizationScope, mentionId: string): Promise<GenerationAttempt | null>;
}

export interface EscalationRepository {
  list(scope: OrganizationScope, filter?: EscalationFilter): Promise<Escalation[]>;
  get(scope: OrganizationScope, escalationId: string): Promise<Escalation | null>;
  /**
   * The escalation ladder — **not a production path**.
   *
   * Escalations are created by exactly two entry points: `applyAnalysisOccurrence`
   * (analysis) and `executeUnit` (automation). Both reach the ladder internally;
   * nothing else may. The Supabase adapter enforces that by refusing this method
   * outright (`unavailable`), which matches the database, where `raise_escalation`
   * is executable by no application role and INSERT on `escalations` is revoked.
   *
   * The demo adapter keeps it working as the in-memory twin's seam — it has no
   * privilege system to enforce anything with, and its tests need a way to seed
   * a case — and it runs the exact ladder: provenance → occurrence replay →
   * dismissed → open dedupe → awaiting re-triage → create.
   *
   * The result names which arm answered. `escalation` is null exactly on a hard
   * refusal; a refusal never answers with somebody else's case.
   */
  create(
    scope: OrganizationScope,
    input: CreateEscalationInput,
  ): Promise<RaiseEscalationResult>;
  updateStatus(
    scope: OrganizationScope,
    escalationId: string,
    status: Escalation["status"],
    resolutionNote?: string,
  ): Promise<Escalation>;
  assign(
    scope: OrganizationScope,
    escalationId: string,
    assignedUserId: string | null,
  ): Promise<Escalation>;
}

export interface ClaimSweepResult {
  sweep: AutomationSweep;
  claimed: boolean;
}

export interface FinalizeSweepInput {
  status: "completed" | "failed";
  counters: SweepCounters;
  errorCode?: string | null;
}

/**
 * A unit of execution: which rule, at which revision, against which mention,
 * on the authority of which analysis occurrence.
 *
 * Five identifiers and no actions. What runs is whatever the *stored* revision
 * says — the caller names a unit, it never defines one — so a sweep cannot
 * execute a list of actions the rule does not currently hold, and a snapshot
 * that has gone stale fails the unit (`rule_changed`) instead of quietly
 * applying yesterday's configuration.
 */
export interface ExecuteUnitInput {
  /**
   * The sweep making this attempt — the **attemptSweepId**. The row keeps the
   * sweep that first claimed the unit (its **originSweepId**), so a retry from
   * a later sweep leaves the two different, and both are recorded in the audit
   * trail.
   */
  sweepId: string;
  automationRuleId: string;
  ruleRevision: number;
  mentionId: string;
  triggerAnalysisId: string;
}

/** The same unit key, plus what the dry run projected for it. */
export interface RecordProjectionInput extends ExecuteUnitInput {
  status: DryRunExecutionStatus;
  outcomes: ExecutionActionOutcome[];
}

export interface AutomationSweepRepository {
  /**
   * Claim the organization's sweep. `claimed: false` returns the already
   * running sweep untouched (the caller skips the organization). A running
   * sweep older than 30 minutes is expired: marked failed
   * (`lease_expired`) and replaced by the new claim.
   */
  claim(
    scope: OrganizationScope,
    input: { mode: AutomationExecutionMode },
  ): Promise<ClaimSweepResult>;
  finalize(
    scope: OrganizationScope,
    sweepId: string,
    input: FinalizeSweepInput,
  ): Promise<AutomationSweep>;
}

export interface AutomationRuleExecutionRepository {
  /**
   * The transactional unit of apply mode (spec §7): claim, validate,
   * apply via the transition matrix, record, audit — atomically. Replays
   * (same idempotency key, terminal row) return the row with zero
   * effects. In G0 only the demo adapter implements this; the Supabase
   * adapter throws DataError("unavailable") until the G1 RPC lands.
   */
  executeUnit(
    scope: OrganizationScope,
    input: ExecuteUnitInput,
  ): Promise<AutomationRuleExecution>;
  /** Dry run: insert a projection row; no business mutation of any kind. */
  recordProjection(
    scope: OrganizationScope,
    input: RecordProjectionInput,
  ): Promise<AutomationRuleExecution>;
  listForRule(
    scope: OrganizationScope,
    ruleId: string,
    limit: number,
  ): Promise<AutomationRuleExecution[]>;
}

export interface AutomationRuleRepository {
  list(scope: OrganizationScope, filter?: AutomationRuleFilter): Promise<AutomationRule[]>;
  get(scope: OrganizationScope, ruleId: string): Promise<AutomationRule | null>;
  create(scope: OrganizationScope, input: AutomationRuleConfig): Promise<AutomationRule>;
  /**
   * Structural edit. Refused (conflict) when the rule is active or archived, or
   * when expectedRevision no longer matches. Bumps revision.
   */
  update(
    scope: OrganizationScope,
    ruleId: string,
    input: AutomationRuleConfig,
    expectedRevision: number,
  ): Promise<AutomationRule>;
  /** Draft/inactive only. Sets archivedAt; never deletes. */
  archive(scope: OrganizationScope, ruleId: string): Promise<AutomationRule>;
  /** Marks the given revision simulated. Refused when the revision is not current. */
  recordSimulation(
    scope: OrganizationScope,
    ruleId: string,
    revision: number,
  ): Promise<AutomationRule>;
  /** Enabling requires activationProblems(rule) to be empty — enforced here as backstop. */
  setEnabled(
    scope: OrganizationScope,
    ruleId: string,
    enabled: boolean,
  ): Promise<AutomationRule>;
  /** Active, unarchived, ordered priority asc, createdAt asc, id asc. */
  listActiveForExecution(scope: OrganizationScope): Promise<AutomationRule[]>;
  /**
   * Apply-mode activity stamps, monotonic (greatest of existing and new).
   * evaluatedAt always advances; matched/applied only when their flag is set.
   */
  markActivity(scope: OrganizationScope, ruleId: string, input: {
    at: string; matched: boolean; applied: boolean;
  }): Promise<void>;
}

/**
 * Brand voice.
 *
 * One profile per organization, so there is no id parameter and no list
 * method — naming the scope names the row. `get` returns null for an
 * organization that has never saved one; callers substitute
 * `DEFAULT_BRAND_VOICE` rather than treating absence as an error.
 */
export interface BrandVoiceRepository {
  get(scope: OrganizationScope): Promise<BrandVoiceProfile | null>;
  /**
   * Insert or update the organization's profile.
   *
   * Returns the stored row unchanged when the input matches it — no version
   * bump, no `updatedAt` change. See the `version` column comment.
   */
  save(scope: OrganizationScope, input: UpdateBrandVoiceInput): Promise<BrandVoiceProfile>;
}

/**
 * Raised when a sync is already running for the same profile and resource.
 *
 * Its own type rather than a generic conflict because the caller has to be able
 * to tell "somebody else is already doing this" — which is fine, and needs no
 * remediation — from every other reason a run could fail to open.
 */
export class SyncRunInProgressError extends Error {
  readonly activeRunId: string;

  constructor(activeRunId: string) {
    super("A sync is already running for this location.");
    this.name = "SyncRunInProgressError";
    this.activeRunId = activeRunId;
  }
}

export interface PlatformSyncRunRepository {
  /**
   * Open a run, or refuse because one is already open.
   *
   * The refusal is enforced by `platform_sync_runs_one_active`, a partial
   * unique index — not by reading first and then inserting, which is two
   * statements with a race between them. Throws `SyncRunInProgressError`.
   *
   * A run left `running` by a process that died is reclaimed rather than
   * blocking the location forever; see `SYNC_RUN_STALE_AFTER_MS`.
   */
  start(scope: OrganizationScope, input: StartSyncRunInput): Promise<PlatformSyncRun>;
  /** Close a run. Idempotent in effect: finishing a finished run is a no-op. */
  finish(
    scope: OrganizationScope,
    runId: string,
    input: FinishSyncRunInput,
  ): Promise<PlatformSyncRun>;
  get(scope: OrganizationScope, runId: string): Promise<PlatformSyncRun | null>;
  /** Most recent runs for one profile, newest first. */
  listForProfile(
    scope: OrganizationScope,
    profileId: string,
    limit?: number,
  ): Promise<PlatformSyncRun[]>;
  /**
   * The latest run for each of these profiles, and the latest successful one.
   *
   * Two different questions, answered together because the integration screen
   * asks both at once: "is it running / did it just fail" and "when was this
   * location's data last actually refreshed".
   */
  latestForProfiles(
    scope: OrganizationScope,
    profileIds: string[],
    resource: SyncResource,
  ): Promise<Record<string, ProfileSyncState>>;
}

/** The sync state the integration screen renders for one connected location. */
export interface ProfileSyncState {
  latest: PlatformSyncRun | null;
  lastSuccessful: PlatformSyncRun | null;
}

/** A run left `running` by a dead process is reclaimed after this. */
export const POLL_RUN_STALE_AFTER_MS = 30 * 60 * 1000;

export interface StartPollRunInput {
  monitoringQueryId: string;
  trigger: NewsPollRun["trigger"];
  actorUserId: string | null;
}

export interface FinishPollRunInput {
  status: Exclude<NewsPollRun["status"], "running">;
  candidatesEvaluated: number;
  acceptedCount: number;
  rejectedCount: number;
  requestsSpent: number;
  truncated: boolean;
  gateScoreMin: number | null;
  gateScoreMean: number | null;
  gateScoreMax: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface MonitoringQueryRepository {
  list(scope: OrganizationScope): Promise<MonitoringQuery[]>;
  get(scope: OrganizationScope, queryId: string): Promise<MonitoringQuery | null>;
  create(
    scope: OrganizationScope,
    input: CreateMonitoringQueryInput,
  ): Promise<MonitoringQuery>;
  update(
    scope: OrganizationScope,
    queryId: string,
    input: UpdateMonitoringQueryInput,
  ): Promise<MonitoringQuery>;
  remove(scope: OrganizationScope, queryId: string): Promise<void>;
  /** Advance the cursor. Only the poll service calls this. */
  markPolled(
    scope: OrganizationScope,
    queryId: string,
    polledAt: string,
  ): Promise<MonitoringQuery>;
  /**
   * Enabled queries whose interval has elapsed, across every tenant.
   *
   * The one deliberately unscoped read in the repository layer. Cron holds no
   * membership and cannot construct a scope, so the poll service builds one per
   * row from `organizationId` (D88). Never call this from a request path.
   */
  listDue(now: string, limit: number): Promise<MonitoringQuery[]>;
}

export interface NewsPollRunRepository {
  /** Throws `PollRunInProgressError`. Reclaims runs older than the stale window. */
  start(scope: OrganizationScope, input: StartPollRunInput): Promise<NewsPollRun>;
  finish(
    scope: OrganizationScope,
    runId: string,
    input: FinishPollRunInput,
  ): Promise<NewsPollRun>;
  listForQuery(
    scope: OrganizationScope,
    queryId: string,
    limit?: number,
  ): Promise<NewsPollRun[]>;
  /** Global spend since an instant. Unscoped, because the budget is Lia's (D85). */
  requestsSpentSince(since: string): Promise<number>;
}

export interface NewsRejectedCandidateRepository {
  recordMany(
    scope: OrganizationScope,
    candidates: readonly Omit<
      NewsRejectedCandidate,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >[],
  ): Promise<void>;
  listForQuery(
    scope: OrganizationScope,
    queryId: string,
    limit?: number,
  ): Promise<NewsRejectedCandidate[]>;
  /** Delete rows older than the retention window. Returns the count removed. */
  purgeOlderThan(scope: OrganizationScope, before: string): Promise<number>;
}

/**
 * Raised when an analysis is already running for this organization.
 *
 * Its own type rather than a generic conflict, for the same reason
 * `SyncRunInProgressError` is: the caller has to be able to tell "somebody
 * else is already doing this" — which is fine and needs no remediation — from
 * every other reason a run could fail to open.
 */
export class AnalysisRunInProgressError extends Error {
  readonly activeRunId: string;

  constructor(activeRunId: string) {
    super("An analysis is already running for this organization.");
    this.name = "AnalysisRunInProgressError";
    this.activeRunId = activeRunId;
  }
}

export interface AnalysisRunRepository {
  /**
   * Open a run, or refuse because one is already open.
   *
   * Enforced by `analysis_runs_one_active`, a partial unique index — not by
   * reading first and then inserting, which is two statements with a race
   * between them. Throws `AnalysisRunInProgressError`.
   *
   * A run left `running` by a process that died is reclaimed rather than
   * blocking the organization forever; see `ANALYSIS_RUN_STALE_AFTER_MS`.
   */
  start(scope: OrganizationScope, input: StartAnalysisRunInput): Promise<AnalysisRun>;
  finish(
    scope: OrganizationScope,
    runId: string,
    input: FinishAnalysisRunInput,
  ): Promise<AnalysisRun>;
  get(scope: OrganizationScope, runId: string): Promise<AnalysisRun | null>;
  /** Most recent runs, newest first. */
  list(scope: OrganizationScope, limit?: number): Promise<AnalysisRun[]>;
  /**
   * The latest run and the latest successful one.
   *
   * Two different questions, answered together because the inbox card asks
   * both at once: "is it running / did it just fail" and "when did analysis
   * last actually get through anything".
   */
  latest(scope: OrganizationScope): Promise<AnalysisRunState>;
}

/** What the /mentions card renders about analysis. */
export interface AnalysisRunState {
  latest: AnalysisRun | null;
  lastSuccessful: AnalysisRun | null;
}

/**
 * First-run setup progress.
 *
 * One row per organization, so — like `BrandVoiceRepository` — naming the scope
 * names the row and there is no id parameter and no list method.
 *
 * Every transition is its own method rather than one `update(patch)`, and that
 * is the point of the interface. A general patch would let a caller write
 * `completedAt` without having settled a single step; these methods can only
 * move progress forward one defined transition at a time, and each is
 * idempotent — pressing a button twice, or a double-submitted form, records the
 * first timestamp and returns the same row rather than rewriting history.
 *
 * `get` returns null for an organization that has no row. Callers treat that as
 * **completed**, not as "start the wizard": every organization that existed
 * before onboarding shipped was backfilled, and failing open to the product is
 * the right direction for a row that has gone missing — the alternative traps
 * an established customer in a setup wizard for a workspace they already use.
 */
export interface OnboardingRepository {
  get(scope: OrganizationScope): Promise<OrganizationOnboarding | null>;
  /**
   * Create the row for an organization that has none.
   *
   * Provisioning already creates it inside `provision_organization`, in the
   * same transaction as the organization itself, so this is not the ordinary
   * path. It exists for the demo adapter and for an organization created before
   * this table existed whose backfill did not reach it.
   */
  create(scope: OrganizationScope): Promise<OrganizationOnboarding>;

  completeOrganizationStep(
    scope: OrganizationScope,
    organizationSize: OrganizationSize | null,
  ): Promise<OrganizationOnboarding>;
  completeSourceStep(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  skipSourceStep(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  completeLocationsStep(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  skipLocationsStep(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  completeBrandVoiceStep(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  completeTeamStep(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  skipTeamStep(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  /**
   * Mark the whole thing finished.
   *
   * Refuses when a step is still unsettled, so "completed" cannot be written by
   * a caller that skipped the wizard rather than the steps.
   */
  completeOnboarding(scope: OrganizationScope): Promise<OrganizationOnboarding>;
  /** Stamp the first view of the Workspace Ready screen. Idempotent. */
  markReadyViewed(scope: OrganizationScope): Promise<OrganizationOnboarding>;
}

/* -------------------------------------------------------------------------- */
/* Website review widget                                                       */
/* -------------------------------------------------------------------------- */

export interface ReviewWidgetRepository {
  /** Every widget in the organization, for the configuration screen's picker. */
  list(scope: OrganizationScope): Promise<ReviewWidget[]>;
  /**
   * The widget for one location, or null.
   *
   * Keyed by location rather than by id because that is the question every
   * caller actually has — the configuration screen opens on a location, and
   * `review_widgets_one_per_location` makes the answer singular.
   */
  getForLocation(
    scope: OrganizationScope,
    locationId: string,
  ): Promise<ReviewWidget | null>;
  /**
   * Create the widget for a location, or update the one that exists.
   *
   * Upsert rather than separate create/update because the screen has one save
   * button and one location, and "does a row exist yet" is not a question the
   * person pressing it has an opinion about. The service still distinguishes
   * the two — it reads first, so it can record `review_widget.created` or
   * `review_widget.updated` rather than one event that means either.
   *
   * `publicId` on the input is resolved by the service, never chosen by a
   * caller: on a create it is freshly issued, and on an update it is the
   * existing one carried forward. Rotation is its own method for exactly that
   * reason — it is the one act that changes it.
   */
  upsert(
    scope: OrganizationScope,
    input: UpsertReviewWidgetInput,
  ): Promise<ReviewWidget>;
  /**
   * Switch the embed on or off, leaving everything else alone.
   *
   * Its own method rather than a field on `upsert`, so a customer saving a
   * theme can never accidentally take their widget dark, and so the write that
   * changes what a public page shows is always a deliberate call.
   */
  setStatus(
    scope: OrganizationScope,
    widgetId: string,
    status: ReviewWidgetStatus,
  ): Promise<ReviewWidget>;
  /**
   * Issue a new public id, invalidating every snippet already published.
   *
   * The id is generated by the caller (`generateWidgetPublicId`, which is
   * server-only) and passed in, so the adapters share one source of randomness
   * rather than each having their own.
   */
  rotatePublicId(
    scope: OrganizationScope,
    widgetId: string,
    publicId: string,
    rotatedAt: string,
  ): Promise<ReviewWidget>;
  /**
   * Everything an anonymous embed request may read, keyed by the public id.
   *
   * **Not organization-scoped, and the only method in this file that is not.**
   * The rule that every organization-owned read takes an `OrganizationScope`
   * exists so a missing tenant filter is a type error; this method cannot obey
   * it, because the caller is a stranger's browser on a restaurant's website
   * and there is no membership to construct a scope from. `InvitationRepository.preview`
   * is the existing precedent and carries the same exemption for the same
   * reason.
   *
   * What replaces the scope is the return type. `ReviewWidgetRenderRow` holds
   * widget configuration and six review fields, and nothing else — no status,
   * no sentiment, no risk level, no raw payload, no organization id. A caller
   * cannot widen it, so the anonymous surface is bounded by the type rather
   * than by care at the call site. Under Supabase it is one `SECURITY DEFINER`
   * function; under the demo adapter it is the same eligibility predicate the
   * configuration screen uses.
   */
  render(publicId: string): Promise<ReviewWidgetRenderRow | null>;
}

/**
 * The website press widget: one to three news stories for the organization.
 *
 * Deliberately not `ReviewWidgetRepository` with nullable extras. The two
 * widgets share their envelope and nothing about their content, and a single
 * repository over both would be a method set where half the arguments are
 * meaningless for half the calls — the shape that makes a tenancy mistake easy
 * to write and hard to see.
 *
 * The most visible difference is the key. A review widget is looked up by
 * location, because there is one per location; a press widget is looked up by
 * scope alone, because there is one per organization. `get(scope)` therefore
 * takes no second argument, and `press_widgets_one_per_organization` is what
 * makes the answer singular.
 */
export interface PressWidgetRepository {
  /** The organization's press widget, or null. */
  get(scope: OrganizationScope): Promise<PressWidget | null>;
  /**
   * Create the organization's press widget, or update the one that exists.
   *
   * Upsert rather than separate create/update because the screen has one save
   * button and "does a row exist yet" is not a question the person pressing it
   * has an opinion about. The service still distinguishes the two — it reads
   * first, so it can record `press_widget.created` or `press_widget.updated`
   * rather than one event that means either.
   *
   * `publicId` on the input is resolved by the service, never chosen by a
   * caller: on a create it is freshly issued, and on an update it is the
   * existing one carried forward.
   */
  upsert(
    scope: OrganizationScope,
    input: UpsertPressWidgetInput,
  ): Promise<PressWidget>;
  /**
   * Switch the embed on or off, leaving everything else alone.
   *
   * Its own method rather than a field on `upsert`, so a customer saving a
   * theme can never accidentally take their widget dark, and so the write that
   * changes what a public page shows is always a deliberate call.
   */
  setStatus(
    scope: OrganizationScope,
    widgetId: string,
    status: PressWidgetStatus,
  ): Promise<PressWidget>;
  /**
   * Issue a new public id, invalidating every snippet already published.
   *
   * The id is generated by the caller (`generateWidgetPublicId`, which is
   * server-only) and passed in, so the adapters share one source of randomness
   * rather than each having their own.
   */
  rotatePublicId(
    scope: OrganizationScope,
    widgetId: string,
    publicId: string,
    rotatedAt: string,
  ): Promise<PressWidget>;
  /**
   * Everything an anonymous embed request may read, keyed by the public id.
   *
   * **Not organization-scoped**, and the second method in this file that is
   * not, for the identical reason: the caller is a stranger's browser on a
   * restaurant's website and there is no membership to construct a scope from.
   *
   * What replaces the scope is the return type. `PressWidgetRenderRow` holds
   * widget configuration and, per story, the six fields the widget draws — no
   * status, no sentiment, no risk level, no relevance score, no monitoring
   * keywords, no raw payload, no organization id, no mention id. A caller
   * cannot widen it, so the anonymous surface is bounded by the type rather
   * than by care at the call site.
   *
   * The array is already capped at the widget's `itemLimit`. It is what the
   * widget draws, not a page of candidates for a caller to filter — a
   * repository that returned more would be a repository whose output depended
   * on the renderer remembering to slice it.
   */
  render(publicId: string): Promise<PressWidgetRenderRow | null>;
}

/** What `apply_stripe_billing_projection` needs. Mirrors CanonicalSubscription. */
export interface ApplyBillingProjectionInput {
  organizationId: string;
  customerId: string | null;
  subscriptionId: string | null;
  itemId: string | null;
  priceId: string | null;
  interval: BillingInterval | null;
  status: SubscriptionStatus | null;
  quantity: number | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialStart: string | null;
  trialEnd: string | null;
  trialGrantSource: TrialGrantSource | null;
  /** The Stripe event this came from, marked processed in the same transaction. */
  stripeEventId: string | null;
}

export interface RecordBillingPaymentInput {
  organizationId: string;
  paid: boolean;
  occurredAt: string;
  /** Whether this is the subscription's first charge, decided by the service. */
  isFirstCharge: boolean;
  stripeEventId: string | null;
}

export interface ClaimWebhookEventInput {
  stripeEventId: string;
  eventType: string;
  stripeObjectId: string | null;
  livemode: boolean;
  stripeCreatedAt: string;
}

/**
 * What claiming an event decided.
 *
 * Three outcomes rather than a boolean, because each needs a different HTTP
 * response: process it, acknowledge a duplicate with 200 so Stripe stops
 * retrying, or refuse with 409 so Stripe retries after whoever holds it is
 * done.
 */
export type WebhookClaim = "claimed" | "already_processed" | "in_progress";

/**
 * One organization's billing projection.
 *
 * Reads are organization-scoped like every other repository. Writes are not,
 * and cannot be: they arrive from a webhook that has no session, so they take
 * an explicit organization id resolved from the Stripe customer rather than an
 * `OrganizationScope` there is nobody to build (D88). Every write method here
 * is reachable only from the service-role data source.
 */
export interface BillingRepository {
  /** Null when the organization has never reached billing. Absence fails open. */
  get(scope: OrganizationScope): Promise<OrganizationBilling | null>;

  /**
   * The tenant a Stripe customer belongs to.
   *
   * The webhook's only tenant lookup. Deliberately keyed on the customer id
   * rather than on event metadata: metadata is correlation, and a lookup
   * through it would make a forged or mistaken metadata field authoritative.
   */
  findByCustomerId(customerId: string): Promise<OrganizationBilling | null>;

  /** Attaches a Stripe customer, once. A second, different one is a conflict. */
  bindCustomer(
    organizationId: string,
    customerId: string,
  ): Promise<OrganizationBilling>;

  applyProjection(input: ApplyBillingProjectionInput): Promise<OrganizationBilling>;

  recordPayment(input: RecordBillingPaymentInput): Promise<OrganizationBilling>;

  /** Locations consuming purchased capacity: everything except `inactive`. */
  countBillableLocations(scope: OrganizationScope): Promise<number>;

  /**
   * Every organization with a Stripe customer, for reconciliation.
   *
   * Not organization-scoped, and the only method here that crosses tenants by
   * design — the job's whole purpose is to sweep all of them. Reachable from
   * the service-role data source only, and its one caller constructs a scope
   * per row from that row's own organization id rather than trusting an
   * ambient one (D88).
   */
  listForReconciliation(limit: number): Promise<OrganizationBilling[]>;

  /** The only path that restores trial eligibility. Always audited. */
  grantTrial(input: {
    organizationId: string;
    grantSource: TrialGrantSource;
    actorUserId: string | null;
    note: string | null;
  }): Promise<OrganizationBilling>;

  /** Complimentary, grandfathered, internal, or sales-managed access. */
  setAccessDisposition(input: {
    organizationId: string;
    disposition: AccessDisposition;
    expiresAt: string | null;
    note: string | null;
    actorUserId: string | null;
  }): Promise<OrganizationBilling>;
}

/**
 * The Stripe event log.
 *
 * Not organization-scoped, and cannot be: an event arrives before the
 * organization is known, which is the whole job of resolving one. Same shape
 * as `OAuthStateRepository`, for the same reason.
 */
export interface StripeWebhookEventRepository {
  claim(input: ClaimWebhookEventInput): Promise<WebhookClaim>;
  finish(
    stripeEventId: string,
    status: "processed" | "ignored" | "failed",
    errorCategory?: WebhookErrorCategory | null,
  ): Promise<void>;
  /** Operational read, for the reconciliation report. */
  get(stripeEventId: string): Promise<StripeWebhookEvent | null>;
}

export interface AuditEventRepository {
  list(scope: OrganizationScope, filter?: AuditEventFilter): Promise<AuditEvent[]>;
  record(scope: OrganizationScope, input: RecordAuditEventInput): Promise<AuditEvent>;
}

/** The full surface a data adapter must implement. */
/* -------------------------------------------------------------------------- */
/* Yelp Assisted                                                               */
/* -------------------------------------------------------------------------- */

export interface YelpListingSnapshotRepository {
  /**
   * Record one successful observation.
   *
   * Append-only: there is no update and no delete, because a snapshot is
   * evidence of what Lia saw at a moment and editing it would make the
   * occurrence that cites it unexplainable.
   */
  record(
    scope: OrganizationScope,
    input: CreateYelpListingSnapshotInput,
  ): Promise<YelpListingSnapshot>;
  /**
   * The most recent observation for one listing, or null on a first check.
   *
   * Null is the baseline case, and the check service treats it as "record a
   * snapshot and stop" rather than as an error — a first check has nothing to
   * compare against and must not manufacture activity out of its own arrival.
   */
  latestForProfile(
    scope: OrganizationScope,
    profileId: string,
  ): Promise<YelpListingSnapshot | null>;
  /** Observation history for one listing, newest first. */
  listForProfile(
    scope: OrganizationScope,
    profileId: string,
    limit?: number,
  ): Promise<YelpListingSnapshot[]>;
}

export interface YelpActivityOccurrenceRepository {
  /**
   * Record a change between two observations, or return the one already there.
   *
   * Idempotent on `(platformProfileId, fromSnapshotId, toSnapshotId)`, enforced
   * by `yelp_activity_occurrences_unique_transition`. The adapter absorbs the
   * unique violation and loads the winning row rather than checking first —
   * two concurrent checks observing the same transition is exactly the race a
   * read-then-insert would lose (D24).
   *
   * `created` distinguishes a fresh detection from a replay, so only a genuine
   * first detection writes an audit event and only it is worth notifying about.
   */
  record(
    scope: OrganizationScope,
    input: RecordYelpActivityInput,
  ): Promise<{ occurrence: YelpActivityOccurrence; created: boolean }>;
  get(
    scope: OrganizationScope,
    occurrenceId: string,
  ): Promise<YelpActivityOccurrence | null>;
  list(
    scope: OrganizationScope,
    filter?: YelpActivityOccurrenceFilter,
  ): Promise<YelpActivityOccurrence[]>;
  /** How many occurrences are still open, for the integration screen's badge. */
  countOpen(scope: OrganizationScope): Promise<number>;
  /**
   * Close an occurrence, either by naming the review somebody added or by
   * dismissing it.
   *
   * One method rather than two because the write is the same shape and the
   * database constrains the pairing (`yelp_activity_capture_pairing`): a
   * `captured` resolution names a mention and a `dismissed` one does not.
   *
   * Guarded on the occurrence still being `open`, so two people resolving the
   * same item do not both succeed — the second gets the first one's row back.
   */
  resolve(
    scope: OrganizationScope,
    input: ResolveYelpActivityInput,
  ): Promise<YelpActivityOccurrence>;
}

/**
 * A detected change, as the check service hands it over.
 *
 * `organizationId` is absent for the reason it is absent from every other write
 * input: the tenant comes from the caller's verified scope, never the payload.
 * Note there is no field for a number of new reviews — see the entity's own
 * doc comment for why that absence is the point.
 */
export interface RecordYelpActivityInput {
  platformProfileId: string;
  locationId: string | null;
  fromSnapshotId: string;
  toSnapshotId: string;
  detectedAt: string;
  changeKind: YelpActivityChangeKind;
  previousReviewCount: number | null;
  currentReviewCount: number | null;
  previousRating: number | null;
  currentRating: number | null;
}

export interface ResolveYelpActivityInput {
  occurrenceId: string;
  /** `captured` must name a mention; `dismissed` must not. */
  status: Extract<YelpActivityStatus, "captured" | "dismissed">;
  capturedMentionId: string | null;
  resolvedByUserId: string;
  resolvedAt: string;
}

export interface LiaDataSource {
  readonly kind: "demo" | "supabase";
  organizations: OrganizationRepository;
  /** First-run setup progress. One row per organization, created with it. */
  onboarding: OnboardingRepository;
  /** Profiles. Self-service only — member administration lives on memberships. */
  users: UserRepository;
  memberships: MembershipRepository;
  /** Pending offers of membership. Acceptance is not organization-scoped. */
  invitations: InvitationRepository;
  locations: LocationRepository;
  platformConnections: PlatformConnectionRepository;
  platformProfiles: PlatformProfileRepository;
  /** Ciphertext only. Server integration layer callers exclusively. */
  platformCredentials: PlatformCredentialRepository;
  /** Not organization-scoped: a callback arrives before the org is known. */
  oauthStates: OAuthStateRepository;
  /** Synchronisation history, and the lock that keeps runs from overlapping. */
  platformSyncRuns: PlatformSyncRunRepository;
  /** Analysis history, and the lock that keeps runs from overlapping. */
  analysisRuns: AnalysisRunRepository;
  /** What Lia watches. */
  monitoringQueries: MonitoringQueryRepository;
  /** Poll history, and the lock that keeps runs from overlapping. */
  newsPollRuns: NewsPollRunRepository;
  /** Why the gate refused an article. Diagnostic, readable by any member. */
  newsRejectedCandidates: NewsRejectedCandidateRepository;
  mentions: MentionRepository;
  responseDrafts: ResponseDraftRepository;
  /** The claim/complete/fail lifecycle behind manual response generation. */
  generationAttempts: GenerationAttemptRepository;
  escalations: EscalationRepository;
  automationRules: AutomationRuleRepository;
  /** One pass of the automation engine over pending mentions, per organization. */
  automationSweeps: AutomationSweepRepository;
  /** Per-(rule, mention) decisions a sweep produced. */
  automationRuleExecutions: AutomationRuleExecutionRepository;
  /** How Lia is configured to sound. One row per organization. */
  brandVoice: BrandVoiceRepository;
  /** What Lia observed about a connected Yelp listing, one row per check. */
  yelpListingSnapshots: YelpListingSnapshotRepository;
  /** Changes Lia noticed between two observations of a listing. */
  yelpActivityOccurrences: YelpActivityOccurrenceRepository;
  /** What Lia publishes on the customer's own website. One per location. */
  reviewWidgets: ReviewWidgetRepository;
  pressWidgets: PressWidgetRepository;
  /** One organization's Stripe relationship. A projection, never a source of truth. */
  billing: BillingRepository;
  /** Stripe's event log, and the claim that makes processing idempotent. */
  stripeWebhookEvents: StripeWebhookEventRepository;
  auditEvents: AuditEventRepository;
}

export type { Organization, Membership, User, Invitation };
