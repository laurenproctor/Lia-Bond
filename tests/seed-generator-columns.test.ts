import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "libpg-query";
import { describe, expect, it } from "vitest";
import {
  columnName,
  conflictTarget,
  SEED_COLUMN_EXCLUSIONS,
  SEED_CONFLICT_TARGETS,
  SEED_TABLE_COLUMNS,
} from "../scripts/seed-sql-columns.ts";

/**
 * Pins `scripts/generate-seed-sql.ts`'s column lists against the real
 * Postgres columns those tables have, as defined by the migrations.
 *
 * The same shape of bug as `tests/audit-vocabulary-migrations.test.ts` (whose
 * approach this file follows closely): a hand-written list on the TypeScript
 * side is supposed to mirror something on the database side, nothing keeps
 * them in sync automatically, and every other check in this repository is
 * satisfied by the drifted state. `db:validate` only parses the generated SQL
 * for syntax — a column silently missing from an `insert` statement is
 * perfectly valid SQL. `seed-dataset.test.ts` validates the TypeScript
 * objects against the Zod domain schemas, which have nothing to do with what
 * `generate-seed-sql.ts` actually chose to write out. This bug class was hit
 * three times while building news monitoring (`monitoring_queries` missing
 * entirely, `mentions`' four news columns, `mention_analyses`' three
 * provenance columns) and found each time by a human reading the diff rather
 * than by anything failing. This test makes it a build failure instead.
 *
 * It parses every migration with the real Postgres grammar (`libpg-query`,
 * the same library `scripts/validate-migrations.mjs` and
 * `audit-vocabulary-migrations.test.ts` use) and replays `create table` /
 * `alter table ... add column` / `alter table ... drop column` in migration
 * order (lexicographic filename order — the same order Supabase applies
 * them) to arrive at each table's final column set, the same way Postgres
 * would after applying every migration in sequence.
 *
 * Checked in both directions per table: every real column must be either
 * generated or in the documented `SEED_COLUMN_EXCLUSIONS` allowlist (catches
 * the bug this test exists for), and every generated or allowlisted column
 * must be real (catches the opposite mistake — a column renamed or dropped
 * in a migration that the generator or the allowlist never noticed).
 */

const root = resolve(process.cwd());
const migrationsDir = join(root, "supabase", "migrations");

interface StmtWrapper {
  stmt?: Record<string, unknown>;
}

function relationTable(relation: unknown): string | null {
  if (relation === null || typeof relation !== "object") return null;
  const record = relation as Record<string, unknown>;
  const schema = record["schemaname"];
  const name = record["relname"];
  // Only public-schema tables are in scope; nothing in this codebase creates
  // tables in another schema.
  if (schema !== undefined && schema !== "public") return null;
  return typeof name === "string" ? name : null;
}

/**
 * Columns defined by a `create table public.<name> (...)` statement, or
 * `null` if `stmt` is not one.
 *
 * Throws if it recognises the statement but cannot read a column name out of
 * it — silently returning an empty or partial list here would let this test
 * pass by finding nothing, which is worse than not having it (see the same
 * principle in `audit-vocabulary-migrations.test.ts`).
 */
function columnsFromCreateTable(stmt: Record<string, unknown>): { table: string; columns: string[] } | null {
  const create = stmt["CreateStmt"] as Record<string, unknown> | undefined;
  if (!create) return null;

  const table = relationTable(create["relation"]);
  if (!table) return null;

  const elts = create["tableElts"];
  if (!Array.isArray(elts)) {
    throw new Error(`"create table public.${table}" has no readable column list.`);
  }

  const columns: string[] = [];
  for (const elt of elts) {
    // tableElts mixes ColumnDef entries with table-level Constraint entries
    // (e.g. a named `unique (...)` or `check (...)`); only ColumnDef is a
    // column.
    const colDef = (elt as Record<string, unknown>)["ColumnDef"] as
      | Record<string, unknown>
      | undefined;
    if (!colDef) continue;

    const colname = colDef["colname"];
    if (typeof colname !== "string" || colname.length === 0) {
      throw new Error(
        `"create table public.${table}" has a column definition with no readable name.`,
      );
    }
    columns.push(colname);
  }

  if (columns.length === 0) {
    throw new Error(`"create table public.${table}" produced zero columns — extraction is broken.`);
  }

  return { table, columns };
}

