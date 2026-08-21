import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Newspaper } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import {
  PressWidgetConfigurator,
  type PressStoryView,
  type QueryOption,
} from "@/components/integrations/press-widget-configurator";
import { PressWidgetEmbedPanel } from "@/components/integrations/press-widget-embed-panel";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { appOrigin } from "@/lib/env";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { isNewsMonitorAvailable } from "@/news/registry";
import { ATTRIBUTION_EXPLANATION } from "@/lib/widgets/attribution";
import { listPressStoryChoices } from "@/lib/widgets/press/service";
import { DEFAULT_PRESS_WIDGET_ITEMS } from "@/domain";

export const metadata: Metadata = { title: "Press widget" };

/**
 * Where a customer puts their press coverage on their own website.
 *
 * Under `/integrations` alongside the review widget, and reached from
 * `/integrations/website-widgets` — which is the screen that explains the
 * choice between the two. `CLAUDE.md` fixes the top-level route list, and this
 * is a child of one of them.
 *
 * Unlike the review widget's screen there is no location parameter and no
 * picker: a press widget is organization-level, because coverage arrives bound
 * to a monitoring query rather than to a restaurant. Choosing a query *is* the
 * per-restaurant filter, and a second location selector would silently
 * disagree with it.
 *
 * The screen has three genuinely different empty states, and they are three
 * different sentences because they need three different actions:
 *
 *   * news monitoring is not configured on this deployment at all;
 *   * it is configured but this organization has no watches yet;
 *   * it has watches but nothing eligible has been found yet.
 *
 * Collapsing them into "no coverage yet" would send an owner to a screen that
 * cannot help them, or leave them waiting for a poll that will never run.
 */
export default async function PressWidgetPage() {
  const [context, dataSource] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
  ]);
  const { scope, role } = context;

  const [widget, queries] = await Promise.all([
    dataSource.pressWidgets.get(scope),
    dataSource.monitoringQueries.list(scope),
  ]);

  const canManage = can(role, "website_widget.manage");
  const newsAvailable = isNewsMonitorAvailable();

  const monitoringQueryId = widget?.monitoringQueryId ?? null;
  const choices = await listPressStoryChoices({ dataSource, scope }, { monitoringQueryId });

  const locations = await dataSource.locations.list(scope);
  const locationNames = new Map(locations.map((location) => [location.id, location.name]));

  const queryOptions: QueryOption[] = queries.map((query) => ({
    id: query.id,
    name: query.name,
    enabled: query.enabled,
    locationName: query.locationId ? (locationNames.get(query.locationId) ?? null) : null,
  }));

  const stories: PressStoryView[] = choices.map((choice) => ({
    id: choice.mention.id,
    headline: choice.mention.title,
    publisherName: choice.mention.publisherName,
    publisherDomain: choice.mention.publisherDomain,
    publishedAt: choice.mention.publishedAt,
    eligible: choice.eligible,
    refusedBy: choice.refusedBy,
    // Which of these actually appear is derived in the component, against the
    // item limit the person can change without a round trip. Sending a
    // server-computed answer would be a second one to keep in step.
  }));

  const hasEligible = choices.some((choice) => choice.eligible);

  return (
    <PageBody>
      <Header />

      {!newsAvailable ? <NewsUnavailableNotice /> : null}

      {newsAvailable && queries.length === 0 ? <NoQueriesNotice /> : null}

      {newsAvailable && queries.length > 0 && !hasEligible ? (
        <NoEligibleCoverageNotice />
      ) : null}

      <Card>
        <CardHeader
          title="Widget settings"
          description="What your press strip shows, and how it looks on the page."
        />
        <div className="mt-4">
          <PressWidgetConfigurator
            canManage={canManage}
            queries={queryOptions}
            stories={stories}
            initial={{
              theme: widget?.theme ?? "light",
              monitoringQueryId,
              itemLimit: widget?.itemLimit ?? DEFAULT_PRESS_WIDGET_ITEMS,
              allowedDomains: widget?.allowedDomains ?? [],
            }}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Embed code"
          description="Two lines, pasted where the coverage should appear. Works in any website builder that accepts HTML."
        />
        <div className="mt-4">
          {widget ? (
            <PressWidgetEmbedPanel
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

function Header() {
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
        title="Recent press widget"
        description="Show your latest earned-media coverage on your own website. Lia keeps it current, and stops showing a story the moment it stops qualifying."
      />
    </div>
  );
}

/**
 * The deployment cannot search news at all.
 *
 * A different sentence from "you have no watches", and it names the person who
 * can fix it. Nobody in the organization can act on this — it is a server
 * configuration — so there is no button, which is better than one that lands
 * on a screen saying the same thing.
 */
function NewsUnavailableNotice() {
  return (
    <Card>
      <EmptyState
        icon={Newspaper}
        title="News monitoring is not set up on this server"
        description="The press widget shows coverage Lia has already found, and this deployment has no news provider configured. Your administrator needs to set the news provider credentials before there is anything to show."
      />
    </Card>
  );
}

function NoQueriesNotice() {
  return (
    <Card>
      <EmptyState
        icon={Newspaper}
        title="No news watches yet"
        description="Lia finds coverage by watching for the terms you give it. Add a watch on News and media, and the articles it finds become the ones this widget can show."
        action={
          <ButtonLink href="/integrations/news-media" variant="primary">
            Set up news monitoring
          </ButtonLink>
        }
      />
    </Card>
  );
}

/**
 * Watches exist and have found nothing that qualifies.
 *
 * Deliberately not phrased as a failure. A new watch has not polled yet, and a
 * watch that has polled may honestly have found nothing — coverage is not
 * something a restaurant can produce on demand. The link goes to the screen
 * where somebody can poll now or widen the terms.
 */
function NoEligibleCoverageNotice() {
  return (
    <Card>
      <EmptyState
        icon={Newspaper}
        title="No coverage to show yet"
        description="Your watches have not turned up an article that can be published yet. The list below shows everything Lia has found, and why each piece is not eligible."
        action={
          <ButtonLink href="/integrations/news-media" variant="secondary">
            Review news monitoring
          </ButtonLink>
        }
      />
    </Card>
  );
}

/**
 * The capability list.
 *
 * Stated per rule so nothing has to be inferred from an empty card — the same
 * job the review widget's version does, and worth repeating rather than
 * sharing, because every line in it is different.
 */
function WidgetRulesCard() {
  return (
    <Card>
      <CardHeader
        title="What this widget shows"
        description="Stated per rule, so nothing here has to be inferred from an empty strip."
      />
      <ul className="mt-3 space-y-1.5 text-[12.5px] text-gray-700">
        <li>
          Up to three of your most recent news articles, newest first. Lia
          chooses them; there is no way to pin one, so the strip cannot go
          stale.
        </li>
        <li>
          Articles you have dismissed, articles escalated for handling, articles
          an outlet has taken down, and syndicated copies of a story you are
          already showing are never included.
        </li>
        <li>
          Each story links to the original article on the publisher&rsquo;s own
          site. A story with no usable link is left out rather than shown
          without one.
        </li>
        <li>
          Publication logos are shown only for outlets Lia holds a verified,
          licensed mark for. Every other publication is named in text — a
          missing logo never hides a story, and Lia never loads an image from a
          publisher&rsquo;s server onto your page.
        </li>
        <li>{ATTRIBUTION_EXPLANATION}</li>
      </ul>
    </Card>
  );
}
