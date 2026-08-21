import { beforeEach, describe, expect, it } from "vitest";
import { can } from "@/lib/auth/permissions";
import type { LiaDataSource } from "@/lib/data/types";
import { resolveRenderedWidget } from "@/lib/widgets/render";
import {
  listWidgetReviewChoices,
  rotateReviewWidgetEmbedId,
  saveReviewWidget,
  setReviewWidgetStatus,
} from "@/lib/widgets/service";
import { freshDataSource, harbor, ORG_USHG, ushg } from "./helpers/scope";

/**
 * The widget lifecycle, end to end, against the demo data source.
 *
 * The cases that matter most here are not the happy path. They are the ones
 * where a widget could publish the wrong thing: a review from another
 * restaurant, a review from another *organization*, a review somebody
 * dismissed, or a review that keeps appearing after the person who pinned it
 * lost the right to.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

function context(scope = ushg.owner()) {
  return { dataSource: data, scope, actorUserId: scope.userId };
}

/** The ids the seed actually carries, resolved rather than hard-coded. */
async function locationIds(): Promise<{ westVillage: string; soho: string }> {
  const locations = await data.locations.list(ushg.owner());
  const westVillage = locations.find((row) => row.name === "West Village");
  const soho = locations.find((row) => row.name === "SoHo");
  if (!westVillage || !soho) throw new Error("seed fixtures missing");
  return { westVillage: westVillage.id, soho: soho.id };
}

