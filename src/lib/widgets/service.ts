import "server-only";

import {
  saveReviewWidgetInputSchema,
  type Mention,
  type ReviewWidget,
  type ReviewWidgetStatus,
} from "@/domain";
import { recordAuditEvent, diff } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { invalidInput, notFound } from "@/lib/data/errors";
import {
  firstFailedWidgetRule,
  isWidgetEligibleReview,
  type ReviewWidgetEligibilityRule,
} from "@/lib/widgets/eligibility";
import { generateWidgetPublicId } from "@/lib/widgets/public-id";
import { normalizeWidgetDomains } from "@/lib/widgets/domains";

/**
 * Website review widget orchestration.
 *
 * The server actions are thin over this: `authorize()`, parse, call, audit,
 * revalidate. Everything that decides *what happens* lives here so it can be
 * tested against the demo data source without a request, which is how every
 * other service in `src/lib/` is arranged.
 *
 * Three invariants this module owns, none of which the database can:
 *
 * 1. **A pinned review must belong to the widget's own location.**
 *    `selected_mention_id` is only a foreign key to `mentions` — Postgres will
 *    happily accept a review from another restaurant, and that is precisely
 *    the "silently substituting another location's review" failure the product
 *    brief singles out. Checked here, on every save.
 * 2. **A pinned review must be eligible at the moment it is pinned.** Somebody
 *    can only pick from the eligible list in the interface, but an action is
 *    a public entry point and a crafted payload is not obliged to use it.
 * 3. **The public id is issued, never supplied.** Created fresh on a create,
 *    carried forward on an update, and changed by exactly one function.
 */

export interface WidgetServiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
  actorUserId: string;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One review a person may pin, with the verdict already applied.
 *
 * Ineligible reviews are returned rather than filtered out, carrying the rule
 * that refused them. Hiding them would produce the most common support
 * question this feature can generate — "why can I see this review in my inbox
 * but not in the widget list" — and leave the person with nowhere to look for
 * the answer.
 */
export interface WidgetReviewChoice {
  mention: Mention;
  eligible: boolean;
  /** Null when eligible; otherwise the first rule that refused it. */
  refusedBy: ReviewWidgetEligibilityRule | null;
}

/** How many reviews the picker offers. The repository caps `limit` at 200. */
const CHOICE_LIMIT = 60;

/**
 * The reviews at one location, newest first, each marked eligible or not.
 *
 * The floor passed here is deliberately the widget's own, so the list a person
 * chooses from is scored by the same number their automatic selection would
 * use — but note that pinning is not *blocked* by the floor (see
 * `assertPinnable`). The list marks a three-star review as below the floor;
 * it does not refuse to let somebody deliberately choose it.
 */
