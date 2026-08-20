import Link from "next/link";
import { ArrowRight, Code2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";

/**
 * The entry point to the website widgets area.
 *
 * The odd one out on the integrations screen, and the copy says so rather than
 * letting the card's position imply otherwise. Every other card there is a
 * *source* — an account Lia reads from, with a connection status and a set of
 * capabilities. This is an *outbound* surface: nothing to authorise, nothing
 * to disconnect, no provider to be degraded by. It carries no
 * `ConnectionStatusBadge` for exactly that reason; a "disconnected" badge on
 * something that was never a connection would be the interface inventing a
 * state.
 *
 * It renders unconditionally, unlike the news and Yelp cards, because there is
 * no connection row whose absence it is standing in for. What it needs is a
 * location and some imported Google reviews, and the screen it links to says
 * so when they are missing.
 */
export function ReviewWidgetEntryCard({
  configuredCount,
}: {
  configuredCount: number;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex size-6 items-center justify-center rounded-md bg-gray-100">
              <Code2 className="size-3.5 text-gray-700" aria-hidden />
            </span>
            Website widgets
          </span>
        }
        description="Show one recent Google review on your own website, with a copy-and-paste embed code."
      />

      <p className="mt-3 text-[13px] text-gray-700">
        {configuredCount === 0
          ? "Set up a widget for a location, choose a light or dark theme, and paste two lines into your site. Lia keeps the review current and stops showing it the moment it stops qualifying."
          : `${configuredCount} ${configuredCount === 1 ? "location has" : "locations have"} a widget. Reviews update on their own; you can pin a specific one at any time.`}
      </p>

      <p className="mt-2 text-[12.5px] text-gray-500">
        This is the one integration that sends something out rather than reading
        something in — there is no account to connect.
      </p>

      <div className="mt-4">
        <Link
          href="/integrations/review-widget"
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
        >
          {configuredCount === 0 ? "Set up a website widget" : "Manage website widgets"}
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}
