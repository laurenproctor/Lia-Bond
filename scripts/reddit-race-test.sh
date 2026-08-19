#!/usr/bin/env bash
#
# Deterministic, bounded concurrency proofs for Reddit ingest and run claiming.
#
# Same discipline as scripts/generation-race-test.sh, and the same reason for
# it: nothing here sleeps and hopes. Two psql sessions are driven statement by
# statement over FIFOs, so the interleaving is chosen rather than observed —
# session A opens a transaction and HOLDS it, session B is pushed into the
# exact conflict, and only then is A released.
#
#   1. Two monitors, one post   -> ONE mention, TWO match rows, and B provably
#                                  parked on A's row lock while A holds it
#   2. Two claims, one monitor  -> one `claimed`, one `in_progress`, one run
#   3. Attribution under a race -> the second monitor's disagreement is seen by
#                                  the derivation, so the thread ends up
#                                  organization-wide rather than keeping
#                                  whichever location committed first
#
# Race 1 is the one that matters most. Two location monitors for the same brand
# finding the same thread is not a corner case on Reddit, it is Tuesday — and
# an ingest that let both fall through to the insert would either duplicate the
# thread in the inbox or fail one poll on a unique violation.
#
# Race 3 is the reason attribution is *derived* rather than written. If the
# second transaction's match were invisible to the first's derivation, the
# thread would keep the first monitor's location and one restaurant's team
# would silently own another's conversation.
#
# Rails, because a race harness that hangs is worse than one that fails:
#   * every session opens with statement_timeout = 10s and lock_timeout = 10s
#   * every round runs under a 60s watchdog that TERMs the script
#   * `trap cleanup EXIT INT TERM` closes the FIFOs (which rolls back any held
#     transaction, since the backend aborts when its client disappears) and
#     deletes the whole race organization, row by row, in dependency order
#
# These transactions COMMIT — that is the point — so the fixtures live in a
# throwaway organization (slug `reddit-race-*`) rather than in the seed.
#
# Usage:  bash scripts/reddit-race-test.sh
#         (SUPABASE_DB_URL is honoured; the local stack's URL is the default.)

set -uo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reddit-race.XXXXXX")"
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

q() { psql "$DB_URL" -X -q -A -t -c "$1" 2>>"$WORK/oneshot.log"; }

cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  [ -n "$WATCHDOG" ] && kill "$WATCHDOG" 2>/dev/null
  # The braces are load-bearing: `exec 7>&- 2>/dev/null` would silence stderr
  # for the whole rest of cleanup, including the residue report.
  { exec 7>&-; exec 8>&-; } 2>/dev/null
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null
  wait 2>/dev/null

  cat > "$WORK/cleanup.sql" <<'SQL'
do $$
declare v_org uuid;
begin
  for v_org in select id from public.organizations where slug like 'reddit-race-%' loop
    delete from public.audit_events              where organization_id = v_org;
    delete from public.reddit_query_matches      where organization_id = v_org;
    delete from public.reddit_poll_runs          where organization_id = v_org;
    delete from public.reddit_monitoring_queries where organization_id = v_org;
    delete from public.reddit_community_postures where organization_id = v_org;
    delete from public.response_drafts           where organization_id = v_org;
    delete from public.mentions                  where organization_id = v_org;
    delete from public.memberships               where organization_id = v_org;
    delete from public.locations                 where organization_id = v_org;
    delete from public.platform_connections      where organization_id = v_org;
    delete from public.organizations             where id = v_org;
  end loop;
  delete from public.users where email like 'reddit-race-%@example.test';
end $$;
drop table if exists public.reddit_race_fixture;
SQL
  psql "$DB_URL" -X -q -f "$WORK/cleanup.sql" >>"$WORK/oneshot.log" 2>&1

  # Residue is a failure, not a warning: these races COMMIT, so a surviving
  # fixture poisons every later run.
  local leftovers
  leftovers="$(q "select count(*) from public.organizations where slug like 'reddit-race-%'")"
  if [ "${leftovers:-0}" != "0" ]; then
    fail "$leftovers reddit-race organization(s) survived cleanup"
    rm -rf "$WORK"
    exit 1
  fi
  rm -rf "$WORK"
}

trap 'cleanup' EXIT
trap 'printf "\ninterrupted\n" >&2; cleanup; exit 130' INT TERM

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

# Each session is a psql reading from a FIFO we hold open. `\o <file>` captures
# a step's result and `\! touch <file>` is the handshake: psql runs it only
# after everything before it has finished, so a step whose marker never appears
# is a step that is BLOCKED — which is what race 1 needs to observe.

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

