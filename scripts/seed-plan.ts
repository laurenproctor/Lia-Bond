/**
 * The ordered list of tables the seed writes, with the rows and columns for
 * each.
 *
 * Two consumers, and they must not drift:
 *
 * - `generate-seed-sql.ts` renders it to `supabase/seed.sql`, for a database
 *   reachable by `psql`.
 * - `seed-remote.ts` upserts it through PostgREST, for a hosted project where
 *   only the service-role key is to hand.
 *
 * Order is insertion order and it is load-bearing — `monitoring_queries`
 * precedes `mentions` because a seeded mention references it, and every child
 * table follows its parent. A loader that sorted these alphabetically would
 * fail on a foreign key.
 *
 * Kept separate from `seed-sql-columns.ts` because that module is the
 * *column* contract, asserted against the migrations by
 * `tests/seed-generator-columns.test.ts`. This one is the *table* contract:
 * which tables are seeded, in what order, from which dataset field.
 */

import { SEED_DATASET } from "@/lib/seed/dataset";
import { SEED_TABLE_COLUMNS } from "./seed-sql-columns.ts";

type Scalar = string | number | boolean | null | undefined;
export type SeedRow = Record<string, Scalar | Scalar[] | object>;

export interface SeedTablePlan {
  table: string;
  rows: SeedRow[];
  columns: readonly string[];
  /** Rendered as a SQL comment by the generator; ignored by the loader. */
  note?: string;
}

export const SEED_PLAN: SeedTablePlan[] = [
  { table: "users", rows: SEED_DATASET.users, columns: SEED_TABLE_COLUMNS.users },
  {
    table: "organizations",
    rows: SEED_DATASET.organizations,
    columns: SEED_TABLE_COLUMNS.organizations,
  },
  {
    table: "memberships",
    rows: SEED_DATASET.memberships,
    columns: SEED_TABLE_COLUMNS.memberships,
  },
  {
    table: "locations",
    rows: SEED_DATASET.locations,
    columns: SEED_TABLE_COLUMNS.locations,
  },
  {
    table: "platform_connections",
    rows: SEED_DATASET.platformConnections,
    columns: SEED_TABLE_COLUMNS.platform_connections,
    note:
      "No credential column appears here, and none ever should: OAuth material\n" +
      "lives in platform_connection_secrets, which is service-role only and is\n" +
      "deliberately not seeded. A fixture token is how a fixture token ends up\n" +
      "somewhere real.",
  },
  {
    table: "platform_profiles",
    rows: SEED_DATASET.platformProfiles,
    columns: SEED_TABLE_COLUMNS.platform_profiles,
  },
  {
    table: "monitoring_queries",
    rows: SEED_DATASET.monitoringQueries,
    columns: SEED_TABLE_COLUMNS.monitoring_queries,
    note:
      "Must precede `mentions`: a seeded mention's monitoring_query_id\n" +
      "references this table, and insertion order is what satisfies it.",
  },
  { table: "mentions", rows: SEED_DATASET.mentions, columns: SEED_TABLE_COLUMNS.mentions },
  {
    table: "mention_analyses",
    rows: SEED_DATASET.mentionAnalyses,
    columns: SEED_TABLE_COLUMNS.mention_analyses,
  },
  {
    table: "response_drafts",
    rows: SEED_DATASET.responseDrafts,
    columns: SEED_TABLE_COLUMNS.response_drafts,
  },
  {
    table: "approvals",
    rows: SEED_DATASET.approvals,
    columns: SEED_TABLE_COLUMNS.approvals,
  },
  {
    table: "escalations",
    rows: SEED_DATASET.escalations,
    columns: SEED_TABLE_COLUMNS.escalations,
  },
  {
    table: "automation_rules",
    rows: SEED_DATASET.automationRules,
    columns: SEED_TABLE_COLUMNS.automation_rules,
  },
  {
    table: "brand_voice_profiles",
    // Flattened here: the domain type nests the five axes under `axes`, the
    // migration holds them as five columns. The mapping lives in the plan so
    // the dataset stays shaped like the type the application reads.
    rows: SEED_DATASET.brandVoiceProfiles.map((profile) => ({
      id: profile.id,
      organizationId: profile.organizationId,
      name: profile.name,
      axisWarmth: profile.axes.warmth,
      axisDetail: profile.axes.detail,
      axisFormality: profile.axes.formality,
      axisConfidence: profile.axes.confidence,
      axisHospitality: profile.axes.hospitality,
      approvedPhrases: profile.approvedPhrases,
      prohibitedPhrases: profile.prohibitedPhrases,
      version: profile.version,
      updatedByUserId: profile.updatedByUserId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
    columns: SEED_TABLE_COLUMNS.brand_voice_profiles,
  },
  {
    table: "audit_events",
    rows: SEED_DATASET.auditEvents,
    columns: SEED_TABLE_COLUMNS.audit_events,
  },
];
