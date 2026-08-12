#!/usr/bin/env bash
#
# Deterministic, bounded concurrency proofs for response generation.
#
# The three races below are not load tests and nothing here sleeps and hopes.
# Two psql sessions are driven statement by statement over FIFOs, so the
# interleaving is chosen rather than observed: session A opens a transaction
# and HOLDS it, session B is pushed into the exact conflict, and only then is A
# released. Every outcome is therefore reproducible.
#
#   1. Two concurrent claims      -> one claim, one in_progress, one pending row
#   2. Expiry re-claim            -> one new attempt, one lease_expired closure
#   3. The stale worker           -> its completion is superseded, and the
#                                    attempt that replaced it is untouched
#
# Rails, because a race harness that hangs is worse than one that fails:
#   * every session opens with statement_timeout = 10s and lock_timeout = 10s
#   * every round runs under a 60s watchdog that TERMs the script
#   * `trap cleanup EXIT INT TERM` closes the FIFOs (which rolls back any held
#     transaction, since the backend aborts when its client disappears), drops
#     the scratch table, and deletes the whole race organization
#
# Unlike supabase/tests/generation-verification.sql, these transactions COMMIT —
# that is the point — so the fixtures live in their own throwaway organization
# (slug `gen-race-*`) which cleanup removes row by row, in dependency order,
# whatever happens.
#
# Every session authenticates as a real member: claim_generation_attempt reads
# auth.uid() and checks membership and role itself, so a bare superuser session
# would be refused (42501) and prove nothing about the race.
#
# Usage:  bash scripts/generation-race-test.sh
#         (SUPABASE_DB_URL is honoured; the local stack's URL is the default.)

set -uo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/generation-race.XXXXXX")"
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
  # the residue report below.
  { exec 7>&-; exec 8>&-; } 2>/dev/null
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null
  wait 2>/dev/null

  cat > "$WORK/cleanup.sql" <<'SQL'
do $$
declare v_org uuid;
begin
  for v_org in select id from public.organizations where slug like 'gen-race-%' loop
    delete from public.audit_events        where organization_id = v_org;
    delete from public.generation_attempts where organization_id = v_org;
    delete from public.response_drafts     where organization_id = v_org;
    delete from public.mentions            where organization_id = v_org;
    delete from public.memberships         where organization_id = v_org;
    delete from public.locations           where organization_id = v_org;
    delete from public.platform_connections where organization_id = v_org;
    delete from public.organizations       where id = v_org;
  end loop;
  delete from public.users where email like 'gen-race-%@example.test';
end $$;
drop table if exists public.gen_race_fixture;
SQL
  psql "$DB_URL" -X -q -f "$WORK/cleanup.sql" >>"$WORK/oneshot.log" 2>&1

  # Residue is a failure, not a warning: these races COMMIT, so a fixture that
  # survives poisons every later run of the harness (and the seed the rest of
  # the suite assumes). Reported through `fail` and then forced into the exit
  # status — cleanup runs from the EXIT trap, after the script has already
  # chosen its status, so incrementing FAILURES alone would change nothing.
  local leftovers
  leftovers="$(q "select count(*) from public.organizations where slug like 'gen-race-%'")"
  if [ "${leftovers:-0}" != "0" ]; then
    fail "$leftovers gen-race organization(s) survived cleanup"
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
# exactly what all three races need to be able to observe.
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

# No error lines in the transcript. The pattern allows a prefix: sessions are
# fed with `psql -f <fifo>`, and in file mode psql labels every diagnostic
# `psql:<path>:<line>: ERROR: …` rather than starting the line with ERROR.
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
# Fixtures: one throwaway organization, a real member to act as, and the two
# Google reviews the races claim against.
# --------------------------------------------------------------------------

round "setup"

cat > "$WORK/setup.sql" <<'SQL'
create table public.gen_race_fixture (slot text primary key, value uuid);

do $$
declare
  v_org uuid; v_conn uuid; v_loc uuid; v_user uuid;
  v_slug text; v_m1 uuid; v_m3 uuid;