close_sessions() {
  { exec 7>&-; exec 8>&-; } 2>/dev/null
  wait "$PID_A" 2>/dev/null
  wait "$PID_B" 2>/dev/null
  PID_A=""; PID_B=""
  rm -f "$WORK/a.in" "$WORK/b.in"
}

step_a() { local marker="$1"; shift
  rm -f "$WORK/a.$marker.done" "$WORK/a.$marker.out"
  printf '\\o %s\n' "$WORK/a.$marker.out" >&7
  printf '%s\n' "$*" >&7
  printf '\\o\n' >&7
  printf '\\! touch %s\n' "$WORK/a.$marker.done" >&7
}

step_b() { local marker="$1"; shift
  rm -f "$WORK/b.$marker.done" "$WORK/b.$marker.out"
  printf '\\o %s\n' "$WORK/b.$marker.out" >&8
  printf '%s\n' "$*" >&8
  printf '\\o\n' >&8
  printf '\\! touch %s\n' "$WORK/b.$marker.done" >&8
}

await() { local f="$1" limit="${2:-15}" i=0
  while [ ! -e "$f" ]; do
    sleep 0.05
    i=$((i + 1))
    if [ "$i" -gt $((limit * 20)) ]; then return 1; fi
  done
  return 0
}

await_a() { await "$WORK/a.$1.done" "${2:-15}"; }
await_b() { await "$WORK/b.$1.done" "${2:-15}"; }
out_a()   { tr -d ' \n' < "$WORK/a.$1.out" 2>/dev/null; }
out_b()   { tr -d ' \n' < "$WORK/b.$1.out" 2>/dev/null; }

# Poll pg_stat_activity until a session is provably parked on a lock. This is
# what makes "B is blocked" an assertion rather than an assumption.
await_blocked() { local frag="$1" limit="${2:-10}" i=0 n
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

session_clean() { local who="$1" hit
  # The pattern allows a prefix: in file mode psql labels every diagnostic
  # `psql:<path>:<line>: ERROR: …` rather than starting the line with ERROR.
  hit="$(grep -m1 -E '(^|: )ERROR:' "$WORK/$who.log" 2>/dev/null)"
  if [ -n "$hit" ]; then
    fail "session $who reported an error: $hit"
    return 1
  fi
  return 0
}

both_clean() { local rc=0
  session_clean a || rc=1
  session_clean b || rc=1
  [ "$rc" -eq 0 ] && ok "$1"
  return "$rc"
}

# --------------------------------------------------------------------------
# Fixtures: one throwaway organization, a Reddit connection, two locations, and
# three monitors — two location-scoped and one organization-wide.
# --------------------------------------------------------------------------

round "setup"

cat > "$WORK/setup.sql" <<'SQL'
create table public.reddit_race_fixture (slot text primary key, value uuid);

do $$
declare
  v_org uuid; v_conn uuid; v_loc_a uuid; v_loc_b uuid;
  v_slug text; v_q_a uuid; v_q_b uuid; v_q_brand uuid;
begin
  v_slug := 'reddit-race-' || substr(gen_random_uuid()::text, 1, 12);

  insert into public.organizations (name, slug, industry)
  values ('Reddit race harness', v_slug, 'restaurants')
  returning id into v_org;

  insert into public.locations
    (organization_id, name, slug, address_line1, city, region, postal_code,
     country_code, timezone, status)
  values (v_org, 'Race location A', 'race-a', '1 Race Street', 'New York',
          'NY', '10001', 'US', 'America/New_York', 'active')
  returning id into v_loc_a;
  insert into public.locations
    (organization_id, name, slug, address_line1, city, region, postal_code,
     country_code, timezone, status)
  values (v_org, 'Race location B', 'race-b', '2 Race Street', 'New York',
          'NY', '10002', 'US', 'America/New_York', 'active')
  returning id into v_loc_b;

  insert into public.platform_connections (organization_id, platform, status)
  values (v_org, 'reddit', 'connected') returning id into v_conn;

  insert into public.reddit_monitoring_queries (organization_id, name, terms, location_id)
  values (v_org, 'race monitor a', array['race brand'], v_loc_a) returning id into v_q_a;
  insert into public.reddit_monitoring_queries (organization_id, name, terms, location_id)
  values (v_org, 'race monitor b', array['race brand'], v_loc_b) returning id into v_q_b;
  insert into public.reddit_monitoring_queries (organization_id, name, terms, location_id)
  values (v_org, 'race monitor brand', array['race brand'], null) returning id into v_q_brand;

  insert into public.reddit_race_fixture (slot, value) values
    ('org', v_org), ('conn', v_conn), ('loc_a', v_loc_a), ('loc_b', v_loc_b),
    ('q_a', v_q_a), ('q_b', v_q_b), ('q_brand', v_q_brand);
end $$;
SQL

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK/setup.sql" >>"$WORK/oneshot.log" 2>&1 || {
  say "setup failed; see $WORK/oneshot.log"
  cat "$WORK/oneshot.log" >&2
  exit 1
}

