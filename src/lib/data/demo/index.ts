import {
  applySourceFields,
  auditEventSchema,
  BRAND_VOICE_AXIS_KEYS,
  createEscalationInputSchema,
  createLocationInputSchema,
  createMentionAnalysisInputSchema,
  createMentionInputSchema,
  EMPTY_ANALYSIS_COUNTS,
  EMPTY_SYNC_COUNTS,
  finishAnalysisRunInputSchema,
  finishSyncRunInputSchema,
  ingestMentionInputSchema,
  invitationState,
  isExpired,
  isAnalysisRunStale,
  isEscalationClosed,
  isSuccessfulAnalysisRun,
  isSuccessfulSyncRun,
  isSyncRunStale,
  firstIncompleteStep,
  NEW_CONNECTION_DEFAULTS,
  NEW_PROFILE_DEFAULTS,
  oauthStateSchema,
  recordAuditEventInputSchema,
  requiresResolutionNote,
  sourceFieldsChanged,
  startAnalysisRunInputSchema,
  startSyncRunInputSchema,
  updateBrandVoiceInputSchema,
  upsertPlatformConnectionInputSchema,
  upsertPlatformProfileInputSchema,
  type AnalysisRun,
  type Approval,
  type AuditEvent,
  type AutomationRule,
  type BrandVoiceProfile,
  type Escalation,
  type Invitation,
  type Location,
  type Membership,
  type Mention,
  type MentionAnalysis,
  type OAuthState,
  type Organization,
  type OrganizationOnboarding,
  type PlatformConnection,
  type PlatformProfile,
  type PlatformSyncRun,
  type ResponseDraft,
  type UpdateBrandVoiceInput,
  type User,
} from "@/domain";
import { canDecideOnDraft, canEditDraft } from "@/domain";
import { DataError, conflict, invalidInput, notFound } from "@/lib/data/errors";
import {
  computeLocationMetrics,
  computeOrganizationMetrics,
  countByStatus,
  isOpenStatus,
  rankByUrgency,
} from "@/lib/data/metrics";
import { demoRuntimeStore, demoStore, replaceRow, scoped } from "@/lib/data/demo/store";
import { createMonitoringRepositories } from "@/lib/data/demo/monitoring";
import {
  AnalysisRunInProgressError,
  SyncRunInProgressError,
  type LiaDataSource,
  type MentionDetail,
  type OrganizationScope,
  type ProfileSyncState,
} from "@/lib/data/types";
import { REFERENCE_NOW } from "@/lib/seed/clock";
import { seedId } from "@/lib/seed/ids";

/**
 * The demo adapter.
 *
 * Implements the full repository surface against the in-memory store so the
 * application, its mutations, and its tests all run with no database. Filters
 * and ordering match the Supabase adapter's behaviour deliberately: a screen
 * must not change shape when a deployment gains a database.
 */

function nowIso(): string {
  // Demo mode runs on the seed clock so timestamps stay reproducible.
  return REFERENCE_NOW;
}

/**
 * The wall clock, for records whose lifetime is real.
 *
 * Invitations are the exception to the seed clock, and it has to be an
 * exception: their `expiresAt` is computed by the action from `Date.now()`, so
 * checking it against a frozen `REFERENCE_NOW` compares two different clocks.
 * The seed instant is in the past and recedes further every day, which means a
 * demo invitation would never expire — the check would silently pass forever.
 *
 * Seeded rows keep the frozen clock, because their whole purpose is to render
 * identically on every machine. Nothing here is seeded.
 */
function realNowIso(): string {
  return new Date().toISOString();
}

function findOnboarding(organizationId: string): OrganizationOnboarding | null {
  return (
    demoStore().organizationOnboarding.find(
      (row: OrganizationOnboarding) => row.organizationId === organizationId,
    ) ?? null
  );
}

/**
 * Apply one onboarding transition.
 *
 * The patch is a function of the current row rather than a literal, because
 * every transition is idempotent: a step that already carries a timestamp keeps
 * it, so a resubmitted form does not make the trail claim somebody completed a
 * step later than they did. The Supabase adapter gets the same behaviour from
 * its `nowIfUnset` sentinel.
 */
function patchOnboarding(
  organizationId: string,
  patch: (current: OrganizationOnboarding) => Partial<OrganizationOnboarding>,
): OrganizationOnboarding {
  const current = findOnboarding(organizationId);
  if (!current) throw notFound("Setup progress");

  const updated: OrganizationOnboarding = {
    ...current,
    ...patch(current),
    updatedAt: nowIso(),
  };

  const rows = demoStore().organizationOnboarding;
  const index = rows.findIndex(
    (row: OrganizationOnboarding) => row.organizationId === organizationId,
  );
  if (index === -1) {
    rows.push(updated);
  } else {
    rows[index] = updated;
  }
  return updated;
}

function textIncludes(haystack: string | null, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle);
}

/**
 * Whether a save would change anything.
 *
 * Order counts as a change for phrase lists: the order is what somebody sees
 * when they read the list back, so silently keeping the old one would make the
 * screen disagree with the database.
 */
function matchesStored(stored: BrandVoiceProfile, input: UpdateBrandVoiceInput): boolean {
  const sameAxes = BRAND_VOICE_AXIS_KEYS.every(
    (key) => stored.axes[key] === input.axes[key],
  );
  const samePhrases = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  return (
    sameAxes &&
    stored.name === input.name &&
    samePhrases(stored.approvedPhrases, input.approvedPhrases) &&
    samePhrases(stored.prohibitedPhrases, input.prohibitedPhrases)
  );
}

/**
 * A URL-safe slug for a location, unique within its organization.
 *
 * A location created from a Google listing has no human to type one, and
 * Google names collide freely across a group — "Maison Laurent" is every one of
 * them. So a numeric suffix is appended rather than the create failing on a
 * conflict the user did not cause and cannot see.
 */
