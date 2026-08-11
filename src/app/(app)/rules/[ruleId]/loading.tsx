import { PageBody } from "@/components/shell/app-shell";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/**
 * Route-level loading state for a single rule.
 *
 * Mirrors what the loaded page renders: a title/description header with the
 * toggle and row actions on the right, the builder's stacked cards on the
 * left, and the readiness/simulation/history cards on the right.
 */
export default function RuleDetailLoading() {
  return (
    <PageBody>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-3.5 w-96" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-9 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
        <div className="flex flex-col gap-4 xl:col-span-5">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
          <SkeletonCard lines={5} />
        </div>
      </div>

      <span className="sr-only" role="status">
        Loading rule
      </span>
    </PageBody>
  );
}
