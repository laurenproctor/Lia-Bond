import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ReviewWidgetLayout,
  ReviewWidgetRenderRow,
  ReviewWidgetSelectionMode,
  ReviewWidgetStatus,
  ReviewWidgetTheme,
} from "@/domain";
import { conflict, DataError, notFound } from "@/lib/data/errors";
import { toReviewWidget } from "@/lib/data/supabase/mappers";
import type { ReviewWidgetRepository } from "@/lib/data/types";

/**
 * The Supabase adapter for the website review widget.
 *
 * Its own file rather than more lines in `supabase/index.ts`, which is already
 * the largest module in the data layer — the decision `supabase/monitoring.ts`
 * and `supabase/yelp.ts` both made.
 *
 * The interesting method is `render`, and it differs from its demo twin in a
 * way that is not incidental. The demo adapter walks an in-memory array and
 * applies the shared TypeScript eligibility predicate. This one calls
 * `public.review_widget_render`, a `SECURITY DEFINER` function, because the
 * caller is an anonymous browser on a restaurant's website: there is no
 * `auth.uid()`, so every policy on `mentions` returns nothing, and no amount
 * of adapter code can change that.
 *
 * That means the eligibility rules exist twice — once in
 * `src/lib/widgets/eligibility.ts` and once in the function's `where` clauses.
 * The duplication is forced rather than chosen, it is documented at both ends,
 * and `tests/review-widget-eligibility.test.ts` pins the rule list. It is the
 * one place in this feature where two implementations of a decision are
 * allowed to exist.
 *
 * NOTE: like the rest of this adapter, the write paths here have been
 * exercised against a local Postgres through the SQL harness rather than
 * through PostgREST. See the note at the top of `index.ts`.
 */

type Row = Record<string, unknown>;

/**
 * `rows` and `fail` are duplicated from `index.ts` rather than imported, for
 * the reason `supabase/monitoring.ts` and `supabase/yelp.ts` record: `index.ts`
 * imports this module to wire it into the returned data source, so importing
 * back would be a circular dependency.
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

/** Postgres `numeric` arrives as a string over PostgREST. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * One string literal, not a concatenation.
 *
 * `supabase-js` parses the select list at the *type* level to infer the row
 * shape, and `"a, b" + "c"` widens to `string`, at which point the inferred
 * row becomes `GenericStringError` and every `toReviewWidget(data)` below
 * stops type-checking. Wrapping the line is not worth breaking that.
 */
const COLUMNS =
  "id, organization_id, location_id, public_id, status, layout, theme, selection_mode, selected_mention_id, minimum_rating, allowed_domains, attribution_suppressed, public_id_rotated_at, created_by_user_id, created_at, updated_at";

export function createReviewWidgetRepository(
  client: SupabaseClient,
): ReviewWidgetRepository {
  return {
    async list(scope) {
      const { data, error } = await client
        .from("review_widgets")
        .select(COLUMNS)
        .eq("organization_id", scope.organizationId)
        .order("created_at", { ascending: true });

      if (error) fail(error, "load your website widgets");
      return rows(data).map(toReviewWidget);
    },

    async getForLocation(scope, locationId) {
      const { data, error } = await client
        .from("review_widgets")
        .select(COLUMNS)
        .eq("organization_id", scope.organizationId)
        .eq("location_id", locationId)
        .maybeSingle();

      if (error) fail(error, "load that website widget");
      return data ? toReviewWidget(data as Row) : null;
    },

    async upsert(scope, input) {
      // `onConflict` on the composite key rather than on `id`: the identity of
      // a widget is its location, and the caller has no id to offer on a
      // create. `ignoreDuplicates: false` makes this an update-on-conflict
      // rather than a silent no-op, which is what a save button means.
      //
      // `public_id` is in the payload because an insert requires it, and it is
      // harmless on the update path only because the service always passes the
      // existing value there — the input type has no way to express a
      // different one, and rotation is a separate method.
      const { data, error } = await client
        .from("review_widgets")
        .upsert(
          {
            organization_id: scope.organizationId,
            location_id: input.locationId,
            public_id: input.publicId,
            layout: input.layout,
            theme: input.theme,
            selection_mode: input.selectionMode,
            selected_mention_id: input.selectedMentionId,
            minimum_rating: input.minimumRating,
            allowed_domains: input.allowedDomains,
            created_by_user_id: input.createdByUserId,
          },
          { onConflict: "organization_id,location_id" },
        )
        .select(COLUMNS)
        .single();

      if (error) {
        // `23503` is a foreign-key violation: a location or a pinned review
        // that does not exist, or belongs to somebody else. Reported as
        // "not found" rather than as a database error because from the
        // caller's side those are the same thing, and the alternative message
        // would distinguish "exists but is not yours" from "does not exist",
        // which is an existence oracle across tenants.
        if (error.code === "23503") {
          throw notFound("Location or review");
        }
        fail(error, "save that website widget");
      }

      return toReviewWidget(data as Row);
    },

    async setStatus(scope, widgetId, status) {
      const { data, error } = await client
        .from("review_widgets")
        .update({ status })
        .eq("organization_id", scope.organizationId)
        .eq("id", widgetId)
        .select(COLUMNS)
        .maybeSingle();

      if (error) fail(error, "update that website widget");
      if (!data) throw notFound("Website widget");
      return toReviewWidget(data as Row);
    },

    async rotatePublicId(scope, widgetId, publicId, rotatedAt) {
      const { data, error } = await client
        .from("review_widgets")
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
      if (!data) throw notFound("Website widget");
      return toReviewWidget(data as Row);
    },

    async render(publicId) {
      // An RPC rather than a select, and the *only* thing anonymous traffic
      // reaches. The caller has no session, so no policy on `review_widgets`
      // or `mentions` would return a row — the same problem, and the same
      // solution, as `invitation_preview` on the public acceptance page.
      const { data, error } = await client.rpc("review_widget_render", {
        widget_public_id: publicId,
      });

      if (error) fail(error, "load that review");

      const row = rows(data)[0];
      if (!row) return null;

      return {
        theme: row.theme as ReviewWidgetTheme,
        layout: row.layout as ReviewWidgetLayout,
        status: row.status as ReviewWidgetStatus,
        attributionSuppressed: row.attribution_suppressed === true,
        allowedDomains: Array.isArray(row.allowed_domains)
          ? row.allowed_domains.map(String)
          : [],
        selectionMode: row.selection_mode as ReviewWidgetSelectionMode,
        // `num` for the reason the mappers module records: PostgREST returns a
        // `numeric` as a string, and "4.5" rendering as four and a half stars
        // would be an accident of coercion rather than a decision.
        reviewRating: num(row.review_rating),
        reviewText: textOrNull(row.review_text),
        reviewAuthorName: textOrNull(row.review_author_name),
        // Left as the timestamp Postgres returned when it is one, and null
        // when nothing resolved. The renderer treats a null published-at as
        // "no review", so a malformed value must not become a valid-looking
        // date here.
        reviewPublishedAt:
          row.review_published_at === null || row.review_published_at === undefined
            ? null
            : new Date(String(row.review_published_at)).toISOString(),
        profileUrl: textOrNull(row.profile_url),
      } satisfies ReviewWidgetRenderRow;
    },
  };
}
