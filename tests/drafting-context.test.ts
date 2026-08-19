import { describe, expect, it } from "vitest";
import type { DraftingPromptContext } from "@/ai/anthropic/drafting-prompt";
import {
  DEFAULT_BRAND_VOICE,
  NON_DISCUSSION_INGEST_FIELDS,
  type BrandVoiceProfile,
  type Location,
  type Mention,
  type MentionAnalysis,
  type Organization,
} from "@/domain";
import {
  buildDraftingContext,
  canonicalContextHash,
  type DraftingContext,
} from "@/lib/responses/drafting-context";

/**
 * `buildDraftingContext`: the frozen DTO handed to `renderDraftingPrompt`,
 * plus the provenance a `generation_attempts` row records alongside it
 * (`brandVoiceSource`, `brandVoiceVersion`, `analysisIncluded`).
 *
 * Two things matter beyond "does it read the right fields": the voice
 * snapshot must fall back to `DEFAULT_BRAND_VOICE` when there is no saved
 * profile, and the returned context must be a genuine snapshot -- mutating
 * whatever was passed in afterwards must never reach it.
 */

const ORG_ID = "1a2b3c4d-1111-4a22-8b33-1a2b3c4d5e6f";
const LOCATION_ID = "2a2b3c4d-2222-4a22-8b33-1a2b3c4d5e6f";
const MENTION_ID = "3a2b3c4d-3333-4a22-8b33-1a2b3c4d5e6f";
const CONNECTION_ID = "4a2b3c4d-4444-4a22-8b33-1a2b3c4d5e6f";
const VOICE_ID = "5a2b3c4d-5555-4a22-8b33-1a2b3c4d5e6f";
const ANALYSIS_ID = "6a2b3c4d-6666-4a22-8b33-1a2b3c4d5e6f";
const ANALYSIS_RUN_ID = "7a2b3c4d-7777-4a22-8b33-1a2b3c4d5e6f";

function baseMention(overrides: Partial<Mention> = {}): Mention {
  return {
    id: MENTION_ID,
    organizationId: ORG_ID,
    locationId: LOCATION_ID,
    platformConnectionId: CONNECTION_ID,
    platformProfileId: null,
    sourceType: "google_review",
    externalId: "ext-1",
    externalParentId: null,
    sourceUrl: "https://maps.example.com/review/1",
    title: null,
    content: "The service was slow but the food was great. Will come back.",
    authorName: "Jordan P.",
    authorExternalId: null,
    rating: 4,
    language: "en",
    publishedAt: "2026-08-10T12:00:00.000Z",
    receivedAt: "2026-08-10T12:05:00.000Z",
    status: "analyzed",
    sentiment: "mixed",
    riskLevel: "low",
    relevanceScore: 0.9,
    engagementScore: null,
    rawPayload: {},
    externalResourceName: null,
    authorAvatarUrl: null,
    authorIsAnonymous: false,
    sourceUpdatedAt: null,
    sourceReplyText: null,
    sourceReplyUpdatedAt: null,
    sourceMetadata: {},
    lastSyncedAt: null,
    publisherName: null,
    publisherDomain: null,
    isSyndicated: false,
    monitoringQueryId: null,
    captureMethod: "provider_api",
    capturedByUserId: null,
    capturedAt: null,
    yelpActivityOccurrenceId: null,
    ...NON_DISCUSSION_INGEST_FIELDS,
    createdAt: "2026-08-10T12:05:00.000Z",
    updatedAt: "2026-08-10T12:05:00.000Z",
    ...overrides,
  };
}

