import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMatrixParityLines } from "../scripts/generate-matrix-parity-sql.ts";

/**
 * Pins the committed `supabase/tests/matrix-parity.generated.sql` against
 * what `npm run matrix:parity:generate` would produce right now.
 *
 * `buildMatrixParityLines()` derives every assertion in that file from
 * `decideSetStatus`/`decideEscalate` in `src/lib/rules/transitions.ts` — the
 * TypeScript source of truth for the Phase 2 automation transition matrix.
 * Nothing stops the committed SQL from drifting the moment `transitions.ts`
 * changes and someone forgets to re-run the generator; the SQL would still
 * parse, `db:validate` would still pass, and the drift would only surface if
 * a database happened to run this file. This test makes that drift a build
 * failure instead, the same shape of gap `tests/seed-generator-columns.test.ts`
 * and `tests/audit-vocabulary-migrations.test.ts` close for the seed and the
 * audit vocabulary respectively.
 *
 * Imports the builder straight from the script with a relative path, rather
 * than `@/`, because `scripts/` sits outside `src/` and the `@/` alias only
 * resolves under it (see `tests/seed-generator-columns.test.ts`, which
 * imports `scripts/seed-sql-columns.ts` the same way). Importing the builder
 * — not running the CLI — means this test never touches the filesystem
 * beyond reading the committed file.
 */
describe("matrix-parity.generated.sql", () => {
  it("matches what buildMatrixParityLines() produces right now", () => {
    const committedPath = resolve(
      process.cwd(),
      "supabase/tests/matrix-parity.generated.sql",
    );
    const committed = readFileSync(committedPath, "utf8");

    const expected = buildMatrixParityLines().join("\n") + "\n";

    expect(committed).toBe(expected);
  });
});
