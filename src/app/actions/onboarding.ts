"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  createLocationInputSchema,
  INVITABLE_ROLES,
  INVITATION_TTL_DAYS,
  ONBOARDING_READY_PATH,
  onboardingNewsMonitoringInputSchema,
  updateBrandVoiceInputSchema,
  updateOnboardingOrganizationInputSchema,
  type MonitoringQuery,
  type OrganizationOnboarding,
} from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationUrl,
} from "@/lib/auth/invitation-token";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit/record";
import { deliverInvitation } from "@/lib/email/invitation-delivery";
import type { InvitationDeliveryStatus } from "@/lib/email/invitation-message";
import { saveBrandVoice } from "@/lib/brand-voice/save";
import { appOrigin } from "@/lib/env";
import { conflict, DataError } from "@/lib/data/errors";
import {
  completeBrandVoiceStep,
  completeLocationsStep,
  completeOrganizationStep,
  completeSourceStep,
  completeTeamStep,
  finishOnboarding,
  markReadyViewed,
  skipLocationsStep,
  skipSourceStep,
  skipTeamStep,
} from "@/lib/onboarding/service";
import { syncGoogleReviews } from "@/lib/integrations/google-reviews";
import {
  saveGoogleLocationMappings,
  saveMappingsInputSchema,
} from "@/lib/integrations/google-mapping";
import {
  ensureOnboardingLocationQueries,
  saveOnboardingNewsQuery,
} from "@/lib/onboarding/news";
import { can } from "@/lib/auth/permissions";
import { NEWS_ERROR_MESSAGES } from "@/lib/monitoring/poll-service";
import { NewsError } from "@/news/errors";
import type { NewsMonitor } from "@/news/monitor";
import { getNewsMonitor } from "@/news/registry";

/**
 * Onboarding server actions.
 *
 * Thin, like every other action in this directory: validate, authorise, call
 * the service, audit inside the service, revalidate, return a typed result.
 * Nothing here talks to a platform API directly and nothing returns a
 * credential.
 *
 * Redirects are performed by the **caller**, not here. Every one of these
 * returns an `ActionResult` so the client component can show a per-field error
 * on a failure — a `redirect()` inside the action body would make that
 * impossible, because `redirect` throws and there would be no way to distinguish
 * it from a real failure in `runAction`'s catch.
 */

/** Revalidates the whole wizard: the progress strip changes on every step. */
function revalidateOnboarding(): void {
  revalidatePath("/onboarding", "layout");
}

/* -------------------------------------------------------------------------- */
/* Step 1 — organization                                                       */
/* -------------------------------------------------------------------------- */

export async function updateOnboardingOrganizationAction(
  input: unknown,
): Promise<ActionResult<{ nextPath: string }>> {
  return runAction("onboarding.organization", async () => {
    const parsed = updateOnboardingOrganizationInputSchema.parse(input);
    const context = await authorize("onboarding.manage");

    await completeOrganizationStep(context, parsed);

    revalidateOnboarding();
    // The organization's name and timezone are rendered by the app shell and by
    // the locations screen, so both are stale after this.
    revalidatePath("/", "layout");

    return { nextPath: "/onboarding/connect-sources" };
  });
}

/* -------------------------------------------------------------------------- */
/* Step 2 — connect sources                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record that a source is connected and move on.
 *
 * Called from step 2 when Google is *already* connected — the OAuth callback
 * returns to step 3 directly, so this covers somebody who connected earlier
 * (from the integrations screen, or on a previous visit) and is now walking the
 * wizard. It re-reads the connection server-side rather than trusting the
 * button: a client that could mark this step complete without a connection
 * would let anybody past the only step with a real external prerequisite.
 */
export async function completeOnboardingSourceAction(): Promise<
  ActionResult<{ nextPath: string }>
> {
  return runAction("onboarding.source_connected", async () => {
    const context = await authorize("onboarding.manage");

    const connection = await context.dataSource.platformConnections.getByPlatform(
      context.scope,
      "google_business_profile",
    );

    if (!connection || connection.status === "disconnected") {
      throw conflict(
        "No source is connected yet. Connect Google, or continue without connecting.",
      );
    }

    await completeSourceStep(context);
    revalidateOnboarding();

    return { nextPath: "/onboarding/locations" };
  });
}

/**
 * Continue without connecting anything.
 *
 * The confirmation happens in the dialog, not here — but the consequence is
 * real and the screen states it: with no connection there is no Google location
 * discovery and no review import, so step 3 falls back to entering a location by
 * hand and the workspace starts empty.
 */
