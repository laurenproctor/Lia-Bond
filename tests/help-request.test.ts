import { describe, expect, it } from "vitest";
import {
  composeHelpRequest,
  helpRequestSchema,
  parseAddressList,
  MAX_CC_RECIPIENTS,
  MAX_HELP_MESSAGE_LENGTH,
} from "@/lib/support/help-request";

/**
 * Help request validation and composition.
 *
 * The composer is pure, so the whole message can be asserted without a mail
 * provider. The property that matters most is the last test in the file: the
 * body reports the signed-in account, not the address typed into the form.
 */

const VALID = {
  topic: "bug",
  replyTo: "kate@bondgroup.com",
  cc: "",
  message: "The Google sync has been stuck on 'running' since this morning.",
};

const SENDER = {
  fullName: "Kate Nguyen",
  email: "kate@bondgroup.com",
  roleLabel: "Owner",
};

const ORGANIZATION = { name: "Bond Restaurant Group", slug: "bond-restaurant-group" };

function compose(
  input: unknown,
  demoMode = false,
  attachments: Array<{ name: string; type: string; size: number }> = [],
) {
  return composeHelpRequest({
    request: helpRequestSchema.parse(input),
    sender: SENDER,
    organization: ORGANIZATION,
    origin: "https://app.lia.test",
    demoMode,
    attachments,
    sentAt: new Date("2026-08-04T09:30:00.000Z"),
  });
}

describe("parseAddressList", () => {
  it("splits on the separators people actually type", () => {
    expect(parseAddressList("a@x.com, b@x.com; c@x.com  d@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  it("returns nothing for an empty field", () => {
    expect(parseAddressList("   ")).toEqual([]);
  });
});

describe("helpRequestSchema", () => {
  it("accepts a well-formed request", () => {
    const parsed = helpRequestSchema.parse(VALID);
    expect(parsed.topic).toBe("bug");
    expect(parsed.cc).toEqual([]);
  });

  it("trims the message", () => {
    const parsed = helpRequestSchema.parse({
      ...VALID,
      message: `  ${VALID.message}  `,
    });
    expect(parsed.message).toBe(VALID.message);
  });

  it("rejects an unknown topic", () => {
    expect(() => helpRequestSchema.parse({ ...VALID, topic: "urgent" })).toThrow();
  });

  it("rejects an unselected topic, in the wording the form shows", () => {
    // The picker opens on no topic, so both of these reach the action when
    // somebody submits without choosing.
    for (const topic of ["", undefined]) {
      expect(() => helpRequestSchema.parse({ ...VALID, topic })).toThrow(
        /Choose the topic that fits best/,
      );
    }
  });

  it("rejects a message with nothing in it to act on", () => {
    expect(() => helpRequestSchema.parse({ ...VALID, message: "help" })).toThrow();
  });

  it("rejects a message over the length cap", () => {
    expect(() =>
      helpRequestSchema.parse({
        ...VALID,
        message: "a".repeat(MAX_HELP_MESSAGE_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("parses a copy list into addresses", () => {
    const parsed = helpRequestSchema.parse({
      ...VALID,
      cc: "ops@bondgroup.com, gm@bondgroup.com",
    });
    expect(parsed.cc).toEqual(["ops@bondgroup.com", "gm@bondgroup.com"]);
  });

  it("rejects a malformed copy address", () => {
    expect(() =>
      helpRequestSchema.parse({ ...VALID, cc: "ops@bondgroup.com, not-an-email" }),
    ).toThrow(/not a valid email address/);
  });

  it("caps how many people can be copied", () => {
    const tooMany = Array.from(
      { length: MAX_CC_RECIPIENTS + 1 },
      (_, index) => `person${index}@bondgroup.com`,
    ).join(", ");

    expect(() => helpRequestSchema.parse({ ...VALID, cc: tooMany })).toThrow(
      /up to 3 people/i,
    );
  });
});

describe("composeHelpRequest", () => {
  it("puts the topic and the organization in the subject", () => {
    expect(compose(VALID).subject).toBe("Lia help — Bug — Bond Restaurant Group");
  });

  it("carries the message body verbatim", () => {
    expect(compose(VALID).text).toContain(VALID.message);
  });

  it("names the organization, the role, and the deployment", () => {
    const { text } = compose(VALID);
    expect(text).toContain("Bond Restaurant Group (bond-restaurant-group)");
    expect(text).toContain("Owner");
    expect(text).toContain("https://app.lia.test");
    expect(text).toContain("2026-08-04T09:30:00.000Z");
  });

  it("lists copied addresses only when there are some", () => {
    expect(compose(VALID).text).not.toContain("Copied");
    expect(compose({ ...VALID, cc: "ops@bondgroup.com" }).text).toContain(
      "Copied",
    );
  });

  it("flags demo data, which is why a report often describes numbers nobody else sees", () => {
    expect(compose(VALID).text).not.toContain("Demo dataset");
    expect(compose(VALID, true).text).toContain("Demo dataset");
  });

  it("names attachments in the body, so a stripped one shows as a gap", () => {
    expect(compose(VALID).text).not.toContain("Attached");

    const { text } = compose(VALID, false, [
      { name: "screenshot.png", type: "image/png", size: 240 * 1024 },
      { name: "clip.mov", type: "video/quicktime", size: 3 * 1024 * 1024 },
    ]);

    expect(text).toContain("screenshot.png (240 KB)");
    expect(text).toContain("clip.mov (3 MB)");
  });

  it("reports the signed-in account even when the reply-to is somewhere else", () => {
    const { text } = compose({ ...VALID, replyTo: "shared-inbox@bondgroup.com" });

    // The form cannot make a message look like it came from someone else: the
    // typed address appears as a reply-to, and the session identity is stamped
    // alongside it.
    expect(text).toContain("Kate Nguyen <kate@bondgroup.com>");
    expect(text).toContain("shared-inbox@bondgroup.com");
  });
});
