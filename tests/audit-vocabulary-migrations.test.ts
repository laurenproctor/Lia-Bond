import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "libpg-query";
import { describe, expect, it } from "vitest";
import { AUDIT_ENTITY_TYPES, AUDIT_EVENT_TYPES, GATE_REJECTION_REASONS } from "@/domain/enums";

/**
 * Pins the TypeScript closed lists against the Postgres constraints that are
 * supposed to mirror them.
 *
 * `AUDIT_EVENT_TYPES` and `AUDIT_ENTITY_TYPES` (`src/domain/enums.ts`) exist
 * so a typo in an audit event is a compile error, not a bad row. The demo
 * data source enforces neither list — it is a plain in-memory array — so
 * every test in this suite can add a value to one side of the mirror and
 * still pass, right up until a Supabase-mode write throws `23514` in
 * production. This happened twice: Task 10's review flagged the risk, and
 * Task 11 hit it — three new event types with no matching migration. This
 * test makes that drift a build failure instead of a review-time discovery.
 *
 * It parses every migration with the real Postgres grammar (`libpg-query`,
 * the same library `scripts/validate-migrations.mjs` uses for `npm run
 * db:validate`) rather than a regex over the SQL text, and replays the
 * statements in the order Supabase applies them (lexicographic filename
 * order — the migrations are timestamp-prefixed) to arrive at the
 * constraint's and the enum's *final* permitted set, the same way Postgres
 * would after applying every migration in sequence.
 *
 * Deliberately strict rather than lenient: every extraction helper below
 * throws if it finds a matching statement whose shape it does not recognise,
 * rather than silently skipping it. A parser that can return an empty result
 * for a migration that actually changed the vocabulary would make this test
 * unable to fail, which is worse than not having it.
 */

const root = resolve(process.cwd());
const migrationsDir = join(root, "supabase", "migrations");

/** Every value in an object tree, depth-first, arrays included. */
function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node !== null && typeof node === "object") {
    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

interface ParsedFile {
  path: string;
  stmts: unknown;
}

async function parseMigrations(): Promise<ParsedFile[]> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const parsed: ParsedFile[] = [];
  for (const name of files) {
    const path = join(migrationsDir, name);
    const sql = readFileSync(path, "utf8");
    const result = await parse(sql);
    parsed.push({ path: name, stmts: result.stmts });
  }
  return parsed;
}

/**
 * Every `check (event_type in (...))` definition of `constraintName`, in the
 * order it appears in this file's statements.
 *
 * Each occurrence is a *replacement* of the constraint (the migrations drop
 * it and add it back with a longer list, or define it fresh in the initial
 * `create table`) — never additive — so the caller keeps only the last one
 * seen across all files.
 */
function extractCheckConstraintValueLists(
  stmts: unknown,
  constraintName: string,
): string[][] {
  const found: string[][] = [];

  walk(stmts, (node) => {
    const constraint = node["Constraint"] as Record<string, unknown> | undefined;
    if (
      !constraint ||
      constraint["contype"] !== "CONSTR_CHECK" ||
      constraint["conname"] !== constraintName
    ) {
      return;
    }

    const rawExpr = constraint["raw_expr"] as Record<string, unknown> | undefined;
    const aExpr = rawExpr?.["A_Expr"] as Record<string, unknown> | undefined;
    const items = (aExpr?.["rexpr"] as Record<string, unknown> | undefined)?.[
      "List"
    ] as Record<string, unknown> | undefined;
    const itemList = items?.["items"];

    if (aExpr?.["kind"] !== "AEXPR_IN" || !Array.isArray(itemList) || itemList.length === 0) {
      throw new Error(
        `Found a CHECK constraint named "${constraintName}" whose shape this parser does not ` +
          `recognise (expected "column in (...)"). Update extractCheckConstraintValueLists — ` +
          `do not let this pass silently.`,
      );
    }

    const values = itemList.map((item) => {
      const record = item as Record<string, unknown>;
      const aConst = record["A_Const"] as Record<string, unknown> | undefined;
      const sval = (aConst?.["sval"] as Record<string, unknown> | undefined)?.["sval"];
      if (typeof sval !== "string") {
        throw new Error(
          `A value in CHECK constraint "${constraintName}" was not a plain string literal. ` +
            `Update extractCheckConstraintValueLists.`,
        );
      }
      return sval;
    });

    found.push(values);
  });

  return found;
}

