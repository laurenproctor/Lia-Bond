import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { PlatformGlyph } from "@/components/ui/source-badge";
import { ConnectionStatusBadge } from "@/components/ui/status-badge";
import { PLATFORM_LABELS } from "@/lib/labels";

/**
 * The entry point to Yelp Assisted, for an organization with no connection yet.
 *
 * Follows `NewsEntryCard` exactly, and for the same structural reason: Yelp has
 * no OAuth button, because its connection is provisioned implicitly the first
 * time a listing is connected on the detail screen. So this card, not a connect
 * form, is how a brand-new organization reaches that screen — and the page
 * renders it only while no `yelp` connection row exists, so it and the generic
 * connections grid never show at once.
 *
 * The description does the work the product name cannot. "Yelp" on a card in a
 * list of integrations reads as "Lia handles Yelp"; the sentence underneath is
 * where a customer learns what assisted actually means, before they click.
 */
export function YelpEntryCard({ available }: { available: boolean }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <PlatformGlyph platform="yelp" size="md" />
            {PLATFORM_LABELS.yelp} Assisted
          </span>
        }
        description="Lia watches your Yelp listing's review count and rating and tells you when they change. It cannot read your reviews or post replies — Yelp reserves both for licensed partners."
        actions={<ConnectionStatusBadge status="disconnected" />}
      />
      <p className="mt-3 text-[13px] text-gray-700">
        {available
          ? "Connect a location's Yelp listing to start. When Lia detects activity you add the review yourself, and it then goes through the same analysis, routing, and drafting as every other source."
          : "Yelp is not configured on this server. Your administrator needs to set the Yelp API key before a listing can be connected."}
      </p>
      <div className="mt-4">
        <Link
          href="/integrations/yelp"
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
        >
          Set up Yelp Assisted
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}
