import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_MENTION_DEFAULTS, type Mention } from "@/domain";
import {
  firstFailedPressRule,
  isPressEligibleArticle,
  PRESS_WIDGET_ELIGIBILITY_RULES,
  selectPressStories,
} from "@/lib/widgets/press/eligibility";

/**
 * Which coverage may be published on a customer's website.
 *
 * The most consequential predicate in the press widget — everything it admits
 * ends up on a homepage, cited as proof — so every rule gets its own case
 * rather than one "eligible/ineligible" pair.
 *
 * The last block is the one that guards a bug nothing else here could catch.
 * The anonymous render path cannot run this predicate: an embed request has no
 * session, so it goes through `public.press_widget_render`, whose `where`
 * clauses are a hand-written SQL mirror of the list below. Every test in this
 * file would pass with the two out of step, and the symptom in production
 * would be that the coverage a customer sees listed inside Lia and the
 * coverage their website serves are chosen by different rules. So the
 * migration is parsed and required to name every rule.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const QUERY = "77777777-7777-4777-8777-777777777777";

const BASE: Mention = {
  ...NEW_MENTION_DEFAULTS,
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: ORG,
  locationId: null,
  platformConnectionId: "44444444-4444-4444-8444-444444444444",
  platformProfileId: null,
  sourceType: "news_article",
  externalId: "https://harbourledger.example/story",
  externalParentId: null,
  sourceUrl: "https://harbourledger.example/story",
  title: "A dining room that taught a neighbourhood to book early",
  content: "A long look at how one kitchen rebuilt its lunch service.",
  authorName: "A Reporter",
  authorExternalId: null,
  rating: null,
  language: "en",
  publishedAt: "2026-08-01T12:00:00.000Z",
  receivedAt: "2026-08-01T12:05:00.000Z",
  status: "monitoring",
  sentiment: "positive",
  riskLevel: "low",
  relevanceScore: 0.9,
  engagementScore: null,
  rawPayload: {},
  publisherName: "The Harbour Ledger",
  publisherDomain: "harbourledger.example",
  monitoringQueryId: QUERY,
  createdAt: "2026-08-01T12:05:00.000Z",
  updatedAt: "2026-08-01T12:05:00.000Z",
};

/** All-press mode: no query selected, so `query` and `query_enabled` are moot. */
const ALL_PRESS = { organizationId: ORG, monitoringQueryId: null };

function mention(overrides: Partial<Mention> = {}): Mention {
  return { ...BASE, ...overrides };
}

describe("an article that may be published", () => {
  it("accepts an ordinary news article with a headline and a link", () => {
    expect(firstFailedPressRule(mention(), ALL_PRESS)).toBeNull();
    expect(isPressEligibleArticle(mention(), ALL_PRESS)).toBe(true);
  });

  it("accepts one whose workflow state is merely internal", () => {
    // The rule this asserts the *absence* of. "Responded", "monitoring", and
    // "no action recommended" all say something about Lia's queue and nothing
    // about whether the article exists — and an article Lia recommends no
    // action on is very often the best coverage a customer has.
    for (const status of ["new", "monitoring", "responded", "analyzed"] as const) {
      expect(firstFailedPressRule(mention({ status }), ALL_PRESS), status).toBeNull();
    }
  });
});

