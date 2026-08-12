-- Add audit event vocabulary for response generation (Task 1 of the
-- response-generation plan).
--
-- Redefines `audit_events_known_event_type` in full: Postgres has no "add a
-- value to a check constraint" statement, and a partial redefinition silently
-- drops every value it omits (see 20260807000700_audit_vocabulary_merge.sql).
-- `tests/audit-vocabulary-migrations.test.ts` pins this list against
-- `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`.
--
-- The two new literals below (`response.generated`, `response.changes_requested`)
-- are written by the generation worker (Task 6) and `decideResponseDraftAction`
-- (`src/app/actions/responses.ts`) respectively; `response.changes_requested`
-- replaces `response.rejected` going forward, which stays listed for history
-- only — nothing writes it anymore.

alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      'mention.status_changed',
      'response.assigned',
      'response.approved',
      'response.rejected',
      -- Generation. Metadata carries counts, a model name, a prompt version,
      -- and a normalised error/failure category — never review text, never
      -- the response text, and never the prompt.
      'response.generated',
      -- The live decision outcome for "not approved": a draft returned to
      -- the writer with a decision note, as opposed to the old terminal
      -- 'response.rejected', which nothing emits anymore.
      'response.changes_requested',
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
      -- Rule execution (G1). These are written by the automation execution
      -- functions and subsume the rule's effect on a mention batch, as
      -- opposed to rule edits.
      'automation_rule.executed',
      'automation_rule.execution_failed',
      -- Sweep lifecycle: recording that an execution pass ran (once per hour,
      -- typically), regardless of whether any rules executed.
      'automation_sweep.completed',
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