function uniqueSlug(name: string, taken: Set<string>, fallback = "location"): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || fallback;

  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${base}-${taken.size + 1}`;
}

export function createDemoDataSource(): LiaDataSource {
  const store = () => demoStore();

  /** Rows the caller is entitled to see, for one table. */
  const orgRows = <T extends { organizationId: string }>(
    rows: T[],
    scope: OrganizationScope,
  ): T[] => scoped(rows, scope.organizationId);

  function findMembership(scope: OrganizationScope, userId: string): Membership {
    const membership = orgRows(store().memberships, scope).find(
      (row) => row.userId === userId,
    );
    if (!membership) throw notFound("Membership");
    return membership;
  }

  /**
   * Refuse to strip the last active owner.
   *
   * An organization with no owner cannot be repaired through the interface —
   * there is nobody left who could promote anyone — so this is checked before
   * the write rather than reported after it.
   */
  function assertNotLastOwner(scope: OrganizationScope, userId: string): void {
    const otherOwners = orgRows(store().memberships, scope).filter(
      (row) => row.role === "owner" && row.status === "active" && row.userId !== userId,
    );

    if (otherOwners.length === 0) {
      throw conflict(
        "This is the only owner. Make somebody else an owner first, then change this one.",
      );
    }
  }

  /** The invitation a token hash refers to, or null. Never logs the hash. */
  function findByTokenHash(tokenHash: string): Invitation | null {
    const runtime = demoRuntimeStore();
    for (const [invitationId, storedHash] of runtime.invitationTokenHashes) {
      if (storedHash !== tokenHash) continue;
      return runtime.invitations.find((row) => row.id === invitationId) ?? null;
    }
    return null;
  }

  const mentionsIn = (scope: OrganizationScope): Mention[] =>
    orgRows(store().mentions, scope);
  const draftsIn = (scope: OrganizationScope): ResponseDraft[] =>
    orgRows(store().responseDrafts, scope);
  const analysesIn = (scope: OrganizationScope): MentionAnalysis[] =>
    orgRows(store().mentionAnalyses, scope);

  return {
    kind: "demo",
    ...createMonitoringRepositories(),

    organizations: {
      async listForUser(userId) {
        return store()
          .memberships.filter(
            (membership) => membership.userId === userId && membership.status === "active",
          )
          .flatMap((membership) => {
            const organization = store().organizations.find(
              (row) => row.id === membership.organizationId,
            );
            return organization
              ? [{ organization, role: membership.role, status: membership.status }]
              : [];
          })
          .sort((a, b) => a.organization.name.localeCompare(b.organization.name));
      },

      async getBySlug(slug, userId) {
        const all = await this.listForUser(userId);
        return all.find((entry) => entry.organization.slug === slug) ?? null;
      },

      async getById(organizationId, userId) {
        const all = await this.listForUser(userId);
        return all.find((entry) => entry.organization.id === organizationId) ?? null;
      },

      async provision(input) {
        const name = input.name.trim();
        if (!name) throw invalidInput("An organization name is required.");

        const user = store().users.find((row) => row.id === input.userId);
        if (!user) throw notFound("User account");

        const taken = new Set(store().organizations.map((row) => row.slug));
        const timestamp = nowIso();

        const organization = {
          id: seedId(`organization:${name}:${input.userId}`),
          name,
          slug: uniqueSlug(name, taken, "organization"),
          industry: input.industry?.trim() || "Restaurant group",
          websiteUrl: null,
          defaultTimezone: input.timezone?.trim() || "UTC",
          defaultLanguage: input.language?.trim() || "en-US",
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        // Both rows or neither. In demo mode that is one synchronous block; the
        // Supabase adapter gets the same guarantee from a function body.
        store().organizations.push(organization);
        store().memberships.push({
          id: seedId(`membership:${organization.id}:${input.userId}`),
          organizationId: organization.id,
          userId: input.userId,
          role: "owner",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        // Both rows *and* the onboarding row, matching what
        // `provision_organization` does inside one function body.
        store().organizationOnboarding.push({
          organizationId: organization.id,
          status: "in_progress",
          currentStep: "organization",
          organizationCompletedAt: null,
          sourceCompletedAt: null,
          sourceSkippedAt: null,
          locationsCompletedAt: null,
          locationsSkippedAt: null,
          brandVoiceCompletedAt: null,
          teamCompletedAt: null,
          teamSkippedAt: null,
          completedAt: null,
          readyViewedAt: null,
          organizationSize: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        return { organization, role: "owner", status: "active" };
      },

      async update(scope, input) {
        const existing = store().organizations.find(
          (row) => row.id === scope.organizationId,
        );
        if (!existing) throw notFound("Organization");

        if (input.slug !== undefined && input.slug !== existing.slug) {
          const taken = store().organizations.some(
            (row) => row.slug === input.slug && row.id !== existing.id,
          );
          if (taken) {
            throw new DataError("conflict", "That slug is already taken.", {
              slug: "That slug is already taken.",
            });
          }
        }

        const updated: Organization = {
          ...existing,
          name: input.name,
          websiteUrl: input.websiteUrl,
          industry: input.industry,
          defaultTimezone: input.defaultTimezone,
          defaultLanguage: input.defaultLanguage,
          slug: input.slug ?? existing.slug,
          updatedAt: nowIso(),
        };

        return replaceRow(store().organizations, updated);
      },
      // Deliberately unscoped — see the doc comment on
      // `listWithUnanalyzedMentions` in types.ts. Mirrors `listUnanalyzed`'s
      // own selection ("no analysis row"), just unfiltered by organization.
      async listWithUnanalyzedMentions() {
        const analyzed = new Set(
          store().mentionAnalyses.map((analysis) => analysis.mentionId),
        );
        const organizationIds = new Set<string>();
        for (const mention of store().mentions) {
          if (!analyzed.has(mention.id)) organizationIds.add(mention.organizationId);
        }
        return [...organizationIds];
      },
    },

    onboarding: {
      async get(scope) {
        return findOnboarding(scope.organizationId);
      },

      async create(scope) {
        const existing = findOnboarding(scope.organizationId);
        if (existing) return existing;

        const timestamp = nowIso();
        const created: OrganizationOnboarding = {
          organizationId: scope.organizationId,
          status: "in_progress",
          currentStep: "organization",
          organizationCompletedAt: null,
          sourceCompletedAt: null,
          sourceSkippedAt: null,
          locationsCompletedAt: null,
          locationsSkippedAt: null,
          brandVoiceCompletedAt: null,
          teamCompletedAt: null,
          teamSkippedAt: null,
          completedAt: null,
          readyViewedAt: null,
          organizationSize: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        store().organizationOnboarding.push(created);
        return created;
      },

      async completeOrganizationStep(scope, organizationSize) {
        return patchOnboarding(scope.organizationId, (current) => ({
          organizationCompletedAt: current.organizationCompletedAt ?? nowIso(),
          organizationSize,
          currentStep: "connect_sources",
        }));
      },

      async completeSourceStep(scope) {
        // Clears the skip: somebody who continued without connecting and then
        // came back and connected has not skipped the step, and the table's
        // check constraint refuses both timestamps at once.
        return patchOnboarding(scope.organizationId, (current) => ({
          sourceCompletedAt: current.sourceCompletedAt ?? nowIso(),
          sourceSkippedAt: null,
          currentStep: "locations",
        }));
      },

      async skipSourceStep(scope) {
        return patchOnboarding(scope.organizationId, (current) => ({
          sourceSkippedAt: current.sourceSkippedAt ?? nowIso(),
          sourceCompletedAt: null,
          currentStep: "locations",
        }));
      },

      async completeLocationsStep(scope) {
        return patchOnboarding(scope.organizationId, (current) => ({
          locationsCompletedAt: current.locationsCompletedAt ?? nowIso(),
          locationsSkippedAt: null,
          currentStep: "brand_voice",
        }));
      },

      async skipLocationsStep(scope) {
        return patchOnboarding(scope.organizationId, (current) => ({
          locationsSkippedAt: current.locationsSkippedAt ?? nowIso(),
          locationsCompletedAt: null,
          currentStep: "brand_voice",
        }));
      },

      async completeBrandVoiceStep(scope) {
        return patchOnboarding(scope.organizationId, (current) => ({
          brandVoiceCompletedAt: current.brandVoiceCompletedAt ?? nowIso(),
          currentStep: "team",
        }));
      },

      async completeTeamStep(scope) {
        return patchOnboarding(scope.organizationId, (current) => ({
          teamCompletedAt: current.teamCompletedAt ?? nowIso(),
          teamSkippedAt: null,
          currentStep: "ready",
        }));
      },

      async skipTeamStep(scope) {
        return patchOnboarding(scope.organizationId, (current) => ({
          teamSkippedAt: current.teamSkippedAt ?? nowIso(),
          teamCompletedAt: null,
          currentStep: "ready",
        }));
      },

      async completeOnboarding(scope) {
        const current = findOnboarding(scope.organizationId);
        if (!current) throw notFound("Setup progress");
        // Already finished. Returned rather than rewritten, so a resubmitted
        // form does not restamp `completedAt`.
        if (current.status === "completed") return current;

        if (firstIncompleteStep(current)) {
          throw conflict("Finish the earlier setup steps before completing setup.");
        }

        return patchOnboarding(scope.organizationId, () => ({
          status: "completed",
          completedAt: nowIso(),
          currentStep: "ready",
        }));
      },

      async markReadyViewed(scope) {
        return patchOnboarding(scope.organizationId, (current) => ({
          readyViewedAt: current.readyViewedAt ?? nowIso(),
        }));
      },
    },

    users: {
      async updateOwnProfile(userId, input) {
        const user = store().users.find((row) => row.id === userId);
        if (!user) throw notFound("That account no longer exists.");

        const updated: User = {
          ...user,
          firstName: input.firstName,
          lastName: input.lastName,
          // Composed the same way the database's generated column composes it,
          // so the two adapters render identical display names.
          fullName: `${input.firstName} ${input.lastName}`.trim(),
          updatedAt: realNowIso(),
        };

        replaceRow(store().users, updated);
        return updated;
      },

      async updateOwnAvatar(userId, avatarUrl) {
        const user = store().users.find((row) => row.id === userId);
        if (!user) throw notFound("User");

        const updated: User = { ...user, avatarUrl, updatedAt: nowIso() };
        return replaceRow(store().users, updated);
      },
    },

    memberships: {
      async getActiveMembership(organizationId, userId) {
        return (
          store().memberships.find(
            (membership) =>
              membership.organizationId === organizationId &&
              membership.userId === userId &&
              membership.status === "active",
          ) ?? null
        );
      },

      async listMembers(scope) {
        return orgRows(store().memberships, scope).flatMap((membership) => {
          const user = store().users.find((row) => row.id === membership.userId);
          return user ? [{ ...membership, user }] : [];
        });
      },

      async listAssignableUsers(scope) {
        const members = await this.listMembers(scope);
        return members
          .filter((membership) => membership.status === "active")
          .map((membership): User => membership.user)
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
      },

      async countActiveOwners(scope) {
        return orgRows(store().memberships, scope).filter(
          (membership) => membership.role === "owner" && membership.status === "active",
        ).length;
      },

      async updateRole(scope, userId, role) {
        const membership = findMembership(scope, userId);

        // Mirrors the database constraint trigger. Demo mode has no trigger, so
        // without this the two adapters would disagree about what is legal —
        // and the one without a database is the one tests run against.
        if (membership.role === "owner" && role !== "owner") {
          assertNotLastOwner(scope, userId);
        }

        return replaceRow(store().memberships, {
          ...membership,
          role,
          updatedAt: nowIso(),
        });
      },

      async updateStatus(scope, userId, status) {
        const membership = findMembership(scope, userId);

        if (membership.role === "owner" && status !== "active") {
          assertNotLastOwner(scope, userId);
        }

        return replaceRow(store().memberships, {
          ...membership,
          status,
          updatedAt: nowIso(),
        });
      },

      async remove(scope, userId) {
        const membership = findMembership(scope, userId);
        if (membership.role === "owner") assertNotLastOwner(scope, userId);

        const rows = store().memberships;
        rows.splice(rows.indexOf(membership), 1);
      },
    },

    invitations: {
      async create(scope, input) {
        const email = input.email.trim().toLowerCase();
        if (!email.includes("@")) throw invalidInput("Enter a valid email address.");

        // The partial unique index, in application form. Demo mode has no
        // index, and letting two live invitations exist here would make the
        // adapters disagree about a rule the tests rely on.
        const alreadyPending = demoRuntimeStore().invitations.some(
          (row) =>
            row.organizationId === scope.organizationId &&
            row.email === email &&
            row.status === "pending",
        );
        if (alreadyPending) {
          throw conflict("That person already has a pending invitation.");
        }

        if (
          orgRows(store().memberships, scope).some((membership) => {
            const user = store().users.find((row) => row.id === membership.userId);
            return user?.email.toLowerCase() === email;
          })
        ) {
          throw conflict("That person is already a member of this organization.");
        }

        const runtime = demoRuntimeStore();
        runtime.invitationSequence += 1;
        const timestamp = realNowIso();

        const invitation = {
          id: seedId(`invitation:${scope.organizationId}:${runtime.invitationSequence}`),
          organizationId: scope.organizationId,
          email,
          role: input.role,
          status: "pending" as const,
          invitedByUserId: input.invitedByUserId,
          expiresAt: input.expiresAt,
          acceptedAt: null,
          acceptedByUserId: null,
          revokedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        runtime.invitations.push(invitation);
        // Held beside the record rather than on it, as the database does: the
        // hash is a lookup key, and putting it on the domain object would carry
        // it into anything that ever serialises an Invitation.
        runtime.invitationTokenHashes.set(invitation.id, input.tokenHash);

        return invitation;
      },

      async listPending(scope) {
        return demoRuntimeStore()
          .invitations.filter(
            (row) => row.organizationId === scope.organizationId && row.status === "pending",
          )
          .map((row) => ({
            ...row,
            invitedByName:
              store().users.find((user) => user.id === row.invitedByUserId)?.fullName ?? null,
          }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },

      async revoke(scope, invitationId) {
        const runtime = demoRuntimeStore();
        const invitation = runtime.invitations.find(
          (row) => row.id === invitationId && row.organizationId === scope.organizationId,
        );

        if (!invitation) throw notFound("Invitation");
        if (invitation.status !== "pending") {
          throw conflict("That invitation is no longer pending.");
        }

        const revoked = {
          ...invitation,
          status: "revoked" as const,
          revokedAt: realNowIso(),
          updatedAt: realNowIso(),
        };
        replaceRow(runtime.invitations, revoked);

        // The hash is deliberately kept. Acceptance is gated on `status ===
        // "pending"`, so a revoked invitation is already unusable — and
        // keeping the lookup is what lets the acceptance page say "that
        // invitation was withdrawn" instead of "that link is not valid".
        // Postgres does the same thing, and the two adapters must not show
        // different screens for the same situation.

        return revoked;
      },

      async preview(tokenHash) {
        const invitation = findByTokenHash(tokenHash);
        if (!invitation) return null;

        const organization = store().organizations.find(
          (row) => row.id === invitation.organizationId,
        );
        if (!organization) return null;

        return {
          organizationName: organization.name,
          email: invitation.email,
          role: invitation.role,
          state: invitationState(invitation, new Date(realNowIso())),
        };
      },

      async accept(tokenHash, userId) {
        const runtime = demoRuntimeStore();
        const invitation = findByTokenHash(tokenHash);
        const user = store().users.find((row) => row.id === userId);

        // One failure for every reason, matching the SQL. The caller has
        // already been told which by `preview`; distinguishing them here would
        // only grade an attacker's attempts.
        if (
          !invitation ||
          !user ||
          invitation.status !== "pending" ||
          isExpired(invitation, new Date(realNowIso())) ||
          invitation.email !== user.email.trim().toLowerCase()
        ) {
          throw invalidInput("That invitation cannot be accepted.");
        }

        replaceRow(runtime.invitations, {
          ...invitation,
          status: "accepted",
          acceptedAt: realNowIso(),
          acceptedByUserId: userId,
          updatedAt: realNowIso(),
        });

        const existing = store().memberships.find(
          (row) =>
            row.organizationId === invitation.organizationId && row.userId === userId,
        );

        if (existing) {
          // Upsert, not insert. Re-inviting somebody who was suspended, or
          // moving them to a different role, has to actually take effect.
          replaceRow(store().memberships, {
            ...existing,
            role: invitation.role,
            status: "active",
            updatedAt: nowIso(),
          });
        } else {
          store().memberships.push({
            id: seedId(`membership:${invitation.organizationId}:${userId}`),
            organizationId: invitation.organizationId,
            userId,
            role: invitation.role,
            status: "active",
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        }

        return { organizationId: invitation.organizationId };
      },
    },

    locations: {
      async list(scope) {
        return orgRows(store().locations, scope).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      },

      async get(scope, locationId) {
        return orgRows(store().locations, scope).find((row) => row.id === locationId) ?? null;
      },

      async metrics(scope) {
        return computeLocationMetrics(
          orgRows(store().locations, scope),
          mentionsIn(scope),
          draftsIn(scope),
        );
      },

      async updateManager(scope, locationId, managerUserId) {
        const location = orgRows(store().locations, scope).find(
          (row) => row.id === locationId,
        );
        if (!location) throw notFound("Location");

        if (managerUserId) {
          const membership = store().memberships.find(
            (row) =>
              row.organizationId === scope.organizationId &&
              row.userId === managerUserId &&
              row.status === "active",
          );
          // A manager must be a member of the same organization, or the
          // assignment would hand a location to someone with no access to it.
          if (!membership) {
            throw invalidInput("That person is not an active member of this organization.");
          }
        }

        const updated: Location = { ...location, managerUserId, updatedAt: nowIso() };
        return replaceRow(store().locations, updated);
      },

      async create(scope, input) {
        const value = createLocationInputSchema.parse(input);

        if (value.managerUserId) {
          const membership = store().memberships.find(
            (row) =>
              row.organizationId === scope.organizationId &&
              row.userId === value.managerUserId &&
              row.status === "active",
          );
          if (!membership) {
            throw invalidInput("That person is not an active member of this organization.");
          }
        }

        const existingSlugs = new Set(
          orgRows(store().locations, scope).map((row) => row.slug),
        );
        const slug = value.slug ?? uniqueSlug(value.name, existingSlugs);

        // Slugs are unique per organization, not globally, so this only has to
        // look at rows the caller can already see.
        if (existingSlugs.has(slug)) {
          throw conflict(`A location with the address "${slug}" already exists.`);
        }

        const created: Location = {
          id: seedId(`location:runtime:${scope.organizationId}:${slug}`),
          organizationId: scope.organizationId,
          name: value.name,
          slug,
          addressLine1: value.addressLine1,
          addressLine2: value.addressLine2,
          city: value.city,
          region: value.region,
          postalCode: value.postalCode,
          countryCode: value.countryCode,
          timezone: value.timezone,
          status: value.status,
          managerUserId: value.managerUserId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        store().locations.push(created);
        return created;
      },
    },

    platformConnections: {
      async list(scope) {
        return orgRows(store().platformConnections, scope).sort((a, b) =>
          a.platform.localeCompare(b.platform),
        );
      },
      async get(scope, connectionId) {
        return (
          orgRows(store().platformConnections, scope).find(
            (row) => row.id === connectionId,
          ) ?? null
        );
      },

      async getByPlatform(scope, platform) {
        return (
          orgRows(store().platformConnections, scope).find(
            (row) => row.platform === platform,
          ) ?? null
        );
      },

      async upsert(scope, input) {
        const value = upsertPlatformConnectionInputSchema.parse(input);

        // One connection per platform per organization, mirroring the unique
        // index. Reauthorizing updates the existing row so the profile mappings
        // that reference its id survive.
        const existing = orgRows(store().platformConnections, scope).find(
          (row) => row.platform === value.platform,
        );

        if (existing) {
          const updated: PlatformConnection = {
            ...existing,
            externalAccountId: value.externalAccountId,
            externalAccountName: value.externalAccountName,
            status: value.status,
            capabilities: value.capabilities,
            tokenExpiresAt: value.tokenExpiresAt,
            grantedScopes: value.grantedScopes,
            providerMetadata: value.providerMetadata,
            connectedByUserId: value.connectedByUserId,
            connectedAt: value.connectedAt,
            // Reconnecting clears the previous failure. Leaving it would show a
            // fixed problem next to a healthy badge.
            disconnectedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            updatedAt: nowIso(),
          };
          return replaceRow(store().platformConnections, updated);
        }

        const created: PlatformConnection = {
          ...NEW_CONNECTION_DEFAULTS,
          id: seedId(`connection:runtime:${scope.organizationId}:${value.platform}`),
          organizationId: scope.organizationId,
          platform: value.platform,
          externalAccountId: value.externalAccountId,
          externalAccountName: value.externalAccountName,
          status: value.status,
          capabilities: value.capabilities,
          tokenExpiresAt: value.tokenExpiresAt,
          lastSyncedAt: null,
          grantedScopes: value.grantedScopes,
          providerMetadata: value.providerMetadata,
          connectedByUserId: value.connectedByUserId,
          connectedAt: value.connectedAt,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        store().platformConnections.push(created);
        return created;
      },

      async updateHealth(scope, connectionId, update) {
        const connection = orgRows(store().platformConnections, scope).find(
          (row) => row.id === connectionId,
        );
        if (!connection) throw notFound("Platform connection");

        return replaceRow(store().platformConnections, {
          ...connection,
          lastHealthCheckAt: update.lastHealthCheckAt,
          lastHealthStatus: update.lastHealthStatus,
          lastErrorCode: update.lastErrorCode,
          lastErrorMessage: update.lastErrorMessage,
          status: update.status,
          updatedAt: nowIso(),
        });
      },

      async markDisconnected(scope, connectionId) {
        const connection = orgRows(store().platformConnections, scope).find(
          (row) => row.id === connectionId,
        );
        if (!connection) throw notFound("Platform connection");

        // Idempotent: a second disconnect returns the same row rather than
        // failing, because a user double-clicking a confirm button should not
        // see an error for getting what they asked for.
        if (connection.status === "disconnected") return connection;

        return replaceRow(store().platformConnections, {
          ...connection,
          status: "disconnected",
          disconnectedAt: nowIso(),
          tokenExpiresAt: null,
          grantedScopes: [],
          lastHealthStatus: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: nowIso(),
        });
      },
    },

    platformProfiles: {
      async list(scope) {
        return orgRows(store().platformProfiles, scope);
      },
      async listForConnection(scope, connectionId) {
        return orgRows(store().platformProfiles, scope).filter(
          (row) => row.platformConnectionId === connectionId,
        );
      },

      async upsert(scope, input) {
        const value = upsertPlatformProfileInputSchema.parse(input);

        const connection = orgRows(store().platformConnections, scope).find(
          (row) => row.id === value.platformConnectionId,
        );
        // The scope filter above is what stops a caller mapping a profile onto
        // another organization's connection by supplying its id.
        if (!connection) throw notFound("Platform connection");

        if (value.locationId) {
          const location = orgRows(store().locations, scope).find(
            (row) => row.id === value.locationId,
          );
          if (!location) throw notFound("Location");
        }

        const existing = store().platformProfiles.find(
          (row) =>
            row.platformConnectionId === value.platformConnectionId &&
            row.externalProfileId === value.externalProfileId,
        );

        // Mirrors platform_profiles_one_location_per_connection: two profiles
        // pointing at one restaurant would double-count its every mention.
        const locationTaken =
          value.locationId !== null &&
          store().platformProfiles.some(
            (row) =>
              row.platformConnectionId === value.platformConnectionId &&
              row.locationId === value.locationId &&
              row.id !== existing?.id,
          );

        if (locationTaken) {
          throw conflict(
            "That Lia location is already mapped to a different Google location.",
          );
        }

        if (existing) {
          if (existing.organizationId !== scope.organizationId) {
            throw conflict("That profile belongs to another organization.");
          }

          return replaceRow(store().platformProfiles, {
            ...existing,
            locationId: value.locationId,
            externalProfileName: value.externalProfileName,
            externalAccountId: value.externalAccountId,
            profileUrl: value.profileUrl,
            status: value.status,
            verificationState: value.verificationState,
            providerMetadata: value.providerMetadata,
            lastConfirmedAt: value.lastConfirmedAt,
            updatedAt: nowIso(),
          });
        }

        const created: PlatformProfile = {
          ...NEW_PROFILE_DEFAULTS,
          id: seedId(
            `profile:runtime:${value.platformConnectionId}:${value.externalProfileId}`,
          ),
          organizationId: scope.organizationId,
          locationId: value.locationId,
          platformConnectionId: value.platformConnectionId,
          externalProfileId: value.externalProfileId,
          externalProfileName: value.externalProfileName,
          externalAccountId: value.externalAccountId,
          profileUrl: value.profileUrl,
          status: value.status,
          verificationState: value.verificationState,
          providerMetadata: value.providerMetadata,
          lastConfirmedAt: value.lastConfirmedAt,
          syncCursor: null,
          lastSyncedAt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        store().platformProfiles.push(created);
        return created;
      },

      async markSynced(scope, profileId, syncedAt) {
        const profile = orgRows(store().platformProfiles, scope).find(
          (row) => row.id === profileId,
        );
        if (!profile) throw notFound("Connected location");

        return replaceRow(store().platformProfiles, {
          ...profile,
          lastSyncedAt: syncedAt,
          updatedAt: syncedAt,
        });
      },

      async deactivateForConnection(scope, connectionId) {
        const profiles = orgRows(store().platformProfiles, scope).filter(
          (row) => row.platformConnectionId === connectionId,
        );

        // Preserved, not deleted. Reconnecting later restores every mapping
        // instead of asking someone to redo the work.
        return profiles.map((profile) =>
          replaceRow(store().platformProfiles, {
            ...profile,
            status: "disconnected",
            updatedAt: nowIso(),
          }),
        );
      },
    },

    platformCredentials: {
      async load(scope, connectionId) {
        // Scope check first: a credential is only loadable through a connection
        // the caller's organization owns.
        const connection = orgRows(store().platformConnections, scope).find(
          (row) => row.id === connectionId,
        );
        if (!connection) return null;

        return demoRuntimeStore().credentials.get(connectionId) ?? null;
      },

      async save(scope, connectionId, record) {
        const connection = orgRows(store().platformConnections, scope).find(
          (row) => row.id === connectionId,
        );
        if (!connection) throw notFound("Platform connection");

        demoRuntimeStore().credentials.set(connectionId, { ...record });
      },

      async clear(scope, connectionId) {
        const connection = orgRows(store().platformConnections, scope).find(
          (row) => row.id === connectionId,
        );
        // Idempotent, and silent on a missing connection: clearing credentials
        // that are already gone is the desired end state either way.
        if (!connection) return;

        demoRuntimeStore().credentials.delete(connectionId);
      },
    },

    oauthStates: {
      async create(input) {
        const runtime = demoRuntimeStore();

        const state: OAuthState = oauthStateSchema.parse({
          id: seedId(`oauth-state:${input.stateHash}`),
          provider: input.provider,
          organizationId: input.organizationId,
          userId: input.userId,
          redirectPath: input.redirectPath,
          reauthorization: input.reauthorization,
          expiresAt: input.expiresAt,
          consumedAt: null,
          createdAt: new Date().toISOString(),
        });

        // The hash is stored beside the record rather than inside it, matching
        // the table's unique constraint without putting a lookup key on the
        // domain object that leaves this module.
        runtime.oauthStates.push(state);
        runtime.stateHashes.set(state.id, input.stateHash);
        return state;
      },

      async consume(stateHash) {
        const runtime = demoRuntimeStore();
        const now = Date.now();

        const index = runtime.oauthStates.findIndex(
          (row) => runtime.stateHashes.get(row.id) === stateHash,
        );
        const found = index === -1 ? undefined : runtime.oauthStates[index];
        if (!found) return null;

        // Unknown, spent, and expired are one answer on purpose: telling a
        // caller which of the three it hit would grade their guesses.
        if (found.consumedAt !== null) return null;
        if (Date.parse(found.expiresAt) <= now) return null;

        const consumed: OAuthState = {
          ...found,
          consumedAt: new Date(now).toISOString(),
        };
        runtime.oauthStates[index] = consumed;
        return consumed;
      },

      async purgeExpired() {
        const runtime = demoRuntimeStore();
        const cutoff = Date.now() - 60 * 60 * 1000;

        const keep = runtime.oauthStates.filter(
          (row) => Date.parse(row.expiresAt) >= cutoff,
        );
        const removed = runtime.oauthStates.length - keep.length;
        const kept = new Set(keep);

        for (const row of runtime.oauthStates) {
          if (!kept.has(row)) runtime.stateHashes.delete(row.id);
        }

        runtime.oauthStates.length = 0;
        runtime.oauthStates.push(...keep);
        return removed;
      },
    },

    platformSyncRuns: {
      async start(scope, input) {
        const value = startSyncRunInputSchema.parse(input);
        const runtime = demoRuntimeStore();

        const profile = orgRows(store().platformProfiles, scope).find(
          (row) => row.id === value.platformProfileId,
        );
        // The scope filter is what stops a caller opening a run against another
        // organization's profile by supplying its id.
        if (!profile) throw notFound("Connected location");

        const now = Date.now();
        const active = runtime.syncRuns.find(
          (row) =>
            row.platformProfileId === value.platformProfileId &&
            row.resource === value.resource &&
            row.status === "running",
        );

        if (active) {
          // A run abandoned by a process that died must not block the location
          // forever, so a stale one is closed rather than honoured. Mirrors the
          // reclaim the Supabase adapter performs against the unique index.
          if (!isSyncRunStale(active, now)) {
            throw new SyncRunInProgressError(active.id);
          }

          replaceRow(runtime.syncRuns, {
            ...active,
            status: "failed",
            completedAt: new Date(now).toISOString(),
            errorCode: "sync_abandoned",
            errorMessage:
              "This sync stopped without finishing. It was closed so a new one could start.",
            updatedAt: new Date(now).toISOString(),
          });
        }

        runtime.syncRunSequence += 1;
        const created: PlatformSyncRun = {
          id: seedId(
            `sync-run:${value.platformProfileId}:${value.resource}:${runtime.syncRunSequence}`,
          ),
          organizationId: scope.organizationId,
          platformConnectionId: value.platformConnectionId,
          platformProfileId: value.platformProfileId,
          resource: value.resource,
          trigger: value.trigger,
          actorUserId: value.actorUserId,
          status: "running",
          startedAt: value.startedAt,
          completedAt: null,
          counts: { ...EMPTY_SYNC_COUNTS },
          pagesFetched: 0,
          totalReviewCount: null,
          errorCode: null,
          errorMessage: null,
          createdAt: value.startedAt,
          updatedAt: value.startedAt,
        };

        runtime.syncRuns.push(created);
        return created;
      },

      async finish(scope, runId, input) {
        const value = finishSyncRunInputSchema.parse(input);
        const runtime = demoRuntimeStore();

        const run = runtime.syncRuns.find(
          (row) => row.id === runId && row.organizationId === scope.organizationId,
        );
        if (!run) throw notFound("Sync run");

        return replaceRow(runtime.syncRuns, {
          ...run,
          status: value.status,
          completedAt: value.completedAt,
          counts: value.counts,
          pagesFetched: value.pagesFetched,
          totalReviewCount: value.totalReviewCount,
          errorCode: value.errorCode,
          errorMessage: value.errorMessage,
          updatedAt: value.completedAt,
        });
      },

      async get(scope, runId) {
        return (
          demoRuntimeStore().syncRuns.find(
            (row) => row.id === runId && row.organizationId === scope.organizationId,
          ) ?? null
        );
      },

      async listForProfile(scope, profileId, limit) {
        const rows = orgRows(demoRuntimeStore().syncRuns, scope)
          .filter((row) => row.platformProfileId === profileId)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

        return limit === undefined ? rows : rows.slice(0, limit);
      },

      async latestForProfiles(scope, profileIds, resource) {
        const wanted = new Set(profileIds);
        const state: Record<string, ProfileSyncState> = {};
        for (const id of profileIds) {
          state[id] = { latest: null, lastSuccessful: null };
        }

        const rows = orgRows(demoRuntimeStore().syncRuns, scope)
          .filter((row) => row.resource === resource && wanted.has(row.platformProfileId))
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

        for (const row of rows) {
          const entry = state[row.platformProfileId];
          if (!entry) continue;
          entry.latest ??= row;
          if (entry.lastSuccessful === null && isSuccessfulSyncRun(row)) {
            entry.lastSuccessful = row;
          }
        }

        return state;
      },
    },

    analysisRuns: {
      async start(scope, input) {
        const value = startAnalysisRunInputSchema.parse(input);
        const runtime = demoRuntimeStore();
        const now = Date.now();

        const active = orgRows(runtime.analysisRuns, scope).find(
          (row) => row.status === "running",
        );

        if (active) {
          // A run abandoned by a process that died must not block the
          // organization forever, so a stale one is closed rather than
          // honoured. Mirrors the reclaim in the Supabase adapter.
          if (!isAnalysisRunStale(active, now)) {
            throw new AnalysisRunInProgressError(active.id);
          }

          replaceRow(runtime.analysisRuns, {
            ...active,
            status: "failed",
            completedAt: new Date(now).toISOString(),
            errorCode: "analysis_abandoned",
            errorMessage:
              "This analysis stopped without finishing. It was closed so a new one could start.",
            updatedAt: new Date(now).toISOString(),
          });
        }

        runtime.analysisRunSequence += 1;
        const created: AnalysisRun = {
          id: seedId(
            `analysis-run:${scope.organizationId}:${runtime.analysisRunSequence}`,
          ),
          organizationId: scope.organizationId,
          trigger: value.trigger,
          actorUserId: value.actorUserId,
          status: "running",
          startedAt: value.startedAt,
          completedAt: null,
          counts: { ...EMPTY_ANALYSIS_COUNTS },
          modelProvider: null,
          modelName: null,
          promptVersion: null,
          errorCode: null,
          errorMessage: null,
          createdAt: value.startedAt,
          updatedAt: value.startedAt,
        };

        runtime.analysisRuns.push(created);
        return created;
      },

      async finish(scope, runId, input) {
        const value = finishAnalysisRunInputSchema.parse(input);
        const runtime = demoRuntimeStore();

        const run = runtime.analysisRuns.find(
          (row) => row.id === runId && row.organizationId === scope.organizationId,
        );
        if (!run) throw notFound("Analysis run");

        return replaceRow(runtime.analysisRuns, {
          ...run,
          status: value.status,
          completedAt: value.completedAt,
          counts: value.counts,
          modelProvider: value.modelProvider,
          modelName: value.modelName,
          promptVersion: value.promptVersion,
          errorCode: value.errorCode,
          errorMessage: value.errorMessage,
          updatedAt: value.completedAt,
        });
      },

      async get(scope, runId) {
        return (
          demoRuntimeStore().analysisRuns.find(
            (row) => row.id === runId && row.organizationId === scope.organizationId,
          ) ?? null
        );
      },

      async list(scope, limit) {
        const rows = orgRows(demoRuntimeStore().analysisRuns, scope).sort(
          (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
        );
        return limit === undefined ? rows : rows.slice(0, limit);
      },

      async latest(scope) {
        const rows = orgRows(demoRuntimeStore().analysisRuns, scope).sort(
          (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
        );

        return {
          latest: rows[0] ?? null,
          lastSuccessful: rows.find(isSuccessfulAnalysisRun) ?? null,
        };
      },
    },

    mentions: {
      async list(scope, filter = {}) {
        const connectionsById = new Map(
          orgRows(store().platformConnections, scope).map((row) => [row.id, row]),
        );
        const search = filter.search?.trim().toLowerCase();

        let rows = mentionsIn(scope).filter((mention) => {
          if (filter.locationId && mention.locationId !== filter.locationId) return false;
          if (filter.sourceTypes && !filter.sourceTypes.includes(mention.sourceType)) return false;
          if (filter.statuses && !filter.statuses.includes(mention.status)) return false;
          if (filter.sentiments && !filter.sentiments.includes(mention.sentiment)) return false;
          if (filter.riskLevels && !filter.riskLevels.includes(mention.riskLevel)) return false;
          if (filter.publishedAfter && mention.publishedAt < filter.publishedAfter) return false;
          if (filter.publishedBefore && mention.publishedAt > filter.publishedBefore) return false;

          if (filter.platform) {
            const connection = connectionsById.get(mention.platformConnectionId);
            if (connection?.platform !== filter.platform) return false;
          }

          if (search) {
            const hit =
              textIncludes(mention.title, search) ||
              textIncludes(mention.content, search) ||
              textIncludes(mention.authorName, search);
            if (!hit) return false;
          }

          return true;
        });

        rows = rows.sort(
          (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
        );

        const offset = filter.offset ?? 0;
        return filter.limit === undefined
          ? rows.slice(offset)
          : rows.slice(offset, offset + filter.limit);
      },

      async get(scope, mentionId) {
        return mentionsIn(scope).find((row) => row.id === mentionId) ?? null;
      },

      async getDetail(scope, mentionId) {
        const mention = mentionsIn(scope).find((row) => row.id === mentionId);
        if (!mention) return null;

        const analysis =
          analysesIn(scope)
            .filter((row) => row.mentionId === mentionId)
            .sort((a, b) => Date.parse(b.analyzedAt) - Date.parse(a.analyzedAt))[0] ?? null;

        const detail: MentionDetail = {
          mention,
          analysis,
          drafts: draftsIn(scope)
            .filter((row) => row.mentionId === mentionId)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
          escalation:
            orgRows(store().escalations, scope).find((row) => row.mentionId === mentionId) ??
            null,
          location: mention.locationId
            ? (orgRows(store().locations, scope).find((row) => row.id === mention.locationId) ??
              null)
            : null,
          connection:
            orgRows(store().platformConnections, scope).find(
              (row) => row.id === mention.platformConnectionId,
            ) ?? null,
        };

        return detail;
      },

      async listNeedingAttention(scope, limit) {
        const open = mentionsIn(scope).filter((mention) => isOpenStatus(mention.status));
        const ranked = rankByUrgency(open);
        return limit === undefined ? ranked : ranked.slice(0, limit);
      },

      async counts(scope, filter) {
        return countByStatus(await this.list(scope, filter));
      },

      async metrics(scope) {
        return computeOrganizationMetrics({
          mentions: mentionsIn(scope),
          analyses: analysesIn(scope),
          drafts: draftsIn(scope),
          referenceNow: REFERENCE_NOW,
        });
      },

      async create(scope, input) {
        const parsed = createMentionInputSchema.safeParse(input);
        if (!parsed.success) {
          throw invalidInput("That mention could not be stored.", {
            [parsed.error.issues[0]?.path.join(".") ?? "input"]:
              parsed.error.issues[0]?.message ?? "Invalid value",
          });
        }
        const value = parsed.data;

        // Idempotent ingest: the same external record must update, not
        // duplicate. Mirrors the unique constraint in the schema.
        const existing = store().mentions.find(
          (row) =>
            row.platformConnectionId === value.platformConnectionId &&
            row.sourceType === value.sourceType &&
            row.externalId === value.externalId,
        );

        if (existing) {
          if (existing.organizationId !== scope.organizationId) {
            throw conflict("That external record belongs to another organization.");
          }
          const updated: Mention = {
            ...existing,
            ...value,
            id: existing.id,
            organizationId: existing.organizationId,
            receivedAt: value.receivedAt ?? existing.receivedAt,
            createdAt: existing.createdAt,
            updatedAt: nowIso(),
          };
          return replaceRow(store().mentions, updated);
        }

        const created: Mention = {
          ...value,
          id: seedId(`mention:runtime:${value.platformConnectionId}:${value.externalId}`),
          organizationId: scope.organizationId,
          receivedAt: value.receivedAt ?? nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        store().mentions.push(created);
        return created;
      },

      async ingest(scope, input) {
        const value = ingestMentionInputSchema.parse(input);

        // The same natural key the database enforces. Looked up across the
        // whole store rather than the caller's slice, because a key that
        // already belongs to another organization must be reported as a
        // conflict rather than silently inserted a second time.
        const existing = store().mentions.find(
          (row) =>
            row.platformConnectionId === value.platformConnectionId &&
            row.sourceType === value.sourceType &&
            row.externalId === value.externalId,
        );

        if (existing) {
          if (existing.organizationId !== scope.organizationId) {
            throw conflict("That external record belongs to another organization.");
          }

          const changed = sourceFieldsChanged(existing, value);

          // `updatedAt` only moves when something did. An unchanged record that
          // bumped its own timestamp on every sync would make "what changed
          // recently" useless, which is the question the inbox is sorted by.
          const updated = applySourceFields(
            existing,
            value,
            changed ? nowIso() : existing.updatedAt,
          );

          return {
            mention: replaceRow(store().mentions, updated),
            outcome: changed ? "updated" : "unchanged",
          };
        }

        const created: Mention = {
          id: seedId(`mention:runtime:${value.platformConnectionId}:${value.externalId}`),
          organizationId: scope.organizationId,
          locationId: value.locationId,
          platformConnectionId: value.platformConnectionId,
          platformProfileId: value.platformProfileId,
          sourceType: value.sourceType,
          externalId: value.externalId,
          externalParentId: value.externalParentId,
          sourceUrl: value.sourceUrl,
          title: value.title,
          content: value.content,
          authorName: value.authorName,
          authorExternalId: value.authorExternalId,
          rating: value.rating,
          language: value.language,
          publishedAt: value.publishedAt,
          // First sight, so this genuinely is when Lia received it. A later
          // sync of the same review leaves it alone.
          receivedAt: value.syncedAt,
          // Lia workflow state starts at its defaults and is never set by an
          // ingest again.
          status: "new",
          sentiment: "unknown",
          riskLevel: "low",
          relevanceScore: null,
          engagementScore: null,
          rawPayload: value.rawPayload,
          externalResourceName: value.externalResourceName,
          authorAvatarUrl: value.authorAvatarUrl,
          authorIsAnonymous: value.authorIsAnonymous,
          sourceUpdatedAt: value.sourceUpdatedAt,
          sourceReplyText: value.sourceReplyText,
          sourceReplyUpdatedAt: value.sourceReplyUpdatedAt,
          sourceMetadata: value.sourceMetadata,
          lastSyncedAt: value.syncedAt,
          publisherName: value.publisherName,
          publisherDomain: value.publisherDomain,
          // Set by the gate, not by this ingest — no candidate arrives here
          // already flagged as syndicated.
          isSyndicated: false,
          // Only a brand-new mention attributes to the query that found it;
          // `applySourceFields` (the update branch above) never touches this.
          monitoringQueryId: value.monitoringQueryId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        store().mentions.push(created);
        return { mention: created, outcome: "created" };
      },

      async listUnanalyzed(scope, limit) {
        const analyzed = new Set(
          analysesIn(scope).map((analysis) => analysis.mentionId),
        );

        return mentionsIn(scope)
          .filter((mention) => !analyzed.has(mention.id))
          // Oldest first: a backlog should drain in arrival order rather than
          // the newest batch being re-picked while older mentions never surface.
          .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
          .slice(0, limit);
      },

      async countUnanalyzed(scope) {
        const analyzed = new Set(
          analysesIn(scope).map((analysis) => analysis.mentionId),
        );
        return mentionsIn(scope).filter((mention) => !analyzed.has(mention.id))
          .length;
      },

      async createAnalysis(scope, input) {
        const value = createMentionAnalysisInputSchema.parse(input);

        const mention = mentionsIn(scope).find(
          (row) => row.id === value.mentionId,
        );
        // The scope filter is what stops an analysis being attached to another
        // organization's mention by supplying its id.
        if (!mention) throw notFound("Mention");

        const created: MentionAnalysis = {
          ...value,
          // Append-only, so the id has to differ per analysis rather than per
          // mention — re-analysing inserts beside the old row, never over it.
          id: seedId(
            `analysis:runtime:${value.mentionId}:${store().mentionAnalyses.length}`,
          ),
          organizationId: scope.organizationId,
          createdAt: nowIso(),
        };

        store().mentionAnalyses.push(created);
        return created;
      },

      async applyAnalysisOutcome(scope, mentionId, outcome) {
        const mention = mentionsIn(scope).find((row) => row.id === mentionId);
        if (!mention) throw notFound("Mention");

        return replaceRow(store().mentions, {
          ...mention,
          sentiment: outcome.sentiment,
          riskLevel: outcome.riskLevel,
          relevanceScore: outcome.relevanceScore,
          // Only from `new`. A mention somebody has already escalated,
          // dismissed, or responded to keeps the state that person set — the
          // machine does not get to reopen a decision a human made.
          status: mention.status === "new" ? outcome.status : mention.status,
          updatedAt: nowIso(),
        });
      },

      async countByProfile(scope, profileIds) {
        const wanted = new Set(profileIds);
        const counts: Record<string, number> = {};
        for (const id of profileIds) counts[id] = 0;

        for (const mention of mentionsIn(scope)) {
          const id = mention.platformProfileId;
          if (id === null || !wanted.has(id)) continue;
          counts[id] = (counts[id] ?? 0) + 1;
        }

        return counts;
      },

      async updateStatus(scope, mentionId, status) {
        const mention = mentionsIn(scope).find((row) => row.id === mentionId);
        if (!mention) throw notFound("Mention");

        return replaceRow(store().mentions, {
          ...mention,
          status,
          updatedAt: nowIso(),
        });
      },

      async latestAnalysis(scope, mentionId) {
        return (
          analysesIn(scope)
            .filter((row) => row.mentionId === mentionId)
            .sort((a, b) => Date.parse(b.analyzedAt) - Date.parse(a.analyzedAt))[0] ?? null
        );
      },
    },

    responseDrafts: {
      async list(scope, filter = {}) {
        const search = filter.search?.trim().toLowerCase();

        const rows = draftsIn(scope).filter((draft) => {
          if (filter.mentionId && draft.mentionId !== filter.mentionId) return false;
          if (filter.statuses && !filter.statuses.includes(draft.status)) return false;
          if (filter.responseTypes && !filter.responseTypes.includes(draft.responseType))
            return false;
          if (filter.assignedUserId && draft.assignedUserId !== filter.assignedUserId)
            return false;
          if (filter.generatedBy && draft.generatedBy !== filter.generatedBy) return false;
          if (search) {
            const hit =
              textIncludes(draft.draftText, search) || textIncludes(draft.finalText, search);
            if (!hit) return false;
          }
          return true;
        });

        const sorted = rows.sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        );
        const offset = filter.offset ?? 0;
        return filter.limit === undefined
          ? sorted.slice(offset)
          : sorted.slice(offset, offset + filter.limit);
      },

      async get(scope, draftId) {
        return draftsIn(scope).find((row) => row.id === draftId) ?? null;
      },

      async assign(scope, draftId, assignedUserId) {
        const draft = draftsIn(scope).find((row) => row.id === draftId);
        if (!draft) throw notFound("Response draft");

        if (assignedUserId) {
          const membership = store().memberships.find(
            (row) =>
              row.organizationId === scope.organizationId &&
              row.userId === assignedUserId &&
              row.status === "active",
          );
          if (!membership) {
            throw invalidInput("That person is not an active member of this organization.");
          }
        }

        return replaceRow(store().responseDrafts, {
          ...draft,
          assignedUserId,
          updatedAt: nowIso(),
        });
      },

      async saveFinalText(scope, draftId, finalText) {
        const draft = draftsIn(scope).find((row) => row.id === draftId);
        if (!draft) throw notFound("Response draft");

        if (!canEditDraft(draft.status)) {
          throw conflict(
            `A response that is already ${draft.status.replace(/_/g, " ")} can no longer be edited.`,
          );
        }

        return replaceRow(store().responseDrafts, {
          ...draft,
          finalText,
          updatedAt: nowIso(),
        });
      },

      async decide(scope, draftId, decision, decidedByUserId, decisionNote, finalText) {
        const draft = draftsIn(scope).find((row) => row.id === draftId);
        if (!draft) throw notFound("Response draft");

        if (!canDecideOnDraft(draft.status)) {
          throw conflict(
            `A response that is already ${draft.status.replace(/_/g, " ")} cannot be decided again.`,
          );
        }

        const timestamp = nowIso();
        const updatedDraft: ResponseDraft = {
          ...draft,
          finalText: finalText ?? draft.finalText,
          status: decision === "approved" ? "approved" : "draft",
          approvedByUserId: decision === "approved" ? decidedByUserId : null,
          approvedAt: decision === "approved" ? timestamp : null,
          updatedAt: timestamp,
        };
        replaceRow(store().responseDrafts, updatedDraft);

        const pending = orgRows(store().approvals, scope).find(
          (row) => row.responseDraftId === draftId && row.status === "pending",
        );

        let updatedApproval: Approval | null = null;
        if (pending) {
          updatedApproval = replaceRow(store().approvals, {
            ...pending,
            status: decision,
            decisionNote: decisionNote ?? null,
            decidedAt: timestamp,
            updatedAt: timestamp,
          });
        }

        return { draft: updatedDraft, approval: updatedApproval };
      },

      async listApprovals(scope, draftId) {
        return orgRows(store().approvals, scope)
          .filter((row) => row.responseDraftId === draftId)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      },
    },

    escalations: {
      async list(scope, filter = {}) {
        const search = filter.search?.trim().toLowerCase();

        const rows = orgRows(store().escalations, scope).filter((escalation) => {
          if (filter.mentionId && escalation.mentionId !== filter.mentionId) return false;
          if (filter.statuses && !filter.statuses.includes(escalation.status)) return false;
          if (filter.categories && !filter.categories.includes(escalation.category)) return false;
          if (filter.severities && !filter.severities.includes(escalation.severity)) return false;
          if (filter.assignedUserId && escalation.assignedUserId !== filter.assignedUserId)
            return false;
          if (search) {
            const hit =
              textIncludes(escalation.title, search) || textIncludes(escalation.summary, search);
            if (!hit) return false;
          }
          return true;
        });

        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;
        const sorted = rows.sort(
          (a, b) =>
            severityOrder[a.severity] - severityOrder[b.severity] ||
            Date.parse(a.dueAt ?? a.createdAt) - Date.parse(b.dueAt ?? b.createdAt),
        );

        const offset = filter.offset ?? 0;
        return filter.limit === undefined
          ? sorted.slice(offset)
          : sorted.slice(offset, offset + filter.limit);
      },

      async get(scope, escalationId) {
        return orgRows(store().escalations, scope).find((row) => row.id === escalationId) ?? null;
      },

      async create(scope, input) {
        const value = createEscalationInputSchema.parse(input);

        const mention = mentionsIn(scope).find((row) => row.id === value.mentionId);
        if (!mention) throw notFound("Mention");

        // One escalation per mention. Two open cases for one review is a queue
        // nobody trusts, and re-running an analysis must not produce that.
        const existing = orgRows(store().escalations, scope).find(
          (row) => row.mentionId === value.mentionId,
        );
        if (existing) return { escalation: existing, created: false };

        const created: Escalation = {
          id: seedId(`escalation:runtime:${value.mentionId}`),
          organizationId: scope.organizationId,
          mentionId: value.mentionId,
          category: value.category,
          severity: value.severity,
          status: "open",
          title: value.title,
          summary: value.summary,
          // Unassigned on purpose: an unowned item in the escalations centre
          // is the "somebody must look at this" signal. Defaulting an owner
          // would make it look handled.
          assignedUserId: null,
          dueAt: value.dueAt,
          resolvedAt: null,
          resolutionNote: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        store().escalations.push(created);
        return { escalation: created, created: true };
      },

      async updateStatus(scope, escalationId, status, resolutionNote) {
        const escalation = orgRows(store().escalations, scope).find(
          (row) => row.id === escalationId,
        );
        if (!escalation) throw notFound("Escalation");

        if (requiresResolutionNote(status) && !resolutionNote?.trim()) {
          throw invalidInput("Add a resolution note before resolving this escalation.", {
            resolutionNote: "A resolution note is required.",
          });
        }

        const timestamp = nowIso();
        const updated: Escalation = {
          ...escalation,
          status,
          resolutionNote: resolutionNote?.trim() || escalation.resolutionNote,
          resolvedAt: isEscalationClosed(status) ? timestamp : null,
          updatedAt: timestamp,
        };

        return replaceRow(store().escalations, updated);
      },

      async assign(scope, escalationId, assignedUserId) {
        const escalation = orgRows(store().escalations, scope).find(
          (row) => row.id === escalationId,
        );
        if (!escalation) throw notFound("Escalation");

        if (assignedUserId) {
          const membership = store().memberships.find(
            (row) =>
              row.organizationId === scope.organizationId &&
              row.userId === assignedUserId &&
              row.status === "active",
          );
          if (!membership) {
            throw invalidInput("That person is not an active member of this organization.");
          }
        }

        return replaceRow(store().escalations, {
          ...escalation,
          assignedUserId,
          updatedAt: nowIso(),
        });
      },
    },

    automationRules: {
      async list(scope, filter = {}) {
        const search = filter.search?.trim().toLowerCase();

        return orgRows(store().automationRules, scope)
          .filter((rule) => {
            if (filter.statuses && !filter.statuses.includes(rule.status)) return false;
            if (search) {
              const hit =
                textIncludes(rule.name, search) || textIncludes(rule.description, search);
              if (!hit) return false;
            }
            return true;
          })
          .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
      },

      async get(scope, ruleId) {
        return orgRows(store().automationRules, scope).find((row) => row.id === ruleId) ?? null;
      },

      async setEnabled(scope, ruleId, enabled) {
        const rule = orgRows(store().automationRules, scope).find((row) => row.id === ruleId);
        if (!rule) throw notFound("Automation rule");

        // A draft rule has never been reviewed; enabling it straight from the
        // list would put untested automation into production.
        if (enabled && rule.status === "draft") {
          throw conflict("Finish and simulate this draft rule before enabling it.");
        }

        const updated: AutomationRule = {
          ...rule,
          status: enabled ? "active" : "inactive",
          updatedAt: nowIso(),
        };
        return replaceRow(store().automationRules, updated);
      },
    },

    brandVoice: {
      async get(scope) {
        return (
          store().brandVoiceProfiles.find(
            (row) => row.organizationId === scope.organizationId,
          ) ?? null
        );
      },

      async save(scope, input) {
        // Re-parse rather than trust the caller's shape: this is what actually
        // enforces phrase deduplication, trim-and-drop-blanks, the length caps,
        // and the approved/prohibited collision rule. A caller reaching the
        // repository directly bypasses none of that.
        const value = updateBrandVoiceInputSchema.parse(input);

        const existing = store().brandVoiceProfiles.find(
          (row) => row.organizationId === scope.organizationId,
        );

        if (!existing) {
          const created: BrandVoiceProfile = {
            id: seedId(`brand_voice:${scope.organizationId}`),
            organizationId: scope.organizationId,
            name: value.name,
            axes: { ...value.axes },
            approvedPhrases: [...value.approvedPhrases],
            prohibitedPhrases: [...value.prohibitedPhrases],
            version: 1,
            updatedByUserId: scope.userId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };

          store().brandVoiceProfiles.push(created);
          return created;
        }

        // A save that changes nothing returns the stored row untouched.
        // `response_drafts.brand_voice_version` records which voice produced a
        // draft, so bumping on a no-op would invalidate the provenance of every
        // existing draft because somebody pressed Save twice.
        if (matchesStored(existing, value)) return existing;

        const updated: BrandVoiceProfile = {
          ...existing,
          name: value.name,
          axes: { ...value.axes },
          approvedPhrases: [...value.approvedPhrases],
          prohibitedPhrases: [...value.prohibitedPhrases],
          version: existing.version + 1,
          updatedByUserId: scope.userId,
          updatedAt: nowIso(),
        };

        return replaceRow(store().brandVoiceProfiles, updated);
      },
    },

    auditEvents: {
      async list(scope, filter = {}) {
        return orgRows(store().auditEvents, scope)
          .filter((event) => {
            if (filter.entityType && event.entityType !== filter.entityType) return false;
            if (filter.entityId && event.entityId !== filter.entityId) return false;
            if (filter.eventTypes && !filter.eventTypes.includes(event.eventType)) return false;
            if (filter.actorUserId && event.actorUserId !== filter.actorUserId) return false;
            if (filter.occurredAfter && event.occurredAt < filter.occurredAfter) return false;
            return true;
          })
          .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
          .slice(0, filter.limit ?? 50);
      },

      async record(scope, input) {
        const parsed = recordAuditEventInputSchema.safeParse(input);
        if (!parsed.success) {
          throw invalidInput("That audit event could not be recorded.");
        }

        const event: AuditEvent = auditEventSchema.parse({
          ...parsed.data,
          id: seedId(
            `audit:runtime:${scope.organizationId}:${parsed.data.entityId}:${parsed.data.eventType}:${store().auditEvents.length}`,
          ),
          organizationId: scope.organizationId,
          occurredAt: parsed.data.occurredAt ?? nowIso(),
        });

        // Append-only: push, never replace.
        store().auditEvents.push(event);
        return event;
      },
    },
  };
}

export type {
  Approval,
  AutomationRule,
  Escalation,
  Location,
  Mention,
  PlatformConnection,
  PlatformProfile,
  ResponseDraft,
};
