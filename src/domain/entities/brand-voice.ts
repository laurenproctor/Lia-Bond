import { z } from "zod";
import {
  organizationOwnedSchema,
  timestampSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * Brand voice: how Lia is configured to sound.
 *
 * One profile per organization. Nothing reads it to generate text yet —
 * response drafting is a later workflow — so this module's job is to settle the
 * shape and refuse input that could not be acted on later.
 */

export const MAX_PHRASES = 20;
export const MAX_PHRASE_LENGTH = 80;

export const BRAND_VOICE_AXIS_KEYS = [
  "warmth",
  "detail",
  "formality",
  "confidence",
  "hospitality",
] as const;

export type BrandVoiceAxisKey = (typeof BRAND_VOICE_AXIS_KEYS)[number];

export interface BrandVoiceAxis {
  key: BrandVoiceAxisKey;
  /** The 0 pole. */
  leftLabel: string;
  /** The 100 pole. */
  rightLabel: string;
  /**
   * Plain-language descriptions of the low, middle, and high thirds.
   *
   * Held here rather than in the summary module so that adding an axis cannot
   * leave the summary silently describing four of five settings.
   */
  bands: readonly [string, string, string];
}

/**
 * The taxonomy.
 *
 * The single declaration of the axes. The form, the summary, and any future
 * prompt all read this, so a change lands in one place.
 */
export const BRAND_VOICE_AXES: readonly BrandVoiceAxis[] = [
  {
    key: "warmth",
    leftLabel: "Warm",
    rightLabel: "Formal",
    bands: ["Warm and personal", "Warm but composed", "Formal and reserved"],
  },
  {
    key: "detail",
    leftLabel: "Concise",
    rightLabel: "Detailed",
    bands: ["Brief and to the point", "Brief but thoughtful", "Thorough and specific"],
  },
  {
    key: "formality",
    leftLabel: "Casual",
    rightLabel: "Professional",
    bands: ["Casual and conversational", "Relaxed but polished", "Professional throughout"],
  },
  {
    key: "confidence",
    leftLabel: "Apologetic",
    rightLabel: "Confident",
    bands: ["Leads with an apology", "Acknowledges without over-apologising", "Confident and direct"],
  },
  {
    key: "hospitality",
    leftLabel: "Hospitality-forward",
    rightLabel: "Neutral",
    bands: [
      "Ends with an invitation back",
      "Offers a helpful next step",
      "Neutral, with no invitation",
    ],
  },
] as const;

const axisValueSchema = z
  .number()
  .int("Use a whole number.")
  .min(0, "Must be between 0 and 100.")
  .max(100, "Must be between 0 and 100.");

export const brandVoiceAxesSchema = z.object({
  warmth: axisValueSchema,
  detail: axisValueSchema,
  formality: axisValueSchema,
  confidence: axisValueSchema,
  hospitality: axisValueSchema,
});

export type BrandVoiceAxes = z.infer<typeof brandVoiceAxesSchema>;

/**
 * Keep the first spelling of each phrase, comparing case-insensitively.
 *
 * "Thank you" and "thank you" are the same instruction. Storing both would put
 * a meaningless distinction in front of whoever reads the list later.
 */
function dedupePhrases(phrases: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const phrase of phrases) {
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(phrase);
  }

  return kept;
}

/**
 * A phrase list, normalised on the way in.
 *
 * Trim and drop blanks first, so a row of empty inputs is not a validation
 * error a person has to hunt for. Length limits apply to what survives.
 */
export const phraseListSchema = z
  .array(z.string())
  .transform((raw) => raw.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0))
  .pipe(
    z
      .array(z.string().max(MAX_PHRASE_LENGTH, `Keep each phrase under ${MAX_PHRASE_LENGTH} characters.`))
      .max(MAX_PHRASES, `Up to ${MAX_PHRASES} phrases.`),
  )
  .transform(dedupePhrases);

export const updateBrandVoiceInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give this voice a name.").max(80),
    axes: brandVoiceAxesSchema,
    approvedPhrases: phraseListSchema,
    prohibitedPhrases: phraseListSchema,
  })
  .superRefine((value, ctx) => {
    // A phrase Lia must use and must never use is not a preference, it is a
    // contradiction. Cheaper to refuse here than to invent a precedence rule
    // nobody will remember when generation finally reads these lists.
    const approved = new Set(value.approvedPhrases.map((phrase) => phrase.toLowerCase()));
    const collisions = value.prohibitedPhrases.filter((phrase) =>
      approved.has(phrase.toLowerCase()),
    );

    if (collisions.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["prohibitedPhrases"],
        message: `Listed in both use and avoid: ${collisions.join(", ")}. Remove it from one.`,
      });
    }
  });

export type UpdateBrandVoiceInput = z.infer<typeof updateBrandVoiceInputSchema>;

export const brandVoiceProfileSchema = z
  .object({
    name: z.string().min(1),
    axes: brandVoiceAxesSchema,
    approvedPhrases: z.array(z.string()),
    prohibitedPhrases: z.array(z.string()),
    /**
     * Incremented on every save that changes something.
     *
     * `response_drafts.brand_voice_version` records which voice produced a
     * draft, so a no-op save must not bump this — see the repository.
     */
    version: z.number().int().positive(),
    updatedByUserId: uuidSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape);

export type BrandVoiceProfile = z.infer<typeof brandVoiceProfileSchema>;

/**
 * The starting point for an organization with no row.
 *
 * There is no backfill migration and `provision_organization` does not create
 * one, so absence is normal and means "never configured". The axis values are
 * declared once, here — the migration in `20260806000300_brand_voice.sql`
 * carries no column defaults, so this constant is the sole source of the
 * starting values. The phrase lists are empty because a default phrase would
 * put words in a customer's mouth.
 */
export const DEFAULT_BRAND_VOICE: UpdateBrandVoiceInput = {
  name: "Brand voice",
  axes: { warmth: 45, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
  approvedPhrases: [],
  prohibitedPhrases: [],
};
