import { parse } from "libpg-query";
import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES } from "@/domain/enums";
import {
  AUDIT_EVENT_CONSTRAINT,
  buildAuditVocabularyLines,
  nextMigrationVersion,
} from "../scripts/generate-audit-vocabulary-sql.ts";

/**
 * Proves the generator's output says what it claims to say.
 *
 * `tests/audit-vocabulary-migrations.test.ts` guards the committed migrations;
 * this guards the thing that writes the next one. The two are deliberately
 * separate: that test would keep passing if this generator emitted a constraint
 * permitting the wrong set, right up until somebody ran it and committed the
 * result.
 *
 * The central assertion parses the emitted SQL with the real Postgres grammar
 * rather than matching its text, because the text is not the claim — a list of
 * quoted names inside `check (event_type in (...))` is only a vocabulary if
 * Postgres reads it as one. A regex would pass on SQL that does not parse.
 *
 * Imports the builder from `scripts/` with a relative path rather than `@/`,
 * which only resolves under `src/` — the same arrangement
 * `tests/matrix-parity-generated.test.ts` uses.
 */

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

/**
 * The names permitted by the `check (event_type in (...))` the SQL adds.
 *
 * Deliberately strict in the same way the migrations test is: an unrecognised
 * shape throws rather than yielding an empty list, because a parser that can
 * quietly return nothing makes the assertion below unable to fail.
 */
async function permittedEventNames(sql: string): Promise<string[]> {
  const result = await parse(sql);
  const found: string[][] = [];

  walk(result.stmts, (node) => {
    const constraint = node["Constraint"] as Record<string, unknown> | undefined;
    if (
      !constraint ||
      constraint["contype"] !== "CONSTR_CHECK" ||
      constraint["conname"] !== AUDIT_EVENT_CONSTRAINT
    ) {
      return;
    }

    const rawExpr = constraint["raw_expr"] as Record<string, unknown> | undefined;
    const aExpr = rawExpr?.["A_Expr"] as Record<string, unknown> | undefined;
    const items = (aExpr?.["rexpr"] as Record<string, unknown> | undefined)?.["List"] as
      | Record<string, unknown>
      | undefined;
    const itemList = items?.["items"];

    if (aExpr?.["kind"] !== "AEXPR_IN" || !Array.isArray(itemList)) {
      throw new Error(
        `The generator emitted a CHECK constraint whose shape this parser does not recognise ` +
          `(expected "event_type in (...)").`,
      );
    }

    found.push(
      itemList.map((item) => {
        const aConst = (item as Record<string, unknown>)["A_Const"] as
          | Record<string, unknown>
          | undefined;
        const sval = (aConst?.["sval"] as Record<string, unknown> | undefined)?.["sval"];
        if (typeof sval !== "string") {
          throw new Error("The generator emitted a non-literal in the event list.");
        }
        return sval;
      }),
    );
  });

  expect(found).toHaveLength(1);
  return found[0] as string[];
}

describe("generate-audit-vocabulary-sql", () => {
  it("emits a constraint permitting exactly AUDIT_EVENT_TYPES, in order", async () => {
    const sql = buildAuditVocabularyLines().join("\n") + "\n";

    // Order, not just membership: the array's grouping is what makes the diff
    // against the previous vocabulary migration readable.
    expect(await permittedEventNames(sql)).toEqual([...AUDIT_EVENT_TYPES]);
  });

  it("emits SQL the migration validator can parse", async () => {
    const sql = buildAuditVocabularyLines().join("\n") + "\n";

    // `npm run db:validate` parses every migration with this same library, so a
    // generated file that failed here would break the build for everyone.
    const result = await parse(sql);
    expect(Array.isArray(result.stmts)).toBe(true);
    expect((result.stmts as unknown[]).length).toBeGreaterThan(0);
  });

  it("drops the constraint before adding it back", () => {
    const sql = buildAuditVocabularyLines().join("\n");

    const dropAt = sql.indexOf(`drop constraint ${AUDIT_EVENT_CONSTRAINT}`);
    const addAt = sql.indexOf(`add constraint ${AUDIT_EVENT_CONSTRAINT}`);

    // Reversed, the migration would fail on an existing database: Postgres
    // refuses a second constraint of the same name.
    expect(dropAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(dropAt);
  });

  it("carries the derivation notice into the file itself", () => {
    const sql = buildAuditVocabularyLines().join("\n");

    // A reader who opens the migration and does not know it is generated is
    // exactly the person who would hand-edit it back into a stale copy.
    expect(sql).toContain("npm run audit:vocabulary:generate");
    expect(sql).toContain("Do not hand-edit");
  });

  it("uses the caller's reason as the opening line", () => {
    const lines = buildAuditVocabularyLines(["a.b"], { reason: "Add the widget events." });
    expect(lines[0]).toBe("-- Add the widget events.");
  });

  it("refuses names it cannot emit as string literals", () => {
    expect(() => buildAuditVocabularyLines(["it's.broken"])).toThrow(/string literal/);
    expect(() => buildAuditVocabularyLines([" padded.name"])).toThrow(/string literal/);
  });

  it("refuses a duplicate name", () => {
    expect(() => buildAuditVocabularyLines(["a.b", "a.b"])).toThrow(/twice/);
  });

  it("refuses an empty vocabulary", () => {
    // The constraint would be `event_type in ()`, which is a syntax error, but
    // the honest failure is that an empty audit vocabulary is never intended.
    expect(() => buildAuditVocabularyLines([])).toThrow(/empty/);
  });

  describe("nextMigrationVersion", () => {
    const day = new Date(Date.UTC(2026, 7, 20));

    it("steps in hundreds from the highest version that day", () => {
      const existing = [
        "20260819000900_other.sql",
        "20260820000100_review_widget.sql",
        "20260820000300_review_widget_audit_vocabulary.sql",
      ];
      expect(nextMigrationVersion(existing, day)).toBe("20260820000400");
    });

    it("starts at 000100 on a day with no migrations", () => {
      expect(nextMigrationVersion(["20260819000900_other.sql"], day)).toBe("20260820000100");
    });

    it("ignores a different day's higher sequence", () => {
      // Versions sort lexicographically as whole strings, so a later day with a
      // lower sequence still sorts last. Only the same day's numbers matter.
      expect(nextMigrationVersion(["20260821009900_later.sql"], day)).toBe("20260820000100");
    });
  });
});
