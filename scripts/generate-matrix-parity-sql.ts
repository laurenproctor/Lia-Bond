/**
 * Renders `supabase/tests/matrix-parity.generated.sql` from
 * `src/lib/rules/transitions.ts`.
 *
 * `transitions.ts` is the single TypeScript source of truth for the Phase 2
 * automation transition matrix (spec §7). The G1 execution RPC restates the
 * same matrix in SQL, in
 * `supabase/migrations/20260812000400_automation_transition_functions.sql`.
 * Generating the parity assertions from `transitions.ts` — rather than
 * hand-writing them — is what stops the SQL restatement and the TypeScript
 * original from silently drifting apart; `tests/matrix-parity-generated.test.ts`
 * fails the build the moment the committed file no longer matches what this
 * script would produce.
 *
 * `buildMatrixParityLines()` is exported (rather than only run as a CLI) so
 * the drift test can call the exact same code the CLI does, without
 * importing a module whose evaluation has the side effect of writing a file
 * — see `scripts/seed-sql-columns.ts`'s header for why that split matters.
 *
 * Run with: npm run matrix:parity:generate
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Resolved by scripts/tsconfig-paths-hook.mjs, which the npm script preloads.
import { MENTION_STATUSES, RISK_LEVELS, type MentionStatus, type RiskLevel } from "@/domain";
import { decideEscalate, decideSetStatus, type TransitionDecision } from "@/lib/rules/transitions";

/** The SQL functions' text result for a decision: `apply`, `no_op`, or a blocked code. */
function expectedOutcome(decision: TransitionDecision): string {
  switch (decision.kind) {
    case "apply":
      return "apply";
    case "no_op":
      return "no_op";
    case "blocked":
      return decision.code;
  }
}

function setStatusLine(current: MentionStatus, target: MentionStatus, risk: RiskLevel): string {
  const expected = expectedOutcome(decideSetStatus(current, target, risk));
  return (
    `select pg_temp.check('set_status ${current}->${target}@${risk}', ` +
    `public.automation_set_status_decision('${current}','${target}','${risk}') = '${expected}');`
  );
}

function escalateLine(current: MentionStatus): string {
  const expected = expectedOutcome(decideEscalate(current));
  return (
    `select pg_temp.check('escalate from ${current}', ` +
    `public.automation_escalate_decision('${current}') = '${expected}');`
  );
}

/**
 * Every line of `supabase/tests/matrix-parity.generated.sql`, in order.
 *
 * The committed file is exactly `buildMatrixParityLines().join("\n") + "\n"`
 * — `tests/matrix-parity-generated.test.ts` asserts this byte-for-byte, so
 * this function owns the whole file (header comment, `begin`/`rollback`
 * wrapper, and every check), not just the generated checks.
 */
export function buildMatrixParityLines(): string[] {
  const lines: string[] = [
    "-- GENERATED FILE — do not edit by hand.",
    "-- Source: src/lib/rules/transitions.ts",
    "-- Regenerate: npm run matrix:parity:generate",
    "--",
    "-- Asserts, cell for cell, that public.automation_set_status_decision and",
    "-- public.automation_escalate_decision",
    "-- (supabase/migrations/20260812000400_automation_transition_functions.sql)",
    "-- agree with decideSetStatus/decideEscalate in transitions.ts — the",
    "-- Phase 2 automation transition matrix (spec §7).",
    "--",
    "-- pg_temp.check(label, condition) is defined by the database test",
    "-- harness this file is included into; this file only calls it.",
    "",
    "begin;",
    "",
  ];

  // 324 set_status checks: MENTION_STATUSES x MENTION_STATUSES x RISK_LEVELS.
  for (const current of MENTION_STATUSES) {
    for (const target of MENTION_STATUSES) {
      for (const risk of RISK_LEVELS) {
        lines.push(setStatusLine(current, target, risk));
      }
    }
  }

  // 9 escalate checks: one per mention status.
  for (const current of MENTION_STATUSES) {
    lines.push(escalateLine(current));
  }

  lines.push("", "rollback;");

  return lines;
}

function isMain(): boolean {
  if (process.argv[1] === undefined) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMain()) {
  const lines = buildMatrixParityLines();
  const outputPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../supabase/tests/matrix-parity.generated.sql",
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");

  console.log(`Wrote ${outputPath} (${lines.length} lines).`);
}
