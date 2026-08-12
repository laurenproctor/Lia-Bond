import { createHash } from "node:crypto";
import { z } from "zod";
import {
  brandVoiceAxesSchema,
  DEFAULT_BRAND_VOICE,
  riskLevelSchema,
  sentimentSchema,
  type BrandVoiceProfile,
  type BrandVoiceSource,
  type Location,
  type Mention,
  type MentionAnalysis,
  type Organization,
} from "@/domain";

/**
 * The frozen input to one drafting attempt.
 *
 * Built once per attempt by `buildDraftingContext`, then handed to
 * `renderDraftingPrompt` (`src/ai/anthropic/drafting-prompt.ts`) and recorded
 * alongside the attempt via `canonicalContextHash`. "Frozen" is the point:
 * nothing downstream can observe a later edit to the mention, location,
 * organization, or voice profile that produced it, because the builder
 * deep-copies everything it reads before returning.
 */

/**
 * The five brand-voice sliders, plus the three fields the drafting prompt
 * also needs (`toneNotes`, `bannedPhrases`, `signOff`) that
 * `src/domain/entities/brand-voice.ts` does not yet model as columns.
 *
 * Mapping decision (task 6 of the response-generation plan):
 * - `bannedPhrases` <- the profile's `prohibitedPhrases` (or
 *   `DEFAULT_BRAND_VOICE.prohibitedPhrases`, `[]` today, when unconfigured).
 * - `toneNotes` and `signOff` have no counterpart in `brand-voice.ts` today —
 *   no field there plausibly stands in for either (the profile has no notes
 *   field and no signature field). Both are always `null`, in both the
 *   configured and default snapshot, until a future migration adds them.
 *   Nothing here invents a value for either.
 */
export const draftingVoiceSnapshotSchema = brandVoiceAxesSchema.extend({
  toneNotes: z.string().nullable(),
  bannedPhrases: z.array(z.string()),
  signOff: z.string().nullable(),
});

export type DraftingVoiceSnapshot = z.infer<typeof draftingVoiceSnapshotSchema>;

export const draftingContextSchema = z.object({
  review: z.object({
    /** Untrusted: a customer's own words. Never treated as instructions. */
    text: z.string(),
    rating: z.number().min(0).max(5).nullable(),
    /** Untrusted, same as `text`. */
    authorName: z.string().nullable(),
    publishedAt: z.string(),
    locationName: z.string().nullable(),
  }),
  business: z.object({
    organizationName: z.string(),
    defaultLanguage: z.string(),
  }),
  analysis: z
    .object({
      sentiment: sentimentSchema,
      riskLevel: riskLevelSchema,
      topics: z.array(z.string()),
    })
    .nullable(),
  voice: draftingVoiceSnapshotSchema,
});

/**
 * Structurally assignable to `DraftingPromptContext`
 * (`src/ai/anthropic/drafting-prompt.ts`) without a cast: same field names,
 * and `sentiment`/`riskLevel` narrow to `string`, `warmth`..`hospitality`
 * infer as `number`. `tests/drafting-context.test.ts` pins that assignment.
 */
export type DraftingContext = z.infer<typeof draftingContextSchema>;

export interface BuildDraftingContextResult {
  context: DraftingContext;
  brandVoiceSource: BrandVoiceSource;
  /** The profile's `updatedAt` (ISO timestamp) when configured; `null` on defaults. */
  brandVoiceVersion: string | null;
  analysisIncluded: boolean;
}

function voiceSnapshotFromProfile(profile: BrandVoiceProfile): DraftingVoiceSnapshot {
  return {
    warmth: profile.axes.warmth,
    detail: profile.axes.detail,
    formality: profile.axes.formality,
    confidence: profile.axes.confidence,
    hospitality: profile.axes.hospitality,
    toneNotes: null,
    bannedPhrases: [...profile.prohibitedPhrases],
    signOff: null,
  };
}

function defaultVoiceSnapshot(): DraftingVoiceSnapshot {
  return {
    warmth: DEFAULT_BRAND_VOICE.axes.warmth,
    detail: DEFAULT_BRAND_VOICE.axes.detail,
    formality: DEFAULT_BRAND_VOICE.axes.formality,
    confidence: DEFAULT_BRAND_VOICE.axes.confidence,
    hospitality: DEFAULT_BRAND_VOICE.axes.hospitality,
    toneNotes: null,
    bannedPhrases: [...DEFAULT_BRAND_VOICE.prohibitedPhrases],
    signOff: null,
  };
}

/**
 * Build the frozen drafting context for one mention.
 *
 * `location` and `voiceProfile` are nullable for the same reason:
 * `mention.locationId` is nullable (a Reddit thread or a news article is not
 * always tied to a restaurant), and an organization with no saved brand-voice
 * row is the normal, unconfigured state (`DEFAULT_BRAND_VOICE`'s doc
 * comment). Both absences render as an honest fallback rather than a
 * fabricated value.
 */
export function buildDraftingContext(
  mention: Mention,
  location: Location | null,
  organization: Organization,
  voiceProfile: BrandVoiceProfile | null,
  latestAnalysis: MentionAnalysis | null,
): BuildDraftingContextResult {
  const voice = voiceProfile
    ? voiceSnapshotFromProfile(voiceProfile)
    : defaultVoiceSnapshot();

  const context = draftingContextSchema.parse({
    review: {
      text: mention.content,
      rating: mention.rating,
      authorName: mention.authorName,
      publishedAt: mention.publishedAt,
      locationName: location ? location.name : null,
    },
    business: {
      organizationName: organization.name,
      defaultLanguage: organization.defaultLanguage,
    },
    analysis: latestAnalysis
      ? {
          sentiment: latestAnalysis.sentiment,
          riskLevel: latestAnalysis.riskLevel,
          topics: [...latestAnalysis.topics],
        }
      : null,
    voice,
  } satisfies DraftingContext);

  return {
    // `draftingContextSchema.parse` already rebuilds every nested object and
    // array, but `structuredClone` makes the "nothing the caller does to its
    // inputs afterwards can reach this context" guarantee explicit rather
    // than a side effect of how Zod happens to parse today.
    context: structuredClone(context),
    brandVoiceSource: voiceProfile ? "configured" : "default",
    brandVoiceVersion: voiceProfile ? voiceProfile.updatedAt : null,
    analysisIncluded: latestAnalysis !== null,
  };
}

/**
 * Deterministic string form of a JSON-serialisable value: object keys sorted,
 * arrays kept in element order. Exists only so `canonicalContextHash` does
 * not depend on the property insertion order of the context it is given.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of `context`, as lowercase hex, over a key-order-independent encoding. */
export function canonicalContextHash(context: DraftingContext): string {
  return createHash("sha256").update(stableStringify(context), "utf8").digest("hex");
}
