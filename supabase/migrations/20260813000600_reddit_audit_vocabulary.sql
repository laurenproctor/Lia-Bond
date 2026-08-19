-- Reddit monitoring, community policy, and publication audit vocabulary
-- (Task 3 of the Reddit plan).
--
-- Redefines `audit_events_known_event_type` in full: Postgres has no "add a
-- value to a check constraint" statement, and a partial redefinition silently
-- drops every value it omits (see 20260807000700_audit_vocabulary_merge.sql).
-- `tests/audit-vocabulary-migrations.test.ts` pins this list against
-- `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`, which is why the whole current
-- list is carried forward below rather than only the additions.
--
-- Reddit sharpens the standing rule that audit metadata carries no content.
-- Two Reddit-specific things are named here because they are not obviously
-- "content" and would otherwise look safe to record:
--
--   * a monitor's search terms are the customer's own words about their brand,
--     and a trail of them is a trail of what a restaurant is worried about;
--   * a subreddit name is not Reddit's content, but a community a customer is
--     watching is still a fact about that customer, and the audit trail is not
--     where it belongs when the monitor row already holds it.
--
-- New entity types land alongside, for the same reason and in the same shape.

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
      'onboarding.ready_viewed',
      -- Reddit monitoring. Metadata carries counts, identifiers, and
      -- normalised codes — never a post or comment body, never a subreddit
      -- name typed by a person into a query, never a Reddit username, and
      -- never a monitor's search terms, which are the customer's own words
      -- about their brand.
      'reddit_monitor.created',
      'reddit_monitor.updated',
      'reddit_monitor.deleted',
      'reddit_monitor.polled',
      'reddit_monitor.poll_failed',
      -- A person's recorded decision about whether Lia may reply in one
      -- community, and the automatic return to review when its rules change
      -- under a previously granted approval.
      'reddit_community.decision_recorded',
      'reddit_community.review_required',
      -- Content that stopped existing at the source. Written by the removal
      -- contract, and carrying Lia's own row ids and a reason code only: an
      -- audit row about deleted content that quoted it would defeat itself.
      'reddit_content.removed',
      'reddit_content.reconciled',
      -- Publication. The response lifecycle's public half: claiming the right
      -- to post, the outcome, the uncertain outcome that must be reconciled
      -- against the connected account's own history rather than retried, and
      -- a retraction. No draft text, no provider message, no Reddit content.
      'response.published',
      'response.publish_failed',
      'response.publish_reconciled',
      'response.retracted'
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, reviewer names, article titles, URLs, publisher names, Reddit post or comment text, Reddit usernames, subreddit names, or monitor search terms in metadata.';

-- ---------------------------------------------------------------------------
-- Entity types.
--
-- `audit_entity_type` is a Postgres enum rather than a check constraint, so
-- these are additive and irreversible: a value cannot be dropped, and a
-- rollback is an application revert that stops emitting it.
--
-- Three new subjects, because "which thing did this happen to" has three
-- genuinely different answers here, and collapsing any of them onto an
-- existing type would make the trail unqueryable in exactly the case somebody
-- needs it. A Reddit monitor is not a `monitoring_query` — different table,
-- different lifecycle, different owner. A community posture is not a
-- `platform_connection` — it is a decision about somebody else's rules, not
-- about Lia's access. A publication attempt is not a `response_draft` — the
-- draft is the words, the attempt is the act of publishing them, and the whole
-- point of separating them is that one draft can have several attempts.
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value if not exists 'reddit_monitoring_query';
alter type audit_entity_type add value if not exists 'reddit_community_posture';
alter type audit_entity_type add value if not exists 'response_publication_attempt';