interface ColumnChange {
  table: string;
  add?: string;
  drop?: string;
}

/**
 * Column additions and removals from an `alter table public.<name> (...)`
 * statement. Every `AlterTableCmd` subtype other than add/drop column
 * (constraints, RLS, defaults, type changes) is intentionally ignored: none
 * of them changes which columns exist, which is the only thing this file
 * cares about.
 */
function columnChangesFromAlterTable(stmt: Record<string, unknown>): ColumnChange[] {
  const alter = stmt["AlterTableStmt"] as Record<string, unknown> | undefined;
  if (!alter) return [];

  const table = relationTable(alter["relation"]);
  if (!table) return [];

  const cmds = alter["cmds"];
  if (!Array.isArray(cmds)) return [];

  const changes: ColumnChange[] = [];
  for (const wrapper of cmds) {
    const cmd = (wrapper as Record<string, unknown>)["AlterTableCmd"] as
      | Record<string, unknown>
      | undefined;
    if (!cmd) continue;

    if (cmd["subtype"] === "AT_AddColumn") {
      const def = cmd["def"] as Record<string, unknown> | undefined;
      const colDef = def?.["ColumnDef"] as Record<string, unknown> | undefined;
      const colname = colDef?.["colname"];
      if (typeof colname !== "string" || colname.length === 0) {
        throw new Error(
          `"alter table public.${table} add column" has no readable column name.`,
        );
      }
      changes.push({ table, add: colname });
    } else if (cmd["subtype"] === "AT_DropColumn") {
      const colname = cmd["name"];
      if (typeof colname !== "string" || colname.length === 0) {
        throw new Error(
          `"alter table public.${table} drop column" has no readable column name.`,
        );
      }
      changes.push({ table, drop: colname });
    }
  }
  return changes;
}

/**
 * Every public table's final column set after replaying every migration in
 * order.
 */
async function extractSchemaColumns(): Promise<{
  tables: Map<string, Set<string>>;
  createCount: number;
  alterCount: number;
}> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const tables = new Map<string, Set<string>>();
  let createCount = 0;
  let alterCount = 0;

  for (const name of files) {
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    const result = await parse(sql);

    for (const wrapper of result.stmts as StmtWrapper[]) {
      const stmt = wrapper.stmt;
      if (!stmt) continue;

      const created = columnsFromCreateTable(stmt);
      if (created) {
        if (tables.has(created.table)) {
          throw new Error(`public.${created.table} is created more than once across the migrations.`);
        }
        tables.set(created.table, new Set(created.columns));
        createCount += 1;
        continue;
      }

      for (const change of columnChangesFromAlterTable(stmt)) {
        const set = tables.get(change.table);
        if (!set) {
          throw new Error(
            `"alter table public.${change.table}" appeared before any ` +
              `"create table public.${change.table}" this walker recognised.`,
          );
        }
        if (change.add !== undefined) {
          set.add(change.add);
          alterCount += 1;
        }
        if (change.drop !== undefined) {
          set.delete(change.drop);
          alterCount += 1;
        }
      }
    }
  }

  return { tables, createCount, alterCount };
}

