#!/usr/bin/env bash
#
# Deterministic, bounded concurrency proofs for the execution path.
#
# The four races below are not load tests and nothing here sleeps and hopes.
# Two psql sessions are driven statement by statement over FIFOs, so the
# interleaving is chosen rather than observed: session A opens a transaction
# and HOLDS it, session B is pushed into the exact conflict, and only then is A
# released. Every outcome is therefore reproducible.
#
#   1. Sweep claim from an empty state   -> one running row, one winner
#   2. Stale-lease takeover               -> exactly one takeover, no double owner
#   3. The execution unit                 -> one row, one case, ONE transition
#   4. Occurrence recording               -> one row, one created=true
#
# Rails, because a race harness that hangs is worse than one that fails:
#   * every session opens with statement_timeout = 10s and lock_timeout = 10s
#   * every round runs under a 60s watchdog that TERMs the script
#   * `trap cleanup EXIT INT TERM` closes the FIFOs (which rolls back any held
#     transaction, since the backend aborts when its client disappears), drops
#     the test trigger and scratch tables, and deletes the whole race
#     organization
#
# Unlike supabase/tests/execution-verification.sql, these transactions COMMIT —
# that is the point — so the fixtures live in their own throwaway organization
# (slug `race-harness-*`) which cleanup removes row by row, in dependency
# order, whatever happens.
#
# Usage:  bash scripts/execution-race-test.sh
#         (SUPABASE_DB_URL is honoured; the local stack's URL is the default.)

set -uo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/execution-race.XXXXXX")"
MAIN_PID=$$
ROUND="startup"
WATCHDOG=""
CLEANED=0
PID_A=""
PID_B=""
FAILURES=0

say()  { printf '%s\n' "$*"; }
ok()   { printf 'ok: %s\n' "$*"; }
fail() { printf 'RACE CHECK FAILED [%s]: %s\n' "$ROUND" "$*" >&2; FAILURES=$((FAILURES + 1)); }

check() { # check <condition-result> <label>   (0 = held)
  if [ "$1" -eq 0 ]; then ok "$2"; else fail "$2"; fi
}

# --------------------------------------------------------------------------
# psql helpers
# --------------------------------------------------------------------------

q() { # one-shot query, unaligned single value
  psql "$DB_URL" -X -q -A -t -c "$1" 2>>"$WORK/oneshot.log"
}

runsql() { # one-shot script file
  psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$1" >>"$WORK/oneshot.log" 2>&1
}

# --------------------------------------------------------------------------
# Cleanup — runs on every exit path, including the watchdog's TERM.
# --------------------------------------------------------------------------

cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  [ -n "$WATCHDOG" ] && kill "$WATCHDOG" 2>/dev/null
  # Closing the write end lets each psql see EOF and exit; a session still
  # inside a transaction has it aborted by the backend when the client goes.
  #
  # The braces are load-bearing. `exec 7>&- 2>/dev/null` is `exec` with
  # redirections and no command, which applies BOTH to the shell permanently —
  # so it would silence stderr for the whole of the rest of cleanup, including
  # the residue report below. Scoping the 2>/dev/null to a group keeps the
  # closes (which are what we want to persist) and drops the silencing.
  { exec 7>&-; exec 8>&-; } 2>/dev/null
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null
  wait 2>/dev/null

  cat > "$WORK/cleanup.sql" <<'SQL'
do $$
declare v_org uuid;
begin
  for v_org in select id from public.organizations where slug like 'race-harness-%' loop
    delete from public.audit_events              where organization_id = v_org;
    delete from public.automation_rule_executions where organization_id = v_org;
    delete from public.escalations               where organization_id = v_org;
    delete from public.mention_analyses          where organization_id = v_org;
    delete from public.analysis_runs             where organization_id = v_org;
    delete from public.mentions                  where organization_id = v_org;
    delete from public.automation_sweeps         where organization_id = v_org;
    delete from public.automation_rules          where organization_id = v_org;
    delete from public.locations                 where organization_id = v_org;
    delete from public.platform_connections      where organization_id = v_org;
    delete from public.organizations             where id = v_org;
  end loop;
