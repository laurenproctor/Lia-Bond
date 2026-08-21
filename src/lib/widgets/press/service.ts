import "server-only";

import {
  savePressWidgetInputSchema,
  type Mention,
  type MonitoringQuery,
  type PressWidget,
  type PressWidgetStatus,
} from "@/domain";
import { recordAuditEvent, diff } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { invalidInput, notFound } from "@/lib/data/errors";
import { normalizeWidgetDomains } from "@/lib/widgets/domains";
import {
  firstFailedPressRule,
  type PressWidgetEligibilityRule,
} from "@/lib/widgets/press/eligibility";
import { generateWidgetPublicId } from "@/lib/widgets/public-id";

/**
 * Website press widget orchestration.
 *
 * The server actions are thin over this: `authorize()`, parse, call, audit,
 * revalidate. Everything that decides *what happens* lives here so it can be
 * tested against the demo data source without a request, which is how every
 * other service in `src/lib/` is arranged.
 *
 * Three invariants this module owns:
 *
 * 1. **A selected monitoring query must belong to this organization.** The
 *    database enforces it too — `press_widgets_query_same_org` is a composite
 *    foreign key on `(monitoring_query_id, organization_id)`, so a query from
 *    another tenant is not merely refused here but unrepresentable. Both
 *    layers, deliberately: this row decides what appears on a public page, and
 *    for that class of surface an application check is not the last line.
 * 2. **One widget per organization.** Read before write, and mirrored by a
 *    unique index so a concurrent second save conflicts rather than creating a
 *    second row nobody can tell apart in a page's source.
 * 3. **The public id is issued, never supplied.** Created fresh on a create,
 *    carried forward on an update, and changed by exactly one function.
 */

export interface PressWidgetServiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
  actorUserId: string;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One article, with the verdict already applied.
 *
 * Ineligible articles are returned rather than filtered out, carrying the rule
 * that refused them. Hiding them would produce the most likely support
 * question this feature can generate — "why is this piece in my media queue
 * but not on my website" — and leave the person with nowhere to look for the
 * answer.
 */
export interface PressStoryChoice {
  mention: Mention;
  eligible: boolean;
  /** Null when eligible; otherwise the first rule that refused it. */
  refusedBy: PressWidgetEligibilityRule | null;
}

/** How many articles the configuration screen considers. */
const CHOICE_LIMIT = 60;

/**
 * The organization's news coverage, newest first, each marked eligible or not.
 *
 * Scored against the widget's own filter, so the list a person reads is scored
 * by the same rules the live widget will apply. When a query is selected, the
 * candidates are fetched filtered — an unfiltered list annotated with "belongs
 * to a different watch" on forty rows is noise, not an explanation.
 */
export async function listPressStoryChoices(
  context: Pick<PressWidgetServiceContext, "dataSource" | "scope">,
  input: { monitoringQueryId: string | null },
): Promise<PressStoryChoice[]> {
  const [mentions, queries] = await Promise.all([
    context.dataSource.mentions.list(context.scope, {
      sourceTypes: ["news_article"],
      monitoringQueryId: input.monitoringQueryId ?? undefined,
      limit: CHOICE_LIMIT,
    }),
    input.monitoringQueryId === null
      ? Promise.resolve<MonitoringQuery[]>([])
      : context.dataSource.monitoringQueries.list(context.scope),
  ]);

  const selected =
    input.monitoringQueryId === null
      ? null
      : (queries.find((query) => query.id === input.monitoringQueryId) ?? null);

  return [...mentions]
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .map((mention) => {
      const refusedBy = firstFailedPressRule(mention, {
        organizationId: context.scope.organizationId,
        monitoringQueryId: input.monitoringQueryId,
        selectedQueryEnabled: selected?.enabled ?? false,
      });
      return { mention, eligible: refusedBy === null, refusedBy };
    });
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

export interface SavePressWidgetResult {
  widget: PressWidget;
  /** True on the first save. Decides which audit event fires. */
  created: boolean;
  /**
   * Domains the person typed that could not be enforced.
   *
   * Returned rather than silently dropped or fatally rejected, exactly as on
   * the review widget: somebody pasting five hostnames and one stray
   * "localhost" should get their five saved and be told about the sixth.
   */
  rejectedDomains: string[];
}

export async function savePressWidget(
  context: PressWidgetServiceContext,
  raw: unknown,
): Promise<SavePressWidgetResult> {
  const input = savePressWidgetInputSchema.parse(raw);
  const { dataSource, scope } = context;

  if (input.monitoringQueryId !== null) {
    await assertQueryAttachable(context, input.monitoringQueryId);
  }

  const { domains, rejected } = normalizeWidgetDomains(input.allowedDomains);

  const existing = await dataSource.pressWidgets.get(scope);

  const widget = await dataSource.pressWidgets.upsert(scope, {
    ...input,
    allowedDomains: domains,
    // Issued on a create, carried forward on an update. The one place a public
    // id is chosen, other than `rotatePressWidgetEmbedId`.
    publicId: existing?.publicId ?? generateWidgetPublicId("press"),
    createdByUserId: existing?.createdByUserId ?? context.actorUserId,
  });

  const AUDITED_FIELDS = [
    "theme",
    "layout",
    "monitoringQueryId",
    "itemLimit",
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
          eventType: "press_widget.updated",
          entityType: "press_widget",
          entityId: widget.id,
          previousState: change.previousState,
          newState: change.newState,
          metadata: {},
        },
      );
    }
  } else {
    await recordAuditEvent(
      { dataSource, scope },
      {
        eventType: "press_widget.created",
        entityType: "press_widget",
        entityId: widget.id,
        previousState: null,
        // Note what is absent: every headline, every excerpt, every publisher,
        // and the monitoring query's keywords. The widget publishes the first
        // three and the fourth is the customer's own competitive information;
        // the audit trail records the *decision*, which is reconstructable
        // from the query's id alone.
        newState: {
          theme: widget.theme,
          layout: widget.layout,
          monitoringQueryId: widget.monitoringQueryId,
          itemLimit: widget.itemLimit,
          allowedDomains: widget.allowedDomains,
        },
        metadata: {},
      },
    );
  }

  return { widget, created: existing === null, rejectedDomains: rejected };
}