/** The initial `create type <name> as enum (...)` values, if this file defines it. */
function extractEnumCreation(stmts: unknown, typeName: string): string[][] {
  const found: string[][] = [];

  walk(stmts, (node) => {
    const createEnum = node["CreateEnumStmt"] as Record<string, unknown> | undefined;
    if (!createEnum) return;

    const name = enumTypeName(createEnum["typeName"]);
    if (name !== typeName) return;

    const vals = createEnum["vals"];
    if (!Array.isArray(vals) || vals.length === 0) {
      throw new Error(
        `Found "create type ${typeName} as enum (...)" with no values this parser could read. ` +
          `Update extractEnumCreation.`,
      );
    }

    found.push(
      vals.map((entry) => {
        const sval = (
          (entry as Record<string, unknown>)["String"] as Record<string, unknown> | undefined
        )?.["sval"];
        if (typeof sval !== "string") {
          throw new Error(`A value in "create type ${typeName}" was not a plain string.`);
        }
        return sval;
      }),
    );
  });

  return found;
}

/** Every `alter type <name> add value ... '<x>'` addition, in file order. */
function extractEnumAdditions(stmts: unknown, typeName: string): string[] {
  const found: string[] = [];

  walk(stmts, (node) => {
    const alterEnum = node["AlterEnumStmt"] as Record<string, unknown> | undefined;
    if (!alterEnum) return;

    const name = enumTypeName(alterEnum["typeName"]);
    if (name !== typeName) return;

    const newVal = alterEnum["newVal"];
    if (typeof newVal !== "string") {
      throw new Error(
        `Found "alter type ${typeName} add value" with no readable value. ` +
          `Update extractEnumAdditions.`,
      );
    }
    found.push(newVal);
  });

  return found;
}

function enumTypeName(typeName: unknown): string | null {
  if (!Array.isArray(typeName) || typeName.length === 0) return null;
  const last = typeName.at(-1) as Record<string, unknown> | undefined;
  const sval = (last?.["String"] as Record<string, unknown> | undefined)?.["sval"];
  return typeof sval === "string" ? sval : null;
}

/**
 * Asserts that a Postgres enum type's final permitted set — its initial
 * `create type ... as enum (...)` values plus every `alter type ... add
 * value` seen across the migrations, in file order — matches a TypeScript
 * closed list exactly (as sets; the migrations are append-only and ordered
 * for Postgres's sake, not readability, so order is not compared).
 *
 * Shared by every enum (as opposed to check-constraint) vocabulary this file
 * pins — `audit_events_known_event_type` stays separate above because it is
 * a CHECK constraint, not a `create type ... as enum`, and follows a
 * replace-not-append shape that doesn't fit this helper.
 */
async function expectEnumMatches(typeName: string, expected: readonly string[]): Promise<void> {
  const files = await parseMigrations();

  let base: string[] | null = null;
  const additions: string[] = [];

  for (const file of files) {
    const creations = extractEnumCreation(file.stmts, typeName);
    if (creations.length > 0) {
      if (base !== null) {
        throw new Error(`${typeName} was created more than once across the migrations.`);
      }
      base = creations[0] ?? null;
    }
    additions.push(...extractEnumAdditions(file.stmts, typeName));
  }

  expect(base).not.toBeNull();

  const final = new Set([...(base ?? []), ...additions]);
  expect(final).toEqual(new Set(expected));
}

describe("audit vocabulary vs. the Postgres migrations", () => {
  it("keeps audit_events_known_event_type in sync with AUDIT_EVENT_TYPES", async () => {
    const files = await parseMigrations();

    let current: string[] | null = null;
    let occurrences = 0;

    for (const file of files) {
      const lists = extractCheckConstraintValueLists(
        file.stmts,
        "audit_events_known_event_type",
      );
      occurrences += lists.length;
      if (lists.length > 0) {
        // A file may only redefine the constraint once; if it ever legitimately
        // redefined it twice the last one is what Postgres would end up with.
        current = lists.at(-1) ?? null;
      }
    }

    // A parser that silently found nothing must not report success — this
    // constraint is defined in the very first migration.
    expect(occurrences).toBeGreaterThan(0);
    expect(current).not.toBeNull();

    expect(new Set(current)).toEqual(new Set(AUDIT_EVENT_TYPES));
  });

  it("keeps audit_entity_type in sync with AUDIT_ENTITY_TYPES", async () => {
    await expectEnumMatches("audit_entity_type", AUDIT_ENTITY_TYPES);
  });

  // gate_rejection_reason is not an audit vocabulary, but it is the same class
  // of closed list with the same failure mode: a value added in TypeScript and
  // forgotten in the migrations type-checks perfectly and then violates an
  // enum constraint at runtime. It was outside this file's coverage for no
  // reason other than that nobody added it.
  it("keeps gate_rejection_reason in sync with GATE_REJECTION_REASONS", async () => {
    await expectEnumMatches("gate_rejection_reason", GATE_REJECTION_REASONS);
  });
});
