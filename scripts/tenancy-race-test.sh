#!/usr/bin/env bash
#
# Deterministic, bounded concurrency proofs for multi-organization provisioning
# and location mapping.
#
# Two races, and neither sleeps and hopes. Two psql sessions are driven
# statement by statement over FIFOs, so the interleaving is chosen rather than
# observed: session A opens a transaction and HOLDS it, session B is pushed
# into the exact conflict, `pg_stat_activity` is polled until B is provably
# parked, and only then is A released.
#
#   1. Provisioning replay   -> two calls with one request key produce one
#                               organization, one owner membership, one
#                               onboarding row, and ONE organization.created
#                               event; both callers get the same id; a third
#                               caller who does not own the key gets 42501
#   2. Mapping convergence   -> two calls mapping the same external profile
#                               produce ONE location and one set of three audit
#                               events; the loser reports replayed = true
#
# Why this exists as well as supabase/tests/tenancy-verification.sql: T-14 and
# T-19c in that file call each function twice in sequence, which a
# read-then-insert implementation passes happily. The whole claim being made
# here — that the insert itself is the idempotency decision — is only falsifiable
# under genuine concurrency, and "two clicks are two processes" is the normal
# case on serverless, not an exotic one.
#
# Rails, because a race harness that hangs is worse than one that fails:
#   * every session opens with statement_timeout = 10s and lock_timeout = 10s
#   * every round runs under a 60s watchdog that TERMs the script
#   * `trap cleanup EXIT INT TERM` closes the FIFOs (which rolls back any held
#     transaction, since the backend aborts when its client disappears) and
#     removes the whole race organization row by row
#
# Unlike the SQL harness these transactions COMMIT — that is the point — so the
# fixtures live in throwaway organizations (slug `tenancy-race-%`) that cleanup
# removes whatever happens, and surviving residue is reported as a failure
# rather than a warning: it would poison every later run.
#
# Both sessions authenticate as a real user. `provision_organization` and
# `create_and_map_location` both read auth.uid() and check membership
# themselves, so a bare superuser session would be refused and prove nothing.
#
# Usage:  bash scripts/tenancy-race-test.sh
#         (SUPABASE_DB_URL is honoured; the local stack's URL is the default.)

set -uo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tenancy-race.XXXXXX")"
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

eq() { # eq <actual> <expected> <label>
  if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (expected '$2', got '$1')"; fi
}

q() { psql "$DB_URL" -X -q -A -t -c "$1" 2>>"$WORK/oneshot.log"; }

# --------------------------------------------------------------------------
# Cleanup — runs on every exit path, including the watchdog's TERM.
# --------------------------------------------------------------------------

cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  [ -n "$WATCHDOG" ] && kill "$WATCHDOG" 2>/dev/null
  # Closing the write end lets each psql see EOF and exit; a session still
  # inside a transaction has it aborted by the backend when the client goes.
  # The braces are load-bearing — `exec 7>&- 2>/dev/null` would silence stderr
  # for the rest of cleanup, including the residue report below.
  { exec 7>&-; exec 8>&-; } 2>/dev/null
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null
  wait 2>/dev/null

  cat > "$WORK/cleanup.sql" <<'SQL'
do $$
declare v_org uuid;
begin
  for v_org in select id from public.organizations where slug like 'tenancy-race%' loop
    delete from public.audit_events           where organization_id = v_org;
    delete from public.mentions               where organization_id = v_org;
    delete from public.platform_profiles      where organization_id = v_org;
    delete from public.monitoring_queries     where organization_id = v_org;
    delete from public.locations              where organization_id = v_org;
    delete from public.organization_onboarding where organization_id = v_org;
    delete from public.memberships            where organization_id = v_org;
    delete from public.platform_connections   where organization_id = v_org;
    delete from public.organizations          where id = v_org;
  end loop;
  delete from public.users where email like 'tenancy-race-%@example.test';
end $$;
drop table if exists public.tenancy_race_fixture;
SQL
  psql "$DB_URL" -X -q -f "$WORK/cleanup.sql" >>"$WORK/oneshot.log" 2>&1

  local leftovers
  leftovers="$(q "select count(*) from public.organizations where slug like 'tenancy-race%'")"
  if [ "${leftovers:-0}" != "0" ]; then
    fail "$leftovers tenancy-race organization(s) survived cleanup"
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

