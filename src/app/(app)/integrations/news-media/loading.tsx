import { PageBody } from "@/components/shell/app-shell";
import { Skeleton, SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";

/**
 * Route-level loading state for the news and media screen.
 *
 * This route joins several tables per query — poll runs and rejected
 * candidates, merged across every monitoring query — so the generic shell
 * skeleton would finish before the page actually could. The shape below
 * mirrors what the loaded page renders: a capability card, the query table,
 * and two history tables underneath it.
 */
export default function NewsMediaLoading() {
  return (
    <PageBody>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3.5 w-80" />
        </div>
        <Skeleton className="h-9 w-40 rounded-lg" />
      </div>

      <SkeletonCard lines={4} />

      <div className="lia-card p-5">
        <Skeleton className="h-4 w-48" />
        <SkeletonRows rows={3} className="mt-3" />
      </div>

      <div className="lia-card p-5">
        <Skeleton className="h-4 w-40" />
        <SkeletonRows rows={4} className="mt-3" />
      </div>

      <span className="sr-only" role="status">
        Loading news and media
      </span>
    </PageBody>
  );
}
