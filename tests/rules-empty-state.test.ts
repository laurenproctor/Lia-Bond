import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULE_TEMPLATES } from "@/lib/rules/templates";

/**
 * The rules screen when there is nothing on it.
 *
 * Two different emptinesses share one route, and the whole point of this
 * change is that they stopped sharing one branch:
 *
 * - **No rules at all** — a workspace nobody has configured. Gets the templates
 *   beside it, because "what would I even automate?" is the real question.
 * - **No rules on this tab** — a filter that matched nothing. Those rules
 *   exist, one tab away. Offering to create more answers a question nobody
 *   asked, and calling it "No rules yet" is simply false.
 *
 * Read from the page source. A page component here is an async server
 * component that reaches for `getOrganizationContext` and the data source, and
 * the repo has no testing-library dependency to render one with (see D74) — so
 * what is checkable is the branch's existence and the copy it carries, which is
 * exactly what regressed.
 */

const PAGE = readFileSync("src/app/(app)/rules/page.tsx", "utf8");
const PANEL = readFileSync("src/components/rules/rule-templates-panel.tsx", "utf8");

describe("the empty rules screen", () => {
  it("branches on having no rules at all, not on the filtered view being empty", () => {
    // `visibleRules` is the filtered list; `rules` is everything. The empty
    // branch must key off the latter.
    expect(PAGE).toContain("const neverHadRules = rules.length === 0");
  });

  it("shows the templates panel beside it", () => {
    expect(PAGE).toContain("RuleTemplatesPanel");
    expect(PAGE).toContain('import { RuleTemplatesPanel }');
  });

  it("passes the viewer's permission down to the panel", () => {
    // Otherwise a reader gets five buttons into a page that tells them they
    // cannot create rules.
    expect(PAGE).toContain("<RuleTemplatesPanel canManage={canManage} />");
  });

  it("uses the same 7/5 split the builder pairs templates with", () => {
    expect(PAGE).toContain("xl:grid-cols-12");
    expect(PAGE).toContain("xl:col-span-7");
    expect(PAGE).toContain("xl:col-span-5");
  });

  it("never tells somebody with rules that they have none", () => {
    // The old copy was a bare string on the DataTable, rendered for both
    // emptinesses. If it comes back as an unconditional prop, this fails.
    expect(PAGE).not.toContain('emptyTitle="No rules yet"');
  });

  it("names the status when a filter is what came up empty", () => {
    expect(PAGE).toContain("AUTOMATION_RULE_STATUS_LABELS[status]");
    expect(PAGE).toContain("under other statuses");
  });

  it("hides the status tabs when every count would read zero", () => {
    expect(PAGE).toContain("{neverHadRules ? null : (");
  });

  it("avoids positional copy that breaks when the columns stack", () => {
    // The grid collapses to one column below `xl`, so "on the right" would be
    // wrong on a tablet.
    expect(PAGE).not.toMatch(/templates on the right/i);
    expect(PAGE).toContain("Start from one of the templates");
  });
});

describe("the templates panel", () => {
  it("still defaults to permitting use, so the builder is unaffected", () => {
    // The builder renders this panel only after its own permission check, so
    // it must not have to pass the flag.
    expect(PANEL).toContain("canManage = true");
  });

  it("renders no action at all for a viewer who cannot create rules", () => {
    // Not a disabled button in an empty container — no container.
    expect(PANEL).toContain("{applied || !canManage ? null : (");
  });

  it("has templates to show in the first place", () => {
    // The sidebar is worth building only because this is non-empty; a future
    // change that empties it should fail here rather than ship a blank column.
    expect(RULE_TEMPLATES.length).toBeGreaterThan(0);
  });
});
