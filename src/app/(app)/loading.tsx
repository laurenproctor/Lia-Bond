import { PageBody } from "@/components/shell/app-shell";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/** Route-level loading state shared by every screen inside the shell. */
export default function AppLoading() {
  return (
    <PageBody>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3.5 w-80" />
        </div>
        <Skeleton className="h-9 w-36 rounded-lg" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <SkeletonCard key={index} lines={2} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <SkeletonCard lines={6} className="xl:col-span-2" />
        <SkeletonCard lines={6} />
      </div>

      <span className="sr-only" role="status">
        Loading
      </span>
    </PageBody>
  );
}
