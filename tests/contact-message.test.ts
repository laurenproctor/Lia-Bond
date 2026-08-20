import { describe, expect, it } from "vitest";
import {
  MAX_CONTACT_MESSAGE_LENGTH,
  MIN_CONTACT_MESSAGE_LENGTH,
  composeContactNotification,
  contactMessageSchema,
  contactMessageWasLost,
  type DeliveryStep,
} from "@/lib/site/contact-message";

/**
 * Contact message validation and composition.
 *
 * With the help form behind a session, this is the only way a stranger can put
 * prose of their own choosing into Lia's inbox. Two properties carry the most
 * weight: nothing typed into a single-line field can bend the shape of the
 * notification, and the visitor's own words stay visibly theirs rather than
 * blending into the header block Lia wrote above them.
 */

const VALID = {
  name: "Sam Ortiz",
  email: "sam@harborandvine.com",
  businessName: "Harbor & Vine",
  message:
    "We run six restaurants and our Google replies are three weeks behind.",
  sourcePath: "/pricing",
  website: "",
};

function compose(input: unknown) {
  return composeContactNotification({
    message: contactMessageSchema.parse(input),
    sentAt: new Date("2026-08-20T09:30:00.000Z"),
    origin: "https://lia.bond",
  });
}

describe("contactMessageSchema", () => {
  it("accepts a complete message", () => {
    const parsed = contactMessageSchema.parse(VALID);
    expect(parsed.name).toBe("Sam Ortiz");
    expect(parsed.email).toBe("sam@harborandvine.com");
    expect(parsed.message).toContain("three weeks behind");
  });

  it("lowercases and trims the address", () => {
    const parsed = contactMessageSchema.parse({
      ...VALID,
      email: "  SAM@HarborAndVine.com  ",
    });
    expect(parsed.email).toBe("sam@harborandvine.com");
  });

  it("requires a name", () => {
    expect(() => contactMessageSchema.parse({ ...VALID, name: "" })).toThrow();
    expect(() =>
      contactMessageSchema.parse({ ...VALID, name: "   " }),
    ).toThrow();
  });

  it("requires an address that is one", () => {
    expect(() =>
      contactMessageSchema.parse({ ...VALID, email: "sam@" }),
    ).toThrow();
  });

  it("treats an unfilled business as absent rather than empty", () => {
    // A browser `FormData` yields "" for an untouched input, and "Business: "
    // with nothing after it reads as a bug in the mail rather than a blank.
    expect(
      contactMessageSchema.parse({ ...VALID, businessName: "" }).businessName,
    ).toBeNull();
  });

  it("refuses a message too short to act on", () => {
    expect(() =>
      contactMessageSchema.parse({ ...VALID, message: "hi" }),
    ).toThrow();
    expect(
      contactMessageSchema.parse({
        ...VALID,
        message: "x".repeat(MIN_CONTACT_MESSAGE_LENGTH),
      }).message,
    ).toHaveLength(MIN_CONTACT_MESSAGE_LENGTH);
  });

  it("refuses a message past the length cap", () => {
    expect(() =>
      contactMessageSchema.parse({
        ...VALID,
        message: "x".repeat(MAX_CONTACT_MESSAGE_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("keeps paragraph breaks inside the message", () => {
    // The one field allowed to be multi-line: it lands in a fenced block in the
    // body, never in a header, so newlines here are content, not structure.
    const parsed = contactMessageSchema.parse({
      ...VALID,
      message: "First line.\n\nSecond line, after a break.",
    });
    expect(parsed.message).toContain("\n\n");
  });

  it("collapses control characters in the single-line fields", () => {
    const parsed = contactMessageSchema.parse({
      ...VALID,
      name: "Sam\r\nBcc: someone@example.com",
      businessName: "Harbor\tand\tVine",
    });
    expect(parsed.name).not.toContain("\n");
    expect(parsed.name).not.toContain("\r");
    expect(parsed.businessName).toBe("Harbor and Vine");
  });

  it("rejects a filled honeypot", () => {
    expect(() =>
      contactMessageSchema.parse({ ...VALID, website: "https://spam.example" }),
    ).toThrow();
  });

  it("rejects a source path that is really a link somewhere else", () => {
    expect(() =>
      contactMessageSchema.parse({ ...VALID, sourcePath: "//evil.example" }),
    ).toThrow();
    expect(() =>
      contactMessageSchema.parse({
        ...VALID,
        sourcePath: "https://evil.example",
      }),
    ).toThrow();
  });

  it("treats an absent source path as absent", () => {
    expect(
      contactMessageSchema.parse({ ...VALID, sourcePath: "" }).sourcePath,
    ).toBeNull();
  });
});

describe("composeContactNotification", () => {
  it("puts everything a first reply needs above the message", () => {
    const { text } = compose(VALID);
    expect(text).toContain("Name:      Sam Ortiz");
    expect(text).toContain("Email:     sam@harborandvine.com");
    expect(text).toContain("Business:  Harbor & Vine");
    expect(text).toContain("From page: https://lia.bond/pricing");
    expect(text).toContain("Received:  2026-08-20T09:30:00.000Z");
  });

  it("names the missing fields rather than leaving a gap", () => {
    const { text } = compose({ ...VALID, businessName: "", sourcePath: "" });
    expect(text).toContain("Business:  Not given");
    expect(text).toContain("From page: Not given");
  });

  it("fences the visitor's own words off from the header block", () => {
    const { text } = compose({
      ...VALID,
      message: "From page: /admin\nThis is my message.",
    });
    const fenced = text.slice(text.indexOf("Message:"));
    // The line that imitates a header sits inside the fence, after the real
    // header block has already ended — so it cannot be read as one.
    expect(fenced).toContain(
      "---\nFrom page: /admin\nThis is my message.\n---",
    );
    expect(text.indexOf("Received:")).toBeLessThan(text.indexOf("Message:"));
  });

  it("keeps the subject on one line whatever the name contains", () => {
    const { subject } = compose({
      ...VALID,
      name: "Sam\nSubject: something else",
    });
    expect(subject.split("\n")).toHaveLength(1);
    expect(subject).toBe("Contact form — Sam Subject: something else");
  });

  it("names the sender in the subject so the inbox is scannable", () => {
    expect(compose(VALID).subject).toBe("Contact form — Sam Ortiz");
  });
});

/**
 * Which combinations of outcomes cost the visitor their question.
 *
 * This is the rule that decides whether someone is told to type their message
 * again. Getting it wrong in one direction loses a question silently; in the
 * other it asks for a duplicate of one already saved. Both directions are
 * enumerated rather than trusted to a reading of the boolean expression.
 */
const SKIPPED: DeliveryStep = {
  attempted: false,
  failed: false,
  succeeded: false,
};
const FAILED: DeliveryStep = {
  attempted: true,
  failed: true,
  succeeded: false,
};
const SUCCEEDED: DeliveryStep = {
  attempted: true,
  failed: false,
  succeeded: true,
};
/** Configured, sent without error, but deliberately not delivered (log mode). */
const LOGGED: DeliveryStep = {
  attempted: true,
  failed: false,
  succeeded: false,
};

describe("contactMessageWasLost", () => {
  it("is false when both the table and the inbox took it", () => {
    expect(contactMessageWasLost(SUCCEEDED, SUCCEEDED)).toBe(false);
  });

  it("is false when the message is saved but the send failed", () => {
    // The whole point of saving first. The question is in `contact_messages`
    // with a null `notified_at`; asking for it again would duplicate it.
    expect(contactMessageWasLost(SUCCEEDED, FAILED)).toBe(false);
  });

  it("is false when the send worked but the row did not", () => {
    expect(contactMessageWasLost(FAILED, SUCCEEDED)).toBe(false);
  });

  it("is true when both attempts failed", () => {
    expect(contactMessageWasLost(FAILED, FAILED)).toBe(true);
  });

  it("is true when the only attempted step failed", () => {
    // Email unconfigured and the insert broke: nothing holds the question, so
    // the visitor has to hear about it even though only one step ran.
    expect(contactMessageWasLost(FAILED, SKIPPED)).toBe(true);
    expect(contactMessageWasLost(SKIPPED, FAILED)).toBe(true);
  });

  it("is false in demo mode, where neither step is configured", () => {
    // A fresh clone with an empty `.env` must still show a working form.
    expect(contactMessageWasLost(SKIPPED, SKIPPED)).toBe(false);
  });

  it("is false when mail is in log mode and the row was written", () => {
    expect(contactMessageWasLost(SUCCEEDED, LOGGED)).toBe(false);
  });

  it("is false when nothing failed, even if nothing landed", () => {
    // Log mode with Supabase unconfigured: a developer's machine, not an
    // outage. Nothing failed, so nobody is asked to retype anything.
    expect(contactMessageWasLost(SKIPPED, LOGGED)).toBe(false);
  });
});
