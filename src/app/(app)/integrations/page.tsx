import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, Minus } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { ConnectGoogleForm } from "@/components/integrations/connect-google-form";
import { NewsEntryCard } from "@/components/integrations/news-entry-card";
import { YelpEntryCard } from "@/components/integrations/yelp-entry-card";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { PlatformGlyph } from "@/components/ui/source-badge";
import { ConnectionStatusBadge } from "@/components/ui/status-badge";
import { formatRelativeShort } from "@/lib/format";
import { CAPABILITY_LABELS, PLATFORM_LABELS } from "@/lib/labels";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { isGoogleConnectorAvailable } from "@/integrations/registry";
import { isNewsMonitorAvailable } from "@/news/registry";
import { isYelpAvailable } from "@/yelp/registry";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import {
  resolvePublishingMode,
  type PlatformConnection,
  type PublishingMode,
} from "@/domain";

export const metadata: Metadata = { title: "Integrations" };

const PUBLISHING_COPY: Record<PublishingMode, string> = {
  direct: "Lia can publish responses directly.",
  assisted: "Lia prepares the response; you post it and confirm.",
  manual: "Read-only. Lia prepares the text and a person posts it.",
  unavailable: "No mention access yet.",
};

const GOOGLE = "google_business_profile";
const NEWS = "news_media";
const YELP = "yelp";

function CapabilityList({ connection }: { connection: PlatformConnection }) {
  const entries = Object.entries(connection.capabilities) as [string, boolean][];

  return (
    <ul className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {entries.map(([key, enabled]) => (
        <li key={key} className="flex items-center gap-1.5 text-[12.5px]">
          {enabled ? (
            <Check className="size-3.5 shrink-0 text-green-600" aria-hidden />
          ) : (
            <Minus className="size-3.5 shrink-0 text-gray-300" aria-hidden />
          )}
          <span className={enabled ? "text-gray-700" : "text-gray-400"}>
            {CAPABILITY_LABELS[key] ?? key}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string; account?: string }>;
}) {
  const [context, dataSource, params] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
    searchParams,
  ]);
  const { scope, role } = context;

  const [connections, profiles] = await Promise.all([
    dataSource.platformConnections.list(scope),
    dataSource.platformProfiles.list(scope),
  ]);

  const profileCounts = new Map<string, number>();
  for (const profile of profiles) {
    profileCounts.set(
      profile.platformConnectionId,
      (profileCounts.get(profile.platformConnectionId) ?? 0) + 1,
    );
  }

  const google = connections.find((connection) => connection.platform === GOOGLE);
  const googleConnected = google !== undefined && google.status !== "disconnected";
  const mayConnect = can(role, "integration.connect");
  const connectorAvailable = isGoogleConnectorAvailable();

  // News has no OAuth handshake to complete here: its connection is
  // provisioned implicitly the first time a monitoring query is saved, on the
  // detail screen itself. So there is nothing to find in `connections` for an
  // organization that has never added a query, and the entry point below has
  // to work whether or not that row exists yet.
  const newsConnection = connections.find((connection) => connection.platform === NEWS) ?? null;
  const newsAvailable = isNewsMonitorAvailable();
  const yelpConnection = connections.find((connection) => connection.platform === YELP) ?? null;
  const yelpAvailable = isYelpAvailable();

  return (
    <PageBody>
      <PageHeader
        title="Integrations"
        description="Connect sources, and see exactly what each one lets Lia read and publish."
        actions={
          !googleConnected && mayConnect && connectorAvailable ? (
            <ConnectGoogleForm />
          ) : null
        }
      />

      {/*
        Carried back from the OAuth route handlers, which cannot render. Only a
        status and a message ever travel in the URL — never a code or a token.
      */}
      {params.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
          {params.error}
        </p>
      ) : null}

      {params.connected === "1" ? (
        <p
          role="status"
          className="rounded-lg border border-green-600/20 bg-green-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          Google Business Profile is connected
          {params.account ? ` as ${params.account}` : ""}. No reviews have been
          imported — connecting authorises Lia to read your listings, and review
          synchronisation is not built yet.
        </p>
      ) : null}

      <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-700">
        Every connector states its own capabilities. Where a source has no
        publishing API, Lia prepares the text and a person posts it — the product
        never implies otherwise.
      </p>

      {!connectorAvailable ? (
        <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-700">
          Google Business Profile is not configured on this server, so it cannot
          be connected from here. Your administrator needs to set the Google
          OAuth client and the credential encryption key.
        </p>
      ) : null}

      {connections.length === 0 ? (
        <Card>
          <EmptyState
            title="No integrations yet"
            description="Connect a review platform to start collecting mentions."
            action={
              mayConnect && connectorAvailable ? <ConnectGoogleForm /> : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {connections.map((connection) => {
            const publishing = resolvePublishingMode(connection.capabilities);
            const isGoogle = connection.platform === GOOGLE;
            const isNews = connection.platform === NEWS;
            const isYelp = connection.platform === YELP;

            return (
              <Card key={connection.id}>
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      <PlatformGlyph platform={connection.platform} size="md" />
                      {PLATFORM_LABELS[connection.platform]}
                    </span>
                  }
                  description={connection.externalAccountName ?? "Not linked to an account"}
                  actions={<ConnectionStatusBadge status={connection.status} />}
                />

                <p className="mt-3 text-[13px] font-medium text-gray-950">
                  {PUBLISHING_COPY[publishing]}
                </p>

                <CapabilityList connection={connection} />

                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-200 pt-3 text-[12.5px] sm:grid-cols-3">
                  <div>
                    <dt className="text-gray-500">Profiles</dt>
                    <dd className="font-medium text-gray-950 tabular-nums">
                      {profileCounts.get(connection.id) ?? 0}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Last synced</dt>
                    <dd className="font-medium text-gray-950">
                      {connection.lastSyncedAt
                        ? formatRelativeShort(connection.lastSyncedAt)
                        : "Never"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Token expires</dt>
                    <dd className="font-medium text-gray-950">
                      {connection.tokenExpiresAt
                        ? formatRelativeShort(connection.tokenExpiresAt)
                        : "—"}
                    </dd>
                  </div>
                </dl>

                {/*
                  Google and news are the connectors with a real detail
                  screen. The others render the summary card and say so,
                  rather than offering buttons that do nothing.
                */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {isGoogle || isNews || isYelp ? (
                    <Link
                      href={
                        isGoogle
                          ? "/integrations/google-business-profile"
                          : isYelp
                            ? "/integrations/yelp"
                            : "/integrations/news-media"
                      }
                      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
                    >
                      Manage
                      <ArrowRight className="size-4 shrink-0" aria-hidden />
                    </Link>
                  ) : (
                    <span className="text-[12.5px] text-gray-500">
                      Configured outside Lia for now.
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/*
        News has no connect button of its own — the entry point is always
        this card, whether or not a connection row exists yet. A brand-new
        organization would otherwise have no way to reach the screen that
        creates one.
      */}
      {newsConnection === null ? <NewsEntryCard available={newsAvailable} /> : null}

      {/* Same arrangement as news: Yelp has no connect button of its own, so
          this card is the only route to the screen that creates the connection. */}
      {yelpConnection === null ? <YelpEntryCard available={yelpAvailable} /> : null}

      <SectionPlaceholder
        title="Available integrations"
        description="Sources that can be connected but have not been set up yet."
        shape="grid"
      />
    </PageBody>
  );
}
