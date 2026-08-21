import { PageBody } from "@/components/shell/app-shell";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

/**
 * Route-level loading state for billing.
 *
 * Its own skeleton rather than the shell's, because this route makes a live
 * Stripe call — `loadBillingView` prices the current subscription — and a
 * network round trip to a third party is exactly the case the generic
 * skeleton finishes too early for.
 *
 * The shape mirrors the loaded page: plan on the left, capacity beneath it,
 * and the action column on the right.
 */
export default function BillingLoading() {
  return (
    <PageBody>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-3.5 w-72" />
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={3} />
        </div>
        <div className="flex flex-col gap-4 xl:col-span-5">
          <SkeletonCard lines={5} />
          <SkeletonCard lines={2} />
        </div>
      </div>
    </PageBody>
  );
}
