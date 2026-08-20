import type { Metadata } from "next";
import { PageBody } from "@/components/shell/app-shell";
import {
  ReviewWidgetConfigurator,
  type ReviewChoiceView,
} from "@/components/integrations/review-widget-configurator";
import { ReviewWidgetEmbedPanel } from "@/components/integrations/review-widget-embed-panel";
import { ReviewWidgetLocationPicker } from "@/components/integrations/review-widget-location-picker";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { appOrigin } from "@/lib/env";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { ATTRIBUTION_EXPLANATION } from "@/lib/widgets/attribution";
import { DEFAULT_MINIMUM_RATING } from "@/domain";
import { listWidgetReviewChoices } from "@/lib/widgets/service";

export const metadata: Metadata = { title: "Website widgets" };

/**
 * Where a customer puts a Google review on their own website.
 *
 * Under `/integrations` rather than under `/locations`, which was the other
 * candidate. A widget is per-location, but what a person comes here to do is
 * connect Lia to something outside it — the same errand as connecting Google
 * or Yelp — and `/locations` is a portfolio comparison screen with no
 * per-location detail route to hang this on. `CLAUDE.md` fixes the top-level
 * route list, and this is a child of one of them.
 *
 * The location is a URL parameter rather than client state, so the widget, its
 * eligible reviews, and its embed code are all resolved on the server by the
 * repositories that already enforce tenancy. Switching location is a
 * navigation.
 */
export default async function ReviewWidgetPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>;
}) {
  const [context, dataSource, params] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
    searchParams,
  ]);
  const { scope, role } = context;

  const [locations, widgets] = await Promise.all([
    dataSource.locations.list(scope),
    dataSource.reviewWidgets.list(scope),
  ]);

  const canManage = can(role, "review_widget.manage");

  if (locations.length === 0) {
    return (
      <PageBody>
        <Header />
        <Card>
          <EmptyState
            title="No locations yet"
            description="Add a location and connect its Google Business Profile before putting a review on your website."
          />
        </Card>
      </PageBody>
    );
  }

  // A requested location that is not in this organization's list falls back to
  // the first rather than erroring: the id came from a URL, and the honest
  // answer to a stale bookmark is the screen it was pointing at, not a 404.
  const requested = params.location;
  const selected =
    locations.find((location) => location.id === requested) ?? locations[0];
  if (!selected) return null;

  const widget = widgets.find((row) => row.locationId === selected.id) ?? null;
  const minimumRating = widget?.minimumRating ?? DEFAULT_MINIMUM_RATING;

  const choices = await listWidgetReviewChoices(
    { dataSource, scope },
    { locationId: selected.id, minimumRating },
  );

  const choiceViews: ReviewChoiceView[] = choices.map((choice) => ({
    id: choice.mention.id,
    rating: choice.mention.rating,
    authorName: choice.mention.authorName,
    excerpt: choice.mention.content.replace(/\s+/g, " ").trim().slice(0, 180),
    publishedAt: choice.mention.publishedAt,
    eligible: choice.eligible,
    refusedBy: choice.refusedBy,
  }));

  return (
    <PageBody>
      <Header
        picker={
          <ReviewWidgetLocationPicker
            selectedId={selected.id}
            locations={locations.map((location) => ({
              id: location.id,
              name: location.name,
              city: location.city,
              hasWidget: widgets.some((row) => row.locationId === location.id),
            }))}
          />
        }
      />

      <Card>
        <CardHeader
          title="Widget settings"
          description={`What ${selected.name} shows, and how it looks on the page.`}
        />
        <div className="mt-4">
          <ReviewWidgetConfigurator
            locationId={selected.id}
            locationName={selected.name}
            canManage={canManage}
            choices={choiceViews}
            initial={{
              theme: widget?.theme ?? "light",
              selectionMode: widget?.selectionMode ?? "most_recent",
              selectedMentionId: widget?.selectedMentionId ?? null,
              minimumRating,
              allowedDomains: widget?.allowedDomains ?? [],
            }}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Embed code"
          description="Two lines, pasted where the review should appear. Works in any website builder that accepts HTML."
        />
        <div className="mt-4">
          {widget ? (
            <ReviewWidgetEmbedPanel
              locationId={selected.id}
              publicId={widget.publicId}
              status={widget.status}
              origin={appOrigin()}
              canManage={canManage}
            />
          ) : (
            <EmptyState
              title="Save the settings to get your embed code"
              description="Lia issues the code once the widget exists, so the snippet you copy is never one that stops working."
            />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="What this widget shows"
          description="Stated per rule, so nothing here has to be inferred from an empty card."
        />
        <ul className="mt-3 space-y-1.5 text-[12.5px] text-gray-700">
          <li>One Google review at a time, for this location only.</li>
          <li>
            Reviews with no written text, reviews you have dismissed, reviews
            escalated for handling, and reviews Google no longer carries are
            never shown.
          </li>
          <li>
            &ldquo;Read on Google&rdquo; opens this location&rsquo;s Google
            profile. Google publishes no link to an individual review, so Lia
            does not invent one.
          </li>
          <li>{ATTRIBUTION_EXPLANATION}</li>
          <li>
            Photo and video layouts are not built yet. This version is text
            only.
          </li>
        </ul>
      </Card>
    </PageBody>
  );
}

function Header({ picker }: { picker?: React.ReactNode }) {
  return (
    <PageHeader
      title="Website widgets"
      description="Show one recent Google review on your own website. Lia keeps it current, and stops showing it the moment it stops qualifying."
      actions={picker}
    />
  );
}