export async function skipOnboardingSourceAction(): Promise<
  ActionResult<{ nextPath: string }>
> {
  return runAction("onboarding.source_skipped", async () => {
    const context = await authorize("onboarding.manage");
    await skipSourceStep(context);
    revalidateOnboarding();
    return { nextPath: "/onboarding/locations" };
  });
}

/**
 * Save the optional News monitoring configuration offered on step 2.
 *
 * Backed entirely by the real monitoring-query architecture: the same input
 * vocabulary (`onboardingNewsMonitoringInputSchema` is a pick of the create
 * schema), the same `createMonitoringQuery` service with its implicit
 * `news_media` connection, and the same audit events. Which persisted query
 * this action edits is decided by `findOnboardingNewsQuery` — the oldest
 * organization-wide brand query — so pressing save five times updates one
 * row rather than creating five.
 *
 * Deliberately does **not** touch onboarding progress. News is optional;
 * only `completeOnboardingSourceAction` / `skipOnboardingSourceAction`
 * settle step 2, and both remain gated on Google alone.
 */
export async function saveOnboardingNewsMonitoringAction(
  input: unknown,
): Promise<ActionResult<MonitoringQuery>> {
  return runAction("onboarding.news_monitoring", async () => {
    const parsed = onboardingNewsMonitoringInputSchema.parse(input);
    // The monitoring permission, not `onboarding.manage`: this writes a
    // monitoring query, and the authority to do that is the same one the News
    // & Media screen requires. Owners and admins — the only roles the wizard
    // admits — hold it.
    const context = await authorize("monitoring.manage_queries");

    // Same translation `resolveMonitor` makes in `actions/monitoring.ts`:
    // Lia's own sentence for the code, never the provider's message.
    let monitor: NewsMonitor;
    try {
      monitor = getNewsMonitor();
    } catch (error) {
      if (error instanceof NewsError) {
        throw new DataError("unavailable", NEWS_ERROR_MESSAGES[error.code]);
      }
      throw error;
    }

    const query = await saveOnboardingNewsQuery(
      context,
      parsed,
      monitor,
      new Date().toISOString(),
    );

    revalidateOnboarding();
    revalidatePath("/integrations/news-media");

    return query;
  });
}

/* -------------------------------------------------------------------------- */
/* Step 3 — locations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort News coverage for the locations step 3 just configured.
 *
 * A side effect of the locations step, never a gate on it: by the time this
 * runs the step has already completed, and no outcome here — including the
 * news monitor being unconfigured on this deployment, or the caller's role
 * lacking the monitoring permission — may surface as a step failure. The
 * real rules (opt-in via the enabled onboarding brand query, one query per
 * uncovered location, never touching existing rows) live in
 * `ensureOnboardingLocationQueries`.
 */
async function ensureLocationMonitoring(
  context: Awaited<ReturnType<typeof authorize>>,
  locationIds: readonly string[],
): Promise<void> {
  if (locationIds.length === 0) return;
  if (!can(context.role, "monitoring.manage_queries")) return;

  try {
    const monitor = getNewsMonitor();
    const outcome = await ensureOnboardingLocationQueries(
      context,
      locationIds,
      monitor,
      new Date().toISOString(),
    );
    if (outcome.created > 0) revalidatePath("/integrations/news-media");
  } catch (error) {
    // Unconfigured news monitoring arrives here as a NewsError; anything
    // else is logged the same way. Either way the locations step stands.
    if (!(error instanceof NewsError)) {
      console.error("[action:onboarding.locations] location monitoring skipped", error);
    }
  }
}

/**
 * Save Google location mappings and mark step 3 complete.
 *
 * Delegates the whole mapping to `saveGoogleLocationMappings`, which is the
 * same service the integrations setup screen uses — including its server-side
 * re-fetch of every selected Google listing. A form field naming a Google
 * location id is a claim, and this action verifies it exactly as that screen
 * does rather than reimplementing the check more loosely because it is
 * onboarding.
 *
 * The step is marked complete only when at least one profile actually mapped.
 * A submission where every row failed has configured nothing, and advancing
 * would leave somebody with an empty workspace and no idea why.
 */
export async function saveOnboardingLocationsAction(
  input: unknown,
): Promise<
  ActionResult<{
    nextPath: string | null;
    mapped: number;
    created: number;
    failures: { externalProfileId: string; message: string }[];
  }>
