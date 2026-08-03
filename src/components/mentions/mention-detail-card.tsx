import { Sparkles } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailField, DetailSection } from "@/components/ui/detail-panel";
import { RatingStars } from "@/components/ui/rating-stars";
import { SourceBadge } from "@/components/ui/source-badge";
import { RecommendedActionBadge, RiskBadge, SentimentBadge } from "@/components/ui/status-badge";
import { formatRelativeLong } from "@/lib/format";
import type { MentionAnalysis } from "@/domain";
import type { MentionView } from "@/lib/view-models/mention";

export interface MentionDetailCardProps {
  mention: MentionView;
  analysis: MentionAnalysis | null;
  className?: string;
}

/**
 * The source record and what Lia made of it.
 *
 * Analysis is optional on purpose: a mention that has only just arrived has no
 * analysis yet, and the screen says so rather than rendering an empty summary
 * box that reads like the model found nothing.
 */
export function MentionDetailCard({
  mention,
  analysis,
  className,
}: MentionDetailCardProps) {
  return (
    <Card className={className}>
      <CardHeader
        title={<SourceBadge platform={mention.platform} context={mention.contextLabel} size="md" />}
        actions={
          <span className="text-[12px] text-gray-500">
            {formatRelativeLong(mention.publishedAt)}
          </span>
        }
      />

      <div className="mt-4 flex items-start gap-3">
        <Avatar initials={mention.authorInitials} name={mention.authorName} size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-gray-950">{mention.authorName}</p>
          {mention.rating !== null ? (
            <RatingStars rating={mention.rating} className="mt-0.5" />
          ) : null}
        </div>
      </div>

      {mention.title ? (
        <h3 className="mt-3 text-[15px] font-semibold text-gray-950">{mention.title}</h3>
      ) : null}
      <p className="mt-2 text-[13.5px] leading-relaxed whitespace-pre-line text-gray-700">
        {mention.content}
      </p>

      <div className="mt-4 space-y-4">
        {analysis ? (
          <>
            <DetailSection
              title="Lia summary"
              actions={<Sparkles className="size-4 text-purple-600" aria-hidden />}
            >
              <p className="text-[13px] text-gray-700">
                {analysis.relevanceExplanation ?? "No summary was recorded."}
              </p>
            </DetailSection>

            <DetailSection title="Detected topics">
              {analysis.topics.length === 0 ? (
                <p className="text-[13px] text-gray-500">No topics were detected.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {analysis.topics.map((topic) => (
                    <Badge key={topic}>{topic}</Badge>
                  ))}
                </div>
              )}
            </DetailSection>

            <DetailSection title="Assessment">
              <dl className="grid grid-cols-2 gap-4">
                <DetailField label="Sentiment">
                  <SentimentBadge sentiment={mention.sentiment} />
                </DetailField>
                <DetailField label="Risk level">
                  <RiskBadge risk={mention.riskLevel} />
                </DetailField>
              </dl>
            </DetailSection>

            <DetailSection title="Recommended action">
              <RecommendedActionBadge action={analysis.recommendedAction} />
              <p className="mt-2 text-[13px] text-gray-700">
                {analysis.recommendationExplanation ?? "No rationale was recorded."}
              </p>
            </DetailSection>

            {analysis.factsNeedingVerification.length > 0 ? (
              <DetailSection title="Verify before responding">
                <ul className="list-inside list-disc space-y-1 text-[13px] text-gray-700">
                  {analysis.factsNeedingVerification.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
              </DetailSection>
            ) : null}
          </>
        ) : (
          <DetailSection title="Analysis">
            <p className="text-[13px] text-gray-500">
              This mention has not been analyzed yet. Sentiment and risk shown above
              are the ingest defaults.
            </p>
          </DetailSection>
        )}
      </div>
    </Card>
  );
}
