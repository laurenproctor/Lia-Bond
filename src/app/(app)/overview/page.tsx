import type { Metadata } from "next";
import {
  AlertTriangle,
  CalendarRange,
  Clock,
  Download,
  MessageCircle,
  ShieldCheck,
  Smile,
  Timer,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { EmergingTopicsCard } from "@/components/overview/emerging-topics-card";
import {
  LocationComparisonCard,
  type LocationRow,
} from "@/components/overview/location-comparison-card";
import { NeedsAttentionCard } from "@/components/overview/needs-attention-card";
import { RecentActivityCard } from "@/components/overview/recent-activity-card";
import { ReputationPulseCard } from "@/components/overview/reputation-pulse-card";
import { SourceMixCard } from "@/components/overview/source-mix-card";
import { Button } from "@/components/ui/button";
import { KpiCard, type KpiCardProps } from "@/components/ui/kpi-card";
import { PageHeader } from "@/components/ui/page-header";
import { getDataSource } from "@/lib/data";
import { getOrganizationScope } from "@/lib/tenancy/organization-context";
import { buildOverviewKpis } from "@/lib/view-models/kpi";
import { toMentionViews } from "@/lib/view-models/mention";

export const metadata: Metadata = { title: "Overview" };

/** Icon and accent per KPI, keyed by the id the view model assigns. */
const KPI_PRESENTATION: Record<
  string,
  { icon: LucideIcon; accent: NonNullable<KpiCardProps["accent"]> }
> = {
  new_mentions: { icon: MessageCircle, accent: "purple" },
  awaiting_response: { icon: Timer, accent: "amber" },
  high_risk: { icon: AlertTriangle, accent: "red" },
  avg_response_time: { icon: Clock, accent: "blue" },
  response_coverage: { icon: ShieldCheck, accent: "green" },
  sentiment_change: { icon: Smile, accent: "purple" },
};

export default async function OverviewPage() {
  const scope = await getOrganizationScope();
  const dataSource = await getDataSource();

  const [metrics, openMentions, locations, locationMetrics, auditEvents, members] =
    await Promise.all([
      dataSource.mentions.metrics(scope),
      dataSource.mentions.listNeedingAttention(scope),
      dataSource.locations.list(scope),
      dataSource.locations.metrics(scope),
      dataSource.auditEvents.list(scope, { limit: 6 }),
      dataSource.memberships.listMembers(scope),
    ]);

  const analyses = await Promise.all(
    openMentions.slice(0, 4).map((mention) =>
      dataSource.mentions.latestAnalysis(scope, mention.id),
    ),
  );

  const attentionViews = toMentionViews(openMentions.slice(0, 4), {
    analyses: analyses.filter((analysis) => analysis !== null),
    locations,
  });

  const metricsByLocation = new Map(
    locationMetrics.map((entry) => [entry.locationId, entry]),
  );

  const locationRows: LocationRow[] = locations
    .filter((location) => location.status === "active")
    .flatMap((location) => {
      const entry = metricsByLocation.get(location.id);
      return entry ? [{ location, metrics: entry }] : [];
    });

  const actorNames = new Map(
    members.map((member) => [member.userId, member.user.fullName]),
  );

  return (
    <PageBody>
      <PageHeader
        title="Overview"
        description="Track reputation health, urgent issues, and cross-channel activity at a glance."
        actions={
          <>
            <Button icon={Download}>Export</Button>
            <Button icon={CalendarRange}>Last 30 days</Button>
          </>
        }
      />

      {/* Six across only once the viewport can give each card enough room for
          its label; three across from `lg` reads better at 1440. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {buildOverviewKpis(metrics).map((kpi) => {
          const presentation = KPI_PRESENTATION[kpi.id];
          return (
            <KpiCard
              key={kpi.id}
              kpi={kpi}
              icon={presentation?.icon}
              accent={presentation?.accent}
            />
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <NeedsAttentionCard
          className="xl:col-span-5"
          mentions={attentionViews}
          totalOpen={openMentions.length}
        />
        <ReputationPulseCard className="xl:col-span-4" data={metrics.sentimentTrend} />
        <SourceMixCard
          className="xl:col-span-3"
          entries={metrics.sourceMix}
          total={metrics.totalMentions}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <EmergingTopicsCard
          className="xl:col-span-4"
          topics={metrics.topTopics.slice(0, 6)}
        />
        <LocationComparisonCard className="xl:col-span-5" rows={locationRows} />
        <RecentActivityCard
          className="xl:col-span-3"
          events={auditEvents}
          actorNames={actorNames}
        />
      </div>
    </PageBody>
  );
}
