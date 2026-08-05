import type {
  Approval,
  AuditEvent,
  AutomationRule,
  ConnectorCapabilities,
  Escalation,
  Location,
  Membership,
  Mention,
  MentionAnalysis,
  MonitoringQuery,
  Organization,
  PlatformConnection,
  PlatformProfile,
  ResponseDraft,
  User,
} from "@/domain";
import {
  NEW_CONNECTION_DEFAULTS,
  NEW_MENTION_DEFAULTS,
  NEW_PROFILE_DEFAULTS,
  NO_CAPABILITIES,
} from "@/domain";
import { daysAgo, daysFromNow, hoursAgo, minutesAgo, minutesFromNow, REFERENCE_NOW } from "@/lib/seed/clock";
import { seedId } from "@/lib/seed/ids";

/**
 * The demo dataset.
 *
 * This is the single source of seed truth. The demo data source reads it
 * directly, and `scripts/generate-seed-sql.ts` renders it to
 * `supabase/seed.sql`, so the in-memory experience and the database seed cannot
 * drift apart.
 *
 * Two organizations exist on purpose. The second one is small and dull, but it
 * is what makes cross-tenant isolation testable: if a query ever returns a
 * Harbor & Vine row to a Union Square user, the tests fail.
 *
 * Everything here is fictional. No real tokens, addresses, or personal data.
 */

export interface SeedDataset {
  organizations: Organization[];
  users: User[];
  memberships: Membership[];
  locations: Location[];
  platformConnections: PlatformConnection[];
  platformProfiles: PlatformProfile[];
  mentions: Mention[];
  mentionAnalyses: MentionAnalysis[];
  responseDrafts: ResponseDraft[];
  approvals: Approval[];
  escalations: Escalation[];
  automationRules: AutomationRule[];
  auditEvents: AuditEvent[];
  /**
   * What Lia watches.
   *
   * Standing configuration, the same category as `platformProfiles` and
   * `automationRules` — not event history — so it belongs here rather than
   * in the demo adapter's runtime-only store. Empty until a later task
   * (seed data) attaches fixture queries; `generate-seed-sql.ts` needs this
   * collection to exist here to ever render `news_monitoring_queries` rows.
   */
  monitoringQueries: MonitoringQuery[];
}

const CREATED = daysAgo(240);

/* -------------------------------------------------------------------------- */
/* Organizations                                                               */
/* -------------------------------------------------------------------------- */

export const ORG_USHG = seedId("org:ushg");
export const ORG_HARBOR = seedId("org:harbor");

const organizations: Organization[] = [
  {
    id: ORG_USHG,
    name: "Union Square Hospitality Group",
    slug: "union-square-hospitality",
    industry: "Restaurants and hospitality",
    websiteUrl: "https://example.com/ushg",
    defaultTimezone: "America/New_York",
    defaultLanguage: "en-US",
    createdAt: CREATED,
    updatedAt: CREATED,
  },
  {
    id: ORG_HARBOR,
    name: "Harbor & Vine Restaurant Group",
    slug: "harbor-and-vine",
    industry: "Restaurants and hospitality",
    websiteUrl: "https://example.com/harbor-and-vine",
    defaultTimezone: "America/Los_Angeles",
    defaultLanguage: "en-US",
    createdAt: CREATED,
    updatedAt: CREATED,
  },
];

/* -------------------------------------------------------------------------- */
/* Users and memberships                                                       */
/* -------------------------------------------------------------------------- */

export const USER_KATE = seedId("user:kate");
export const USER_DANIEL = seedId("user:daniel");
export const USER_NAOMI = seedId("user:naomi");
export const USER_PRIYA = seedId("user:priya");
export const USER_MARCUS = seedId("user:marcus");
export const USER_JORDAN = seedId("user:jordan");
export const USER_SOFIA = seedId("user:sofia");