describe("each rule refuses on its own", () => {
  it("refuses an article belonging to another organization", () => {
    const other = mention({ organizationId: "99999999-9999-4999-8999-999999999999" });
    expect(firstFailedPressRule(other, ALL_PRESS)).toBe("organization");
  });

  it("refuses anything that is not a news article", () => {
    for (const sourceType of ["google_review", "reddit_post", "article_comment"] as const) {
      expect(firstFailedPressRule(mention({ sourceType }), ALL_PRESS), sourceType).toBe(
        "source",
      );
    }
  });

  it("refuses an article found by a different watch when one is selected", () => {
    const input = { organizationId: ORG, monitoringQueryId: QUERY, selectedQueryEnabled: true };
    const elsewhere = mention({ monitoringQueryId: "88888888-8888-4888-8888-888888888888" });
    expect(firstFailedPressRule(elsewhere, input)).toBe("query");
    // And one attributed to no watch at all.
    expect(firstFailedPressRule(mention({ monitoringQueryId: null }), input)).toBe("query");
  });

  it("refuses every article when the selected watch is switched off", () => {
    const input = { organizationId: ORG, monitoringQueryId: QUERY, selectedQueryEnabled: false };
    expect(firstFailedPressRule(mention(), input)).toBe("query_enabled");
  });

  it("treats an unstated enabled flag as switched off", () => {
    // Fail closed. A caller that forgot to load the query must produce an
    // empty widget, never one drawing on a watch nobody checked.
    const input = { organizationId: ORG, monitoringQueryId: QUERY };
    expect(firstFailedPressRule(mention(), input)).toBe("query_enabled");
  });

  it("ignores the watch entirely in all-press mode", () => {
    expect(firstFailedPressRule(mention({ monitoringQueryId: null }), ALL_PRESS)).toBeNull();
  });

  it("refuses an article with no headline", () => {
    expect(firstFailedPressRule(mention({ title: null }), ALL_PRESS)).toBe("headline");
    expect(firstFailedPressRule(mention({ title: "   " }), ALL_PRESS)).toBe("headline");
  });

  it("refuses an article with no usable link", () => {
    // The card *is* a link. A headline a reader cannot check is the shape of a
    // fabricated one.
    expect(firstFailedPressRule(mention({ sourceUrl: null }), ALL_PRESS)).toBe("source_url");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//harbourledger.example/story",
    "file:///etc/passwd",
    "ftp://harbourledger.example/story",
    "not a url at all",
  ])("refuses %s as a destination", (sourceUrl) => {
    expect(firstFailedPressRule(mention({ sourceUrl }), ALL_PRESS)).toBe("source_url");
  });

  it("accepts plain http, which small publishers still serve", () => {
    const plain = mention({ sourceUrl: "http://northsidedispatch.example/story" });
    expect(firstFailedPressRule(plain, ALL_PRESS)).toBeNull();
  });

  it("refuses a dismissed article", () => {
    expect(firstFailedPressRule(mention({ status: "dismissed" }), ALL_PRESS)).toBe(
      "not_dismissed",
    );
  });

  it("refuses an escalated article, because it was routed to a person as a risk", () => {
    expect(firstFailedPressRule(mention({ status: "escalated" }), ALL_PRESS)).toBe(
      "not_escalated",
    );
  });

  it("refuses an article no longer published at the source", () => {
    const removed = mention({ sourceRemovedAt: "2026-08-02T00:00:00.000Z" });
    expect(firstFailedPressRule(removed, ALL_PRESS)).toBe("present_at_source");
  });

  it("refuses a syndicated copy", () => {
    // One wire story printed three times is not three publications covering
    // you, and a three-item strip is exactly where that difference shows.
    expect(firstFailedPressRule(mention({ isSyndicated: true }), ALL_PRESS)).toBe(
      "not_syndicated",
    );
  });

  it("refuses an article a person typed in, which nothing can verify", () => {
    const typed = mention({
      captureMethod: "manual_entry",
      capturedAt: "2026-08-01T12:00:00.000Z",
      capturedByUserId: "55555555-5555-4555-8555-555555555555",
    });
    expect(firstFailedPressRule(typed, ALL_PRESS)).toBe("provider_returned");
  });
});