> {
  return runAction("onboarding.locations", async () => {
    const parsed = saveMappingsInputSchema.parse(input);
    // Two permissions, both required and neither implied by the other: mapping
    // a listing is `integration.manage_profiles`, and advancing setup is
    // `onboarding.manage`.
    await authorize("integration.manage_profiles");
    const context = await authorize("onboarding.manage");

    const result = await saveGoogleLocationMappings(context, parsed);

    const mapped = result.mappedProfiles.length;
    const created = result.createdLocations.length;

    if (mapped === 0) {
      // Nothing took. Reported as a success-shaped result carrying the row
      // failures, so the form can show each one against its row rather than
      // replacing the screen with one generic error.
      return { nextPath: null, mapped, created, failures: result.failures };
    }

    await completeLocationsStep(context, { mapped, created });

    // After the step is settled: News queries for the locations that just
    // arrived, when the organization opted into News monitoring at step 2.
    await ensureLocationMonitoring(context, [
      ...result.createdLocations.map((location) => location.id),
      ...result.mappedProfiles
        .map((profile) => profile.locationId)
        .filter((locationId): locationId is string => locationId !== null),
    ]);

    revalidateOnboarding();
    revalidatePath("/locations");
    revalidatePath("/integrations/google-business-profile");

    return {
      nextPath: "/onboarding/brand-voice",
      mapped,
      created,
      failures: result.failures,
    };
  });
}

/**
 * Create one location by hand and mark step 3 complete.
 *
 * The manual path, reached when step 2 was skipped. Uses the same
 * `createLocationInputSchema` and the same repository method the Google path
 * creates locations through, so a hand-entered location is indistinguishable
 * from a discovered one everywhere downstream.
 */
export async function createOnboardingLocationAction(
  input: unknown,
): Promise<ActionResult<{ nextPath: string; locationId: string }>> {
  return runAction("onboarding.manual_location", async () => {
    const parsed = createLocationInputSchema.parse(input);
    const context = await authorize("onboarding.manage");

    const location = await context.dataSource.locations.create(context.scope, parsed);

    // `location.created`, not `location.created_from_integration`: nothing
    // discovered this location, a person typed it, and an auditor tracing where
    // a restaurant record came from needs those two told apart.
    await recordAuditEvent(context, {
      eventType: "location.created",
      entityType: "location",
      entityId: location.id,
      previousState: null,
      newState: { name: location.name, slug: location.slug, status: location.status },
      metadata: { source: "onboarding_manual" },
    });

    await completeLocationsStep(context, { mapped: 0, created: 1 });

    await ensureLocationMonitoring(context, [location.id]);

    revalidateOnboarding();
    revalidatePath("/locations");

    return { nextPath: "/onboarding/brand-voice", locationId: location.id };
  });
}

export async function skipOnboardingLocationsAction(): Promise<
  ActionResult<{ nextPath: string }>
> {
  return runAction("onboarding.locations_skipped", async () => {
    const context = await authorize("onboarding.manage");
    await skipLocationsStep(context);
    revalidateOnboarding();
    return { nextPath: "/onboarding/brand-voice" };
  });
}

/* -------------------------------------------------------------------------- */
/* Step 4 — brand voice                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Save the voice, then mark step 4 complete.
 *
 * Two writes, and the order is what makes the split safe. The voice is saved
 * first through the existing `saveBrandVoice` service — the same one
 * `/brand-voice` uses, with its own validation and its own audit event — and
 * only then is progress advanced. A crash between them leaves the voice
 * persisted and the step unmarked, so the person returns to a form already
 * carrying their settings and presses the button again. Nobody is ever asked to
 * re-enter a voice they already saved.
 *
 * This is also why resume is safe: the wizard reads the stored profile, so the
 * successfully persisted record is what the screen shows on the way back.
 */
export async function completeOnboardingBrandVoiceAction(
  input: unknown,
): Promise<ActionResult<{ nextPath: string }>> {
  return runAction("onboarding.brand_voice", async () => {
    const parsed = updateBrandVoiceInputSchema.parse(input);
    // Both permissions, for the same reason step 3 needs two: writing the voice
    // and advancing setup are separate authorities.
    await authorize("brand_voice.update");
    const context = await authorize("onboarding.manage");

    const { profile } = await saveBrandVoice(context, parsed);
    await completeBrandVoiceStep(context, profile.version);

    revalidateOnboarding();
    revalidatePath("/brand-voice");

    return { nextPath: "/onboarding/team" };
  });
}

/* -------------------------------------------------------------------------- */
/* Step 5 — invite team                                                        */
/* -------------------------------------------------------------------------- */

const teammateSchema = z.object({
  email: z.email("Enter a valid work email address."),
  role: z.enum(INVITABLE_ROLES, { message: "Choose a role." }),
});

