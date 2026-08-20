import {
  findPhraseMatches,
  phraseMatches,
  type BrandVoiceAxes,
  type PhraseMatch,
  type UpdateBrandVoiceInput,
} from "@/domain";

/**
 * The brand-voice preview, shared by onboarding step 4 and `/brand-voice`.
 *
 * Lived under `src/lib/onboarding/` while step 4 was its only caller. It was
 * never onboarding-specific — it is pure, takes an `UpdateBrandVoiceInput`, and
 * imports nothing from the wizard — and keeping it there was what let the two
 * screens diverge: the settings page showed a "available once response drafting
 * arrives" placeholder while the wizard had a working preview, so the screen
 * somebody returns to was strictly less capable than the one they saw once.
 * Both now render this module, so the illustration a person tunes against
 * during setup is the illustration they get back afterwards.
 *
 * The chrome around it is deliberately *not* shared. Onboarding sits outside
 * the app shell on the public-site brand and the settings page is a product
 * page in it, so each renders its own markup; what has to agree is the reply
 * text, which phrases are flagged, and the sentence used to flag them — all of
 * which are decided here.
 *
 * **Deterministic, and no model is called.** Three reasons, in order of how
 * much they matter:
 *
 * 1. A person dragging five sliders would fire a model request per frame. That
 *    is a bill, a rate limit, and a preview that lags behind the control.
 * 2. `LIA_AI_MODE` is frequently `unconfigured` — during onboarding especially,
 *    which is the one moment a new customer must not meet a configuration
 *    error. A preview that needs a provider is a preview that is blank exactly
 *    when it is most needed. This holds on the settings screen too, and it is
 *    why response drafting having shipped did not make this module redundant:
 *    a real draft is a better *sample* and a worse *control*, because it cannot
 *    follow a slider and it fails when the provider is unset.
 * 3. A model's answer would be one sample from a distribution, and showing it
 *    beside "this is how Lia will reply" would overstate it. What this produces
 *    is an *illustration of the settings*, which is a claim it can actually keep
 *    — and the screen labels it as one.
 *
 * The sample review is fictional and labelled as such. It is not drawn from the
 * customer's data: at step 4 there may be no imported reviews at all, and
 * inventing one that looked real would be exactly the fabrication this codebase
 * refuses everywhere else.
 *
 * Pure. No I/O, no framework imports, directly unit-testable.
 */

/** Which third of an axis a value falls in. */
type Band = 0 | 1 | 2;

function band(value: number): Band {
  if (value < 34) return 0;
  if (value < 67) return 1;
  return 2;
}

/**
 * The illustrative review the preview replies to.
 *
 * Four stars and mildly positive on purpose: a five-star rave produces the same
 * reply under every setting, and a one-star complaint would put a fabricated
 * grievance on screen. A near-miss is where tone is actually visible.
 */
export const PREVIEW_REVIEW = {
  rating: 4,
  text: "Great food and friendly staff. Service was a little slow at the start, but we'd definitely come back.",
} as const;

/** Openers, by warmth. */
const OPENINGS: readonly [string, string, string] = [
  "Thank you so much for this — it really made our day.",
  "Thank you for taking the time to share this.",
  "Thank you for your feedback.",
];

/** How the slow service is acknowledged, by confidence. */
const ACKNOWLEDGEMENTS: readonly [string, string, string] = [
  "We're sorry the start of your visit was slower than it should have been.",
  "We're glad the meal landed well, and we've noted the slow start.",
  "We've passed the note about the slow start to the team running that shift.",
];

/** The optional extra sentence, by detail. */
const ELABORATIONS: readonly [string | null, string | null, string | null] = [
  null,
  "Our team is looking at how we pace the first few minutes of a table.",
  "We review pacing at the start of service each week, and your note is going into that review with the specific time and day of your visit.",
];

/** The sign-off, by hospitality. */
const CLOSINGS: readonly [string, string, string] = [
  "We'd love to welcome you back soon.",
  "If there's anything we can do next time, just ask for the manager on duty.",
  "Thanks again for the feedback.",
];

/**
 * Register adjustments, by formality.
 *
 * A word-level pass rather than a fourth sentence bank. Formality is a property
 * of *how* the other four sentences are written, not a thing to say — modelling
 * it as its own clause would produce a reply that mentioned its own register.
 */
