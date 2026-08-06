/**
 * Renders `src/lib/seed/dataset.ts` to `supabase/seed.sql`.
 *
 * The dataset is the single source of seed truth. Generating the SQL rather
 * than hand-writing it is what stops the demo data source and the database seed
 * from drifting apart — and a drifted seed is the kind of bug that only shows
 * up once someone finally provisions a database.
 *
 * Run with: npm run db:seed:generate
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Resolved by scripts/tsconfig-paths-hook.mjs, which the npm script preloads.
import { REFERENCE_NOW } from "@/lib/seed/clock";
import { columnName } from "./seed-sql-columns.ts";
import { SEED_PLAN, type SeedRow } from "./seed-plan.ts";

type Scalar = string | number | boolean | null | undefined;
type Row = SeedRow;

/** Single-quote a value for SQL, escaping embedded quotes. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Columns stored as `jsonb`.
 *
 * Named explicitly rather than inferred from the value, because an empty array
 * is ambiguous: `'{}'` is an empty Postgres array and `'[]'` is an empty JSON
 * one, and nothing about `[]` says which column it is destined for. Guessing
 * produces SQL that parses cleanly and fails at execution — which is exactly
 * how `automation_rules.conditions` shipped as `{"[object Object]",...}` and
 * survived every check this repository had until the seed was first run
 * against a real database.
 *
 * Keys are the camelCase field names from the dataset, matched before
 * `columnName()` converts them.
 */
const JSONB_COLUMNS = new Set([
  "capabilities",
  "providerMetadata",
  "rawPayload",
  "sourceMetadata",
  "conditions",
  "actions",
  "previousState",
  "newState",
  "metadata",
]);

function literal(value: Scalar | Scalar[] | object, key?: string): string {
  if (value === null || value === undefined) return "null";

  // Decided by the column, not by the shape of the value. A jsonb column takes
  // JSON whether it holds an object, an array of objects, or an empty array.
  if (key !== undefined && JSONB_COLUMNS.has(key)) {
    return `${quote(JSON.stringify(value))}::jsonb`;
  }

  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return quote(value);

  if (Array.isArray(value)) {
    // Postgres text[] literal. Enum arrays accept the same form.
    if (value.length === 0) return "'{}'";
    const items = value.map((item) => `"${String(item).replaceAll('"', '\\"')}"`);
    return quote(`{${items.join(",")}}`);
  }

  // An object in a column not listed above. Still jsonb — but reaching here
  // means the column is missing from JSONB_COLUMNS, so say so rather than
  // emitting something that happens to work today.
  throw new Error(
    `Object value for column "${key ?? "unknown"}" — add it to JSONB_COLUMNS in this script.`,
  );
}

function insert(table: string, rows: Row[], columns: readonly string[]): string {
  if (rows.length === 0) return `-- ${table}: no rows\n`;

  const columnList = columns.map(columnName).join(", ");
  const values = rows
    .map(
      (row) =>
        `  (${columns.map((key) => literal(row[key] as Scalar, key)).join(", ")})`,
    )
    .join(",\n");

  return [
    `-- ${table} (${rows.length} rows)`,
    `insert into public.${table} (${columnList}) values`,
    values,
    `on conflict (id) do nothing;`,
    "",
  ].join("\n");
}

const sections: string[] = [
  `-- Lia demo seed.`,
  `--`,
  `-- GENERATED FILE — do not edit by hand.`,
  `-- Source: src/lib/seed/dataset.ts`,
  `-- Regenerate: npm run db:seed:generate`,
  `--`,
  `-- Deterministic: ids are derived from stable labels and timestamps are`,
  `-- anchored to ${REFERENCE_NOW}, so re-running produces identical rows.`,
  `-- Safe to re-run: every insert is "on conflict (id) do nothing".`,
  `--`,
  `-- Contains no real credentials, tokens, or personal data.`,
  ``,
  `begin;`,
  ``,
];

// Column lists live in seed-sql-columns.ts, shared with
// tests/seed-generator-columns.test.ts, which asserts each list matches the
// real migrations exactly (modulo the documented SEED_COLUMN_EXCLUSIONS) —
// see that file's header for why this list has burned us three times.
//
// The table order lives in seed-plan.ts, shared with seed-remote.ts, so the
// SQL file and the PostgREST loader seed the same tables in the same order.
for (const { table, rows, columns, note } of SEED_PLAN) {
  if (note) sections.push(note.replace(/^/gm, "-- "));
  sections.push(insert(table, rows, columns));
}

sections.push("commit;", "");

const outputPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../supabase/seed.sql",
);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, sections.join("\n"), "utf8");

const total = SEED_PLAN.reduce((sum, { rows }) => sum + rows.length, 0);
console.log(
  `Wrote ${outputPath} (${total} rows across ${SEED_PLAN.length} tables).`,
);