const inviteTeamSchema = z.object({
  // Bounded: the wizard is not a bulk import tool, and an unbounded array here
  // would be an unbounded number of invitation rows from one submission.
  teammates: z.array(teammateSchema).max(20, "Invite up to 20 people here."),
});

export interface IssuedOnboardingInvitation {
  email: string;
  /** Shown once. Never persisted, never logged, never audited. */
  url: string;
  expiresAt: string;
  /** What became of the email. Per row: one address can bounce while others go. */
  delivery: InvitationDeliveryStatus;
}

export interface InvitationRowFailure {
  email: string;
  message: string;
}

export interface OnboardingTeamResult {
  issued: IssuedOnboardingInvitation[];
  failures: InvitationRowFailure[];
  nextPath: string;
}

/**
 * Issue invitations and finish setup.
 *
 * Each row is issued independently and its failure is isolated. That is the
 * whole reason this does not call `inviteMemberAction` in a loop: one invalid
 * address, or one that already has a live invitation, must not discard the
 * links already generated for the rows that succeeded. Those links exist
 * exactly once — they are not stored anywhere they could be read a second time
 * — so losing them means the invitation has to be revoked and reissued.
 *
 * Setup completes regardless of whether any invitation landed. Somebody whose
 * three addresses were all typos has still finished setting up their workspace,
 * and trapping them on step 5 over it would be absurd; the failures are
 * reported and the invitations can be reissued from `/settings`.
 */
