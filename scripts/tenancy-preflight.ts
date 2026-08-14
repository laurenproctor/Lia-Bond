/**
 * Read-only cross-tenant violation counts against the hosted project.
 *
 * The migrations in `20260814000200_location_tenant_integrity.sql` add
 * same-organization composite foreign keys to tables that have never had one.
 * Adding such a constraint to a table holding a violating row fails the
 * migration — loudly, mid-`db push`, on a database somebody is using. This
 * script answers "would it?" before the migration is written, which is the
 * whole reason `20260811000100_tenant_integrity_prereqs.sql` carries a
 * pre-flight `DO` block of its own: a violation is a live cross-tenant defect
 * to investigate, never data to grandfather or rewrite.
 *
 * It goes through PostgREST under the service-role key rather than `psql`, for
 * the reason `scripts/seed-remote.ts` records at length: the database password
 * is not in the repository and is not recoverable from the CLI's keychain
 * entry, so the service-role key is the credential a developer actually has.
 * That means the joins happen here rather than in SQL — every table involved
 * is small enough (locations, profiles, monitoring queries, memberships) or is
 * read by a single indexed column (mentions), and the alternative was not
 * running the check at all.
 *
 * **Read-only by construction.** Every call is `.select()`. Nothing here
 * inserts, updates, deletes, or calls an RPC, and it must stay that way — this
 * runs against production with a credential that bypasses RLS.
 *
 * Exit code 1 when any required check finds a violation, so it can gate a push
 * rather than merely inform one. The SEC-1 section is reported but never gates:
 * those foreign keys are inventoried in this workflow and closed in a later
 * one, and a non-zero count there is a finding to record, not a reason to stop
 * this migration.
 *
 * Run with: npm run db:preflight-tenancy
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n" +
      "Run with: npm run db:preflight-tenancy",
  );
  process.exit(1);
}

const client = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PAGE = 1000;

/**
 * Every row of one table, paged.
 *
 * PostgREST caps a response at its configured maximum, and a silent truncation
 * here would under-report violations — which is the one failure mode this
 * script must not have, since a clean run is what authorises a migration.
 */
async function readAll(
  table: string,
  columns: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      throw new Error(`reading ${table}: ${error.message}`);
    }
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface Check {
  id: string;
  label: string;
  /** Required checks gate the migration; informational ones only report. */
  gating: boolean;
  count: number;
  sample: string[];
}

const checks: Check[] = [];

function record(
  id: string,
  label: string,
  gating: boolean,
  violations: string[],
): void {
  checks.push({ id, label, gating, count: violations.length, sample: violations.slice(0, 5) });
}

/** organization_id of each row, keyed by id. */
function orgIndex(rows: Record<string, unknown>[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    const id = str(row.id);
    const organizationId = str(row.organization_id);
    if (id && organizationId) index.set(id, organizationId);
  }
  return index;
}

/**
 * Rows whose optional reference points at a row in a different organization.
 *
 * A reference to a row that does not exist at all is reported separately: the
 * composite foreign key would reject that too, and it is a different defect
 * (dangling, not cross-tenant) with a different remedy.
 */
function crossTenant(
  rows: Record<string, unknown>[],
  column: string,
  target: Map<string, string>,
): { mismatched: string[]; dangling: string[] } {
  const mismatched: string[] = [];
  const dangling: string[] = [];

  for (const row of rows) {
    const reference = str(row[column]);
    if (!reference) continue;
    const ownOrg = str(row.organization_id);
    const referencedOrg = target.get(reference);
    if (referencedOrg === undefined) {
      dangling.push(`${str(row.id)} -> ${column}=${reference}`);
    } else if (referencedOrg !== ownOrg) {
      mismatched.push(`${str(row.id)} (org ${ownOrg}) -> ${column}=${reference} (org ${referencedOrg})`);
    }
  }

  return { mismatched, dangling };
}

