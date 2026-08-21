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
  "response.generate",
  "response.confirm_publication",
  "mention.capture_manual",
  "response.publish",
  "response.retract",
  "escalation.assign",
  "escalation.update_status",
  "automation_rule.toggle",
  "automation_rule.manage",
  "brand_voice.update",
  "location.update_manager",
  "location.create",
  "location.update",
  "organization.manage_members",
  "organization.update",
  "onboarding.manage",
  "integration.connect",
  "integration.reauthorize",
  "integration.manage_profiles",
  "integration.test_connection",
  "integration.sync_reviews",
  "integration.disconnect",
  "monitoring.manage_queries",
  "monitoring.poll_now",
  "website_widget.manage",
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
  // Manual generation (response-generation plan, Task 9). Restated inside
  // `claim_generation_attempt` (`has_organization_role(..., array['owner',
  // 'admin', 'communications_lead'])`) — the same onboarding-style precedent
  // as `onboarding.manage`: a check in application code protects the one
  // path that runs it, but the database enforces the same list itself.
  // Location managers are absent for the same reason they are absent from
  // `response.edit`: a draft carries no location to scope them to.
  "response.generate": ["owner", "admin", "communications_lead"],
  // Stating that an approved response was posted on a platform Lia cannot
  // reach. Deliberately **not** a reuse of `response.decide`: the separation
  // this table has kept between writing text and signing it off would be
  // hollow if the approver could also be the sole witness that it went public.
  // Nobody can confirm a draft that is not approved — `canConfirmPublication`
  // refuses it regardless of who is asking — so this row narrows the door
  // rather than being the lock.
  //
  // Location managers are absent for the same reason they are absent from
  // `response.edit`: a draft carries no location to scope them to. Analysts
  // and viewers are absent because this writes a record of a public act.
  "response.confirm_publication": ["owner", "admin", "communications_lead"],
  // Typing a review Lia could not fetch into the queue.
  //
  // Its own permission rather than a reuse of `integration.sync_reviews`, and
  // the same roles hold both today — the D145 pattern, where two genuinely
  // different acts get two names before the day one of them needs to move.
  // Relaying what a provider returned and asserting content nothing can verify
  // are not the same act: a captured review is unfalsifiable by construction,
  // and it drives analysis, escalation, and a public reply exactly as an
  // imported one does. The obvious future divergence is already visible — a
  // location manager adding their own restaurant's review is plausible, and
  // `integration.sync_reviews` is organization-wide by design and could never
  // express it.
  "mention.capture_manual": ["owner", "admin", "communications_lead"],
  // Pressing publish is the act that puts words under a customer's name in
  // front of the public. Deliberately **not** the same list as
  // `response.decide`: approvers sign text off, and the separation of duties
  // this table has kept since D-day between writing and approving would be
  // hollow if the approver could also be the one to send it. The
  // communications lead who owns the text carries it out, once somebody else
  // has approved it — and `claim_response_publication` refuses an unapproved
  // draft regardless of who is asking, so this row narrows the door rather
  // than being the lock.
  //
  // Analysts, viewers, and location managers are absent. A location manager
  // has no location to be scoped to here for the same reason they are absent
  // from `response.edit`: a draft carries none.
  "response.publish": ["owner", "admin", "communications_lead"],
  // Retraction is an emergency stop, so it sits with the same people rather
  // than one notch higher. Making it an owner-only act would mean the person
  // who noticed the problem has to find somebody else before a bad reply comes
  // down, and minutes matter more here than authority does. Guarded instead by
  // an explicit confirmation and by the database proving Lia published the
  // comment it is about to delete.
  "response.retract": ["owner", "admin", "communications_lead"],
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
  // Structural rule changes. Same roles as `automation_rule.toggle` today —
  // and as the `automation_rules_insert`/`update` RLS policies — but a distinct
  // name, because writing organizational policy and arming it are different
  // acts, and the day the product wants approvers to activate rules they did
  // not author, that is a one-line edit here.
  "automation_rule.manage": ["owner", "admin", "communications_lead"],
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
  // Adding a restaurant to the portfolio, and editing what one is.
  //
  // Neither is a reuse of `location.update_manager`, deliberately. That one is
  // about *who holds authority over a site*, which is why it is narrower than
  // the general write gate — folding "edit the address" into it makes the name
  // a lie in one direction or the other. Nor a reuse of `onboarding.manage`:
  // first-run setup and ongoing administration are different authorities with
  // different lifetimes, and an organization that finished onboarding a year
  // ago still needs to add its eleventh restaurant.
  //
  // Same two roles as `location.update_manager` today, so the split costs
  // nothing now and gives a future "regional director may edit their own
  // sites" role somewhere to attach.
  //
  // These match the database exactly once the contraction migration
  // (20260814000500) lands: `locations_insert` and `locations_update` name
  // owner and admin and nobody else. Before that migration the policies are
  // still the old `can_write_in_organization`, which is wider — the expansion
  // phase deliberately keeps them that way so the currently deployed
  // application keeps working, and this permission is the narrower gate in the
  // meantime.
  //
  // Location managers are absent for the same reason they are absent from
  // `integration.manage_profiles`: creating a restaurant record is an
  // organization-wide decision with no location to scope them to, and under
  // the old policy a location manager could reassign `manager_user_id` to
  // themselves — the exact widening `location.update_manager` exists to stop.
  //
  // Communications leads are absent too, and that is not a demotion: mapping a
  // Google listing still brings a location into existence for them, through
  // `create_and_map_location`, which cannot produce one without binding a
  // profile to it. Creation as a side effect of mapping, never as a capability
  // of its own.
  "location.create": ["owner", "admin"],
  "location.update": ["owner", "admin"],
  "organization.manage_members": ["owner", "admin"],
  // Who runs the roster and who defines the organization's identity are
  // different questions — this is deliberately not a reuse of
  // `manage_members`, so each answer stays legible on its own row. Backstopped
  // by `organizations_update_admins` in RLS, which named the same two roles
  // before this permission existed.
  "organization.update": ["owner", "admin"],
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
  // Configuring what Lia publishes on the customer's own website: the theme,
  // which review or which coverage is shown, the approved domains, and whether
  // either embed resolves at all.
  //
  // **One permission for both website widgets**, and renamed from
  // `review_widget.manage` when the press widget arrived. The alternative —
  // `review_widget.manage` plus `press_widget.manage` — would have been two
  // names for one authority: the same three roles, the same screens, the same
  // approved-domain list, and the same underlying question, which is whether
  // this person may decide what the company publishes on its own site. Two
  // permissions with identical role lists are not a finer-grained control;
  // they are a place for the two lists to drift apart.
  //
  // The rename was made atomically rather than left as an alias. Nothing in
  // SQL names it — the RLS policies restate the *roles* with
  // `has_organization_role`, which is what Postgres can express — so the
  // change is confined to this table, four call sites, and the tests that pin
  // the role list. An alias would have left `review_widget.manage` gating the
  // press widget, which reads as a copy-paste error to the next person and
  // would be one.
  //
  // The same three roles as `brand_voice.update` and `automation_rule.manage`,
  // and it belongs with them rather than with the integration permissions: all
  // three decide what the product says without a person in the loop. An
  // integration permission would have been the wrong shelf — there is no
  // external account here, nothing to authorise, and nothing to disconnect.
  //
  // Location managers are absent. For the review widget that needs an
  // argument, because a widget carries a location and `canForLocation` could
  // scope them to it; two reasons it does not. The policies in 20260820000300
  // and 20260821000200 restate this list with `has_organization_role`, which
  // cannot express "and only for their own locations" — the scoping would live
  // in application code alone, and for a surface the public can see this
  // table's posture is that application code is not the last line. And a
  // group's marketing site is one artefact even when the review on it is one
  // restaurant's. For the press widget the argument is easier still: it
  // carries no location at all, only a monitoring query, so there is nothing
  // to scope them to even in principle.
  //
  // Analysts and viewers are absent for the ordinary reason: they read.
  "website_widget.manage": ["owner", "admin", "communications_lead"],
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
