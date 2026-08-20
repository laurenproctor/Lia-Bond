import { z } from "zod";
import { phraseMatches } from "@/domain/entities/phrase-match";
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

/**
 * What to tell somebody standing in front of an empty phrase box.
 *
 * Declared here, beside the two limits it quotes, and rendered by **both**
 * phrase editors — the wizard's and the settings screen's. Two facts, both of
 * which change what a person types and neither of which is guessable:
 *
 * - **Matching is not exact.** Somebody who assumes it is writes out every
 *   variation of a phrase by hand.
 * - **There are limits.** The settings screen used to reveal these only by
 *   refusing a 21st chip, which is the worst moment to learn them.
 *
 * A constant rather than two hand-written strings because the wizard stating
 * the rule and the settings page staying silent about it is exactly the drift
 * this pairing keeps reintroducing.
 */
export const PHRASE_LIMIT_HINT = `Extra words are allowed inside a phrase — “made our day” also covers “really made our day”. Up to ${MAX_PHRASES} phrases, ${MAX_PHRASE_LENGTH} characters each.`;

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
    //
    // Checked under phrase matching rather than string equality, because that
    // is how these lists are read everywhere else: with "made our day" on the
    // avoid list, an approved "it really made our day" is unusable — every use
    // of it breaks the other rule. Identical spellings still collide, since a
    // phrase always matches itself.
    const collisions = value.prohibitedPhrases.filter((prohibited) =>
      value.approvedPhrases.some((approved) => phraseMatches(approved, prohibited)),
    );

    if (collisions.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["prohibitedPhrases"],
        message: `Also covered by a phrase to use: ${collisions.join(", ")}. Remove it from one list.`,
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

/**
 * Starting points offered on the two phrase lists.
 *
 * **Suggestions, never defaults.** `DEFAULT_BRAND_VOICE` ships both lists empty
 * on purpose — "a default phrase would put words in a customer's mouth" — and
 * that stands. These are only rendered as buttons somebody chooses to press:
 * nothing here reaches a saved profile, a prompt, or a reply unless it was
 * clicked. The value they add is showing what a *useful* entry looks like,
 * which an empty box with a placeholder does not.
 *
 * Written for restaurant groups, and kept to phrases a brand would plausibly
 * want rather than ones that sound impressive. The avoid list leans on the two
 * categories that actually cause trouble in public replies: promises the
 * business cannot keep for every guest, and corporate filler that reads as a
 * form letter.
 *
 * Deliberately disjoint under phrase matching, so pressing any two of them can
 * never produce the "also covered by a phrase to use" error.
 */
export const SUGGESTED_APPROVED_PHRASES: readonly string[] = [
  "Thank you for taking the time to share this",
  "We're glad you enjoyed your visit",
  "We'd love to welcome you back",
  "Our team will hear about this",
  "We're sorry we missed the mark",
  "Please ask for the manager on duty",
] as const;

export const SUGGESTED_PROHIBITED_PHRASES: readonly string[] = [
  "We guarantee",
  "This never happens",
  "Best in town",
  "We apologize for any inconvenience",
  "As per our policy",
  "You are mistaken",
] as const;
