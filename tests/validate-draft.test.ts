import { describe, expect, it } from "vitest";
import { DRAFT_MAX_CODE_POINTS, validateDraftText } from "@/lib/responses/validate-draft";

/**
 * `validateDraftText`: the Global Constraints gate
 * (`DRAFTING_SYSTEM_PROMPT`'s "Length and format" section in
 * `src/ai/anthropic/drafting-prompt.ts`) enforced against the model's raw
 * output, rather than trusted from the prompt alone. One concrete sample per
 * rejection reason, plus a clean reply that must pass and come back trimmed.
 */

/** Builds a plain-prose string of exactly `length` code points, no digits or symbols. */
function repeatToLength(base: string, length: number): string {
  const repeated = base.repeat(Math.ceil(length / base.length) + 1);
  return repeated.slice(0, length);
}

const CLEAN_REPLY = repeatToLength(
  "Thank you for taking the time to share your experience with us. We appreciate the feedback and would love to welcome you back again soon for an even better visit. ",
  400,
);

describe("validateDraftText: empty", () => {
  it("rejects an empty string", () => {
    expect(validateDraftText("")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a whitespace-only string", () => {
    expect(validateDraftText("   \n\t  ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("validateDraftText: too_long", () => {
  it("rejects 1,501 code points, counting emoji as one code point each", () => {
    const tooLong = "\u{1F600}".repeat(DRAFT_MAX_CODE_POINTS + 1);

    expect(Array.from(tooLong).length).toBe(DRAFT_MAX_CODE_POINTS + 1);
    expect(tooLong.length).toBeGreaterThan(Array.from(tooLong).length); // UTF-16 units != code points
    expect(validateDraftText(tooLong)).toEqual({ ok: false, reason: "too_long" });
  });

  it("accepts exactly 1,500 code points", () => {
    const atCap = "\u{1F600}".repeat(DRAFT_MAX_CODE_POINTS);

    expect(validateDraftText(atCap)).toEqual({ ok: true, text: atCap });
  });
});

describe("validateDraftText: markdown", () => {
  it("rejects a Markdown header", () => {
    expect(validateDraftText("## Response")).toEqual({ ok: false, reason: "markdown" });
  });

  it("rejects a Markdown bullet list", () => {
    expect(
      validateDraftText("We're sorry to hear that.\n- We'll fix it\n- We'll follow up"),
    ).toEqual({ ok: false, reason: "markdown" });
  });

  it("rejects a Markdown link", () => {
    expect(validateDraftText("Read more [here](https://example.com).")).toEqual({
      ok: false,
      reason: "markdown",
    });
  });
});

describe("validateDraftText: preamble", () => {
  it("rejects a generic 'Dear reviewer,' opening with an offered alternative", () => {
    const result = validateDraftText(
      "Dear reviewer,\n\nOption 1: We're sorry for the trouble. Option 2: Let us know how we can help.",
    );

    expect(result).toEqual({ ok: false, reason: "preamble" });
  });

  it("rejects the model announcing its own draft", () => {
    expect(
      validateDraftText("Here's a draft: Thank you for your feedback, we appreciate it."),
    ).toEqual({ ok: false, reason: "preamble" });
  });

  it("does not flag an ordinary 'Thank you for...' opening as preamble", () => {
    const result = validateDraftText(CLEAN_REPLY);

    expect(result.ok).toBe(true);
  });
});

describe("validateDraftText: alternatives", () => {
  it("rejects a reply offering two named options, with no preamble wording", () => {
    const result = validateDraftText(
      "We can offer two paths forward. Option 1: a replacement dish. Option 2: a full refund.",
    );

    expect(result).toEqual({ ok: false, reason: "alternatives" });
  });
});

describe("validateDraftText: contains_url", () => {
  it("rejects a reply containing a URL", () => {
    expect(
      validateDraftText("We're sorry to hear that -- please visit https://example.com for more."),
    ).toEqual({ ok: false, reason: "contains_url" });
  });
});

describe("validateDraftText: contains_phone", () => {
  it("rejects a reply containing a phone number", () => {
    expect(
      validateDraftText("Please call 212-555-0100 and we'll make it right."),
    ).toEqual({ ok: false, reason: "contains_phone" });
  });
});

describe("validateDraftText: contains_email", () => {
  it("rejects a reply containing an e-mail address", () => {
    expect(validateDraftText("Feel free to email us at x@y.com anytime.")).toEqual({
      ok: false,
      reason: "contains_email",
    });
  });
});

describe("validateDraftText: a clean reply", () => {
  it("passes a clean 400-character reply and returns it trimmed", () => {
    expect(Array.from(CLEAN_REPLY).length).toBe(400);

    const padded = `  \n${CLEAN_REPLY}\n  `;
    const result = validateDraftText(padded);

    expect(result).toEqual({ ok: true, text: CLEAN_REPLY });
  });
});
