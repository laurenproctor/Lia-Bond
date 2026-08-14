-- Add audit event vocabulary for location administration.
--
-- Redefines `audit_events_known_event_type` in full: Postgres has no "add a
-- value to a check constraint" statement, and a partial redefinition silently
-- drops every value it omits (see 20260807000700_audit_vocabulary_merge.sql,
-- where exactly that cost eight event types on a three-branch merge).
-- `tests/audit-vocabulary-migrations.test.ts` parses this file with
-- libpg-query and pins the list against `AUDIT_EVENT_TYPES` in
-- `src/domain/enums.ts`, failing in both directions — so this migration and
-- the enum change land in one commit or neither does.
--
-- Two new literals, both written by `updateLocationAction`
-- (`src/app/actions/locations.ts`):
--
--   location.updated         identity, address, slug, timezone
--   location.status_changed  lifecycle
--
-- They are separate from each other and from the existing
-- `location.manager_changed` because they answer different questions for
-- different readers — "somebody retired this restaurant", "somebody handed it
-- to Priya", and "somebody fixed a typo in the address". The action emits only
-- the ones whose fields actually changed, so a manager-only edit writes one
-- event rather than two.
--
-- This file must remain the last word on `audit_events_known_event_type`: any
-- later migration redefining it has to start from this list.

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
      -- Identity, address, slug, and timezone edits, and nothing else.
      -- Deliberately NOT emitted for a status or manager change: those have
      -- their own events, and a generic event that also fired for them would
      -- make 'who changed this restaurant's address' unanswerable.
      'location.updated',
      -- Lifecycle only: setup / active / review / inactive. A reporting and
      -- retirement state, not a processing switch — nothing in the product
      -- pauses collection or analysis on the strength of it.
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