function baseInput(locationId: string) {
  return {
    locationId,
    theme: "light" as const,
    layout: "single_review_text" as const,
    selectionMode: "most_recent" as const,
    selectedMentionId: null,
    minimumRating: 4,
    allowedDomains: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Creating and updating                                                       */
/* -------------------------------------------------------------------------- */

describe("saving a widget", () => {
  it("issues a public id on the first save", async () => {
    const { westVillage } = await locationIds();
    const { widget, created } = await saveReviewWidget(context(), baseInput(westVillage));

    expect(created).toBe(true);
    expect(widget.publicId).toMatch(/^rw_[A-Za-z0-9_-]{20}$/);
    expect(widget.status).toBe("active");
  });

  it("keeps the same public id across every later save", async () => {
    const { westVillage } = await locationIds();

    const first = await saveReviewWidget(context(), baseInput(westVillage));
    const second = await saveReviewWidget(context(), {
      ...baseInput(westVillage),
      theme: "dark",
    });

    // A snippet already pasted into a website must not stop working because
    // somebody changed a theme.
    expect(second.widget.publicId).toBe(first.widget.publicId);
    expect(second.created).toBe(false);
    expect(second.widget.theme).toBe("dark");
  });

  it("keeps one widget per location", async () => {
    const { westVillage } = await locationIds();

    await saveReviewWidget(context(), baseInput(westVillage));
    await saveReviewWidget(context(), baseInput(westVillage));

    const widgets = await data.reviewWidgets.list(ushg.owner());
    expect(widgets.filter((row) => row.locationId === westVillage)).toHaveLength(1);
  });

  it("normalises the approved domains and reports what it could not use", async () => {
    const { westVillage } = await locationIds();

    const result = await saveReviewWidget(context(), {
      ...baseInput(westVillage),
      allowedDomains: ["HTTPS://Example.com/menu", "example.com", "localhost"],
    });

    expect(result.widget.allowedDomains).toEqual(["example.com"]);
    expect(result.rejectedDomains).toEqual(["localhost"]);
  });

  it("refuses a location in another organization", async () => {
    const { westVillage } = await locationIds();

    await expect(
      saveReviewWidget(context(harbor.owner()), baseInput(westVillage)),
    ).rejects.toThrow();
  });

  it("refuses a selection mode of specific with nothing selected", async () => {
    const { westVillage } = await locationIds();

    await expect(
      saveReviewWidget(context(), {
        ...baseInput(westVillage),
        selectionMode: "specific",
      }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Pinning                                                                     */
/* -------------------------------------------------------------------------- */

describe("pinning a specific review", () => {
  async function eligibleAt(locationId: string): Promise<string> {
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId, minimumRating: 4 },
    );
    const eligible = choices.find((choice) => choice.eligible);
    if (!eligible) throw new Error("seed has no eligible review at this location");
    return eligible.mention.id;
  }

  it("accepts an eligible review at the same location", async () => {
    const { westVillage } = await locationIds();
    const mentionId = await eligibleAt(westVillage);

    const { widget } = await saveReviewWidget(context(), {
      ...baseInput(westVillage),
      selectionMode: "specific",
      selectedMentionId: mentionId,
    });

    expect(widget.selectedMentionId).toBe(mentionId);
  });

  it("refuses a review belonging to a different restaurant", async () => {
    // The failure the product brief names: a widget must never silently show
    // another location's review.
    const { westVillage } = await locationIds();
    const elsewhere = await eligibleAt(westVillage);
    const { soho } = await locationIds();

    await expect(
      saveReviewWidget(context(), {
        ...baseInput(soho),
        selectionMode: "specific",
        selectedMentionId: elsewhere,
      }),
    ).rejects.toThrow();
  });

  it("refuses an ineligible review even when the caller names it directly", async () => {
    // The interface only offers eligible reviews, but an action is a public
    // entry point and a crafted payload is not obliged to use it. SoHo carries
    // an escalated review, which is refused for a reason no floor can relax.
    const { soho } = await locationIds();
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId: soho, minimumRating: 4 },
    );
    const escalated = choices.find((choice) => choice.mention.status === "escalated");
    if (!escalated) throw new Error("seed has no escalated review at SoHo");

    await expect(
      saveReviewWidget(context(), {
        ...baseInput(soho),
        selectionMode: "specific",
        selectedMentionId: escalated.mention.id,
      }),
    ).rejects.toThrow();
  });

  it("lets somebody deliberately pin a review below the automatic floor", async () => {
    // The rating floor governs automatic selection only. A person pinning a
    // three-star review meant it, and overriding an explicit choice would be
    // the product second-guessing a deliberate decision.
    const { westVillage } = await locationIds();
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId: westVillage, minimumRating: 4 },
    );
    const belowFloor = choices.find((choice) => choice.refusedBy === "minimum_rating");
    if (!belowFloor) throw new Error("seed has no below-floor review at West Village");

    const { widget } = await saveReviewWidget(context(), {
      ...baseInput(westVillage),
      selectionMode: "specific",
      selectedMentionId: belowFloor.mention.id,
    });

    expect(widget.selectedMentionId).toBe(belowFloor.mention.id);

    // And it really is served, rather than quietly falling through to the
    // five-star one the automatic rule would have picked.
    const rendered = resolveRenderedWidget(
      await data.reviewWidgets.render(widget.publicId),
    );
    expect(rendered.state === "ready" && rendered.review.rating).toBe(3);
  });

  it("refuses a review from another organization", async () => {
    const { westVillage } = await locationIds();
    const harborMentions = await data.mentions.list(harbor.owner(), {
      sourceTypes: ["google_review"],
    });
    const theirs = harborMentions[0];
    if (!theirs) throw new Error("seed has no Harbor Google review");

    await expect(
      saveReviewWidget(context(), {
        ...baseInput(westVillage),
        selectionMode: "specific",
        selectedMentionId: theirs.id,
      }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The picker                                                                  */
/* -------------------------------------------------------------------------- */

describe("the review picker", () => {
  it("lists ineligible reviews with the reason rather than hiding them", async () => {
    const { soho } = await locationIds();
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId: soho, minimumRating: 4 },
    );

    const refused = choices.filter((choice) => !choice.eligible);
    expect(refused.length).toBeGreaterThan(0);
    for (const choice of refused) expect(choice.refusedBy).not.toBeNull();
  });

  it("marks the escalated review as escalated, not as low-rated", async () => {
    // SoHo carries a one-star escalated review. The first rule to refuse it
    // must be the one a person can act on.
    const { soho } = await locationIds();
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId: soho, minimumRating: 4 },
    );

    const escalated = choices.find((choice) => choice.mention.status === "escalated");
    expect(escalated?.refusedBy).toBe("not_escalated");
  });

  it("never lists another location's reviews", async () => {
    const { westVillage } = await locationIds();
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId: westVillage, minimumRating: 4 },
    );

    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      expect(choice.mention.locationId).toBe(westVillage);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Switching off and regenerating                                              */
/* -------------------------------------------------------------------------- */

describe("switching a widget off", () => {
  it("keeps the public id, so the snippet stays valid", async () => {
    const { westVillage } = await locationIds();
    const { widget } = await saveReviewWidget(context(), baseInput(westVillage));

    const disabled = await setReviewWidgetStatus(context(), {
      locationId: westVillage,
      status: "disabled",
    });

    expect(disabled.status).toBe("disabled");
    expect(disabled.publicId).toBe(widget.publicId);
  });

  it("is idempotent, and writes no second event", async () => {
    const { westVillage } = await locationIds();
    await saveReviewWidget(context(), baseInput(westVillage));

    await setReviewWidgetStatus(context(), { locationId: westVillage, status: "disabled" });
    await setReviewWidgetStatus(context(), { locationId: westVillage, status: "disabled" });

    const events = await data.auditEvents.list(ushg.owner());
    const disables = events.filter((event) => event.eventType === "review_widget.disabled");
    expect(disables).toHaveLength(1);
  });
});

describe("regenerating the embed code", () => {
  it("issues a different id and reports the retired one", async () => {
    const { westVillage } = await locationIds();
    const { widget } = await saveReviewWidget(context(), baseInput(westVillage));

    const rotated = await rotateReviewWidgetEmbedId(context(), {
      locationId: westVillage,
      now: "2026-08-20T12:00:00.000Z",
    });

    expect(rotated.widget.publicId).not.toBe(widget.publicId);
    // Lia cannot know which pages carry the old snippet, so telling the
    // customer what to search for is the only honest help available.
    expect(rotated.previousPublicId).toBe(widget.publicId);
    expect(rotated.widget.publicIdRotatedAt).toBe("2026-08-20T12:00:00.000Z");
  });

  it("makes the old id stop resolving", async () => {
    const { westVillage } = await locationIds();
    const { widget } = await saveReviewWidget(context(), baseInput(westVillage));

    await rotateReviewWidgetEmbedId(context(), {
      locationId: westVillage,
      now: "2026-08-20T12:00:00.000Z",
    });

    expect(await data.reviewWidgets.render(widget.publicId)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The public render path                                                      */
/* -------------------------------------------------------------------------- */

describe("what a website visitor gets", () => {
  it("serves the newest eligible review for that location only", async () => {
    const { westVillage } = await locationIds();
    const { widget } = await saveReviewWidget(context(), baseInput(westVillage));

    const row = await data.reviewWidgets.render(widget.publicId);
    expect(row).not.toBeNull();

    const rendered = resolveRenderedWidget(row);
    expect(rendered.state).toBe("ready");
    if (rendered.state !== "ready") return;

    // The seed's West Village five-star review, and not the three-star one
    // sitting alongside it.
    expect(rendered.review.rating).toBe(5);

    const mentions = await data.mentions.list(ushg.owner(), { locationId: westVillage });
    const match = mentions.find((mention) => mention.content === rendered.review.text);
    expect(match?.locationId).toBe(westVillage);
  });

  it("carries no internal workflow state off the tenant boundary", async () => {
    const { westVillage } = await locationIds();
    const { widget } = await saveReviewWidget(context(), baseInput(westVillage));

    const row = await data.reviewWidgets.render(widget.publicId);

    // The render row is the anonymous surface. Anything not on it cannot leak,
    // whatever the renderer does with it.
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "allowedDomains",
      "attributionSuppressed",
      "layout",
      "profileUrl",
      "reviewAuthorName",
      "reviewPublishedAt",
      "reviewRating",
      "reviewText",
      "selectionMode",
      "status",
      "theme",
    ]);
  });

  it("goes quiet when the pinned review is dismissed, rather than showing another", async () => {
    const { westVillage } = await locationIds();
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId: westVillage, minimumRating: 4 },
    );
    const eligible = choices.find((choice) => choice.eligible);
    if (!eligible) throw new Error("seed has no eligible review at West Village");

    const { widget } = await saveReviewWidget(context(), {
      ...baseInput(westVillage),
      selectionMode: "specific",
      selectedMentionId: eligible.mention.id,
    });

    await data.mentions.updateStatus(ushg.owner(), eligible.mention.id, "dismissed");

    const rendered = resolveRenderedWidget(
      await data.reviewWidgets.render(widget.publicId),
    );

    expect(rendered.state).toBe("unavailable");
    if (rendered.state !== "unavailable") return;
    expect(rendered.reason).toBe("selected_review_unavailable");
  });

  it("returns nothing for an id nobody issued", async () => {
    expect(await data.reviewWidgets.render("rw_notarealwidgetidxx")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                     */
/* -------------------------------------------------------------------------- */

describe("cross-tenant isolation", () => {
  it("never lists another organization's widgets", async () => {
    const { westVillage } = await locationIds();
    await saveReviewWidget(context(), baseInput(westVillage));

    const mine = await data.reviewWidgets.list(ushg.owner());
    const theirs = await data.reviewWidgets.list(harbor.owner());

    expect(mine.every((row) => row.organizationId === ORG_USHG)).toBe(true);
    expect(theirs).toEqual([]);
  });

  it("cannot reach another organization's widget by location id", async () => {
    const { westVillage } = await locationIds();
    await saveReviewWidget(context(), baseInput(westVillage));

    expect(
      await data.reviewWidgets.getForLocation(harbor.owner(), westVillage),
    ).toBeNull();
  });

  it("refuses to switch off a widget from another organization", async () => {
    const { westVillage } = await locationIds();
    await saveReviewWidget(context(), baseInput(westVillage));

    await expect(
      setReviewWidgetStatus(context(harbor.owner()), {
        locationId: westVillage,
        status: "disabled",
      }),
    ).rejects.toThrow();
  });

  it("resolves the render row against the widget's own organization", async () => {
    // The one scopeless read in the data layer. It must derive the tenant from
    // the widget row rather than from anything the caller supplied.
    const { westVillage } = await locationIds();
    const { widget } = await saveReviewWidget(context(), baseInput(westVillage));

    const row = await data.reviewWidgets.render(widget.publicId);
    const rendered = resolveRenderedWidget(row);
    if (rendered.state !== "ready") throw new Error("expected a review");

    const harborMentions = await data.mentions.list(harbor.owner());
    expect(
      harborMentions.some((mention) => mention.content === rendered.review.text),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The audit trail                                                             */
/* -------------------------------------------------------------------------- */

describe("the audit trail", () => {
  it("records a creation, an update, and a rotation under distinct names", async () => {
    const { westVillage } = await locationIds();

    await saveReviewWidget(context(), baseInput(westVillage));
    await saveReviewWidget(context(), { ...baseInput(westVillage), theme: "dark" });
    await rotateReviewWidgetEmbedId(context(), {
      locationId: westVillage,
      now: "2026-08-20T12:00:00.000Z",
    });

    const types = (await data.auditEvents.list(ushg.owner()))
      .filter((event) => event.entityType === "review_widget")
      .map((event) => event.eventType);

    expect(types).toContain("review_widget.created");
    expect(types).toContain("review_widget.updated");
    expect(types).toContain("review_widget.embed_id_rotated");
  });

  it("writes nothing when a save changes nothing", async () => {
    const { westVillage } = await locationIds();

    await saveReviewWidget(context(), baseInput(westVillage));
    await saveReviewWidget(context(), baseInput(westVillage));

    const updates = (await data.auditEvents.list(ushg.owner())).filter(
      (event) => event.eventType === "review_widget.updated",
    );
    expect(updates).toHaveLength(0);
  });

  it("never records the review's words or the reviewer's name", async () => {
    // The widget publishes those. The audit trail is not where a second copy
    // of them belongs — the rule every other event about a mention keeps.
    const { westVillage } = await locationIds();
    const choices = await listWidgetReviewChoices(
      { dataSource: data, scope: ushg.owner() },
      { locationId: westVillage, minimumRating: 4 },
    );
    const eligible = choices.find((choice) => choice.eligible);
    if (!eligible) throw new Error("seed has no eligible review at West Village");

    await saveReviewWidget(context(), {
      ...baseInput(westVillage),
      selectionMode: "specific",
      selectedMentionId: eligible.mention.id,
    });

    const events = (await data.auditEvents.list(ushg.owner())).filter(
      (event) => event.entityType === "review_widget",
    );
    const serialised = JSON.stringify(events);

    expect(serialised).toContain(eligible.mention.id);
    expect(serialised).not.toContain(eligible.mention.content.slice(0, 30));
    if (eligible.mention.authorName) {
      expect(serialised).not.toContain(eligible.mention.authorName);
    }
  });

  it("records both ids on a rotation, so a retired snippet stays traceable", async () => {
    const { westVillage } = await locationIds();
    const { widget } = await saveReviewWidget(context(), baseInput(westVillage));

    const rotated = await rotateReviewWidgetEmbedId(context(), {
      locationId: westVillage,
      now: "2026-08-20T12:00:00.000Z",
    });

    const event = (await data.auditEvents.list(ushg.owner())).find(
      (row) => row.eventType === "review_widget.embed_id_rotated",
    );

    expect(event?.previousState).toMatchObject({ publicId: widget.publicId });
    expect(event?.newState).toMatchObject({ publicId: rotated.widget.publicId });
  });
});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

describe("who may configure a widget", () => {
  it("is the roles that already decide what the product says", () => {
    expect(can("owner", "website_widget.manage")).toBe(true);
    expect(can("admin", "website_widget.manage")).toBe(true);
    expect(can("communications_lead", "website_widget.manage")).toBe(true);
  });

  it("excludes every read-only role", () => {
    expect(can("analyst", "website_widget.manage")).toBe(false);
    expect(can("viewer", "website_widget.manage")).toBe(false);
  });

  it("excludes approvers and location managers", () => {
    // Approvers sign off text; they do not publish it. Location managers are
    // absent because the RLS policies restate this list with
    // `has_organization_role`, which cannot express per-location scoping —
    // and this is a surface the public can see.
    expect(can("approver", "website_widget.manage")).toBe(false);
    expect(can("location_manager", "website_widget.manage")).toBe(false);
  });

  it("matches the roles named in the RLS policies", () => {
    // Restated here rather than trusted, because the two lists are written in
    // two languages and drift silently.
    const allowed = (["owner", "admin", "communications_lead"] as const).every((role) =>
      can(role, "website_widget.manage"),
    );
    expect(allowed).toBe(true);
  });
});
