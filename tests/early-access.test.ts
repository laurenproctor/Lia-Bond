import { describe, expect, it } from "vitest";
import {
  composeEarlyAccessNotification,
  earlyAccessSchema,
} from "@/lib/site/early-access";

/**
 * Early-access validation and composition.
 *
 * This is a public, unauthenticated endpoint — the only one in the application
 * — so the schema is the entire trust boundary. Two properties carry the most
 * weight: the email is normalised before it ever reaches the unique index, and
 * nothing a stranger types can bend the shape of the notification that lands in
 * the support inbox.
 */

const VALID = {
  email: "sam@harborandvine.com",
  businessName: "Harbor & Vine",
  industry: "restaurants",
  sourcePath: "/for/restaurants",
  website: "",
};

function compose(input: unknown) {
  return composeEarlyAccessNotification({
    request: earlyAccessSchema.parse(input),
    sentAt: new Date("2026-08-04T09:30:00.000Z"),
    origin: "https://lia.bond",
  });
}

describe("earlyAccessSchema", () => {
  it("accepts a complete request", () => {
    expect(earlyAccessSchema.parse(VALID).email).toBe("sam@harborandvine.com");
  });

  it("lowercases and trims the address", () => {
    // The unique index is on lower(email); normalising here means the index
    // does the job it was built for rather than admitting three spellings.
    const parsed = earlyAccessSchema.parse({
      ...VALID,
      email: "  SAM@HarborAndVine.com  ",
    });
    expect(parsed.email).toBe("sam@harborandvine.com");
  });

  it("rejects an address that is not one", () => {
    expect(() => earlyAccessSchema.parse({ ...VALID, email: "sam@" })).toThrow();
  });

  it("requires an address", () => {
    expect(() => earlyAccessSchema.parse({ ...VALID, email: "" })).toThrow();
  });

  it("treats a filled honeypot as a bot", () => {
    // `website` is hidden from people and irresistible to form-fillers.
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, website: "http://spam.example" }),
    ).toThrow();
  });

  it("accepts a request with no business name or industry", () => {
    const parsed = earlyAccessSchema.parse({
      email: "sam@harborandvine.com",
      website: "",
    });
    expect(parsed.businessName).toBeNull();
    expect(parsed.industry).toBeNull();
  });

  it("rejects an unknown industry rather than storing it", () => {
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, industry: "dentists" }),
    ).toThrow();
  });

  it("refuses an overlong business name", () => {
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, businessName: "x".repeat(201) }),
    ).toThrow();
  });

  it("keeps a stray source path from becoming an open field", () => {
    // Only paths, never absolute URLs — the value is echoed into the email.
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, sourcePath: "https://evil.example" }),
    ).toThrow();
  });
});

describe("composeEarlyAccessNotification", () => {
  it("names the requester in the subject", () => {
    expect(compose(VALID).subject).toContain("sam@harborandvine.com");
  });

  it("reports the business, industry, and converting page", () => {
    const { text } = compose(VALID);
    expect(text).toContain("Harbor & Vine");
    expect(text).toContain("Restaurants");
    expect(text).toContain("/for/restaurants");
  });

  it("says so plainly when optional fields are absent", () => {
    const { text } = compose({ email: "sam@harborandvine.com", website: "" });
    expect(text).toContain("Not given");
  });

  it("cannot have mail headers injected through the address", () => {
    // A newline in the subject line is how a header injection starts.
    expect(() =>
      earlyAccessSchema.parse({
        ...VALID,
        email: "sam@harborandvine.com\nBcc: everyone@example.com",
      }),
    ).toThrow();
  });

  it("keeps the subject on one line whatever the input", () => {
    const { subject } = compose(VALID);
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
