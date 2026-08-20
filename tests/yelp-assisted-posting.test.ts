import { beforeEach, describe, expect, it } from "vitest";
import {
  canConfirmPublication,
  resolvePublishingMode,
  NO_CAPABILITIES,
  type ResponseDraft,
} from "@/domain";
import { createDemoDataSource } from "@/lib/data/demo";
import { demoStore, resetDemoStore } from "@/lib/data/demo/store";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { can } from "@/lib/auth/permissions";
import { YELP_ASSISTED_CAPABILITIES } from "@/yelp/capabilities";
import { normalizeYelpUrl } from "@/yelp/urls";

/**
 * Assisted posting.
 *
 * The guarantees here are all negative ones — what must *not* happen — because
 * this is the part of the feature where Lia records something about the public
 * world that it did not witness. Copying must not publish, opening Yelp must
 * not publish, and a user's confirmation must never become indistinguishable
 * from a provider's acknowledgement.
 */

let dataSource: LiaDataSource;
let scope: OrganizationScope;
let approvedDraftId: string;
const CONFIRMED_AT = "2026-08-18T12:00:00.000Z";

beforeEach(() => {
  resetDemoStore();
  dataSource = createDemoDataSource();

  const store = demoStore();
  const organization = store.organizations[0];
  const user = store.users[0];
  if (!organization || !user) throw new Error("seed fixtures missing");

  scope = { organizationId: organization.id, userId: user.id, role: "owner" };

  const approved = store.responseDrafts.find(
    (row) => row.organizationId === organization.id && row.status === "approved",
  );
  if (!approved) throw new Error("seed has no approved draft");
  approvedDraftId = approved.id;
});

/* -------------------------------------------------------------------------- */
/* The publishing mode                                                         */
/* -------------------------------------------------------------------------- */

describe("publishing mode", () => {
  it("routes Yelp to assisted, not to manual or unavailable", () => {
    expect(resolvePublishingMode(YELP_ASSISTED_CAPABILITIES)).toBe("assisted");
  });

  it("still reports unavailable for a source with no path at all", () => {
    expect(resolvePublishingMode(NO_CAPABILITIES)).toBe("unavailable");
  });

  it("never routes a publishing provider through the handoff", () => {
    // The precedence, not a preference: a provider that can publish directly
    // is never sent through a copy-and-confirm flow whatever else it supports.
    expect(
      resolvePublishingMode({
        ...YELP_ASSISTED_CAPABILITIES,
        canPublishResponses: true,
      }),
    ).toBe("direct");
  });

  it("keeps the old manual reading for a readable, unpublishable source", () => {
    expect(
      resolvePublishingMode({ ...NO_CAPABILITIES, canReadMentions: true }),
    ).toBe("manual");
  });
});

/* -------------------------------------------------------------------------- */
/* Copying and opening                                                         */
/* -------------------------------------------------------------------------- */

