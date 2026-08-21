import {
  pressWidgetSchema,
  type PressWidget,
  type PressWidgetRenderRow,
} from "@/domain";
import { conflict, notFound } from "@/lib/data/errors";
import { demoRuntimeStore, demoStore, replaceRow, scoped } from "@/lib/data/demo/store";
import type { OrganizationScope, PressWidgetRepository } from "@/lib/data/types";
import { selectPressStories } from "@/lib/widgets/press/eligibility";
import { excerptOf } from "@/lib/widgets/press/excerpt";
import { REFERENCE_NOW } from "@/lib/seed/clock";
import { seedId } from "@/lib/seed/ids";

/**
 * The demo adapter for the website press widget.
 *
 * Its own file, following `demo/review-widgets.ts`. Two things here are not
 * merely a mirror of the Supabase adapter and are worth reading before
 * changing either.
 *
 * 1. **`render()` is the one method that crosses tenants by design.** It is
 *    keyed by public id and has no scope, exactly as the interface says, so it
 *    searches every organization's widgets. That is correct — a visitor to a
 *    restaurant's website belongs to no organization — and it is why the
 *    method resolves the organization *from the widget row* and then filters
 *    mentions on it. A lookup that filtered on the monitoring query alone
 *    would be a cross-tenant read the moment two organizations shared a query
 *    id, which is exactly the class of bug the scope discipline exists to make
 *    impossible everywhere else.
 *
 * 2. **Eligibility is the shared predicate, not a reimplementation.** Both
 *    branches call `selectPressStories` from
 *    `@/lib/widgets/press/eligibility`, which is also what the configuration
 *    screen and the preview use. The Supabase adapter cannot share it —
 *    anonymous traffic needs SQL — so the SQL function is the documented
 *    mirror. Here there is no excuse for a second copy.
 */

function nowIso(): string {
  // Demo mode runs on the seed clock so timestamps stay reproducible.
  return REFERENCE_NOW;
}

export function createPressWidgetRepository(): PressWidgetRepository {
  function widgets(): PressWidget[] {
    return demoRuntimeStore().pressWidgets;
  }

  function findInScope(scope: OrganizationScope, widgetId: string): PressWidget {
    const widget = scoped(widgets(), scope.organizationId).find(
      (row) => row.id === widgetId,
    );
    if (!widget) throw notFound("Press widget");
    return widget;
  }

  return {
    async get(scope) {
      const widget = scoped(widgets(), scope.organizationId)[0];
      return widget ? { ...widget } : null;
    },

    async upsert(scope, input) {
      const store = demoStore();

      // The monitoring query must belong to this organization. Postgres gets
      // this from the composite foreign key on
      // `(monitoring_query_id, organization_id)`; here it has to be checked,
      // and it is checked rather than assumed because the alternative is a
      // widget publishing another tenant's coverage under this tenant's public
      // id.
      if (input.monitoringQueryId !== null) {
        const query = store.monitoringQueries.find(
          (row) =>
            row.id === input.monitoringQueryId &&
            row.organizationId === scope.organizationId,
        );
        if (!query) throw notFound("Monitoring query");
      }

      const existing = scoped(widgets(), scope.organizationId)[0];
      const timestamp = nowIso();

      if (existing) {
        // The public id is carried forward, never taken from the input, so an
        // update cannot change which snippet resolves. Rotation is its own
        // method.
        const updated = pressWidgetSchema.parse({
          ...existing,
          theme: input.theme,
          layout: input.layout,
          monitoringQueryId: input.monitoringQueryId,
          itemLimit: input.itemLimit,
          allowedDomains: [...input.allowedDomains],
          updatedAt: timestamp,
        });
        return { ...replaceRow(widgets(), updated) };
      }

      // Mirrors `press_widgets_one_per_organization`. Unreachable through the
      // service, which reads before it writes, and kept so a direct adapter
      // caller gets the database's answer rather than a second row.
      if (widgets().some((row) => row.organizationId === scope.organizationId)) {
        throw conflict("This organization already has a press widget.");
      }

      const created = pressWidgetSchema.parse({
        id: seedId(`press-widget:${scope.organizationId}`),
        organizationId: scope.organizationId,
        publicId: input.publicId,
        status: "active",
        layout: input.layout,
        theme: input.theme,
        monitoringQueryId: input.monitoringQueryId,
        itemLimit: input.itemLimit,
        allowedDomains: [...input.allowedDomains],
        attributionSuppressed: false,
        publicIdRotatedAt: null,
        createdByUserId: input.createdByUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      widgets().push(created);
      return { ...created };
    },

    async setStatus(scope, widgetId, status) {
      const widget = findInScope(scope, widgetId);
      const updated = pressWidgetSchema.parse({
        ...widget,
        status,
        updatedAt: nowIso(),
      });
      return { ...replaceRow(widgets(), updated) };
    },

    async rotatePublicId(scope, widgetId, publicId, rotatedAt) {
      const widget = findInScope(scope, widgetId);

      // The unique index on `public_id` is global, so the collision check is
      // too. At 120 bits of entropy this will never fire; it exists because
      // "will never fire" and "cannot fire" are different claims, and the
      // Supabase adapter gets the real guarantee from the index.
      if (widgets().some((row) => row.publicId === publicId && row.id !== widgetId)) {
        throw conflict("Could not issue a new embed code. Please try again.");
      }

      const updated = pressWidgetSchema.parse({
        ...widget,
        publicId,
        publicIdRotatedAt: rotatedAt,
        updatedAt: nowIso(),
      });
      return { ...replaceRow(widgets(), updated) };
    },

    async render(publicId) {
      const widget = widgets().find((row) => row.publicId === publicId);
      if (!widget) return null;

      const store = demoStore();

      // Every mention read below is filtered on the widget's own organization.
      // See the note at the top of this file: this is one of the two scopeless
      // methods in the data layer, so the tenant filter is written out rather
      // than inherited from a scope.
      const candidates = store.mentions.filter(
        (mention) => mention.organizationId === widget.organizationId,
      );

      const query =
        widget.monitoringQueryId === null
          ? null
          : (store.monitoringQueries.find(
              (row) =>
                row.id === widget.monitoringQueryId &&
                row.organizationId === widget.organizationId,
            ) ?? null);

      const stories = selectPressStories(candidates, {
        organizationId: widget.organizationId,
        monitoringQueryId: widget.monitoringQueryId,
        selectedQueryEnabled: query?.enabled ?? false,
        itemLimit: widget.itemLimit,
      });

      return {
        theme: widget.theme,
        layout: widget.layout,
        status: widget.status,
        attributionSuppressed: widget.attributionSuppressed,
        allowedDomains: [...widget.allowedDomains],
        stories: stories.map((mention) => ({
          headline: mention.title,
          // Shortened here rather than in the renderer, so the anonymous
          // surface carries what the widget shows and not a paragraph the
          // widget would discard. `press_widget_render` applies the same cut.
          excerpt: excerptOf(mention.content),
          publisherName: mention.publisherName,
          publisherDomain: mention.publisherDomain,
          sourceUrl: mention.sourceUrl,
          publishedAt: mention.publishedAt,
        })),
      } satisfies PressWidgetRenderRow;
    },
  };
}
