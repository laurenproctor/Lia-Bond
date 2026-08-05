import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink, Repeat } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { MentionDetailCard } from "@/components/mentions/mention-detail-card";
import { WorkspaceQueue } from "@/components/mentions/workspace-queue";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailField } from "@/components/ui/detail-panel";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { formatDateTime } from "@/lib/format";
import { loadWorkspace } from "@/lib/view-models/workspace";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await loadWorkspace(id, ["news_article"]);
  return { title: data?.selected.title ?? "News and media" };
}

/**
 * The news and media workspace.
 *
 * Unlike the review and Reddit workspaces this shares a layout with, Lia does
 * not hold the article: the free GNews tier returns a headline and a
 * description, and `normaliseGNewsArticle` deliberately discards the
 * truncated `content` field rather than store a partial article as if it were
 * complete. Every affordance here follows from that — a prominent link out to
 * the real source, and no response composer, since there is no path by which
 * Lia posts to a publication (D72).
 */
export default async function MediaWorkspacePage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadWorkspace(id, ["news_article"]);
  if (!data) notFound();

  const { queue, selected, detail } = data;
  const sourceUrl = detail.mention.sourceUrl;

  return (
    <PageBody>
      <PageHeader
        title="News and media"
        description="Assess coverage and check claims against the source. Lia cannot publish to a publication."
        actions={
          sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-purple-600 bg-purple-600 px-3 text-[13px] font-medium whitespace-nowrap text-white transition-colors hover:bg-purple-500 active:bg-purple-600"
            >
              Read at source
              <ExternalLink className="size-4 shrink-0" aria-hidden />
            </a>
          ) : null
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <WorkspaceQueue
          className="xl:col-span-4"
          title="Coverage queue"
          mentions={queue}
          selectedId={selected.id}
        />

        <div className="flex flex-col gap-4 xl:col-span-4">
          <MentionDetailCard mention={selected} analysis={detail.analysis} />
          {selected.sourceType === "news_article" ? (
            <p className="text-[12.5px] leading-relaxed text-gray-500">
              Lia holds the headline and summary above, not the full article —
              the free tier truncates article bodies, and a truncated copy
              stored as if it were complete would be quoted back as fact. Read
              the full story at the source before responding to it.
            </p>
          ) : null}
          <SectionPlaceholder
            title="Article comments"
            description="Comments on this article that mention the brand."
            shape="rows"
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-4">
          <Card>
            <CardHeader
              title="Article source"
              description="Where the rest of the story lives."
            />
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <DetailField label="Publisher">
                {selected.publisherName ?? "Unknown publisher"}
              </DetailField>
              <DetailField label="Published">{formatDateTime(selected.publishedAt)}</DetailField>
            </dl>

            {selected.isSyndicated ? (
              <Badge tone="amber" icon={Repeat} className="mt-3">
                Syndicated coverage
              </Badge>
            ) : null}

            <p className="mt-4 text-[13px] leading-relaxed text-gray-700">
              Media sources have no publishing API, so there is no response
              composer here. Reach out to the journalist by email or another
              channel Lia does not control.
            </p>
          </Card>
          <SectionPlaceholder
            title="Coverage timeline"
            description="How this story has developed across outlets."
            shape="rows"
          />
        </div>
      </div>
    </PageBody>
  );
}
