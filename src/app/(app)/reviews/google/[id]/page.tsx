import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileText, MapPin, Send } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { MentionDetailCard } from "@/components/mentions/mention-detail-card";
import { WorkspaceQueue } from "@/components/mentions/workspace-queue";
import { ResponseComposer } from "@/components/responses/response-composer";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { loadWorkspace } from "@/lib/view-models/workspace";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await loadWorkspace(id, ["google_review"]);
  return { title: data?.selected.title ?? "Google review response" };
}

export default async function GoogleReviewWorkspacePage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadWorkspace(id, ["google_review"]);
  if (!data) notFound();

  const { queue, selected, detail, publishing, canDecide, canEdit } = data;
  const primaryDraft = detail.drafts[0] ?? null;

  const needsResponse = queue.filter((mention) =>
    ["new", "analyzed", "draft_ready", "needs_approval"].includes(mention.status),
  ).length;
  const highRisk = queue.filter((mention) =>
    ["high", "critical"].includes(mention.riskLevel),
  ).length;

  return (
    <PageBody>
      <PageHeader
        title="Google review response"
        description="Manage and publish thoughtful responses to Google reviews."
        actions={
          <>
            <Button icon={MapPin}>{selected.locationLabel}</Button>
            <Button icon={FileText}>Preview response policy</Button>
            <Button variant="primary" icon={Send} disabled={publishing !== "direct"}>
              {publishing === "direct" ? "Publish reply" : "Manual publishing"}
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <WorkspaceQueue
          className="xl:col-span-4"
          title="Review queue"
          mentions={queue}
          selectedId={selected.id}
          controls={
            <SegmentedTabs
              label="Review queue filter"
              variant="chips"
              tabs={[
                { id: "all", label: "All", count: queue.length },
                { id: "needs_response", label: "Needs response", count: needsResponse },
                { id: "high_risk", label: "High risk", count: highRisk },
              ]}
            />
          }
        />

        <div className="flex flex-col gap-4 xl:col-span-4">
          <MentionDetailCard mention={selected} analysis={detail.analysis} />
          <SectionPlaceholder
            title="Customer history"
            description="Previous reviews and visits from this guest."
            shape="lines"
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-4">
          <Card>
            <CardHeader
              title="Response"
              description="Approvals are recorded in the audit trail."
            />
            <div className="mt-4">
              {primaryDraft ? (
                <ResponseComposer
                  draft={primaryDraft}
                  publishing={publishing}
                  canDecide={canDecide}
                  canEdit={canEdit}
                />
              ) : (
                <EmptyState
                  title="No draft yet"
                  description="Response generation arrives with the AI workflow. Until then, drafts are created by a person."
                  size="sm"
                />
              )}
            </div>
          </Card>
          <SectionPlaceholder
            title="Quality checklist and internal notes"
            description="Policy checks, and notes visible only to the team."
            shape="rows"
          />
        </div>
      </div>

      <SectionPlaceholder
        title="Response history"
        description="Draft generated, assigned, policy checked, edited, previewed, and published."
        shape="rows"
      />
    </PageBody>
  );
}
