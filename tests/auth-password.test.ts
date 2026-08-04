import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, newPasswordSchema } from "@/lib/auth/password";

/**
 * The new-password rules.
 *
 * Tested here rather than through the form, because `minLength` on an input is
 * a hint to the browser and not a constraint on what arrives. Anything that
 * matters has to hold when the request is posted directly.
 */

function parse(password: string, confirm = password) {
  return newPasswordSchema.safeParse({ password, confirm });
}

describe("length", () => {
  it("is above the provider's own floor of six", () => {
    // Below this the provider is doing the work, which makes the policy a
    // coincidence rather than a decision.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(6);
  });

  it("accepts a password at the minimum", () => {
    expect(parse("a".repeat(MIN_PASSWORD_LENGTH)).success).toBe(true);
  });

  it("rejects one character short", () => {
    const result = parse("a".repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("rejects an empty password", () => {
    expect(parse("").success).toBe(false);
  });

  it("imposes no composition rules", () => {
    // Deliberate. Requiring a digit and a symbol reliably produces `Passw0rd!`
    // and annoys everyone already using a manager, which generates something
    // stronger than any rule would think to demand.
    expect(parse("correct horse battery staple").success).toBe(true);
    expect(parse("aaaaaaaaaaaaaaaaaaaa").success).toBe(true);
  });

  it("does not trim, so a deliberate trailing space is honoured", () => {
    const withSpace = `${"a".repeat(MIN_PASSWORD_LENGTH)} `;
    const result = newPasswordSchema.safeParse({
      password: withSpace,
      confirm: withSpace,
    });
    expect(result.success).toBe(true);
  });
});

describe("confirmation", () => {
  it("accepts a matching pair", () => {
    expect(parse("a-long-enough-password").success).toBe(true);
  });

  it("rejects a mismatch and points at the confirm field", () => {
    const result = parse("a-long-enough-password", "a-different-password");

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["confirm"]);
    expect(result.error?.issues[0]?.message).toMatch(/do not match/i);
  });

  it("rejects a mismatch that differs only by whitespace", () => {
    // The likeliest real mismatch: a trailing space from a paste. Silently
    // trimming would set a password the person cannot reproduce.
    const result = parse("a-long-enough-password", "a-long-enough-password ");
    expect(result.success).toBe(false);
  });

  it("reports the length failure before the mismatch", () => {
    // Both are wrong here. Telling somebody their passwords do not match when
    // the real problem is length sends them round a loop.
    const result = parse("short", "different");
    expect(result.error?.issues[0]?.message).toContain(String(MIN_PASSWORD_LENGTH));
  });
});