describe("seed generator columns vs. the Postgres migrations", () => {
  it("keeps every table's generated column list in sync with its migrations", async () => {
    const { tables: schemaColumns, createCount, alterCount } = await extractSchemaColumns();

    // A parser or walker that silently matched nothing must not let this test
    // pass by comparing two empty sets. The migrations create at least the 14
    // tables the generator writes, and at least one of them (mentions) has
    // gained columns via `alter table ... add column` since its creation.
    expect(createCount).toBeGreaterThanOrEqual(Object.keys(SEED_TABLE_COLUMNS).length);
    expect(alterCount).toBeGreaterThan(0);

    for (const [table, generatedKeys] of Object.entries(SEED_TABLE_COLUMNS)) {
      const realColumns = schemaColumns.get(table);
      expect(realColumns, `no migration ever creates public.${table}`).toBeDefined();

      const generated = new Set(generatedKeys.map(columnName));
      const excluded = new Set(SEED_COLUMN_EXCLUSIONS[table] ?? []);
      const excludedColumns = new Set([...excluded].map(columnName));

      // Direction 1: every real column is either generated or a documented
      // exclusion. This is the bug hit three times — a column that is
      // neither is a silent gap in supabase/seed.sql.
      for (const column of realColumns ?? []) {
        const covered = generated.has(column) || excludedColumns.has(column);
        expect(
          covered,
          `public.${table}.${column} exists in the migrations but generate-seed-sql.ts ` +
            `neither writes it nor excludes it in SEED_COLUMN_EXCLUSIONS. Add it to one.`,
        ).toBe(true);
      }

      // Direction 2: the generator never claims a column that does not
      // exist — a rename or drop the generator's list was never updated for.
      for (const column of generated) {
        expect(
          realColumns?.has(column),
          `generate-seed-sql.ts writes public.${table}.${column}, but no migration defines it.`,
        ).toBe(true);
      }

      // The allowlist itself must stay honest: every exclusion must name a
      // real column (a typo there would silently exclude nothing), and must
      // not name a column the generator also writes (a stale exclusion left
      // behind after the column was actually wired up).
      for (const column of excludedColumns) {
        expect(
          realColumns?.has(column),
          `SEED_COLUMN_EXCLUSIONS["${table}"] lists "${column}", which is not a real column.`,
        ).toBe(true);
        expect(
          generated.has(column),
          `SEED_COLUMN_EXCLUSIONS["${table}"] lists "${column}", but generate-seed-sql.ts ` +
            `also writes it — remove the now-stale exclusion.`,
        ).toBe(false);
      }
    }
  });

  /**
   * The same bug class one layer down.
   *
   * Both seed loaders write an idempotent upsert, and both hard-coded `id` as
   * the conflict target — a silent, table-shaped assumption that `db:validate`
   * cannot catch, because `on conflict (id) do nothing` is valid *syntax*
   * against any table. It fails only when the statement reaches a real
   * Postgres, which is exactly how `organization_onboarding` (keyed on
   * `organization_id`, with no surrogate id) broke the first `supabase db
   * reset` these migrations were ever run against.
   */
  it("gives every seeded table a conflict target that is a real column", async () => {
    const { tables: schemaColumns } = await extractSchemaColumns();

    for (const table of Object.keys(SEED_TABLE_COLUMNS)) {
      const realColumns = schemaColumns.get(table);
      expect(realColumns, `no migration ever creates public.${table}`).toBeDefined();

      const target = conflictTarget(table);
      expect(
        realColumns?.has(target),
        `the seed loaders upsert public.${table} on "${target}", which is not a ` +
          `real column. Add an entry to SEED_CONFLICT_TARGETS.`,
      ).toBe(true);
    }
  });

  it("keeps the conflict-target overrides honest", async () => {
    const { tables: schemaColumns } = await extractSchemaColumns();

    for (const [table, column] of Object.entries(SEED_CONFLICT_TARGETS)) {
      expect(
        SEED_TABLE_COLUMNS,
        `SEED_CONFLICT_TARGETS names "${table}", which is not a seeded table.`,
      ).toHaveProperty(table);

      // An override that names `id` is either wrong or redundant — `id` is
      // already the default, so listing it hides a table that genuinely has
      // no surrogate key behind one that does.
      expect(
        column,
        `SEED_CONFLICT_TARGETS["${table}"] is "id", which is the default. Remove it.`,
      ).not.toBe("id");

      const real = schemaColumns.get(table);
      expect(
        real?.has(columnName(column)),
        `SEED_CONFLICT_TARGETS["${table}"] names "${column}", which is not a real column.`,
      ).toBe(true);
    }
  });
});
