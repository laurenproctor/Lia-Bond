import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CONNECTION_HEALTH_LABELS, PLATFORM_LABELS } from "@/lib/labels";
import { formatRelativeShort } from "@/lib/format";
import type { Platform, PlatformConnection, PlatformProfile } from "@/domain";

/**
 * Which external profiles route to this location, and whether they are working.
 *
 * The screen answers "why is this restaurant quiet?", so it has to distinguish
 * three things a single "connected" badge would flatten: the profile's own
 * mapping state, the health of the connection underneath it, and when reviews
 * last actually arrived. A profile can be mapped and active while its
 * connection needs reauthorizing, and that is exactly the case somebody is here
 * to find.
 */

/**
 * Where to go to change a mapping, per platform.
 *
 * A map rather than a string built from the platform name: only two platforms
 * have management screens, and inventing a URL for the others would produce a
 * link to a 404 the moment somebody maps a Yelp profile.
 */
const MANAGEMENT_PATHS: Partial<Record<Platform, string>> = {
  google_business_profile: "/integrations/google-business-profile/setup",
  news_media: "/integrations/news-media",
};

export function MappedProfilesCard({
  profiles,
  connections,
}: {
  profiles: PlatformProfile[];
  connections: PlatformConnection[];
}) {
  const connectionById = new Map(connections.map((row) => [row.id, row]));

  if (profiles.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Connected profiles"
          description="Which source profiles route to this location."
        />
        <EmptyState
          title="No profiles mapped yet"
          description="Nothing arrives for this location until a source profile points at it. Map one from the Google setup screen."
          action={
            <ButtonLink
              href={MANAGEMENT_PATHS.google_business_profile ?? "/integrations"}
              variant="secondary"
              size="sm"
            >
              Map a Google listing
            </ButtonLink>
          }
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Connected profiles"
        description="Which source profiles route to this location, and their sync state."
      />
      <ul className="mt-3 flex flex-col divide-y divide-gray-200">
        {profiles.map((profile) => {
          const connection = connectionById.get(profile.platformConnectionId);
          const platform = connection?.platform;
          const managementPath = platform ? MANAGEMENT_PATHS[platform] : undefined;

          return (
            <li key={profile.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-gray-950">
                  {profile.externalProfileName}
                </p>
                <p className="mt-0.5 text-[12px] text-gray-500">
                  {platform ? PLATFORM_LABELS[platform] : "Unknown platform"}
                  {" · "}
                  {profile.lastSyncedAt
                    ? `Last sync ${formatRelativeShort(profile.lastSyncedAt)}`
                    : "Never synced"}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {/* The profile's mapping state and the connection's health are
                    separate facts, and collapsing them is how "connected"
                    becomes a lie. A profile can be active on a connection that
                    needs reauthorizing, which is precisely the case somebody
                    lands on this screen to diagnose. */}
                <Badge tone={profile.status === "active" ? "green" : "amber"}>
                  {profile.status === "active" ? "Mapped" : "Needs attention"}
                </Badge>
                {connection?.lastHealthStatus &&
                connection.lastHealthStatus !== "healthy" ? (
                  <Badge tone="amber">
                    {CONNECTION_HEALTH_LABELS[connection.lastHealthStatus]}
                  </Badge>
                ) : null}
                {managementPath ? (
                  <ButtonLink href={managementPath} variant="ghost" size="sm">
                    Manage
                    <ExternalLink className="size-3.5" aria-hidden />
                  </ButtonLink>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
