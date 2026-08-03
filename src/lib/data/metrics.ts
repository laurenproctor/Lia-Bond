import type {
  Escalation,
  Location,
  Mention,
  MentionAnalysis,
  MentionStatus,
  Platform,
  ResponseDraft,
  Sentiment,
} from "@/domain";
import { MENTION_STATUSES, SENTIMENTS, SOURCE_TYPE_PLATFORM } from "@/domain";
import type {
  LocationMetrics,
  MentionStatusCounts,
  OrganizationMetrics,
} from "@/lib/data/types";

/**
 * Aggregations, as pure functions over rows.
 *
 * Both adapters call these, so the overview means the same thing whether the
 * rows came from Postgres or from the demo fixture. When volume outgrows
 * in-memory aggregation these become SQL views and the signatures stay put.
 */

const PLATFORM_LABELS: Record<Platform, string> = {
  google_business_profile: "Google",
  yelp: "Yelp",
  reddit: "Reddit",
  news_media: "News and media",
  disqus: "Article comments",
  trustpilot: "Trustpilot",
  tripadvisor: "Tripadvisor",
  facebook: "Facebook",
  instagram: "Instagram",
};

/** Statuses that mean a human still owes this mention a decision. */
const OPEN_STATUSES: readonly MentionStatus[] = [
  "new",
  "analyzed",
  "draft_ready",
  "needs_approval",
  "escalated",
];

