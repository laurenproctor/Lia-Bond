import { describe, expect, it } from "vitest";
import {
  composeInvitationEmail,
  invitationWasEmailed,
  type InvitationDeliveryStatus,
} from "@/lib/email/invitation-message";

/**
 * The invitation email.
 *
 * Two properties carry the weight. Nothing typed into an organization name or a
 * profile name can bend the shape of the message it lands in — both reach a
 * subject line, and a CR there is the opening move of a header injection. And
 * the message states the rule that actually governs acceptance (D56: the link
 * only works for the address it was issued to), because someone who forwards it
 * otherwise discovers that rule after a colleague has made an account.
 */

const VALID = {
  email: "sam@harborandvine.com",
  organizationName: "Harbor & Vine",
  inviterName: "Kate Alvarez",
  role: "communications_lead" as const,
  url: "https://lia.bond/invite/kZ9wQx",
  expiresAt: "2026-08-27T09:30:00.000Z",
};

describe("composeInvitationEmail", () => {
  it("names the inviter, the organization and the role", () => {
    const { subject, text } = composeInvitationEmail(VALID);

    expect(subject).toBe("Kate Alvarez invited you to Harbor & Vine on Lia");
    expect(text).toContain("Kate Alvarez invited you to join Harbor & Vine");
    // The label from `MEMBERSHIP_ROLE_LABELS`, not the raw enum value.
    expect(text).toContain("as communications lead");
    expect(text).not.toContain("communications_lead");
  });

  it("carries the link and the expiry", () => {
    const { text } = composeInvitationEmail(VALID);

    expect(text).toContain("https://lia.bond/invite/kZ9wQx");
    expect(text).toContain("Aug 27, 2026");
    expect(text).toContain("UTC");
    expect(text).toContain("can be used once");
  });

  it("states that the invitation is bound to the invited address", () => {
    const { text } = composeInvitationEmail(VALID);

    expect(text).toContain("Sign in with sam@harborandvine.com");
    expect(text).toContain("forwarding this message will not let someone else");
  });

  /* ---------------------------------------------------------------------- */
  /* Header injection                                                        */
  /* ---------------------------------------------------------------------- */

  it("keeps a newline in the organization name out of the subject", () => {
    const { subject } = composeInvitationEmail({
      ...VALID,
      organizationName: "Harbor\r\nBcc: everyone@example.com",
    });

    expect(subject).not.toContain("\r");
    expect(subject).not.toContain("\n");
    expect(subject).toContain("Harbor Bcc: everyone@example.com");
  });

  it("keeps a newline in the inviter name out of the subject", () => {
    const { subject } = composeInvitationEmail({
      ...VALID,
      inviterName: "Kate\nSubject: You have won",
    });

    expect(subject.split("\n")).toHaveLength(1);
  });

  it("bounds both names so neither can run away with the subject", () => {
    const { subject } = composeInvitationEmail({
      ...VALID,
      organizationName: "a".repeat(5000),
      inviterName: "b".repeat(5000),
    });

    // 160 each, plus the fixed wording around them.
    expect(subject.length).toBeLessThan(400);
  });

  it("falls back rather than rendering an empty name", () => {
    const { subject, text } = composeInvitationEmail({
      ...VALID,
      organizationName: "   ",
      inviterName: "\t\t",
    });

    expect(subject).toBe("Someone invited you to a team on Lia");
    expect(text).toContain("Someone invited you to join a team");
  });
});

describe("invitationWasEmailed", () => {
  it("is true only for a live send", () => {
    expect(invitationWasEmailed("sent")).toBe(true);
  });

  it.each<InvitationDeliveryStatus>(["logged", "not_configured", "failed"])(
    "is false for %s, so nothing claims a delivery that did not happen",
    (status) => {
      expect(invitationWasEmailed(status)).toBe(false);
    },
  );
});
