import type { ConnectorCapabilities, PlatformConnection } from "@/domain";
import { NO_CAPABILITIES } from "@/domain";
import type { RedditDeployment } from "@/lib/env";
import type { IntegrationCapability } from "@/integrations/connector";

/**
 * What the Reddit integration can actually do, right now.
 *
 * The honesty requirement in `CLAUDE.md` has its hardest form here. Google's
 * capabilities answer one question — is a connection live? News answers one —
 * is the provider configured? Reddit needs four to agree before it can claim
 * anything, and any one of them can be false while the other three look fine:
 *
 * 1. is the deployment configured (client, redirect, user agent, vault);
 * 2. did Reddit's agreement permit this feature;
 * 3. is an account connected for this organization;
 * 4. did the grant actually return the scope the feature needs.
 *
 * So capability is an **intersection**, computed from all four, and never
 * inferred from the platform's name or from a successful OAuth handshake. A
 * connected account with `read` but no `submit` is a monitoring integration,
 * not a publishing one, and it has to say so — the failure this guards against
 * is a Publish button that exists because Reddit-the-platform supports posting
 * rather than because this deployment may.
 */

/** The scopes each capability genuinely needs. */
export const REDDIT_SCOPE_IDENTITY = "identity";
export const REDDIT_SCOPE_READ = "read";
export const REDDIT_SCOPE_SUBMIT = "submit";
export const REDDIT_SCOPE_EDIT = "edit";
export const REDDIT_SCOPE_HISTORY = "history";

/**
 * Everything Lia asks for at its widest.
 *
 * `edit` is here for **retraction only**. Lia does not edit published text and
 * `canEditResponses` stays false regardless: changing words a person approved,
 * after they approved them, needs a revision-and-reapproval design that does
 * not exist. Holding the scope and not using it is the honest position —
 * requesting it later, at the moment a customer needs a bad reply removed,
 * would mean a reauthorization in the middle of an incident.
 */
export const REDDIT_REQUESTED_SCOPES = [
  REDDIT_SCOPE_IDENTITY,
  REDDIT_SCOPE_READ,
  REDDIT_SCOPE_SUBMIT,
  REDDIT_SCOPE_EDIT,
  REDDIT_SCOPE_HISTORY,
] as const;

/**
 * The states a Reddit capability can be in.
 *
 * Wider than `IntegrationCapabilityState`'s three, because the three collapse
 * distinctions that decide what a person should do next. "Not configured" and
 * "Reddit has not agreed to this" both render as a grey badge under the old
 * vocabulary, and the first is a ten-minute fix while the second is a
 * conversation that takes weeks.
 */
export type RedditCapabilityState =
  | "enabled"
  | "approval_missing"
  | "not_configured"
  | "disconnected"
  | "missing_scope"
  | "read_only"
  | "community_policy_required"
  | "unavailable";

export interface RedditCapability extends IntegrationCapability {
  /** The precise reason, for copy that has to explain rather than grey out. */
  redditState: RedditCapabilityState;
}

/**
 * What the signed agreement permits, as this module needs it.
 *
 * Structural rather than a direct dependency on `RedditDeployment`, so the
 * contract's terms can be read from configuration today and from a database
 * row later without changing this function's shape.
 */
export interface RedditContractTerms {
  /** Whether a model may be run over Reddit content at all. */
  readonly aiInferencePermitted: boolean;
  /** Whether the agreement covers submitting comments on a customer's behalf. */
  readonly commentSubmissionPermitted: boolean;
}

export interface RedditCapabilityInput {
  readonly connection: PlatformConnection | null;
  readonly deployment: RedditDeployment;
  readonly contract: RedditContractTerms;
  /** Scopes the grant actually returned — not the ones Lia asked for. */
  readonly grantedScopes: readonly string[];
  /**
   * Whether every community this organization monitors has a current
   * `allowed` posture. Absent when nothing has been monitored yet, which is
   * not the same as "no community objects".
   */
  readonly communityPostureSettled?: boolean;
}

