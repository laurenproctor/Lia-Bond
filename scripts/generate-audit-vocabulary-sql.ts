/**
 * Renders a migration that restates `audit_events_known_event_type` from
 * `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`.
 *
 * Postgres has no statement for adding a value to a check constraint, so every
 * migration that introduces an audit event name drops the constraint and adds
 * it back with the *whole* list restated. That is safe on one line of history
 * and hazardous the moment there are two: each branch restates the vocabulary
 * as it stood on that branch, migrations apply in filename order, and whichever
 * sorts last silently drops the other's names. The result is valid SQL that
 * applies cleanly and throws `23514` on the first real write — in Supabase mode
 * only, where the demo adapter's plain in-memory array sees nothing.
 *
 * That has happened three times: 20260807000700_audit_vocabulary_merge.sql
 * (membership and brand voice, dropped by news monitoring),
 * 20260818000300_yelp_audit_vocabulary.sql (which dropped Reddit's thirteen,
 * caught before merge), and 20260820000100_location_audit_vocabulary_after_yelp.sql
 * (two location events, caught after).
 *
 * `tests/audit-vocabulary-migrations.test.ts` is what *detects* all three: it
 * replays every migration with the real Postgres grammar and compares the final
 * permitted set against `AUDIT_EVENT_TYPES`. This script is the other half —
 * the *repair*. Hand-merging eighty-five names out of two prior migrations is
 * how a fix ends up correct for the branches its author knew about and wrong
 * for the next one; deriving the list from the TypeScript array cannot be a
 * stale copy of anything.
 *
 * It does not prevent the collision. Two branches that each add events still
 * produce two migrations, each carrying only its own branch's union, and the
 * later filename still wins. What it removes is the chance of getting the
 * repair wrong once the test has told you a repair is needed. Ending the class
 * outright means a vocabulary that accumulates rather than restates — a
 * reference table with a foreign key, where adding an event is an `insert`
 * two branches can both perform. See `docs/architecture/audit-vocabulary.md`.
 *
 * `buildAuditVocabularyLines()` is exported (rather than only run as a CLI) so
 * `tests/audit-vocabulary-generator.test.ts` can parse the exact bytes the CLI
 * writes, without importing a module whose evaluation writes a file — see
 * `scripts/seed-sql-columns.ts`'s header for why that split matters.
 *
 * Run with: npm run audit:vocabulary:generate -- --slug reddit_audit_vocabulary
 */

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Resolved by scripts/tsconfig-paths-hook.mjs, which the npm script preloads.
import { AUDIT_EVENT_TYPES } from "@/domain/enums";

/** The constraint every audit-vocabulary migration replaces. */
export const AUDIT_EVENT_CONSTRAINT = "audit_events_known_event_type";

const CONSTRAINT_COMMENT =
  "Closed list of audit event names, generated from AUDIT_EVENT_TYPES by " +
  "npm run audit:vocabulary:generate. Every migration that adds one restates the whole list, " +
  "because Postgres cannot extend a check constraint — " +
  "tests/audit-vocabulary-migrations.test.ts pins this against AUDIT_EVENT_TYPES in both " +
  "directions so a redefinition assembled from a stale copy cannot silently drop an event the " +
  "application still emits.";

/**
 * Rejects anything that would not survive being wrapped in single quotes.
 *
 * Not a SQL-injection guard — this input is a checked-in TypeScript array, not
 * a request. It is here because a name containing an apostrophe would emit SQL
 * that fails to parse, and the failure would surface as a confusing syntax
 * error in a generated file rather than as the naming mistake it actually is.
 */
function assertEmittable(events: readonly string[]): void {
  if (events.length === 0) {
    throw new Error("Refusing to generate an empty audit vocabulary.");
  }

  const seen = new Set<string>();
  for (const event of events) {
    if (event.includes("'") || event.includes("\\") || event.trim() !== event) {
      throw new Error(
        `Audit event name ${JSON.stringify(event)} cannot be emitted as a SQL string literal.`,
      );
    }
    if (seen.has(event)) {
      throw new Error(`Audit event name ${JSON.stringify(event)} appears twice in AUDIT_EVENT_TYPES.`);
    }
    seen.add(event);
  }
}

