import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RiskBadge } from "@/components/ui/status-badge";
import type { OrganizationMetrics } from "@/lib/data/types";

type TopicTrend = OrganizationMetrics["topTopics"][number];

export interface EmergingTopicsCardProps {
  topics: TopicTrend[];
  className?: string;
}

/**
 * The themes appearing most often across every source.
 *
 * Ranked by volume with the worst risk level seen on any mention carrying that
 * topic — a topic that shows up three times but once on a critical mention
 * deserves the red badge.
 */
export function EmergingTopicsCard({ topics, className }: EmergingTopicsCardProps) {
  return (
    <Card flush className={className}>
      <CardHeader
        className="p-5 pb-3"
        title="Emerging topics"
        description="Themes appearing most often across every source."
      />

      {topics.length === 0 ? (
        <EmptyState
          title="No topics yet"
          description="Topics appear once mentions have been analyzed."
          size="sm"
        />
      ) : (
        <ul className="grid gap-2.5 px-5 pb-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {topics.map((topic) => (
            <li
              key={topic.topic}
              className="rounded-[10px] border border-gray-200 px-3 py-2.5"
            >
              <p className="truncate text-[13px] font-medium text-gray-950">
                {topic.topic}
              </p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold text-gray-700 tabular-nums">
                  {topic.mentions} {topic.mentions === 1 ? "mention" : "mentions"}
                </span>
                <RiskBadge risk={topic.riskLevel} short />
              </div>
            </li>
          ))}
        </ul>
      )}

      <CardFooter>
        <span className="text-gray-500">Highest risk seen on each topic</span>
        <Link
          href="/insights"
          className="inline-flex items-center gap-0.5 font-medium text-purple-600 hover:underline"
        >
          View all topics
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardFooter>
    </Card>
  );
}