end $$;
drop trigger  if exists race_transition_guard on public.mentions;
drop function if exists public.race_record_transition();
drop table    if exists public.race_transitions;
drop table    if exists public.race_fixture;
SQL
  psql "$DB_URL" -X -q -f "$WORK/cleanup.sql" >>"$WORK/oneshot.log" 2>&1

  # Residue is a failure, not a warning: these races COMMIT, so a fixture that
  # survives poisons every later run of the harness (and the seed the rest of
  # the suite assumes). Reported through `fail` and then forced into the exit
  # status — cleanup runs from the EXIT trap, after the script has already
  # chosen its status, so incrementing FAILURES alone would change nothing.
  local leftovers
  leftovers="$(q "select count(*) from public.organizations where slug like 'race-harness-%'")"
  if [ "${leftovers:-0}" != "0" ]; then
    fail "$leftovers race-harness organization(s) survived cleanup"
    rm -rf "$WORK"
    exit 1
  fi
  rm -rf "$WORK"
}

trap 'cleanup' EXIT
trap 'printf "\ninterrupted\n" >&2; cleanup; exit 130' INT TERM

# --------------------------------------------------------------------------
# Round bounds — a 60s watchdog per round, cancelled when the round ends.
# --------------------------------------------------------------------------

round() {
  ROUND="$1"
  say ""
  say "== round: $ROUND"
  ( sleep 60
    printf 'TIMEOUT: round %s exceeded 60s\n' "$ROUND" >&2
    kill -TERM "$MAIN_PID" 2>/dev/null ) &
  WATCHDOG=$!
}

endround() {
  [ -n "$WATCHDOG" ] && kill "$WATCHDOG" 2>/dev/null
  WATCHDOG=""
}

# --------------------------------------------------------------------------
# Session plumbing.
#
# Each session is a psql reading from a FIFO we hold open, so statements can be
# fed one at a time. `\o <file>` captures a step's result and `\! touch <file>`
# is the handshake: psql runs it only after everything before it has finished,
# so a step whose marker never appears is a step that is BLOCKED — which is
# exactly what races 1, 3 and 4 need to be able to observe.
# --------------------------------------------------------------------------

open_a() {
  mkfifo "$WORK/a.in"
  : > "$WORK/a.log"
  psql "$DB_URL" -X -q -A -t -f "$WORK/a.in" >>"$WORK/a.log" 2>&1 &
  PID_A=$!
  exec 7>"$WORK/a.in"
  printf "%s\n" "set statement_timeout = '10s'; set lock_timeout = '10s';" >&7
}

open_b() {
  mkfifo "$WORK/b.in"
  : > "$WORK/b.log"
  psql "$DB_URL" -X -q -A -t -f "$WORK/b.in" >>"$WORK/b.log" 2>&1 &
  PID_B=$!
  exec 8>"$WORK/b.in"
  printf "%s\n" "set statement_timeout = '10s'; set lock_timeout = '10s';" >&8
}

step_a() { # step_a <marker> <sql...>
  local marker="$1"; shift
  rm -f "$WORK/a.$marker.done" "$WORK/a.$marker.out"
  printf '\\o %s\n' "$WORK/a.$marker.out" >&7
  printf '%s\n' "$*" >&7
  printf '\\o\n' >&7
  printf '\\! touch %s\n' "$WORK/a.$marker.done" >&7
}

step_b() {
  local marker="$1"; shift
  rm -f "$WORK/b.$marker.done" "$WORK/b.$marker.out"
  printf '\\o %s\n' "$WORK/b.$marker.out" >&8
  printf '%s\n' "$*" >&8
  printf '\\o\n' >&8
  printf '\\! touch %s\n' "$WORK/b.$marker.done" >&8
}

await() { # await <file> <seconds>  -> 0 if it appeared
  local f="$1" limit="${2:-15}" i=0
  while [ ! -e "$f" ]; do
    sleep 0.05
    i=$((i + 1))
    if [ "$i" -gt $((limit * 20)) ]; then return 1; fi
  done
  return 0
}

await_a() { await "$WORK/a.$1.done" "${2:-15}"; }
await_b() { await "$WORK/b.$1.done" "${2:-15}"; }

out_a() { tr -d ' \n' < "$WORK/a.$1.out" 2>/dev/null; }
out_b() { tr -d ' \n' < "$WORK/b.$1.out" 2>/dev/null; }