export async function listWidgetReviewChoices(
  context: Pick<WidgetServiceContext, "dataSource" | "scope">,
  input: { locationId: string; minimumRating: number },
): Promise<WidgetReviewChoice[]> {
  const mentions = await context.dataSource.mentions.list(context.scope, {
    locationId: input.locationId,
    sourceTypes: ["google_review"],
    limit: CHOICE_LIMIT,
  });

  return [...mentions]
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .map((mention) => {
      const refusedBy = firstFailedWidgetRule(mention, {
        locationId: input.locationId,
        minimumRating: input.minimumRating,
      });
      return { mention, eligible: refusedBy === null, refusedBy };
    });
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

export interface SaveWidgetResult {
  widget: ReviewWidget;
  /** True on the first save for a location. Decides which audit event fires. */
  created: boolean;
  /**
   * Domains the person typed that could not be enforced.
   *
   * Returned rather than silently dropped or fatally rejected. Somebody
   * pasting five hostnames and one stray "localhost" should get their five
   * saved and be told about the sixth — refusing the whole save would make
   * them find the bad entry by bisection.
   */
  rejectedDomains: string[];
}

export async function saveReviewWidget(
  context: WidgetServiceContext,
  raw: unknown,
): Promise<SaveWidgetResult> {
  const input = saveReviewWidgetInputSchema.parse(raw);
  const { dataSource, scope } = context;

  const locations = await dataSource.locations.list(scope);
  const location = locations.find((row) => row.id === input.locationId);
  if (!location) throw notFound("Location");

  if (input.selectedMentionId !== null) {
    await assertPinnable(context, input.locationId, input.selectedMentionId);
  }

  const { domains, rejected } = normalizeWidgetDomains(input.allowedDomains);

  const existing = await dataSource.reviewWidgets.getForLocation(scope, input.locationId);

  const widget = await dataSource.reviewWidgets.upsert(scope, {
    ...input,
    allowedDomains: domains,
    // Issued on a create, carried forward on an update. The one place a public
    // id is chosen, other than `rotateReviewWidgetEmbedId`.
    publicId: existing?.publicId ?? generateWidgetPublicId("review"),
    createdByUserId: existing?.createdByUserId ?? context.actorUserId,
  });

  const AUDITED_FIELDS = [
    "theme",
    "layout",
    "selectionMode",
    "selectedMentionId",
    "minimumRating",
    "allowedDomains",
  ] as const;

  if (existing) {
    const change = diff(
      { ...existing } as Record<string, unknown>,
      { ...widget } as Record<string, unknown>,
      [...AUDITED_FIELDS],
    );

    // A save that changed nothing writes nothing. Pressing save twice is not
    // an event, and a trail full of empty diffs is a trail nobody reads.
    if (Object.keys(change.newState).length > 0) {
      await recordAuditEvent(
        { dataSource, scope },
        {
          eventType: "review_widget.updated",
          entityType: "review_widget",
          entityId: widget.id,
          previousState: change.previousState,
          newState: change.newState,
          metadata: { locationId: widget.locationId },
        },
      );
    }
  } else {
    await recordAuditEvent(
      { dataSource, scope },
      {
        eventType: "review_widget.created",
        entityType: "review_widget",
        entityId: widget.id,
        previousState: null,
        // Note what is absent: the review text and the reviewer's name. The
        // widget publishes those; the audit trail is not where a second copy
        // of them belongs, which is the rule every other event about a mention
        // already keeps. The pinned review's *id* is here, because that is
        // what makes the decision reconstructable.
        newState: {
          locationId: widget.locationId,
          theme: widget.theme,
          layout: widget.layout,
          selectionMode: widget.selectionMode,
          selectedMentionId: widget.selectedMentionId,
          minimumRating: widget.minimumRating,
          allowedDomains: widget.allowedDomains,
        },
        metadata: { locationName: location.name },
      },
    );
  }

  return { widget, created: existing === null, rejectedDomains: rejected };
}

/**
 * Whether this review may be pinned to this widget.
 *
 * Two checks, and they refuse for different reasons on purpose. Belonging to
 * another location is answered as "not found", because saying "that review
 * belongs to a different restaurant" to a caller who supplied an arbitrary
 * UUID would confirm that the id exists — an existence oracle across the
 * tenant boundary. Being ineligible is answered plainly, because by then the
 * caller has already proved they can see the review.
 *
 * The rating floor is not applied. A person pinning a three-star review meant
 * it, and a floor that overrode an explicit choice would be the product
 * second-guessing a deliberate decision. The automatic path is where the floor
 * belongs, and both the SQL function and the demo adapter make the same
 * exception the same way.
 */
async function assertPinnable(
  context: WidgetServiceContext,
  locationId: string,
  mentionId: string,
): Promise<void> {
  const mention = await context.dataSource.mentions.get(context.scope, mentionId);

  if (!mention || mention.locationId !== locationId) {
    throw notFound("Review");
  }

  if (!isWidgetEligibleReview(mention, { locationId, minimumRating: 0 })) {
    throw invalidInput("That review cannot be shown on a website.", {
      selectedMentionId: "This review is not eligible for the widget.",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Enable, disable, rotate                                                     */
/* -------------------------------------------------------------------------- */

export async function setReviewWidgetStatus(
  context: WidgetServiceContext,
  input: { locationId: string; status: ReviewWidgetStatus },
): Promise<ReviewWidget> {
  const { dataSource, scope } = context;

  const existing = await dataSource.reviewWidgets.getForLocation(scope, input.locationId);
  if (!existing) throw notFound("Website widget");

  // Idempotent by design: disabling an already-disabled widget is a no-op
  // rather than a second audit event saying it happened twice.
  if (existing.status === input.status) return existing;

  const widget = await dataSource.reviewWidgets.setStatus(
    scope,
    existing.id,
    input.status,
  );

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType:
        input.status === "disabled" ? "review_widget.disabled" : "review_widget.enabled",
      entityType: "review_widget",
      entityId: widget.id,
      previousState: { status: existing.status },
      newState: { status: widget.status },
      metadata: { locationId: widget.locationId },
    },
  );

  return widget;
}

export interface RotateResult {
  widget: ReviewWidget;
  /** The id that has just stopped resolving. Shown once, so it can be found. */
  previousPublicId: string;
}

/**
 * Issue a new embed id, invalidating every snippet already published.
 *
 * The irreversible act in this feature. Nothing here can undo it, and nothing
 * here can tell the customer which of their pages carry the old snippet — so
 * the previous id is returned for the interface to show once, which is the
 * only help Lia can honestly offer somebody about to go and find them.
 */
export async function rotateReviewWidgetEmbedId(
  context: WidgetServiceContext,
  input: { locationId: string; now: string },
): Promise<RotateResult> {
  const { dataSource, scope } = context;

  const existing = await dataSource.reviewWidgets.getForLocation(scope, input.locationId);
  if (!existing) throw notFound("Website widget");

  const widget = await dataSource.reviewWidgets.rotatePublicId(
    scope,
    existing.id,
    generateWidgetPublicId("review"),
    input.now,
  );

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "review_widget.embed_id_rotated",
      entityType: "review_widget",
      entityId: widget.id,
      // Both ids are recorded. The old one is the only way to answer "which
      // snippet stopped working, and when" months later, and neither is a
      // secret — the old one is in the customer's own page source.
      previousState: { publicId: existing.publicId },
      newState: { publicId: widget.publicId },
      metadata: { locationId: widget.locationId },
    },
  );

  return { widget, previousPublicId: existing.publicId };
}
