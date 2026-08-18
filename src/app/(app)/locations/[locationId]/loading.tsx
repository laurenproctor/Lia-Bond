import { PageBody } from "@/components/shell/app-shell";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/**
 * Route-level loading state for one location.
 *
 * Mirrors the loaded page: a title with the status badge, a four-up KPI row,
 * the details card on the left and the mapped-profiles card on the right.
 */
export default function LocationDetailLoading() {
  return (
    <PageBody>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3.5 w-40" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SkeletonCard lines={1} />
        <SkeletonCard lines={1} />
        <SkeletonCard lines={1} />
        <SkeletonCard lines={1} />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <SkeletonCard lines={8} />
        </div>
        <div className="xl:col-span-5">
          <SkeletonCard lines={4} />
        </div>
      </div>

      <span className="sr-only" role="status">
        Loading location
      </span>
    </PageBody>
  );
}