ORG="$(q "select value from public.reddit_race_fixture where slot = 'org'")"
CONN="$(q "select value from public.reddit_race_fixture where slot = 'conn'")"
LOC_A="$(q "select value from public.reddit_race_fixture where slot = 'loc_a'")"
Q_A="$(q "select value from public.reddit_race_fixture where slot = 'q_a'")"
Q_B="$(q "select value from public.reddit_race_fixture where slot = 'q_b'")"
Q_BRAND="$(q "select value from public.reddit_race_fixture where slot = 'q_brand'")"

[ -n "$ORG" ] && ok "fixtures created" || { fail "no fixture organization"; exit 1; }
endround

# The ingest call, parameterised by monitor and post. Kept in one place so the
# two racing sessions differ only in the monitor they are acting for — which is
# the whole variable under test.
ingest_sql() { # ingest_sql <query-id> <external-id>
  printf "select outcome from public.ingest_reddit_mention(
    '%s'::uuid, '%s'::uuid, '%s'::uuid, 'reddit_post', '%s', null, '%s',
    'https://www.reddit.com/r/racesub/comments/x', 'Race post', 'Race body.',
    'u/racer', 't2_racer', now() - interval '1 hour', now(), 'racesub',
    10, 2, false, false, false, null, '{}'::jsonb, array['race brand'], 0.9);" \
    "$ORG" "$CONN" "$1" "$2" "$2"
}

# --------------------------------------------------------------------------
# Race 1 — two monitors find the same post at the same moment.
#
# One mention, two matches. B must be provably PARKED on A's `for update` while
# A holds its transaction open; if it were not, both would fall through to the
# insert and one would die on mentions_unique_external.
# --------------------------------------------------------------------------

round "two monitors, one post"

open_a
open_b

step_a begin "begin;"
await_a begin || fail "session A could not begin"

step_a ingest "$(ingest_sql "$Q_A" 't3_race1')"
await_a ingest || fail "session A's ingest did not return"
check "$([ "$(out_a ingest)" = "created" ] && echo 0 || echo 1)" \
  "the first monitor's ingest creates the mention"

# B enters the same ingest while A still holds the row. It must block.
step_b begin "begin;"
await_b begin || fail "session B could not begin"
step_b ingest "$(ingest_sql "$Q_B" 't3_race1')"

if await_blocked "ingest_reddit_mention" 10; then
  ok "the second monitor's ingest parks on the first's row lock"
else
  fail "the second monitor's ingest was never observed blocked"
fi

check "$(await_b ingest 2 && echo 1 || echo 0)" \
  "and stays blocked while the first transaction is open"

step_a commit "commit;"
await_a commit || fail "session A could not commit"

await_b ingest 15 || fail "session B's ingest never completed after A committed"
B_OUT="$(out_b ingest)"
# `unchanged`, not `created`: B found the row A committed, and nothing about
# the post itself differed between the two calls.
check "$([ "$B_OUT" = "unchanged" ] || [ "$B_OUT" = "updated" ] && echo 0 || echo 1)" \
  "the second monitor's ingest resolves against the existing mention (got: $B_OUT)"

step_b commit "commit;"
await_b commit || fail "session B could not commit"

MENTIONS="$(q "select count(*) from public.mentions
                where organization_id = '$ORG' and external_id = 't3_race1'")"
check "$([ "$MENTIONS" = "1" ] && echo 0 || echo 1)" \
  "two concurrent monitors produced exactly one mention (got: $MENTIONS)"

MATCHES="$(q "select count(*) from public.reddit_query_matches m
                join public.mentions n on n.id = m.mention_id
               where n.organization_id = '$ORG' and n.external_id = 't3_race1'")"
check "$([ "$MATCHES" = "2" ] && echo 0 || echo 1)" \
  "two concurrent monitors produced two match rows (got: $MATCHES)"

both_clean "neither session reported an error"
close_sessions
endround

# --------------------------------------------------------------------------
# Race 3 (run before 2 so it reuses race 1's committed state).
#
# Attribution under a race. Two *disagreeing* location monitors matched the
# same post above, so the derivation must have seen both and left the thread
# organization-wide — not kept whichever location committed first.
# --------------------------------------------------------------------------