function baseLocation(overrides: Partial<Location> = {}): Location {
  return {
    id: LOCATION_ID,
    organizationId: ORG_ID,
    name: "Lia Bistro - Downtown",
    slug: "downtown",
    addressLine1: "1 Main St",
    addressLine2: null,
    city: "New York",
    region: "NY",
    postalCode: "10001",
    countryCode: "US",
    timezone: "America/New_York",
    status: "active",
    managerUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseOrganization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG_ID,
    name: "Lia Bistro Group",
    slug: "lia-bistro-group",
    industry: "Restaurants",
    websiteUrl: null,
    defaultTimezone: "America/New_York",
    defaultLanguage: "en",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseVoiceProfile(overrides: Partial<BrandVoiceProfile> = {}): BrandVoiceProfile {
  return {
    id: VOICE_ID,
    organizationId: ORG_ID,
    name: "Maison voice",
    axes: { warmth: 62, detail: 38, formality: 51, confidence: 70, hospitality: 20 },
    approvedPhrases: ["we appreciate you sharing this"],
    prohibitedPhrases: ["not our fault", "policy is policy"],
    version: 3,
    updatedByUserId: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-07-15T09:30:00.000Z",
    ...overrides,
  };
}

function baseAnalysis(overrides: Partial<MentionAnalysis> = {}): MentionAnalysis {
  return {
    id: ANALYSIS_ID,
    organizationId: ORG_ID,
    mentionId: MENTION_ID,
    modelProvider: "anthropic",
    modelName: "claude-sonnet",
    promptVersion: "analysis@1",
    relevanceScore: 0.95,
    relevanceExplanation: null,
    sentiment: "mixed",
    sentimentScore: 0.1,
    riskLevel: "low",
    riskCategories: [],
    riskExplanation: null,
    topics: ["service speed", "food quality"],
    factsNeedingVerification: [],
    recommendedAction: "respond_publicly",
    recommendationExplanation: null,
    analyzedAt: "2026-08-10T12:10:00.000Z",
    analysisRunId: ANALYSIS_RUN_ID,
    inputTokens: 500,
    outputTokens: 120,
    outcomeAppliedAt: "2026-08-10T12:10:01.000Z",
    createdAt: "2026-08-10T12:10:00.000Z",
    ...overrides,
  };
}

describe("buildDraftingContext: review, business, and location fields", () => {
  it("carries the mention, organization, and location through verbatim", () => {
    const mention = baseMention();
    const location = baseLocation();
    const organization = baseOrganization();

    const { context } = buildDraftingContext(mention, location, organization, null, null);

    expect(context.review).toEqual({
      text: mention.content,
      rating: mention.rating,
      authorName: mention.authorName,
      publishedAt: mention.publishedAt,
      locationName: location.name,
    });
    expect(context.business).toEqual({
      organizationName: organization.name,
      defaultLanguage: organization.defaultLanguage,
    });
  });

  it("reports locationName: null when the mention has no location", () => {
    const { context } = buildDraftingContext(
      baseMention({ locationId: null }),
      null,
      baseOrganization(),
      null,
      null,
    );

    expect(context.review.locationName).toBeNull();
  });
});

describe("buildDraftingContext: brand voice", () => {
  it("carries a configured profile's sliders and banned phrases verbatim", () => {
    const profile = baseVoiceProfile();

    const result = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      profile,
      null,
    );

    expect(result.context.voice).toEqual({
      warmth: profile.axes.warmth,
      detail: profile.axes.detail,
      formality: profile.axes.formality,
      confidence: profile.axes.confidence,
      hospitality: profile.axes.hospitality,
      toneNotes: null,
      preferredPhrases: profile.approvedPhrases,
      bannedPhrases: profile.prohibitedPhrases,
      signOff: null,
    });
    expect(result.brandVoiceSource).toBe("configured");
    // `String(profile.version)`, not `profile.updatedAt` -- brand-voice.ts's
    // own doc comment on `version` says `response_drafts.brand_voice_version`
    // records this field.
    expect(result.brandVoiceVersion).toBe(String(profile.version));
  });

  it("falls back to DEFAULT_BRAND_VOICE with brandVoiceSource: default and a null version when there is no row", () => {
    const result = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      null,
      null,
    );

    expect(result.context.voice).toEqual({
      warmth: DEFAULT_BRAND_VOICE.axes.warmth,
      detail: DEFAULT_BRAND_VOICE.axes.detail,
      formality: DEFAULT_BRAND_VOICE.axes.formality,
      confidence: DEFAULT_BRAND_VOICE.axes.confidence,
      hospitality: DEFAULT_BRAND_VOICE.axes.hospitality,
      toneNotes: null,
      preferredPhrases: [],
      bannedPhrases: [],
      signOff: null,
    });
    expect(result.brandVoiceSource).toBe("default");
    expect(result.brandVoiceVersion).toBeNull();
  });
});