describe("selection", () => {
  function article(id: string, publishedAt: string, overrides: Partial<Mention> = {}) {
    return mention({ id, publishedAt, ...overrides });
  }

  it("returns the newest first", () => {
    const stories = selectPressStories(
      [
        article("11111111-1111-4111-8111-111111111101", "2026-07-01T00:00:00.000Z"),
        article("11111111-1111-4111-8111-111111111102", "2026-08-01T00:00:00.000Z"),
        article("11111111-1111-4111-8111-111111111103", "2026-06-01T00:00:00.000Z"),
      ],
      { ...ALL_PRESS, itemLimit: 3 },
    );
    expect(stories.map((story) => story.id)).toEqual([
      "11111111-1111-4111-8111-111111111102",
      "11111111-1111-4111-8111-111111111101",
      "11111111-1111-4111-8111-111111111103",
    ]);
  });

  it("breaks a tie on id, descending, so the order is stable across renders", () => {
    // Matches `press_widget_render`'s `order by published_at desc, id desc`.
    // A widget that reshuffled two same-minute stories on every page load
    // looks broken, and a *different* tiebreaker on either side is the least
    // visible way for the two implementations to drift.
    const same = "2026-08-01T00:00:00.000Z";
    const stories = selectPressStories(
      [
        article("11111111-1111-4111-8111-11111111110a", same),
        article("11111111-1111-4111-8111-11111111110c", same),
        article("11111111-1111-4111-8111-11111111110b", same),
      ],
      { ...ALL_PRESS, itemLimit: 3 },
    );
    expect(stories.map((story) => story.id)).toEqual([
      "11111111-1111-4111-8111-11111111110c",
      "11111111-1111-4111-8111-11111111110b",
      "11111111-1111-4111-8111-11111111110a",
    ]);
  });

  it.each([1, 2, 3])("honours an item limit of %i", (itemLimit) => {
    const stories = selectPressStories(
      [
        article("11111111-1111-4111-8111-111111111101", "2026-08-03T00:00:00.000Z"),
        article("11111111-1111-4111-8111-111111111102", "2026-08-02T00:00:00.000Z"),
        article("11111111-1111-4111-8111-111111111103", "2026-08-01T00:00:00.000Z"),
      ],
      { ...ALL_PRESS, itemLimit },
    );
    expect(stories).toHaveLength(itemLimit);
  });

  it("drops ineligible articles rather than counting them against the limit", () => {
    const stories = selectPressStories(
      [
        article("11111111-1111-4111-8111-111111111101", "2026-08-05T00:00:00.000Z", {
          status: "dismissed",
        }),
        article("11111111-1111-4111-8111-111111111102", "2026-08-04T00:00:00.000Z", {
          isSyndicated: true,
        }),
        article("11111111-1111-4111-8111-111111111103", "2026-08-03T00:00:00.000Z"),
      ],
      { ...ALL_PRESS, itemLimit: 3 },
    );
    expect(stories.map((story) => story.id)).toEqual([
      "11111111-1111-4111-8111-111111111103",
    ]);
  });

  it("returns nothing rather than throwing when nothing qualifies", () => {
    expect(selectPressStories([], { ...ALL_PRESS, itemLimit: 3 })).toEqual([]);
  });
});

describe("the SQL mirror", () => {
  const migration = readFileSync(
    join(
      resolve(process.cwd()),
      "supabase",
      "migrations",
      "20260821000100_press_widget.sql",
    ),
    "utf8",
  );

  it("names every eligibility rule in press_widget_render", () => {
    // The function's `where` clauses carry the rule identifier as a trailing
    // comment on each line. A rule added here and not there means the customer
    // reads one list inside Lia and their website serves another.
    for (const rule of PRESS_WIDGET_ELIGIBILITY_RULES) {
      expect(
        migration.includes(`-- ${rule}`),
        `press_widget_render does not name the "${rule}" rule. Add the clause and its trailing comment, or remove the rule from PRESS_WIDGET_ELIGIBILITY_RULES.`,
      ).toBe(true);
    }
  });

  it("orders by published_at desc with the same id tiebreaker", () => {
    expect(migration).toContain("order by m.published_at desc, m.id desc");
  });

  it("applies the widget's own item limit rather than a constant", () => {
    expect(migration).toContain("limit (select w.item_limit from widget w)");
  });

  it("keeps the rule list free of duplicates", () => {
    expect(new Set(PRESS_WIDGET_ELIGIBILITY_RULES).size).toBe(
      PRESS_WIDGET_ELIGIBILITY_RULES.length,
    );
  });

  it("does not treat an internal workflow status as evidence of removal", () => {
    // The rules this migration must NOT contain. `responded` and
    // `no_action_recommended` are queue states; publishing decisions made from
    // them would hide coverage that is plainly still online.
    for (const forbidden of ["'responded'", "'no_action_recommended'", "'monitoring'"]) {
      expect(migration.includes(forbidden), forbidden).toBe(false);
    }
  });
});
