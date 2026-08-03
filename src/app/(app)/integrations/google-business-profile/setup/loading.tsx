import { PageBody } from "@/components/shell/app-shell";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/**
 * Setup-specific loading state.
 *
 * This route calls Google during render — two round trips, for accounts and
 * then locations — so it can genuinely take a second or two, and the generic
 * dashboard skeleton would suggest the wrong shape. The skeleton below mirrors
 * the row list the user is waiting for.
 */
export default function GoogleSetupLoading() {
  return (
    <PageBody>
      <div className="space-y-2">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-3.5 w-96" />
      </div>

      <SkeletonCard lines={2} />

      <div className="lia-card flex flex-col gap-4 p-5">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-80" />
            <Skeleton className="h-8 w-64 rounded-lg" />
          </div>
        ))}
      </div>

      <span className="sr-only" role="status">
        Loading Google locations
      </span>
    </PageBody>
  );
}
