import Link from "next/link";
import { ArrowRight, Code2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";

/**
 * The entry point to the website widgets area.
 *
 * The odd one out on the integrations screen, and the copy says so rather than
 * letting the card's position imply otherwise. Every other card there is a
 * *source* — an account Lia reads from, with a connection status and a set of
 * capabilities. These are *outbound* surfaces: nothing to authorise, nothing
 * to disconnect, no provider to be degraded by. The card carries no
 * `ConnectionStatusBadge` for exactly that reason; a "disconnected" badge on
 * something that was never a connection would be the interface inventing a
 * state.
 *
 * It renders unconditionally, unlike the news and Yelp cards, because there is
 * no connection row whose absence it is standing in for.
 *
 * It links to `/integrations/website-widgets` rather than to either
 * configurator. There are two products now, and a card that opened one of them
 * would make that one the default and the other a thing you find by accident.
 */
export function WebsiteWidgetsEntryCard({
  reviewWidgetCount,
  hasPressWidget,
}: {
  /** Active review widgets. One per location, so this is a count of locations. */
  reviewWidgetCount: number;
  hasPressWidget: boolean;
}) {
  const configured = reviewWidgetCount > 0 || hasPressWidget;

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
        description="Show a recent Google review, or your latest press coverage, on your own website with a copy-and-paste embed code."
      />

      <p className="mt-3 text-[13px] text-gray-700">
        {configured ? summarise(reviewWidgetCount, hasPressWidget) : SETUP_COPY}
      </p>

      <p className="mt-2 text-[12.5px] text-gray-500">
        These are the two integrations that send something out rather than
        reading something in — there is no account to connect.
      </p>

      <div className="mt-4">
        <Link
          href="/integrations/website-widgets"
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
        >
          {configured ? "Manage website widgets" : "Set up a website widget"}
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}

const SETUP_COPY =
  "Choose a widget, pick a light or dark theme, and paste two lines into your site. Lia keeps what it shows current and stops showing anything that no longer qualifies.";

/**
 * What is already live, in one sentence.
 *
 * Both halves are named even when only one is set up, because the point of
 * this card is that there are two things here — and "1 location has a review
 * widget" on its own reads as though that is all Lia offers.
 */
function summarise(reviewWidgetCount: number, hasPressWidget: boolean): string {
  const parts: string[] = [];

  if (reviewWidgetCount > 0) {
    parts.push(
      `${reviewWidgetCount} ${reviewWidgetCount === 1 ? "location has" : "locations have"} a review widget`,
    );
  }
  if (hasPressWidget) parts.push("your press widget is set up");

  const done = parts.join(", and ");
  const remaining = hasPressWidget
    ? reviewWidgetCount > 0
      ? null
      : "A review widget can show one location's Google reviews as well."
    : "A press widget can show your recent coverage as well.";

  return remaining ? `${capitalise(done)}. ${remaining}` : `${capitalise(done)}.`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
