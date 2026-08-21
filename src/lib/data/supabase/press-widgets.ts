import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PressWidgetLayout,
  PressWidgetRenderRow,
  PressWidgetStatus,
  PressWidgetStoryRow,
  PressWidgetTheme,
} from "@/domain";
import { conflict, DataError, notFound } from "@/lib/data/errors";
import { toPressWidget } from "@/lib/data/supabase/mappers";
import type { PressWidgetRepository } from "@/lib/data/types";

/**
 * The Supabase adapter for the website press widget.
 *
 * Its own file rather than more lines in `supabase/index.ts`, which is already
 * the largest module in the data layer — the decision `supabase/monitoring.ts`,
 * `supabase/yelp.ts`, and `supabase/review-widgets.ts` all made.
 *
 * The interesting method is `render`, and it differs from its demo twin in a
 * way that is not incidental. The demo adapter walks an in-memory array and
 * applies the shared TypeScript eligibility predicate. This one calls
 * `public.press_widget_render`, a `SECURITY DEFINER` function, because the
 * caller is an anonymous browser on a restaurant's website: there is no
 * `auth.uid()`, so every policy on `mentions` and `monitoring_queries` returns
 * nothing, and no amount of adapter code can change that.
 *
 * That means the eligibility rules exist twice — once in
 * `src/lib/widgets/press/eligibility.ts` and once in the function's `where`
 * clauses. The duplication is forced rather than chosen, it is documented at
 * both ends, and `tests/press-widget-eligibility.test.ts` pins the rule list.
 *
 * NOTE: like the rest of this adapter, the write paths here have been
 * exercised against a local Postgres through the SQL harness rather than
 * through PostgREST. See the note at the top of `index.ts`.
 */

type Row = Record<string, unknown>;

/**
 * `rows` and `fail` are duplicated from `index.ts` rather than imported, for
 * the reason `supabase/monitoring.ts` and `supabase/review-widgets.ts` record:
 * `index.ts` imports this module to wire it into the returned data source, so
 * importing back would be a circular dependency.
 */
function rows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

