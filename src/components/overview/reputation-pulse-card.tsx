import { ChartContainer } from "@/components/charts/chart-container";
import { SentimentTrendChart } from "@/components/charts/sentiment-trend-chart";
import { SelectFilter } from "@/components/ui/select-filter";
import { STATUS_COLORS } from "@/lib/chart-theme";
import { formatDate } from "@/lib/format";
import type { OrganizationMetrics } from "@/lib/data/types";

type TrendPoint = OrganizationMetrics["sentimentTrend"][number];

export interface ReputationPulseCardProps {
  data: TrendPoint[];
  className?: string;
}

export function ReputationPulseCard({ data, className }: ReputationPulseCardProps) {
  const first = data[0];
  const last = data[data.length - 1];

  return (
    <ChartContainer
      title="Reputation pulse"
      hint="Daily mention volume split by sentiment."
      className={className}
      height={236}
      legend={[
        { label: "Positive", color: STATUS_COLORS.positive },
        { label: "Neutral", color: STATUS_COLORS.neutral },
        { label: "Negative", color: STATUS_COLORS.negative },
      ]}
      actions={
        <>
          <SelectFilter
            label="Interval"
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
            ]}
          />
          <SelectFilter
            label="Series"
            options={[
              { value: "mentions", label: "Mentions and sentiment" },
              { value: "rating", label: "Rating" },
            ]}
          />
        </>
      }
      summary={
        first && last
          ? `Sentiment from ${formatDate(first.date)} to ${formatDate(last.date)}: positive moved from ${first.positive} to ${last.positive}, neutral from ${first.neutral} to ${last.neutral}, negative from ${first.negative} to ${last.negative} mentions per day.`
          : undefined
      }
    >
      <SentimentTrendChart data={data} />
    </ChartContainer>
  );
}
