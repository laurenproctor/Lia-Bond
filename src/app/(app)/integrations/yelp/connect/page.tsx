import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageBody } from "@/components/shell/app-shell";
import { YelpConnectForm } from "@/components/integrations/yelp-connect-form";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { isYelpAvailable } from "@/yelp/registry";

export const metadata: Metadata = { title: "Connect a Yelp listing" };

/**
 * Finding and confirming a location's Yelp listing.
 *
 * A separate route rather than a dialog on the integration page, following
 * `/integrations/google-business-profile/setup`: the flow is a search, a
 * comparison, and a decision, and compressing that into a modal is how somebody
 * ends up skimming a list of near-identical restaurant names.
 *
 * The permission is checked here as well as in the action. This one is the
 * outer of two, and it exists so a role that cannot map profiles gets a page
 * that explains why rather than a form that fails on submit.
 */
export default async function ConnectYelpListingPage() {
  const { scope, role } = await getOrganizationContext();

  if (!can(role, "integration.manage_profiles")) notFound();
  if (!isYelpAvailable()) {
    return (
      <PageBody>
        <PageHeader title="Connect a Yelp listing" />
        <EmptyState
          title="Yelp is not set up on this server"
          description="This deployment has no Yelp API key configured, so listings cannot be searched. Your administrator needs to set YELP_API_KEY."
        />
      </PageBody>
    );
  }

  const dataSource = await getDataSource();
  const locations = await dataSource.locations.list(scope);

  return (
    <PageBody>
      <PageHeader
        title="Connect a Yelp listing"
        description="Pick the location, then choose its listing from Yelp's results. Lia never picks for you — a wrong match would send one restaurant's review activity to another's queue."
      />

      <Card>
        <CardHeader
          title="Find the listing"
          description="Connecting a listing is a mapping you confirm. It does not prove you own the business, and Lia's Yelp access cannot check that."
        />
        <div className="mt-3">
          {locations.length === 0 ? (
            <EmptyState
              title="No locations yet"
              description="Add a location before connecting a Yelp listing — Lia searches Yelp using the location's own name and address."
            />
          ) : (
            <YelpConnectForm
              locations={locations.map((location) => ({
                id: location.id,
                name: location.name,
                city: location.city,
              }))}
            />
          )}
        </div>
      </Card>
    </PageBody>
  );
}
