-- Rule authoring: revisions, simulation readiness, recoverable archiving,
-- and the authoring/simulation audit vocabulary.

alter table public.automation_rules
  add column revision integer not null default 1
    check (revision >= 1),
  add column last_simulated_at timestamptz,
  add column simulated_revision integer
    check (simulated_revision is null or simulated_revision >= 1),
  add column archived_at timestamptz;

comment on column public.automation_rules.revision is
  'Bumped on every structural edit. Optimistic-concurrency token; simulated_revision must equal it for activation.';
comment on column public.automation_rules.last_simulated_at is
  'When the rule was last simulated. Display only; readiness is simulated_revision = revision.';
comment on column public.automation_rules.simulated_revision is
  'The revision that was simulated. Editing bumps revision, which makes a prior simulation stale.';
comment on column public.automation_rules.archived_at is
  'Recoverable archive. Archived rules are hidden from the default list; history is preserved. There is no delete.';

-- Audit vocabulary: redefine in full (Postgres cannot extend a check
-- constraint; see 20260807000700_audit_vocabulary_merge.sql).
-- tests/audit-vocabulary-migrations.test.ts pins this list against
-- AUDIT_EVENT_TYPES in src/domain/enums.ts.
alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      -- A person changed a draft's final text. previousState/newState carry
      -- text lengths only — response text embeds customer situations, and the
      -- trail records that an edit happened, not the prose.
      'response.edited',
      'escalation.assigned',
      'escalation.status_changed',
      'automation_rule.enabled',
      'automation_rule.disabled',
      -- Rule authoring. previousState/newState carry the rule's own
      -- configuration — conditions, actions, priority — never mention
      -- content. automation_rule.simulated metadata carries counts only.
      'automation_rule.created',
      'automation_rule.updated',
      'automation_rule.duplicated',
      'automation_rule.archived',
      'automation_rule.simulated',
      'automation_rule.activation_refused',
      'location.manager_changed',
      -- A location a person typed in, as opposed to one discovered through an
      -- integration. Kept apart from 'location.created_from_integration'.
      'location.created',
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
      -- Onboarding. Progress metadata only: step names, whether a step was
      -- skipped, and counts. Never a token, an account name, or review text.
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
      'onboarding.ready_viewed'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, reviewer names, article titles, URLs, or publisher names in metadata.';
