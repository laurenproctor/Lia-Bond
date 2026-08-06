import Link from "next/link";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The product's 404.
 *
 * Reached when `notFound()` is raised inside a product route — a mention id
 * that no longer resolves, a location removed from the organization. The root
 * `not-found.tsx` now belongs to the marketing site, which is where an
 * unmatched URL lands; this one keeps the offer that makes sense to somebody
 * already signed in.
 */
export default function AppNotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <div className="lia-card w-full max-w-md">
        <EmptyState
          icon={Compass}
          title="We couldn't find that page"
          description="The link may be out of date, or the item may have been dismissed or reassigned."
          action={
            <Link
              href="/overview"
              className="inline-flex h-9 items-center rounded-lg bg-purple-600 px-3 text-[13px] font-medium text-white hover:bg-purple-500"
            >
              Back to overview
            </Link>
          }
        />
      </div>
    </main>
  );
}