# Poll pg_stat_activity until a session is provably parked on a lock.
await_blocked() { # await_blocked <query fragment> <seconds>
  local frag="$1" limit="${2:-10}" i=0 n
  while :; do
    n="$(q "select count(*) from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and query ilike '%${frag}%'")"
    [ "${n:-0}" -ge 1 ] && return 0
    sleep 0.05
    i=$((i + 1))
    if [ "$i" -gt $((limit * 20)) ]; then return 1; fi
  done
}

# No error lines in the transcript.
#
# The pattern has to allow a prefix. Sessions are fed with `psql -f <fifo>`,
# and in file mode psql labels every diagnostic `psql:<path>:<line>: ERROR: …`
# rather than starting the line with ERROR — so an anchored '^ERROR' matches
# nothing a session can actually produce and the check passes for free. Both
# shapes are accepted: `: ERROR:` for the file-mode prefix, `^ERROR:` for the
# bare form.
session_clean() {
  local who="$1" hit
  hit="$(grep -m1 -E '(^|: )ERROR:' "$WORK/$who.log" 2>/dev/null)"
  if [ -n "$hit" ]; then
    fail "session $who reported an error: $hit"
    return 1
  fi
  return 0
}

both_clean() {
  local rc=0
  session_clean a || rc=1
  session_clean b || rc=1
  [ "$rc" -eq 0 ] && ok "$1"
  return "$rc"
}

# --------------------------------------------------------------------------
# Fixtures: one throwaway organization, everything the four races need.
# --------------------------------------------------------------------------

round "setup"

cat > "$WORK/setup.sql" <<'SQL'
create table public.race_fixture (slot text primary key, value uuid);

-- Session-crossing scratch table for race 3: a real table, because two
-- different backends write to it.
create table public.race_transitions (
  id bigserial primary key,
  mention_id uuid not null,
  new_status text not null,
  at timestamptz not null default now()
);

create function public.race_record_transition()
returns trigger language plpgsql as $fn$
begin
  if new.status is distinct from old.status then
    insert into public.race_transitions (mention_id, new_status)
    values (new.id, new.status::text);
  end if;
  return new;
end $fn$;

create trigger race_transition_guard
  after update on public.mentions
  for each row execute function public.race_record_transition();

do $$
declare
  v_org uuid; v_conn uuid; v_loc uuid;
  v_rule uuid; v_run uuid;
  v_m_exec uuid; v_o_exec uuid;
  v_m_rec uuid; v_run_rec uuid;
  v_sweep_a uuid; v_sweep_b uuid;
begin
  insert into public.organizations (name, slug, industry)
  values ('Race harness', 'race-harness-' || substr(gen_random_uuid()::text, 1, 12),
          'restaurants')
  returning id into v_org;

  insert into public.platform_connections (organization_id, platform)
  values (v_org, 'google_business_profile') returning id into v_conn;

  insert into public.locations
      (organization_id, name, slug, address_line1, city, region, postal_code,
       country_code, timezone, status)
  values (v_org, 'Race House', 'race-house', '1 Race Street', 'New York', 'NY',
          '10001', 'US', 'America/New_York', 'active')
  returning id into v_loc;

  insert into public.automation_rules (organization_id, name, status, actions)
  values (v_org, 'race escalate', 'active',
          '[{"type": "escalate", "assigneeUserId": null}]'::jsonb)
  returning id into v_rule;

  -- Completed, because analysis_runs_one_active allows one running run per
  -- organization and race 4 needs a run id it can record against freely.
  insert into public.analysis_runs (organization_id, status, completed_at)
  values (v_org, 'completed', now()) returning id into v_run;
  insert into public.analysis_runs (organization_id, status, completed_at)
  values (v_org, 'completed', now()) returning id into v_run_rec;

  -- Race 3's subject: analysed and high risk, so `escalate` applies.
  insert into public.mentions
      (organization_id, location_id, platform_connection_id, source_type,
       external_id, content, published_at, status, risk_level)
  values (v_org, v_loc, v_conn, 'google_review', 'race-exec-' || gen_random_uuid()::text,
          'race fixture', now(), 'analyzed', 'high')
  returning id into v_m_exec;

  select analysis_id into v_o_exec from public.record_analysis_occurrence(
    v_org, v_m_exec, v_run, 'anthropic', 'claude-race', 'v1', 0.800, 'relevant',
    'negative'::sentiment, -0.600, 'high'::risk_level,
    array['food_safety']::escalation_category[], 'risky', array['race']::text[],
    array[]::text[], 'escalate'::recommended_action, 'escalate it', now());
  update public.mention_analyses set outcome_applied_at = now() where id = v_o_exec;

  -- Race 4's subject: nothing recorded against it yet.
  insert into public.mentions
      (organization_id, location_id, platform_connection_id, source_type,
       external_id, content, published_at, status, risk_level)
  values (v_org, v_loc, v_conn, 'google_review', 'race-rec-' || gen_random_uuid()::text,
          'race fixture', now(), 'new', 'high')
  returning id into v_m_rec;

  -- Two completed sweeps: race 3's two callers arrive under different sweeps
  -- (which is what makes origin-vs-attempt observable), and only RUNNING
  -- sweeps are restricted to one per organization.
  insert into public.automation_sweeps (organization_id, mode, status, completed_at)
  values (v_org, 'apply', 'completed', now()) returning id into v_sweep_a;
  insert into public.automation_sweeps (organization_id, mode, status, completed_at)
  values (v_org, 'apply', 'completed', now()) returning id into v_sweep_b;

  insert into public.race_fixture (slot, value) values
    ('org', v_org), ('rule', v_rule),
    ('mention_exec', v_m_exec), ('occurrence_exec', v_o_exec),
    ('mention_rec', v_m_rec), ('run_rec', v_run_rec),
    ('sweep_a', v_sweep_a), ('sweep_b', v_sweep_b);
