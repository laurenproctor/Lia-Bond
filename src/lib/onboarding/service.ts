import "server-only";

import type {
  AuditEventType,
  OnboardingWizardStep,
  OrganizationOnboarding,
  OrganizationSize,
  UpdateOnboardingOrganizationInput,
} from "@/domain";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

/**
 * Onboarding transitions, with their audit trail.
 *
 * Separate from the actions for the reason `saveBrandVoice` and
 * `analyzeMentions` are: the ordering that matters — persist, then record what
 * moved — lives here once, so a future caller gets identical behaviour rather
 * than a second implementation of it.
 *
 * **Nothing recorded here may carry a credential.** Onboarding sits directly on
 * top of an OAuth grant and an invitation issuer, which are the two most
 * valuable things in the product to leak into a log. The metadata each event
 * carries is listed on the function that writes it, and it is always the same
 * three shapes: a step name, a boolean, or a count.
 *
 * Callers have already passed `authorize("onboarding.manage")`. No function
 * here performs a role check of its own.
 */

export interface OnboardingServiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

/** Every transition writes one event, and the map is the whole vocabulary. */
const STEP_EVENTS: Record<
  OnboardingWizardStep,
  { completed: AuditEventType; skipped: AuditEventType | null }
> = {
  organization: { completed: "onboarding.organization_completed", skipped: null },
  connect_sources: {
    completed: "onboarding.source_connected",
    skipped: "onboarding.source_skipped",
  },
  locations: {
    completed: "onboarding.locations_completed",
    skipped: "onboarding.locations_skipped",
  },
  brand_voice: { completed: "onboarding.brand_voice_completed", skipped: null },
  team: { completed: "onboarding.team_completed", skipped: "onboarding.team_skipped" },
};

/**
 * Record a progress event.
 *
 * Attributed to `entityType: "organization"` with the organization's own id.
 * Onboarding is a property of an organization rather than a thing in its own
 * right, so it needs no entity type of its own — and adding one would need an
 * `ALTER TYPE`, which cannot run in the transaction that first writes the value.
 */
async function recordProgress(
  context: OnboardingServiceContext,
  eventType: AuditEventType,
  before: OrganizationOnboarding | null,
  after: OrganizationOnboarding,
  metadata: Record<string, string | number | boolean> = {},
): Promise<void> {
  const changes = before
    ? diff(
        { status: before.status, currentStep: before.currentStep },
        { status: after.status, currentStep: after.currentStep },
        ["status", "currentStep"],
      )
    : { previousState: null, newState: { status: after.status, currentStep: after.currentStep } };

  await recordAuditEvent(context, {
    eventType,
    entityType: "organization",
    entityId: context.scope.organizationId,
    previousState: changes.previousState,
    newState: changes.newState,
    metadata,
  });
}

/**
 * Ensure the organization has an onboarding row, and record that setup began.
 *
 * The row normally arrives with the organization, from inside
 * `provision_organization`. This covers the organization created before that
 * function wrote one — reachable only by an operator, but reachable.
 */
export async function startOnboarding(
  context: OnboardingServiceContext,
): Promise<OrganizationOnboarding> {
  const existing = await context.dataSource.onboarding.get(context.scope);
  if (existing) return existing;

  const created = await context.dataSource.onboarding.create(context.scope);
  await recordProgress(context, "onboarding.started", null, created);
  return created;
}

/**
 * Step 1: the organization's own details, plus its size.
 *
 * Two writes that are not one transaction — the organization row and the
 * onboarding row live in different tables and the repository interface has no
 * transaction to open (D17: only a Postgres function body has one, and adding a
 * function for this would make the demo adapter untestable).
 *
 * The order is what makes the split safe. The organization is written first, so
 * a crash between the two leaves the details saved and the step unmarked: the
 * person returns to step 1, sees their own answers prefilled from the
 * organization they already updated, and presses the button again. The reverse
 * order would mark the step complete over details that were never saved, and
 * they would never be asked again.
 */
export async function completeOrganizationStep(
  context: OnboardingServiceContext,
  input: UpdateOnboardingOrganizationInput,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);

  await context.dataSource.organizations.update(context.scope, {
    name: input.name,
    websiteUrl: input.websiteUrl,
    industry: input.industry,
    defaultTimezone: input.defaultTimezone,
    defaultLanguage: input.defaultLanguage,
  });

  const size: OrganizationSize | null = input.organizationSize ?? null;
  const after = await context.dataSource.onboarding.completeOrganizationStep(
    context.scope,
    size,
  );

  // Industry, timezone, and language are the organization's own configuration
  // and are safe to record. The name is not included: `organizations.name` is
  // customer-identifying and the audit trail already names the organization by
  // id, so repeating it would add nothing an auditor needs.
  await recordProgress(context, STEP_EVENTS.organization.completed, before, after, {
    industry: input.industry,
    timezone: input.defaultTimezone,
    language: input.defaultLanguage,
    hasWebsite: input.websiteUrl !== null,
    organizationSize: size ?? "",
  });

  return after;
}