function applyRegister(sentence: string, formality: Band): string {
  if (formality === 0) {
    return sentence
      .replace(/We are\b/g, "We're")
      .replace(/we are\b/g, "we're")
      .replace(/We would\b/g, "We'd")
      .replace(/we would\b/g, "we'd");
  }
  if (formality === 2) {
    return sentence
      .replace(/We're\b/g, "We are")
      .replace(/we're\b/g, "we are")
      .replace(/We'd\b/g, "We would")
      .replace(/we'd\b/g, "we would")
      .replace(/Thanks again\b/g, "Thank you again");
  }
  return sentence;
}

/**
 * Weave an approved phrase in, if there is one that is not already said.
 *
 * Only one is used. Stuffing every approved phrase into one reply would produce
 * something no customer would believe a person wrote, and the list is a
 * vocabulary Lia may draw on rather than a checklist it must exhaust — which is
 * a distinction the preview has to demonstrate, not just claim.
 *
 * Which one is chosen goes through phrase matching. The warm opening already
 * says "it really made our day", so an approved "made our day" is satisfied
 * before this function runs; inserting it anyway would show the same thought
 * twice in one reply, which reads as a bug rather than as a setting being
 * honoured. When a phrase is already covered the next uncovered one is used,
 * and when they all are, nothing is added.
 */
function withApprovedPhrase(sentences: string[], phrases: readonly string[]): string[] {
  const assembled = sentences.join(" ");
  const phrase = phrases.find(
    (candidate) =>
      candidate.trim().length > 0 && !phraseMatches(assembled, candidate),
  );
  if (!phrase) return sentences;

  const trimmed = phrase.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const punctuated = /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
  return [sentences[0] ?? "", punctuated, ...sentences.slice(1)].filter(
    (sentence) => sentence.length > 0,
  );
}

/**
 * Build the illustrative reply.
 *
 * Every axis moves something visible. An axis that changed nothing would be a
 * control the screen invited somebody to set and then ignored.
 */
export function buildVoicePreview(voice: UpdateBrandVoiceInput): string {
  const axes: BrandVoiceAxes = voice.axes;

  const warmth = band(axes.warmth);
  const detail = band(axes.detail);
  const formality = band(axes.formality);
  const confidence = band(axes.confidence);
  const hospitality = band(axes.hospitality);

  const sentences: string[] = [
    OPENINGS[warmth],
    ACKNOWLEDGEMENTS[confidence],
  ];

  const elaboration = ELABORATIONS[detail];
  if (elaboration) sentences.push(elaboration);

  sentences.push(CLOSINGS[hospitality]);

  return withApprovedPhrase(sentences, voice.approvedPhrases)
    .map((sentence) => applyRegister(sentence, formality))
    .join(" ");
}

/**
 * Prohibited phrases that appear in the preview.
 *
 * Normally empty — the sentence banks were written to avoid the obvious ones —
 * but a customer may prohibit a word this preview happens to use, and silently
 * showing a reply that breaks their own rule would undermine the whole screen.
 * When this returns anything, the preview says so rather than pretending.
 *
 * Matched as phrases rather than as substrings, which is both looser and
 * stricter than the `includes` it replaced: "made our day" now catches "really
 * made our day", and "our day" no longer catches "flavours our dayboat scallop"
 * — the old check matched across word boundaries, so it could fire on a word
 * the customer never wrote.
 *
 * Returns the matches, not just the phrases: with a rule this loose, a warning
 * has to be able to show *what* it matched, or the customer has no way to tell
 * whether it was right.
 */
export function prohibitedPhraseMatchesInPreview(
  preview: string,
  prohibitedPhrases: readonly string[],
): PhraseMatch[] {
  return findPhraseMatches(preview, prohibitedPhrases);
}

/**
 * The matched wording, written out for the warning.
 *
 * Here rather than in either screen because both have to say the same thing.
 * When this was inline JSX on step 4, the settings page had no warning at all
 * to disagree with; now that both render one, the phrasing is a single fact.
 *
 * Names what the example *actually said*, and the phrase it matched when the
 * two differ — a list that matches around extra words has to show its working,
 * or a warning about wording nobody typed looks like a mistake.
 */
export function describePreviewConflicts(matches: readonly PhraseMatch[]): string {
  return matches
    .map((match) =>
      match.matchedText.toLowerCase() === match.phrase.toLowerCase()
        ? `“${match.matchedText}”`
        : `“${match.matchedText}” (matching “${match.phrase}”)`,
    )
    .join(", ");
}