end $$;
SQL

if ! runsql "$WORK/setup.sql"; then
  say "setup failed:"
  cat "$WORK/oneshot.log" >&2
  exit 1
fi

ORG="$(q "select value from public.race_fixture where slot = 'org'")"
RULE="$(q "select value from public.race_fixture where slot = 'rule'")"
M_EXEC="$(q "select value from public.race_fixture where slot = 'mention_exec'")"
O_EXEC="$(q "select value from public.race_fixture where slot = 'occurrence_exec'")"
M_REC="$(q "select value from public.race_fixture where slot = 'mention_rec'")"
RUN_REC="$(q "select value from public.race_fixture where slot = 'run_rec'")"
SWEEP_A="$(q "select value from public.race_fixture where slot = 'sweep_a'")"
SWEEP_B="$(q "select value from public.race_fixture where slot = 'sweep_b'")"

if [ -z "$ORG" ]; then
  say "setup produced no organization id"
  cat "$WORK/oneshot.log" >&2
  exit 1
fi
ok "fixtures built in throwaway organization $ORG"

open_a
open_b
ok "two sessions open, each with statement_timeout = 10s and lock_timeout = 10s"
endround

# --------------------------------------------------------------------------
# Race 1 — two sweep claims from an empty state.
#
# A inserts the running row and holds. B finds no running sweep (A's insert is
# invisible to it) and tries to insert its own, which parks on
# automation_sweeps_one_running until A commits. B then absorbs the unique
# violation and reports A's sweep back as a normal, unclaimed outcome.
# --------------------------------------------------------------------------

round "1 — sweep claim from an empty state"

step_a r1 "begin; select (sweep).id::text || ':' || claimed::text from public.claim_automation_sweep('$ORG', 'apply');"
if ! await_a r1; then fail "session A never returned from its claim"; fi

step_b r1 "begin; select (sweep).id::text || ':' || claimed::text from public.claim_automation_sweep('$ORG', 'apply');"
if await_blocked "claim_automation_sweep" 10; then
  ok "session B is parked on a lock while A holds its transaction"
else
  fail "session B never blocked — the race did not happen"
fi

step_a r1commit "commit;"
await_a r1commit || fail "session A could not commit"

if await_b r1 10; then ok "session B returned once A committed"; else fail "session B never returned"; fi
step_b r1commit "commit;"
await_b r1commit || fail "session B could not commit"

A1="$(out_a r1)"; B1="$(out_b r1)"
A1_ID="${A1%%:*}"; A1_CLAIMED="${A1##*:}"
B1_ID="${B1%%:*}"; B1_CLAIMED="${B1##*:}"