/**
 * The connector capability flags, as an intersection of all four gates.
 *
 * `NO_CAPABILITIES` is the base rather than a hand-written all-false object,
 * so a capability added to `ConnectorCapabilities` later defaults to off here
 * instead of being silently absent.
 */
export function redditConnectorCapabilities(
  input: RedditCapabilityInput,
): ConnectorCapabilities {
  const { connection, deployment, contract, grantedScopes } = input;

  const deploymentLive = deployment.effectiveStage !== "off";
  const connected = connection?.status === "connected";
  const has = (scope: string) => grantedScopes.includes(scope);

  const canRead = deploymentLive && connected && has(REDDIT_SCOPE_READ);
  const canWrite =
    deploymentLive &&
    connected &&
    deployment.effectiveStage === "read_write" &&
    contract.commentSubmissionPermitted &&
    has(REDDIT_SCOPE_SUBMIT);

  return {
    ...NO_CAPABILITIES,
    canReadMentions: canRead,
    // Reddit returns the whole post and comment body, unlike the news tier
    // which truncates. Gated on `canRead` rather than stated unconditionally:
    // "we would get full text if we could read" is not a capability.
    canReadFullText: canRead,
    // Reddit has no push notification Lia subscribes to. Polling is the only
    // mechanism, at whatever cadence the agreement and the scheduler allow.
    supportsWebhooks: false,
    canPublishResponses: canWrite,
    // Permanently false in this design, and not an oversight. See
    // REDDIT_REQUESTED_SCOPES: the `edit` grant exists for retraction.
    canEditResponses: false,
    // Retraction needs the publish path to exist before it means anything —
    // there is nothing to delete until Lia has posted something. Turned on
    // with the publication lifecycle, not before.
    canDeleteResponses: false,
    // Never negotiable, on any rollout stage, under any agreement.
    requiresApproval: true,
    requiresPartnerAccess: true,
  };
}

/**
 * The per-capability cards the integrations screen renders.
 *
 * Each one names the *first* gate that is closed, in the order a person can
 * act on them: an approval that does not exist cannot be fixed by connecting
 * an account, so it is reported first even when the account is also missing.
 */