export async function completeOnboardingTeamAction(
  input: unknown,
): Promise<ActionResult<OnboardingTeamResult>> {
  return runAction("onboarding.team", async () => {
    const { teammates } = inviteTeamSchema.parse(input);
    await authorize("organization.manage_members");
    const context = await authorize("onboarding.manage");

    // Read once, outside the loop: the inviter is the same person for every row.
    const session = await requireSession();

    const issued: IssuedOnboardingInvitation[] = [];
    const failures: InvitationRowFailure[] = [];
    const seen = new Set<string>();

    for (const teammate of teammates) {
      const email = teammate.email.trim().toLowerCase();

      // Caught here rather than at the database, where the partial unique index
      // would reject the second row with a message about an index.
      if (seen.has(email)) {
        failures.push({ email, message: "This address appears twice on the form." });
        continue;
      }
      seen.add(email);

      try {
        const token = generateInvitationToken();
        const expiresAt = new Date(
          Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString();

        const invitation = await context.dataSource.invitations.create(context.scope, {
          email,
          role: teammate.role,
          // Only the digest reaches the repository. The token exists in this
          // loop and in the value returned to the caller, and nowhere else.
          tokenHash: hashInvitationToken(token),
          invitedByUserId: context.scope.userId,
          expiresAt,
        });

        const url = invitationUrl(appOrigin(), token);

        // Inside the per-row try, after the row exists. A send that throws is
        // already caught by `deliverInvitation`, but the placement matters
        // anyway: nothing about delivery may cost a link that cannot be
        // regenerated.
        const delivery = await deliverInvitation({
          email: invitation.email,
          organizationName: context.organization.name,
          inviterName: session.fullName,
          role: invitation.role,
          url,
          expiresAt,
        });

        await recordAuditEvent(context, {
          eventType: "membership.invited",
          entityType: "membership",
          entityId: invitation.id,
          previousState: null,
          // The address and the role, never the token.
          newState: { email: invitation.email, role: invitation.role },
          metadata: { expiresAt, source: "onboarding", delivery },
        });

        issued.push({
          email: invitation.email,
          url,
          expiresAt,
          delivery,
        });
      } catch (error) {
        // Per row, so one bad address cannot erase the links beside it. The
        // message is Lia's own — a database conflict here means "already
        // invited", which is what the person needs to know.
        console.error("[action:onboarding.team] invitation failed");
        failures.push({
          email,
          message:
            error instanceof Error && error.name === "DataError"
              ? error.message
              : "That invitation could not be created. They may already have one.",
        });
      }
    }

    if (issued.length > 0) {
      await completeTeamStep(context, issued.length);
    } else {
      // Nothing was issued. Recorded as a skip rather than a completion, so the
      // trail does not claim a team step that invited nobody.
      await skipTeamStep(context);
    }

    await finishOnboarding(context);

    revalidateOnboarding();
    revalidatePath("/settings");
    revalidatePath("/", "layout");

    return { issued, failures, nextPath: ONBOARDING_READY_PATH };
  });
}

/** Skip step 5 and finish setup. */
export async function skipOnboardingTeamAction(): Promise<
  ActionResult<{ nextPath: string }>
> {
  return runAction("onboarding.team_skipped", async () => {
    const context = await authorize("onboarding.manage");
    await skipTeamStep(context);
    await finishOnboarding(context);

    revalidateOnboarding();
    revalidatePath("/", "layout");

    return { nextPath: ONBOARDING_READY_PATH };
  });
}

/* -------------------------------------------------------------------------- */
/* Completion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Finish setup without changing a step.
 *
 * Covers the resume case: the browser died between the last step and the
 * completion write, so every step is settled but the status is still in
 * progress. The repository refuses if that is not actually true.
 */
export async function finishOnboardingAction(): Promise<
  ActionResult<{ nextPath: string }>
> {
  return runAction("onboarding.finish", async () => {
    const context = await authorize("onboarding.manage");
    await finishOnboarding(context);
    revalidateOnboarding();
    revalidatePath("/", "layout");
    return { nextPath: ONBOARDING_READY_PATH };
  });
}

export async function markOnboardingReadyViewedAction(): Promise<
  ActionResult<{ readyViewedAt: string | null }>
> {
  return runAction("onboarding.ready_viewed", async () => {
    const context = await authorize("onboarding.manage");
    const state: OrganizationOnboarding = await markReadyViewed(context);
    revalidatePath("/overview");
    return { readyViewedAt: state.readyViewedAt };
  });
}

/* -------------------------------------------------------------------------- */
/* Review import                                                               */
/* -------------------------------------------------------------------------- */

export interface StartImportResult {
  /** How many locations a sync was opened for. */
  started: number;
  /** Locations where a sync was already running. Not a failure. */
  alreadyRunning: number;
  created: number;
  updated: number;
  failed: number;
  /** What to tell the user. Never claims an import that did not happen. */
  message: string;
}

/**
 * Start importing reviews for every connected location.
 *
 * This exists because there is **no scheduled review sync**. `vercel.ts`
 * schedules the news poll and the analysis sweep; neither touches reviews, and
 * inventing a background job to enqueue against would mean the ready screen
 * claimed an import that nothing would ever run. So the import is a real,
 * user-triggered synchronisation through the same `syncGoogleReviews` service
 * the integrations screen uses, and the screen says so.
 *
 * Runs sequentially rather than in parallel: each location's sync makes paged
 * requests against one shared Google credential, and firing them all at once is
 * how a first-day customer meets a quota error.
 */
export async function startOnboardingImportAction(): Promise<
  ActionResult<StartImportResult>
> {
  return runAction("onboarding.start_import", async () => {
    const context = await authorize("integration.sync_reviews");

    const profiles = (await context.dataSource.platformProfiles.list(context.scope))
      .filter((profile) => profile.status === "active");

    const result: StartImportResult = {
      started: 0,
      alreadyRunning: 0,
      created: 0,
      updated: 0,
      failed: 0,
      message: "",
    };

    if (profiles.length === 0) {
      throw conflict(
        "No locations are connected yet, so there is nothing to import.",
      );
    }

    for (const profile of profiles) {
      try {
        const run = await syncGoogleReviews(context, { platformProfileId: profile.id });
        result.started += 1;
        result.created += run.counts.created;
        result.updated += run.counts.updated;
        result.failed += run.counts.failed;
      } catch (error) {
        // A sync already open for this location is somebody else pressing the
        // button first, which is the system working — counted, not reported as
        // an error. Everything else is a genuine failure for this location and
        // must not stop the others.
        if (error instanceof Error && error.name === "SyncRunInProgressError") {
          result.alreadyRunning += 1;
          continue;
        }
        console.error("[action:onboarding.start_import] sync failed");
        result.failed += 1;
      }
    }

    revalidateOnboarding();
    for (const path of ["/mentions", "/reviews", "/overview", "/insights"]) {
      revalidatePath(path);
    }

    result.message = describeImport(result);
    return result;
  });
}

/** One sentence about what the import did. Phrased around counts, never status. */
function describeImport(result: StartImportResult): string {
  if (result.started === 0 && result.alreadyRunning > 0) {
    return "An import is already running for your locations. This page will show the results once it finishes.";
  }

  const parts: string[] = [];
  if (result.created > 0) parts.push(`${result.created} new`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);

  if (parts.length === 0) {
    return result.failed > 0
      ? "Lia could not import reviews for your locations. Try again shortly."
      : "No reviews were found for your locations yet.";
  }

  const summary = `Imported ${parts.join(", ")}.`;
  return result.failed > 0
    ? `${summary} ${result.failed} could not be imported — the rest were saved.`
    : summary;
}
