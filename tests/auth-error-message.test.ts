import { describe, expect, it } from "vitest";
import {
  invitationSignUpErrorMessage,
  signUpErrorMessage,
  updatePasswordErrorMessage,
} from "@/lib/auth/auth-error";

/**
 * What a failed sign-up tells the person in front of it.
 *
 * Two properties are worth protecting, and they pull against each other. The
 * message has to name a next move — that is the whole reason the mapping
 * exists — while never confirming that an address is registered, because
 * sign-up is reachable without a session and would otherwise enumerate
 * customers for anyone with a list of addresses.
 */

/** Every code the sign-up table knows, so a regression cannot go unnoticed. */
const SIGN_UP_CODES = [
  "user_already_exists",
  "email_exists",
  "weak_password",
  "email_address_invalid",
  "email_address_not_authorized",
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "signup_disabled",
  "email_provider_disabled",
  "provider_disabled",
  "user_banned",
  "captcha_failed",
  "unexpected_failure",
  "validation_failed",
];

describe("sign-up", () => {
  it("says something different for every code it knows", () => {
    // A table that mapped two codes onto the same sentence would pass every
    // other test here while delivering exactly the generic message this
    // replaced.
    const messages = SIGN_UP_CODES.map((code) => signUpErrorMessage({ code }));
    const distinct = new Set(messages);

    // Two deliberate synonym pairs: `user_already_exists`/`email_exists`, and
    // `email_provider_disabled`/`provider_disabled`. `signup_disabled` is not
    // one of them — "new accounts are not being accepted" and "email sign-up is
    // switched off" are different states of the product. Nothing else collides.
    expect(distinct.size).toBe(SIGN_UP_CODES.length - 2);
  });

  it("never confirms that an address is registered", () => {
    const message = signUpErrorMessage({ code: "user_already_exists", status: 422 });

    // Conditional, not declarative. "You already have an account" would answer
    // the attacker's question as helpfully as the customer's.
    expect(message).toContain("If you already have an account");
    expect(message).not.toMatch(/already (has|exists|registered)/i);
  });

  it("still points a duplicate sign-up at the way out", () => {
    const message = signUpErrorMessage({ code: "email_exists" });

    expect(message).toMatch(/sign in/i);
    expect(message).toMatch(/reset your password/i);
  });

  it("blames the provider, not the password, for a server failure", () => {
    const message = signUpErrorMessage({
      code: "unexpected_failure",
      status: 500,
      // The provider's own words for a failing profile trigger. Publishing this
      // would describe our schema to whoever asked.
      message: "Database error saving new user",
    });

    expect(message).toMatch(/on our side/i);
    expect(message).not.toMatch(/database/i);
  });

  it("never repeats the provider's message", () => {
    // The provider's English is written for whoever integrated the API and
    // changes without notice.
    const provider = "Anonymous sign-ins are disabled";
    expect(signUpErrorMessage({ code: "signup_disabled", message: provider })).not.toContain(
      provider,
    );
    expect(signUpErrorMessage({ status: 400, message: provider })).not.toContain(provider);
  });

  it("falls back on the status when the code is unknown", () => {
    // Supabase adds codes; this file will not always be updated on the same
    // day. 429 and 5xx are the two shapes with a better answer than "try
    // again", so they are recognised without a code at all.
    expect(signUpErrorMessage({ code: "code_from_the_future", status: 429 })).toMatch(
      /wait a few minutes/i,
    );
    expect(signUpErrorMessage({ code: "code_from_the_future", status: 503 })).toMatch(
      /on our side/i,
    );
  });

  it("has a last resort that still says what to do", () => {
    const message = signUpErrorMessage({});

    // A route that exists, rather than a support mailbox that does not.
    expect(message).toMatch(/lia\.bond\/contact/);
  });
});

describe("sign-up from an invitation", () => {
  it("names the duplicate plainly", () => {
    // Nothing is enumerated here: the address is read off the invitation on the
    // server, and reaching this screen requires the token.
    const message = invitationSignUpErrorMessage({ code: "user_already_exists" });

    expect(message).toMatch(/you already have an account/i);
    expect(message).toMatch(/open this invitation link again/i);
  });

  it("sends the invitee back to acceptance, not to sign-up", () => {
    const message = invitationSignUpErrorMessage({ code: "email_exists" });

    expect(message).not.toMatch(/reset your password/i);
  });

  it("shares every other branch with sign-up", () => {
    for (const code of SIGN_UP_CODES) {
      if (code === "user_already_exists" || code === "email_exists") continue;
      expect(invitationSignUpErrorMessage({ code })).toBe(signUpErrorMessage({ code }));
    }
  });
});

describe("password change", () => {
  it("distinguishes a rejected password from an unchanged one", () => {
    expect(updatePasswordErrorMessage({ code: "weak_password" })).toMatch(/too easy to guess/i);
    expect(updatePasswordErrorMessage({ code: "same_password" })).toMatch(
      /already your password/i,
    );
  });

  it("keeps the expired-link advice as its default", () => {
    // The common cause of a failure here is a recovery link that has been used,
    // and that is what the fallback has to keep saying.
    expect(updatePasswordErrorMessage({ code: "something_else" })).toMatch(/new link/i);
  });

  it("recognises a rate limit by status alone", () => {
    expect(updatePasswordErrorMessage({ status: 429 })).toMatch(/wait a few minutes/i);
  });
});
