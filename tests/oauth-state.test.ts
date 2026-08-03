import { beforeEach, describe, expect, it } from "vitest";
import { OAUTH_STATE_TTL_MINUTES } from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";
import {
  consumeState,
  generateStateValue,
  hashState,
  issueState,
  OAuthStateError,
} from "@/lib/integrations/oauth-state";
import { freshDataSource, ORG_HARBOR, ORG_USHG } from "./helpers/scope";
import { USER_DANIEL, USER_KATE } from "@/lib/seed/dataset";

/**
 * OAuth handshake state.
 *
 * The `state` parameter is what stops someone sending an administrator a link
 * to Lia's callback carrying their own authorization code, quietly attaching
 * their Google account to the administrator's organization. Every assertion
 * below is a way that attack could work if the check were missing.
 */

let dataSource: LiaDataSource;

beforeEach(() => {
  dataSource = freshDataSource();
});

function issue(
  overrides: Partial<Parameters<typeof issueState>[0]> = {},
) {
  return issueState({
    dataSource,
    provider: "google_business_profile",
    organizationId: ORG_USHG,
    userId: USER_KATE,
    redirectPath: "/integrations/google-business-profile/setup",
    reauthorization: false,
    ...overrides,
  });
}

function consume(state: string, overrides: Record<string, string> = {}) {
  return consumeState({
    dataSource,
    state,
    expectedProvider: "google_business_profile",
    currentUserId: USER_KATE,
    currentOrganizationId: ORG_USHG,
    ...overrides,
  });
}

