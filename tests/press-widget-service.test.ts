import { beforeEach, describe, expect, it } from "vitest";
import { can, PERMISSIONS } from "@/lib/auth/permissions";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource } from "@/lib/data/types";
import { MEMBERSHIP_ROLES } from "@/domain";
import { resolveRenderedPressWidget } from "@/lib/widgets/press/render";
import {
  listPressStoryChoices,
  rotatePressWidgetEmbedId,
  savePressWidget,
  setPressWidgetStatus,
} from "@/lib/widgets/press/service";
import { MQ_HARBOR_BRAND, MQ_USHG_BRAND, MQ_USHG_GRAMERCY } from "@/lib/seed/dataset";
import { freshDataSource, harbor, ORG_USHG, ushg } from "./helpers/scope";

/**
 * The press widget lifecycle, end to end, against the demo data source.
 *
 * The cases that matter most here are not the happy path. They are the ones
 * where a widget could publish the wrong thing: coverage found by another
 * organization's watch, coverage somebody dismissed, a syndicated copy of a
 * story already on the page, or a strip that keeps resolving after its owner
 * asked for it to stop.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

function context(scope = ushg.owner()) {
  return { dataSource: data, scope, actorUserId: scope.userId };
}

function baseInput() {
  return {
    theme: "light" as const,
    layout: "recent_press_list" as const,
    monitoringQueryId: null,
    itemLimit: 3,
    allowedDomains: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Creating and updating                                                       */
/* -------------------------------------------------------------------------- */