begin
  v_slug := 'gen-race-' || substr(gen_random_uuid()::text, 1, 12);

  insert into public.organizations (name, slug, industry)
  values ('Generation race harness', v_slug, 'restaurants')
  returning id into v_org;

  insert into public.platform_connections (organization_id, platform)
  values (v_org, 'google_business_profile') returning id into v_conn;

  insert into public.locations
      (organization_id, name, slug, address_line1, city, region, postal_code,
       country_code, timezone, status)
  values (v_org, 'Race House', 'race-house', '1 Race Street', 'New York', 'NY',
          '10001', 'US', 'America/New_York', 'active')
  returning id into v_loc;

  -- A real member, because the claim checks membership and role itself.
  -- communications_lead: the least-privileged role that holds response.generate,
  -- so the races prove the grant rather than an owner's blanket authority.
  insert into public.users (id, email, first_name, last_name)
  values (gen_random_uuid(), v_slug || '@example.test', 'Race', 'Runner')
  returning id into v_user;

  insert into public.memberships (organization_id, user_id, role, status)
  values (v_org, v_user, 'communications_lead', 'active');

  insert into public.mentions
      (organization_id, location_id, platform_connection_id, source_type,
       external_id, content, published_at, status, risk_level)
  values (v_org, v_loc, v_conn, 'google_review', 'gen-race-1-' || gen_random_uuid()::text,
          'race fixture review', now(), 'analyzed', 'low')
  returning id into v_m1;

  insert into public.mentions
      (organization_id, location_id, platform_connection_id, source_type,
       external_id, content, published_at, status, risk_level)
  values (v_org, v_loc, v_conn, 'google_review', 'gen-race-3-' || gen_random_uuid()::text,
          'race fixture review', now(), 'analyzed', 'low')
  returning id into v_m3;

  insert into public.gen_race_fixture (slot, value) values
    ('org', v_org), ('member', v_user), ('mention_1', v_m1), ('mention_3', v_m3);
end $$;
SQL

if ! runsql "$WORK/setup.sql"; then
  say "setup failed:"
  cat "$WORK/oneshot.log" >&2
  exit 1
fi

ORG="$(q "select value from public.gen_race_fixture where slot = 'org'")"
MEMBER="$(q "select value from public.gen_race_fixture where slot = 'member'")"
M1="$(q "select value from public.gen_race_fixture where slot = 'mention_1'")"
M3="$(q "select value from public.gen_race_fixture where slot = 'mention_3'")"

if [ -z "$ORG" ]; then
  say "setup produced no organization id"
  cat "$WORK/oneshot.log" >&2
  exit 1
fi
ok "fixtures built in throwaway organization $ORG"

# Every claim runs as this member. `set local` scopes both to the transaction,
# so a committed session goes back to being the owner it connected as.
AUTH="set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$MEMBER\",\"role\":\"authenticated\"}';"

# outcome:attempt:token, with '-' for the nulls a non-claim returns.
claim_sql() { # claim_sql <mention-id>
  printf "%s select outcome || ':' || coalesce(attempt_id::text, '-') || ':' || coalesce(claim_token::text, '-') from public.claim_generation_attempt('%s', '{\"review\": {\"text\": \"race\"}}'::jsonb, 'race-hash', 'drafting@race', 'configured', '1', true, 120);" \
    "$AUTH" "$1"
}

open_a
open_b
ok "two sessions open, each with statement_timeout = 10s and lock_timeout = 10s"
endround

# --------------------------------------------------------------------------
# Race 1 — two concurrent claims on the same review.
#
# A takes the mention row FOR UPDATE and holds. B asks for the same review and
# parks on that lock — which is the whole serialization argument: the claim's
# first act is to lock the mention, so two clicks can never both reach the
# insert. When A commits, B re-reads, finds A's live lease, and reports it.
# --------------------------------------------------------------------------

round "1 — two concurrent claims"

step_a r1 "begin; $(claim_sql "$M1")"
await_a r1 || fail "session A never returned from its claim"

step_b r1 "begin; $(claim_sql "$M1")"
if await_blocked "claim_generation_attempt" 10; then
  ok "session B is parked on the mention lock while A holds its transaction"
else
  fail "session B never blocked — the race did not happen"
fi

step_a r1commit "commit;"
await_a r1commit || fail "session A could not commit"

