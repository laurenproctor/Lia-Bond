-- ---------------------------------------------------------------------------
-- Separate "Google has granted this project no quota" from "Google is
-- throttling us".
--
-- Both arrive as RESOURCE_EXHAUSTED and both were recorded as 'quota_limited',
-- which made them indistinguishable in the one place an operator would look.
-- They are not the same event: throttling clears itself, and a zero quota —
-- the default for the Business Profile APIs until Google approves an access
-- application — never does. A connection in that state fetches nothing, ever,
-- while reporting a transient-sounding health status.
--
-- Mirrors CONNECTION_HEALTH_STATUSES in src/domain/enums.ts.
-- ---------------------------------------------------------------------------

-- Added after 'quota_limited' to keep the enum's ordering meaningful: the two
-- quota outcomes sit together, ahead of the non-quota failures.
alter type connection_health_status
  add value if not exists 'quota_not_provisioned' after 'quota_limited';

comment on type connection_health_status is
  'Outcome of a connection health check. Mirrors CONNECTION_HEALTH_STATUSES in '
  'src/domain/enums.ts. quota_limited is transient throttling; '
  'quota_not_provisioned is a project Google has granted no quota at all, which '
  'does not resolve without an approved API access application.';

-- No backfill. Existing 'quota_limited' rows are not safely reclassifiable —
-- the distinguishing signal lives in a Google error body that was never
-- stored — and the next health check overwrites the row with a correctly
-- classified value anyway.
