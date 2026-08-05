-- ---------------------------------------------------------------------------
-- Monitoring-query write vocabulary
--
-- Task 11's server actions are the first thing that writes an audit event for
-- creating, editing, or removing a monitoring query, rather than for a poll
-- run against one. Three more closed-list additions, mirroring the same three
-- values added to AUDIT_EVENT_TYPES in src/domain/enums.ts. No new entity
-- type: `monitoring_query` already exists on audit_entity_type, added by
-- 20260807000100_news_poll_audit.sql.
-- ---------------------------------------------------------------------------

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
