import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink, Mail } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { MentionDetailCard } from "@/components/mentions/mention-detail-card";
import { WorkspaceQueue } from "@/components/mentions/workspace-queue";
import { ResponseComposer } from "@/components/responses/response-composer";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { loadWorkspace } from "@/lib/view-models/workspace";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await loadWorkspace(id, ["news_article"]);
  return { title: data?.selected.title ?? "News and media" };
}

export default async function MediaWorkspacePage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadWorkspace(id, ["news_article"]);
  if (!data) notFound();

  const { queue, selected, detail, publishing, canDecide } = data;
  const primaryDraft = detail.drafts[0] ?? null;

  return (
    <PageBody>
      <PageHeader
        title="News and media"
        description="Assess coverage, check claims, and decide how to respond."
        actions={
          <>
            <Button icon={ExternalLink} iconPosition="trailing">
              Open article
            </Button>
            <Button variant="primary" icon={Mail}>
              Draft journalist email
            </Button>
          </>
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
          <SectionPlaceholder
            title="Article comments"
            description="Comments on this article that mention the brand."
            shape="rows"
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-4">
          <Card>
            <CardHeader
              title="Media response"
              description="Media sources have no publishing API. Responses go by email or an owned channel."
            />
            <div className="mt-4">
              {primaryDraft ? (
                <ResponseComposer
                  draft={primaryDraft}
                  publishing={publishing}
                  canDecide={canDecide}
                />
              ) : (
                <EmptyState
                  title="No draft yet"
                  description="Response generation arrives with the AI workflow."
                  size="sm"
                />
              )}
            </div>
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