/**
 * Step 2, completed: a source is connected.
 *
 * Called after the OAuth callback has already stored the connection, so this
 * only records the step. No account name, no account id, and above all no token
 * reaches the event — `integration.connected` already records the connection
 * itself, and duplicating its identity here would put the same value in two
 * places for no gain.
 */
export async function completeSourceStep(
  context: OnboardingServiceContext,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.completeSourceStep(context.scope);
  await recordProgress(context, STEP_EVENTS.connect_sources.completed, before, after);
  return after;
}

/** Step 2, skipped: continue without connecting anything. */
export async function skipSourceStep(
  context: OnboardingServiceContext,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.skipSourceStep(context.scope);
  await recordProgress(context, "onboarding.source_skipped", before, after);
  return after;
}

/**
 * Step 3, completed.
 *
 * The counts are the point of this event: "how many locations did they set up
 * on day one" is the question that explains a support ticket three weeks later.
 * They are numbers, never names or addresses.
 */
export async function completeLocationsStep(
  context: OnboardingServiceContext,
  counts: { mapped: number; created: number },
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.completeLocationsStep(context.scope);
  await recordProgress(context, STEP_EVENTS.locations.completed, before, after, {
    mappedProfiles: counts.mapped,
    createdLocations: counts.created,
  });
  return after;
}

export async function skipLocationsStep(
  context: OnboardingServiceContext,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.skipLocationsStep(context.scope);
  await recordProgress(context, "onboarding.locations_skipped", before, after);
  return after;
}

/**
 * Step 4.
 *
 * The voice itself was saved by `saveBrandVoice`, which writes its own
 * `brand_voice.updated` event with the diff. This records only that the step
 * was passed, which is why it carries the version rather than the settings.
 */
export async function completeBrandVoiceStep(
  context: OnboardingServiceContext,
  brandVoiceVersion: number,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.completeBrandVoiceStep(context.scope);
  await recordProgress(context, STEP_EVENTS.brand_voice.completed, before, after, {
    brandVoiceVersion,
  });
  return after;
}

/**
 * Step 5, completed.
 *
 * `invitationsIssued` is a count. The addresses invited are already recorded by
 * `membership.invited`, one event each, and the tokens are recorded nowhere —
 * an audit trail carrying an invitation token would be a way in rather than a
 * record of one.
 */
export async function completeTeamStep(
  context: OnboardingServiceContext,
  invitationsIssued: number,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.completeTeamStep(context.scope);
  await recordProgress(context, STEP_EVENTS.team.completed, before, after, {
    invitationsIssued,
  });
  return after;
}

export async function skipTeamStep(
  context: OnboardingServiceContext,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.skipTeamStep(context.scope);
  await recordProgress(context, "onboarding.team_skipped", before, after);
  return after;
}

/**
 * Finish setup.
 *
 * The repository refuses when a step is unsettled, so this cannot mark an
 * organization set up whose owner skipped the wizard rather than its steps. The
 * metadata records which steps were skipped rather than completed, because that
 * is exactly what explains an empty inbox to whoever picks up the ticket.
 */
export async function finishOnboarding(
  context: OnboardingServiceContext,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  const after = await context.dataSource.onboarding.completeOnboarding(context.scope);

  // Already finished before this call: the transition did not happen, so
  // recording it would put a second completion in the trail for one setup.
  if (before?.status !== "completed") {
    await recordProgress(context, "onboarding.completed", before, after, {
      sourceSkipped: after.sourceSkippedAt !== null,
      locationsSkipped: after.locationsSkippedAt !== null,
      teamSkipped: after.teamSkippedAt !== null,
    });
  }

  return after;
}

/**
 * Record the first view of the Workspace Ready screen.
 *
 * Only the first: the screen is a useful landing page and gets opened again,
 * and an event per visit would bury the one that matters.
 */
export async function markReadyViewed(
  context: OnboardingServiceContext,
): Promise<OrganizationOnboarding> {
  const before = await context.dataSource.onboarding.get(context.scope);
  if (before?.readyViewedAt) return before;

  const after = await context.dataSource.onboarding.markReadyViewed(context.scope);
  await recordProgress(context, "onboarding.ready_viewed", before, after);
  return after;
}
