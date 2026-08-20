import type { Metadata } from "next";
import { PageBody } from "@/components/shell/app-shell";
import { CapabilityTable } from "@/components/integrations/capability-table";
import { YelpListingPanel } from "@/components/integrations/yelp-listing-panel";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ButtonLink } from "@/components/ui/button";
import { ConnectionStatusBadge } from "@/components/ui/status-badge";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { yelpCapabilities, yelpConnectionWarnings } from "@/lib/yelp/capabilities";
import { isYelpAvailable } from "@/yelp/registry";

export const metadata: Metadata = { title: "Yelp Assisted" };

/**
 * The Yelp Assisted connection screen.
 *
 * Server-rendered, reading through the scoped repositories exactly like every
 * other integration screen. The one thing worth calling out is the page's own
 * framing: the header says *assisted* and the capability table says what that
 * costs, before anything on the page mentions activity detection. A customer
 * who reads only the top of this page should already know Lia cannot read their
 * Yelp reviews.
 */
export default async function YelpIntegrationPage() {
  const { scope, role } = await getOrganizationContext();
  const dataSource = await getDataSource();

  const available = isYelpAvailable();
  const connection = await dataSource.platformConnections.getByPlatform(scope, "yelp");

  const profiles = connection
    ? await dataSource.platformProfiles.listForConnection(scope, connection.id)
    : [];
  const activeProfiles = profiles.filter((profile) => profile.status !== "disconnected");

  const locations = await dataSource.locations.list(scope);
  const locationNames = Object.fromEntries(
    locations.map((location) => [location.id, location.name]),
  );

  const occurrences = await dataSource.yelpActivityOccurrences.list(scope, {
    statuses: ["open"],
    limit: 50,
  });

  // The latest observation per listing, so the panel can show what Yelp last
  // reported without each panel running its own query.
  const snapshots = await Promise.all(
    activeProfiles.map(async (profile) => ({
      profileId: profile.id,
      snapshot: await dataSource.yelpListingSnapshots.latestForProfile(
        scope,
        profile.id,
      ),
    })),
  );
  const latestByProfile = new Map(
    snapshots.map((entry) => [entry.profileId, entry.snapshot]),
  );

  const capabilities = yelpCapabilities({ available, connection, profiles });
  const warnings = yelpConnectionWarnings({ available, connection, profiles });

  const canManage = can(role, "integration.manage_profiles");
  const canCheck = can(role, "monitoring.poll_now");
  const canResolve = can(role, "mention.capture_manual");

  return (
    <PageBody>
      <PageHeader
        title="Yelp Assisted"
        description="Lia connects your Yelp listing, watches its review count and rating, and prepares responses for you to post. It cannot read your Yelp reviews or post replies for you — Yelp reserves both for licensed partners."
        actions={
          connection ? <ConnectionStatusBadge status={connection.status} /> : null
        }
      />

      {warnings.length > 0 ? (
        <Card>
          <CardHeader title="Needs attention" />
          <ul className="mt-2 space-y-1.5 text-[12.5px] text-amber-900">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="What this integration can do"
          description="Stated per capability, so nothing here has to be inferred from a badge."
        />
        <div className="mt-3">
          <CapabilityTable capabilities={capabilities} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Connected listings"
          description="One Yelp listing per restaurant. Connecting a listing is a mapping you confirm — it does not prove ownership, and Lia's Yelp access cannot check."
          actions={
            canManage && available ? (
              <ButtonLink href="/integrations/yelp/connect" variant="primary" size="sm">
                Connect a listing
              </ButtonLink>
            ) : null
          }
        />

        <div className="mt-3 space-y-3">
          {!available ? (
            <EmptyState
              title="Yelp is not set up on this server"
              description="This deployment has no Yelp API key configured, so listings cannot be searched or checked. Your administrator needs to set YELP_API_KEY before this integration can be used."
            />
          ) : activeProfiles.length === 0 ? (
            <EmptyState
              title="No Yelp listing is connected"
              description="Connect a location's Yelp listing and Lia will start checking its review count and rating, and tell you when either changes."
            />
          ) : (
            activeProfiles.map((profile) => {
              const snapshot = latestByProfile.get(profile.id) ?? null;
              return (
                <YelpListingPanel
                  key={profile.id}
                  profile={profile}
                  locationName={
                    profile.locationId ? (locationNames[profile.locationId] ?? null) : null
                  }
                  occurrences={occurrences.filter(
                    (occurrence) => occurrence.platformProfileId === profile.id,
                  )}
                  locationNames={locationNames}
                  lastCheckedAt={snapshot?.observedAt ?? null}
                  reviewCount={snapshot?.reviewCount ?? null}
                  rating={snapshot?.rating ?? null}
                  canCheck={canCheck}
                  canResolve={canResolve}
                  canDisconnect={canManage}
                />
              );
            })
          )}
        </div>
      </Card>
    </PageBody>
  );
}
