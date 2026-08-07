import type { Location, MembershipRole } from "@/domain";

/**
 * The permission matrix.
 *
 * One table, one function. Role checks are never written inline in a component
 * or an action — they go through `can()` so that changing who may approve a
 * response is a one-line edit here rather than a search across the codebase.
 *
 * This module is pure: no I/O, no framework imports, fully unit-testable.
 */

export const PERMISSIONS = [
  "mention.update_status",
  "mention.analyze",
  "response.assign",
  "response.decide",
  "response.edit",
  "escalation.assign",
  "escalation.update_status",
  "automation_rule.toggle",
  "brand_voice.update",
  "location.update_manager",
  "organization.manage_members",
  "onboarding.manage",
  "integration.connect",
  "integration.reauthorize",
  "integration.manage_profiles",
  "integration.test_connection",
  "integration.sync_reviews",
  "integration.disconnect",
  "monitoring.manage_queries",
  "monitoring.poll_now",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Which roles hold which permission.
 *
 * Reading the columns: analysts and viewers appear nowhere — they are strictly
 * read-only. Location managers appear only where a scoping check can constrain
 * them to their own locations (see `canForLocation`).
 */
const PERMISSION_MATRIX: Record<Permission, readonly MembershipRole[]> = {
  "mention.update_status": [
    "owner",
    "admin",
    "communications_lead",
    "location_manager",
  ],
  // Running an analysis spends money on a model and fills the queue these
  // three roles are accountable for, so they can refresh their own inbox
  // rather than filing a ticket. Location managers are absent for the same
  // reason they are absent from integration work: a run walks the whole
  // organization's backlog, so there is no location to scope them to.
  "mention.analyze": ["owner", "admin", "communications_lead"],
  "response.assign": [
    "owner",
    "admin",
    "communications_lead",
    "location_manager",
  ],
  // Deliberately narrow: writing a draft and approving it are different jobs.
  "response.decide": ["owner", "admin", "approver"],
  // Writing response text and signing it off stay separate jobs, but the
  // roles that own the text — and the approver amending as part of a
  // decision (D107) — must not need a ticket to fix a typo. Location
  // managers are absent because drafts carry no location to scope them to.
  "response.edit": ["owner", "admin", "communications_lead", "approver"],
  "escalation.assign": ["owner", "admin", "communications_lead"],
  "escalation.update_status": [
    "owner",
    "admin",
    "communications_lead",
    "location_manager",
  ],
  // Automation changes what the product does without a human, so it stays with
  // owners, admins, and the communications lead who owns response policy.
  "automation_rule.toggle": ["owner", "admin", "communications_lead"],
  // Brand voice sets how every generated response sounds, so it belongs with
  // automation rather than with administration: both change what the product
  // says without a person in the loop. The communications lead is the role
  // accountable for response policy — locking them out would mean filing a
  // ticket to change the tone of their own team's writing.
  //
  // Approvers are absent deliberately. Deciding one response and setting the
  // policy for all of them are different jobs, and conflating them was the
  // reason this permission is new rather than a reuse of `response.decide`.
  "brand_voice.update": ["owner", "admin", "communications_lead"],
  "location.update_manager": ["owner", "admin"],
  "organization.manage_members": ["owner", "admin"],
  // First-run setup. Narrower than the write gate the rest of the product
  // uses, because finishing onboarding decides what *everybody* in the
  // organization sees on sign-in — and because its five steps are each already
  // an owner-or-admin decision on their own (renaming the organization,
  // granting Google standing access, deciding which listing is which
  // restaurant, setting the voice every response will carry, issuing
  // invitations). A communications lead who could mark setup complete would be
  // pushing the whole organization past steps they had no authority to perform.
  //
  // Restated in `organization_onboarding`'s RLS policies, not merely trusted
  // here: a check in application code protects the one path that runs it.
  "onboarding.manage": ["owner", "admin"],

  // Integrations.
  //
  // There is no `integration.view` permission, deliberately. This table gates
  // writes; reading an integration is already governed by holding an active
  // membership, and by the row-level security select policies underneath. A
  // permission every role held would add a name without adding a check, and it
  // would break the invariant that analysts and viewers appear nowhere here.
  //
  // Connecting and disconnecting stay with owners and admins: an OAuth grant
  // hands Lia standing authority over a customer's Google listings, and
  // withdrawing it silently stops every downstream feature. Neither is a
  // decision to spread across the org chart.
  //
  // Mapping profiles to locations sits one notch lower. It is consequential but
  // reversible, it is the day-to-day work of running the integration, and it is
  // exactly what a communications lead is accountable for. Location managers are
  // absent on purpose: a mapping is an organization-wide decision about which
  // Google listing represents which restaurant, so there is no location to scope
  // them to and granting it would widen their authority beyond their own sites.
  "integration.connect": ["owner", "admin"],
  "integration.reauthorize": ["owner", "admin"],
  "integration.manage_profiles": ["owner", "admin", "communications_lead"],
  // Read-only against the provider and changes no Lia state beyond a health
  // record, so the people who watch the queues can check it themselves rather
  // than filing a ticket to find out whether Google is up.
  "integration.test_connection": ["owner", "admin", "communications_lead"],
  // Importing reviews is read-only against Google and adds records to the
  // queue the communications lead already owns, so they can refresh their own
  // inbox rather than asking an admin to press a button for them. Location
  // managers are absent for the same reason they are absent from mapping: a
  // sync runs against a shared credential for a whole connected location, and
  // there is no per-location scoping to limit them to.
  "integration.sync_reviews": ["owner", "admin", "communications_lead"],
  "integration.disconnect": ["owner", "admin"],

  // News monitoring.
  //
  // Deciding what Lia watches is the same class of decision as deciding which
  // locations it syncs, which is why these match `integration.manage_profiles`
  // and `integration.sync_reviews` exactly. There is no read permission, per
  // D19 — reading a query is governed by membership, not this table.
  "monitoring.manage_queries": ["owner", "admin", "communications_lead"],
  "monitoring.poll_now": ["owner", "admin", "communications_lead"],
};

export function can(role: MembershipRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[permission].includes(role);
}

/** Every permission a role holds. Useful for exposing capabilities to the UI. */
export function permissionsFor(role: MembershipRole): Permission[] {
  return PERMISSIONS.filter((permission) => can(role, permission));
}

/**
 * Roles whose authority is limited to the locations they manage.
 *
 * A location manager may act on records for their own restaurants and nothing
 * else. Everyone else with the permission acts organization-wide.
 */
const LOCATION_SCOPED_ROLES: readonly MembershipRole[] = ["location_manager"];

export function isLocationScoped(role: MembershipRole): boolean {
  return LOCATION_SCOPED_ROLES.includes(role);
}

export interface LocationScopeCheck {
  role: MembershipRole;
  userId: string;
  /** The location the target record belongs to. Null for org-wide records. */
  locationId: string | null;
  /** Locations in this organization, used to resolve the manager. */
  locations: Pick<Location, "id" | "managerUserId">[];
}

/**
 * Permission check that also honours location scoping.
 *
 * A location manager acting on an organization-wide record (a Reddit thread
 * with no location, say) is refused: they have no location to be scoped to, so
 * granting it would silently widen their authority.
 */
export function canForLocation(
  permission: Permission,
  check: LocationScopeCheck,
): boolean {
  if (!can(check.role, permission)) return false;
  if (!isLocationScoped(check.role)) return true;
  if (check.locationId === null) return false;

  const location = check.locations.find((row) => row.id === check.locationId);
  return location?.managerUserId === check.userId;
}

/** Human explanation for a refusal. Shown in the UI, never a stack trace. */
export function explainDenial(
  permission: Permission,
  role: MembershipRole,
): string {
  if (!can(role, permission)) {
    return `Your role (${role.replace(/_/g, " ")}) cannot perform this action.`;
  }
  return "You can only act on records for the locations you manage.";
}