describe("copying and opening change nothing", () => {
  it("leaves the draft approved — copying is a client-side clipboard write", async () => {
    // There is no server action for copying, and that absence is the
    // guarantee: no code path exists by which copying could move a status.
    const before = await dataSource.responseDrafts.get(scope, approvedDraftId);
    expect(before?.status).toBe("approved");
    expect(before?.publishedAt).toBeNull();
    expect(before?.publicationMethod).toBeNull();
  });

  it("refuses an unsafe destination before it can become a link", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "https://evil.test/biz/spoof",
      "https://www.yelp.com@evil.test/biz/x",
      "http://www.yelp.com/biz/example",
    ]) {
      expect(normalizeYelpUrl(hostile)).toBeNull();
    }
  });

  it("accepts a genuine Yelp destination", () => {
    expect(normalizeYelpUrl("https://www.yelp.com/biz/example")).toBe(
      "https://www.yelp.com/biz/example",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Confirming                                                                  */
/* -------------------------------------------------------------------------- */

describe("marking as posted", () => {
  it("records the actor, the moment, and the manual method", async () => {
    const { draft, outcome } = await dataSource.responseDrafts.confirmPublication(
      scope,
      approvedDraftId,
      scope.userId,
      CONFIRMED_AT,
    );

    expect(outcome).toBe("confirmed");
    expect(draft.status).toBe("published");
    expect(draft.publishedAt).toBe(CONFIRMED_AT);
    expect(draft.publicationMethod).toBe("manual_external");
    expect(draft.publishedByUserId).toBe(scope.userId);
  });

  it("never claims a provider acknowledged it", async () => {
    const { draft } = await dataSource.responseDrafts.confirmPublication(
      scope,
      approvedDraftId,
      scope.userId,
      CONFIRMED_AT,
    );

    // The single most important assertion in this file. A provider-assigned
    // identifier is what would make a user-confirmed publication read as
    // provider-verified, and there is none — permanently, on this path.
    expect(draft.externalResponseId).toBeNull();
    expect(draft.publicationMethod).not.toBe("provider_api");
  });

  it("is idempotent — a second click is success, not a second confirmation", async () => {
    const first = await dataSource.responseDrafts.confirmPublication(
      scope,
      approvedDraftId,
      scope.userId,
      CONFIRMED_AT,
    );
    const second = await dataSource.responseDrafts.confirmPublication(
      scope,
      approvedDraftId,
      scope.userId,
      "2026-08-18T13:00:00.000Z",
    );

    expect(second.outcome).toBe("already_confirmed");
    // The original moment stands: a repeat must not rewrite when it happened.
    expect(second.draft.publishedAt).toBe(first.draft.publishedAt);
  });

  it("refuses a draft that nobody approved", async () => {
    const store = demoStore();
    const unapproved = store.responseDrafts.find(
      (row) => row.organizationId === scope.organizationId && row.status === "draft",
    );
    if (!unapproved) throw new Error("seed has no unapproved draft");

    // Confirming unapproved words were posted publicly would record an
    // approval that never happened.
    await expect(
      dataSource.responseDrafts.confirmPublication(
        scope,
        unapproved.id,
        scope.userId,
        CONFIRMED_AT,
      ),
    ).rejects.toThrow(/approved/i);
  });

  it("only permits confirmation from the approved status", () => {
    expect(canConfirmPublication("approved")).toBe(true);
    for (const status of ["draft", "awaiting_approval", "failed", "dismissed"] as const) {
      expect(canConfirmPublication(status)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Correcting                                                                  */
/* -------------------------------------------------------------------------- */

describe("withdrawing a confirmation", () => {
  it("returns the draft to approved and clears the provenance", async () => {
    await dataSource.responseDrafts.confirmPublication(
      scope,
      approvedDraftId,
      scope.userId,
      CONFIRMED_AT,
    );

    const draft = await dataSource.responseDrafts.unconfirmPublication(
      scope,
      approvedDraftId,
    );

    expect(draft.status).toBe("approved");
    expect(draft.publishedAt).toBeNull();
    expect(draft.publicationMethod).toBeNull();
    expect(draft.publishedByUserId).toBeNull();
  });

  it("can be re-confirmed afterwards", async () => {
    await dataSource.responseDrafts.confirmPublication(
      scope,
      approvedDraftId,
      scope.userId,
      CONFIRMED_AT,
    );
    await dataSource.responseDrafts.unconfirmPublication(scope, approvedDraftId);

    const again = await dataSource.responseDrafts.confirmPublication(
      scope,
      approvedDraftId,
      scope.userId,
      "2026-08-18T14:00:00.000Z",
    );
    expect(again.outcome).toBe("confirmed");
  });

  it("refuses a draft that was never confirmed", async () => {
    await expect(
      dataSource.responseDrafts.unconfirmPublication(scope, approvedDraftId),
    ).rejects.toThrow(/posted by hand/i);
  });

  it("cannot erase a provider publication", async () => {
    // A provider publication is something Lia observed and holds an
    // acknowledgement for. Letting the correction path rewrite one as a mistake
    // is the failure this guard exists for.
    const store = demoStore();
    const published = store.responseDrafts.find(
      (row) =>
        row.organizationId === scope.organizationId &&
        row.status === "published" &&
        row.publicationMethod === "provider_api",
    );
    if (!published) throw new Error("seed has no provider-published draft");

    await expect(
      dataSource.responseDrafts.unconfirmPublication(scope, published.id),
    ).rejects.toThrow(/posted by hand/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

describe("who may confirm", () => {
  it("is held by the roles that own the response, not by the approver alone", () => {
    for (const role of ["owner", "admin", "communications_lead"] as const) {
      expect(can(role, "response.confirm_publication")).toBe(true);
    }
  });

  it("is refused to read-only roles and to the approver", () => {
    // Deliberately not the same list as `response.decide`: the separation
    // between signing text off and being the sole witness that it went public
    // would be hollow if the approver held both.
    for (const role of ["approver", "analyst", "viewer", "location_manager"] as const) {
      expect(can(role, "response.confirm_publication")).toBe(false);
    }
  });

  it("keeps manual capture separate from review synchronisation", () => {
    for (const role of ["owner", "admin", "communications_lead"] as const) {
      expect(can(role, "mention.capture_manual")).toBe(true);
    }
    for (const role of ["analyst", "viewer", "approver"] as const) {
      expect(can(role, "mention.capture_manual")).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                     */
/* -------------------------------------------------------------------------- */

describe("tenancy", () => {
  it("refuses to confirm another organization's draft", async () => {
    const store = demoStore();
    const other = store.organizations[1];
    const user = store.users[0];
    if (!other || !user) throw new Error("seed fixtures missing");

    const otherScope: OrganizationScope = {
      organizationId: other.id,
      userId: user.id,
      role: "owner",
    };

    await expect(
      dataSource.responseDrafts.confirmPublication(
        otherScope,
        approvedDraftId,
        user.id,
        CONFIRMED_AT,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("leaves the draft untouched after a refused cross-tenant attempt", async () => {
    const store = demoStore();
    const other = store.organizations[1];
    const user = store.users[0];
    if (!other || !user) throw new Error("seed fixtures missing");

    await dataSource.responseDrafts
      .confirmPublication(
        { organizationId: other.id, userId: user.id, role: "owner" },
        approvedDraftId,
        user.id,
        CONFIRMED_AT,
      )
      .catch(() => undefined);

    const draft = (await dataSource.responseDrafts.get(
      scope,
      approvedDraftId,
    )) as ResponseDraft;
    expect(draft.status).toBe("approved");
    expect(draft.publicationMethod).toBeNull();
  });
});
