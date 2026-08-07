import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink, ShieldCheck } from "lucide-react";
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
  const data = await loadWorkspace(id, ["reddit_post", "reddit_comment"]);
  return { title: data?.selected.title ?? "Reddit conversation" };
}

export default async function RedditWorkspacePage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadWorkspace(id, ["reddit_post", "reddit_comment"]);
  if (!data) notFound();

  const { queue, selected, detail, publishing, canDecide, canEdit } = data;
  const primaryDraft = detail.drafts[0] ?? null;

  return (
    <PageBody>
      <PageHeader
        title="Reddit conversation"
        description="Engage in discussions where a reply helps, and never post without approval."
        actions={
          <>
            <Button icon={ExternalLink} iconPosition="trailing">
              View on Reddit
            </Button>
            <Button variant="primary" icon={ShieldCheck}>
              Send for approval
            </Button>
          </>
        }
      />

      <p className="flex items-center gap-2 rounded-lg border border-amber-600/25 bg-amber-100 px-3 py-2 text-[13px] text-gray-950">
        <ShieldCheck className="size-4 shrink-0 text-amber-600" aria-hidden />
        Reddit engagement is approval-first. Lia never posts to Reddit without a
        named approver.
      </p>

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <WorkspaceQueue
          className="xl:col-span-4"
          title="Thread queue"
          mentions={queue}
          selectedId={selected.id}
        />

        <div className="flex flex-col gap-4 xl:col-span-4">
          <MentionDetailCard mention={selected} analysis={detail.analysis} />
          <SectionPlaceholder
            title="Comment thread"
            description="Top comments with sentiment, so the room can be read before replying."
            shape="rows"
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-4">
          <Card>
            <CardHeader
              title="Reddit response"
              description="Held for a named approver before it can post."
            />
            <div className="mt-4">
              {primaryDraft ? (
                <ResponseComposer
                  key={primaryDraft.id}
                  draft={primaryDraft}
                  publishing={publishing}
                  canDecide={canDecide}
                  canEdit={canEdit}
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
            title="Internal notes"
            description="Context for approvers, visible only to the team."
            shape="lines"
          />
        </div>
      </div>
    </PageBody>
  );
}