if await_b r1 10; then ok "session B returned once A committed"; else fail "session B never returned"; fi
step_b r1commit "commit;"
await_b r1commit || fail "session B could not commit"

A1="$(out_a r1)"; B1="$(out_b r1)"
A1_OUTCOME="$(printf '%s' "$A1" | cut -d: -f1)"
A1_ID="$(printf '%s' "$A1" | cut -d: -f2)"
A1_TOKEN="$(printf '%s' "$A1" | cut -d: -f3)"
B1_OUTCOME="$(printf '%s' "$B1" | cut -d: -f1)"
B1_ID="$(printf '%s' "$B1" | cut -d: -f2)"
B1_TOKEN="$(printf '%s' "$B1" | cut -d: -f3)"

[ "$A1_OUTCOME" = "claimed" ] && [ "$B1_OUTCOME" = "in_progress" ]
check $? "exactly one session claimed the review (A=$A1_OUTCOME, B=$B1_OUTCOME)"
[ -n "$A1_ID" ] && [ "$A1_ID" = "$B1_ID" ]
check $? "the loser was handed the winner's attempt, not a second one"
[ "$A1_TOKEN" != "-" ] && [ "$B1_TOKEN" = "-" ]
check $? "only the winner received a claim token"
[ "$(q "select count(*) from public.generation_attempts where mention_id = '$M1' and status = 'pending'")" = "1" ]
check $? "exactly one pending attempt exists"
[ "$(q "select dedup_hits from public.generation_attempts where id = '$A1_ID'")" = "1" ]
check $? "the deduplicated click was counted once"
both_clean "neither session errored"
endround

# --------------------------------------------------------------------------
# Race 2 — an expired lease, re-claimed exactly once.
#
# Race 1's winner is backdated past its lease. Both sessions now want the same
# review again. A sweeps the dead attempt and opens a new one; B blocks on the
# mention, then sees A's fresh lease and defers to it. What must not happen is
# two live attempts, or the dead one being closed twice.
# --------------------------------------------------------------------------

round "2 — expiry re-claim"

# Both timestamps move: ga_lease_order requires expires_at > claimed_at, so
# pulling expiry into the past alone would violate the constraint rather than
# simulate a timeout.
q "update public.generation_attempts
      set claimed_at = now() - interval '10 minutes',
          expires_at = now() - interval '5 minutes'
    where id = '$A1_ID'" > /dev/null

step_a r2 "begin; $(claim_sql "$M1")"
await_a r2 || fail "session A never returned from its re-claim"

step_b r2 "begin; $(claim_sql "$M1")"
if await_blocked "claim_generation_attempt" 10; then
  ok "session B is parked on the mention lock during the sweep"
else
  fail "session B never blocked on the expiring attempt"
fi

step_a r2commit "commit;"
await_a r2commit || fail "session A could not commit"
await_b r2 10 || fail "session B never returned"
step_b r2commit "commit;"
await_b r2commit || fail "session B could not commit"

A2="$(out_a r2)"; B2="$(out_b r2)"
A2_OUTCOME="$(printf '%s' "$A2" | cut -d: -f1)"
A2_ID="$(printf '%s' "$A2" | cut -d: -f2)"
B2_OUTCOME="$(printf '%s' "$B2" | cut -d: -f1)"
B2_ID="$(printf '%s' "$B2" | cut -d: -f2)"

[ "$A2_OUTCOME" = "claimed" ] && [ "$B2_OUTCOME" = "in_progress" ]
check $? "exactly one re-claim happened (A=$A2_OUTCOME, B=$B2_OUTCOME)"
[ "$A2_ID" != "$A1_ID" ]
check $? "the re-claim opened a new attempt rather than reviving the dead one"
[ -n "$A2_ID" ] && [ "$A2_ID" = "$B2_ID" ]
check $? "no double owner — both sessions name the same new attempt"
[ "$(q "select count(*) from public.generation_attempts where mention_id = '$M1' and status = 'pending'")" = "1" ]
check $? "still exactly one pending attempt"
[ "$(q "select count(*) from public.generation_attempts where id = '$A1_ID' and status = 'failed' and failure_category = 'lease_expired'")" = "1" ]
check $? "the timed-out attempt was closed as lease_expired"
[ "$(q "select count(*) from public.generation_attempts where mention_id = '$M1' and failure_category = 'lease_expired'")" = "1" ]
check $? "and closed exactly once"
both_clean "neither session errored"
endround