export interface AuditVocabularyOptions {
  /**
   * Why this migration exists, as the first line of the file.
   *
   * The generated list carries no per-event commentary — the reasoning for each
   * name lives beside it in `AUDIT_EVENT_TYPES`, and duplicating it here is how
   * the two would come to disagree. This one line is the occasion.
   */
  readonly reason?: string;
}

/**
 * The migration body, as lines, derived entirely from `events`.
 *
 * Order follows `AUDIT_EVENT_TYPES` rather than being sorted, so a reviewer
 * diffing this against the previous vocabulary migration sees the additions
 * where the array puts them instead of scattered through an alphabetical list.
 */
export function buildAuditVocabularyLines(
  events: readonly string[] = AUDIT_EVENT_TYPES,
  options: AuditVocabularyOptions = {},
): string[] {
  assertEmittable(events);

  const reason =
    options.reason ??
    "Restate the audit vocabulary so the check constraint matches AUDIT_EVENT_TYPES.";

  const lines: string[] = [
    `-- ${reason}`,
    "--",
    "-- Generated by `npm run audit:vocabulary:generate` from `AUDIT_EVENT_TYPES` in",
    "-- `src/domain/enums.ts`. Do not hand-edit: the value of this file is that its",
    "-- list is derived rather than copied, and an edit here is exactly the stale",
    "-- copy the generator exists to rule out. Add the event to the TypeScript array",
    "-- and regenerate.",
    "--",
    "-- Postgres cannot extend a check constraint, so this restates the whole list.",
    "-- `tests/audit-vocabulary-migrations.test.ts` replays every migration in",
    "-- filename order and compares the final permitted set against that same array",
    "-- in both directions, which is what fails if a later branch drops these names.",
    "",
    "alter table public.audit_events",
    `  drop constraint ${AUDIT_EVENT_CONSTRAINT};`,
    "",
    "alter table public.audit_events",
    `  add constraint ${AUDIT_EVENT_CONSTRAINT} check (`,
    "    event_type in (",
  ];

  events.forEach((event, index) => {
    const comma = index === events.length - 1 ? "" : ",";
    lines.push(`      '${event}'${comma}`);
  });

  lines.push(
    "    )",
    "  );",
    "",
    `comment on constraint ${AUDIT_EVENT_CONSTRAINT} on public.audit_events is`,
    `  '${CONSTRAINT_COMMENT.replaceAll("'", "''")}';`,
    "",
    "-- No entity-type change. `audit_entity_type` is a Postgres enum and its values",
    "-- are added with `add value if not exists`, which is additive — unlike the",
    "-- check constraint above, a later migration cannot drop an earlier one's value.",
    "-- Add one in its own migration when a new subject appears.",
  );

  return lines;
}

/**
 * The next unused `YYYYMMDDNNNNNN` version for `date`.
 *
 * The repository numbers same-day migrations in hundreds (`000100`, `000200`),
 * leaving room to insert one between two others without renumbering an applied
 * file — which the 20260808 collision proved you cannot do.
 */
export function nextMigrationVersion(existing: readonly string[], date: Date): string {
  const day =
    `${date.getUTCFullYear()}` +
    `${String(date.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(date.getUTCDate()).padStart(2, "0")}`;

  let highest = 0;
  for (const name of existing) {
    if (!name.startsWith(day)) continue;
    const sequence = Number.parseInt(name.slice(8, 14), 10);
    if (Number.isFinite(sequence) && sequence > highest) highest = sequence;
  }

  return `${day}${String(highest + 100).padStart(6, "0")}`;
}

function readFlag(name: string): string | undefined {
  const prefixed = `--${name}`;
  const index = process.argv.indexOf(prefixed);
  if (index === -1 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

function isMain(): boolean {
  if (process.argv[1] === undefined) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMain()) {
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
  const slug = readFlag("slug") ?? "audit_vocabulary";
  const reason = readFlag("reason");

  if (!/^[a-z0-9_]+$/.test(slug)) {
    throw new Error(`--slug must be lower_snake_case; got ${JSON.stringify(slug)}.`);
  }

  const version = nextMigrationVersion(readdirSync(migrationsDir), new Date());
  const outputPath = join(migrationsDir, `${version}_${slug}.sql`);
  const lines = buildAuditVocabularyLines(AUDIT_EVENT_TYPES, { reason });

  writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");

  console.log(`Wrote ${outputPath} (${AUDIT_EVENT_TYPES.length} event types).`);
}
