/**
 * The column lists `scripts/generate-seed-sql.ts` writes for each table.
 *
 * Pulled out of that script into its own side-effect-free module for one
 * reason: `tests/seed-generator-columns.test.ts` needs to read these lists
 * without triggering `generate-seed-sql.ts`'s top-level side effect of
 * writing `supabase/seed.sql`. Importing a script that writes a file as a
 * side effect of module evaluation is not something a test should do.
 *
 * This is the data half of the fix for a bug class hit three times while
 * building news monitoring: a column exists in a migration and in the
 * TypeScript domain type, the seed dataset sets a real value for it, and
 * `generate-seed-sql.ts`'s hand-written column list simply never mentions
 * it — so the value silently never reaches `supabase/seed.sql`, and nothing
 * fails, because every other check (schema validation, referential
 * integrity, `db:validate`'s syntax parse) is satisfied by SQL that is
 * merely missing a column, not malformed. `tests/seed-generator-columns.test.ts`
 * closes that gap by asserting these lists match the real migrations in both
 * directions.
 */

/** camelCase -> snake_case, matching the column names in the migrations. */
export function columnName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Every column `generate-seed-sql.ts` writes for a table, keyed by table
 * name, as the camelCase field names used in `src/lib/seed/dataset.ts` (the
 * same strings passed to each `insert()` call there).
 *
 * Typed with `satisfies` rather than a `Record<string, readonly string[]>`
 * annotation: the latter widens every property access to `... | undefined`
 * under `noUncheckedIndexedAccess`, which would force `generate-seed-sql.ts`
 * to handle an "undefined columns for a known table" case that can never
 * actually happen. `satisfies` keeps the literal, fully-keyed type while
 * still checking it against the `Record<string, readonly string[]>` shape.
 */
export const SEED_TABLE_COLUMNS = {
  users: ["id", "email", "firstName", "lastName", "avatarUrl", "createdAt", "updatedAt"],
  organizations: [
    "id", "name", "slug", "industry", "websiteUrl", "defaultTimezone",
    "defaultLanguage", "createdAt", "updatedAt",
  ],
  memberships: [
    "id", "organizationId", "userId", "role", "status", "createdAt", "updatedAt",
  ],
  locations: [
    "id", "organizationId", "name", "slug", "addressLine1", "addressLine2",
    "city", "region", "postalCode", "countryCode", "timezone", "status",
    "managerUserId", "createdAt", "updatedAt",
  ],
  platform_connections: [
    "id", "organizationId", "platform", "externalAccountId",
    "externalAccountName", "status", "capabilities", "tokenExpiresAt",
    "lastSyncedAt", "grantedScopes", "providerMetadata", "lastHealthCheckAt",
    "lastHealthStatus", "lastErrorCode", "lastErrorMessage",
    "connectedByUserId", "connectedAt", "disconnectedAt", "createdAt",
    "updatedAt",
  ],
  platform_profiles: [
    "id", "organizationId", "locationId", "platformConnectionId",
    "externalProfileId", "externalProfileName", "externalAccountId",
    "profileUrl", "status", "verificationState", "providerMetadata",
    "lastConfirmedAt", "syncCursor", "lastSyncedAt", "createdAt", "updatedAt",
  ],
  monitoring_queries: [
    "id", "organizationId", "locationId", "name", "queryType", "keywords",
    "exclusions", "allowedDomains", "deniedDomains", "sourceCountry",
    // Locality (the monitoring-query-locality migration). Null on most seeded
    // rows, which is the honest depiction of a workspace configured before the
    // columns existed.
    "postalCode", "localityCity", "localityRegion",
    "language", "relevanceThreshold", "enabled", "pollIntervalMinutes",
    "origin", "lastPolledAt", "createdAt", "updatedAt",
  ],
  mentions: [
    "id", "organizationId", "locationId", "platformConnectionId",
    "platformProfileId", "sourceType", "externalId", "externalParentId",
    "sourceUrl", "title", "content", "authorName", "authorExternalId", "rating",
    "language", "publishedAt", "receivedAt", "status", "sentiment", "riskLevel",
    "relevanceScore", "engagementScore", "rawPayload",
    "publisherName", "publisherDomain", "isSyndicated", "monitoringQueryId",
    "createdAt", "updatedAt",
  ],
  mention_analyses: [
    "id", "organizationId", "mentionId", "modelProvider", "modelName",
    "promptVersion", "relevanceScore", "relevanceExplanation", "sentiment",
    "sentimentScore", "riskLevel", "riskCategories", "riskExplanation", "topics",
    "factsNeedingVerification", "recommendedAction", "recommendationExplanation",
    "analyzedAt",
    // Provenance (workflow 04). Every seeded row sets these to null today —
    // see the comment on dataset.ts's `analysis()` factory — but they are
    // real, non-defaulted-to-anything-but-null columns, and the day a fixture
    // wants to claim a real run, this is what makes that value reach the SQL.
    "analysisRunId", "inputTokens", "outputTokens",
    // Occurrence lifecycle (the escalation contract migration). Written
    // rather than excluded: the seed dataset's `analysis()` factory sets a
    // real, non-null value (mirroring the migration's own backfill posture
    // for historical rows) so seeded occurrences are not permanently
    // pending — see the comment there.
    "outcomeAppliedAt",
    "createdAt",
  ],
  response_drafts: [
    "id", "organizationId", "mentionId", "responseType", "draftText",
    "finalText", "status", "generatedBy", "generationProvider",
    "generationModel", "promptVersion", "brandVoiceVersion", "policyVersion",
    "assignedUserId", "approvedByUserId", "approvedAt", "publishedAt",
    "externalResponseId", "publicationError", "createdAt", "updatedAt",
  ],
  approvals: [
    "id", "organizationId", "responseDraftId", "requestedByUserId",
    "assignedToUserId", "status", "decisionNote", "decidedAt", "createdAt",
    "updatedAt",
  ],
  escalations: [
    "id", "organizationId", "mentionId", "category", "severity", "status",
    "title", "summary", "assignedUserId", "dueAt", "resolvedAt",
    "resolutionNote",
    // Occurrence provenance (the escalation contract migration). Written as
    // null, following this file's own precedent for nullable provenance
    // columns (e.g. mention_analyses' analysisRunId above): seeded
    // escalations are hand-written fixtures with no real analysis
    // occurrence behind them, so null is the honest value, not an omission.
    "triggerAnalysisId",
    "createdAt", "updatedAt",
  ],
  automation_rules: [
    "id", "organizationId", "name", "description", "status", "priority",
    "conditions", "actions", "lastEvaluatedAt", "lastMatchedAt", "lastAppliedAt",
    "revision", "lastSimulatedAt", "simulatedRevision", "archivedAt",
    "createdAt", "updatedAt",
  ],
  // The five axes are one nested `axes` object on the domain type and five
  // flat columns in the migration, so `generate-seed-sql.ts` flattens the row
  // before writing it. These are the column-side names — the post-flattening
  // keys — which is what keeps this list comparable against the migration.
  brand_voice_profiles: [
    "id", "organizationId", "name", "axisWarmth", "axisDetail",
    "axisFormality", "axisConfidence", "axisHospitality", "approvedPhrases",
    "prohibitedPhrases", "version", "updatedByUserId", "createdAt", "updatedAt",
  ],
  // No surrogate id: `organization_id` is the primary key, one row per
  // organization. Seeded because the backfill in
  // 20260808000100_organization_onboarding.sql runs before `supabase/seed.sql`
  // and therefore never sees these organizations — without these rows a fresh
  // `supabase db reset` would leave both seeded tenants with no onboarding
  // record at all.
  organization_onboarding: [
    "organizationId", "status", "currentStep", "organizationCompletedAt",
    "sourceCompletedAt", "sourceSkippedAt", "locationsCompletedAt",
    "locationsSkippedAt", "brandVoiceCompletedAt", "teamCompletedAt",
    "teamSkippedAt", "completedAt", "readyViewedAt", "organizationSize",
    "createdAt", "updatedAt",
  ],
  audit_events: [
    "id", "organizationId", "actorUserId", "actorType", "eventType",
    "entityType", "entityId", "previousState", "newState", "metadata",
    "occurredAt",
  ],
} satisfies Record<string, readonly string[]>;

