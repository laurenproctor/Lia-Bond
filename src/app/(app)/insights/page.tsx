import type { Metadata } from "next";
import { CalendarRange, Download } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { EmergingTopicsCard } from "@/components/overview/emerging-topics-card";
import { ReputationPulseCard } from "@/components/overview/reputation-pulse-card";
import { SourceMixCard } from "@/components/overview/source-mix-card";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { KpiCard } from "@/components/ui/kpi-card";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { SelectFilter } from "@/components/ui/select-filter";
import { getDataSource } from "@/lib/data";
import { getOrganizationScope } from "@/lib/tenancy/organization-context";
import { buildInsightsKpis } from "@/lib/view-models/kpi";

export const metadata: Metadata = { title: "Insights" };

export default async function InsightsPage() {
  const scope = await getOrganizationScope();
  const dataSource = await getDataSource();

  const [metrics, locations] = await Promise.all([
    dataSource.mentions.metrics(scope),
    dataSource.locations.list(scope),
  ]);

  return (
    <PageBody>
      <PageHeader
        title="Insights"
        description="What public feedback is telling you to fix, keep, and watch."
        actions={
          <>
            <Button icon={Download}>Export</Button>
            <Button icon={CalendarRange}>Last 30 days</Button>
          </>
        }
      >
        <FilterBar>
          <SelectFilter
            label="Location"
            options={[
              { value: "all", label: "All locations" },
              ...locations.map((location) => ({
                value: location.id,
                label: location.name,
              })),
            ]}
          />
          <SelectFilter
            label="Source"
            options={[
              { value: "all", label: "All sources" },
              { value: "reviews", label: "Reviews only" },
              { value: "social", label: "Social only" },
              { value: "media", label: "Media only" },
            ]}
          />
        </FilterBar>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {buildInsightsKpis(metrics).map((kpi) => (
          <KpiCard key={kpi.id} kpi={kpi} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <ReputationPulseCard className="xl:col-span-8" data={metrics.sentimentTrend} />
        <SourceMixCard
          className="xl:col-span-4"
          entries={metrics.sourceMix}
          total={metrics.totalMentions}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <EmergingTopicsCard className="xl:col-span-5" topics={metrics.topTopics} />
        <SectionPlaceholder
          className="xl:col-span-7"
          title="Cross-channel topic trends"
          description="How each topic moves across reviews, discussions, and media over time."
          shape="chart"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <SectionPlaceholder
          className="xl:col-span-4"
          title="Reputation drivers"
          description="Which themes move sentiment the most, in both directions."
          shape="chart"
        />
        <SectionPlaceholder
          className="xl:col-span-4"
          title="Emerging issues"
          description="Themes accelerating fast enough to need an operational answer."
          shape="rows"
        />
        <SectionPlaceholder
          className="xl:col-span-4"
          title="Response intelligence"
          description="Which response patterns actually change sentiment and rating."
          shape="chart"
        />
      </div>

      <SectionPlaceholder
        title="Praised menu items and recurring themes"
        description="What guests name by dish, server, and occasion."
        shape="grid"
      />
    </PageBody>
  );
}
