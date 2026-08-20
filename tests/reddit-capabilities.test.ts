import { describe, expect, it } from "vitest";
import type { PlatformConnection } from "@/domain";
import type { RedditDeployment } from "@/lib/env";
import {
  REDDIT_REQUESTED_SCOPES,
  redditCapabilities,
  redditConnectorCapabilities,
  type RedditCapabilityInput,
  type RedditCapabilityState,
} from "@/lib/reddit/capabilities";

/**
 * Reddit capability is an intersection of four independent gates, and the
 * failure this suite exists to stop is any one of them being inferred from
 * another: a Publish button that appears because Reddit-the-platform supports
 * posting, or because an OAuth handshake succeeded, rather than because this
 * deployment is actually permitted to post.
 */

const CONNECTED: PlatformConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  platform: "reddit",
  externalAccountId: "t2_abc",
  externalAccountName: "maison-laurent",
  status: "connected",
  capabilities: {
    canReadMentions: true,
    canReadFullText: true,
    supportsWebhooks: false,
    canPublishResponses: false,
    canEditResponses: false,
    canDeleteResponses: false,
    requiresApproval: true,
    requiresPartnerAccess: true,
    canMatchLocations: false,
    supportsAssistedPosting: false,
  },
  tokenExpiresAt: null,
  lastSyncedAt: null,
  grantedScopes: [...REDDIT_REQUESTED_SCOPES],
  providerMetadata: {},
  lastHealthCheckAt: null,
  lastHealthStatus: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  connectedByUserId: null,
  connectedAt: "2026-08-14T10:00:00.000Z",
  disconnectedAt: null,
  createdAt: "2026-08-14T10:00:00.000Z",
  updatedAt: "2026-08-14T10:00:00.000Z",
};

const READ_WRITE: RedditDeployment = {
  requestedStage: "read_write",
  effectiveStage: "read_write",
  mode: "live",
  blockers: [],
  aiInferencePermitted: true,
  approvalRef: "2026-08-14:reddit-data-api-commercial",
};

const FULL_CONTRACT = {
  aiInferencePermitted: true,
  commentSubmissionPermitted: true,
};

function input(overrides: Partial<RedditCapabilityInput> = {}): RedditCapabilityInput {
  return {
    connection: CONNECTED,
    deployment: READ_WRITE,
    contract: FULL_CONTRACT,
    grantedScopes: [...REDDIT_REQUESTED_SCOPES],
    ...overrides,
  };
}

function stateOf(
  capabilities: ReturnType<typeof redditCapabilities>,
  id: string,
): RedditCapabilityState {
  const found = capabilities.find((capability) => capability.id === id);
  if (!found) throw new Error(`No capability ${id}`);
  return found.redditState;
}

describe("redditConnectorCapabilities — the intersection", () => {
  it("turns everything on only when all four gates agree", () => {
    expect(redditConnectorCapabilities(input())).toMatchObject({
      canReadMentions: true,
      canReadFullText: true,
      canPublishResponses: true,
    });
  });

  it("refuses publishing when the rollout is read-only, however complete the grant", () => {
    const readOnly = redditConnectorCapabilities(
      input({
        deployment: { ...READ_WRITE, requestedStage: "read_only", effectiveStage: "read_only" },
      }),
    );
    expect(readOnly.canReadMentions).toBe(true);
    expect(readOnly.canPublishResponses).toBe(false);
  });

  it("refuses publishing when the agreement does not cover submission", () => {
    // The gate that has nothing to do with the credential: Reddit can grant a
    // working `submit` scope while the contract covers monitoring only.
    const capabilities = redditConnectorCapabilities(
      input({ contract: { ...FULL_CONTRACT, commentSubmissionPermitted: false } }),
    );
    expect(capabilities.canPublishResponses).toBe(false);
    expect(capabilities.canReadMentions).toBe(true);
  });

  it("refuses publishing when the grant withheld submit", () => {
    const capabilities = redditConnectorCapabilities(
      input({ grantedScopes: ["identity", "read"] }),
    );
    expect(capabilities.canPublishResponses).toBe(false);
    expect(capabilities.canReadMentions).toBe(true);
  });

  it("refuses reading when the grant withheld read, connected or not", () => {
    const capabilities = redditConnectorCapabilities(
      input({ grantedScopes: ["identity"] }),
    );
    expect(capabilities.canReadMentions).toBe(false);
    expect(capabilities.canReadFullText).toBe(false);
  });

  it("refuses everything when the deployment is off", () => {
    const capabilities = redditConnectorCapabilities(
      input({
        deployment: {
          requestedStage: "read_write",
          effectiveStage: "off",
          mode: "live",
          blockers: ["approval_not_recorded"],
          aiInferencePermitted: false,
          approvalRef: null,
        },
      }),
    );
    expect(capabilities.canReadMentions).toBe(false);
    expect(capabilities.canPublishResponses).toBe(false);
  });

  it("refuses everything when no account is connected", () => {
    const capabilities = redditConnectorCapabilities(input({ connection: null }));
    expect(capabilities.canReadMentions).toBe(false);
    expect(capabilities.canPublishResponses).toBe(false);
  });

  it("refuses everything for a disconnected connection row", () => {
    // The row survives a disconnect so history is not erased. It must not read
    // as a live connection.
    const capabilities = redditConnectorCapabilities(
      input({ connection: { ...CONNECTED, status: "disconnected" } }),
    );
    expect(capabilities.canReadMentions).toBe(false);
  });

  it("never turns off approval or partner access, on any configuration", () => {
    for (const overrides of [
      {},
      { connection: null },
      { grantedScopes: [] },
      { contract: { aiInferencePermitted: false, commentSubmissionPermitted: false } },
    ]) {
      const capabilities = redditConnectorCapabilities(input(overrides));
      expect(capabilities.requiresApproval).toBe(true);
      expect(capabilities.requiresPartnerAccess).toBe(true);
    }
  });

  it("keeps editing off even when the grant includes edit", () => {
    // `edit` is requested for retraction. Rewriting words a person approved,
    // after they approved them, needs a design that does not exist.
    expect(redditConnectorCapabilities(input()).canEditResponses).toBe(false);
  });

  it("keeps deletion off until the publication lifecycle exists", () => {
    // There is nothing to retract until Lia has published something. Turned on
    // by the publication task, not before.
    expect(redditConnectorCapabilities(input()).canDeleteResponses).toBe(false);
  });

  it("never claims webhooks — polling is the only mechanism", () => {
    expect(redditConnectorCapabilities(input()).supportsWebhooks).toBe(false);
  });
});