# --------------------------------------------------------------------------
# Session plumbing.
#
# Each session is a psql reading from a FIFO we hold open, so statements can be
# fed one at a time. `\o <file>` captures a step's result and `\! touch <file>`
# is the handshake: psql runs it only after everything before it has finished,
# so a step whose marker never appears is a step that is BLOCKED — which is
# exactly what both races need to observe.
# --------------------------------------------------------------------------

open_session() { # open_session <a|b>
  local who="$1"
  # Removed first: rounds two and three reuse these names, and mkfifo on an
  # existing path fails rather than reopening it.
  rm -f "$WORK/$who.in"
  mkfifo "$WORK/$who.in"
  : > "$WORK/$who.log"
  psql "$DB_URL" -X -q -A -t -f "$WORK/$who.in" >>"$WORK/$who.log" 2>&1 &
}

# Close both sessions and reap them.
#
# `endround` first, and `wait <pid>` rather than a bare `wait`: the round
# watchdog is itself a background job, so a bare wait blocks on its full 60s
# sleep and the round times out having already passed every check. Found
# exactly that way.
close_sessions() {
  endround
  { exec 7>&-; exec 8>&-; } 2>/dev/null
  [ -n "$PID_A" ] && wait "$PID_A" 2>/dev/null
  [ -n "$PID_B" ] && wait "$PID_B" 2>/dev/null
  PID_A=""
  PID_B=""
}

open_a() {
  open_session a
  PID_A=$!
  exec 7>"$WORK/a.in"
  printf "%s\n" "set statement_timeout = '10s'; set lock_timeout = '10s';" >&7
}