/**
 * Whether this monitoring query may be attached to this organization's widget.
 *
 * Refused as "not found" rather than "that belongs to another organization",
 * because the second sentence to a caller who supplied an arbitrary UUID would
 * confirm that the id exists — an existence oracle across the tenant boundary.
 * The repository is already organization-scoped, so a query from elsewhere
 * simply is not in the list.
 *
 * A **disabled** query is refused with a plain message instead. By then the
 * caller has proved they can see it, and the honest thing to say is that
 * attaching it would produce an empty widget — `query_enabled` is one of the
 * eligibility rules, so a widget pointed at a switched-off watch shows
 * nothing. Refusing at the save is better than letting somebody publish a
 * blank strip and work out why later.
 */
async function assertQueryAttachable(
  context: PressWidgetServiceContext,
  monitoringQueryId: string,
): Promise<void> {
  const queries = await context.dataSource.monitoringQueries.list(context.scope);
  const query = queries.find((row) => row.id === monitoringQueryId);

  if (!query) throw notFound("Monitoring query");

  if (!query.enabled) {
    throw invalidInput("That news watch is switched off.", {
      monitoringQueryId:
        "Switch this watch back on, or choose all press coverage instead.",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Enable, disable, rotate                                                     */
/* -------------------------------------------------------------------------- */

export async function setPressWidgetStatus(
  context: PressWidgetServiceContext,
  input: { status: PressWidgetStatus },
): Promise<PressWidget> {
  const { dataSource, scope } = context;

  const existing = await dataSource.pressWidgets.get(scope);
  if (!existing) throw notFound("Press widget");

  // Idempotent by design: disabling an already-disabled widget is a no-op
  // rather than a second audit event saying it happened twice.
  if (existing.status === input.status) return existing;

  const widget = await dataSource.pressWidgets.setStatus(scope, existing.id, input.status);

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType:
        input.status === "disabled" ? "press_widget.disabled" : "press_widget.enabled",
      entityType: "press_widget",
      entityId: widget.id,
      previousState: { status: existing.status },
      newState: { status: widget.status },
      metadata: {},
    },
  );

  return widget;
}

export interface RotatePressResult {
  widget: PressWidget;
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
 *
 * The full previous id is returned to the *caller*, which renders it to the
 * person who asked for the rotation. It is not logged, and the audit event
 * records both ids because that is a tenant-scoped record of a deliberate act
 * — neither is a secret, and the old one is in the customer's own page source.
 */
export async function rotatePressWidgetEmbedId(
  context: PressWidgetServiceContext,
  input: { now: string },
): Promise<RotatePressResult> {
  const { dataSource, scope } = context;

  const existing = await dataSource.pressWidgets.get(scope);
  if (!existing) throw notFound("Press widget");

  const widget = await dataSource.pressWidgets.rotatePublicId(
    scope,
    existing.id,
    generateWidgetPublicId("press"),
    input.now,
  );

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "press_widget.embed_id_rotated",
      entityType: "press_widget",
      entityId: widget.id,
      previousState: { publicId: existing.publicId },
      newState: { publicId: widget.publicId },
      metadata: {},
    },
  );

  return { widget, previousPublicId: existing.publicId };
}
