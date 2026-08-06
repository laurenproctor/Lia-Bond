-- Restore the audit vocabulary lost when three branches were integrated.
--
-- `audit_events_known_event_type` is a closed list that each workflow redefines
-- in full rather than extending, because Postgres has no "add a value to a
-- check constraint" statement. That is fine on one line of history and wrong
-- the moment there are three: membership provisioning (20260805000100) and
-- brand voice (20260806000300) each added their events to the list as it stood
-- on their own branch, and news monitoring (20260807000200) — developed in
-- parallel, from a commit that predated both — redefined the constraint from a
-- copy that had never seen either.
--
-- Migrations run in filename order, so the news redefinition lands last and
-- silently drops eight event types that the application still emits. Nothing
-- about that is visible in a diff of any single branch; it exists only in the
-- union. The first `insert into audit_events` for a membership change or a
-- brand voice edit would fail the check constraint in production.
--
-- This migration is the union of all three lists and must stay the last word
-- on the constraint. `tests/audit-vocabulary-migrations.test.ts` asserts the
-- final definition matches `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`, which
-- is what turned this up.

alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      'escalation.assigned',
      'escalation.status_changed',
      'automation_rule.enabled',
      'automation_rule.disabled',
      'location.manager_changed',
      -- Integration lifecycle. None of these may carry tokens, authorization
      -- codes, or state values.
      'integration.oauth_started',
      'integration.oauth_completed',
      'integration.connected',
      'integration.reauthorization_started',
      'integration.reauthorized',
      'integration.health_checked',
      'integration.health_degraded',
      'integration.profile_connected',
      'integration.profile_mapped',
      'location.created_from_integration',
      'integration.disconnected',
      'integration.credentials_revoked',
      'integration.credentials_revocation_failed',
      -- Review synchronisation. Metadata carries counts and a normalised error
      -- code — never review text, never a reviewer's name, never a token.
      'integration.reviews_synced',
      'integration.review_sync_failed',
      -- Analysis. Metadata carries counts, a model name, a prompt version, and
      -- a normalised error code — never the prompt, which contains both the
      -- review text and the reviewer's name.
      'mention.analyzed',
      'mention.analysis_failed',
      'escalation.created_from_analysis',
      -- Membership. Metadata carries roles, statuses, and email addresses —
      -- never an invitation token, which would turn the audit trail into a way
      -- in. Restored here: dropped by 20260807000200.
      'organization.created',
      'membership.invited',
      'membership.invitation_revoked',
      'membership.joined',
      'membership.role_changed',
      'membership.status_changed',
      'membership.removed',
      -- Brand voice. Restored here: dropped by 20260807000200.
      'brand_voice.updated',
      -- News polling. Metadata carries counts and a normalised error code —
      -- never an article title, a URL, or a publisher name.
      'monitoring_query.polled',
      'monitoring_query.poll_failed',
      -- Monitoring query lifecycle. Metadata and previous/new state carry the
      -- query's own configuration (keywords, domains, thresholds) — never
      -- article content, which the query has no relationship to until a poll
      -- runs.
      'monitoring_query.created',
      'monitoring_query.updated',
      'monitoring_query.deleted'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, reviewer names, article titles, URLs, or publisher names in metadata.';
