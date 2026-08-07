import "server-only";

import { resolvePublishingMode, type MentionSourceType, type PublishingMode } from "@/domain";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import type { MentionDetail } from "@/lib/data/types";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { toMentionViews, type MentionView } from "@/lib/view-models/mention";

/**
 * Shared loader for the three workspace screens.
 *
 * Google reviews, Reddit threads, and articles differ in what they render but
 * not in what they need: a queue, a selected record, its analysis, its drafts,
 * and what the connector permits. Loading that once here keeps the three page
 * components thin and stops their data shapes drifting apart.
 */

export interface WorkspaceData {
  queue: MentionView[];
  selected: MentionView;
  detail: MentionDetail;
  /** What the source connector actually allows for responses. */
  publishing: PublishingMode;
  canDecide: boolean;
  canEdit: boolean;
}

export async function loadWorkspace(
  mentionId: string,
  sourceTypes: MentionSourceType[],
): Promise<WorkspaceData | null> {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();

  const detail = await dataSource.mentions.getDetail(context.scope, mentionId);
  if (!detail || !sourceTypes.includes(detail.mention.sourceType)) return null;

  const [queueMentions, locations] = await Promise.all([
    dataSource.mentions.list(context.scope, { sourceTypes, limit: 50 }),
    dataSource.locations.list(context.scope),
  ]);

  const analyses = await Promise.all(
    queueMentions.map((mention) =>
      dataSource.mentions.latestAnalysis(context.scope, mention.id),
    ),
  );

  const queue = toMentionViews(queueMentions, {
    analyses: analyses.filter((analysis) => analysis !== null),
    locations,
  });

  const [selected] = toMentionViews([detail.mention], {
    analyses: detail.analysis ? [detail.analysis] : [],
    locations,
  });

  if (!selected) return null;

  return {
    queue,
    selected,
    detail,
    // Derived from the connector's capabilities, never assumed from the
    // platform name — this is what keeps the publishing promise honest.
    publishing: detail.connection
      ? resolvePublishingMode(detail.connection.capabilities)
      : "unavailable",
    canDecide: can(context.role, "response.decide"),
    canEdit: can(context.role, "response.edit"),
  };
}