open_b() {
  open_session b
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

# Poll pg_stat_activity until a session is provably parked on a lock. Without
# this the races would only be *probably* interleaved, and a passing run would
# not distinguish "B waited for A" from "B ran after A finished anyway".
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

session_clean() { # allows a psql file-mode prefix on the diagnostic line
  local who="$1" hit
  hit="$(grep -m1 -E '(^|: )ERROR:' "$WORK/$who.log" 2>/dev/null)"
  if [ -n "$hit" ]; then
    fail "session $who reported an error: $hit"
    return 1
  fi
  return 0
}

become() { # become <session-fd-name> <user-uuid>  -> emits the two SETs
  printf "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"authenticated\"}';" "$1"
}

# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

round "setup"

cat > "$WORK/setup.sql" <<'SQL'
create table public.tenancy_race_fixture (slot text primary key, value uuid);

do $$
declare
  v_actor uuid;
  v_other uuid;
  v_org uuid;
  v_conn uuid;
  v_slug text;
begin
  -- Two real users. The first drives both races; the second exists only to
  -- prove that a request key belonging to somebody else is refused.
  --
  -- `id` carries no default: public.users mirrors auth.users, where the id is
  -- the auth account's. `full_name` is STORED GENERATED from the two parts, so
  -- naming it in an INSERT is an error rather than a redundancy.
  insert into public.users (id, email, first_name, last_name)
  values (gen_random_uuid(),
          'tenancy-race-actor-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test',
          'Race', 'Actor')
  returning id into v_actor;

  insert into public.users (id, email, first_name, last_name)
  values (gen_random_uuid(),
          'tenancy-race-other-' || substr(gen_random_uuid()::text, 1, 8) || '@example.test',
          'Race', 'Other')
  returning id into v_other;

  -- A pre-made organization for the mapping race, with the actor as a
  -- communications lead: that is the role whose mapping authority the RPC
  -- exists to preserve, so it is the one worth racing.
  v_slug := 'tenancy-race-map-' || substr(gen_random_uuid()::text, 1, 8);
  insert into public.organizations (name, slug, industry)
  values ('Tenancy race mapping', v_slug, 'restaurants')
  returning id into v_org;

  insert into public.memberships (organization_id, user_id, role, status)
  values (v_org, v_actor, 'communications_lead', 'active');

  -- An owner too: the last-owner constraint trigger refuses an organization
  -- with no active owner, and cleanup deletes memberships.
  insert into public.memberships (organization_id, user_id, role, status)
  values (v_org, v_other, 'owner', 'active');

  insert into public.platform_connections (
    organization_id, platform, status, external_account_id, external_account_name
  )
  values (v_org, 'google_business_profile', 'connected', 'accounts/race', 'Race account')
  returning id into v_conn;

  insert into public.tenancy_race_fixture values
    ('actor', v_actor), ('other', v_other), ('org', v_org), ('conn', v_conn);
end $$;
SQL

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK/setup.sql" >>"$WORK/oneshot.log" 2>&1
if [ $? -ne 0 ]; then
  fail "fixture setup failed — see $WORK/oneshot.log"
  cat "$WORK/oneshot.log" >&2
  exit 1
fi

ACTOR="$(q "select value from public.tenancy_race_fixture where slot = 'actor'")"
OTHER="$(q "select value from public.tenancy_race_fixture where slot = 'other'")"
ORG="$(q "select value from public.tenancy_race_fixture where slot = 'org'")"
CONN="$(q "select value from public.tenancy_race_fixture where slot = 'conn'")"

[ -n "$ACTOR" ] && [ -n "$CONN" ] || { fail "fixtures did not resolve"; exit 1; }
ok "fixtures created"
endround

# --------------------------------------------------------------------------
# Race 1 — provisioning replay under genuine concurrency
#
# A opens a transaction and provisions with key K, holding it. B calls with the
# same K and must park on organizations_provision_request_key_unique. A commits;
# B's ON CONFLICT DO NOTHING then reports zero rows, and its actor-scoped
# fallback lookup returns A's organization — including A's membership row,
# which is only visible because the conflict arm waited for A's commit. That
# ordering is the load-bearing part, and this is the only place it is proven.
# --------------------------------------------------------------------------

round "provisioning replay"

KEY="$(q "select gen_random_uuid()")"
NAME="Tenancy race provisioning"

open_a
open_b

step_a begin "begin; $(become "$ACTOR")"
await_a begin 10 || fail "session A could not begin"

step_a provision \
  "select public.provision_organization('$NAME', 'Restaurant group', 'UTC', 'en-US', '$KEY'::uuid, 'in_app');"
await_a provision 10 || fail "session A's provision never returned"
A_ORG="$(out_a provision)"
check $([ -n "$A_ORG" ] && echo 0 || echo 1) "session A provisioned an organization"

step_b begin "begin; $(become "$ACTOR")"
await_b begin 10 || fail "session B could not begin"

step_b provision \
  "select public.provision_organization('$NAME', 'Restaurant group', 'UTC', 'en-US', '$KEY'::uuid, 'in_app');"

# B must be genuinely parked, not merely slow.
if await_blocked "provision_organization" 10; then
  ok "session B is parked on the request-key conflict (pg_stat_activity)"
else
  fail "session B never blocked — the unique index is not acting as the lock"
fi

if await_b provision 2; then
  fail "session B returned while A still held its transaction"
else
  ok "session B stayed blocked until A committed"
fi

step_a commit "commit;"
await_a commit 10 || fail "session A could not commit"

await_b provision 15 || fail "session B never unblocked after A committed"
B_ORG="$(out_b provision)"
step_b commit "commit;"
await_b commit 10 || fail "session B could not commit"

eq "$B_ORG" "$A_ORG" "both callers received the same organization id"

eq "$(q "select count(*) from public.organizations where provision_request_key = '$KEY'")" "1" \
  "exactly one organization carries the request key"
eq "$(q "select count(*) from public.memberships where organization_id = '$A_ORG' and role = 'owner'")" "1" \
  "exactly one owner membership"
eq "$(q "select count(*) from public.organization_onboarding where organization_id = '$A_ORG'")" "1" \
  "exactly one onboarding row"
eq "$(q "select count(*) from public.audit_events where entity_id = '$A_ORG' and event_type = 'organization.created'")" "1" \
  "exactly one organization.created event"

session_clean a && ok "session A transcript is clean"
session_clean b && ok "session B transcript is clean"

# A third caller who does not own the key is refused, and the message names no
# organization. Run as a one-shot: there is nothing to interleave.
cat > "$WORK/foreign.sql" <<SQL
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"$OTHER","role":"authenticated"}';
select public.provision_organization('$NAME', 'Restaurant group', 'UTC', 'en-US', '$KEY'::uuid, 'in_app');
rollback;
SQL
FOREIGN_OUT="$(psql "$DB_URL" -X -q -A -t -f "$WORK/foreign.sql" 2>&1)"
case "$FOREIGN_OUT" in
  *"could not be completed"*) ok "a request key owned by somebody else is refused" ;;
  *) fail "a foreign request key was not refused: $FOREIGN_OUT" ;;