/**
 * The conflict target each table's idempotent insert uses.
 *
 * Every seeded table but one is keyed on a surrogate `id`, so `id` is the
 * default and this map holds only the exception. `organization_onboarding` is
 * keyed on `organization_id` — one row per organization is not a rule the
 * application has to remember, and there is no surrogate id for a second row to
 * occupy.
 *
 * This exists because both loaders previously hard-coded `id`. That is a
 * silent, table-shaped assumption: `db:validate` parses the generated SQL
 * happily (`on conflict (id)` is valid syntax against any table), and it fails
 * only when the statement reaches a real Postgres — which is exactly what
 * happened the first time these migrations were applied.
 * `tests/seed-generator-columns.test.ts` now asserts every target is a real
 * column of its table.
 */
export const SEED_CONFLICT_TARGETS: Record<string, string> = {
  organization_onboarding: "organizationId",
};

/** The conflict target for a table, as a snake_case column name. */
export function conflictTarget(table: string): string {
  return columnName(SEED_CONFLICT_TARGETS[table] ?? "id");
}

/**
 * Real, non-generated columns the seed generator deliberately does not
 * write, with why. Each entry here is a visible decision, not a silent gap —
 * `tests/seed-generator-columns.test.ts` fails if a column exists in the
 * migrations but is in neither `SEED_TABLE_COLUMNS` nor this allowlist, and
 * also fails if an allowlisted column turns out to already be generated
 * (which would mean the exclusion is stale and should be deleted).
 *
 * Every column named here is nullable (or has a real default) in the
 * migrations — nothing with a `not null` constraint and no default can ever
 * belong in this list, because the generated INSERT would fail outright
 * against a real database the moment `mentions` had more than zero rows.
 */
export const SEED_COLUMN_EXCLUSIONS: Record<string, readonly string[]> = {
  users: [
    // STORED GENERATED from first_name and last_name (see the user_name_parts
    // migration). Postgres refuses an INSERT that names a generated column,
    // so the seed must not write it — it exists the moment the parts do.
    "fullName",
  ],
  mentions: [
    // Source-owned sync-history fields (workflow 03). Every seeded mention
    // predates any real sync, so claiming a last-synced instant, an owner
    // reply, or an edit history would depict an import that never happened —
    // see the comment on dataset.ts's `mention()` factory. Unlike
    // mention_analyses' provenance columns above, setting these to anything
    // but their null default would be dishonest for *any* seeded row, not
    // merely unfinished, so they stay excluded rather than added at null.
    "externalResourceName", "authorAvatarUrl", "authorIsAnonymous",
    "sourceUpdatedAt", "sourceReplyText", "sourceReplyUpdatedAt",
    "sourceMetadata", "lastSyncedAt",
  ],
};
