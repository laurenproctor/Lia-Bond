-- ---------------------------------------------------------------------------
-- Poll-run audit vocabulary
--
-- Workflow 06's poll service (Task 10) is the first thing that writes an
-- audit event for a monitoring query. Two closed-list additions it needs:
-- an entity type for the query a run concerns, and event types for how the
-- run ended. Mirrors AUDIT_ENTITY_TYPES and AUDIT_EVENT_TYPES in
-- src/domain/enums.ts.
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value 'monitoring_query';

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
      'monitoring_query.poll_failed'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, reviewer names, article titles, URLs, or publisher names in metadata.';