describe("buildDraftingContext: analysis", () => {
  it("sets analysisIncluded: true and carries sentiment/riskLevel/topics when analysis is given", () => {
    const analysis = baseAnalysis();

    const result = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      null,
      analysis,
    );

    expect(result.analysisIncluded).toBe(true);
    expect(result.context.analysis).toEqual({
      sentiment: analysis.sentiment,
      riskLevel: analysis.riskLevel,
      topics: analysis.topics,
    });
  });

  it("sets analysisIncluded: false and analysis: null when there is no analysis", () => {
    const result = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      null,
      null,
    );

    expect(result.analysisIncluded).toBe(false);
    expect(result.context.analysis).toBeNull();
  });
});

describe("buildDraftingContext: frozen snapshot", () => {
  it("is unaffected by mutating the source profile and analysis after building", () => {
    const profile = baseVoiceProfile();
    const analysis = baseAnalysis();

    const { context } = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      profile,
      analysis,
    );

    const preferredPhrasesBefore = [...context.voice.preferredPhrases];
    const bannedPhrasesBefore = [...context.voice.bannedPhrases];
    const topicsBefore = [...(context.analysis?.topics ?? [])];
    const warmthBefore = context.voice.warmth;

    // Mutate every source object the builder read, after the fact.
    profile.approvedPhrases.push("mutated after build");
    profile.prohibitedPhrases.push("mutated after build");
    profile.axes.warmth = 1;
    analysis.topics.push("mutated after build");

    expect(context.voice.preferredPhrases).toEqual(preferredPhrasesBefore);
    expect(context.voice.bannedPhrases).toEqual(bannedPhrasesBefore);
    expect(context.voice.warmth).toBe(warmthBefore);
    expect(context.analysis?.topics).toEqual(topicsBefore);
  });
});

describe("canonicalContextHash", () => {
  it("is a lowercase sha256 hex digest", () => {
    const { context } = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      null,
      null,
    );

    expect(canonicalContextHash(context)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across two builds of the same inputs", () => {
    const a = buildDraftingContext(baseMention(), baseLocation(), baseOrganization(), null, null);
    const b = buildDraftingContext(baseMention(), baseLocation(), baseOrganization(), null, null);

    expect(canonicalContextHash(a.context)).toBe(canonicalContextHash(b.context));
  });

  it("changes when the review text changes", () => {
    const a = buildDraftingContext(baseMention(), baseLocation(), baseOrganization(), null, null);
    const b = buildDraftingContext(
      baseMention({ content: "A completely different review." }),
      baseLocation(),
      baseOrganization(),
      null,
      null,
    );

    expect(canonicalContextHash(a.context)).not.toBe(canonicalContextHash(b.context));
  });

  it("does not depend on object key order", () => {
    const { context } = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      baseVoiceProfile(),
      baseAnalysis(),
    );

    const reordered = reorderKeysDeep(context) as DraftingContext;

    expect(canonicalContextHash(reordered)).toBe(canonicalContextHash(context));
  });
});

describe("DraftingContext / DraftingPromptContext compatibility", () => {
  it("is assignable to the drafting renderer's context type, unchanged", () => {
    const { context } = buildDraftingContext(
      baseMention(),
      baseLocation(),
      baseOrganization(),
      baseVoiceProfile(),
      baseAnalysis(),
    );

    // Compile-time assertion: Task 5's renderer (`renderDraftingPrompt`) takes
    // `DraftingPromptContext`. If `DraftingContext` ever drifted from that
    // shape, this assignment would fail `tsc --noEmit`.
    const promptContext: DraftingPromptContext = context;

    expect(promptContext.voice.warmth).toBe(context.voice.warmth);
  });
});

/** Rebuilds every plain object in `value` with its keys in reverse order. */
function reorderKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reorderKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).reverse();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = reorderKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