export function redditCapabilities(
  input: RedditCapabilityInput,
): RedditCapability[] {
  const { connection, deployment, contract, grantedScopes } = input;

  const connected = connection?.status === "connected";
  const has = (scope: string) => grantedScopes.includes(scope);

  /** The gates every capability shares, hardest-to-fix first. */
  function commonState(): RedditCapabilityState | null {
    if (deployment.blockers.includes("approval_not_recorded")) {
      return "approval_missing";
    }
    if (deployment.effectiveStage === "off") return "not_configured";
    if (!connected) return "disconnected";
    return null;
  }

  const base = commonState();
  const readState: RedditCapabilityState =
    base ?? (has(REDDIT_SCOPE_READ) ? "enabled" : "missing_scope");

  function writeState(): RedditCapabilityState {
    if (base) return base;
    if (!contract.commentSubmissionPermitted) return "approval_missing";
    if (deployment.effectiveStage !== "read_write") return "read_only";
    if (!has(REDDIT_SCOPE_SUBMIT)) return "missing_scope";
    if (input.communityPostureSettled === false) {
      return "community_policy_required";
    }
    return "enabled";
  }

  const publishState = writeState();

  return [
    {
      id: "post_discovery",
      label: "Post discovery",
      state: badge(readState),
      redditState: readState,
      detail: detailFor(
        readState,
        "Lia searches Reddit posts for each monitor's terms, optionally limited to the communities you name.",
        "search Reddit posts for your monitors' terms",
      ),
    },
    {
      id: "comment_monitoring",
      label: "Comment monitoring",
      state: badge(readState),
      redditState: readState,
      // The sentence this feature is most likely to be misread on, so the
      // limit is in the enabled copy rather than in a footnote below it.
      detail: detailFor(
        readState,
        "Lia re-reads the comments inside posts it has already matched. It does not search every Reddit comment — Reddit's search covers posts, so a brand mentioned only in a comment on an unmatched thread is not discovered.",
        "monitor comments inside the posts your monitors match",
      ),
    },
    {
      id: "thread_analysis",
      label: "Thread analysis",
      state: badge(
        base ?? (contract.aiInferencePermitted ? readState : "approval_missing"),
      ),
      redditState:
        base ?? (contract.aiInferencePermitted ? readState : "approval_missing"),
      detail: contract.aiInferencePermitted
        ? detailFor(
            readState,
            "Discovered posts and comments go through the same analysis, risk, and escalation path as every other mention.",
            "analyse Reddit discussion for sentiment, topics, and risk",
          )
        : "Reddit's agreement does not cover running a model over Reddit content on this deployment, so discussion is monitored and displayed but not analysed.",
    },
    {
      id: "reply_publishing",
      label: "Reply publishing",
      state: badge(publishState),
      redditState: publishState,
      detail: publishDetail(publishState),
    },
    {
      id: "reply_editing",
      label: "Reply editing",
      // Unqualified by any gate on purpose, exactly like Google's
      // `review_publishing`: no amount of connecting, approving, or granting
      // makes this available, because it is not built.
      state: "unavailable",
      redditState: "unavailable",
      detail:
        "Not available. Changing the words of a reply after somebody approved them needs a revision and a fresh approval, which is not built — so a published reply can be retracted, but not rewritten.",
    },
    {
      id: "automated_replies",
      label: "Automated replies",
      state: "unavailable",
      redditState: "unavailable",
      detail:
        "Not available, and not planned. Every Reddit reply needs a named approver and a person to publish it. No rule, schedule, or automation can post to Reddit.",
    },
  ];
}

/** Collapse the wider vocabulary onto the three states the shared badge knows. */
function badge(state: RedditCapabilityState): IntegrationCapability["state"] {
  if (state === "enabled") return "enabled";
  if (state === "unavailable") return "unavailable";
  return "not_configured";
}

function detailFor(
  state: RedditCapabilityState,
  enabled: string,
  verbPhrase: string,
): string {
  switch (state) {
    case "enabled":
      return enabled;
    case "approval_missing":
      return `Reddit has not granted this deployment access yet, so Lia cannot ${verbPhrase}. This is an agreement with Reddit, not a setting.`;
    case "not_configured":
      return `Reddit is not configured on this server, so Lia cannot ${verbPhrase}.`;
    case "disconnected":
      return `Connect a Reddit account to ${verbPhrase}.`;
    case "missing_scope":
      return `The connected Reddit account did not grant the permission Lia needs to ${verbPhrase}. Reauthorize and accept every requested permission.`;
    default:
      return `Not available on this deployment.`;
  }
}

function publishDetail(state: RedditCapabilityState): string {
  switch (state) {
    case "enabled":
      return "An approved reply can be published to Reddit by a person, under the account this organization connected. Lia never posts without a named approver, and never on a schedule.";
    case "read_only":
      return "This deployment is in read-only rollout. Lia monitors and drafts, and a person publishes the reply themselves through Reddit until direct publishing is turned on.";
    case "community_policy_required":
      return "Publishing is held until somebody records a decision about each community's rules. Many subreddits ban brand accounts outright, and a reply into one of those gets the customer's account banned — so Lia refuses until a person has read the rules and said yes.";
    case "approval_missing":
      return "Reddit's agreement with this deployment does not cover posting on a customer's behalf. Replies are prepared and approved in Lia, then posted by a person.";
    case "missing_scope":
      return "The connected Reddit account did not grant permission to post. Reauthorize and accept every requested permission.";
    case "disconnected":
      return "Connect a Reddit account to publish approved replies under it.";
    default:
      return "Not available on this deployment. Replies are prepared and approved in Lia, then posted by a person.";
  }
}