describe("saving a press widget", () => {
  it("issues a public id on the first save", async () => {
    const { widget, created } = await savePressWidget(context(), baseInput());

    expect(created).toBe(true);
    expect(widget.publicId).toMatch(/^pw_[A-Za-z0-9_-]{20}$/);
    expect(widget.status).toBe("active");
    expect(widget.itemLimit).toBe(3);
  });

  it("keeps the same public id across every later save", async () => {
    const first = await savePressWidget(context(), baseInput());
    const second = await savePressWidget(context(), { ...baseInput(), theme: "dark" });

    // A snippet already pasted into a website must not stop working because
    // somebody changed a theme.
    expect(second.widget.publicId).toBe(first.widget.publicId);
    expect(second.created).toBe(false);
    expect(second.widget.theme).toBe("dark");
  });

  it("keeps one widget per organization rather than creating a second", async () => {
    await savePressWidget(context(), baseInput());
    await savePressWidget(context(), { ...baseInput(), itemLimit: 1 });

    const widget = await data.pressWidgets.get(ushg.owner());
    expect(widget?.itemLimit).toBe(1);
  });

  it("never lets a caller choose the public id", async () => {
    // `publicId` is not on the input type, so this is a compile-time
    // guarantee as well — asserted at runtime because the action's input is
    // `unknown` and a crafted payload is not obliged to respect the type.
    const { widget } = await savePressWidget(context(), {
      ...baseInput(),
      publicId: "pw_attackerchosen00000",
    });
    expect(widget.publicId).not.toBe("pw_attackerchosen00000");
  });

  it("never lets a caller switch the widget on through a save", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    await setPressWidgetStatus(context(), { status: "disabled" });

    const after = await savePressWidget(context(), {
      ...baseInput(),
      status: "active",
      theme: "dark",
    });

    // "Your widget came back on" must never be a side effect of saving a
    // theme, in either direction.
    expect(after.widget.status).toBe("disabled");
    expect(after.widget.id).toBe(widget.id);
  });

  it("normalises approved domains and reports the ones it could not use", async () => {
    const { widget, rejectedDomains } = await savePressWidget(context(), {
      ...baseInput(),
      allowedDomains: [
        "https://Example.com/",
        "example.com",
        "*.example.com",
        "localhost",
        "203.0.113.7",
      ],
    });

    expect(widget.allowedDomains).toEqual(["example.com", "*.example.com"]);
    // Saved five, kept two, and said which three could not be enforced —
    // rather than refusing the whole save and making somebody bisect.
    expect(rejectedDomains).toEqual(["localhost", "203.0.113.7"]);
  });

  it.each([0, 4, 99, -1])("refuses an item limit of %i", async (itemLimit) => {
    await expect(savePressWidget(context(), { ...baseInput(), itemLimit })).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                     */
/* -------------------------------------------------------------------------- */

describe("attaching a monitoring query", () => {
  it("accepts one of the organization's own enabled watches", async () => {
    const { widget } = await savePressWidget(context(), {
      ...baseInput(),
      monitoringQueryId: MQ_USHG_GRAMERCY,
    });
    expect(widget.monitoringQueryId).toBe(MQ_USHG_GRAMERCY);
  });

  it("refuses another organization's watch, as not found", async () => {
    // The cross-tenant case, and the reason `press_widgets_query_same_org` is
    // a composite foreign key rather than a simple one: this check is the
    // first line, and the database is the last.
    //
    // Reported as "not found" rather than "belongs to another organization",
    // because the second sentence to a caller who supplied an arbitrary UUID
    // would confirm the id exists — an existence oracle across the boundary.
    await expect(
      savePressWidget(context(), {
        ...baseInput(),
        monitoringQueryId: MQ_HARBOR_BRAND,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses it symmetrically, from the other tenant's side", async () => {
    await expect(
      savePressWidget(context(harbor.owner()), {
        ...baseInput(),
        monitoringQueryId: MQ_USHG_BRAND,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a watch that does not exist at all", async () => {
    await expect(
      savePressWidget(context(), {
        ...baseInput(),
        monitoringQueryId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("refuses a switched-off watch, and says why", async () => {
    // Attaching one would produce a widget that publishes nothing —
    // `query_enabled` is an eligibility rule — so refusing at the save is
    // better than letting somebody publish a blank strip and work out why
    // later.
    await data.monitoringQueries.update(ushg.owner(), MQ_USHG_GRAMERCY, {
      enabled: false,
    });

    await expect(
      savePressWidget(context(), {
        ...baseInput(),
        monitoringQueryId: MQ_USHG_GRAMERCY,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps one organization's widget invisible to another", async () => {
    await savePressWidget(context(), baseInput());
    expect(await data.pressWidgets.get(harbor.owner())).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Enable, disable, rotate                                                     */
/* -------------------------------------------------------------------------- */

describe("switching a widget off and on", () => {
  it("disables and re-enables without touching the public id", async () => {
    const { widget } = await savePressWidget(context(), baseInput());

    const off = await setPressWidgetStatus(context(), { status: "disabled" });
    expect(off.status).toBe("disabled");
    expect(off.publicId).toBe(widget.publicId);

    const on = await setPressWidgetStatus(context(), { status: "active" });
    expect(on.status).toBe("active");
    expect(on.publicId).toBe(widget.publicId);
  });

  it("is idempotent, and writes no second audit event", async () => {
    await savePressWidget(context(), baseInput());
    await setPressWidgetStatus(context(), { status: "disabled" });
    await setPressWidgetStatus(context(), { status: "disabled" });

    const events = await data.auditEvents.list(ushg.owner(), {
      eventTypes: ["press_widget.disabled"],
    });
    expect(events).toHaveLength(1);
  });

  it("refuses when there is no widget yet", async () => {
    await expect(
      setPressWidgetStatus(context(), { status: "disabled" }),
    ).rejects.toBeInstanceOf(DataError);
  });
});

describe("rotating the embed id", () => {
  it("issues a new id and reports the retired one exactly once", async () => {
    const { widget } = await savePressWidget(context(), baseInput());

    const result = await rotatePressWidgetEmbedId(context(), {
      now: "2026-09-01T12:00:00.000Z",
    });

    expect(result.previousPublicId).toBe(widget.publicId);
    expect(result.widget.publicId).not.toBe(widget.publicId);
    expect(result.widget.publicId).toMatch(/^pw_[A-Za-z0-9_-]{20}$/);
    expect(result.widget.publicIdRotatedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("stops the old id resolving, and starts the new one", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    const rotated = await rotatePressWidgetEmbedId(context(), {
      now: "2026-09-01T12:00:00.000Z",
    });

    expect(await data.pressWidgets.render(widget.publicId)).toBeNull();
    expect(await data.pressWidgets.render(rotated.widget.publicId)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The audit trail                                                             */
/* -------------------------------------------------------------------------- */

describe("the audit trail", () => {
  it("records a creation, an update, a disable, and a rotation, each by name", async () => {
    await savePressWidget(context(), baseInput());
    await savePressWidget(context(), { ...baseInput(), theme: "dark" });
    await setPressWidgetStatus(context(), { status: "disabled" });
    await rotatePressWidgetEmbedId(context(), { now: "2026-09-01T12:00:00.000Z" });

    const events = await data.auditEvents.list(ushg.owner(), {});
    const types = events.map((event) => event.eventType);

    expect(types).toContain("press_widget.created");
    expect(types).toContain("press_widget.updated");
    expect(types).toContain("press_widget.disabled");
    expect(types).toContain("press_widget.embed_id_rotated");
  });

  it("writes nothing when a save changes nothing", async () => {
    await savePressWidget(context(), baseInput());
    await savePressWidget(context(), baseInput());

    const events = await data.auditEvents.list(ushg.owner(), {
      eventTypes: ["press_widget.updated"],
    });
    // Pressing save twice is not an event, and a trail full of empty diffs is
    // a trail nobody reads.
    expect(events).toHaveLength(0);
  });

  it("names the actor on every event", async () => {
    await savePressWidget(context(ushg.comms()), baseInput());

    const [event] = await data.auditEvents.list(ushg.owner(), {
      eventTypes: ["press_widget.created"],
    });
    expect(event?.actorUserId).toBe(ushg.comms().userId);
  });

  it("copies no article content, publisher, or monitoring keyword into the trail", async () => {
    await savePressWidget(context(), {
      ...baseInput(),
      monitoringQueryId: MQ_USHG_GRAMERCY,
    });
    await savePressWidget(context(), { ...baseInput(), itemLimit: 1 });
    await rotatePressWidgetEmbedId(context(), { now: "2026-09-01T12:00:00.000Z" });

    const events = await data.auditEvents.list(ushg.owner(), {});
    const serialized = JSON.stringify(events);

    // The widget publishes headlines and publishers; the audit trail is not
    // where a second copy of them belongs. The monitoring query's *keywords*
    // are the customer's own competitive information and are worse still.
    for (const leaked of [
      "spring tasting menu",
      "Eater New York",
      "Time Out",
      "Maison Laurent",
      "Prince Street",
      "eater.com",
    ]) {
      expect(serialized, leaked).not.toContain(leaked);
    }

    // What it does carry: the decision, reconstructable from ids alone.
    expect(serialized).toContain(MQ_USHG_GRAMERCY);
    expect(serialized).toContain("itemLimit");
  });

  it("records both ids on a rotation", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    const rotated = await rotatePressWidgetEmbedId(context(), {
      now: "2026-09-01T12:00:00.000Z",
    });

    const [event] = await data.auditEvents.list(ushg.owner(), {
      eventTypes: ["press_widget.embed_id_rotated"],
    });

    // The old id is the only way to answer "which snippet stopped working,
    // and when" months later, and neither is a secret — the old one is in the
    // customer's own page source.
    expect(JSON.stringify(event?.previousState)).toContain(widget.publicId);
    expect(JSON.stringify(event?.newState)).toContain(rotated.widget.publicId);
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering, through the demo adapter's anonymous path                        */
/* -------------------------------------------------------------------------- */

describe("what the public embed resolves to", () => {
  it("returns null for an id nobody issued", async () => {
    expect(await data.pressWidgets.render("pw_doesnotexist000000")).toBeNull();
  });

  it("returns the row for a disabled widget rather than nothing", async () => {
    // Returning no row would make a disabled widget indistinguishable from a
    // deleted one, and those are two different sentences on a customer's page.
    const { widget } = await savePressWidget(context(), baseInput());
    await setPressWidgetStatus(context(), { status: "disabled" });

    const row = await data.pressWidgets.render(widget.publicId);
    expect(row?.status).toBe("disabled");
    expect(resolveRenderedPressWidget(row).state).toBe("unavailable");
  });

  it("draws the organization's own coverage, newest first", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    const row = await data.pressWidgets.render(widget.publicId);

    expect(row?.stories.length).toBeGreaterThan(0);
    const dates = (row?.stories ?? []).map((story) => story.publishedAt ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("never crosses the tenant boundary", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    const row = await data.pressWidgets.render(widget.publicId);

    const harborMentions = await data.mentions.list(harbor.owner(), {
      sourceTypes: ["news_article"],
    });
    const harborHeadlines = new Set(harborMentions.map((mention) => mention.title));

    for (const story of row?.stories ?? []) {
      expect(harborHeadlines.has(story.headline)).toBe(false);
    }
  });

  it("honours the item limit", async () => {
    const { widget } = await savePressWidget(context(), { ...baseInput(), itemLimit: 1 });
    const row = await data.pressWidgets.render(widget.publicId);
    expect(row?.stories).toHaveLength(1);
  });

  it("narrows to the selected watch", async () => {
    const { widget } = await savePressWidget(context(), {
      ...baseInput(),
      monitoringQueryId: MQ_USHG_BRAND,
    });
    const row = await data.pressWidgets.render(widget.publicId);

    const expected = (
      await data.mentions.list(ushg.owner(), {
        sourceTypes: ["news_article"],
        monitoringQueryId: MQ_USHG_BRAND,
      })
    ).map((mention) => mention.title);

    for (const story of row?.stories ?? []) {
      expect(expected).toContain(story.headline);
    }
  });

  it("empties when the selected watch is switched off after the fact", async () => {
    const { widget } = await savePressWidget(context(), {
      ...baseInput(),
      monitoringQueryId: MQ_USHG_BRAND,
    });

    await data.monitoringQueries.update(ushg.owner(), MQ_USHG_BRAND, { enabled: false });

    const row = await data.pressWidgets.render(widget.publicId);
    expect(row?.stories).toEqual([]);
    expect(resolveRenderedPressWidget(row)).toMatchObject({
      state: "unavailable",
      reason: "no_eligible_press",
    });
  });

  it("drops a story the moment somebody dismisses it, with no widget write", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    const before = await data.pressWidgets.render(widget.publicId);
    const first = before?.stories[0];
    expect(first).toBeDefined();

    const mention = (
      await data.mentions.list(ushg.owner(), { sourceTypes: ["news_article"] })
    ).find((row) => row.title === first?.headline);
    expect(mention).toBeDefined();

    await data.mentions.updateStatus(ushg.owner(), mention!.id, "dismissed");

    const after = await data.pressWidgets.render(widget.publicId);
    // This is the property that makes "the widget holds no copy of the
    // article" worth the join it costs.
    expect(after?.stories.map((story) => story.headline)).not.toContain(first?.headline);
  });

  it("exposes only the six documented story fields", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    const row = await data.pressWidgets.render(widget.publicId);

    // The anonymous surface is bounded by the *type*, so this asserts the
    // shape the adapter actually produces rather than trusting the interface.
    for (const story of row?.stories ?? []) {
      expect(Object.keys(story).sort()).toEqual([
        "excerpt",
        "headline",
        "publishedAt",
        "publisherDomain",
        "publisherName",
        "sourceUrl",
      ]);
    }

    expect(Object.keys(row ?? {}).sort()).toEqual([
      "allowedDomains",
      "attributionSuppressed",
      "layout",
      "status",
      "stories",
      "theme",
    ]);
  });

  it("carries no organization id, mention id, status, sentiment, or score", async () => {
    const { widget } = await savePressWidget(context(), baseInput());
    const row = await data.pressWidgets.render(widget.publicId);
    const serialized = JSON.stringify(row);

    expect(serialized).not.toContain(ORG_USHG);
    for (const leaked of ["sentiment", "riskLevel", "relevanceScore", "rawPayload", "monitoringQueryId"]) {
      expect(serialized, leaked).not.toContain(leaked);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The configuration screen's list                                             */
/* -------------------------------------------------------------------------- */

describe("the candidate list", () => {
  it("marks ineligible coverage rather than hiding it", async () => {
    const mentions = await data.mentions.list(ushg.owner(), {
      sourceTypes: ["news_article"],
    });
    const first = mentions[0];
    expect(first).toBeDefined();

    await data.mentions.updateStatus(ushg.owner(), first!.id, "dismissed");

    const choices = await listPressStoryChoices(
      { dataSource: data, scope: ushg.owner() },
      { monitoringQueryId: null },
    );

    const refused = choices.find((choice) => choice.mention.id === first!.id);
    // Hiding it produces the support question this feature is most likely to
    // generate, with nowhere for the person to find the answer.
    expect(refused).toBeDefined();
    expect(refused?.eligible).toBe(false);
    expect(refused?.refusedBy).toBe("not_dismissed");
  });

  it("scores against the widget's own watch, so the list matches the widget", async () => {
    const choices = await listPressStoryChoices(
      { dataSource: data, scope: ushg.owner() },
      { monitoringQueryId: MQ_USHG_BRAND },
    );

    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      expect(choice.mention.monitoringQueryId).toBe(MQ_USHG_BRAND);
    }
  });

  it("returns nothing for another tenant's watch rather than that tenant's coverage", async () => {
    const choices = await listPressStoryChoices(
      { dataSource: data, scope: ushg.owner() },
      { monitoringQueryId: MQ_HARBOR_BRAND },
    );
    expect(choices).toEqual([]);
  });

  it("is ordered newest first", async () => {
    const choices = await listPressStoryChoices(
      { dataSource: data, scope: ushg.owner() },
      { monitoringQueryId: null },
    );
    const dates = choices.map((choice) => choice.mention.publishedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

describe("who may configure a website widget", () => {
  it("admits the three roles that decide what the product says", () => {
    expect(can("owner", "website_widget.manage")).toBe(true);
    expect(can("admin", "website_widget.manage")).toBe(true);
    expect(can("communications_lead", "website_widget.manage")).toBe(true);
  });

  it("excludes the read-only roles", () => {
    expect(can("analyst", "website_widget.manage")).toBe(false);
    expect(can("viewer", "website_widget.manage")).toBe(false);
  });

  it("excludes approvers and location managers", () => {
    // A press widget carries no location at all, only a monitoring query — so
    // there is nothing to scope a location manager to even in principle.
    expect(can("approver", "website_widget.manage")).toBe(false);
    expect(can("location_manager", "website_widget.manage")).toBe(false);
  });

  it("is one permission covering both widgets, not two with identical lists", () => {
    // Two names for one authority is a place for two lists to drift apart.
    expect(PERMISSIONS).toContain("website_widget.manage");
    expect(PERMISSIONS).not.toContain("review_widget.manage");
    expect(PERMISSIONS).not.toContain("press_widget.manage");
  });

  it("matches the role list the RLS policies restate", () => {
    const allowed = MEMBERSHIP_ROLES.filter((role) => can(role, "website_widget.manage"));
    expect([...allowed].sort()).toEqual(["admin", "communications_lead", "owner"]);
  });
});
