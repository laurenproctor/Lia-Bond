import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Newspaper, Radar, Settings2 } from "lucide-react";
import type { MembershipRole } from "@/domain";
import { PageBody } from "@/components/shell/app-shell";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import type { MediaReadinessState } from "@/lib/integrations/media-readiness";
import { mediaReadiness } from "@/lib/integrations/media-readiness";
import { isNewsMonitorAvailable } from "@/news/registry";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "News and media" };

const NEWS_INTEGRATION_PATH = "/integrations/news-media";

/**
 * "News and media" in the sidebar opens the workspace on the most recent
 * article rather than an extra index screen — the queue lives inside the
 * workspace.
 *
 * When there is no most recent article there is nothing to open, and this used
 * to raise `notFound()`, which is the same mistake `/reviews` made: an
 * unfinished setup step reported as a broken link. The empty case now names
 * the step that is missing and offers it.
 */
export default async function MediaIndexPage() {
  const [context, dataSource] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
  ]);
  const { scope, role } = context;

  const [first] = await dataSource.mentions.list(scope, {
    sourceTypes: ["news_article"],
    limit: 1,
  });

  if (first) redirect(`/media/${first.id}`);

  const queries = await dataSource.monitoringQueries.list(scope);
  const readiness = mediaReadiness({
    monitorAvailable: isNewsMonitorAvailable(),
    queries,
  });

  return (
    <PageBody>
      <PageHeader
        title="News and media"
        description="Coverage found by the monitoring queries you set for this organization."
      />

      <Card>
        <EmptyState
          icon={Newspaper}
          title={readiness.title}
          description={readiness.description}
          action={<ReadinessAction state={readiness.state} role={role} />}
        />
      </Card>
    </PageBody>
  );
}

/**
 * The one thing to do next.
 *
 * Every actionable state leads to the same place — queries, polling, and the
 * poll history all live on the news integration page — so the branch decides
 * the label rather than the destination. The label only promises the action
 * when the role can actually take it; everybody else gets the page itself,
 * which is readable by all members, and can take it to whoever can act.
 */
function ReadinessAction({
  state,
  role,
}: {
  state: MediaReadinessState;
  role: MembershipRole;
}) {
  // Nothing on the integration page helps when the server has no API key —
  // that is an administrator's job, and the description already says so.
  if (state === "not_configured") return null;

  if (state === "no_queries" && can(role, "monitoring.manage_queries")) {
    return (
      <ButtonLink href={NEWS_INTEGRATION_PATH} size="lg" icon={Radar}>
        Add a monitoring query
      </ButtonLink>
    );
  }

  if (state === "never_polled" && can(role, "monitoring.poll_now")) {
    return (
      <ButtonLink href={NEWS_INTEGRATION_PATH} size="lg" icon={Radar}>
        Run a poll
      </ButtonLink>
    );
  }

  return (
    <ButtonLink href={NEWS_INTEGRATION_PATH} size="lg" icon={Settings2}>
      Open news and media
    </ButtonLink>
  );
}
