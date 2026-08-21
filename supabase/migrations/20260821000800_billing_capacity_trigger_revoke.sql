-- Complete the EXECUTE revoke on the billing definer functions.
--
-- `20260821000600` revoked `public, authenticated, anon` from eight functions
-- and missed the ninth: `enforce_location_capacity()`, the trigger function
-- itself. It is `security definer` like the rest, so it picked up the implicit
-- PUBLIC grant and Supabase's `alter default privileges` grant to `anon` and
-- `authenticated` — exactly the gap that migration's own header describes, in
-- the one function whose name is not in its revoke list.
--
-- **The practical exposure is nil, and that is not the reason to fix it.** A
-- function returning `trigger` cannot be invoked from SQL ("trigger functions
-- can only be called as triggers") and PostgREST does not expose one as an
-- RPC, so there was never a call path. What is wrong is the posture: this
-- schema's rule is that a definer function holds no grant it does not need,
-- asserted rather than assumed, and an exception that happens to be
-- unreachable today is an exception the next person has to re-derive.
--
-- Found by reading the hosted grants back after `db push` rather than by the
-- harness, which checked three functions by name and therefore could not see
-- a fourth. `supabase/tests/billing-verification.sql` now enumerates every
-- definer function in the billing set instead of naming a sample — the same
-- reasoning that put `count_billable_locations` in the revoke list in the
-- first place.

revoke execute on function public.enforce_location_capacity()
  from public, authenticated, anon;

comment on function public.enforce_location_capacity is
  'Refuses a location that would exceed purchased capacity. Takes a row lock on organization_billing so concurrent creation cannot both pass the same check. Fails open where no capacity has been purchased. Reachable only as a trigger: EXECUTE is revoked from public, authenticated, and anon.';