round "attribution under a race"

LOCATION="$(q "select coalesce(location_id::text, 'NULL') from public.mentions
                where organization_id = '$ORG' and external_id = 't3_race1'")"
check "$([ "$LOCATION" = "NULL" ] && echo 0 || echo 1)" \
  "two disagreeing monitors left the thread organization-wide (got: $LOCATION)"

# And the mirror, so the check above is not passing because attribution is
# simply never written: one monitor alone does attribute.
psql "$DB_URL" -X -q -A -t >>"$WORK/oneshot.log" 2>&1 <<SQL
select public.ingest_reddit_mention(
  '$ORG'::uuid, '$CONN'::uuid, '$Q_A'::uuid, 'reddit_post', 't3_race2', null, 't3_race2',
  null, 'Solo', 'Body.', 'u/racer', 't2_racer', now(), now(), 'racesub',
  1, 0, false, false, false, null, '{}'::jsonb, array['race brand'], 0.9);
SQL

SOLO="$(q "select coalesce(location_id::text, 'NULL') from public.mentions
            where organization_id = '$ORG' and external_id = 't3_race2'")"
check "$([ "$SOLO" = "$LOC_A" ] && echo 0 || echo 1)" \
  "a single located monitor does attribute, so the check above is meaningful"

# A third monitor that disagrees now flips the solo thread to organization-wide,
# proving the derivation re-runs over the whole set rather than only on insert.
psql "$DB_URL" -X -q -A -t >>"$WORK/oneshot.log" 2>&1 <<SQL
select public.ingest_reddit_mention(
  '$ORG'::uuid, '$CONN'::uuid, '$Q_B'::uuid, 'reddit_post', 't3_race2', null, 't3_race2',
  null, 'Solo', 'Body.', 'u/racer', 't2_racer', now(), now(), 'racesub',
  1, 0, false, false, false, null, '{}'::jsonb, array['race brand'], 0.9);
SQL

FLIPPED="$(q "select coalesce(location_id::text, 'NULL') from public.mentions
               where organization_id = '$ORG' and external_id = 't3_race2'")"
check "$([ "$FLIPPED" = "NULL" ] && echo 0 || echo 1)" \
  "a later disagreeing monitor re-derives attribution rather than being ignored"

endround

# --------------------------------------------------------------------------
# Race 2 — two workers claim the same monitor's poll run.
# --------------------------------------------------------------------------

round "two claims, one monitor"

open_a
open_b

claim_sql() {
  printf "select claimed from public.claim_reddit_poll_run(
    '%s'::uuid, 'search', '%s'::uuid, null, 'scheduled', null, 900);" "$ORG" "$Q_BRAND"
}

step_a begin "begin;"
await_a begin || fail "session A could not begin"
step_a claim "$(claim_sql)"
await_a claim || fail "session A's claim did not return"
check "$([ "$(out_a claim)" = "t" ] && echo 0 || echo 1)" "the first claim succeeds"

step_b begin "begin;"
await_b begin || fail "session B could not begin"
step_b claim "$(claim_sql)"

# B blocks on A's `for update` of the running row — or, if A has not inserted
# one yet from B's perspective, on the partial unique index. Either way it must
# not come back with a second claim.
if await_blocked "claim_reddit_poll_run" 10; then
  ok "the second claim parks rather than racing the insert"
else
  # Not a failure on its own: if A committed fast enough B may simply have
  # taken the lock cleanly. What must hold is the outcome, checked below.
  say "note: the second claim was not observed parked; asserting the outcome instead"
fi

step_a commit "commit;"
await_a commit || fail "session A could not commit"

await_b claim 15 || fail "session B's claim never returned"
check "$([ "$(out_b claim)" = "f" ] && echo 0 || echo 1)" \
  "the second claim is refused (got: $(out_b claim))"

step_b commit "commit;"
await_b commit || fail "session B could not commit"

RUNS="$(q "select count(*) from public.reddit_poll_runs
            where organization_id = '$ORG' and kind = 'search' and status = 'running'")"
check "$([ "$RUNS" = "1" ] && echo 0 || echo 1)" \
  "two concurrent claims produced exactly one running run (got: $RUNS)"

both_clean "neither session reported an error"
close_sessions
endround

say ""
if [ "$FAILURES" -eq 0 ]; then
  say "all reddit race checks passed"
  exit 0
fi
say "$FAILURES reddit race check(s) failed"
exit 1
