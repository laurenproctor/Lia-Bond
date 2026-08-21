import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, MapPin } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { ConnectGoogleForm } from "@/components/integrations/connect-google-form";
import {
  ReviewWidgetConfigurator,
  type ReviewChoiceView,
} from "@/components/integrations/review-widget-configurator";
import { ReviewWidgetEmbedPanel } from "@/components/integrations/review-widget-embed-panel";
import { ReviewWidgetLocationPicker } from "@/components/integrations/review-widget-location-picker";
import { ReviewWidgetTeaser } from "@/components/integrations/review-widget-teaser";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { appOrigin } from "@/lib/env";
import { isGoogleConnectorAvailable } from "@/integrations/registry";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { ATTRIBUTION_EXPLANATION } from "@/lib/widgets/attribution";
import { DEFAULT_MINIMUM_RATING } from "@/domain";
import { listWidgetReviewChoices } from "@/lib/widgets/service";
import type { MembershipRole } from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

export const metadata: Metadata = { title: "Review widget" };

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

  const canManage = can(role, "website_widget.manage");

  if (locations.length === 0) {
    const googleConnected = await isGoogleConnected(dataSource, scope);

    return (
      <PageBody>
        <Header />
        <Card>
          <EmptyState
            icon={MapPin}
            title="No locations yet"
            description="A widget shows one location's Google reviews, so Lia needs a location connected before it has anything to put on your website."
            action={
              <ConnectLocationAction
                googleConnected={googleConnected}
                role={role}
              />
            }
          />
        </Card>

        <Card>
          <CardHeader
            title="What you'll be putting on your site"
            description="Rendered by the same code your website will get — this is the widget itself, not a picture of it."
          />
          <div className="mt-4">
            <ReviewWidgetTeaser />
          </div>
        </Card>

        <WidgetRulesCard />
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

      <WidgetRulesCard />
    </PageBody>
  );
}

/**
 * Whether this organization has a Google account attached at all.
 *
 * Only asked on the empty branch, and only to decide which button to draw:
 * "connect Google" and "choose locations" are two different errands, and
 * offering the wrong one sends somebody to a screen that cannot help them. The
 * configured branch never runs this query.
 */
async function isGoogleConnected(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
): Promise<boolean> {
  const connection = await dataSource.platformConnections.getByPlatform(
    scope,
    "google_business_profile",
  );
  return connection !== null && connection.status !== "disconnected";
}

/**
 * The way out of the empty state.
 *
 * Three outcomes rather than one link, because "connect a location" means
 * something different depending on where the organization already is, and a
 * button that lands on a screen saying *you cannot do this here* is worse than
 * no button:
 *
 * - **No Google account, and this person may connect one.** The real OAuth
 *   form, returning to location selection — the same control the integrations
 *   screen offers, not a link to it.
 * - **Google connected.** Straight to location selection, which is where the
 *   locations actually come from.
 * - **Neither.** The integrations screen, which explains the state of every
 *   source and is where an owner would be sent anyway. A member without the
 *   permission is not shown a button that would fail; they are shown where to
 *   look.
 */
function ConnectLocationAction({
  googleConnected,
  role,
}: {
  googleConnected: boolean;
  role: MembershipRole;
}) {
  if (!googleConnected) {
    if (can(role, "integration.connect") && isGoogleConnectorAvailable()) {
      return <ConnectGoogleForm label="Connect a location" />;
    }
    return (
      <ButtonLink href="/integrations" variant="primary">
        Go to integrations
      </ButtonLink>
    );
  }

  if (can(role, "integration.manage_profiles")) {
    return (
      <ButtonLink
        href="/integrations/google-business-profile/setup"
        variant="primary"
        icon={MapPin}
      >
        Choose locations
      </ButtonLink>
    );
  }

  return (
    <ButtonLink href="/integrations" variant="primary">
      Go to integrations
    </ButtonLink>
  );
}

/**
 * The capability list, drawn on both branches.
 *
 * It belongs on the empty state as much as on the configured one — arguably
 * more, since the teaser above it is showing somebody a card they have not
 * earned yet, and the honest thing to put underneath is what the widget will
 * and will not do.
 */
function WidgetRulesCard() {
  return (
    <Card>
      <CardHeader
        title="What this widget shows"
        description="Stated per rule, so nothing here has to be inferred from an empty card."
      />
      <ul className="mt-3 space-y-1.5 text-[12.5px] text-gray-700">
        <li>One Google review at a time, for one location only.</li>
        <li>
          Reviews with no written text, reviews you have dismissed, reviews
          escalated for handling, and reviews Google no longer carries are never
          shown.
        </li>
        <li>
          &ldquo;Read on Google&rdquo; opens the location&rsquo;s Google
          profile. Google publishes no link to an individual review, so Lia does
          not invent one.
        </li>
        <li>{ATTRIBUTION_EXPLANATION}</li>
        <li>
          Photo and video layouts are not built yet. This version is text only.
        </li>
      </ul>
    </Card>
  );
}

/**
 * The page header, plus the way back to the choice between the two widgets.
 *
 * The title is `Review widget`, not `Website widgets`, since the press widget
 * shipped. Two screens called the same thing is how somebody ends up
 * configuring the one they did not mean to, and the breadcrumb above it is
 * what says which of the two areas they are in.
 *
 * The route itself is unchanged. `/integrations/review-widget` has been in the
 * sidebar and in customers' browser history since this feature shipped, and
 * moving it beneath the new landing route would have broken every one of those
 * links to save a path segment.
 */
function Header({ picker }: { picker?: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <Link
        href="/integrations/website-widgets"
        className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-gray-500 transition-colors hover:text-gray-950"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Website widgets
      </Link>
      <PageHeader
        title="Review widget"
        description="Show one recent Google review on your own website. Lia keeps it current, and stops showing it the moment it stops qualifying."
        actions={picker}
      />
    </div>
  );
}
