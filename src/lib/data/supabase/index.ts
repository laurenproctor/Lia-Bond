import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BRAND_VOICE_AXIS_KEYS,
  canDecideOnDraft,
  createEscalationInputSchema,
  createLocationInputSchema,
  createMentionAnalysisInputSchema,
  createMentionInputSchema,
  finishAnalysisRunInputSchema,
  finishSyncRunInputSchema,
  ingestMentionInputSchema,
  isAnalysisRunStale,
  isEscalationClosed,
  isSuccessfulAnalysisRun,
  isSuccessfulSyncRun,
  isSyncRunStale,
  firstIncompleteStep,
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
  type BrandVoiceProfile,
  type Invitation,
  type InvitationPreview,
  type Mention,
  type MentionAnalysis,
  type OrganizationOnboarding,
  type PlatformSyncRun,
  type ResponseDraft,
  type SyncResource,
  type UpdateBrandVoiceInput,
} from "@/domain";
import { conflict, DataError, invalidInput, notFound } from "@/lib/data/errors";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  computeLocationMetrics,
  computeOrganizationMetrics,
  countByStatus,
  isOpenStatus,
  rankByUrgency,
} from "@/lib/data/metrics";
import {
  AnalysisRunInProgressError,
  SyncRunInProgressError,
  type LiaDataSource,
  type OrganizationScope,
  type ProfileSyncState,
} from "@/lib/data/types";
import {
  toAnalysisRun,
  toApproval,
  toAuditEvent,
  toAutomationRule,
  toBrandVoiceProfile,
  toEscalation,
  toInvitation,
  toLocation,
  toMembership,
  toMention,
  toMentionAnalysis,
  toOAuthState,
  toOrganization,
  toOrganizationOnboarding,
  toPlatformConnection,
  toPlatformProfile,
  toPlatformSyncRun,
  toResponseDraft,
  toUser,
} from "@/lib/data/supabase/mappers";
import { createMonitoringRepositories } from "@/lib/data/supabase/monitoring";

/**
 * The Supabase adapter.
 *
 * Every query filters on `organization_id` explicitly even though row-level
 * security already would. That redundancy is deliberate: the filter documents
 * the tenant boundary at the call site, and it keeps the adapter correct if it
 * is ever run under the service role, where RLS does not apply.
 *
 * NOTE: this adapter has not been executed against a live database. The
 * environment used to build workflow 01 had no PostgreSQL server available, so
 * it is verified by type-checking and by the schema it was written against, not
 * by integration tests. See docs/architecture/current-state.md.
 */

type Row = Record<string, unknown>;

function rows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

/**
 * Explicit upper bound on `organizations_with_unanalyzed_mentions()`.
 *
 * Moving the anti-join into that function (see the migration) fixed the
 * failure class where an unbounded `.select()` on `mentions` truncates
 * silently past PostgREST's default row cap — but a `returns table` function
 * is still subject to the same cap if nothing overrides it, so an explicit,
 * documented ceiling replaces an implicit, undocumented one rather than
 * eliminating the ceiling outright.
 *
 * Five figures because the result here is "organizations with an analysis
 * backlog," not "mentions": this holds for any tenant count Lia is plausibly
 * operating at while this comment is accurate. What breaks first if it stops
 * holding: `listWithUnanalyzedMentions` truncates the same way the pre-fix
 * version did, just at ~5,000 tenants with a simultaneous backlog instead of
 * ~1,000 mentions — silently, unless the warning below fires.
 */
const MAX_ORGANIZATIONS_PER_ANALYSIS_SWEEP = 5000;

/**
 * A URL-safe slug for a location, unique within its organization.
 *
 * Duplicated deliberately rather than shared with the demo adapter: the two
 * adapters are meant to be independently readable, and a shared helper here
 * would be the first step towards shared query logic that is not shareable.
 */
function uniqueSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "location";

  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${base}-${taken.size + 1}`;
}

/** Turn a PostgREST error into a domain error without leaking driver detail. */
function fail(error: { message: string; code?: string }, action: string): never {
  if (error.code === "23505") {
    throw conflict("That record already exists.");
  }
  if (error.code === "42501" || error.code === "PGRST301") {
    throw new DataError("forbidden", "You don't have permission to do that.");
  }
  throw new DataError("unavailable", `Could not ${action}. Please try again.`);
}

/**
 * Whether a save would change anything.
 *
 * Order counts as a change for phrase lists: the order is what somebody sees
 * when they read the list back. Duplicated deliberately rather than shared
 * with the demo adapter's `matchesStored` — see the note on `uniqueSlug` above.
 */
function matchesStoredProfile(
  stored: BrandVoiceProfile,
  input: UpdateBrandVoiceInput,
): boolean {
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
 * Sentinel for "stamp this column with now(), unless it already has a value".
 *
 * A unique symbol rather than a magic string, so it can never collide with a
 * value somebody genuinely wants to write.
 */
const nowIfUnset = Symbol("now-if-unset");

export function createSupabaseDataSource(client: SupabaseClient): LiaDataSource {
  /** Base selector for an organization-owned table. */
  const from = (table: string, scope: OrganizationScope) =>
    client.from(table).select("*").eq("organization_id", scope.organizationId);

  /**
   * Refuse to strip the last active owner.
   *
   * The database enforces this with a deferred constraint trigger, which is
   * the actual guarantee. This exists so the failure is a sentence rather than
   * a 23514 at commit time — and it returns early when the target is not an
   * owner, so the ordinary case costs one indexed read.
   */
  async function assertNotLastOwner(
    scope: OrganizationScope,
    userId: string,
  ): Promise<void> {
    const { data, error } = await client
      .from("memberships")
      .select("user_id, role, status")
      .eq("organization_id", scope.organizationId)
      .eq("role", "owner")
      .eq("status", "active");

    if (error) fail(error, "check the owners");

    const owners = rows(data);
    const isTarget = owners.some((row) => row.user_id === userId);
    if (!isTarget) return;

    if (owners.length <= 1) {
      throw conflict(
        "This is the only owner. Make somebody else an owner first, then change this one.",
      );
    }
  }

  /**
   * Apply one onboarding transition.
   *
   * `nowIfUnset` is what makes every transition idempotent: a step that already
   * carries a timestamp keeps it, so a double-submitted form or a refreshed
   * confirmation does not restamp progress and make the trail claim somebody
   * completed a step later than they did. A plain `now()` would rewrite it.
   *
   * The row is read first because that resolution needs the current values.
   * That is a read-then-write, but it is not a race worth guarding: the two
   * writers are the same person in two tabs, and both are writing the same
   * forward transition.
   */
  async function updateOnboarding(
    scope: OrganizationScope,
    patch: Record<string, unknown>,
  ): Promise<OrganizationOnboarding> {
    const { data: existing, error: readError } = await client
      .from("organization_onboarding")
      .select("*")
      .eq("organization_id", scope.organizationId)
      .maybeSingle();

    if (readError) fail(readError, "load setup progress");
    if (!existing) throw notFound("Setup progress");

    const row = existing as Row;
    const stamp = new Date().toISOString();
    const resolved: Record<string, unknown> = {};

    for (const [column, value] of Object.entries(patch)) {
      resolved[column] = value === nowIfUnset ? (row[column] ?? stamp) : value;
    }

    const { data, error } = await client
      .from("organization_onboarding")
      .update(resolved)
      .eq("organization_id", scope.organizationId)
      .select("*")
      .maybeSingle();

    if (error) fail(error, "save setup progress");
    // Null means the update matched no row: RLS refused it because the caller
    // is not an owner or admin here.
    if (!data) throw new DataError("forbidden", "Your role cannot change setup progress.");
    return toOrganizationOnboarding(data as Row);
  }

  /**
   * The privileged client, built on first use.
   *
   * Two tables are unreachable from a user session by design:
   * `platform_connection_secrets` and `oauth_states` both have row-level
   * security enabled with zero policies. That is the point — an application
   * user has no legitimate read on either — but it means the server has to
   * reach them with the service role, which bypasses RLS entirely.
   *
   * Every call site that uses this first establishes the tenant boundary
   * against `client` (the caller's own session), so the service role is only
   * ever used to touch rows the caller has already been proven to own. Built
   * lazily so a deployment with no service-role key still runs everything else.
   */
  let privileged: SupabaseClient | null = null;
  const serviceClient = (): SupabaseClient => {
    privileged ??= createSupabaseServiceClient();
    return privileged;
  };

  /** The analysis run currently holding this organization's lock, if any. */
  async function findActiveAnalysisRun(
    scope: OrganizationScope,
  ): Promise<AnalysisRun | null> {
    const { data, error } = await from("analysis_runs", scope)
      .eq("status", "running")
      .maybeSingle();

    if (error) fail(error, "check for a running analysis");
    return data ? toAnalysisRun(data as Row) : null;
  }

  /** The run currently holding the lock for this profile, if there is one. */
  async function findActiveRun(
    scope: OrganizationScope,
    profileId: string,
    resource: SyncResource,
  ): Promise<PlatformSyncRun | null> {
    const { data, error } = await from("platform_sync_runs", scope)
      .eq("platform_profile_id", profileId)
      .eq("resource", resource)
      .eq("status", "running")
      .maybeSingle();

    if (error) fail(error, "check for a running sync");
    return data ? toPlatformSyncRun(data as Row) : null;
  }

  /** Mention ids that already carry an analysis. One indexed column read. */
  async function fetchAnalyzedMentionIds(
    scope: OrganizationScope,
  ): Promise<string[]> {
    const { data, error } = await client
      .from("mention_analyses")
      .select("mention_id")
      .eq("organization_id", scope.organizationId);

    if (error) fail(error, "load the analyzed mentions");

    // Distinct: the table is append-only, so a re-analysed mention appears
    // more than once and would otherwise inflate the backlog arithmetic.
    return [
      ...new Set(
        rows(data).flatMap((row) =>
          typeof row.mention_id === "string" ? [row.mention_id] : [],
        ),
      ),
    ];
  }

  async function fetchMentions(scope: OrganizationScope): Promise<Mention[]> {
    const { data, error } = await from("mentions", scope);
    if (error) fail(error, "load mentions");
    return rows(data).map(toMention);
  }

  async function fetchAnalyses(scope: OrganizationScope): Promise<MentionAnalysis[]> {
    const { data, error } = await from("mention_analyses", scope);
    if (error) fail(error, "load analyses");
    return rows(data).map(toMentionAnalysis);
  }

  async function fetchDrafts(scope: OrganizationScope): Promise<ResponseDraft[]> {
    const { data, error } = await from("response_drafts", scope);
    if (error) fail(error, "load responses");
    return rows(data).map(toResponseDraft);
  }

  /** Confirms the user is an active member before an assignment is accepted. */
  async function assertActiveMember(
    scope: OrganizationScope,
    userId: string,
  ): Promise<void> {
    const { data, error } = await client
      .from("memberships")
      .select("id")
      .eq("organization_id", scope.organizationId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (error) fail(error, "verify membership");
    if (!data) {
      throw invalidInput("That person is not an active member of this organization.");
    }
  }

  return {
    kind: "supabase",

    organizations: {
      async listForUser(userId) {
        const { data, error } = await client
          .from("memberships")
          .select("role, status, organizations(*)")
          .eq("user_id", userId)
          .eq("status", "active");

        if (error) fail(error, "load organizations");

        return rows(data)
          .flatMap((row) => {
            const organization = row.organizations as Row | null;
            if (!organization) return [];
            return [
              {
                organization: toOrganization(organization),
                role: row.role as never,
                status: row.status as never,
              },
            ];
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
        // An RPC, not two inserts. `organizations` has no INSERT policy and
        // `memberships_insert_admins` requires already being an admin, so a
        // brand-new user satisfies neither — and the two rows must land
        // together or the organization is unreachable by anyone. A function
        // body is a transaction, which is the only place this codebase has
        // that guarantee (D17).
        const { data, error } = await client.rpc("provision_organization", {
          organization_name: input.name,
          organization_industry: input.industry ?? "Restaurant group",
          organization_timezone: input.timezone ?? "UTC",
          organization_language: input.language ?? "en-US",
        });

        if (error) fail(error, "create that organization");

        if (typeof data !== "string") {
          throw new DataError(
            "unavailable",
            "Could not create that organization. Please try again.",
          );
        }

        const created = await this.getById(data, input.userId);
        if (!created) throw notFound("Organization");
        return created;
      },

      async update(scope, input) {
        const { data, error } = await client
          .from("organizations")
          .update({
            name: input.name,
            website_url: input.websiteUrl,
            industry: input.industry,
            default_timezone: input.defaultTimezone,
            default_language: input.defaultLanguage,
          })
          // Scoped by primary key rather than by `organization_id`: this *is*
          // the tenant root. `organizations_update_admins` re-checks the role,
          // so a scope forged past the application layer still writes nothing.
          .eq("id", scope.organizationId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "save that organization");
        // Null means the update matched no row — the caller is not an owner or
        // admin of this organization, and RLS filtered it out.
        if (!data) throw notFound("Organization");
        return toOrganization(data as Row);
      },
      // Deliberately unscoped and run under the service-role client — see the
      // doc comment on `listWithUnanalyzedMentions` in types.ts and on
      // `serviceClient` above.
      //
      // Calls a database function (`supabase/migrations/…
      // _analyze_mentions_organization_scan.sql`) rather than reading
      // `mentions` and `mention_analyses` in full and folding the anti-join
      // into application code, which was this method's first version. Both
      // tables are unbounded — they grow with product usage — and a plain
      // `.select()` with no `.range()` is capped by PostgREST at a fixed row
      // count; past that cap the read truncates with no error, and an
      // organization whose unanalysed mentions fell outside the returned page
      // would simply stop being swept, silently, forever. The function moves
      // the anti-join into Postgres so the result set this reads is
      // organizations — small, bounded by tenant count — never mentions.
      async listWithUnanalyzedMentions() {
        // `.range()` is explicit rather than omitted: a `returns table`
        // function is still subject to PostgREST's own default cap, so
        // leaving it implicit would just move the silent-truncation risk
        // this method exists to fix down one layer. See
        // `MAX_ORGANIZATIONS_PER_ANALYSIS_SWEEP`'s own comment for the
        // reasoning behind the number and what breaks first.
        const { data, error } = await serviceClient()
          .rpc("organizations_with_unanalyzed_mentions")
          .range(0, MAX_ORGANIZATIONS_PER_ANALYSIS_SWEEP - 1);

        if (error) fail(error, "find organizations with unanalysed mentions");
        const returned = rows(data);

        // Not proof of truncation — the cap could land exactly on the true
        // count — but the only signal available without a second, costlier
        // count query, and cheap insurance against the exact failure mode
        // this method was rewritten to fix. No tenant identifier or count
        // in the message: this is a capacity signal for an operator to act
        // on, not a coverage report.
        if (returned.length >= MAX_ORGANIZATIONS_PER_ANALYSIS_SWEEP) {
          console.warn(
            "[data:supabase] organizations_with_unanalyzed_mentions reached its row cap; the analyse-mentions sweep may be missing organizations",
          );
        }

        return [
          ...new Set(
            returned.flatMap((row) =>
              typeof row.organization_id === "string" ? [row.organization_id] : [],
            ),
          ),
        ];
      },
    },

    onboarding: {
      async get(scope) {
        const { data, error } = await client
          .from("organization_onboarding")
          .select("*")
          .eq("organization_id", scope.organizationId)
          .maybeSingle();

        if (error) fail(error, "load setup progress");
        return data ? toOrganizationOnboarding(data as Row) : null;
      },

      async create(scope) {
        // `provision_organization` already writes this row in the same
        // transaction as the organization, so reaching here means the row is
        // genuinely absent. `on conflict` is expressed as an upsert rather than
        // a read-then-insert: two tabs opening onboarding at once would
        // otherwise race, and the loser would see a unique-violation error for
        // getting exactly what it asked for.
        const { data, error } = await client
          .from("organization_onboarding")
          .upsert(
            { organization_id: scope.organizationId },
            { onConflict: "organization_id", ignoreDuplicates: false },
          )
          .select("*")
          .single();

        if (error) fail(error, "start setup");
        return toOrganizationOnboarding(data as Row);
      },

      completeOrganizationStep(scope, organizationSize) {
        return updateOnboarding(scope, {
          organization_completed_at: nowIfUnset,
          organization_size: organizationSize,
          current_step: "connect_sources",
        });
      },

      completeSourceStep(scope) {
        // Clears the skip. Somebody who continued without connecting and then
        // came back and connected has not skipped the step, and leaving both
        // timestamps set would violate the table's own check constraint.
        return updateOnboarding(scope, {
          source_completed_at: nowIfUnset,
          source_skipped_at: null,
          current_step: "locations",
        });
      },

      skipSourceStep(scope) {
        return updateOnboarding(scope, {
          source_skipped_at: nowIfUnset,
          source_completed_at: null,
          current_step: "locations",
        });
      },

      completeLocationsStep(scope) {
        return updateOnboarding(scope, {
          locations_completed_at: nowIfUnset,
          locations_skipped_at: null,
          current_step: "brand_voice",
        });
      },

      skipLocationsStep(scope) {
        return updateOnboarding(scope, {
          locations_skipped_at: nowIfUnset,
          locations_completed_at: null,
          current_step: "brand_voice",
        });
      },

      completeBrandVoiceStep(scope) {
        return updateOnboarding(scope, {
          brand_voice_completed_at: nowIfUnset,
          current_step: "team",
        });
      },

      completeTeamStep(scope) {
        return updateOnboarding(scope, {
          team_completed_at: nowIfUnset,
          team_skipped_at: null,
          current_step: "ready",
        });
      },

      skipTeamStep(scope) {
        return updateOnboarding(scope, {
          team_skipped_at: nowIfUnset,
          team_completed_at: null,
          current_step: "ready",
        });
      },

      async completeOnboarding(scope) {
        const current = await this.get(scope);
        if (!current) throw notFound("Setup progress");
        // Already finished. Returned rather than rewritten so a resubmitted
        // form does not restamp `completedAt` and make the trail claim setup
        // finished later than it did.
        if (current.status === "completed") return current;

        const unfinished = firstIncompleteStep(current);
        if (unfinished) {
          throw conflict("Finish the earlier setup steps before completing setup.");
        }

        return updateOnboarding(scope, {
          status: "completed",
          completed_at: nowIfUnset,
          current_step: "ready",
        });
      },

      markReadyViewed(scope) {
        return updateOnboarding(scope, { ready_viewed_at: nowIfUnset });
      },
    },

    users: {
      async updateOwnProfile(userId, input) {
        // `full_name` is a generated column, so only the parts are written and
        // the returned row already carries the recomposed display name. RLS
        // (`users_update_self`) refuses any row but the caller's own.
        const { data, error } = await client
          .from("users")
          .update({
            first_name: input.firstName,
            last_name: input.lastName,
          })
          .eq("id", userId)
          .select("*")
          .single();

        if (error) fail(error, "update your profile");
        return toUser(data as Row);
      },

      async updateOwnAvatar(userId, avatarUrl) {
        const { data, error } = await client
          .from("users")
          .update({ avatar_url: avatarUrl })
          .eq("id", userId)
          .select("*")
          .single();

        if (error) fail(error, "update your photo");
        return toUser(data as Row);
      },
    },

    memberships: {
      async getActiveMembership(organizationId, userId) {
        const { data, error } = await client
          .from("memberships")
          .select("*")
          .eq("organization_id", organizationId)
          .eq("user_id", userId)
          .eq("status", "active")
          .maybeSingle();

        if (error) fail(error, "verify membership");
        return data ? toMembership(data as Row) : null;
      },

      async listMembers(scope) {
        const { data, error } = await client
          .from("memberships")
          .select("*, users(*)")
          .eq("organization_id", scope.organizationId);

        if (error) fail(error, "load members");

        return rows(data).flatMap((row) => {
          const user = row.users as Row | null;
          if (!user) return [];
          return [{ ...toMembership(row), user: toUser(user) }];
        });
      },

      async listAssignableUsers(scope) {
        const members = await this.listMembers(scope);
        return members
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.user)
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
      },

      async countActiveOwners(scope) {
        const { count, error } = await client
          .from("memberships")
          .select("user_id", { count: "exact", head: true })
          .eq("organization_id", scope.organizationId)
          .eq("role", "owner")
          .eq("status", "active");

        if (error) fail(error, "count the owners");
        return count ?? 0;
      },

      async updateRole(scope, userId, role) {
        // Checked here as well as by the database trigger. The trigger is the
        // guarantee; this is the sentence the user reads. A deferred constraint
        // failure arrives as an opaque 23514 at commit, which is true but
        // useless to somebody trying to reorganise their team.
        if (role !== "owner") await assertNotLastOwner(scope, userId);

        const { data, error } = await client
          .from("memberships")
          .update({ role })
          .eq("organization_id", scope.organizationId)
          .eq("user_id", userId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "change that role");
        if (!data) throw notFound("Membership");
        return toMembership(data as Row);
      },

      async updateStatus(scope, userId, status) {
        if (status !== "active") await assertNotLastOwner(scope, userId);

        const { data, error } = await client
          .from("memberships")
          .update({ status })
          .eq("organization_id", scope.organizationId)
          .eq("user_id", userId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "change that membership");
        if (!data) throw notFound("Membership");
        return toMembership(data as Row);
      },

      async remove(scope, userId) {
        await assertNotLastOwner(scope, userId);

        const { error } = await client
          .from("memberships")
          .delete()
          .eq("organization_id", scope.organizationId)
          .eq("user_id", userId);

        if (error) fail(error, "remove that member");
      },
    },

    invitations: {
      async create(scope, input) {
        const email = input.email.trim().toLowerCase();

        // Read first so the common mistake gets a sentence rather than a
        // unique-violation. The index is still what guarantees it: two admins
        // inviting the same person at once will both pass this check, and one
        // of them will lose at the database.
        const { data: existingMember, error: memberError } = await client
          .from("memberships")
          .select("user_id, users!inner(email)")
          .eq("organization_id", scope.organizationId)
          .eq("users.email", email)
          .maybeSingle();

        if (memberError) fail(memberError, "check the current members");
        if (existingMember) {
          throw conflict("That person is already a member of this organization.");
        }

        const { data, error } = await client
          .from("invitations")
          .insert({
            organization_id: scope.organizationId,
            email,
            role: input.role,
            token_hash: input.tokenHash,
            invited_by_user_id: input.invitedByUserId,
            expires_at: input.expiresAt,
          })
          .select("*")
          .single();

        if (error) {
          // 23505 here is the partial unique index, which means one specific
          // thing. `fail` would flatten it to "that record already exists".
          if (error.code === "23505") {
            throw conflict("That person already has a pending invitation.");
          }
          fail(error, "send that invitation");
        }

        return toInvitation(data as Row);
      },

      async listPending(scope) {
        const { data, error } = await client
          .from("invitations")
          .select("*, invited_by:users!invitations_invited_by_user_id_fkey(full_name)")
          .eq("organization_id", scope.organizationId)
          .eq("status", "pending")
          .order("created_at", { ascending: false });

        if (error) fail(error, "load pending invitations");

        return rows(data).map((row) => {
          const inviter = row.invited_by as Row | null;
          return {
            ...toInvitation(row),
            invitedByName: (inviter?.full_name as string | undefined) ?? null,
          };
        });
      },

      async revoke(scope, invitationId) {
        // Conditional on `pending`, so revoking something already accepted
        // cannot silently appear to succeed.
        const { data, error } = await client
          .from("invitations")
          .update({ status: "revoked", revoked_at: new Date().toISOString() })
          .eq("organization_id", scope.organizationId)
          .eq("id", invitationId)
          .eq("status", "pending")
          .select("*")
          .maybeSingle();

        if (error) fail(error, "revoke that invitation");
        if (!data) throw notFound("Pending invitation");
        return toInvitation(data as Row);
      },

      async preview(tokenHash) {
        // An RPC rather than a select: the caller may not be signed in, and
        // even signed in they are not a member of the organization yet, so no
        // policy on `invitations` would return the row. The function is
        // SECURITY DEFINER and keyed by the token hash.
        const { data, error } = await client.rpc("invitation_preview", {
          invitation_token_hash: tokenHash,
        });

        if (error) fail(error, "read that invitation");

        const row = rows(data)[0];
        if (!row) return null;

        return {
          organizationName: String(row.organization_name),
          email: String(row.invited_email),
          role: row.invited_role as Invitation["role"],
          state: row.invitation_state as InvitationPreview["state"],
        };
      },

      // The `userId` the interface offers is deliberately not accepted here.
      // `accept_invitation` reads `auth.uid()` itself, so a caller cannot join
      // on somebody else's behalf even if this adapter were wrong. The
      // parameter stays in the interface for the demo adapter, which has no
      // session to read and must be told who is acting.
      async accept(tokenHash) {
        const { data, error } = await client.rpc("accept_invitation", {
          invitation_token_hash: tokenHash,
        });

        if (error) {
          // Unknown, expired, spent, revoked, and addressed to somebody else
          // all raise P0002 from the function, by design.
          if (error.code === "P0002") {
            throw invalidInput("That invitation cannot be accepted.");
          }
          fail(error, "accept that invitation");
        }

        if (typeof data !== "string") {
          throw new DataError("unavailable", "Could not accept that invitation. Please try again.");
        }

        return { organizationId: data };
      },
    },

    locations: {
      async list(scope) {
        const { data, error } = await from("locations", scope).order("name");
        if (error) fail(error, "load locations");
        return rows(data).map(toLocation);
      },

      async get(scope, locationId) {
        const { data, error } = await from("locations", scope).eq("id", locationId).maybeSingle();
        if (error) fail(error, "load the location");
        return data ? toLocation(data as Row) : null;
      },

      async metrics(scope) {
        const [locations, mentions, drafts] = await Promise.all([
          this.list(scope),
          fetchMentions(scope),
          fetchDrafts(scope),
        ]);
        return computeLocationMetrics(locations, mentions, drafts);
      },

      async updateManager(scope, locationId, managerUserId) {
        if (managerUserId) await assertActiveMember(scope, managerUserId);

        const { data, error } = await client
          .from("locations")
          .update({ manager_user_id: managerUserId })
          .eq("organization_id", scope.organizationId)
          .eq("id", locationId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "update the location manager");
        if (!data) throw notFound("Location");
        return toLocation(data as Row);
      },

      async create(scope, input) {
        const value = createLocationInputSchema.parse(input);
        if (value.managerUserId) await assertActiveMember(scope, value.managerUserId);

        const { data: existing, error: slugError } = await client
          .from("locations")
          .select("slug")
          .eq("organization_id", scope.organizationId);

        if (slugError) fail(slugError, "create the location");
        const taken = new Set(rows(existing).map((row) => String(row.slug)));
        const slug = value.slug ?? uniqueSlug(value.name, taken);

        const { data, error } = await client
          .from("locations")
          .insert({
            organization_id: scope.organizationId,
            name: value.name,
            slug,
            address_line1: value.addressLine1,
            address_line2: value.addressLine2,
            city: value.city,
            region: value.region,
            postal_code: value.postalCode,
            country_code: value.countryCode,
            timezone: value.timezone,
            status: value.status,
            manager_user_id: value.managerUserId,
          })
          .select("*")
          .maybeSingle();

        if (error) fail(error, "create the location");
        if (!data) throw notFound("Location");
        return toLocation(data as Row);
      },
    },

    platformConnections: {
      async list(scope) {
        const { data, error } = await from("platform_connections", scope).order("platform");
        if (error) fail(error, "load integrations");
        return rows(data).map(toPlatformConnection);
      },
      async get(scope, connectionId) {
        const { data, error } = await from("platform_connections", scope)
          .eq("id", connectionId)
          .maybeSingle();
        if (error) fail(error, "load the integration");
        return data ? toPlatformConnection(data as Row) : null;
      },

      async getByPlatform(scope, platform) {
        const { data, error } = await from("platform_connections", scope)
          .eq("platform", platform)
          .maybeSingle();
        if (error) fail(error, "load the integration");
        return data ? toPlatformConnection(data as Row) : null;
      },

      async upsert(scope, input) {
        const value = upsertPlatformConnectionInputSchema.parse(input);

        // Upsert on (organization_id, platform), matching the unique index.
        // Reauthorizing must update the existing row: every platform_profiles
        // row references this id, and inserting a second connection would
        // orphan every mapping the user made.
        const { data, error } = await client
          .from("platform_connections")
          .upsert(
            {
              organization_id: scope.organizationId,
              platform: value.platform,
              external_account_id: value.externalAccountId,
              external_account_name: value.externalAccountName,
              status: value.status,
              capabilities: value.capabilities,
              token_expires_at: value.tokenExpiresAt,
              granted_scopes: value.grantedScopes,
              provider_metadata: value.providerMetadata,
              connected_by_user_id: value.connectedByUserId,
              connected_at: value.connectedAt,
              // Reconnecting clears the previous failure, so a fixed problem
              // does not sit next to a healthy badge.
              disconnected_at: null,
              last_error_code: null,
              last_error_message: null,
            },
            { onConflict: "organization_id,platform" },
          )
          .select("*")
          .maybeSingle();

        if (error) fail(error, "save the integration");
        if (!data) throw notFound("Platform connection");
        return toPlatformConnection(data as Row);
      },

      async updateHealth(scope, connectionId, update) {
        const { data, error } = await client
          .from("platform_connections")
          .update({
            last_health_check_at: update.lastHealthCheckAt,
            last_health_status: update.lastHealthStatus,
            last_error_code: update.lastErrorCode,
            last_error_message: update.lastErrorMessage,
            status: update.status,
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", connectionId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "record connection health");
        if (!data) throw notFound("Platform connection");
        return toPlatformConnection(data as Row);
      },

      async markDisconnected(scope, connectionId) {
        const { data, error } = await client
          .from("platform_connections")
          .update({
            status: "disconnected",
            disconnected_at: new Date().toISOString(),
            token_expires_at: null,
            granted_scopes: [],
            last_health_status: null,
            last_error_code: null,
            last_error_message: null,
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", connectionId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "disconnect the integration");
        if (!data) throw notFound("Platform connection");
        return toPlatformConnection(data as Row);
      },
    },

    platformProfiles: {
      async list(scope) {
        const { data, error } = await from("platform_profiles", scope);
        if (error) fail(error, "load profiles");
        return rows(data).map(toPlatformProfile);
      },
      async listForConnection(scope, connectionId) {
        const { data, error } = await from("platform_profiles", scope).eq(
          "platform_connection_id",
          connectionId,
        );
        if (error) fail(error, "load profiles");
        return rows(data).map(toPlatformProfile);
      },

      async upsert(scope, input) {
        const value = upsertPlatformProfileInputSchema.parse(input);

        // Re-reading the connection under the caller's scope is what stops a
        // supplied connection id pointing at another organization's row. RLS
        // would refuse the write anyway; this refuses it with a clear message.
        const { data: connection, error: connectionError } = await from(
          "platform_connections",
          scope,
        )
          .eq("id", value.platformConnectionId)
          .maybeSingle();

        if (connectionError) fail(connectionError, "save the profile mapping");
        if (!connection) throw notFound("Platform connection");

        if (value.locationId) {
          const { data: location, error: locationError } = await from("locations", scope)
            .eq("id", value.locationId)
            .maybeSingle();
          if (locationError) fail(locationError, "save the profile mapping");
          if (!location) throw notFound("Location");
        }

        const { data, error } = await client
          .from("platform_profiles")
          .upsert(
            {
              organization_id: scope.organizationId,
              location_id: value.locationId,
              platform_connection_id: value.platformConnectionId,
              external_profile_id: value.externalProfileId,
              external_profile_name: value.externalProfileName,
              external_account_id: value.externalAccountId,
              profile_url: value.profileUrl,
              status: value.status,
              verification_state: value.verificationState,
              provider_metadata: value.providerMetadata,
              last_confirmed_at: value.lastConfirmedAt,
            },
            { onConflict: "platform_connection_id,external_profile_id" },
          )
          .select("*")
          .maybeSingle();

        if (error) {
          // 23505 here is the one-location-per-connection index, not a generic
          // duplicate, so it gets wording the user can act on.
          if (error.code === "23505") {
            throw conflict(
              "That Lia location is already mapped to a different Google location.",
            );
          }
          fail(error, "save the profile mapping");
        }
        if (!data) throw notFound("Platform profile");
        return toPlatformProfile(data as Row);
      },

      async markSynced(scope, profileId, syncedAt) {
        // Only `last_synced_at`. Nothing about the mapping itself is in this
        // update, so a sync cannot rewrite which restaurant a listing is.
        const { data, error } = await client
          .from("platform_profiles")
          .update({ last_synced_at: syncedAt })
          .eq("organization_id", scope.organizationId)
          .eq("id", profileId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "record the sync time");
        if (!data) throw notFound("Connected location");
        return toPlatformProfile(data as Row);
      },

      async deactivateForConnection(scope, connectionId) {
        // Preserved, not deleted. Reconnecting later restores every mapping
        // rather than asking someone to redo the work.
        const { data, error } = await client
          .from("platform_profiles")
          .update({ status: "disconnected" })
          .eq("organization_id", scope.organizationId)
          .eq("platform_connection_id", connectionId)
          .select("*");

        if (error) fail(error, "disconnect the profiles");
        return rows(data).map(toPlatformProfile);
      },
    },

    platformCredentials: {
      async load(scope, connectionId) {
        // Scope check under the caller's client first: the secrets table is
        // read with the service role, which bypasses RLS entirely, so the
        // tenant boundary has to be established before that client is used.
        const { data: connection, error: connectionError } = await from(
          "platform_connections",
          scope,
        )
          .eq("id", connectionId)
          .maybeSingle();

        if (connectionError) fail(connectionError, "load the connection");
        if (!connection) return null;

        const { data, error } = await serviceClient()
          .from("platform_connection_secrets")
          .select("*")
          .eq("platform_connection_id", connectionId)
          .eq("organization_id", scope.organizationId)
          .maybeSingle();

        if (error) fail(error, "load the connection credentials");
        if (!data) return null;

        const row = data as Row;
        return {
          accessTokenSealed: (row.access_token_sealed as string | null) ?? null,
          refreshTokenSealed: (row.refresh_token_sealed as string | null) ?? null,
          scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
          accessTokenExpiresAt: isoOrNull(row.access_token_expires_at),
          encryptionKeyId: String(row.encryption_key_id ?? "default"),
          encryptionVersion: String(row.encryption_version ?? "v1"),
          rotatedAt: isoOrNull(row.rotated_at),
        };
      },

      async save(scope, connectionId, record) {
        const { data: connection, error: connectionError } = await from(
          "platform_connections",
          scope,
        )
          .eq("id", connectionId)
          .maybeSingle();

        if (connectionError) fail(connectionError, "save the connection credentials");
        if (!connection) throw notFound("Platform connection");

        const { error } = await serviceClient()
          .from("platform_connection_secrets")
          .upsert(
            {
              platform_connection_id: connectionId,
              organization_id: scope.organizationId,
              access_token_sealed: record.accessTokenSealed,
              refresh_token_sealed: record.refreshTokenSealed,
              scopes: record.scopes,
              access_token_expires_at: record.accessTokenExpiresAt,
              encryption_key_id: record.encryptionKeyId,
              encryption_version: record.encryptionVersion,
              rotated_at: record.rotatedAt,
            },
            { onConflict: "platform_connection_id" },
          );

        if (error) fail(error, "save the connection credentials");
      },

      async clear(scope, connectionId) {
        const { error } = await serviceClient()
          .from("platform_connection_secrets")
          .delete()
          .eq("platform_connection_id", connectionId)
          .eq("organization_id", scope.organizationId);

        // Idempotent: deleting rows that are already gone is the desired end
        // state, and PostgREST reports zero deletions as success.
        if (error) fail(error, "remove the connection credentials");
      },
    },

    oauthStates: {
      async create(input) {
        const { data, error } = await serviceClient()
          .from("oauth_states")
          .insert({
            provider: input.provider,
            state_hash: input.stateHash,
            organization_id: input.organizationId,
            user_id: input.userId,
            redirect_path: input.redirectPath,
            reauthorization: input.reauthorization,
            expires_at: input.expiresAt,
          })
          .select("*")
          .maybeSingle();

        if (error) fail(error, "start the authorization");
        if (!data) throw new DataError("unavailable", "Could not start the authorization.");
        return toOAuthState(data as Row);
      },

      async consume(stateHash) {
        // A single conditional UPDATE in SQL. Two callbacks racing the same
        // state would both pass a separate SELECT, and exactly one may win —
        // the WHERE clause inside the function is the lock.
        const { data, error } = await serviceClient().rpc("consume_oauth_state", {
          target_state_hash: stateHash,
        });

        if (error) fail(error, "validate the authorization");

        const row = rows(data)[0];
        return row ? toOAuthState(row) : null;
      },

      async purgeExpired() {
        const { data, error } = await serviceClient().rpc("purge_expired_oauth_states");
        if (error) fail(error, "clean up expired authorizations");
        return typeof data === "number" ? data : 0;
      },
    },

    platformSyncRuns: {
      /**
       * Open a run.
       *
       * The lock is `platform_sync_runs_one_active`, a partial unique index on
       * (profile, resource) where status = 'running'. Inserting is therefore
       * the whole of the concurrency control: a second concurrent sync gets a
       * 23505 rather than both fetching the same pages. Checking first and then
       * inserting would be two statements with a race between them, which is
       * exactly the bug the index exists to make impossible.
       *
       * A run whose process died still holds the lock, so a stale one is closed
       * before retrying once. Without that, a single crashed function would
       * block a location's syncs until somebody edited the database.
       */
      async start(scope, input) {
        const value = startSyncRunInputSchema.parse(input);

        // Membership of the caller's organization, verified before the insert.
        // A profile id from another tenant is simply not found here, so a
        // forged one buys nothing even though the insert would also be refused
        // by the RLS check.
        const { data: profile, error: profileError } = await from(
          "platform_profiles",
          scope,
        )
          .eq("id", value.platformProfileId)
          .maybeSingle();

        if (profileError) fail(profileError, "start the sync");
        if (!profile) throw notFound("Connected location");

        const row = {
          organization_id: scope.organizationId,
          platform_connection_id: value.platformConnectionId,
          platform_profile_id: value.platformProfileId,
          resource: value.resource,
          trigger: value.trigger,
          actor_user_id: value.actorUserId,
          status: "running",
          started_at: value.startedAt,
        };

        const first = await client.from("platform_sync_runs").insert(row).select("*").single();
        if (!first.error) return toPlatformSyncRun(first.data as Row);
        if (first.error.code !== "23505") fail(first.error, "start the sync");

        const active = await findActiveRun(
          scope,
          value.platformProfileId,
          value.resource,
        );

        if (!active) {
          // The unique index rejected the insert but no running row is visible.
          // The only benign explanation is that the other run finished between
          // the two statements, so one retry is warranted — and exactly one, so
          // a genuinely repeating conflict surfaces rather than spinning.
          const retry = await client
            .from("platform_sync_runs")
            .insert(row)
            .select("*")
            .single();
          if (retry.error) fail(retry.error, "start the sync");
          return toPlatformSyncRun(retry.data as Row);
        }

        if (!isSyncRunStale(active, Date.parse(value.startedAt) || Date.now())) {
          throw new SyncRunInProgressError(active.id);
        }

        await client
          .from("platform_sync_runs")
          .update({
            status: "failed",
            completed_at: value.startedAt,
            error_code: "sync_abandoned",
            error_message:
              "This sync stopped without finishing. It was closed so a new one could start.",
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", active.id)
          .eq("status", "running");

        const reclaimed = await client
          .from("platform_sync_runs")
          .insert(row)
          .select("*")
          .single();

        if (reclaimed.error) {
          // Another request reclaimed it first. Theirs is running; ours is not.
          if (reclaimed.error.code === "23505") {
            throw new SyncRunInProgressError(active.id);
          }
          fail(reclaimed.error, "start the sync");
        }

        return toPlatformSyncRun(reclaimed.data as Row);
      },

      async finish(scope, runId, input) {
        const value = finishSyncRunInputSchema.parse(input);

        const { data, error } = await client
          .from("platform_sync_runs")
          .update({
            status: value.status,
            completed_at: value.completedAt,
            fetched_count: value.counts.fetched,
            created_count: value.counts.created,
            updated_count: value.counts.updated,
            unchanged_count: value.counts.unchanged,
            failed_count: value.counts.failed,
            pages_fetched: value.pagesFetched,
            total_review_count: value.totalReviewCount,
            error_code: value.errorCode,
            error_message: value.errorMessage,
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", runId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "record the sync result");
        if (!data) throw notFound("Sync run");
        return toPlatformSyncRun(data as Row);
      },

      async get(scope, runId) {
        const { data, error } = await from("platform_sync_runs", scope)
          .eq("id", runId)
          .maybeSingle();

        if (error) fail(error, "load the sync run");
        return data ? toPlatformSyncRun(data as Row) : null;
      },

      async listForProfile(scope, profileId, limit) {
        let query = from("platform_sync_runs", scope)
          .eq("platform_profile_id", profileId)
          .order("started_at", { ascending: false });

        if (limit !== undefined) query = query.limit(limit);

        const { data, error } = await query;
        if (error) fail(error, "load the sync history");
        return rows(data).map(toPlatformSyncRun);
      },

      async latestForProfiles(scope, profileIds, resource) {
        const state: Record<string, ProfileSyncState> = {};
        for (const id of profileIds) {
          state[id] = { latest: null, lastSuccessful: null };
        }
        if (profileIds.length === 0) return state;

        // One descending scan rather than two queries per profile. Bounded
        // because the integration screen shows a handful of locations and each
        // keeps a short history; if that stops being true this becomes a
        // `distinct on` view rather than a different call site.
        const { data, error } = await from("platform_sync_runs", scope)
          .in("platform_profile_id", profileIds)
          .eq("resource", resource)
          .order("started_at", { ascending: false })
          .limit(500);

        if (error) fail(error, "load the sync status");

        for (const row of rows(data)) {
          const run = toPlatformSyncRun(row);
          const entry = state[run.platformProfileId];
          if (!entry) continue;
          entry.latest ??= run;
          if (entry.lastSuccessful === null && isSuccessfulSyncRun(run)) {
            entry.lastSuccessful = run;
          }
        }

        return state;
      },
    },

    analysisRuns: {
      /**
       * Open a run.
       *
       * The lock is `analysis_runs_one_active`, a partial unique index on the
       * organization where status = 'running'. Inserting is therefore the
       * whole of the concurrency control — a second concurrent request gets a
       * 23505 rather than both walking the same backlog and paying twice for
       * the overlap.
       *
       * A run whose process died still holds the lock, so a stale one is
       * closed before retrying once.
       */
      async start(scope, input) {
        const value = startAnalysisRunInputSchema.parse(input);

        const row = {
          organization_id: scope.organizationId,
          trigger: value.trigger,
          actor_user_id: value.actorUserId,
          status: "running",
          started_at: value.startedAt,
        };

        const first = await client
          .from("analysis_runs")
          .insert(row)
          .select("*")
          .single();

        if (!first.error) return toAnalysisRun(first.data as Row);
        if (first.error.code !== "23505") fail(first.error, "start the analysis");

        const active = await findActiveAnalysisRun(scope);

        if (!active) {
          // The index rejected the insert but no running row is visible: the
          // other run finished between the two statements. Retry exactly once,
          // so a genuinely repeating conflict surfaces rather than spinning.
          const retry = await client
            .from("analysis_runs")
            .insert(row)
            .select("*")
            .single();
          if (retry.error) fail(retry.error, "start the analysis");
          return toAnalysisRun(retry.data as Row);
        }

        if (!isAnalysisRunStale(active, Date.parse(value.startedAt) || Date.now())) {
          throw new AnalysisRunInProgressError(active.id);
        }

        await client
          .from("analysis_runs")
          .update({
            status: "failed",
            completed_at: value.startedAt,
            error_code: "analysis_abandoned",
            error_message:
              "This analysis stopped without finishing. It was closed so a new one could start.",
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", active.id)
          .eq("status", "running");

        const reclaimed = await client
          .from("analysis_runs")
          .insert(row)
          .select("*")
          .single();

        if (reclaimed.error) {
          // Another request reclaimed it first. Theirs is running; ours is not.
          if (reclaimed.error.code === "23505") {
            throw new AnalysisRunInProgressError(active.id);
          }
          fail(reclaimed.error, "start the analysis");
        }

        return toAnalysisRun(reclaimed.data as Row);
      },

      async finish(scope, runId, input) {
        const value = finishAnalysisRunInputSchema.parse(input);

        const { data, error } = await client
          .from("analysis_runs")
          .update({
            status: value.status,
            completed_at: value.completedAt,
            analyzed_count: value.counts.analyzed,
            heuristic_count: value.counts.heuristic,
            escalated_count: value.counts.escalated,
            failed_count: value.counts.failed,
            remaining_count: value.counts.remaining,
            model_provider: value.modelProvider,
            model_name: value.modelName,
            prompt_version: value.promptVersion,
            error_code: value.errorCode,
            error_message: value.errorMessage,
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", runId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "record the analysis result");
        if (!data) throw notFound("Analysis run");
        return toAnalysisRun(data as Row);
      },

      async get(scope, runId) {
        const { data, error } = await from("analysis_runs", scope)
          .eq("id", runId)
          .maybeSingle();

        if (error) fail(error, "load the analysis run");
        return data ? toAnalysisRun(data as Row) : null;
      },

      async list(scope, limit) {
        let query = from("analysis_runs", scope).order("started_at", {
          ascending: false,
        });
        if (limit !== undefined) query = query.limit(limit);

        const { data, error } = await query;
        if (error) fail(error, "load the analysis history");
        return rows(data).map(toAnalysisRun);
      },

      async latest(scope) {
        // One descending scan answers both questions. Bounded because the card
        // only needs the head of the history.
        const { data, error } = await from("analysis_runs", scope)
          .order("started_at", { ascending: false })
          .limit(50);

        if (error) fail(error, "load the analysis status");

        const runs = rows(data).map(toAnalysisRun);
        return {
          latest: runs[0] ?? null,
          lastSuccessful: runs.find(isSuccessfulAnalysisRun) ?? null,
        };
      },
    },

    // News monitoring's own file: see the doc comment at the top of
    // `supabase/monitoring.ts`.
    ...createMonitoringRepositories(client),

    mentions: {
      async list(scope, filter = {}) {
        let query = from("mentions", scope).order("published_at", { ascending: false });

        if (filter.locationId) query = query.eq("location_id", filter.locationId);
        if (filter.sourceTypes?.length) query = query.in("source_type", filter.sourceTypes);
        if (filter.statuses?.length) query = query.in("status", filter.statuses);
        if (filter.sentiments?.length) query = query.in("sentiment", filter.sentiments);
        if (filter.riskLevels?.length) query = query.in("risk_level", filter.riskLevels);
        if (filter.publishedAfter) query = query.gte("published_at", filter.publishedAfter);
        if (filter.publishedBefore) query = query.lte("published_at", filter.publishedBefore);

        if (filter.search) {
          const term = filter.search.replaceAll(",", " ").replaceAll("%", "");
          query = query.or(
            `title.ilike.%${term}%,content.ilike.%${term}%,author_name.ilike.%${term}%`,
          );
        }

        if (filter.platform) {
          const { data: connections, error: connectionError } = await client
            .from("platform_connections")
            .select("id")
            .eq("organization_id", scope.organizationId)
            .eq("platform", filter.platform);

          if (connectionError) fail(connectionError, "load mentions");
          const ids = rows(connections).map((row) => String(row.id));
          if (ids.length === 0) return [];
          query = query.in("platform_connection_id", ids);
        }

        const offset = filter.offset ?? 0;
        if (filter.limit !== undefined) {
          query = query.range(offset, offset + filter.limit - 1);
        } else if (offset > 0) {
          query = query.range(offset, offset + 999);
        }

        const { data, error } = await query;
        if (error) fail(error, "load mentions");
        return rows(data).map(toMention);
      },

      async get(scope, mentionId) {
        const { data, error } = await from("mentions", scope).eq("id", mentionId).maybeSingle();
        if (error) fail(error, "load the mention");
        return data ? toMention(data as Row) : null;
      },

      async getDetail(scope, mentionId) {
        const mention = await this.get(scope, mentionId);
        if (!mention) return null;

        const [analysis, draftResult, escalationResult, locationResult, connectionResult] =
          await Promise.all([
            this.latestAnalysis(scope, mentionId),
            from("response_drafts", scope)
              .eq("mention_id", mentionId)
              .order("created_at", { ascending: false }),
            from("escalations", scope).eq("mention_id", mentionId).maybeSingle(),
            mention.locationId
              ? from("locations", scope).eq("id", mention.locationId).maybeSingle()
              : Promise.resolve({ data: null, error: null }),
            from("platform_connections", scope)
              .eq("id", mention.platformConnectionId)
              .maybeSingle(),
          ]);

        if (draftResult.error) fail(draftResult.error, "load responses");

        return {
          mention,
          analysis,
          drafts: rows(draftResult.data).map(toResponseDraft),
          escalation: escalationResult.data
            ? toEscalation(escalationResult.data as Row)
            : null,
          location: locationResult.data ? toLocation(locationResult.data as Row) : null,
          connection: connectionResult.data
            ? toPlatformConnection(connectionResult.data as Row)
            : null,
        };
      },

      async listNeedingAttention(scope, limit) {
        const open = await this.list(scope, {
          statuses: ["new", "analyzed", "draft_ready", "needs_approval", "escalated"],
        });
        const ranked = rankByUrgency(open.filter((mention) => isOpenStatus(mention.status)));
        return limit === undefined ? ranked : ranked.slice(0, limit);
      },

      async counts(scope, filter) {
        return countByStatus(await this.list(scope, filter));
      },

      async metrics(scope) {
        // Aggregating in the application is acceptable at demo and early
        // production volume. Past that, this becomes a SQL view or a
        // materialized rollup; the signature does not change.
        const [mentions, analyses, drafts] = await Promise.all([
          fetchMentions(scope),
          fetchAnalyses(scope),
          fetchDrafts(scope),
        ]);

        return computeOrganizationMetrics({
          mentions,
          analyses,
          drafts,
          referenceNow: new Date().toISOString(),
        });
      },

      async create(scope, input) {
        const parsed = createMentionInputSchema.safeParse(input);
        if (!parsed.success) {
          throw invalidInput("That mention could not be stored.");
        }
        const value = parsed.data;

        // Upsert on the unique key so a repeated sync updates rather than
        // duplicating. Matches mentions_unique_external in the schema.
        const { data, error } = await client
          .from("mentions")
          .upsert(
            {
              organization_id: scope.organizationId,
              location_id: value.locationId,
              platform_connection_id: value.platformConnectionId,
              platform_profile_id: value.platformProfileId,
              source_type: value.sourceType,
              external_id: value.externalId,
              external_parent_id: value.externalParentId,
              source_url: value.sourceUrl,
              title: value.title,
              content: value.content,
              author_name: value.authorName,
              author_external_id: value.authorExternalId,
              rating: value.rating,
              language: value.language,
              published_at: value.publishedAt,
              received_at: value.receivedAt ?? new Date().toISOString(),
              status: value.status,
              sentiment: value.sentiment,
              risk_level: value.riskLevel,
              relevance_score: value.relevanceScore,
              engagement_score: value.engagementScore,
              raw_payload: value.rawPayload,
              external_resource_name: value.externalResourceName,
              author_avatar_url: value.authorAvatarUrl,
              author_is_anonymous: value.authorIsAnonymous,
              source_updated_at: value.sourceUpdatedAt,
              source_reply_text: value.sourceReplyText,
              source_reply_updated_at: value.sourceReplyUpdatedAt,
              source_metadata: value.sourceMetadata,
              last_synced_at: value.lastSyncedAt,
              publisher_name: value.publisherName,
              publisher_domain: value.publisherDomain,
              is_syndicated: value.isSyndicated,
              monitoring_query_id: value.monitoringQueryId,
            },
            { onConflict: "platform_connection_id,source_type,external_id" },
          )
          .select("*")
          .single();

        if (error) fail(error, "store the mention");
        return toMention(data as Row);
      },

      /**
       * Ingest from a synchronisation.
       *
       * Two statements, and the split is deliberate. The read classifies the
       * outcome — created, updated, or unchanged — which is what a sync reports
       * and what makes a second run legibly idempotent. The write is an upsert
       * on `mentions_unique_external`, which is what actually guarantees no
       * duplicate: the read is advisory and a race can only misreport a count,
       * never write a second row.
       *
       * The column list is the other half of the guarantee. `status`,
       * `sentiment`, `risk_level`, `relevance_score`, `engagement_score`, and
       * `received_at` are absent from the update path entirely, so a re-import
       * cannot move a mention somebody has escalated back to "new".
       */
      async ingest(scope, input) {
        const value = ingestMentionInputSchema.parse(input);

        const { data: existingRow, error: readError } = await client
          .from("mentions")
          .select("*")
          .eq("organization_id", scope.organizationId)
          .eq("platform_connection_id", value.platformConnectionId)
          .eq("source_type", value.sourceType)
          .eq("external_id", value.externalId)
          .maybeSingle();

        if (readError) fail(readError, "store the review");

        const existing = existingRow ? toMention(existingRow as Row) : null;
        const changed = existing === null || sourceFieldsChanged(existing, value);

        // Nothing moved, so nothing is written. Re-stamping every unchanged row
        // on every sync would rewrite a location's whole review history nightly
        // for no information gained.
        if (existing && !changed) {
          return { mention: existing, outcome: "unchanged" };
        }

        const sourceOwned = {
          location_id: value.locationId,
          platform_profile_id: value.platformProfileId,
          external_parent_id: value.externalParentId,
          source_url: value.sourceUrl,
          title: value.title,
          content: value.content,
          author_name: value.authorName,
          author_external_id: value.authorExternalId,
          author_avatar_url: value.authorAvatarUrl,
          author_is_anonymous: value.authorIsAnonymous,
          rating: value.rating,
          language: value.language,
          published_at: value.publishedAt,
          raw_payload: value.rawPayload,
          external_resource_name: value.externalResourceName,
          source_updated_at: value.sourceUpdatedAt,
          source_reply_text: value.sourceReplyText,
          source_reply_updated_at: value.sourceReplyUpdatedAt,
          source_metadata: value.sourceMetadata,
          last_synced_at: value.syncedAt,
          publisher_name: value.publisherName,
          publisher_domain: value.publisherDomain,
        };

        if (existing) {
          const { data, error } = await client
            .from("mentions")
            .update(sourceOwned)
            .eq("organization_id", scope.organizationId)
            .eq("id", existing.id)
            .select("*")
            .maybeSingle();

          if (error) fail(error, "store the review");
          if (!data) throw notFound("Mention");
          return { mention: toMention(data as Row), outcome: "updated" };
        }

        const { data, error } = await client
          .from("mentions")
          .upsert(
            {
              organization_id: scope.organizationId,
              platform_connection_id: value.platformConnectionId,
              source_type: value.sourceType,
              external_id: value.externalId,
              // First sight, so this genuinely is when Lia received it. The
              // update path above never touches it again.
              received_at: value.syncedAt,
              // Set only on creation, mirroring `received_at` above: the
              // query that first found this article keeps the attribution
              // even if a second query later matches the same story.
              monitoring_query_id: value.monitoringQueryId,
              ...sourceOwned,
            },
            { onConflict: "platform_connection_id,source_type,external_id" },
          )
          .select("*")
          .single();

        if (error) fail(error, "store the review");
        return { mention: toMention(data as Row), outcome: "created" };
      },

      /**
       * The unanalysed backlog, oldest first.
       *
       * Two queries rather than a join: PostgREST has no `not exists`, and
       * pulling the analysed ids is a single indexed column read against
       * `mention_analyses_mention_idx`. At the volume a per-organization
       * inbox reaches this is cheap; past that it becomes a view, and the
       * signature does not change.
       */
      async listUnanalyzed(scope, limit) {
        const analyzedIds = await fetchAnalyzedMentionIds(scope);

        let query = from("mentions", scope).order("published_at", {
          ascending: true,
        });

        if (analyzedIds.length > 0) {
          query = query.not(
            "id",
            "in",
            `(${analyzedIds.map((id) => `"${id}"`).join(",")})`,
          );
        }

        const { data, error } = await query.limit(limit);
        if (error) fail(error, "load the unanalyzed mentions");
        return rows(data).map(toMention);
      },

      async countUnanalyzed(scope) {
        const [analyzedIds, total] = await Promise.all([
          fetchAnalyzedMentionIds(scope),
          (async () => {
            const { count, error } = await client
              .from("mentions")
              .select("id", { count: "exact", head: true })
              .eq("organization_id", scope.organizationId);

            if (error) fail(error, "count the unanalyzed mentions");
            return count ?? 0;
          })(),
        ]);

        // Analysed ids are distinct per mention, and every analysis belongs to
        // a mention in the same organization, so the difference is exact.
        return Math.max(0, total - analyzedIds.length);
      },

      async createAnalysis(scope, input) {
        const value = createMentionAnalysisInputSchema.parse(input);

        // The mention is confirmed under the caller's own scope first, so an
        // analysis cannot be attached to another organization's mention.
        const { data: mention, error: mentionError } = await from("mentions", scope)
          .eq("id", value.mentionId)
          .maybeSingle();

        if (mentionError) fail(mentionError, "store the analysis");
        if (!mention) throw notFound("Mention");

        // Insert, never upsert: the table is append-only by design, so a
        // re-analysis lands beside the previous one and readers take the latest.
        const { data, error } = await client
          .from("mention_analyses")
          .insert({
            organization_id: scope.organizationId,
            mention_id: value.mentionId,
            model_provider: value.modelProvider,
            model_name: value.modelName,
            prompt_version: value.promptVersion,
            relevance_score: value.relevanceScore,
            relevance_explanation: value.relevanceExplanation,
            sentiment: value.sentiment,
            sentiment_score: value.sentimentScore,
            risk_level: value.riskLevel,
            risk_categories: value.riskCategories,
            risk_explanation: value.riskExplanation,
            topics: value.topics,
            facts_needing_verification: value.factsNeedingVerification,
            recommended_action: value.recommendedAction,
            recommendation_explanation: value.recommendationExplanation,
            analyzed_at: value.analyzedAt,
            analysis_run_id: value.analysisRunId,
            input_tokens: value.inputTokens,
            output_tokens: value.outputTokens,
          })
          .select("*")
          .single();

        if (error) fail(error, "store the analysis");
        return toMentionAnalysis(data as Row);
      },

      /**
       * Write the four columns an analysis owns.
       *
       * The column list is the guarantee. `content`, `rating`, `author_name`,
       * `published_at`, and every `source_*` column are absent, so an analysis
       * cannot overwrite what a sync imported — the mirror of the rule that
       * keeps a sync out of Lia's workflow state.
       *
       * The `status` filter is applied in the query rather than read-then-write:
       * `eq("status", "new")` means a mention somebody moved in the meantime is
       * not matched at all, so the race resolves in the person's favour.
       */
      async applyAnalysisOutcome(scope, mentionId, outcome) {
        const sourceUntouched = {
          sentiment: outcome.sentiment,
          risk_level: outcome.riskLevel,
          relevance_score: outcome.relevanceScore,
        };

        const advanced = await client
          .from("mentions")
          .update({ ...sourceUntouched, status: outcome.status })
          .eq("organization_id", scope.organizationId)
          .eq("id", mentionId)
          .eq("status", "new")
          .select("*")
          .maybeSingle();

        if (advanced.error) fail(advanced.error, "record the analysis outcome");
        if (advanced.data) return toMention(advanced.data as Row);

        // Not `new` any more — a person has already moved it. The scores still
        // apply; the status they chose stands.
        const { data, error } = await client
          .from("mentions")
          .update(sourceUntouched)
          .eq("organization_id", scope.organizationId)
          .eq("id", mentionId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "record the analysis outcome");
        if (!data) throw notFound("Mention");
        return toMention(data as Row);
      },

      async countByProfile(scope, profileIds) {
        const counts: Record<string, number> = {};
        for (const id of profileIds) counts[id] = 0;
        if (profileIds.length === 0) return counts;

        // Only the discriminator column is selected. Counting is cheap; pulling
        // every review's text back to count them is not.
        const { data, error } = await client
          .from("mentions")
          .select("platform_profile_id")
          .eq("organization_id", scope.organizationId)
          .in("platform_profile_id", profileIds);

        if (error) fail(error, "count imported reviews");

        for (const row of rows(data)) {
          const id = row.platform_profile_id;
          if (typeof id !== "string" || !(id in counts)) continue;
          counts[id] = (counts[id] ?? 0) + 1;
        }

        return counts;
      },

      async updateStatus(scope, mentionId, status) {
        const { data, error } = await client
          .from("mentions")
          .update({ status })
          .eq("organization_id", scope.organizationId)
          .eq("id", mentionId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "update the mention");
        if (!data) throw notFound("Mention");
        return toMention(data as Row);
      },

      async latestAnalysis(scope, mentionId) {
        const { data, error } = await from("mention_analyses", scope)
          .eq("mention_id", mentionId)
          .order("analyzed_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) fail(error, "load the analysis");
        return data ? toMentionAnalysis(data as Row) : null;
      },
    },

    responseDrafts: {
      async list(scope, filter = {}) {
        let query = from("response_drafts", scope).order("created_at", { ascending: false });

        if (filter.mentionId) query = query.eq("mention_id", filter.mentionId);
        if (filter.statuses?.length) query = query.in("status", filter.statuses);
        if (filter.responseTypes?.length) query = query.in("response_type", filter.responseTypes);
        if (filter.assignedUserId) query = query.eq("assigned_user_id", filter.assignedUserId);
        if (filter.generatedBy) query = query.eq("generated_by", filter.generatedBy);
        if (filter.search) {
          const term = filter.search.replaceAll(",", " ").replaceAll("%", "");
          query = query.or(`draft_text.ilike.%${term}%,final_text.ilike.%${term}%`);
        }

        const offset = filter.offset ?? 0;
        if (filter.limit !== undefined) query = query.range(offset, offset + filter.limit - 1);

        const { data, error } = await query;
        if (error) fail(error, "load responses");
        return rows(data).map(toResponseDraft);
      },

      async get(scope, draftId) {
        const { data, error } = await from("response_drafts", scope)
          .eq("id", draftId)
          .maybeSingle();
        if (error) fail(error, "load the response");
        return data ? toResponseDraft(data as Row) : null;
      },

      async assign(scope, draftId, assignedUserId) {
        if (assignedUserId) await assertActiveMember(scope, assignedUserId);

        const { data, error } = await client
          .from("response_drafts")
          .update({ assigned_user_id: assignedUserId })
          .eq("organization_id", scope.organizationId)
          .eq("id", draftId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "assign the response");
        if (!data) throw notFound("Response draft");
        return toResponseDraft(data as Row);
      },

      async decide(scope, draftId, decision, decidedByUserId, decisionNote) {
        const current = await this.get(scope, draftId);
        if (!current) throw notFound("Response draft");

        if (!canDecideOnDraft(current.status)) {
          throw conflict(
            `A response that is already ${current.status.replace(/_/g, " ")} cannot be decided again.`,
          );
        }

        const decidedAt = new Date().toISOString();
        const { data, error } = await client
          .from("response_drafts")
          .update({
            status: decision === "approved" ? "approved" : "draft",
            approved_by_user_id: decision === "approved" ? decidedByUserId : null,
            approved_at: decision === "approved" ? decidedAt : null,
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", draftId)
          // Optimistic guard: if another approver decided in the meantime, the
          // status no longer matches and this update affects no rows.
          .eq("status", current.status)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "record the decision");
        if (!data) throw conflict("Someone else decided on this response first.");

        const { data: approvalRow, error: approvalError } = await client
          .from("approvals")
          .update({
            status: decision,
            decision_note: decisionNote ?? null,
            decided_at: decidedAt,
          })
          .eq("organization_id", scope.organizationId)
          .eq("response_draft_id", draftId)
          .eq("status", "pending")
          .select("*")
          .maybeSingle();

        if (approvalError) fail(approvalError, "record the decision");

        let approval: Approval | null = null;
        if (approvalRow) approval = toApproval(approvalRow as Row);

        return { draft: toResponseDraft(data as Row), approval };
      },

      async listApprovals(scope, draftId) {
        const { data, error } = await from("approvals", scope)
          .eq("response_draft_id", draftId)
          .order("created_at", { ascending: false });
        if (error) fail(error, "load approvals");
        return rows(data).map(toApproval);
      },
    },

    escalations: {
      async list(scope, filter = {}) {
        let query = from("escalations", scope)
          .order("severity")
          .order("due_at", { ascending: true, nullsFirst: false });

        if (filter.mentionId) query = query.eq("mention_id", filter.mentionId);
        if (filter.statuses?.length) query = query.in("status", filter.statuses);
        if (filter.categories?.length) query = query.in("category", filter.categories);
        if (filter.severities?.length) query = query.in("severity", filter.severities);
        if (filter.assignedUserId) query = query.eq("assigned_user_id", filter.assignedUserId);
        if (filter.search) {
          const term = filter.search.replaceAll(",", " ").replaceAll("%", "");
          query = query.or(`title.ilike.%${term}%,summary.ilike.%${term}%`);
        }

        const offset = filter.offset ?? 0;
        if (filter.limit !== undefined) query = query.range(offset, offset + filter.limit - 1);

        const { data, error } = await query;
        if (error) fail(error, "load escalations");
        return rows(data).map(toEscalation);
      },

      async get(scope, escalationId) {
        const { data, error } = await from("escalations", scope)
          .eq("id", escalationId)
          .maybeSingle();
        if (error) fail(error, "load the escalation");
        return data ? toEscalation(data as Row) : null;
      },

      async create(scope, input) {
        const value = createEscalationInputSchema.parse(input);

        // Confirmed under the caller's own scope, so an escalation cannot be
        // attached to another organization's mention.
        const { data: mention, error: mentionError } = await from("mentions", scope)
          .eq("id", value.mentionId)
          .maybeSingle();

        if (mentionError) fail(mentionError, "raise the escalation");
        if (!mention) throw notFound("Mention");

        // One per mention. Two open cases for one review is a queue nobody
        // trusts, and a re-run must not produce that.
        const { data: existing, error: existingError } = await from(
          "escalations",
          scope,
        )
          .eq("mention_id", value.mentionId)
          .maybeSingle();

        if (existingError) fail(existingError, "raise the escalation");
        if (existing) {
          return { escalation: toEscalation(existing as Row), created: false };
        }

        const { data, error } = await client
          .from("escalations")
          .insert({
            organization_id: scope.organizationId,
            mention_id: value.mentionId,
            category: value.category,
            severity: value.severity,
            status: "open",
            title: value.title,
            summary: value.summary,
            // Unassigned on purpose — see the domain schema's note.
            assigned_user_id: null,
            due_at: value.dueAt,
          })
          .select("*")
          .single();

        if (error) fail(error, "raise the escalation");
        return { escalation: toEscalation(data as Row), created: true };
      },

      async updateStatus(scope, escalationId, status, resolutionNote) {
        if (requiresResolutionNote(status) && !resolutionNote?.trim()) {
          throw invalidInput("Add a resolution note before resolving this escalation.", {
            resolutionNote: "A resolution note is required.",
          });
        }

        const update: Record<string, unknown> = {
          status,
          resolved_at: isEscalationClosed(status) ? new Date().toISOString() : null,
        };
        if (resolutionNote?.trim()) update.resolution_note = resolutionNote.trim();

        const { data, error } = await client
          .from("escalations")
          .update(update)
          .eq("organization_id", scope.organizationId)
          .eq("id", escalationId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "update the escalation");
        if (!data) throw notFound("Escalation");
        return toEscalation(data as Row);
      },

      async assign(scope, escalationId, assignedUserId) {
        if (assignedUserId) await assertActiveMember(scope, assignedUserId);

        const { data, error } = await client
          .from("escalations")
          .update({ assigned_user_id: assignedUserId })
          .eq("organization_id", scope.organizationId)
          .eq("id", escalationId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "assign the escalation");
        if (!data) throw notFound("Escalation");
        return toEscalation(data as Row);
      },
    },

    automationRules: {
      async list(scope, filter = {}) {
        let query = from("automation_rules", scope).order("priority").order("name");

        if (filter.statuses?.length) query = query.in("status", filter.statuses);
        if (filter.search) {
          const term = filter.search.replaceAll(",", " ").replaceAll("%", "");
          query = query.or(`name.ilike.%${term}%,description.ilike.%${term}%`);
        }

        const { data, error } = await query;
        if (error) fail(error, "load rules");
        return rows(data).map(toAutomationRule);
      },

      async get(scope, ruleId) {
        const { data, error } = await from("automation_rules", scope)
          .eq("id", ruleId)
          .maybeSingle();
        if (error) fail(error, "load the rule");
        return data ? toAutomationRule(data as Row) : null;
      },

      async setEnabled(scope, ruleId, enabled) {
        const current = await this.get(scope, ruleId);
        if (!current) throw notFound("Automation rule");

        if (enabled && current.status === "draft") {
          throw conflict("Finish and simulate this draft rule before enabling it.");
        }

        const { data, error } = await client
          .from("automation_rules")
          .update({ status: enabled ? "active" : "inactive" })
          .eq("organization_id", scope.organizationId)
          .eq("id", ruleId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "update the rule");
        if (!data) throw notFound("Automation rule");
        return toAutomationRule(data as Row);
      },
    },

    brandVoice: {
      async get(scope) {
        const { data, error } = await from("brand_voice_profiles", scope).maybeSingle();
        if (error) fail(error, "load the brand voice");
        return data ? toBrandVoiceProfile(data as Row) : null;
      },

      async save(scope, input) {
        // Re-parse rather than trust the caller's shape: this is what actually
        // enforces phrase deduplication, trim-and-drop-blanks, the length caps,
        // and the approved/prohibited collision rule. A caller reaching the
        // repository directly bypasses none of that.
        const value = updateBrandVoiceInputSchema.parse(input);

        const current = await this.get(scope);

        const columns = {
          name: value.name,
          axis_warmth: value.axes.warmth,
          axis_detail: value.axes.detail,
          axis_formality: value.axes.formality,
          axis_confidence: value.axes.confidence,
          axis_hospitality: value.axes.hospitality,
          approved_phrases: value.approvedPhrases,
          prohibited_phrases: value.prohibitedPhrases,
          updated_by_user_id: scope.userId,
        };

        if (!current) {
          const { data, error } = await client
            .from("brand_voice_profiles")
            .insert({ ...columns, organization_id: scope.organizationId, version: 1 })
            .select("*")
            .single();
          if (error) fail(error, "save the brand voice");
          return toBrandVoiceProfile(data as Row);
        }

        // Unchanged input returns the stored row untouched, so the version --
        // and therefore the provenance of every draft that cites it -- is not
        // disturbed by pressing Save twice.
        if (matchesStoredProfile(current, value)) return current;

        // Read-then-write, with no transaction available (D17): two concurrent
        // saves can both read version n and both write n+1, so one edit is lost
        // and the version undercounts by one. The unique constraint still
        // guarantees a single row; a serialising fix needs a stored procedure
        // and is out of scope here.
        const { data, error } = await client
          .from("brand_voice_profiles")
          .update({ ...columns, version: current.version + 1 })
          .eq("organization_id", scope.organizationId)
          .select("*")
          .single();
        if (error) fail(error, "save the brand voice");
        return toBrandVoiceProfile(data as Row);
      },
    },

    auditEvents: {
      async list(scope, filter = {}) {
        let query = from("audit_events", scope)
          .order("occurred_at", { ascending: false })
          .limit(filter.limit ?? 50);

        if (filter.entityType) query = query.eq("entity_type", filter.entityType);
        if (filter.entityId) query = query.eq("entity_id", filter.entityId);
        if (filter.eventTypes?.length) query = query.in("event_type", filter.eventTypes);
        if (filter.actorUserId) query = query.eq("actor_user_id", filter.actorUserId);
        if (filter.occurredAfter) query = query.gte("occurred_at", filter.occurredAfter);

        const { data, error } = await query;
        if (error) fail(error, "load activity");
        return rows(data).map(toAuditEvent);
      },

      async record(scope, input) {
        const parsed = recordAuditEventInputSchema.safeParse(input);
        if (!parsed.success) {
          throw invalidInput("That audit event could not be recorded.");
        }
        const value = parsed.data;

        const { data, error } = await client
          .from("audit_events")
          .insert({
            organization_id: scope.organizationId,
            actor_user_id: value.actorUserId,
            actor_type: value.actorType,
            event_type: value.eventType,
            entity_type: value.entityType,
            entity_id: value.entityId,
            previous_state: value.previousState,
            new_state: value.newState,
            metadata: value.metadata,
            occurred_at: value.occurredAt ?? new Date().toISOString(),
          })
          .select("*")
          .single();

        if (error) fail(error, "record the change");
        return toAuditEvent(data as Row);
      },
    },
  };
}
