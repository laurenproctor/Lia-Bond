import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg } from "./helpers/scope";
import { saveBrandVoice } from "@/lib/brand-voice/save";
import type { LiaDataSource } from "@/lib/data/types";
import type { UpdateBrandVoiceInput } from "@/domain";

/**
 * Saving the brand voice, through the service.
 *
 * Repositories and audit are production code here — what these tests are for is
 * how persistence and the trail fit together. A save that stores correctly but
 * records nothing, or one that records a change that did not happen, is exactly
 * the bug a unit test of either piece alone would miss.
 */

let data: LiaDataSource;

const input: UpdateBrandVoiceInput = {
  name: "Maison Laurent voice",
  axes: { warmth: 70, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
  approvedPhrases: ["thank you for sharing"],
  prohibitedPhrases: ["not our fault"],
};

beforeEach(() => {
  data = freshDataSource();
});

function auditEvents(scope = ushg.admin()) {
  return data.auditEvents.list(scope, { entityType: "brand_voice" });
}

describe("saveBrandVoice", () => {
  it("persists the change and reports it as changed", async () => {
    const scope = ushg.comms();
    const result = await saveBrandVoice({ dataSource: data, scope }, input);

    expect(result.changed).toBe(true);
    expect(result.profile.axes.warmth).toBe(70);
    expect((await data.brandVoice.get(scope))?.axes.warmth).toBe(70);
  });

  it("records exactly one audit event, attributed to the actor", async () => {
    const scope = ushg.comms();
    await saveBrandVoice({ dataSource: data, scope }, input);

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("brand_voice.updated");
    expect(events[0]?.entityType).toBe("brand_voice");
    expect(events[0]?.actorUserId).toBe(scope.userId);
  });

  it("records only the fields that moved", async () => {
    const scope = ushg.comms();
    const before = await data.brandVoice.get(scope);
    await saveBrandVoice(
      { dataSource: data, scope },
      {
        name: before?.name ?? "",
        axes: { ...(before?.axes ?? input.axes), warmth: 90 },
        approvedPhrases: before?.approvedPhrases ?? [],
        prohibitedPhrases: before?.prohibitedPhrases ?? [],
      },
    );

    const events = await auditEvents();
    expect(events[0]?.newState).toEqual({ warmth: 90 });
    expect(events[0]?.previousState).toEqual({ warmth: before?.axes.warmth });
  });

  it("writes no audit event when nothing changed", async () => {
    // An entry for a save that changed nothing is noise in the one place noise
    // is most expensive.
    const scope = ushg.comms();
    await saveBrandVoice({ dataSource: data, scope }, input);
    const first = await auditEvents();

    const second = await saveBrandVoice({ dataSource: data, scope }, input);

    expect(second.changed).toBe(false);
    expect(await auditEvents()).toHaveLength(first.length);
  });

  it("leaves the version alone on a no-op save", async () => {
    const scope = ushg.comms();
    const first = await saveBrandVoice({ dataSource: data, scope }, input);
    const second = await saveBrandVoice({ dataSource: data, scope }, input);
    expect(second.profile.version).toBe(first.profile.version);
  });

  it("records a creation with a null previous state", async () => {
    // Harbor has no seeded profile, so this is the insert path.
    const scope = harbor.owner();
    const result = await saveBrandVoice({ dataSource: data, scope }, input);

    expect(result.profile.version).toBe(1);

    const events = await data.auditEvents.list(scope, { entityType: "brand_voice" });
    expect(events).toHaveLength(1);
    expect(events[0]?.previousState).toBeNull();
    expect(events[0]?.newState).not.toBeNull();
  });

  it("keeps one organization's audit trail out of another's", async () => {
    await saveBrandVoice({ dataSource: data, scope: harbor.owner() }, input);
    expect(await auditEvents()).toHaveLength(0);
  });
});