# --------------------------------------------------------------------------
# Race 3 — the stale worker.
#
# A claims and takes so long that its lease expires and B takes the review
# over. A then comes back with a draft and its old token. The CAS is the whole
# defence: A's completion must be refused, and B's attempt must be exactly as
# it was — not overwritten, not completed by somebody else's work.
# --------------------------------------------------------------------------

round "3 — the stale worker"

step_a r3 "begin; $(claim_sql "$M3")"
await_a r3 || fail "session A never returned from its claim"

step_b r3 "begin; $(claim_sql "$M3")"
if await_blocked "claim_generation_attempt" 10; then
  ok "session B is parked on the mention lock"
else
  fail "session B never blocked"
fi

step_a r3commit "commit;"
await_a r3commit || fail "session A could not commit"
await_b r3 10 || fail "session B never returned"
step_b r3commit "commit;"
await_b r3commit || fail "session B could not commit"

A3="$(out_a r3)"; B3="$(out_b r3)"
A3_ID="$(printf '%s' "$A3" | cut -d: -f2)"
A3_TOKEN="$(printf '%s' "$A3" | cut -d: -f3)"
[ "$(printf '%s' "$B3" | cut -d: -f1)" = "in_progress" ]
check $? "B deferred to A's live lease first"

# A's worker is now hung: its lease runs out and B takes the review over.
q "update public.generation_attempts
      set claimed_at = now() - interval '10 minutes',
          expires_at = now() - interval '5 minutes'
    where id = '$A3_ID'" > /dev/null

step_b r3b "begin; $(claim_sql "$M3") commit;"
await_b r3b || fail "session B never returned from its takeover claim"

B3B="$(out_b r3b)"
B3B_OUTCOME="$(printf '%s' "$B3B" | cut -d: -f1)"
B3B_ID="$(printf '%s' "$B3B" | cut -d: -f2)"

[ "$B3B_OUTCOME" = "claimed" ]
check $? "B took the review over once A's lease expired (got $B3B_OUTCOME)"
[ "$(q "select count(*) from public.generation_attempts where id = '$A3_ID' and status = 'failed' and failure_category = 'lease_expired'")" = "1" ]
check $? "A's attempt was closed as lease_expired by the takeover"

BEFORE="$(q "select to_jsonb(ga.*)::text from public.generation_attempts ga where ga.id = '$B3B_ID'")"

# A finally finishes and tries to record its draft with the token it still holds.
step_a r3c "begin; $AUTH select outcome from public.complete_generation_attempt('$A3_ID', '$A3_TOKEN', 'The stale worker''s reply.', 'sys', 'usr', 'draft-output@1', 'anthropic', 'claude-race', 1024, null, 'req_race', 900, 120, 1500); commit;"
await_a r3c || fail "session A never returned from its stale completion"

A3C="$(out_a r3c)"
[ "$A3C" = "superseded" ]
check $? "the stale worker's completion was refused (got $A3C)"

AFTER="$(q "select to_jsonb(ga.*)::text from public.generation_attempts ga where ga.id = '$B3B_ID'")"
[ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ]
check $? "B's attempt is byte-identical after the stale write"

[ "$(q "select count(*) from public.response_drafts where mention_id = '$M3'")" = "0" ]
check $? "no draft was written by the refused completion"
[ "$(q "select count(*) from public.audit_events where event_type = 'response.generated' and organization_id = '$ORG'")" = "0" ]
check $? "and no response.generated event either"
[ "$(q "select status from public.generation_attempts where id = '$B3B_ID'")" = "pending" ]
check $? "B's attempt is still pending, free to finish its own work"
both_clean "neither session errored"
endround

# --------------------------------------------------------------------------

ROUND="summary"
say ""
if [ "$FAILURES" -eq 0 ]; then
  say "all three races held."
  exit 0
fi
say "$FAILURES race check(s) failed."
exit 1