[ "$A1_CLAIMED" = "true" ] && [ "$B1_CLAIMED" = "false" ]
check $? "exactly one session claimed the sweep (A=$A1_CLAIMED, B=$B1_CLAIMED)"
[ -n "$A1_ID" ] && [ "$A1_ID" = "$B1_ID" ]
check $? "the loser was handed the winner's sweep, not a second one"
[ "$(q "select count(*) from public.automation_sweeps where organization_id = '$ORG' and status = 'running'")" = "1" ]
check $? "exactly one running sweep exists"
both_clean "neither session errored"
endround

# --------------------------------------------------------------------------
# Race 2 — a stale lease, taken over exactly once.
#
# Race 1's winner is backdated past the 30-minute lease. Both sessions now
# want to take it over. A locks the stale row FOR UPDATE and finalizes it; B
# blocks on that row lock, re-qualifies it after A commits (it is no longer
# `running`), falls through to its own insert, and loses to A's new row.
# --------------------------------------------------------------------------

round "2 — stale-lease takeover"

q "update public.automation_sweeps set started_at = now() - interval '35 minutes'
    where organization_id = '$ORG' and status = 'running'" > /dev/null

step_a r2 "begin; select (sweep).id::text || ':' || claimed::text from public.claim_automation_sweep('$ORG', 'apply');"
await_a r2 || fail "session A never returned from its takeover claim"

step_b r2 "begin; select (sweep).id::text || ':' || claimed::text from public.claim_automation_sweep('$ORG', 'apply');"
if await_blocked "claim_automation_sweep" 10; then
  ok "session B is parked on the stale sweep's row lock"
else
  fail "session B never blocked on the stale row"
fi

step_a r2commit "commit;"
await_a r2commit || fail "session A could not commit"
await_b r2 10 || fail "session B never returned"
step_b r2commit "commit;"
await_b r2commit || fail "session B could not commit"

A2="$(out_a r2)"; B2="$(out_b r2)"
A2_ID="${A2%%:*}"; A2_CLAIMED="${A2##*:}"
B2_ID="${B2%%:*}"; B2_CLAIMED="${B2##*:}"

[ "$A2_CLAIMED" = "true" ] && [ "$B2_CLAIMED" = "false" ]
check $? "exactly one takeover happened (A=$A2_CLAIMED, B=$B2_CLAIMED)"
[ -n "$A2_ID" ] && [ "$A2_ID" = "$B2_ID" ]
check $? "no double owner — both sessions name the same new sweep"
[ "$A2_ID" != "$A1_ID" ]
check $? "the takeover really did open a new sweep"
[ "$(q "select count(*) from public.automation_sweeps where organization_id = '$ORG' and status = 'running'")" = "1" ]
check $? "still exactly one running sweep"
[ "$(q "select count(*) from public.automation_sweeps where id = '$A1_ID' and status = 'failed' and error_code = 'lease_expired'")" = "1" ]
check $? "the stale sweep was finalized as failed/lease_expired"
both_clean "neither session errored"
endround

# Leave no running sweep behind: races 3 and 4 do not want the lease.
q "update public.automation_sweeps set status = 'completed', completed_at = now()
    where organization_id = '$ORG' and status = 'running'" > /dev/null

# --------------------------------------------------------------------------
# Race 3 — two callers, one execution unit.
#
# Both name the same (rule, revision, mention, occurrence, mode). A's claim
# insert holds the idempotency key; B's insert parks on it, and once A commits
# B's `on conflict do nothing` resolves to nothing, so B re-reads A's finished
# row and returns it untouched. The trigger installed in setup records every
# status change on `mentions`, so "exactly one transition to escalated" is a
# measurement rather than an inference.
# --------------------------------------------------------------------------

round "3 — one execution unit, two callers"

step_a r3 "begin; select id::text || ':' || status || ':' || attempt_count::text from public.execute_automation_rule('$ORG', '$SWEEP_A', '$RULE', 1, '$M_EXEC', '$O_EXEC');"
await_a r3 || fail "session A never returned from the unit"

step_b r3 "begin; select id::text || ':' || status || ':' || attempt_count::text from public.execute_automation_rule('$ORG', '$SWEEP_B', '$RULE', 1, '$M_EXEC', '$O_EXEC');"
if await_blocked "execute_automation_rule" 10; then
  ok "session B is parked on the idempotency key while A holds its transaction"
else
  fail "session B never blocked on the claim"
fi

