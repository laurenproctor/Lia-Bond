-- Restore the two location event types the Yelp vocabulary migration dropped.
--
-- Not a new feature: `location.updated` and `location.status_changed` are
-- already emitted by the locations screens and already listed in
-- `AUDIT_EVENT_TYPES`. They were added by 20260814000400, which sorts *before*
-- 20260818000300_yelp_audit_vocabulary.sql — and that migration restates the
-- whole check constraint from a list assembled before this branch existed.
-- Applying both in filename order therefore leaves a constraint that rejects
-- two events the application still writes, and every location edit would fail
-- with a 23514 in production.
--
-- This is precisely the stale-copy failure the Yelp migration's own header
-- warns about (D93). It only appeared when the branch was rebased onto a base
-- that already carried the Yelp work, because the ordering that produces it
-- does not exist on either branch alone.
--
-- The list below is generated from `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`
-- rather than hand-merged from the two prior migrations, so it cannot itself be
-- a stale copy. `tests/audit-vocabulary-migrations.test.ts` replays every
-- migration in filename order and compares the final permitted set against that
-- same array in both directions, which is what fails if this drifts again.

alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      'response.generated',
      'response.changes_requested',
      'response.edited',
      'escalation.assigned',
      'escalation.status_changed',
      'automation_rule.enabled',
      'automation_rule.disabled',
      'automation_rule.created',
      'automation_rule.updated',
      'automation_rule.duplicated',
      'automation_rule.archived',
      'automation_rule.simulated',
      'automation_rule.activation_refused',
      'automation_rule.executed',
      'automation_rule.execution_failed',
      'automation_sweep.completed',
      'location.manager_changed',
      'location.created',
      'location.updated',
      'location.status_changed',
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
      'integration.reviews_synced',
      'integration.review_sync_failed',
      'mention.analyzed',
      'mention.analysis_failed',
      'escalation.created_from_analysis',
      'organization.created',
      'membership.invited',
      'membership.invitation_revoked',
      'membership.joined',
      'membership.role_changed',
      'membership.status_changed',
      'membership.removed',
      'brand_voice.updated',
      'monitoring_query.polled',
      'monitoring_query.poll_failed',
      'monitoring_query.created',
      'monitoring_query.updated',
      'monitoring_query.deleted',
      'onboarding.started',
      'onboarding.organization_completed',
      'onboarding.source_connected',
      'onboarding.source_skipped',
      'onboarding.locations_completed',
      'onboarding.locations_skipped',
      'onboarding.brand_voice_completed',
      'onboarding.team_completed',
      'onboarding.team_skipped',
      'onboarding.completed',
      'onboarding.ready_viewed',
      'integration.listing_checked',
      'integration.listing_check_failed',
      'yelp_activity.detected',
      'mention.captured_manually',
      'response.publication_confirmed',
      'response.publication_unconfirmed',
      'reddit_monitor.created',
      'reddit_monitor.updated',
      'reddit_monitor.deleted',
      'reddit_monitor.polled',
      'reddit_monitor.poll_failed',
      'reddit_community.decision_recorded',
      'reddit_community.review_required',
      'reddit_content.removed',
      'reddit_content.reconciled',
      'response.published',
      'response.publish_failed',
      'response.publish_reconciled',
      'response.retracted'
    )
  );

-- No entity-type change. `audit_entity_type` is a Postgres enum and its values
-- are added with `add value if not exists`, which is additive — unlike the
-- check constraint above, a later migration cannot drop an earlier one's value,
-- so the location entity types added by 20260814000400 survived this ordering
-- untouched.
