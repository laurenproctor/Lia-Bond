import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseDataSource } from "@/lib/data/supabase";
import type { OrganizationScope } from "@/lib/data/types";
import { ORG_USHG, USER_KATE, LOC_SOHO } from "@/lib/seed/dataset";

/**
 * Which client writes an audit event.
 *
 * The paired migration (`20260812000200_audit_events_no_client_inserts.sql`)
 * revokes INSERT on `audit_events` from `authenticated` outright — a write
 * through the caller's session client would now fail in production with a
 * Postgres permission error, not a graceful rejection. `auditEvents.record`
 * has to route through the service-role client instead, the same way
 * `oauthStates` and `platformCredentials` already do for tables an
 * application session has no business touching directly. This test pins that
 * routing at the adapter level, independent of the database: it stubs both
 * clients the factory can reach and asserts the insert lands on the
 * service-role stub, never on the caller's.
 */

const { createSupabaseServiceClient } = vi.hoisted(() => ({
  createSupabaseServiceClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient,
}));

/** A chainable stand-in for a PostgREST query builder. */
interface FakeQueryChain {
  select: (columns?: string) => FakeQueryChain;
  eq: (column: string, value: unknown) => FakeQueryChain;
  order: (column: string, options?: unknown) => FakeQueryChain;
  limit: (count: number) => FakeQueryChain;
  in: (column: string, values: unknown[]) => FakeQueryChain;
  gte: (column: string, value: unknown) => FakeQueryChain;
  maybeSingle: () => Promise<{ data: null; error: null }>;
  insert: (payload: Record<string, unknown>) => FakeQueryChain;
  single: () => Promise<{ data: Record<string, unknown>; error: null }>;
}

/** A stub client whose every `insert` is reported back to the caller. */
function makeFakeClient(onInsert: (table: string, payload: Record<string, unknown>) => void) {
  const resultRow: Record<string, unknown> = {
    id: LOC_SOHO,
    organization_id: ORG_USHG,
    actor_user_id: USER_KATE,
    actor_type: "user",
    event_type: "mention.status_changed",
    entity_type: "mention",
    entity_id: LOC_SOHO,
    previous_state: null,
    new_state: null,
    metadata: {},
    occurred_at: new Date().toISOString(),
  };

  const from = (table: string): FakeQueryChain => {
    const chain: FakeQueryChain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      in: () => chain,
      gte: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: (payload: Record<string, unknown>) => {
        onInsert(table, payload);
        return chain;
      },
      single: () => Promise.resolve({ data: resultRow, error: null }),
    };
    return chain;
  };

  return { from } as unknown as SupabaseClient;
}

describe("auditEvents.record", () => {
  let userInserts: Array<{ table: string; payload: Record<string, unknown> }>;
  let serviceInserts: Array<{ table: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    userInserts = [];
    serviceInserts = [];
    const serviceClientStub = makeFakeClient((table, payload) => {
      serviceInserts.push({ table, payload });
    });
    createSupabaseServiceClient.mockReset();
    createSupabaseServiceClient.mockReturnValue(serviceClientStub);
  });

  it("inserts through the service client, never the caller's session client", async () => {
    const userClient = makeFakeClient((table, payload) => {
      userInserts.push({ table, payload });
    });
    const dataSource = createSupabaseDataSource(userClient);
    const scope: OrganizationScope = {
      organizationId: ORG_USHG,
      userId: USER_KATE,
      role: "admin",
    };

    await dataSource.auditEvents.record(scope, {
      actorUserId: USER_KATE,
      actorType: "user",
      eventType: "mention.status_changed",
      entityType: "mention",
      entityId: LOC_SOHO,
      previousState: null,
      newState: null,
      metadata: {},
    });

    expect(serviceInserts).toHaveLength(1);
    expect(serviceInserts[0]?.table).toBe("audit_events");
    expect(serviceInserts[0]?.payload).toMatchObject({
      organization_id: ORG_USHG,
      event_type: "mention.status_changed",
    });
    expect(userInserts).toHaveLength(0);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});
