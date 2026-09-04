import type { ConnectorCapabilities } from "@/domain";
import { NO_CAPABILITIES } from "@/domain";

/**
 * What Yelp Assisted can honestly do.
 *
 * Declared once, in the provider layer, so the live client and the mock cannot
 * disagree about it — the same arrangement `GNEWS_CAPABILITIES` uses. The
 * per-capability cards the integrations screen renders live separately in
 * `src/lib/yelp/capabilities.ts`: this answers "what may Lia do with a Yelp
 * mention once it has one", and that one answers "which parts of this
 * integration are built and configured for this organization". Conflating them
 * is what would let a successful listing connection imply that reviews are
 * arriving.
 *
 * Spread from `NO_CAPABILITIES` rather than written out in full, so a
 * capability added to `ConnectorCapabilities` later defaults to off here rather
 * than being silently absent.
 *
 * Every value below is a fact about the Places API plan, not a rollout stage.
 * None of them becomes true because a listing was connected — which is the
 * whole distinction this feature is built around, and the reason the flags are
 * constant rather than computed from a connection the way Reddit's are.
 */
export const YELP_ASSISTED_CAPABILITIES: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  // Lia never receives a Yelp review. Every Yelp review in Lia was typed in by
  // a customer, and `mentions.capture_method` records that on every row.
  canReadMentions: false,
  // Follows from the line above rather than being a separate limitation: there
  // is no review text to be full or partial. Stated explicitly anyway, because
  // "we would get the full text if we could read" is not a capability.
  canReadFullText: false,
  // Yelp offers review webhooks to Partner API licensees. Lia is not one, so
  // the only mechanism is polling the listing's counters.
  supportsWebhooks: false,
  // Responding to reviews is a Partner API capability. Lia does not hold it,
  // and no amount of connecting a listing changes that. Probably permanent
  // rather than pending: Yelp's policy bars software providers from responding
  // on a client's behalf, so this is barred by the terms and not only by the
  // licence. docs/integrations/yelp-assisted.md §1 quotes the sentence.
  canPublishResponses: false,
  canEditResponses: false,
  canDeleteResponses: false,
  // Never negotiable. A Yelp reply is public and permanent enough to matter.
  requiresApproval: true,
  // True, and the honest word for what gates full review text: a licence, not a
  // setting and not a scope. Note it is NOT the only thing gating publishing —
  // see `canPublishResponses` above. A licence would not lift that one.
  requiresPartnerAccess: true,
  // The one thing the Places plan genuinely does well.
  canMatchLocations: true,
  // Copy the approved reply, open the right Yelp page, confirm afterwards.
  supportsAssistedPosting: true,
};
