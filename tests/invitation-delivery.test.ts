import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataError } from "@/lib/data/errors";

/**
 * Invitation delivery.
 *
 * This module is a set of refusals, and the refusals are the point. D55 made an
 * invitation a copyable link because a send that is accepted by the provider and
 * read by nobody looks like a bug in Lia rather than a missing environment
 * variable. D191 adds email without reintroducing that failure, which rests on
 * three behaviours that reading the code cannot confirm:
 *
 * - no verified sender means no send attempt at all, and specifically no
 *   fallback to the support identity (Resend's shared domain, which delivers
 *   only to the account owner);
 * - log mode is never reported as a send; and
 * - a provider failure is reported, never thrown, because by the time this runs
 *   the invitation already exists and the inviter already holds the link.
 */

const { sendEmailMock, inviteFromAddressMock, resolveEmailModeMock } = vi.hoisted(
  () => ({
    sendEmailMock: vi.fn(),
    inviteFromAddressMock: vi.fn(),
    resolveEmailModeMock: vi.fn(),
  }),
);

vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock }));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  inviteFromAddress: inviteFromAddressMock,
  resolveEmailMode: resolveEmailModeMock,
}));

const { deliverInvitation } = await import("@/lib/email/invitation-delivery");

const INVITATION = {
  email: "sam@harborandvine.com",
  organizationName: "Harbor & Vine",
  inviterName: "Kate Alvarez",
  role: "viewer" as const,
  url: "https://lia.bond/invite/kZ9wQx",
  expiresAt: "2026-08-27T09:30:00.000Z",
};

beforeEach(() => {
  // `restoreMocks` in vitest.config.ts does not clear call history on mocks
  // created through `vi.hoisted`, and two of these assertions are about a call
  // never happening.
  vi.clearAllMocks();

  inviteFromAddressMock.mockReturnValue("Lia <invites@lia.bond>");
  resolveEmailModeMock.mockReturnValue("live");
  sendEmailMock.mockResolvedValue({ mode: "live", id: "msg_1" });
});

describe("deliverInvitation", () => {
  it("sends from the configured invitation sender", async () => {
    const status = await deliverInvitation(INVITATION);

    expect(status).toBe("sent");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const message = sendEmailMock.mock.calls[0]![0];
    expect(message.from).toBe("Lia <invites@lia.bond>");
    expect(message.to).toEqual(["sam@harborandvine.com"]);
    expect(message.subject).toContain("Harbor & Vine");
    expect(message.text).toContain("https://lia.bond/invite/kZ9wQx");
  });

  it("does not send at all when no invitation sender is configured", async () => {
    inviteFromAddressMock.mockReturnValue(null);

    const status = await deliverInvitation(INVITATION);

    // The whole of D55's protection: no attempt, so no send that the provider
    // accepts and nobody receives. A fallback to `supportFromAddress()` here
    // would report "sent" for a message delivered only to the account owner.
    expect(status).toBe("not_configured");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not send when the provider itself is unconfigured", async () => {
    resolveEmailModeMock.mockReturnValue("unconfigured");

    const status = await deliverInvitation(INVITATION);

    expect(status).toBe("not_configured");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("reports log mode as its own state rather than as a send", async () => {
    sendEmailMock.mockResolvedValue({ mode: "log", id: null });

    // Nothing was delivered, so nothing may say it was.
    expect(await deliverInvitation(INVITATION)).toBe("logged");
  });

  it("reports a refused send instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmailMock.mockRejectedValue(
      new DataError("unavailable", "The mail service rejected that message."),
    );

    // The invitation exists and the inviter holds the link by this point.
    // Throwing would show an error for an invitation that is perfectly valid.
    expect(await deliverInvitation(INVITATION)).toBe("failed");
  });

  it("keeps the provider's own wording out of the returned status", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmailMock.mockRejectedValue(new Error("smtp 550 <invites@lia.bond> not verified"));

    const status = await deliverInvitation(INVITATION);

    expect(status).toBe("failed");
    expect(status).not.toContain("550");
  });
});