function user(id: string, fullName: string, email: string): User {
  return {
    id,
    email,
    fullName,
    avatarUrl: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

const users: User[] = [
  user(USER_DANIEL, "Daniel Reyes", "daniel.reyes@example.com"),
  user(USER_KATE, "Kate Morgan", "kate.morgan@example.com"),
  user(USER_NAOMI, "Naomi Clarke", "naomi.clarke@example.com"),
  user(USER_PRIYA, "Priya Raman", "priya.raman@example.com"),
  user(USER_MARCUS, "Marcus Bell", "marcus.bell@example.com"),
  user(USER_JORDAN, "Jordan Ellis", "jordan.ellis@example.com"),
  user(USER_SOFIA, "Sofia Duarte", "sofia.duarte@example.com"),
];

function membership(
  organizationId: string,
  userId: string,
  role: Membership["role"],
  status: Membership["status"] = "active",
): Membership {
  return {
    id: seedId(`membership:${organizationId}:${userId}`),
    organizationId,
    userId,
    role,
    status,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

const memberships: Membership[] = [
  membership(ORG_USHG, USER_DANIEL, "owner"),
  membership(ORG_USHG, USER_KATE, "admin"),
  membership(ORG_USHG, USER_NAOMI, "communications_lead"),
  membership(ORG_USHG, USER_PRIYA, "location_manager"),
  membership(ORG_USHG, USER_MARCUS, "approver"),
  membership(ORG_USHG, USER_JORDAN, "analyst"),
  // Sofia belongs only to Harbor & Vine. She is the control in isolation tests.
  membership(ORG_HARBOR, USER_SOFIA, "owner"),
  // Daniel sits in both groups: the multi-organization case must work.
  membership(ORG_HARBOR, USER_DANIEL, "viewer"),
];

/* -------------------------------------------------------------------------- */
/* Locations                                                                   */
/* -------------------------------------------------------------------------- */

export const LOC_SOHO = seedId("loc:soho");
export const LOC_WEST_VILLAGE = seedId("loc:west-village");
export const LOC_UES = seedId("loc:upper-east-side");
export const LOC_TRIBECA = seedId("loc:tribeca");
export const LOC_BROOKLYN = seedId("loc:brooklyn-heights");
export const LOC_HUDSON = seedId("loc:hudson-yards");
export const LOC_HARBOR_HOUSE = seedId("loc:harbor-house");

interface LocationSeed {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  status: Location["status"];
  managerUserId: string | null;
  timezone?: string;
}

function location(seed: LocationSeed): Location {
  return {
    id: seed.id,
    organizationId: seed.organizationId,
    name: seed.name,
    slug: seed.slug,
    addressLine1: seed.addressLine1,
    addressLine2: null,
    city: seed.city,
    region: seed.region,
    postalCode: seed.postalCode,
    countryCode: "US",
    timezone: seed.timezone ?? "America/New_York",
    status: seed.status,
    managerUserId: seed.managerUserId,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

const locations: Location[] = [
  location({
    id: LOC_SOHO,
    organizationId: ORG_USHG,
    name: "SoHo",
    slug: "soho",
    addressLine1: "118 Prince Street",
    city: "New York",
    region: "NY",
    postalCode: "10012",
    status: "active",
    managerUserId: USER_PRIYA,
  }),
  location({
    id: LOC_WEST_VILLAGE,
    organizationId: ORG_USHG,
    name: "West Village",
    slug: "west-village",
    addressLine1: "42 Bedford Street",
    city: "New York",
    region: "NY",
    postalCode: "10014",
    status: "active",
    managerUserId: USER_MARCUS,
  }),
  location({
    id: LOC_UES,
    organizationId: ORG_USHG,
    name: "Upper East Side",
    slug: "upper-east-side",
    addressLine1: "1140 Madison Avenue",
    city: "New York",
    region: "NY",
    postalCode: "10028",
    status: "active",
    managerUserId: USER_PRIYA,
  }),
  location({
    id: LOC_TRIBECA,
    organizationId: ORG_USHG,
    name: "Tribeca",
    slug: "tribeca",
    addressLine1: "205 Hudson Street",
    city: "New York",
    region: "NY",
    postalCode: "10013",
    status: "active",
    managerUserId: null,
  }),
  location({
    id: LOC_BROOKLYN,
    organizationId: ORG_USHG,
    name: "Brooklyn Heights",
    slug: "brooklyn-heights",
    addressLine1: "76 Montague Street",
    city: "Brooklyn",
    region: "NY",
    postalCode: "11201",
    status: "setup",
    managerUserId: null,
  }),
  location({
    id: LOC_HUDSON,
    organizationId: ORG_USHG,
    name: "Hudson Yards",
    slug: "hudson-yards",
    addressLine1: "20 Hudson Yards",
    city: "New York",
    region: "NY",
    postalCode: "10001",
    status: "inactive",
    managerUserId: null,
  }),
  location({
    id: LOC_HARBOR_HOUSE,
    organizationId: ORG_HARBOR,
    name: "Harbor House",
    slug: "harbor-house",
    addressLine1: "1400 Embarcadero",
    city: "San Francisco",
    region: "CA",
    postalCode: "94111",
    status: "active",
    managerUserId: USER_SOFIA,
    timezone: "America/Los_Angeles",
  }),
];

/* -------------------------------------------------------------------------- */
/* Platform connections and profiles                                           */
/* -------------------------------------------------------------------------- */

export const CONN_GOOGLE = seedId("conn:google");
export const CONN_YELP = seedId("conn:yelp");
export const CONN_REDDIT = seedId("conn:reddit");
export const CONN_NEWS = seedId("conn:news");
export const CONN_DISQUS = seedId("conn:disqus");
export const CONN_HARBOR_GOOGLE = seedId("conn:harbor-google");

function capabilities(
  overrides: Partial<ConnectorCapabilities>,
): ConnectorCapabilities {
  return { ...NO_CAPABILITIES, ...overrides };
}

function connection(
  id: string,
  organizationId: string,
  platform: PlatformConnection["platform"],
  fields: Omit<
    PlatformConnection,
    | "id"
    | "organizationId"
    | "platform"
    | "createdAt"
    | "updatedAt"
    | keyof typeof NEW_CONNECTION_DEFAULTS
  >,
): PlatformConnection {
  return {
    id,
    organizationId,
    platform,
    // Workflow 02 added connection health, scopes, and attribution. The demo
    // dataset represents connections established before any of that was
    // recorded, so it takes the same "nothing observed yet" defaults a
    // pre-existing row would — not invented health that was never measured.
    ...NEW_CONNECTION_DEFAULTS,
    grantedScopes: [],
    providerMetadata: {},
    ...fields,
    createdAt: CREATED,
    updatedAt: daysAgo(2),
  };
}

const platformConnections: PlatformConnection[] = [
  connection(CONN_GOOGLE, ORG_USHG, "google_business_profile", {
    externalAccountId: "accounts/1122334455",
    externalAccountName: "Union Square Hospitality Group",
    status: "connected",
    capabilities: capabilities({
      canReadMentions: true,
      canReadFullText: true,
      supportsWebhooks: true,
      canPublishResponses: true,
      canEditResponses: true,
      canDeleteResponses: true,
      requiresApproval: false,
    }),
    tokenExpiresAt: daysFromNow(48),
    lastSyncedAt: minutesAgo(4),
  }),
  connection(CONN_YELP, ORG_USHG, "yelp", {
    externalAccountId: "biz-ushg-4412",
    externalAccountName: "USHG on Yelp",
    status: "connected",
    capabilities: capabilities({
      canReadMentions: true,
      requiresPartnerAccess: true,
    }),
    tokenExpiresAt: null,
    lastSyncedAt: hoursAgo(3),
  }),
  connection(CONN_REDDIT, ORG_USHG, "reddit", {
    externalAccountId: "u/maisonlaurent_team",
    externalAccountName: "u/maisonlaurent_team",
    status: "action_required",
    capabilities: capabilities({
      canReadMentions: true,
      canReadFullText: true,
      canPublishResponses: true,
      canEditResponses: true,
      canDeleteResponses: true,
    }),
    tokenExpiresAt: daysFromNow(6),
    lastSyncedAt: minutesAgo(18),
  }),
  connection(CONN_NEWS, ORG_USHG, "news_media", {
    externalAccountId: "news-monitor-ushg",
    externalAccountName: "News and media monitoring",
    status: "connected",
    capabilities: capabilities({
      canReadMentions: true,
      canReadFullText: true,
      supportsWebhooks: true,
    }),
    tokenExpiresAt: null,
    lastSyncedAt: minutesAgo(9),
  }),
  connection(CONN_DISQUS, ORG_USHG, "disqus", {
    externalAccountId: "comments-bridge-01",
    externalAccountName: "Article comments",
    status: "connected",
    capabilities: capabilities({ canReadMentions: true, canReadFullText: true }),
    tokenExpiresAt: null,
    lastSyncedAt: minutesAgo(31),
  }),
  connection(CONN_HARBOR_GOOGLE, ORG_HARBOR, "google_business_profile", {
    externalAccountId: "accounts/9988776655",
    externalAccountName: "Harbor & Vine",
    status: "connected",
    capabilities: capabilities({
      canReadMentions: true,
      canReadFullText: true,
      canPublishResponses: true,
      requiresApproval: false,
    }),
    tokenExpiresAt: daysFromNow(60),
    lastSyncedAt: hoursAgo(1),
  }),
];

function profile(
  label: string,
  organizationId: string,
  connectionId: string,
  locationId: string | null,
  externalProfileId: string,
  externalProfileName: string,
  profileUrl: string | null,
): PlatformProfile {
  return {
    id: seedId(`profile:${label}`),
    organizationId,
    locationId,
    platformConnectionId: connectionId,
    externalProfileId,
    externalProfileName,
    ...NEW_PROFILE_DEFAULTS,
    profileUrl,
    status: "active",
    syncCursor: null,
    lastSyncedAt: minutesAgo(12),
    createdAt: CREATED,
    updatedAt: minutesAgo(12),
  };
}

const platformProfiles: PlatformProfile[] = [
  profile("google-soho", ORG_USHG, CONN_GOOGLE, LOC_SOHO, "locations/1001", "Maison Laurent SoHo", "https://example.com/gbp/soho"),
  profile("google-wv", ORG_USHG, CONN_GOOGLE, LOC_WEST_VILLAGE, "locations/1002", "Maison Laurent West Village", "https://example.com/gbp/west-village"),
  profile("google-ues", ORG_USHG, CONN_GOOGLE, LOC_UES, "locations/1003", "Maison Laurent Upper East Side", "https://example.com/gbp/upper-east-side"),
  profile("google-tribeca", ORG_USHG, CONN_GOOGLE, LOC_TRIBECA, "locations/1004", "Maison Laurent Tribeca", "https://example.com/gbp/tribeca"),
  profile("yelp-soho", ORG_USHG, CONN_YELP, LOC_SOHO, "yelp-soho", "Maison Laurent SoHo", "https://example.com/yelp/soho"),
  profile("yelp-wv", ORG_USHG, CONN_YELP, LOC_WEST_VILLAGE, "yelp-wv", "Maison Laurent West Village", "https://example.com/yelp/west-village"),
  profile("yelp-tribeca", ORG_USHG, CONN_YELP, LOC_TRIBECA, "yelp-tribeca", "Maison Laurent Tribeca", "https://example.com/yelp/tribeca"),
  profile("reddit-watch", ORG_USHG, CONN_REDDIT, null, "keyword:maison-laurent", "Brand keyword watch", null),
  profile("news-watch", ORG_USHG, CONN_NEWS, null, "keyword:ushg", "Group keyword watch", null),
  profile("disqus-watch", ORG_USHG, CONN_DISQUS, null, "sites:food-press", "Food press comment threads", null),
  profile("harbor-google", ORG_HARBOR, CONN_HARBOR_GOOGLE, LOC_HARBOR_HOUSE, "locations/5001", "Harbor House", "https://example.com/gbp/harbor-house"),
];

/* -------------------------------------------------------------------------- */
/* Mentions                                                                    */
/* -------------------------------------------------------------------------- */

interface MentionSeed {
  label: string;
  organizationId?: string;
  locationId: string | null;
  connectionId: string;
  profileLabel: string | null;
  sourceType: Mention["sourceType"];
  externalId: string;
  title: string | null;
  content: string;
  authorName: string;
  rating?: number | null;
  publishedAt: string;
  status: Mention["status"];
  sentiment: Mention["sentiment"];
  riskLevel: Mention["riskLevel"];
  relevanceScore: number;
  engagementScore?: number | null;
  sourceUrl?: string;
  externalParentId?: string | null;
  rawPayload?: Record<string, string | number | boolean | null>;
}

function mention(seed: MentionSeed): Mention {
  const organizationId = seed.organizationId ?? ORG_USHG;
  return {
    id: seedId(`mention:${seed.label}`),
    organizationId,
    locationId: seed.locationId,
    platformConnectionId: seed.connectionId,
    platformProfileId: seed.profileLabel ? seedId(`profile:${seed.profileLabel}`) : null,
    sourceType: seed.sourceType,
    externalId: seed.externalId,
    externalParentId: seed.externalParentId ?? null,
    sourceUrl: seed.sourceUrl ?? `https://example.com/source/${seed.externalId}`,
    title: seed.title,
    content: seed.content,
    authorName: seed.authorName,
    authorExternalId: `author-${seed.externalId}`,
    rating: seed.rating ?? null,
    language: "en-US",
    publishedAt: seed.publishedAt,
    receivedAt: seed.publishedAt,
    status: seed.status,
    sentiment: seed.sentiment,
    riskLevel: seed.riskLevel,
    relevanceScore: seed.relevanceScore,
    engagementScore: seed.engagementScore ?? null,
    rawPayload: seed.rawPayload ?? {},
    // Source-owned fields (workflow 03). The seed predates review
    // synchronisation and deliberately does not fabricate a sync history: these
    // fixtures were never imported from anywhere, so claiming a last-synced
    // instant or an owner reply would make the demo tenant look like it had run
    // an import that never happened.
    ...NEW_MENTION_DEFAULTS,
    createdAt: seed.publishedAt,
    updatedAt: seed.publishedAt,
  };
}

export const MENTION_LABELS = {
  slowService: "google-slow-service",
  foodSafety: "google-food-safety",
  overpriced: "google-overpriced",
  amazingStaff: "google-amazing-staff",
  reservation: "google-reservation",
  anniversary: "google-anniversary",
  yelpPerfect: "yelp-perfect-night",
  yelpBilling: "yelp-billing",
  yelpNoise: "yelp-noise",
  redditHype: "reddit-worth-the-hype",
  redditRude: "reddit-rude-server",
  redditAnniversary: "reddit-anniversary",
  redditComment: "reddit-pricing-comment",
  newsSpring: "news-spring-menu",
  newsWages: "news-tipped-wages",
  newsListicle: "news-listicle",
  commentVegetarian: "comment-vegetarian",
  commentWages: "comment-wages",
  commentBooking: "comment-booking",
  trustpilotDelivery: "trustpilot-delivery",
  googleBrunch: "google-brunch",
  yelpCocktails: "yelp-cocktails",
} as const;

const mentions: Mention[] = [
  mention({
    label: MENTION_LABELS.slowService,
    locationId: LOC_SOHO,
    connectionId: CONN_GOOGLE,
    profileLabel: "google-soho",
    sourceType: "google_review",
    externalId: "1029384756",
    title: "Slow service and long wait",
    content:
      "We had a reservation for 7pm and weren't seated until 7:45pm. The service was slow and our entrées took nearly an hour to arrive. Food was okay but not worth the price or the wait. The room is beautiful and the host was apologetic, but nobody checked on us once we were seated.",
    authorName: "John L.",
    rating: 2,
    publishedAt: minutesAgo(12),
    status: "draft_ready",
    sentiment: "negative",
    riskLevel: "medium",
    relevanceScore: 0.97,
    rawPayload: { reviewer_review_count: 12, reviewer_photo_count: 3 },
  }),
  mention({
    label: MENTION_LABELS.foodSafety,
    locationId: LOC_SOHO,
    connectionId: CONN_GOOGLE,
    profileLabel: "google-soho",
    sourceType: "google_review",
    externalId: "1029385121",
    title: "Got sick after dinner",
    content:
      "My partner and I both felt unwell a few hours after the oyster course on Saturday. I've contacted the health department. Posting so others are aware before booking.",
    authorName: "Rachel D.",
    rating: 1,
    publishedAt: hoursAgo(9),
    status: "escalated",
    sentiment: "negative",
    riskLevel: "critical",
    relevanceScore: 0.99,
    rawPayload: { reviewer_review_count: 3 },
  }),
  mention({
    label: MENTION_LABELS.overpriced,
    locationId: LOC_SOHO,
    connectionId: CONN_GOOGLE,
    profileLabel: "google-soho",
    sourceType: "google_review",
    externalId: "1029385444",
    title: "Overpriced for what you get",
    content:
      "Overpriced for what you get. Small portions and the service was indifferent at best. Expected far more at this price point.",
    authorName: "NYC Foodie",
    rating: 1,
    publishedAt: hoursAgo(6),
    status: "new",
    sentiment: "negative",
    riskLevel: "high",
    relevanceScore: 0.91,
    rawPayload: { reviewer_review_count: 156 },
  }),
  mention({
    label: MENTION_LABELS.amazingStaff,
    locationId: LOC_UES,
    connectionId: CONN_GOOGLE,
    profileLabel: "google-ues",
    sourceType: "google_review",
    externalId: "1029384999",
    title: "Amazing experience and staff",
    content:
      "Our server, Emma, made the night extra special. She was attentive, kind, and knew the menu perfectly. We celebrated a birthday and the team surprised us with a candle in the dessert.",
    authorName: "Michael T.",
    rating: 5,
    publishedAt: daysAgo(1),
    status: "responded",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.94,
  }),
  mention({
    label: MENTION_LABELS.reservation,
    locationId: LOC_WEST_VILLAGE,
    connectionId: CONN_GOOGLE,
    profileLabel: "google-wv",
    sourceType: "google_review",
    externalId: "1029385777",
    title: "Impossible to get a reservation",
    content:
      "Love the food but the booking system releases tables at midnight and they're gone in ninety seconds. Please consider a waitlist.",
    authorName: "Ana R.",
    rating: 3,
    publishedAt: daysAgo(3),
    status: "draft_ready",
    sentiment: "mixed",
    riskLevel: "low",
    relevanceScore: 0.84,
  }),
  mention({
    label: MENTION_LABELS.anniversary,
    locationId: LOC_WEST_VILLAGE,
    connectionId: CONN_GOOGLE,
    profileLabel: "google-wv",
    sourceType: "google_review",
    externalId: "1029386010",
    title: "Wonderful anniversary dinner",
    content:
      "Celebrated our anniversary here and it was absolutely perfect. The tasting menu was thoughtful and the sommelier's pairings were excellent.",
    authorName: "Emily T.",
    rating: 5,
    publishedAt: daysAgo(1),
    status: "responded",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.9,
  }),
  mention({
    label: MENTION_LABELS.googleBrunch,
    locationId: LOC_TRIBECA,
    connectionId: CONN_GOOGLE,
    profileLabel: "google-tribeca",
    sourceType: "google_review",
    externalId: "1029386220",
    title: "Great food, rushed brunch service",
    content:
      "The food was genuinely excellent but we were asked twice whether we were finished before we'd cleared our plates. Felt hurried on a Sunday.",
    authorName: "Grace P.",
    rating: 3,
    publishedAt: daysAgo(4),
    status: "analyzed",
    sentiment: "mixed",
    riskLevel: "low",
    relevanceScore: 0.86,
  }),
  mention({
    label: MENTION_LABELS.yelpPerfect,
    locationId: LOC_WEST_VILLAGE,
    connectionId: CONN_YELP,
    profileLabel: "yelp-wv",
    sourceType: "yelp_review",
    externalId: "yelp-88213",
    title: "Perfect night out!",
    content:
      "Incredible cocktails, warm ambiance, and the staff went above and beyond. The tiramisu is a must! Our server Camille made great pairing suggestions.",
    authorName: "Sophie M.",
    rating: 5,
    publishedAt: hoursAgo(2),
    status: "monitoring",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.95,
  }),
  mention({
    label: MENTION_LABELS.yelpBilling,
    locationId: LOC_TRIBECA,
    connectionId: CONN_YELP,
    profileLabel: "yelp-tribeca",
    sourceType: "yelp_review",
    externalId: "yelp-88710",
    title: "Charged twice, still waiting on a refund",
    content:
      "We were charged twice for the same dinner on 12 July. Three calls and two emails later I still have no refund. Starting a chargeback with my bank this week.",
    authorName: "Priyanka S.",
    rating: 1,
    publishedAt: daysAgo(2),
    status: "escalated",
    sentiment: "negative",
    riskLevel: "high",
    relevanceScore: 0.93,
  }),
  mention({
    label: MENTION_LABELS.yelpNoise,
    locationId: LOC_SOHO,
    connectionId: CONN_YELP,
    profileLabel: "yelp-soho",
    sourceType: "yelp_review",
    externalId: "yelp-88904",
    title: "Loud room, lovely food",
    content:
      "The cooking is terrific and the wine list is fair. It is extremely loud after 8pm — we gave up on conversation.",
    authorName: "Tom H.",
    rating: 4,
    publishedAt: daysAgo(5),
    status: "monitoring",
    sentiment: "mixed",
    riskLevel: "low",
    relevanceScore: 0.81,
  }),
  mention({
    label: MENTION_LABELS.yelpCocktails,
    locationId: LOC_SOHO,
    connectionId: CONN_YELP,
    profileLabel: "yelp-soho",
    sourceType: "yelp_review",
    externalId: "yelp-89011",
    title: "Best negroni in the city",
    content:
      "Came for a drink at the bar and stayed for dinner. The bar team is doing serious work. Will be back.",
    authorName: "Diego M.",
    rating: 5,
    publishedAt: daysAgo(6),
    status: "no_action_recommended",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.79,
  }),
  mention({
    label: MENTION_LABELS.trustpilotDelivery,
    locationId: LOC_SOHO,
    connectionId: CONN_YELP,
    profileLabel: "yelp-soho",
    sourceType: "trustpilot_review",
    externalId: "tp-55120",
    title: "Delivery arrived cold",
    content:
      "Ordered the tasting box for a birthday at home. It arrived forty minutes late and cold. Support was polite but offered nothing.",
    authorName: "Alicia W.",
    rating: 2,
    publishedAt: daysAgo(7),
    status: "dismissed",
    sentiment: "negative",
    riskLevel: "low",
    relevanceScore: 0.62,
  }),
  mention({
    label: MENTION_LABELS.redditHype,
    locationId: null,
    connectionId: CONN_REDDIT,
    profileLabel: "reddit-watch",
    sourceType: "reddit_post",
    externalId: "t3_1abcde",
    title: "Maison Laurent — worth the hype?",
    content:
      "Has anyone been recently? Trying to decide if it's worth the price. Hard to get a table and the tasting menu is $165 before wine. I've heard mixed things about the pacing lately.",
    authorName: "u/foodie_nyc",
    publishedAt: hoursAgo(4),
    status: "needs_approval",
    sentiment: "mixed",
    riskLevel: "medium",
    relevanceScore: 0.89,
    engagementScore: 0.72,
    rawPayload: { subreddit: "r/FoodNYC", upvotes: 284, comment_count: 96, upvote_ratio: 0.91 },
  }),
  mention({
    label: MENTION_LABELS.redditRude,
    locationId: LOC_TRIBECA,
    connectionId: CONN_REDDIT,
    profileLabel: "reddit-watch",
    sourceType: "reddit_post",
    externalId: "t3_2bcdef",
    title: "Server at the Tribeca location was rude to my friend",
    content:
      "Went last night and the way the front of house spoke to my friend was genuinely uncomfortable. Not naming names but management should look at Saturday's late seating.",
    authorName: "u/hudson_eats",
    publishedAt: hoursAgo(11),
    status: "escalated",
    sentiment: "negative",
    riskLevel: "high",
    relevanceScore: 0.87,
    engagementScore: 0.55,
    rawPayload: { subreddit: "r/FoodNYC", upvotes: 96, comment_count: 41, upvote_ratio: 0.84 },
  }),
  mention({
    label: MENTION_LABELS.redditAnniversary,
    locationId: LOC_SOHO,
    connectionId: CONN_REDDIT,
    profileLabel: "reddit-watch",
    sourceType: "reddit_post",
    externalId: "t3_3cdefg",
    title: "Best anniversary dinner we've had in years",
    content:
      "Took my wife to Maison Laurent SoHo for our tenth. The team remembered a note I left in the booking and it made the night. Worth every dollar.",
    authorName: "u/brooklyn_ben",
    publishedAt: daysAgo(4),
    status: "no_action_recommended",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.82,
    engagementScore: 0.83,
    rawPayload: { subreddit: "r/nyc", upvotes: 412, comment_count: 33, upvote_ratio: 0.97 },
  }),
  mention({
    label: MENTION_LABELS.redditComment,
    locationId: null,
    connectionId: CONN_REDDIT,
    profileLabel: "reddit-watch",
    sourceType: "reddit_comment",
    externalId: "t1_9zyxwv",
    externalParentId: "t3_1abcde",
    title: null,
    content:
      "Went two weeks ago. Pacing was fine, about two hours. The bread course alone is worth it. Book the bar if you can't get a table.",
    authorName: "u/west4th",
    publishedAt: hoursAgo(3),
    status: "monitoring",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.74,
    engagementScore: 0.31,
    rawPayload: { subreddit: "r/FoodNYC", upvotes: 47 },
  }),
  mention({
    label: MENTION_LABELS.newsSpring,
    locationId: LOC_SOHO,
    connectionId: CONN_NEWS,
    profileLabel: "news-watch",
    sourceType: "news_article",
    externalId: "eater-2026-07-30-spring-menu",
    title: "Maison Laurent unveils new spring tasting menu",
    content:
      "The SoHo restaurant introduces a five-course menu celebrating seasonal French ingredients, with a vegetarian pairing available for the first time.",
    authorName: "Dana Whitfield",
    publishedAt: hoursAgo(6),
    status: "monitoring",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.93,
    engagementScore: 0.68,
    rawPayload: { publication: "Eater New York", authority_score: 0.88, estimated_reach: 310000, comment_count: 24 },
  }),
  mention({
    label: MENTION_LABELS.newsWages,
    locationId: null,
    connectionId: CONN_NEWS,
    profileLabel: "news-watch",
    sourceType: "news_article",
    externalId: "tribune-2026-07-28-labor",
    title: "Hospitality groups face scrutiny over tipped wage practices",
    content:
      "The piece names four New York groups, including Union Square Hospitality Group, and states that the group pools tips across front and back of house. It attributes a $19 tipped minimum to the group, which does not match our published pay bands.",
    authorName: "Alex Navarro",
    publishedAt: daysAgo(2),
    status: "needs_approval",
    sentiment: "negative",
    riskLevel: "high",
    relevanceScore: 0.96,
    engagementScore: 0.79,
    rawPayload: { publication: "Metro Tribune", authority_score: 0.79, estimated_reach: 540000, comment_count: 118 },
  }),
  mention({
    label: MENTION_LABELS.newsListicle,
    locationId: LOC_SOHO,
    connectionId: CONN_NEWS,
    profileLabel: "news-watch",
    sourceType: "news_article",
    externalId: "timeout-2026-07-26-tasting",
    title: "NYC's buzziest new tasting menus",
    content:
      "Maison Laurent makes the list of the city's most talked-about tasting menus this season, alongside five other rooms.",
    authorName: "Rosa Lindqvist",
    publishedAt: hoursAgo(30),
    status: "monitoring",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.8,
    engagementScore: 0.44,
    rawPayload: { publication: "Time Out New York", authority_score: 0.74, estimated_reach: 190000, comment_count: 9 },
  }),
  mention({
    label: MENTION_LABELS.commentVegetarian,
    locationId: LOC_SOHO,
    connectionId: CONN_DISQUS,
    profileLabel: "disqus-watch",
    sourceType: "article_comment",
    externalId: "cmt-773421",
    externalParentId: "eater-2026-07-30-spring-menu",
    title: "Do you have vegetarian options?",
    content:
      "Planning a visit this weekend and wondering if there are vegetarian items on the tasting menu. The article mentions a pairing but doesn't say whether it covers every course.",
    authorName: "@GreenEats",
    publishedAt: daysAgo(1),
    status: "needs_approval",
    sentiment: "neutral",
    riskLevel: "low",
    relevanceScore: 0.78,
    rawPayload: { publication: "Eater New York" },
  }),
  mention({
    label: MENTION_LABELS.commentWages,
    locationId: null,
    connectionId: CONN_DISQUS,
    profileLabel: "disqus-watch",
    sourceType: "article_comment",
    externalId: "cmt-991002",
    externalParentId: "tribune-2026-07-28-labor",
    title: null,
    content:
      "Every one of these groups underpays the back of house. The article doesn't go far enough. Nobody in that kitchen is clearing $19 an hour.",
    authorName: "@line_cook_212",
    publishedAt: daysAgo(2),
    status: "analyzed",
    sentiment: "negative",
    riskLevel: "medium",
    relevanceScore: 0.71,
    rawPayload: { publication: "Metro Tribune" },
  }),
  mention({
    label: MENTION_LABELS.commentBooking,
    locationId: LOC_WEST_VILLAGE,
    connectionId: CONN_DISQUS,
    profileLabel: "disqus-watch",
    sourceType: "article_comment",
    externalId: "cmt-991455",
    externalParentId: "timeout-2026-07-26-tasting",
    title: null,
    content:
      "Booked three months out and it was still worth it. Ask for the corner table if you can.",
    authorName: "@village_table",
    publishedAt: daysAgo(3),
    status: "monitoring",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.66,
    rawPayload: { publication: "Time Out New York" },
  }),

  // Harbor & Vine. Present only so isolation has something to fail against.
  mention({
    label: "harbor-great-view",
    organizationId: ORG_HARBOR,
    locationId: LOC_HARBOR_HOUSE,
    connectionId: CONN_HARBOR_GOOGLE,
    profileLabel: "harbor-google",
    sourceType: "google_review",
    externalId: "5001-aaa",
    title: "Great view, average food",
    content: "The view over the bay is unbeatable. The food is fine but forgettable for the price.",
    authorName: "Ken O.",
    rating: 3,
    publishedAt: daysAgo(2),
    status: "new",
    sentiment: "mixed",
    riskLevel: "low",
    relevanceScore: 0.88,
  }),
  mention({
    label: "harbor-allergy",
    organizationId: ORG_HARBOR,
    locationId: LOC_HARBOR_HOUSE,
    connectionId: CONN_HARBOR_GOOGLE,
    profileLabel: "harbor-google",
    sourceType: "google_review",
    externalId: "5001-bbb",
    title: "Allergy request ignored",
    content: "I flagged a shellfish allergy at booking and again at the table. The starter still arrived with shrimp.",
    authorName: "Marta V.",
    rating: 1,
    publishedAt: daysAgo(1),
    status: "escalated",
    sentiment: "negative",
    riskLevel: "critical",
    relevanceScore: 0.98,
  }),
  mention({
    label: "harbor-brunch",
    organizationId: ORG_HARBOR,
    locationId: LOC_HARBOR_HOUSE,
    connectionId: CONN_HARBOR_GOOGLE,
    profileLabel: "harbor-google",
    sourceType: "google_review",
    externalId: "5001-ccc",
    title: "Lovely brunch",
    content: "Friendly team and a good coffee programme. We'll be back with friends.",
    authorName: "Rob T.",
    rating: 5,
    publishedAt: daysAgo(5),
    status: "responded",
    sentiment: "positive",
    riskLevel: "low",
    relevanceScore: 0.83,
  }),
];

/* -------------------------------------------------------------------------- */
/* Analyses                                                                    */
/* -------------------------------------------------------------------------- */

interface AnalysisSeed {
  mentionLabel: string;
  organizationId?: string;
  summary: string;
  topics: string[];
  riskCategories: MentionAnalysis["riskCategories"];
  riskExplanation?: string | null;
  recommendedAction: MentionAnalysis["recommendedAction"];
  recommendationExplanation: string;
  sentiment: MentionAnalysis["sentiment"];
  sentimentScore: number;
  riskLevel: MentionAnalysis["riskLevel"];
  relevanceScore: number;
  factsNeedingVerification?: string[];
}

function analysis(seed: AnalysisSeed): MentionAnalysis {
  const mentionId = seedId(`mention:${seed.mentionLabel}`);
  return {
    id: seedId(`analysis:${seed.mentionLabel}`),
    organizationId: seed.organizationId ?? ORG_USHG,
    mentionId,
    modelProvider: "anthropic",
    modelName: "claude-opus-5",
    promptVersion: "analysis@2026-07-01",
    relevanceScore: seed.relevanceScore,
    relevanceExplanation: seed.summary,
    sentiment: seed.sentiment,
    sentimentScore: seed.sentimentScore,
    riskLevel: seed.riskLevel,
    riskCategories: seed.riskCategories,
    riskExplanation: seed.riskExplanation ?? null,
    topics: seed.topics,
    factsNeedingVerification: seed.factsNeedingVerification ?? [],
    recommendedAction: seed.recommendedAction,
    recommendationExplanation: seed.recommendationExplanation,
    analyzedAt: minutesAgo(5),
    // Provenance (workflow 04). These fixtures were written by hand, not
    // produced by a run, so there is no run to point at and no tokens were
    // spent — claiming either would fabricate a cost record.
    analysisRunId: null,
    inputTokens: null,
    outputTokens: null,
    createdAt: minutesAgo(5),
  };
}

const mentionAnalyses: MentionAnalysis[] = [
  analysis({
    mentionLabel: MENTION_LABELS.slowService,
    summary:
      "Guest is unhappy with long wait times and slow service despite having a reservation. Food quality was perceived as average relative to price.",
    topics: ["Service speed", "Wait time", "Reservation", "Value for money"],
    riskCategories: [],
    recommendedAction: "respond_publicly",
    recommendationExplanation:
      "Acknowledge the delay, apologise, and invite the guest to connect offline so we can make it right.",
    sentiment: "negative",
    sentimentScore: -0.62,
    riskLevel: "medium",
    relevanceScore: 0.97,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.foodSafety,
    summary:
      "Guest reports illness after a raw shellfish course and says they have contacted the health department.",
    topics: ["Food safety", "Shellfish", "Regulatory"],
    riskCategories: ["food_safety"],
    riskExplanation:
      "Alleged foodborne illness with a named service date and a regulator reportedly contacted.",
    recommendedAction: "escalate",
    recommendationExplanation:
      "Food safety claims are never auto-answered. Route to the escalation owner and hold any public reply until legal and operations sign off.",
    sentiment: "negative",
    sentimentScore: -0.94,
    riskLevel: "critical",
    relevanceScore: 0.99,
    factsNeedingVerification: [
      "Whether a health department report exists for the named service date",
      "Oyster supplier lot numbers for that Saturday service",
    ],
  }),
  analysis({
    mentionLabel: MENTION_LABELS.overpriced,
    summary:
      "One-star review from a high-volume local reviewer citing portion size, price, and indifferent service.",
    topics: ["Value for money", "Portion size", "Service"],
    riskCategories: [],
    riskExplanation: "Reviewer has a large local following and this is the third value complaint at SoHo this week.",
    recommendedAction: "respond_publicly",
    recommendationExplanation:
      "Respond without conceding on price, acknowledge the service gap, and offer a direct contact.",
    sentiment: "negative",
    sentimentScore: -0.71,
    riskLevel: "high",
    relevanceScore: 0.91,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.redditHype,
    summary:
      "An active thread weighing price against experience. Comments are split, with recurring doubt about pacing.",
    topics: ["Value for money", "Reservation difficulty", "Service speed", "Menu"],
    riskCategories: ["viral_discussion"],
    riskExplanation: "96 comments in four hours and the top result for the brand name on the subreddit.",
    recommendedAction: "respond_publicly",
    recommendationExplanation:
      "Reddit rewards a transparent, non-promotional reply from a named team member. Approval is required before posting.",
    sentiment: "mixed",
    sentimentScore: -0.08,
    riskLevel: "medium",
    relevanceScore: 0.89,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.redditRude,
    summary:
      "Allegation about staff conduct toward a guest at the Tribeca late seating. No individual is named publicly.",
    topics: ["Staff conduct", "Guest experience"],
    riskCategories: ["employee_misconduct"],
    riskExplanation: "Conduct allegation gaining comments quickly.",
    recommendedAction: "escalate",
    recommendationExplanation:
      "Conduct allegations go to people operations before any public reply. Do not discuss an individual employee in public.",
    sentiment: "negative",
    sentimentScore: -0.77,
    riskLevel: "high",
    relevanceScore: 0.87,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.newsWages,
    summary:
      "Investigative coverage of tipped wage practices that contains one figure we can document as incorrect.",
    topics: ["Labour practices", "Compensation", "Media coverage"],
    riskCategories: ["media_inquiry", "misinformation"],
    riskExplanation: "Named in a critical investigation at a high-reach publication, with a verifiable factual error.",
    recommendedAction: "contact_journalist",
    recommendationExplanation:
      "Send a documented correction request on the wage figure only, and prepare a short public comment. No direct publishing is available on this source.",
    sentiment: "negative",
    sentimentScore: -0.68,
    riskLevel: "high",
    relevanceScore: 0.96,
    factsNeedingVerification: [
      "Published tipped minimum for front-of-house roles in the current pay bands",
      "Whether the tip pool includes back-of-house staff",
    ],
  }),
  analysis({
    mentionLabel: MENTION_LABELS.yelpBilling,
    summary: "Billing dispute with an unresolved duplicate charge and a stated intent to open a chargeback.",
    topics: ["Billing", "Refunds", "Guest recovery"],
    riskCategories: ["refund_dispute"],
    riskExplanation: "Chargeback threatened after five unanswered contacts.",
    recommendedAction: "respond_privately",
    recommendationExplanation:
      "Resolve the refund before replying publicly, then post a short acknowledgement confirming it has been handled.",
    sentiment: "negative",
    sentimentScore: -0.83,
    riskLevel: "high",
    relevanceScore: 0.93,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.commentVegetarian,
    summary: "A direct, answerable question about vegetarian availability on the tasting menu.",
    topics: ["Dietary requirements", "Menu", "Reservation"],
    riskCategories: [],
    recommendedAction: "respond_publicly",
    recommendationExplanation:
      "A short factual reply converts interest into a booking. The comment system requires manual publishing.",
    sentiment: "neutral",
    sentimentScore: 0.05,
    riskLevel: "low",
    relevanceScore: 0.78,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.yelpPerfect,
    summary: "Enthusiastic five-star review praising cocktails, atmosphere, and service. Names a server and a dessert.",
    topics: ["Cocktails", "Atmosphere", "Staff praise", "Desserts"],
    riskCategories: [],
    recommendedAction: "respond_publicly",
    recommendationExplanation: "Thank the guest, name the server they praised, and invite them back for the seasonal menu.",
    sentiment: "positive",
    sentimentScore: 0.88,
    riskLevel: "low",
    relevanceScore: 0.95,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.newsSpring,
    summary: "Favourable trade coverage of the spring menu launch. Accurate on pricing and correctly credits the chef.",
    topics: ["Menu launch", "Seasonality", "Vegetarian options"],
    riskCategories: [],
    recommendedAction: "publish_owned_statement",
    recommendationExplanation: "Amplify through owned channels and thank the writer. No correction is needed.",
    sentiment: "positive",
    sentimentScore: 0.74,
    riskLevel: "low",
    relevanceScore: 0.93,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.reservation,
    summary: "Loyal guest frustrated by reservation availability rather than the experience itself.",
    topics: ["Reservation difficulty", "Booking system", "Loyalty"],
    riskCategories: [],
    recommendedAction: "respond_publicly",
    recommendationExplanation:
      "Acknowledge the friction, explain the release window, and point to the waitlist that opens next month.",
    sentiment: "mixed",
    sentimentScore: 0.12,
    riskLevel: "low",
    relevanceScore: 0.84,
  }),
  analysis({
    mentionLabel: MENTION_LABELS.commentWages,
    summary: "Comment repeating the article's incorrect wage figure and generalising it across the sector.",
    topics: ["Compensation", "Labour practices"],
    riskCategories: ["misinformation"],
    recommendedAction: "monitor",
    recommendationExplanation:
      "Hold until the correction request on the article is resolved, then decide whether a comment adds anything.",
    sentiment: "negative",
    sentimentScore: -0.55,
    riskLevel: "medium",
    relevanceScore: 0.71,
  }),
  analysis({
    mentionLabel: "harbor-allergy",
    organizationId: ORG_HARBOR,
    summary: "Guest states a declared shellfish allergy was not honoured.",
    topics: ["Allergen handling", "Food safety"],
    riskCategories: ["food_safety", "injury"],
    riskExplanation: "Allergen failure with a documented pre-notification.",
    recommendedAction: "escalate",
    recommendationExplanation: "Allergen incidents go straight to the on-call owner.",
    sentiment: "negative",
    sentimentScore: -0.91,
    riskLevel: "critical",
    relevanceScore: 0.98,
  }),
];

/* -------------------------------------------------------------------------- */
/* Response drafts and approvals                                               */
/* -------------------------------------------------------------------------- */

interface DraftSeed {
  label: string;
  mentionLabel: string;
  organizationId?: string;
  responseType: ResponseDraft["responseType"];
  status: ResponseDraft["status"];
  draftText: string;
  finalText?: string | null;
  generatedBy?: ResponseDraft["generatedBy"];
  assignedUserId?: string | null;
  approvedByUserId?: string | null;
  approvedAt?: string | null;
  publishedAt?: string | null;
  externalResponseId?: string | null;
  publicationError?: string | null;
  createdAt?: string;
}

function draft(seed: DraftSeed): ResponseDraft {
  const createdAt = seed.createdAt ?? hoursAgo(4);
  return {
    id: seedId(`draft:${seed.label}`),
    organizationId: seed.organizationId ?? ORG_USHG,
    mentionId: seedId(`mention:${seed.mentionLabel}`),
    responseType: seed.responseType,
    draftText: seed.draftText,
    finalText: seed.finalText ?? null,
    status: seed.status,
    generatedBy: seed.generatedBy ?? "ai",
    generationProvider: seed.generatedBy === "user" ? null : "anthropic",
    generationModel: seed.generatedBy === "user" ? null : "claude-opus-5",
    promptVersion: seed.generatedBy === "user" ? null : "draft@2026-07-01",
    brandVoiceVersion: "maison-laurent@3",
    policyVersion: "response-policy@2026-06",
    assignedUserId: seed.assignedUserId ?? null,
    approvedByUserId: seed.approvedByUserId ?? null,
    approvedAt: seed.approvedAt ?? null,
    publishedAt: seed.publishedAt ?? null,
    externalResponseId: seed.externalResponseId ?? null,
    publicationError: seed.publicationError ?? null,
    createdAt,
    updatedAt: createdAt,
  };
}

const responseDrafts: ResponseDraft[] = [
  draft({
    label: "slow-service",
    mentionLabel: MENTION_LABELS.slowService,
    responseType: "public_reply",
    status: "awaiting_approval",
    assignedUserId: USER_NAOMI,
    draftText:
      "Hi John,\n\nThank you for sharing your feedback. We're very sorry to hear about the long wait and slow service during your visit, especially with a reservation. That's not the experience we aim to deliver.\n\nWe'd love the opportunity to make it right. Please reach out to us directly so we can learn more and welcome you back.\n\nWarmly,\nThe Maison Laurent team",
    createdAt: minutesAgo(8),
  }),
  draft({
    label: "overpriced",
    mentionLabel: MENTION_LABELS.overpriced,
    responseType: "public_reply",
    status: "draft",
    draftText:
      "Hello,\n\nWe're sorry the visit fell short. Our tasting menu is priced around a five-course format with seasonal sourcing, but that only works when the service matches it — and it sounds like it didn't for you.\n\nWe'd like to hear more. You can reach our general manager directly.\n\nThe Maison Laurent team",
    createdAt: hoursAgo(5),
  }),
  draft({
    label: "reddit-hype",
    mentionLabel: MENTION_LABELS.redditHype,
    responseType: "public_reply",
    status: "awaiting_approval",
    assignedUserId: USER_JORDAN,
    draftText:
      "Hi — Priya here, general manager at the SoHo location.\n\nHappy to give you the straight version. The tasting menu is $165 and runs five courses; there's an à la carte list at the bar if you'd rather not commit to the full format. We reworked pacing in June after feedback that service was running long.\n\nIf you book for the anniversary, leave a note and we'll look after it.",
    createdAt: hoursAgo(3),
  }),
  draft({
    label: "news-wages",
    mentionLabel: MENTION_LABELS.newsWages,
    responseType: "journalist_email",
    status: "awaiting_approval",
    assignedUserId: USER_NAOMI,
    draftText:
      "Subject: Correction request — tipped minimum figure\n\nHi Alex,\n\nThank you for the coverage. One figure needs correcting: the piece states a $19 tipped minimum. Our published band for tipped front-of-house roles starts at $22.50, and our tip pool covers front of house only, not back of house.\n\nI've attached our current pay bands and the 2026 pool policy. Happy to talk it through.\n\nBest,\nNaomi Clarke",
    createdAt: daysAgo(1),
  }),
  draft({
    label: "comment-vegetarian",
    mentionLabel: MENTION_LABELS.commentVegetarian,
    responseType: "article_comment",
    status: "approved",
    assignedUserId: USER_JORDAN,
    approvedByUserId: USER_MARCUS,
    approvedAt: hoursAgo(20),
    draftText:
      "Yes — the spring tasting menu has a vegetarian version of all five courses, and the pairing covers the full menu. Just note it when you book and the kitchen will take it from there.",
    createdAt: daysAgo(1),
  }),
  draft({
    label: "reservation",
    mentionLabel: MENTION_LABELS.reservation,
    responseType: "public_reply",
    status: "approved",
    generatedBy: "user",
    assignedUserId: USER_MARCUS,
    approvedByUserId: USER_MARCUS,
    approvedAt: hoursAgo(30),
    draftText:
      "Hi Ana,\n\nThank you — and we hear you on the booking scramble. Tables release at midnight thirty days out, and demand at West Village clears them fast. We're opening a waitlist next month that holds your place automatically when a table frees up.\n\nWe'll be glad to see you again.\n\nThe Maison Laurent team",
    createdAt: daysAgo(2),
  }),
  draft({
    label: "amazing-staff",
    mentionLabel: MENTION_LABELS.amazingStaff,
    responseType: "public_reply",
    status: "published",
    approvedByUserId: USER_KATE,
    approvedAt: minutesAgo(30),
    publishedAt: minutesAgo(12),
    externalResponseId: "gbp-reply-77120",
    draftText:
      "Michael, thank you — we're so glad Emma made the birthday feel special. We'll pass this straight to her and the team. See you next time.",
    finalText:
      "Michael, thank you — we're delighted Emma made the birthday feel special. We've passed this straight to her and the team. We look forward to welcoming you back.",
    createdAt: hoursAgo(1),
  }),
  draft({
    label: "anniversary",
    mentionLabel: MENTION_LABELS.anniversary,
    responseType: "public_reply",
    status: "published",
    approvedByUserId: USER_KATE,
    approvedAt: hoursAgo(22),
    publishedAt: hoursAgo(20),
    externalResponseId: "gbp-reply-77004",
    draftText:
      "Emily, congratulations on the anniversary, and thank you for the kind words about the pairings. We'd love to have you back for the autumn menu.",
    finalText:
      "Emily, congratulations on the anniversary, and thank you for the kind words about the pairings. We'd love to have you back for the autumn menu.",
    createdAt: hoursAgo(24),
  }),
  draft({
    label: "yelp-billing",
    mentionLabel: MENTION_LABELS.yelpBilling,
    responseType: "private_reply",
    status: "failed",
    assignedUserId: USER_PRIYA,
    publicationError:
      "Yelp rejected the reply: the business owner account is not verified for this location.",
    draftText:
      "Priyanka, I'm sorry this has taken so long. I've asked our finance team to reverse the duplicate charge today and I'll confirm here once it clears.",
    createdAt: daysAgo(1),
  }),
  draft({
    label: "reddit-rude",
    mentionLabel: MENTION_LABELS.redditRude,
    responseType: "internal_briefing",
    status: "draft",
    assignedUserId: USER_NAOMI,
    draftText:
      "Internal only. Conduct allegation at Tribeca late seating on Saturday. People operations to review the floor rota and speak to the closing manager before any public response is considered.",
    createdAt: hoursAgo(10),
  }),
  draft({
    label: "harbor-brunch",
    mentionLabel: "harbor-brunch",
    organizationId: ORG_HARBOR,
    responseType: "public_reply",
    status: "published",
    approvedByUserId: USER_SOFIA,
    approvedAt: daysAgo(4),
    publishedAt: daysAgo(4),
    externalResponseId: "gbp-reply-5001",
    draftText: "Rob, thank you — we're glad the coffee hit the mark. See you and your friends soon.",
    finalText: "Rob, thank you — we're glad the coffee hit the mark. See you and your friends soon.",
    createdAt: daysAgo(5),
  }),
];

function approval(
  label: string,
  draftLabel: string,
  status: Approval["status"],
  assignedTo: string,
  requestedBy: string,
  decidedAt: string | null,
  decisionNote: string | null,
  organizationId = ORG_USHG,
): Approval {
  const createdAt = decidedAt ?? hoursAgo(3);
  return {
    id: seedId(`approval:${label}`),
    organizationId,
    responseDraftId: seedId(`draft:${draftLabel}`),
    requestedByUserId: requestedBy,
    assignedToUserId: assignedTo,
    status,
    decisionNote,
    decidedAt,
    createdAt,
    updatedAt: createdAt,
  };
}

const approvals: Approval[] = [
  approval("slow-service", "slow-service", "pending", USER_MARCUS, USER_NAOMI, null, null),
  approval("reddit-hype", "reddit-hype", "pending", USER_MARCUS, USER_NAOMI, null, null),
  approval("news-wages", "news-wages", "pending", USER_DANIEL, USER_NAOMI, null, null),
  approval(
    "comment-vegetarian",
    "comment-vegetarian",
    "approved",
    USER_MARCUS,
    USER_JORDAN,
    hoursAgo(20),
    "Factually correct against the current menu. Publish manually.",
  ),
  approval(
    "amazing-staff",
    "amazing-staff",
    "approved",
    USER_KATE,
    USER_NAOMI,
    minutesAgo(30),
    "Low risk, on voice.",
  ),
];

/* -------------------------------------------------------------------------- */
/* Escalations                                                                 */
/* -------------------------------------------------------------------------- */

interface EscalationSeed {
  label: string;
  mentionLabel: string;
  organizationId?: string;
  category: Escalation["category"];
  severity: Escalation["severity"];
  status: Escalation["status"];
  title: string;
  summary: string;
  assignedUserId: string | null;
  dueAt: string | null;
  openedAt: string;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
}

function escalation(seed: EscalationSeed): Escalation {
  return {
    id: seedId(`escalation:${seed.label}`),
    organizationId: seed.organizationId ?? ORG_USHG,
    mentionId: seedId(`mention:${seed.mentionLabel}`),
    category: seed.category,
    severity: seed.severity,
    status: seed.status,
    title: seed.title,
    summary: seed.summary,
    assignedUserId: seed.assignedUserId,
    dueAt: seed.dueAt,
    resolvedAt: seed.resolvedAt ?? null,
    resolutionNote: seed.resolutionNote ?? null,
    createdAt: seed.openedAt,
    updatedAt: seed.openedAt,
  };
}

const escalations: Escalation[] = [
  escalation({
    label: "food-safety",
    mentionLabel: MENTION_LABELS.foodSafety,
    category: "food_safety",
    severity: "critical",
    status: "in_progress",
    title: "Reported illness after oyster course — SoHo",
    summary:
      "Guest reports illness after Saturday's raw shellfish service and says the health department has been contacted. Supplier lot numbers are being pulled.",
    assignedUserId: USER_NAOMI,
    dueAt: minutesAgo(45),
    openedAt: hoursAgo(9),
  }),
  escalation({
    label: "conduct",
    mentionLabel: MENTION_LABELS.redditRude,
    category: "employee_misconduct",
    severity: "high",
    status: "in_progress",
    title: "Staff conduct allegation — Tribeca late seating",
    summary:
      "Public Reddit allegation about how a guest was spoken to. No individual named. People operations reviewing the rota.",
    assignedUserId: USER_NAOMI,
    dueAt: minutesFromNow(220),
    openedAt: hoursAgo(11),
  }),
  escalation({
    label: "refund",
    mentionLabel: MENTION_LABELS.yelpBilling,
    category: "refund_dispute",
    severity: "high",
    status: "open",
    title: "Duplicate charge unresolved — Tribeca",
    summary: "Guest charged twice on 12 July, five contacts unanswered, chargeback threatened.",
    assignedUserId: USER_PRIYA,
    dueAt: minutesFromNow(60),
    openedAt: daysAgo(2),
  }),
  escalation({
    label: "media",
    mentionLabel: MENTION_LABELS.newsWages,
    category: "media_inquiry",
    severity: "high",
    status: "pending_approval",
    title: "Correction request — tipped wage figure",
    summary:
      "Metro Tribune published a tipped minimum that contradicts our pay bands. Correction request drafted and awaiting sign-off.",
    assignedUserId: USER_NAOMI,
    dueAt: minutesFromNow(600),
    openedAt: daysAgo(2),
  }),
  escalation({
    label: "misinformation",
    mentionLabel: MENTION_LABELS.commentWages,
    category: "misinformation",
    severity: "medium",
    status: "resolved",
    title: "Comment amplifying the incorrect wage figure",
    summary: "Reader comment repeating the article's error across the sector.",
    assignedUserId: USER_KATE,
    dueAt: daysAgo(4),
    openedAt: daysAgo(6),
    resolvedAt: daysAgo(3),
    resolutionNote:
      "Outlet published a correction on the underlying article. No separate comment response required.",
  }),
  escalation({
    label: "harbor-allergy",
    mentionLabel: "harbor-allergy",
    organizationId: ORG_HARBOR,
    category: "food_safety",
    severity: "critical",
    status: "open",
    title: "Allergen failure — Harbor House",
    summary: "Declared shellfish allergy not honoured despite pre-notification at booking and at table.",
    assignedUserId: USER_SOFIA,
    dueAt: minutesFromNow(120),
    openedAt: daysAgo(1),
  }),
];

/* -------------------------------------------------------------------------- */
/* Automation rules                                                            */
/* -------------------------------------------------------------------------- */

function rule(
  label: string,
  fields: Omit<AutomationRule, "id" | "organizationId" | "createdAt" | "updatedAt">,
  organizationId = ORG_USHG,
): AutomationRule {
  return {
    id: seedId(`rule:${label}`),
    organizationId,
    ...fields,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(3),
  };
}

const automationRules: AutomationRule[] = [
  rule("auto-positive", {
    name: "Auto-publish positive Google replies",
    description:
      "Four- and five-star Google reviews with no risk flags get a brand-voice reply published without a human step.",
    status: "active",
    priority: 10,
    conditions: [
      { field: "source_type", operator: "is", value: "google_review" },
      { field: "rating", operator: "greater_than", value: 3 },
      { field: "risk_level", operator: "is", value: "low" },
      { field: "sentiment", operator: "is", value: "positive" },
    ],
    actions: [
      { type: "generate_draft", voiceProfile: "maison-laurent" },
      { type: "auto_publish" },
    ],
    lastRunAt: hoursAgo(20),
  }),
  rule("escalate-high-risk", {
    name: "Escalate high-risk mentions",
    description:
      "Anything classified high or critical goes straight to the escalations centre with a two-hour response target.",
    status: "active",
    priority: 1,
    conditions: [{ field: "risk_level", operator: "at_least", value: "high" }],
    actions: [
      { type: "escalate", assigneeUserId: USER_NAOMI },
      { type: "notify", channel: "both" },
      { type: "require_approval", approverUserId: USER_DANIEL },
    ],
    lastRunAt: hoursAgo(9),
  }),
  rule("reddit-approval", {
    name: "Approval-first Reddit engagement",
    description: "Reddit drafts are always held for a named approver. Nothing posts to Reddit automatically.",
    status: "active",
    priority: 20,
    conditions: [{ field: "platform", operator: "is", value: "reddit" }],
    actions: [
      { type: "generate_draft", voiceProfile: "maison-laurent" },
      { type: "require_approval", approverUserId: USER_MARCUS },
    ],
    lastRunAt: hoursAgo(4),
  }),
  rule("food-safety-hold", {
    name: "Hold all food safety mentions",
    description: "Food safety language blocks draft generation entirely and pages the on-call owner.",
    status: "active",
    priority: 0,
    conditions: [{ field: "risk_level", operator: "is", value: "critical" }],
    actions: [
      { type: "escalate", assigneeUserId: USER_DANIEL },
      { type: "tag", label: "Hold public response" },
    ],
    lastRunAt: hoursAgo(9),
  }),
  rule("assign-negative", {
    name: "Assign negative reviews to the location manager",
    description: "Negative reviews route to whoever manages that location, with a four-hour first-response target.",
    status: "active",
    priority: 30,
    conditions: [
      { field: "sentiment", operator: "is", value: "negative" },
      { field: "source_type", operator: "is", value: "google_review" },
    ],
    actions: [
      { type: "assign", assigneeUserId: USER_PRIYA },
      { type: "notify", channel: "email" },
    ],
    lastRunAt: hoursAgo(6),
  }),
  rule("media-watch", {
    name: "Flag high-authority media coverage",
    description: "Coverage above a relevance threshold notifies communications within fifteen minutes.",
    status: "inactive",
    priority: 40,
    conditions: [
      { field: "source_type", operator: "is", value: "news_article" },
      { field: "relevance_score", operator: "greater_than", value: 0.7 },
    ],
    actions: [{ type: "notify", channel: "in_app" }],
    lastRunAt: null,
  }),
  rule("dismiss-irrelevant", {
    name: "Dismiss low-relevance chatter",
    description: "Mentions scoring below 0.3 relevance are closed automatically so the queue stays honest.",
    status: "draft",
    priority: 90,
    conditions: [{ field: "relevance_score", operator: "less_than", value: 0.3 }],
    actions: [{ type: "set_status", status: "dismissed" }],
    lastRunAt: null,
  }),
  rule(
    "harbor-escalate",
    {
      name: "Escalate allergen mentions",
      description: "Any critical mention pages the owner immediately.",
      status: "active",
      priority: 0,
      conditions: [{ field: "risk_level", operator: "is", value: "critical" }],
      actions: [{ type: "escalate", assigneeUserId: USER_SOFIA }],
      lastRunAt: daysAgo(1),
    },
    ORG_HARBOR,
  ),
];

/* -------------------------------------------------------------------------- */
/* Audit events                                                                */
/* -------------------------------------------------------------------------- */

interface AuditSeed {
  label: string;
  organizationId?: string;
  actorUserId: string | null;
  actorType: AuditEvent["actorType"];
  eventType: AuditEvent["eventType"];
  entityType: AuditEvent["entityType"];
  entityId: string;
  previousState: Record<string, string | null> | null;
  newState: Record<string, string | null> | null;
  metadata?: Record<string, string>;
  occurredAt: string;
}

function auditEvent(seed: AuditSeed): AuditEvent {
  return {
    id: seedId(`audit:${seed.label}`),
    organizationId: seed.organizationId ?? ORG_USHG,
    actorUserId: seed.actorUserId,
    actorType: seed.actorType,
    eventType: seed.eventType,
    entityType: seed.entityType,
    entityId: seed.entityId,
    previousState: seed.previousState,
    newState: seed.newState,
    metadata: seed.metadata ?? {},
    occurredAt: seed.occurredAt,
  };
}

const auditEvents: AuditEvent[] = [
  auditEvent({
    label: "publish-amazing",
    actorUserId: USER_KATE,
    actorType: "user",
    eventType: "response.approved",
    entityType: "response_draft",
    entityId: seedId(`draft:amazing-staff`),
    previousState: { status: "awaiting_approval" },
    newState: { status: "approved" },
    metadata: { source: "responses" },
    occurredAt: minutesAgo(30),
  }),
  auditEvent({
    label: "escalation-food-safety",
    actorUserId: null,
    actorType: "system",
    eventType: "escalation.status_changed",
    entityType: "escalation",
    entityId: seedId(`escalation:food-safety`),
    previousState: { status: "open" },
    newState: { status: "in_progress" },
    metadata: { rule: "Escalate high-risk mentions" },
    occurredAt: hoursAgo(8),
  }),
  auditEvent({
    label: "assign-reddit",
    actorUserId: USER_KATE,
    actorType: "user",
    eventType: "response.assigned",
    entityType: "response_draft",
    entityId: seedId(`draft:reddit-hype`),
    previousState: { assignedUserId: null },
    newState: { assignedUserId: USER_JORDAN },
    occurredAt: hoursAgo(2),
  }),
  auditEvent({
    label: "escalation-media-assign",
    actorUserId: USER_DANIEL,
    actorType: "user",
    eventType: "escalation.assigned",
    entityType: "escalation",
    entityId: seedId(`escalation:media`),
    previousState: { assignedUserId: null },
    newState: { assignedUserId: USER_NAOMI },
    occurredAt: daysAgo(2),
  }),
  auditEvent({
    label: "mention-status-overpriced",
    actorUserId: null,
    actorType: "ai",
    eventType: "mention.status_changed",
    entityType: "mention",
    entityId: seedId(`mention:${MENTION_LABELS.overpriced}`),
    previousState: { status: "new" },
    newState: { status: "analyzed" },
    metadata: { model: "claude-opus-5" },
    occurredAt: hoursAgo(5),
  }),
  auditEvent({
    label: "rule-disabled",
    actorUserId: USER_NAOMI,
    actorType: "user",
    eventType: "automation_rule.disabled",
    entityType: "automation_rule",
    entityId: seedId(`rule:media-watch`),
    previousState: { status: "active" },
    newState: { status: "inactive" },
    occurredAt: daysAgo(1),
  }),
  auditEvent({
    label: "location-manager",
    actorUserId: USER_KATE,
    actorType: "user",
    eventType: "location.manager_changed",
    entityType: "location",
    entityId: LOC_UES,
    previousState: { managerUserId: null },
    newState: { managerUserId: USER_PRIYA },
    occurredAt: daysAgo(9),
  }),
  auditEvent({
    label: "reject-billing",
    actorUserId: USER_MARCUS,
    actorType: "user",
    eventType: "response.rejected",
    entityType: "response_draft",
    entityId: seedId(`draft:yelp-billing`),
    previousState: { status: "awaiting_approval" },
    newState: { status: "draft" },
    metadata: { reason: "Resolve the refund before replying publicly." },
    occurredAt: daysAgo(1),
  }),
  auditEvent({
    label: "harbor-escalation",
    organizationId: ORG_HARBOR,
    actorUserId: USER_SOFIA,
    actorType: "user",
    eventType: "escalation.assigned",
    entityType: "escalation",
    entityId: seedId(`escalation:harbor-allergy`),
    previousState: { assignedUserId: null },
    newState: { assignedUserId: USER_SOFIA },
    occurredAt: daysAgo(1),
  }),
];

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

export const SEED_DATASET: SeedDataset = {
  organizations,
  users,
  memberships,
  locations,
  platformConnections,
  platformProfiles,
  mentions,
  mentionAnalyses,
  responseDrafts,
  approvals,
  escalations,
  automationRules,
  auditEvents,
  monitoringQueries: [],
};

export { REFERENCE_NOW };