async function main(): Promise<void> {
  console.log(`Reading ${url}\n`);

  const [locations, profiles, queries, memberships] = await Promise.all([
    readAll("locations", "id,organization_id,manager_user_id,name"),
    readAll("platform_profiles", "id,organization_id,location_id,platform_connection_id"),
    readAll("monitoring_queries", "id,organization_id,location_id"),
    readAll("memberships", "id,organization_id,user_id,status"),
  ]);

  // `mentions` is the only table here that is not inherently small.
  const mentions = await readAll(
    "mentions",
    "id,organization_id,platform_profile_id,platform_connection_id,monitoring_query_id",
  );
  const connections = await readAll("platform_connections", "id,organization_id");

  console.log(
    `locations=${locations.length} platform_profiles=${profiles.length} ` +
      `monitoring_queries=${queries.length} memberships=${memberships.length} ` +
      `mentions=${mentions.length} platform_connections=${connections.length}\n`,
  );

  const locationOrg = orgIndex(locations);
  const profileOrg = orgIndex(profiles);
  const connectionOrg = orgIndex(connections);
  const queryOrg = orgIndex(queries);

  /* ---- Gating: the four constraints 20260814000200 adds ---- */

  const profileLocation = crossTenant(profiles, "location_id", locationOrg);
  record("A2-1", "platform_profiles.location_id -> locations", true, [
    ...profileLocation.mismatched,
    ...profileLocation.dangling,
  ]);

  const queryLocation = crossTenant(queries, "location_id", locationOrg);
  record("A2-2", "monitoring_queries.location_id -> locations", true, [
    ...queryLocation.mismatched,
    ...queryLocation.dangling,
  ]);

  const mentionProfile = crossTenant(mentions, "platform_profile_id", profileOrg);
  record("A2-3", "mentions.platform_profile_id -> platform_profiles", true, [
    ...mentionProfile.mismatched,
    ...mentionProfile.dangling,
  ]);

  // The manager constraint is not a plain reference check: it must land in
  // `memberships`, keyed on the pair, which no other column in this script is.
  const membershipPairs = new Map<string, string>();
  for (const row of memberships) {
    const organizationId = str(row.organization_id);
    const userId = str(row.user_id);
    const status = str(row.status);
    if (organizationId && userId && status) {
      membershipPairs.set(`${organizationId}:${userId}`, status);
    }
  }

  const managerMissing: string[] = [];
  const managerSuspended: string[] = [];
  for (const row of locations) {
    const managerUserId = str(row.manager_user_id);
    if (!managerUserId) continue;
    const key = `${str(row.organization_id)}:${managerUserId}`;
    const status = membershipPairs.get(key);
    if (status === undefined) {
      managerMissing.push(`${str(row.name)} (${str(row.id)}) -> manager ${managerUserId}`);
    } else if (status !== "active") {
      managerSuspended.push(`${str(row.name)} (${str(row.id)}) -> manager ${managerUserId} is ${status}`);
    }
  }
  record("A2-4", "locations.manager_user_id -> memberships (same organization)", true, managerMissing);

  // Deliberately non-gating. D207's trigger validates a manager on assignment
  // and never on suspension, so an existing suspended manager is the
  // population the design leaves alone on purpose — it belongs in the ledger
  // so the trigger's behaviour is checked against real data, not treated as a
  // violation to fix.
  record(
    "A2-5",
    "locations with a suspended manager (informational — D201/D207 keep these)",
    false,
    managerSuspended,
  );

  /* ---- Informational: SEC-1 baseline (spec §6.1) ---- */

  const profileConnection = crossTenant(profiles, "platform_connection_id", connectionOrg);
  record("SEC-1 P1a", "platform_profiles.platform_connection_id -> platform_connections", false, [
    ...profileConnection.mismatched,
    ...profileConnection.dangling,
  ]);

  const mentionConnection = crossTenant(mentions, "platform_connection_id", connectionOrg);
  record("SEC-1 P1b", "mentions.platform_connection_id -> platform_connections", false, [
    ...mentionConnection.mismatched,
    ...mentionConnection.dangling,
  ]);

  const mentionQuery = crossTenant(mentions, "monitoring_query_id", queryOrg);
  record("SEC-1 P1c", "mentions.monitoring_query_id -> monitoring_queries", false, [
    ...mentionQuery.mismatched,
    ...mentionQuery.dangling,
  ]);

  /* ---- Report ---- */

  let failed = false;
  for (const check of checks) {
    const gate = check.gating ? "GATING" : "info  ";
    const verdict = check.count === 0 ? "clean" : `${check.count} VIOLATION(S)`;
    console.log(`[${gate}] ${check.id.padEnd(9)} ${check.label}\n           -> ${verdict}`);
    for (const sample of check.sample) console.log(`              ${sample}`);
    if (check.count > check.sample.length) {
      console.log(`              … and ${check.count - check.sample.length} more`);
    }
    if (check.gating && check.count > 0) failed = true;
  }

  console.log("");
  if (failed) {
    console.error(
      "Cross-tenant violations exist. Investigate each one before writing or\n" +
        "pushing 20260814000200. Do not grandfather and do not rewrite the data.",
    );
    process.exit(1);
  }
  console.log("All gating checks clean. 20260814000200 may be written and pushed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