export function isOpenStatus(status: MentionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function countByStatus(mentions: Mention[]): MentionStatusCounts {
  const byStatus = Object.fromEntries(
    MENTION_STATUSES.map((status) => [status, 0]),
  ) as Record<MentionStatus, number>;

  for (const mention of mentions) {
    byStatus[mention.status] += 1;
  }

  return { total: mentions.length, byStatus };
}

/** Day key in UTC, so bucketing does not shift with the server's locale. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function buildSentimentTrend(
  mentions: Mention[],
  days: number,
  referenceNow: string,
): OrganizationMetrics["sentimentTrend"] {
  const end = Date.parse(referenceNow);
  const buckets = new Map<string, { positive: number; neutral: number; negative: number }>();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = dayKey(new Date(end - offset * 86_400_000).toISOString());
    buckets.set(key, { positive: 0, neutral: 0, negative: 0 });
  }

  for (const mention of mentions) {
    const bucket = buckets.get(dayKey(mention.publishedAt));
    if (!bucket) continue;

    // "mixed" counts toward neutral in the trend: the chart answers "how is the
    // week going", and a mixed mention is genuinely neither win nor loss.
    if (mention.sentiment === "positive") bucket.positive += 1;
    else if (mention.sentiment === "negative") bucket.negative += 1;
    else bucket.neutral += 1;
  }

  return [...buckets.entries()].map(([date, counts]) => ({
    date: `${date}T00:00:00.000Z`,
    ...counts,
  }));
}

function buildSourceMix(mentions: Mention[]): OrganizationMetrics["sourceMix"] {
  const counts = new Map<Platform, number>();

  for (const mention of mentions) {
    const platform = SOURCE_TYPE_PLATFORM[mention.sourceType];
    counts.set(platform, (counts.get(platform) ?? 0) + 1);
  }

  const total = mentions.length || 1;

  return [...counts.entries()]
    .map(([platform, count]) => ({
      platform,
      label: PLATFORM_LABELS[platform],
      count,
      share: Math.round((count / total) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);
}

function buildTopTopics(
  analyses: MentionAnalysis[],
  mentionsById: Map<string, Mention>,
): OrganizationMetrics["topTopics"] {
  const counts = new Map<string, { mentions: number; worstRisk: Mention["riskLevel"] }>();
  const severity = { low: 0, medium: 1, high: 2, critical: 3 } as const;

  for (const analysis of analyses) {
    const mention = mentionsById.get(analysis.mentionId);
    for (const topic of analysis.topics) {
      const existing = counts.get(topic) ?? { mentions: 0, worstRisk: "low" as const };
      const risk = mention?.riskLevel ?? "low";
      counts.set(topic, {
        mentions: existing.mentions + 1,
        worstRisk:
          severity[risk] > severity[existing.worstRisk] ? risk : existing.worstRisk,
      });
    }
  }

  return [...counts.entries()]
    .map(([topic, value]) => ({
      topic,
      mentions: value.mentions,
      riskLevel: value.worstRisk,
    }))
    .sort((a, b) => b.mentions - a.mentions || a.topic.localeCompare(b.topic));
}

/**
 * Minutes from a mention being published to its first response being published.
 *
 * Only counts drafts that actually went out; a draft sitting in review is not a
 * response time, it is a backlog.
 */
function averageFirstResponseMinutes(
  mentions: Mention[],
  drafts: ResponseDraft[],
): number {
  const firstPublished = new Map<string, number>();

  for (const draft of drafts) {
    if (!draft.publishedAt) continue;
    const published = Date.parse(draft.publishedAt);
    const existing = firstPublished.get(draft.mentionId);
    if (existing === undefined || published < existing) {
      firstPublished.set(draft.mentionId, published);
    }
  }

  const durations: number[] = [];
  for (const mention of mentions) {
    const responded = firstPublished.get(mention.id);
    if (responded === undefined) continue;
    const minutes = (responded - Date.parse(mention.publishedAt)) / 60_000;
    if (minutes >= 0) durations.push(minutes);
  }

  if (durations.length === 0) return 0;
  return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
}

export interface MetricsInput {
  mentions: Mention[];
  analyses: MentionAnalysis[];
  drafts: ResponseDraft[];
  referenceNow: string;
  trendDays?: number;
}

export function computeOrganizationMetrics({
  mentions,
  analyses,
  drafts,
  referenceNow,
  trendDays = 30,
}: MetricsInput): OrganizationMetrics {
  const mentionsById = new Map(mentions.map((mention) => [mention.id, mention]));

  const sentimentBreakdown = Object.fromEntries(
    SENTIMENTS.map((value) => [value, 0]),
  ) as Record<Sentiment, number>;
  for (const mention of mentions) sentimentBreakdown[mention.sentiment] += 1;

  const respondedMentions = mentions.filter(
    (mention) => mention.status === "responded",
  ).length;

  // Coverage measures mentions that warranted a reply, so deliberate
  // no-action and dismissed rows are excluded from the denominator rather than
  // quietly counted as failures.
  const actionable = mentions.filter(
    (mention) =>
      mention.status !== "no_action_recommended" && mention.status !== "dismissed",
  ).length;

  return {
    totalMentions: mentions.length,
    newMentions: mentions.filter((mention) => mention.status === "new").length,
    awaitingResponse: mentions.filter((mention) => isOpenStatus(mention.status)).length,
    highRiskMentions: mentions.filter(
      (mention) => mention.riskLevel === "high" || mention.riskLevel === "critical",
    ).length,
    respondedMentions,
    responseCoveragePercent:
      actionable === 0 ? 0 : Math.round((respondedMentions / actionable) * 100),
    averageFirstResponseMinutes: averageFirstResponseMinutes(mentions, drafts),
    sentimentBreakdown,
    sourceMix: buildSourceMix(mentions),
    sentimentTrend: buildSentimentTrend(mentions, trendDays, referenceNow),
    topTopics: buildTopTopics(analyses, mentionsById),
  };
}

export function computeLocationMetrics(
  locations: Location[],
  mentions: Mention[],
  drafts: ResponseDraft[],
): LocationMetrics[] {
  return locations.map((location) => {
    const scoped = mentions.filter((mention) => mention.locationId === location.id);
    const ratings = scoped
      .map((mention) => mention.rating)
      .filter((rating): rating is number => rating !== null);

    const responded = scoped.filter((mention) => mention.status === "responded").length;
    const actionable = scoped.filter(
      (mention) =>
        mention.status !== "no_action_recommended" && mention.status !== "dismissed",
    ).length;

    const positive = scoped.filter((mention) => mention.sentiment === "positive").length;
    const negative = scoped.filter((mention) => mention.sentiment === "negative").length;

    const scopedDrafts = drafts.filter((draft) =>
      scoped.some((mention) => mention.id === draft.mentionId),
    );

    return {
      locationId: location.id,
      mentionVolume: scoped.length,
      averageRating:
        ratings.length === 0
          ? null
          : Math.round(
              (ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 10,
            ) / 10,
      sentiment:
        scoped.length === 0
          ? "unknown"
          : positive > negative
            ? "positive"
            : negative > positive
              ? "negative"
              : "neutral",
      responseCoveragePercent:
        actionable === 0 ? 0 : Math.round((responded / actionable) * 100),
      averageResponseMinutes: averageFirstResponseMinutes(scoped, scopedDrafts),
      riskMentions: scoped.filter(
        (mention) => mention.riskLevel === "high" || mention.riskLevel === "critical",
      ).length,
    };
  });
}

/** Queue order: worst risk first, then newest. */
export function rankByUrgency(mentions: Mention[]): Mention[] {
  const severity = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return [...mentions].sort(
    (a, b) =>
      severity[a.riskLevel] - severity[b.riskLevel] ||
      Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}

export function countOpenEscalations(escalations: Escalation[]): number {
  return escalations.filter(
    (escalation) => escalation.status !== "resolved" && escalation.status !== "dismissed",
  ).length;
}
