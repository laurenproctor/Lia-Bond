import Link from "next/link";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
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
