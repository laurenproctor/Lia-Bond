import type {
  Approval,
  AuditEvent,
  AuditEventFilter,
  AutomationRule,
  AutomationRuleFilter,
  ConnectionHealthUpdate,
  CreateLocationInput,
  CreateMentionInput,
  Escalation,
  EscalationFilter,
  FinishSyncRunInput,
  IngestMentionInput,
  Location,
  Membership,
  MembershipWithUser,
  Mention,
  MentionAnalysis,
  MentionFilter,
  MentionIngestOutcome,
  MentionStatus,
  OAuthState,
  Organization,
  OrganizationMembership,
  Platform,
  PlatformConnection,
  PlatformProfile,
  PlatformSyncRun,
  RecordAuditEventInput,
  ResponseDraft,
  ResponseDraftFilter,
  StartSyncRunInput,
  SyncResource,
  UpsertPlatformConnectionInput,
  UpsertPlatformProfileInput,
  User,
} from "@/domain";

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

export interface OrganizationRepository {
  /** Organizations where this user holds an active membership. */
  listForUser(userId: string): Promise<OrganizationMembership[]>;
  getBySlug(slug: string, userId: string): Promise<OrganizationMembership | null>;
  getById(organizationId: string, userId: string): Promise<OrganizationMembership | null>;
}

export interface MembershipRepository {
  /** The caller's own membership. Returns null when there is none, or it is not active. */
  getActiveMembership(organizationId: string, userId: string): Promise<Membership | null>;
  listMembers(scope: OrganizationScope): Promise<MembershipWithUser[]>;
  listAssignableUsers(scope: OrganizationScope): Promise<User[]>;
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
  updateStatus(
    scope: OrganizationScope,
    mentionId: string,
    status: MentionStatus,
  ): Promise<Mention>;
  latestAnalysis(scope: OrganizationScope, mentionId: string): Promise<MentionAnalysis | null>;
}

export interface ResponseDraftRepository {
  list(scope: OrganizationScope, filter?: ResponseDraftFilter): Promise<ResponseDraft[]>;
  get(scope: OrganizationScope, draftId: string): Promise<ResponseDraft | null>;
  assign(
    scope: OrganizationScope,
    draftId: string,
    assignedUserId: string | null,
  ): Promise<ResponseDraft>;
  /** Applies the decision to both the draft and its open approval record. */
  decide(
    scope: OrganizationScope,
    draftId: string,
    decision: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote?: string,
  ): Promise<{ draft: ResponseDraft; approval: Approval | null }>;
  listApprovals(scope: OrganizationScope, draftId: string): Promise<Approval[]>;
}

export interface EscalationRepository {
  list(scope: OrganizationScope, filter?: EscalationFilter): Promise<Escalation[]>;
  get(scope: OrganizationScope, escalationId: string): Promise<Escalation | null>;
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

export interface AutomationRuleRepository {
  list(scope: OrganizationScope, filter?: AutomationRuleFilter): Promise<AutomationRule[]>;
  get(scope: OrganizationScope, ruleId: string): Promise<AutomationRule | null>;
  setEnabled(
    scope: OrganizationScope,
    ruleId: string,
    enabled: boolean,
  ): Promise<AutomationRule>;
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

export interface AuditEventRepository {
  list(scope: OrganizationScope, filter?: AuditEventFilter): Promise<AuditEvent[]>;
  record(scope: OrganizationScope, input: RecordAuditEventInput): Promise<AuditEvent>;
}

/** The full surface a data adapter must implement. */
export interface LiaDataSource {
  readonly kind: "demo" | "supabase";
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  locations: LocationRepository;
  platformConnections: PlatformConnectionRepository;
  platformProfiles: PlatformProfileRepository;
  /** Ciphertext only. Server integration layer callers exclusively. */
  platformCredentials: PlatformCredentialRepository;
  /** Not organization-scoped: a callback arrives before the org is known. */
  oauthStates: OAuthStateRepository;
  /** Synchronisation history, and the lock that keeps runs from overlapping. */
  platformSyncRuns: PlatformSyncRunRepository;
  mentions: MentionRepository;
  responseDrafts: ResponseDraftRepository;
  escalations: EscalationRepository;
  automationRules: AutomationRuleRepository;
  auditEvents: AuditEventRepository;
}

export type { Organization, Membership, User };
