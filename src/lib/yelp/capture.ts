import "server-only";

import {
  captureYelpReviewInputSchema,
  isManuallyCapturableSourceType,
  type CaptureYelpReviewInput,
  type Mention,
  type YelpCaptureOutcome,
} from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import { conflict, invalidInput, notFound } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import {
  deriveOverriddenCaptureKey,
  deriveYelpCaptureKey,
} from "@/lib/yelp/dedupe";
import { normalizeYelpUrl } from "@/yelp/urls";

/**
 * Adding a Yelp review to Lia by hand.
 *
 * The point of this module is that a typed review becomes an *ordinary
 * mention* — it goes into the same table, gets the same analysis, the same
 * rules evaluation, the same escalation eligibility, the same drafting and the
 * same approval workflow as a Google review that arrived through an API. There
 * is deliberately no parallel pipeline for captured content, because a parallel
 * pipeline is how the guardrails stop applying to exactly the source that most
 * needs them: this content is unverifiable by construction.
 *
 * What is *not* the same is the provenance. `captureMethod: "manual_entry"`,
 * the capturing actor, and the capture instant are stamped here from the
 * session and the clock, never from the payload — and the database refuses the
 * combinations that would misrepresent them
 * (`mentions_capture_actor_pairing`). Nothing in the interface may describe one
 * of these as imported or retrieved.
 */

export interface CaptureYelpReviewResult {
  outcome: YelpCaptureOutcome;
  /** The captured review, or the existing one a duplicate collided with. */
  mention: Mention;
  /** How Lia decided this was the same review, when it is a duplicate. */
  duplicateBasis: "review_url" | "fingerprint" | null;
}

export interface CaptureYelpReviewOptions {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
  input: CaptureYelpReviewInput;
  /** The verified person doing the typing. Never taken from the payload. */
  actorUserId: string;
  now: string;
}

export async function captureYelpReview(
  options: CaptureYelpReviewOptions,
): Promise<CaptureYelpReviewResult> {
  const { dataSource, scope, actorUserId, now } = options;
  const input = captureYelpReviewInputSchema.parse(options.input);

  // Restated here as well as in the schema. `MANUALLY_CAPTURABLE_SOURCE_TYPES`
  // is declared as data precisely so a caller reaching this path with a
  // `news_article` is refused by a check rather than by never being offered a
  // control — a button is not a security boundary.
  if (!isManuallyCapturableSourceType(input.sourceType)) {
    throw invalidInput("That source cannot have reviews added by hand.");
  }

  const profiles = await dataSource.platformProfiles.list(scope);
  const profile = profiles.find((row) => row.id === input.platformProfileId);
  // The scope filter is what stops a caller attaching a review to another
  // organization's connected listing by supplying its id.
  if (!profile) throw notFound("Connected listing");
  if (profile.status === "disconnected") {
    throw conflict(
      "That Yelp listing is disconnected. Reconnect it before adding reviews.",
    );
  }

  // Validated before it is stored, not before it is opened. This value becomes
  // an "Open in Yelp" destination later, and validating only at render time
  // would mean a hostile URL sat in the database until somebody clicked it.
  const reviewUrl = input.reviewUrl ? normalizeYelpUrl(input.reviewUrl) : null;
  if (input.reviewUrl && !reviewUrl) {
    throw invalidInput(
      "That does not look like a Yelp link. Paste the address of the review on yelp.com, or leave it blank.",
    );
  }

  const key = deriveYelpCaptureKey({
    reviewUrl,
    rating: input.rating,
    content: input.content,
    authorName: input.authorName ?? null,
    reviewedOn: input.reviewedOn ?? null,
  });

  const existing = await dataSource.mentions.findByExternalId(
    scope,
    profile.platformConnectionId,
    input.sourceType,
    key.externalId,
  );

  // A duplicate is an outcome, not an error. The caller asked to add a review
  // Lia already holds, and the honest answer is to show them the one that
  // exists and offer the override — not to fail, and certainly not to merge
  // silently into a row that may be a different review.
  if (existing && !input.confirmDistinct) {
    return { outcome: "duplicate", mention: existing, duplicateBasis: key.basis };
  }

  // The override. A discriminator derived from the capture instant, so the key
  // the unique index sees is distinct while the whole scheme stays
  // deterministic — replaying the same override produces the same key rather
  // than a third copy.
  const externalId = existing
    ? deriveOverriddenCaptureKey(key, now)
    : key.externalId;

  const mention = await dataSource.mentions.create(scope, {
    locationId: profile.locationId,
    platformConnectionId: profile.platformConnectionId,
    platformProfileId: profile.id,
    sourceType: input.sourceType,
    externalId,
    externalParentId: null,
    sourceUrl: reviewUrl,
    title: null,
    content: input.content,
    authorName: input.authorName ?? null,
    authorExternalId: null,
    rating: input.rating,
    language: null,
    // The date the customer read off Yelp, resolved to an instant. Falls back
    // to the capture time when they did not supply one — which is honest
    // rather than convenient: Lia genuinely does not know when it was written,
    // and `capturedAt` beside it records that the two are the same value for a
    // reason.
    publishedAt: input.reviewedOn
      ? new Date(`${input.reviewedOn}T12:00:00.000Z`).toISOString()
      : now,
    rawPayload: {},
    // Both null, and neither is an oversight. Relevance is the analysis
    // layer's column (D83) and this capture has no authority over it;
    // engagement has no meaning for a review. Named rather than defaulted
    // because `CreateMentionInput` requires them, and stating "Lia knows
    // nothing about this yet" is the honest value on a record a person typed.
    relevanceScore: null,
    engagementScore: null,
    // Every field below is stamped by this service. None is reachable from the
    // request, so a crafted payload cannot claim a review arrived through an
    // API or attribute the typing to somebody else.
    captureMethod: "manual_entry",
    capturedByUserId: actorUserId,
    capturedAt: now,
    yelpActivityOccurrenceId: input.activityOccurrenceId ?? null,
  });

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "mention.captured_manually",
      entityType: "mention",
      entityId: mention.id,
      previousState: null,
      newState: { sourceType: input.sourceType, rating: input.rating },
      // The deduplication basis and the override are recorded because they are
      // the decisions a reader would need to reconstruct. The review text is
      // not, matching every other event on a mention.
      metadata: {
        platformProfileId: profile.id,
        locationId: profile.locationId,
        duplicateBasis: key.basis,
        hasReviewUrl: reviewUrl !== null,
        overrodeDuplicate: Boolean(existing),
        ...(input.activityOccurrenceId
          ? { activityOccurrenceId: input.activityOccurrenceId }
          : {}),
      },
    },
  );

  // Close the occurrence that prompted this, if there was one. Done after the
  // mention exists so a failure here leaves an open occurrence beside a
  // captured review — an inconsistency somebody can see and fix — rather than a
  // closed occurrence pointing at a review that was never created.
  if (input.activityOccurrenceId) {
    await dataSource.yelpActivityOccurrences.resolve(scope, {
      occurrenceId: input.activityOccurrenceId,
      status: "captured",
      capturedMentionId: mention.id,
      resolvedByUserId: actorUserId,
      resolvedAt: now,
    });
  }

  return { outcome: "captured", mention, duplicateBasis: null };
}
