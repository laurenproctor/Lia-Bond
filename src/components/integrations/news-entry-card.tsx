import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { PlatformGlyph } from "@/components/ui/source-badge";
import { ConnectionStatusBadge } from "@/components/ui/status-badge";
import { PLATFORM_LABELS } from "@/lib/labels";

/**
 * The entry point to news and media, for an organization with no connection
 * row yet.
 *
 * Extracted from `integrations/page.tsx`, the same move `connection-summary.tsx`
 * made for Google when review sync pushed that page past its size limit —
 * presentational only, no data fetching of its own.
 *
 * News has no "Connect" button the way Google does: its connection is
 * provisioned implicitly the first time a monitoring query is saved, on the
 * detail screen itself (`createMonitoringQuery` in `query-service.ts`). So
 * this card, not an OAuth form, is the only way a brand-new organization
 * reaches that screen. The page renders it only while no `news_media`
 * connection row exists yet — once one does, the generic connections grid's
 * own "Manage" link takes over, so the two never show at once.
 */
export function NewsEntryCard({ available }: { available: boolean }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <PlatformGlyph platform="news_media" size="md" />
            {PLATFORM_LABELS.news_media}
          </span>
        }
        description="Search news coverage for terms you define, and see it in the same inbox as your reviews."
        actions={<ConnectionStatusBadge status="disconnected" />}
      />
      <p className="mt-3 text-[13px] text-gray-700">
        {available
          ? "Add a monitoring query to start. Lia provisions this connection the first time you save one."
          : "News monitoring is not configured on this server. Your administrator needs to set the GNews API key before a query can be polled."}
      </p>
      <div className="mt-4">
        <Link
          href="/integrations/news-media"
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
        >
          Set up news and media
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}
