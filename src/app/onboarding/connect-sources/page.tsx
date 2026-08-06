import type { Metadata } from "next";
import { Link2, ShieldCheck, Sparkles } from "lucide-react";
import { OnboardingAside, stepEyebrow } from "@/components/onboarding/onboarding-aside";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import {
  ConnectSourcesStep,
  type ConnectSourcesViewModel,
} from "@/components/onboarding/connect-sources-step";
import { onboardingStepDefinition, type MonitoringQuery, type Organization } from "@/domain";
import { isGoogleConnectorAvailable } from "@/integrations/registry";
import { requireOnboardingStep } from "@/lib/onboarding/context";
import {
  findOnboardingNewsQuery,
  lastSuccessfulNewsPollAt,
  summarizeNewsMonitoring,
} from "@/lib/onboarding/news";
import { isNewsMonitorAvailable } from "@/news/registry";

export const metadata: Metadata = { title: "Connect your sources" };

/**
 * Step 2 — connect and configure sources.
 *
 * Three sources, three different truths, all read on the server during
 * render:
 *
 * - **Google** — the real connection row. Only the account **name** crosses
 *   to the client; no token, no scope list, no account id.
 * - **News & Media** — the persisted monitoring queries and their poll runs.
 *   Every count on the card is derived here from real rows; nothing is
 *   estimated or invented.
 * - **Reddit** — nothing, because nothing exists. There is no Reddit
 *   connector, monitor, or persistence in this repository
 *   (`getConnector("reddit")` throws), so the view model states
 *   `unavailable` as a fact about the codebase rather than querying for a
 *   configuration that has nowhere to live.
 */
export default async function OnboardingConnectSourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requireOnboardingStep("connect_sources");
  const definition = onboardingStepDefinition("connect_sources");
  const params = await searchParams;

  const [connection, queries, newsConnection] = await Promise.all([
    context.dataSource.platformConnections.getByPlatform(
      context.scope,
      "google_business_profile",
    ),
    context.dataSource.monitoringQueries.list(context.scope),
    context.dataSource.platformConnections.getByPlatform(context.scope, "news_media"),
  ]);

  const connected = Boolean(connection) && connection?.status !== "disconnected";
  const newsAvailable = isNewsMonitorAvailable();
  const newsSummary = summarizeNewsMonitoring(queries);
  const onboardingQuery = findOnboardingNewsQuery(queries);

  // Only read poll history when there is something it could be true of.
  const lastPollAt =
    newsSummary.configured && newsAvailable
      ? await lastSuccessfulNewsPollAt(context.dataSource, context.scope, queries)
      : null;

  const model: ConnectSourcesViewModel = {
    google: {
      available: isGoogleConnectorAvailable(),
      connected,
      // Shown so somebody can confirm they authorised the right Google
      // account. Never the account id, which is a provider identifier the
      // browser has no use for.
      accountName: connection?.externalAccountName ?? null,
      justConnected: params.connected === "1" && connected,
    },
    news: {
      capability: newsAvailable ? "available" : "unavailable",
      configured: newsSummary.configured,
      operational: newsAvailable && newsSummary.configured && newsConnection !== null,
      enabledQueryCount: newsSummary.enabledQueryCount,
      keywordCount: newsSummary.keywordCount,
      language: newsSummary.language,
      country: newsSummary.country,
      lastSuccessfulPollAt: lastPollAt,
      initialValues: configuratorInitialValues(onboardingQuery, context.organization),
      keywordSuggestions: keywordSuggestions(context.organization),
    },
    reddit: {
      // Stated, not probed: the repository has no Reddit provider to ask.
      // `docs/architecture/current-state.md` records the gap.
      capability: "unavailable",
      configured: false,
      operational: false,
      keywordCount: 0,
      priorityCommunityCount: 0,
      lastSuccessfulPollAt: null,
    },
  };

  return (
    <OnboardingShell
      step="connect_sources"
      state={context.state}
      aside={
        <OnboardingAside
          eyebrow={stepEyebrow(definition.number)}
          headline="Connect your sources"
          description="Lia starts with Google so you can import your reviews and locations. You can also configure News & Media and Reddit monitoring to expand your coverage."
          benefits={[
            {
              icon: Link2,
              title: "Bring everything together",
              description:
                "Connect the sources Lia uses to understand what people are saying about your organization.",
            },
            {
              icon: Sparkles,
              title: "Monitor what matters",
              description:
                "Choose the names, topics, and profiles that affect your reputation.",
            },
            {
              icon: ShieldCheck,
              title: "Secure by design",
              description:
                "Connections and monitoring settings remain organization-scoped, and nothing is published without approval.",
            },
          ]}
          footer={
            // Decorative, like every onboarding doodle: hidden from assistive
            // technology, nothing required inside it. An HTML bubble rather
            // than an `OnboardingDoodle` because those carry no text by rule.
            <p
              aria-hidden="true"
              className="pointer-events-none relative hidden w-fit max-w-[30ch] rounded-2xl border-2 border-site-orange bg-white px-4 py-3 text-[13.5px] leading-snug font-semibold text-site-ink lg:block"
            >
              &ldquo;You&rsquo;re building a more complete picture of your
              reputation.&rdquo;
              <span className="absolute -bottom-[9px] left-8 block h-4 w-4 rotate-45 border-r-2 border-b-2 border-site-orange bg-white" />
            </p>
          }
        />
      }
    >
      <ConnectSourcesStep
        model={model}
        alreadySkipped={context.state.sourceSkippedAt !== null}
      />
    </OnboardingShell>
  );
}

/**
 * What the configurator opens with.
 *
 * The persisted onboarding-managed query when one exists — editing, never
 * shadowing — otherwise defaults built from real organization data: the
 * organization's own name as the first keyword and nothing invented. No
 * fabricated aliases, no fabricated people, and no location names, because
 * step 3 has not chosen locations yet.
 */
function configuratorInitialValues(
  query: MonitoringQuery | null,
  organization: Organization,
) {
  if (query) {
    return {
      name: query.name,
      keywords: query.keywords,
      exclusions: query.exclusions,
      sourceCountry: query.sourceCountry,
      language: query.language,
      enabled: query.enabled,
    };
  }

  return {
    name: "Brand watch",
    keywords: [organization.name],
    exclusions: [],
    // Derived from the organization's own configured language ("en-US" →
    // country us, language en) rather than assumed.
    sourceCountry: regionOf(organization.defaultLanguage),
    language: languageOf(organization.defaultLanguage),
    enabled: true,
  };
}

/** Real organization facts offered as one-press keyword chips. */
function keywordSuggestions(organization: Organization): string[] {
  const suggestions: string[] = [organization.name];
  const host = websiteHost(organization.websiteUrl);
  if (host) suggestions.push(host);
  return suggestions;
}

function websiteHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The countries the configurator offers. Must match its select options. */
const CONFIGURATOR_COUNTRIES = new Set(["us", "gb", "ca", "au", "ie", "de", "fr", "es"]);
const CONFIGURATOR_LANGUAGES = new Set(["en", "es", "fr", "de"]);

function regionOf(languageTag: string): string | null {
  const region = languageTag.split("-")[1]?.toLowerCase() ?? null;
  return region && CONFIGURATOR_COUNTRIES.has(region) ? region : null;
}

function languageOf(languageTag: string): string | null {
  const language = languageTag.split("-")[0]?.toLowerCase() ?? null;
  return language && CONFIGURATOR_LANGUAGES.has(language) ? language : null;
}