function fail(error: { message: string; code?: string }, action: string): never {
  if (error.code === "23505") {
    throw conflict("That record already exists.");
  }
  if (error.code === "42501" || error.code === "PGRST301") {
    throw new DataError("forbidden", "You don't have permission to do that.");
  }
  throw new DataError("unavailable", `Could not ${action}. Please try again.`);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * One string literal, not a concatenation.
 *
 * `supabase-js` parses the select list at the *type* level to infer the row
 * shape, and `"a, b" + "c"` widens to `string`, at which point the inferred
 * row becomes `GenericStringError` and every `toPressWidget(data)` below stops
 * type-checking. Wrapping the line is not worth breaking that.
 */
const COLUMNS =
  "id, organization_id, public_id, status, layout, theme, monitoring_query_id, item_limit, allowed_domains, attribution_suppressed, public_id_rotated_at, created_by_user_id, created_at, updated_at";

export function createPressWidgetRepository(
  client: SupabaseClient,
): PressWidgetRepository {
  return {
    async get(scope) {
      const { data, error } = await client
        .from("press_widgets")
        .select(COLUMNS)
        .eq("organization_id", scope.organizationId)
        .maybeSingle();

      if (error) fail(error, "load your press widget");
      return data ? toPressWidget(data as Row) : null;
    },

    async upsert(scope, input) {
      // `onConflict` on `organization_id` rather than on `id`: the identity of
      // a press widget is its organization, and the caller has no id to offer
      // on a create. `ignoreDuplicates` defaults to false, which makes this an
      // update-on-conflict rather than a silent no-op — what a save button
      // means.
      //
      // `public_id` is in the payload because an insert requires it, and it is
      // harmless on the update path only because the service always passes the
      // existing value there — the input type has no way to express a
      // different one, and rotation is a separate method.
      const { data, error } = await client
        .from("press_widgets")
        .upsert(
          {
            organization_id: scope.organizationId,
            public_id: input.publicId,
            layout: input.layout,
            theme: input.theme,
            monitoring_query_id: input.monitoringQueryId,
            item_limit: input.itemLimit,
            allowed_domains: input.allowedDomains,
            created_by_user_id: input.createdByUserId,
          },
          { onConflict: "organization_id" },
        )
        .select(COLUMNS)
        .single();

      if (error) {
        // `23503` is a foreign-key violation, and on this table it means one
        // thing: a monitoring query that does not exist, or belongs to another
        // tenant — the composite key on
        // `(monitoring_query_id, organization_id)` collapses both into the
        // same refusal. Reported as "not found" rather than as a database
        // error because from the caller's side those are the same thing, and
        // distinguishing "exists but is not yours" from "does not exist" would
        // be an existence oracle across tenants.
        if (error.code === "23503") {
          throw notFound("Monitoring query");
        }
        fail(error, "save that press widget");
      }

      return toPressWidget(data as Row);
    },

    async setStatus(scope, widgetId, status) {
      const { data, error } = await client
        .from("press_widgets")
        .update({ status })
        .eq("organization_id", scope.organizationId)
        .eq("id", widgetId)
        .select(COLUMNS)
        .maybeSingle();

      if (error) fail(error, "update that press widget");
      if (!data) throw notFound("Press widget");
      return toPressWidget(data as Row);
    },

    async rotatePublicId(scope, widgetId, publicId, rotatedAt) {
      const { data, error } = await client
        .from("press_widgets")
        .update({ public_id: publicId, public_id_rotated_at: rotatedAt })
        .eq("organization_id", scope.organizationId)
        .eq("id", widgetId)
        .select(COLUMNS)
        .maybeSingle();

      if (error) {
        // The unique index on `public_id` answering. At 120 bits this will not
        // happen; it is handled because the caller can simply try again, and a
        // generic "please try again" is the correct thing to say when that is
        // literally the fix.
        if (error.code === "23505") {
          throw conflict("Could not issue a new embed code. Please try again.");
        }
        fail(error, "issue a new embed code");
      }
      if (!data) throw notFound("Press widget");
      return toPressWidget(data as Row);
    },

    async render(publicId) {
      // An RPC rather than a select, and the *only* thing anonymous traffic
      // reaches for this feature. The caller has no session, so no policy on
      // `press_widgets`, `mentions`, or `monitoring_queries` would return a
      // row — the same problem, and the same solution, as
      // `review_widget_render` and `invitation_preview`.
      const { data, error } = await client.rpc("press_widget_render", {
        widget_public_id: publicId,
      });

      if (error) fail(error, "load that press coverage");

      const returned = rows(data);
      const first = returned[0];
      if (!first) return null;

      return {
        theme: first.theme as PressWidgetTheme,
        layout: first.layout as PressWidgetLayout,
        status: first.status as PressWidgetStatus,
        attributionSuppressed: first.attribution_suppressed === true,
        allowedDomains: Array.isArray(first.allowed_domains)
          ? first.allowed_domains.map(String)
          : [],
        // The function returns one row per story, and one row with every story
        // column null when nothing qualified — the left join that keeps a
        // widget with no coverage from disappearing entirely. Filtering on the
        // headline is what turns that row back into an empty list, and it is
        // also the last of the three checks the renderer repeats at its own
        // boundary.
        stories: returned.flatMap((row) => storyOf(row)),
      } satisfies PressWidgetRenderRow;
    },
  };
}

function storyOf(row: Row): PressWidgetStoryRow[] {
  const headline = textOrNull(row.headline);
  if (headline === null || headline.trim().length === 0) return [];

  return [
    {
      headline,
      excerpt: textOrNull(row.excerpt),
      publisherName: textOrNull(row.publisher_name),
      publisherDomain: textOrNull(row.publisher_domain),
      sourceUrl: textOrNull(row.source_url),
      // Left as the timestamp Postgres returned when it is one, and null when
      // nothing resolved. The renderer treats a null published-at as "not a
      // story", so a malformed value must not become a valid-looking date
      // here.
      publishedAt:
        row.published_at === null || row.published_at === undefined
          ? null
          : new Date(String(row.published_at)).toISOString(),
    },
  ];
}
