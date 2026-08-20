/**
 * Parses every migration and the generated seed with the real PostgreSQL grammar.
 *
 * Workflow 01 did this by hand and recorded the result in the README. Making it
 * a command matters because the alternative — "the SQL looked right" — is not a
 * check, and this repository's migrations have never been executed against a
 * server. A parse is not a substitute for running them (it catches syntax, not
 * a column that does not exist), but it is the strongest guarantee available
 * without a database, and it is worth having on every change rather than once.
 *
 * Run with: npm run db:validate
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "libpg-query";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");

const files = [
  ...readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    // Lexicographic order is the order Supabase applies them in, because the
    // filenames are timestamp-prefixed. Validating in the same order means a
    // later migration is read after the one it depends on.
    .sort()
    .map((name) => join("supabase", "migrations", name)),
  join("supabase", "seed.sql"),
  join("supabase", "tests", "rls-verification.sql"),
  join("supabase", "tests", "tenancy-verification.sql"),
  join("supabase", "tests", "expanded-phase-rehearsal.sql"),
];

let failed = false;

for (const relativePath of files) {
  const absolutePath = join(root, relativePath);

  try {
    const sql = readFileSync(absolutePath, "utf8");
    const result = await parse(sql);
    console.log(`ok    ${relativePath} — ${result.stmts.length} statements`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${relativePath}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) {
  console.error("\nMigration validation failed.");
  process.exit(1);
}

console.log(`\n${files.length} files parsed.`);
