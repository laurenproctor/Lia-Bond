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
 *
 * Renders as a `div`, not a `main`: this tree mounts inside `(app)/layout.tsx`
 * → `AppShell`, which already opens the page's one `<main id="main">`
 * (`src/components/shell/app-shell.tsx`). A second `<main>` here would be two
 * main landmarks on the same page — invalid HTML, and a screen reader's
 * "skip to main content" would have to guess which one.
 */
export default function AppNotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-5">
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
    </div>
  );
}
