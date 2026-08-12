-- Add response-generation vocabulary for approval outcomes (Task 4 of the
-- response-generation plan).
--
-- The audit-literal half of this vocabulary change shipped early in
-- 20260812000700_response_generation_audit_vocabulary.sql (the TS↔SQL
-- drift-guard test forced it there). This migration carries the remaining
-- piece: the SQL enum type that applications write to.
--
-- `changes_requested` is the live decision outcome (Task 1 spec): choosing
-- "changes_requested" returns a draft to editable `draft` status instead of
-- terminating it, which `rejected` never did. `rejected` stays in this enum
-- for historical data — existing rows still carry it — but nothing writes it
-- going forward. The TS vocabulary in `src/domain/enums.ts` already includes
-- `changes_requested` (Task 1 added it).

alter type approval_status add value 'changes_requested';

-- Rollback note: Postgres enums cannot have values removed. Rollback is
-- "stop emitting it" (application revert) — application code must treat this
-- as irreversible.