step_a r3commit "commit;"
await_a r3commit || fail "session A could not commit"
await_b r3 10 || fail "session B never returned"
step_b r3commit "commit;"
await_b r3commit || fail "session B could not commit"

A3="$(out_a r3)"; B3="$(out_b r3)"
A3_ID="$(printf '%s' "$A3" | cut -d: -f1)"
B3_ID="$(printf '%s' "$B3" | cut -d: -f1)"
B3_ATTEMPT="$(printf '%s' "$B3" | cut -d: -f3)"

[ -n "$A3_ID" ] && [ "$A3_ID" = "$B3_ID" ]
check $? "both sessions returned the same execution id"
[ "$B3_ATTEMPT" = "1" ]
check $? "attempt_count is still 1 — the loser replayed, it did not retry"
[ "$(q "select count(*) from public.automation_rule_executions where mention_id = '$M_EXEC'")" = "1" ]
check $? "exactly one execution row"
[ "$(q "select count(*) from public.escalations where mention_id = '$M_EXEC'")" = "1" ]
check $? "exactly one escalation"
[ "$(q "select count(*) from public.race_transitions where mention_id = '$M_EXEC' and new_status = 'escalated'")" = "1" ]
check $? "exactly one recorded transition to escalated"
[ "$(q "select count(*) from public.audit_events where organization_id = '$ORG' and event_type = 'automation_rule.executed'")" = "1" ]
check $? "exactly one automation_rule.executed event"
both_clean "neither session errored"
endround

# --------------------------------------------------------------------------
# Race 4 — two recorders of the same logical analysis event.
#
# A records (run R, mention M) and holds. B records the SAME event and parks
# on `mention_analyses_one_per_event`; once A commits, B absorbs the unique
# violation and returns A's occurrence with created=false. One event, one
# durable row, whichever recorder gets there first.
#
# (The after-completion ordering — a recorder arriving once the event has
# already been applied — is deterministic single-session work and lives in
# section 2b of supabase/tests/execution-verification.sql.)
# --------------------------------------------------------------------------

round "4 — two recorders of one analysis event"

REC_ARGS="'$ORG', '$M_REC', '$RUN_REC', 'anthropic', 'claude-race', 'v1', 0.800, 'relevant', 'negative'::sentiment, -0.600, 'high'::risk_level, array['food_safety']::escalation_category[], 'risky', array['race']::text[], array[]::text[], 'escalate'::recommended_action, 'escalate it', now()"

step_a r4 "begin; select analysis_id::text || ':' || created::text from public.record_analysis_occurrence($REC_ARGS);"
await_a r4 || fail "session A never returned from recording"

step_b r4 "begin; select analysis_id::text || ':' || created::text from public.record_analysis_occurrence($REC_ARGS);"
if await_blocked "record_analysis_occurrence" 10; then
  ok "session B provably blocks on the event key (pg_stat_activity reports a Lock wait)"
else
  fail "session B never blocked — the recorders did not actually race"
fi

step_a r4commit "commit;"
await_a r4commit || fail "session A could not commit"
await_b r4 10 || fail "session B never returned"
step_b r4commit "commit;"
await_b r4commit || fail "session B could not commit"

A4="$(out_a r4)"; B4="$(out_b r4)"
A4_ID="${A4%%:*}"; A4_CREATED="${A4##*:}"
B4_ID="${B4%%:*}"; B4_CREATED="${B4##*:}"

[ "$A4_CREATED" = "true" ] && [ "$B4_CREATED" = "false" ]
check $? "exactly one recorder created the occurrence (A=$A4_CREATED, B=$B4_CREATED)"
[ -n "$A4_ID" ] && [ "$A4_ID" = "$B4_ID" ]
check $? "the loser was handed the winner's occurrence id"
[ "$(q "select count(*) from public.mention_analyses where mention_id = '$M_REC'")" = "1" ]
check $? "exactly one occurrence row for the mention"
[ "$(q "select count(*) from public.mention_analyses where mention_id = '$M_REC' and outcome_applied_at is null")" = "1" ]
check $? "and exactly one pending slot, held by that row"
both_clean "neither session errored"
endround

# --------------------------------------------------------------------------

ROUND="summary"
say ""
if [ "$FAILURES" -eq 0 ]; then
  say "all four races held."
  exit 0
fi
say "$FAILURES race check(s) failed."
exit 1