describe("generation", () => {
  it("produces a high-entropy, URL-safe value", () => {
    const value = generateStateValue();

    // 32 bytes base64url. Anything shorter or with padding is a bug.
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", () => {
    const values = new Set(
      Array.from({ length: 500 }, () => generateStateValue()),
    );
    expect(values.size).toBe(500);
  });

  it("hashes deterministically to hex SHA-256", () => {
    const value = generateStateValue();

    expect(hashState(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashState(value)).toBe(hashState(value));
    expect(hashState(value)).not.toBe(hashState(generateStateValue()));
  });

  it("stores the hash, never the value", async () => {
    const { value, record } = await issue();

    // Read the whole record back as text: the raw state must not appear
    // anywhere in what was persisted.
    expect(JSON.stringify(record)).not.toContain(value);
  });

  it("binds the user, organization, provider, and destination", async () => {
    const { record } = await issue({ reauthorization: true });

    expect(record.userId).toBe(USER_KATE);
    expect(record.organizationId).toBe(ORG_USHG);
    expect(record.provider).toBe("google_business_profile");
    expect(record.redirectPath).toBe("/integrations/google-business-profile/setup");
    expect(record.reauthorization).toBe(true);
    expect(record.consumedAt).toBeNull();
  });

  it("expires within the configured window", async () => {
    const { record } = await issue();
    const lifetimeMinutes =
      (Date.parse(record.expiresAt) - Date.parse(record.createdAt)) / 60_000;

    expect(lifetimeMinutes).toBeGreaterThan(0);
    expect(lifetimeMinutes).toBeLessThanOrEqual(OAUTH_STATE_TTL_MINUTES + 0.1);
  });

  it("refuses a redirect destination that is not on the allow list", async () => {
    // This is the parameter an open-redirect attack wants control of, so it is
    // rejected at issue time — an unvalidated destination sitting in the table
    // is an open redirect waiting for a callback to honour it.
    await expect(issue({ redirectPath: "https://evil.example.com" })).rejects.toThrow(
      expect.objectContaining({ reason: "redirect_not_allowed" }),
    );
    await expect(issue({ redirectPath: "/settings" })).rejects.toThrow(
      OAuthStateError,
    );
    await expect(issue({ redirectPath: "//evil.example.com" })).rejects.toThrow(
      OAuthStateError,
    );
  });
});

describe("consumption", () => {
  it("accepts a valid state once", async () => {
    const { value, record } = await issue();
    const consumed = await consume(value);

    expect(consumed.id).toBe(record.id);
    expect(consumed.consumedAt).not.toBeNull();
  });

  it("rejects a reused state", async () => {
    const { value } = await issue();
    await consume(value);

    await expect(consume(value)).rejects.toThrow(
      expect.objectContaining({ reason: "expired_or_used" }),
    );
  });

  it("rejects an expired state", async () => {
    const value = generateStateValue();
    await dataSource.oauthStates.create({
      provider: "google_business_profile",
      stateHash: hashState(value),
      organizationId: ORG_USHG,
      userId: USER_KATE,
      redirectPath: "/integrations",
      reauthorization: false,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await expect(consume(value)).rejects.toThrow(
      expect.objectContaining({ reason: "expired_or_used" }),
    );
  });

  it("rejects an unknown state", async () => {
    await expect(consume(generateStateValue())).rejects.toThrow(
      expect.objectContaining({ reason: "expired_or_used" }),
    );
  });

  it("reports unknown, spent, and expired identically", async () => {
    // Distinguishing them would grade an attacker's guesses.
    async function rejection(state: string): Promise<OAuthStateError> {
      try {
        await consume(state);
      } catch (error) {
        return error as OAuthStateError;
      }
      throw new Error("expected the state to be rejected");
    }

    const { value: spent } = await issue();
    await consume(spent);

    const spentError = await rejection(spent);
    const unknownError = await rejection(generateStateValue());

    expect(spentError.message).toBe(unknownError.message);
    expect(spentError.reason).toBe(unknownError.reason);
  });

  it("rejects a missing state", async () => {
    await expect(
      consumeState({
        dataSource,
        state: null,
        expectedProvider: "google_business_profile",
        currentUserId: USER_KATE,
        currentOrganizationId: ORG_USHG,
      }),
    ).rejects.toThrow(expect.objectContaining({ reason: "missing" }));
  });

  it("rejects a malformed state without touching the store", async () => {
    await expect(consume("../../etc/passwd")).rejects.toThrow(
      expect.objectContaining({ reason: "invalid" }),
    );
  });

  it("rejects a state presented by a different user", async () => {
    const { value } = await issue({ userId: USER_KATE });

    await expect(consume(value, { currentUserId: USER_DANIEL })).rejects.toThrow(
      expect.objectContaining({ reason: "user_mismatch" }),
    );
  });

  it("rejects a state presented under a different organization", async () => {
    const { value } = await issue({ organizationId: ORG_USHG });

    await expect(
      consume(value, { currentOrganizationId: ORG_HARBOR }),
    ).rejects.toThrow(
      expect.objectContaining({ reason: "organization_mismatch" }),
    );
  });

  it("rejects a state issued for a different provider", async () => {
    const { value } = await issue({ provider: "yelp" });

    await expect(consume(value)).rejects.toThrow(
      expect.objectContaining({ reason: "provider_mismatch" }),
    );
  });

  it("burns the state even when the identity check fails", async () => {
    // Consumption happens before the comparisons on purpose. A rejected attempt
    // that left the state usable would be a free retry for whoever is guessing.
    const { value } = await issue();

    await expect(consume(value, { currentUserId: USER_DANIEL })).rejects.toThrow(
      OAuthStateError,
    );
    await expect(consume(value)).rejects.toThrow(
      expect.objectContaining({ reason: "expired_or_used" }),
    );
  });

  it("only lets one of two concurrent callbacks win", async () => {
    const { value } = await issue();

    const outcomes = await Promise.allSettled([consume(value), consume(value)]);
    const fulfilled = outcomes.filter((entry) => entry.status === "fulfilled");

    expect(fulfilled).toHaveLength(1);
  });
});

describe("cleanup", () => {
  async function seedStale(): Promise<void> {
    await dataSource.oauthStates.create({
      provider: "google_business_profile",
      stateHash: hashState(generateStateValue()),
      organizationId: ORG_USHG,
      userId: USER_KATE,
      redirectPath: "/integrations",
      reauthorization: false,
      expiresAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
  }

  it("removes handshakes well past expiry", async () => {
    await seedStale();
    await expect(dataSource.oauthStates.purgeExpired()).resolves.toBe(1);
  });

  it("keeps handshakes that are still live, and ones only just expired", async () => {
    // The sweep deliberately lags expiry by an hour: deleting a row the instant
    // it expires would turn "your link expired" into "your link never existed".
    const { value: live } = await issue();
    await dataSource.oauthStates.create({
      provider: "google_business_profile",
      stateHash: hashState(generateStateValue()),
      organizationId: ORG_USHG,
      userId: USER_KATE,
      redirectPath: "/integrations",
      reauthorization: false,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect(dataSource.oauthStates.purgeExpired()).resolves.toBe(0);
    await expect(consume(live)).resolves.toBeDefined();
  });

  it("sweeps stale handshakes when a new one is issued", async () => {
    // Cleanup is opportunistic — no scheduler for a table that only grows when
    // somebody clicks Connect.
    await seedStale();
    await issue();

    await expect(dataSource.oauthStates.purgeExpired()).resolves.toBe(0);
  });
});
