import type { Metadata } from "next";
import { CalendarRange, Download, Star } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { AnalysisPanel } from "@/components/mentions/analysis-panel";
import { MentionDetailPane } from "@/components/mentions/mention-detail-pane";
import { MentionListItem } from "@/components/mentions/mention-list-item";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { SelectFilter } from "@/components/ui/select-filter";
import { isAiAvailable } from "@/ai/registry";
import { getAnalysisStatus } from "@/lib/analysis/analyze";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { resolveSelection } from "@/lib/selection";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { toMentionViews } from "@/lib/view-models/mention";
import type { MentionSourceType } from "@/domain";

export const metadata: Metadata = { title: "Mentions" };

const REVIEW_TYPES: MentionSourceType[] = [
  "google_review",
  "yelp_review",
  "trustpilot_review",
  "tripadvisor_review",
];
const REDDIT_TYPES: MentionSourceType[] = ["reddit_post", "reddit_comment"];

interface MentionsPageProps {
  searchParams: Promise<{ mention?: string }>;
}

export default async function MentionsPage({ searchParams }: MentionsPageProps) {
  const { mention: mentionParam } = await searchParams;
  const context = await getOrganizationContext();
  const { scope, role } = context;
  const dataSource = await getDataSource();

  const [mentions, locations, counts, analysisStatus] = await Promise.all([
    dataSource.mentions.list(scope, { limit: 50 }),
    dataSource.locations.list(scope),
    dataSource.mentions.counts(scope),
    getAnalysisStatus({ dataSource, scope }),
  ]);

  const analyses = await Promise.all(
    mentions.map((mention) => dataSource.mentions.latestAnalysis(scope, mention.id)),
  );

  const views = toMentionViews(mentions, {
    analyses: analyses.filter((analysis) => analysis !== null),
    locations,
  });

  const selected = resolveSelection(views, mentionParam, (view) => view.id);
  const selectedDrafts = selected
    ? await dataSource.responseDrafts.list(scope, { mentionId: selected.id })
    : [];

  const countOf = (types: MentionSourceType[]) =>
    mentions.filter((mention) => types.includes(mention.sourceType)).length;

  return (
    <PageBody>
      <PageHeader
        title="Mentions"
        description="Monitor reviews, discussions, and media coverage from one inbox."
        actions={
          <>
            <Button icon={Download}>Export</Button>
            <Button variant="primary" icon={Star}>
              Saved views
            </Button>
          </>
        }
      >
        <FilterBar trailing={<Button icon={CalendarRange}>Last 30 days</Button>}>
          <SearchInput
            label="Search mentions"
            placeholder="Search mentions…"
            className="w-full max-w-64"
          />
          <SelectFilter
            label="Source"
            options={[
              { value: "all", label: "All sources" },
              { value: "google_business_profile", label: "Google" },
              { value: "yelp", label: "Yelp" },
              { value: "reddit", label: "Reddit" },
              { value: "news_media", label: "News and media" },
            ]}
          />
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
            label="Sentiment"
            options={[
              { value: "all", label: "All sentiments" },
              { value: "positive", label: "Positive" },
              { value: "neutral", label: "Neutral" },
              { value: "mixed", label: "Mixed" },
              { value: "negative", label: "Negative" },
            ]}
          />
          <Button>More filters</Button>
        </FilterBar>

        <SegmentedTabs
          label="Source"
          tabs={[
            { id: "all", label: "All", count: mentions.length },
            { id: "reviews", label: "Reviews", count: countOf(REVIEW_TYPES) },
            { id: "reddit", label: "Reddit", count: countOf(REDDIT_TYPES) },
            {
              id: "media",
              label: "News and media",
              count: countOf(["news_article"]),
            },
            {
              id: "comments",
              label: "Article comments",
              count: countOf(["article_comment"]),
            },
          ]}
        />

        <SegmentedTabs
          label="Workflow status"
          variant="chips"
          tabs={[
            { id: "all", label: "All status", count: counts.total },
            { id: "new", label: "New", count: counts.byStatus.new },
            {
              id: "needs_approval",
              label: "Needs approval",
              count: counts.byStatus.needs_approval,
            },
            { id: "escalated", label: "Escalated", count: counts.byStatus.escalated },
            { id: "monitoring", label: "Monitoring", count: counts.byStatus.monitoring },
          ]}
        />
      </PageHeader>

      <Card>
        <AnalysisPanel
          unanalyzedCount={analysisStatus.unanalyzedCount}
          lastRunAt={analysisStatus.lastSuccessful?.completedAt ?? null}
          lastStatus={analysisStatus.latest?.status ?? null}
          lastErrorMessage={analysisStatus.latest?.errorMessage ?? null}
          running={analysisStatus.running}
          canAnalyze={can(role, "mention.analyze")}
          available={isAiAvailable()}
        />
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <Card flush className="xl:col-span-5">
          <CardHeader className="p-4 pb-3" title="Mention queue" />
          {views.length === 0 ? (
            <EmptyState
              title="No mentions yet"
              description="Once a source is connected and synced, mentions appear here."
              size="sm"
            />
          ) : (
            <ul className="lia-scroll max-h-[calc(100dvh-22rem)] divide-y divide-gray-200 overflow-y-auto border-t border-gray-200">
              {views.map((mention) => (
                <MentionListItem
                  key={mention.id}
                  mention={mention}
                  href={`/mentions?mention=${mention.id}`}
                  selected={mention.id === selected?.id}
                  scroll={false}
                />
              ))}
            </ul>
          )}
        </Card>

        {selected ? (
          <MentionDetailPane
            className="xl:col-span-7 xl:max-h-[calc(100dvh-16rem)]"
            mention={selected}
            drafts={selectedDrafts}
          />
        ) : (
          <Card className="xl:col-span-7">
            <EmptyState
              title="Nothing selected"
              description="Once a source is connected and synced, select a mention to see its details."
              size="sm"
            />
          </Card>
        )}
      </div>
    </PageBody>
  );
}
