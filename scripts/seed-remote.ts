/**
 * Loads the demo seed into the linked hosted Supabase project.
 *
 * `supabase/seed.sql` is the seed for a database you can reach with `psql`.
 * This is the same seed for one you cannot: it goes through PostgREST under
 * the service-role key, which is the credential a developer already has in
 * `.env`, rather than the database password, which is not stored in the repo
 * and is not recoverable from the CLI's keychain entry.
 *
 * It exists because the gap was real: after `supabase db push` there was no
 * supported way to seed the hosted project without that password, so the new
 * tables sat empty and every read path against real Postgres was exercising
 * an empty database.
 *
 * Both loaders read `SEED_PLAN`, so they seed the same tables in the same
 * order from the same dataset. Adding a table to the plan reaches both.
 *
 * Idempotent by default, matching `seed.sql`'s "on conflict (id) do nothing":
 * rows that already exist are left exactly as they are, so this never
 * overwrites work done in the hosted project.
 *
 * `--overwrite` changes that conflict rule to "do update", and exists for one
 * situation `seed.sql` cannot handle at all: a database seeded *before* a
 * migration added a column. The row already exists, so "do nothing" skips it,
 * and the new column keeps its default forever — which is how the hosted
 * project ended up with `news_article` mentions carrying no publisher and no
 * monitoring query long after both columns existed. Re-running the plain seed
 * would never have fixed it, and nothing would have reported a problem.
 *
 * It is opt-in because it is destructive in the one way the default is not:
 * every seeded row goes back to its dataset value, discarding anything a
 * person changed in the hosted project. Safe on a demo tenant, wrong on
 * anything else.
 *
 * Run with: npm run db:seed:remote  (add -- --overwrite to force)
 */

import { createClient } from "@supabase/supabase-js";
import { columnName } from "./seed-sql-columns.ts";
import { SEED_PLAN, type SeedRow } from "./seed-plan.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n" +
      "Run with: npm run db:seed:remote",
  );
  process.exit(1);
}

/**
 * Service-role, so this bypasses RLS.
 *
 * Correct here and nowhere else in this repository: seeding writes rows for
 * organizations the caller holds no membership in, which is precisely what
 * every policy is built to refuse. It is also why this is a script run by a
 * person and not anything reachable from the application.
 */
const client = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** camelCase dataset row -> snake_case column row, in the plan's column order. */
function toColumnRow(row: SeedRow, columns: readonly string[]) {
  const mapped: Record<string, unknown> = {};
  for (const key of columns) {
    // `undefined` and a missing key both mean "no value" in the dataset;
    // PostgREST needs an explicit null or it leaves the column out of the
    // insert entirely, which silently takes the database default instead.
    mapped[columnName(key)] = row[key] ?? null;
  }
  return mapped;
}

const overwrite = process.argv.includes("--overwrite");

console.log(
  overwrite
    ? "Mode: OVERWRITE — existing seeded rows will be reset to their dataset values.\n"
    : "Mode: insert-only — existing rows are left untouched.\n",
);

let failed = false;

for (const { table, rows, columns } of SEED_PLAN) {
  if (rows.length === 0) {
    console.log(`${table.padEnd(24)} no rows in the dataset`);
    continue;
  }

  const { error } = await client
    .from(table)
    .upsert(rows.map((row) => toColumnRow(row, columns)), {
      onConflict: "id",
      ignoreDuplicates: !overwrite,
    });

  if (error) {
    failed = true;
    console.error(`${table.padEnd(24)} FAILED  ${error.code}: ${error.message}`);
    if (error.details) console.error(`${" ".repeat(24)} ${error.details}`);
    // Keep going rather than stopping at the first failure: the tables are
    // ordered by foreign key, so one failure usually cascades into several
    // and seeing all of them together is what identifies the root cause.
    continue;
  }

  const { count } = await client
    .from(table)
    .select("*", { count: "exact", head: true });
  console.log(`${table.padEnd(24)} ok, table now holds ${count} rows`);
}

if (failed) {
  console.error("\nSeeding finished with errors. Nothing was overwritten.");
  process.exit(1);
}

console.log("\nSeed loaded.");