esac
case "$FOREIGN_OUT" in
  *"$A_ORG"*) fail "the refusal disclosed the organization id" ;;
  *) ok "the refusal discloses no organization id" ;;
esac

close_sessions

# --------------------------------------------------------------------------
# Race 2 — two submissions mapping the same listing
#
# The failure this rules out is the one that matters most for D200: two clicks
# on Save producing two locations for one Google listing, each bound to half
# the mapping. A holds; B must park on the profile row lock taken by A's
# `on conflict do update`; when A commits, B's replay arm must return A's
# location rather than creating a second.
# --------------------------------------------------------------------------

round "mapping convergence"

EXTERNAL="race-listing-$(q "select substr(gen_random_uuid()::text, 1, 8)")"
PROFILES="[{\"externalProfileId\":\"$EXTERNAL\",\"externalProfileName\":\"Race Listing\",\"profileUrl\":null,\"externalAccountId\":\"accounts/race\",\"verificationState\":null,\"providerMetadata\":{}}]"

open_a
open_b

step_a begin "begin; $(become "$ACTOR")"
await_a begin 10 || fail "session A could not begin"

step_a map \
  "select location_id from public.create_and_map_location('$CONN'::uuid, '$PROFILES'::jsonb, 'Race Restaurant', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');"
await_a map 10 || fail "session A's mapping never returned"
A_LOC="$(out_a map)"
check $([ -n "$A_LOC" ] && echo 0 || echo 1) "session A created and mapped a location"

step_b begin "begin; $(become "$ACTOR")"
await_b begin 10 || fail "session B could not begin"

step_b map \
  "select location_id, replayed from public.create_and_map_location('$CONN'::uuid, '$PROFILES'::jsonb, 'Race Restaurant', '1 A St', null, 'New York', 'NY', '10001', 'US', 'America/New_York');"

if await_blocked "create_and_map_location" 10; then
  ok "session B is parked on the profile row lock (pg_stat_activity)"
else
  fail "session B never blocked — the profile lock is not serialising callers"
fi

if await_b map 2; then
  fail "session B returned while A still held its transaction"
else
  ok "session B stayed blocked until A committed"
fi

step_a commit "commit;"
await_a commit 10 || fail "session A could not commit"

await_b map 15 || fail "session B never unblocked after A committed"
B_MAP="$(out_b map)"
step_b commit "commit;"
await_b commit 10 || fail "session B could not commit"

case "$B_MAP" in
  "$A_LOC"*) ok "session B converged on session A's location" ;;
  *) fail "session B returned a different location: $B_MAP" ;;
esac
case "$B_MAP" in
  *"|t") ok "session B reported itself as a replay" ;;
  *) fail "session B did not report replayed = true: $B_MAP" ;;
esac

eq "$(q "select count(*) from public.locations where organization_id = '$ORG' and name = 'Race Restaurant'")" "1" \
  "exactly one location was created for the listing"
eq "$(q "select count(*) from public.platform_profiles where platform_connection_id = '$CONN' and external_profile_id = '$EXTERNAL'")" "1" \
  "exactly one platform profile exists for the listing"
eq "$(q "select count(*) from public.audit_events where entity_id = '$A_LOC' and event_type = 'location.created_from_integration'")" "1" \
  "exactly one location.created_from_integration event"
eq "$(q "select count(*) from public.audit_events where organization_id = '$ORG' and event_type = 'integration.profile_connected'")" "1" \
  "exactly one integration.profile_connected event"
eq "$(q "select count(*) from public.audit_events where organization_id = '$ORG' and event_type = 'integration.profile_mapped'")" "1" \
  "exactly one integration.profile_mapped event"
eq "$(q "select location_id from public.platform_profiles where platform_connection_id = '$CONN' and external_profile_id = '$EXTERNAL'")" "$A_LOC" \
  "the profile is bound to the one location"

session_clean a && ok "session A transcript is clean"
session_clean b && ok "session B transcript is clean"

close_sessions

# --------------------------------------------------------------------------

say ""
if [ "$FAILURES" -eq 0 ]; then
  say "tenancy race harness: all checks passed"
  exit 0
fi
say "tenancy race harness: $FAILURES check(s) failed"
exit 1
