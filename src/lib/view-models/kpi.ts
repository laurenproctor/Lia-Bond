import type { OrganizationMetrics } from "@/lib/data/types";
import { formatDuration, formatPercent } from "@/lib/format";

/**
 * KPI presentation.
 *
 * A KPI card needs a headline value, a direction, and a shape. The repository
 * returns counts; this turns them into those three things.
 *
 * Where a real comparison period is not available yet, `changePercent` is 0 and
 * the card renders "No change" rather than inventing a delta. Fabricating a
 * trend to make a dashboard look alive is exactly the kind of lie this product
 * exists to avoid.
 */

export interface KpiTrend {
  /** Sparkline series, oldest first. */
  points: number[];
  changePercent: number;
  /** Whether an increase is a good outcome for this metric. */
  higherIsBetter: boolean;
  comparisonLabel: string;
}

export interface Kpi {
  id: string;
  label: string;
  value: string;
  trend: KpiTrend;
}

/**
 * Percentage change between the first and second halves of a daily series.
 *
 * Returns 0 when the earlier half has no data at all. "+100% versus a period
 * we have nothing for" is not a comparison, and rendering it as growth would
 * overstate what the numbers actually say.
 */
function halfOverHalfChange(values: number[]): number {
  if (values.length < 2) return 0;

  const midpoint = Math.floor(values.length / 2);
  const first = values.slice(0, midpoint).reduce((sum, value) => sum + value, 0);
  const second = values.slice(midpoint).reduce((sum, value) => sum + value, 0);

  if (first === 0) return 0;
  return Math.round(((second - first) / first) * 100);
}

export function buildOverviewKpis(metrics: OrganizationMetrics): Kpi[] {
  const trend = metrics.sentimentTrend;
  const totals = trend.map((point) => point.positive + point.neutral + point.negative);
  const negatives = trend.map((point) => point.negative);
  const positives = trend.map((point) => point.positive);

  const comparisonLabel = "vs first half";

  return [
    {
      id: "new_mentions",
      label: "New mentions",
      value: String(metrics.totalMentions),
      trend: {
        points: totals,
        changePercent: halfOverHalfChange(totals),
        higherIsBetter: true,
        comparisonLabel,
      },
    },
    {
      id: "awaiting_response",
      label: "Awaiting response",
      value: String(metrics.awaitingResponse),
      trend: {
        points: totals,
        changePercent: 0,
        higherIsBetter: false,
        comparisonLabel: "open now",
      },
    },
    {
      id: "high_risk",
      label: "High-risk mentions",
      value: String(metrics.highRiskMentions),
      trend: {
        points: negatives,
        changePercent: halfOverHalfChange(negatives),
        higherIsBetter: false,
        comparisonLabel,
      },
    },
    {
      id: "avg_response_time",
      label: "Average response time",
      value: formatDuration(metrics.averageFirstResponseMinutes),
      trend: {
        points: totals,
        changePercent: 0,
        higherIsBetter: false,
        comparisonLabel: "to first reply",
      },
    },
    {
      id: "response_coverage",
      label: "Response coverage",
      value: formatPercent(metrics.responseCoveragePercent),
      trend: {
        points: positives,
        changePercent: 0,
        higherIsBetter: true,
        comparisonLabel: "of repliable mentions",
      },
    },
    {
      id: "sentiment_change",
      label: "Positive share",
      value: formatPercent(
        metrics.totalMentions === 0
          ? 0
          : Math.round(
              (metrics.sentimentBreakdown.positive / metrics.totalMentions) * 100,
            ),
      ),
      trend: {
        points: positives,
        changePercent: halfOverHalfChange(positives),
        higherIsBetter: true,
        comparisonLabel,
      },
    },
  ];
}

export function buildInsightsKpis(metrics: OrganizationMetrics): Kpi[] {
  const trend = metrics.sentimentTrend;
  const positives = trend.map((point) => point.positive);
  const negatives = trend.map((point) => point.negative);
  const total = metrics.totalMentions || 1;

  return [
    {
      id: "positive_share",
      label: "Positive share",
      value: formatPercent(
        Math.round((metrics.sentimentBreakdown.positive / total) * 100),
      ),
      trend: {
        points: positives,
        changePercent: halfOverHalfChange(positives),
        higherIsBetter: true,
        comparisonLabel: "vs first half",
      },
    },
    {
      id: "negative_share",
      label: "Negative share",
      value: formatPercent(
        Math.round((metrics.sentimentBreakdown.negative / total) * 100),
      ),
      trend: {
        points: negatives,
        changePercent: halfOverHalfChange(negatives),
        higherIsBetter: false,
        comparisonLabel: "vs first half",
      },
    },
    {
      id: "mixed_share",
      label: "Mixed sentiment",
      value: formatPercent(Math.round((metrics.sentimentBreakdown.mixed / total) * 100)),
      trend: {
        points: trend.map((point) => point.neutral),
        changePercent: 0,
        higherIsBetter: false,
        comparisonLabel: "praise and complaint",
      },
    },
    {
      id: "high_risk_share",
      label: "High-risk share",
      value: formatPercent(Math.round((metrics.highRiskMentions / total) * 100)),
      trend: {
        points: negatives,
        changePercent: halfOverHalfChange(negatives),
        higherIsBetter: false,
        comparisonLabel: "vs first half",
      },
    },
  ];
}
