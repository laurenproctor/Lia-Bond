import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MessagesSquare, Plug } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDataSource } from "@/lib/data";
import { getOrganizationScope } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "Reddit" };

/**
 * "Reddit" in the sidebar opens the workspace on the most recent thread rather
 * than an extra index screen — the queue lives inside the workspace.
 *
 * The empty case gets a screen instead of the `notFound()` this used to raise,
 * for the reason `/reviews` and `/media` do: nothing to open is a setup state,
 * not a missing page. Reddit's version is the flattest of the three because
 * there is only one thing it can be. There is no Reddit connector — no
 * monitor, no persistence, no poller, and `getConnector("reddit")` throws — so
 * no organization can connect Reddit today and no readiness ladder would have
 * a second rung. See `docs/integrations/reddit.md` for what has to clear
 * before one exists.
 *
 * The copy says "not available yet" rather than "connect Reddit" deliberately.
 * Offering a connection that cannot be made would be the same broken promise
 * the 404 was, one screen later.
 */
export default async function RedditIndexPage() {
  const scope = await getOrganizationScope();
  const dataSource = await getDataSource();

  // Both source types, matching `loadWorkspace` in `/reddit/[id]` — an
  // organization whose only Reddit mention is a comment has a workspace to
  // open, and listing posts alone would have sent it here instead.
  const [first] = await dataSource.mentions.list(scope, {
    sourceTypes: ["reddit_post", "reddit_comment"],
    limit: 1,
  });

  if (first) redirect(`/reddit/${first.id}`);

  return (
    <PageBody>
      <PageHeader
        title="Reddit"
        description="Threads and comments where your brands and locations come up."
      />

      <Card>
        <EmptyState
          icon={MessagesSquare}
          title="Reddit monitoring is not available yet"
          description="Lia cannot watch Reddit on your behalf today. Reddit requires approved commercial API access before any tool can read threads or post replies, and that approval is not in place — so no Reddit conversation will appear here yet. When it is, engagement stays approval-first: Lia will never post without a named approver."
          action={
            <ButtonLink href="/integrations" size="lg" icon={Plug}>
              See connected sources
            </ButtonLink>
          }
        />
      </Card>
    </PageBody>
  );
}
