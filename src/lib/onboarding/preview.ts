import type { BrandVoiceAxes, UpdateBrandVoiceInput } from "@/domain";

/**
 * The brand-voice preview on step 4.
 *
 * **Deterministic, and no model is called.** Three reasons, in order of how
 * much they matter:
 *
 * 1. A person dragging five sliders would fire a model request per frame. That
 *    is a bill, a rate limit, and a preview that lags behind the control.
 * 2. `LIA_AI_MODE` is frequently `unconfigured` — during onboarding especially,
 *    which is the one moment a new customer must not meet a configuration
 *    error. A preview that needs a provider is a preview that is blank exactly
 *    when it is most needed.
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
 * Weave an approved phrase in, if there is one.
 *
 * Only the first is used. Stuffing every approved phrase into one reply would
 * produce something no customer would believe a person wrote, and the list is a
 * vocabulary Lia may draw on rather than a checklist it must exhaust — which is
 * a distinction the preview has to demonstrate, not just claim.
 */
function withApprovedPhrase(sentences: string[], phrases: readonly string[]): string[] {
  const phrase = phrases[0];
  if (!phrase) return sentences;

  const trimmed = phrase.trim();
  if (trimmed.length === 0) return sentences;

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
 */
export function prohibitedPhrasesInPreview(
  preview: string,
  prohibitedPhrases: readonly string[],
): string[] {
  const haystack = preview.toLowerCase();
  return prohibitedPhrases.filter((phrase) => {
    const needle = phrase.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}