describe("redditCapabilities — what a person is told", () => {
  it("reports a missing approval ahead of a missing account", () => {
    // Both are wrong, but only one is fixable this afternoon. Telling somebody
    // to connect an account when the agreement does not exist sends them down
    // a path that ends in a 403 they cannot explain.
    const capabilities = redditCapabilities(
      input({
        connection: null,
        deployment: {
          requestedStage: "read_write",
          effectiveStage: "off",
          mode: "live",
          blockers: ["approval_not_recorded"],
          aiInferencePermitted: false,
          approvalRef: null,
        },
      }),
    );
    expect(stateOf(capabilities, "post_discovery")).toBe("approval_missing");
  });

  it("distinguishes an unconfigured deployment from an unapproved one", () => {
    const capabilities = redditCapabilities(
      input({
        deployment: {
          requestedStage: "read_only",
          effectiveStage: "off",
          mode: "unconfigured",
          blockers: ["deployment_not_configured"],
          aiInferencePermitted: false,
          approvalRef: null,
        },
      }),
    );
    expect(stateOf(capabilities, "post_discovery")).toBe("not_configured");
  });

  it("names read_only rollout as its own state, not a generic refusal", () => {
    const capabilities = redditCapabilities(
      input({
        deployment: { ...READ_WRITE, requestedStage: "read_only", effectiveStage: "read_only" },
      }),
    );
    expect(stateOf(capabilities, "post_discovery")).toBe("enabled");
    expect(stateOf(capabilities, "reply_publishing")).toBe("read_only");
  });

  it("holds publishing when a community posture is unsettled", () => {
    const capabilities = redditCapabilities(input({ communityPostureSettled: false }));
    expect(stateOf(capabilities, "reply_publishing")).toBe(
      "community_policy_required",
    );
    // Reading is unaffected: a community nobody has ruled on is still one Lia
    // may watch.
    expect(stateOf(capabilities, "post_discovery")).toBe("enabled");
  });

  it("names a missing scope rather than reporting the feature as unbuilt", () => {
    const capabilities = redditCapabilities(
      input({ grantedScopes: ["identity", "read"] }),
    );
    expect(stateOf(capabilities, "reply_publishing")).toBe("missing_scope");
  });

  it("separates analysis from reading when inference is not permitted", () => {
    // An agreement can allow display to a customer's team and withhold AI
    // inference. Monitoring must still ship under those terms.
    const capabilities = redditCapabilities(
      input({ contract: { ...FULL_CONTRACT, aiInferencePermitted: false } }),
    );
    expect(stateOf(capabilities, "post_discovery")).toBe("enabled");
    expect(stateOf(capabilities, "thread_analysis")).toBe("approval_missing");
  });

  it("states the comment-search limitation in the enabled copy", () => {
    // The claim most likely to be overstated, so it lives in the sentence a
    // person reads when the feature is working — not in a footnote below it.
    const capabilities = redditCapabilities(input());
    const commentMonitoring = capabilities.find(
      (capability) => capability.id === "comment_monitoring",
    );
    expect(commentMonitoring?.detail).toMatch(
      /does not search every Reddit comment/i,
    );
  });

  it("reports editing and automation as unavailable under every configuration", () => {
    for (const overrides of [{}, { connection: null }, { grantedScopes: [] }]) {
      const capabilities = redditCapabilities(input(overrides));
      expect(stateOf(capabilities, "reply_editing")).toBe("unavailable");
      expect(stateOf(capabilities, "automated_replies")).toBe("unavailable");
    }
  });

  it("never renders an enabled badge for a capability that is not enabled", () => {
    // The badge vocabulary is narrower than the state vocabulary, and this is
    // the collapse that must not lie.
    const capabilities = redditCapabilities(
      input({ deployment: { ...READ_WRITE, effectiveStage: "read_only" } }),
    );
    for (const capability of capabilities) {
      if (capability.state === "enabled") {
        expect(capability.redditState).toBe("enabled");
      }
    }
  });

  it("gives every capability a detail sentence, in every state", () => {
    for (const overrides of [
      {},
      { connection: null },
      { grantedScopes: [] },
      { communityPostureSettled: false },
      { contract: { aiInferencePermitted: false, commentSubmissionPermitted: false } },
    ]) {
      for (const capability of redditCapabilities(input(overrides))) {
        expect(capability.detail.trim().length).toBeGreaterThan(20);
      }
    }
  });
});
