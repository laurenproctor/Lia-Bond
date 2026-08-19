-- Audit vocabulary for Yelp Assisted.
--
-- Redefines `audit_events_known_event_type` in full: Postgres cannot extend a
-- check constraint, so every migration that adds an event name has to restate
-- the whole list. That is why `tests/audit-vocabulary-migrations.test.ts`
-- parses these files with the real Postgres grammar and compares the result
-- against `AUDIT_EVENT_TYPES` in both directions — the failure mode this
-- guards against is a redefinition assembled from a stale copy, which silently
-- drops event types the application still emits (D93).
--
-- Six new events, and the naming of each one is the point:
--
--   * `integration.listing_checked` / `..._failed` rather than reusing
--     `integration.reviews_synced`. Nothing was synced. Sharing the name would
--     make a Yelp counter check and a Google review import indistinguishable in
--     any query over the trail, which is exactly the conflation this whole
--     feature is arranged to avoid.
--   * `yelp_activity.detected` describes a change in a counter, not a review.
--     Its metadata carries the before and after numbers and the kind of change,
--     and there is deliberately no metadata key for a number of new reviews —
--     the counters cannot support one.
--   * `mention.captured_manually` records that a person typed a review in. The
--     metadata carries the derived deduplication key and whether a duplicate
--     warning was overridden; never the review text, matching every other
--     mention event.
--   * `response.publication_confirmed` / `..._unconfirmed`. The second is a
--     correction, not a retraction: a retraction means a published reply was
--     taken down from the platform, and this means the reply was never posted
--     and Lia's record was wrong. Naming them the same thing would put
--     "we removed a bad reply" and "somebody mis-clicked" in one bucket, and
--     the first is the one that has to be provable later.

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
      -- Assisted posting. A person stating they posted an approved response on
      -- a platform Lia cannot reach, and the correction path for somebody who
      -- said so by mistake. Neither claims provider verification; the metadata
      -- names the publication method so a reader cannot mistake one for an API
      -- publication.
      'response.publication_confirmed',
      'response.publication_unconfirmed',
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
      -- Yelp Assisted listing checks. Attributed to the platform_profile that
      -- was checked, matching 'integration.reviews_synced': "which
      -- restaurant's listing moved" is the question an auditor has. Metadata
      -- carries the two counters, a normalised error code, and nothing else.
      'integration.listing_checked',
      'integration.listing_check_failed',
      -- A change Lia observed between two listing checks. Never a claim about
      -- how many reviews were written.
      'yelp_activity.detected',
      -- A review a person typed into Lia. Metadata carries the source, the
      -- rating, the derived deduplication key, and whether a duplicate warning
      -- was deliberately overridden — never the review text.
      'mention.captured_manually',
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
  'Closed list of audit event names. Every migration that adds one restates the whole list, because Postgres cannot extend a check constraint — tests/audit-vocabulary-migrations.test.ts pins this against AUDIT_EVENT_TYPES in both directions so a redefinition assembled from a stale copy cannot silently drop an event the application still emits.';

-- ---------------------------------------------------------------------------
-- Entity type.
--
-- `audit_entity_type` is a Postgres enum rather than a check constraint, so a
-- new value is added rather than the list being restated. `if not exists`
-- because a rerun on a partially-migrated database must not fail.
--
-- Its own subject rather than `platform_profile`, because "what happened to
-- this listing connection" and "what did Lia observe about it on Tuesday" are
-- different questions — an auditor asking the second would otherwise have to
-- read every event on the profile to find the observations among them.
-- ---------------------------------------------------------------------------

alter type audit_entity_type add value if not exists 'yelp_activity_occurrence';

-- Rollback note: Postgres enums cannot have values removed, and a check
-- constraint's previous definition is not recoverable from the catalog. Rolling
-- this back means a forward-repair migration restating the prior list; the
-- enum value simply stops being written. See the rollback section of
-- docs/integrations/yelp-assisted.md.
