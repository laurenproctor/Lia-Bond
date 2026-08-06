/**
 * Stands in for a real user on every write path with no session behind it.
 *
 * Cron holds no membership, so it cannot construct a verified
 * `OrganizationScope` the way `getOrganizationContext()` does for every other
 * caller (D88). This sentinel exists only to satisfy `OrganizationScope`'s
 * `userId: string` — widening that field to `string | null` would weaken the
 * tenancy type for every call site in the codebase to accommodate the two
 * scheduled routes.
 *
 * It must never reach the database: `public.users` has no row for it, so an
 * audit event or a connection carrying it as a foreign key would fail. Every
 * scheduled path records audit with an actor type other than `"user"` instead
 * — `recordAuditEvent` only ever writes `scope.userId` as `actorUserId` when
 * `actorType` is `"user"` — and `ensureNewsConnection` refuses to create a
 * connection when `actorUserId` (not `scope.userId`) is null.
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
