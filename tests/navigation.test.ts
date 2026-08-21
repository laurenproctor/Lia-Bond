import { describe, expect, it } from "vitest";
import { isNavItemActive, NAV_SECTIONS, type NavItem } from "@/lib/navigation";
import { isProductPath } from "@/proxy";

/**
 * The sidebar's active state.
 *
 * Worth its own suite from the moment the nav gained a *nested* entry.
 * "Website widgets" lives beneath "Integrations", and the plain prefix test
 * the module used before that lit up both — which is not a cosmetic problem.
 * The sidebar is the only thing telling somebody which part of the product
 * they are in, and two highlighted items is it saying two contradictory
 * things.
 *
 * Since the press widget it also claims two routes that are *siblings* of its
 * own — the two configurators — through `alsoMatches`. That is a second way
 * for the "exactly one item" invariant to break, so it gets its own cases
 * below.
 *
 * `isNavItemActive` is pure, so unlike most sidebar behaviour this is genuinely
 * testable rather than something only a browser could catch.
 */

const ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

function activeLabels(pathname: string): string[] {
  return ITEMS.filter((item) => isNavItemActive(item, pathname)).map(
    (item) => item.label,
  );
}

describe("the nav table", () => {
  it("lists the website widgets screen", () => {
    const item = ITEMS.find((entry) => entry.label === "Website widgets");
    expect(item?.href).toBe("/integrations/website-widgets");
  });

  it("claims both configurators without owning their URLs", () => {
    // `/integrations/review-widget` predates the landing route and is in
    // customers' browser history. It stays where it is; the nav item reaches
    // it with `alsoMatches` rather than by moving it beneath itself.
    const item = ITEMS.find((entry) => entry.label === "Website widgets");
    expect(item?.alsoMatches).toEqual([
      "/integrations/review-widget",
      "/integrations/press-widget",
    ]);
  });

  it("has no duplicate hrefs", () => {
    const hrefs = ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("keeps every destination behind the authentication gate", () => {
    // A sidebar entry the proxy does not treat as a product path would be a
    // signed-in-only screen reachable without a session. `/embed/*` is public
    // on purpose and is deliberately not in the sidebar.
    for (const item of ITEMS) {
      expect(isProductPath(item.href), item.href).toBe(true);
    }
  });
});

describe("exactly one item is ever active", () => {
  it.each(ITEMS.map((item) => [item.label, item.href] as const))(
    "%s lights up on its own route",
    (label, href) => {
      expect(activeLabels(href)).toEqual([label]);
    },
  );

  it.each([
    ["/reviews/google/abc123", "Reviews"],
    ["/reddit/xyz", "Reddit"],
    ["/media/story-1", "News and media"],
    ["/rules/new", "Rules and automation"],
    // A child of /integrations that is *not* its own nav entry still lights
    // the parent — the nesting fix must not have broken that.
    ["/integrations/yelp", "Integrations"],
    ["/integrations/google-business-profile/setup", "Integrations"],
  ])("%s lights up %s alone", (pathname, expected) => {
    expect(activeLabels(pathname)).toEqual([expected]);
  });
});

describe("the nested entry", () => {
  it("wins over its parent on its own route", () => {
    // The regression this suite exists for.
    expect(activeLabels("/integrations/website-widgets")).toEqual(["Website widgets"]);
  });

  it.each([
    "/integrations/review-widget",
    "/integrations/press-widget",
  ])("wins on %s, which it claims without owning", (pathname) => {
    expect(activeLabels(pathname)).toEqual(["Website widgets"]);
  });

  it("keeps winning on a route beneath a claimed sibling", () => {
    // The review screen selects a location with a search param today, which
    // `usePathname()` strips before this ever sees it — so the case that
    // matters is a future child segment, which must stay with the widget
    // rather than reverting to the parent.
    expect(activeLabels("/integrations/review-widget/anything")).toEqual([
      "Website widgets",
    ]);
  });

  it("does not steal the parent's own route", () => {
    expect(activeLabels("/integrations")).toEqual(["Integrations"]);
  });
});

describe("matching is by segment, not by string prefix", () => {
  it.each([
    "/reviewsomething",
    "/overview-of-pricing",
    "/settings-export",
    "/integrations-guide",
  ])("%s lights up nothing", (pathname) => {
    // The same rule `src/proxy.ts` applies to the auth gate, for the same
    // reason: a marketing page sharing a prefix with a product route is not
    // that route.
    expect(activeLabels(pathname)).toEqual([]);
  });

  it("lights up nothing on a path no item claims", () => {
    expect(activeLabels("/")).toEqual([]);
    expect(activeLabels("/sign-in")).toEqual([]);
  });
});
