import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Accessibility invariants for the onboarding UI.
 *
 * Source assertions, because the suite runs in a Node environment with no DOM —
 * `vitest.config.mts` sets `environment: "node"` on purpose, since every other
 * suite exercises schemas, repositories, or connectors. Adding jsdom for this
 * one file would mean a second rendering model to keep honest.
 *
 * What these can prove is exactly the class of regression that matters here:
 * somebody removes an `aria-current`, swaps a `<label>` for a placeholder,
 * turns a decorative bubble into something announced, or replaces a real range
 * input with a div. Each of those is a visible, greppable change.
 */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

/**
 * The file with its comments removed.
 *
 * Needed for the assertions about what a component does *not* render: the
 * comments in this codebase explain the very rules being checked ("a disabled
 * button implies a capability that…"), so matching raw text would fail on the
 * explanation rather than on a regression.
 */
function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the progress strip", () => {
  const progress = source("src/components/onboarding/onboarding-progress.tsx");

  it("marks the active step with aria-current", () => {
    expect(progress).toContain('aria-current={status === "current" ? "step" : undefined}');
  });

  it("names itself, so it is reachable as a landmark", () => {
    expect(progress).toContain('aria-label="Setup progress"');
  });

  it("uses an ordered list, because the order is the meaning", () => {
    expect(progress).toContain("<ol");
  });

  it("never communicates state by colour alone", () => {
    // Every step carries a word for assistive technology, and a completed step
    // carries a tick rather than only a blue fill.
    expect(progress).toContain("STATE_LABELS");
    expect(progress).toContain('done: "Completed"');
    expect(progress).toContain('skipped: "Skipped"');
    expect(progress).toContain("<Check");
  });

  it("makes settled steps real links and future steps not links at all", () => {
    // A disabled anchor is still focusable in most browsers, and tabbing to
    // something that does nothing is worse than it not being there.
    expect(progress).toContain('const linkable = status === "done" || status === "skipped"');
    expect(progress).not.toContain("aria-disabled");
  });

  it("keeps the step number and title visible on a narrow screen", () => {
    // Only the description is hidden below `sm`.
    expect(progress).toMatch(/hidden[^"]*sm:block/);
  });
});

describe("decorative graphics", () => {
  const doodle = source("src/components/onboarding/onboarding-doodle.tsx");

  it("hides every speech bubble from assistive technology", () => {
    const hiddenCount = (doodle.match(/aria-hidden="true"/g) ?? []).length;
    const svgCount = (doodle.match(/<svg/g) ?? []).length;
    expect(hiddenCount).toBe(svgCount);
  });

  it("marks them presentational and unfocusable as well", () => {
    expect(doodle).toContain('focusable="false"');
    expect(doodle).toContain('role="presentation"');
  });

  it("carries no text, so nothing required can live in one", () => {
    expect(doodle).not.toContain("<text");
    expect(doodle).not.toContain("<title");
  });

  it("cannot be clicked", () => {
    expect(doodle).toContain("pointer-events-none");
  });

  it("stops animating under reduced motion", () => {
    // The drift utilities are `site-float-a` / `site-float-b`, which
    // globals.css disables outright rather than shortening.
    const css = source("src/app/globals.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/\.site-float-a,\s*\n?\s*\.site-float-b\s*\{\s*\n?\s*animation: none;/);
  });

  it("is used at most twice per screen", () => {
    for (const path of [
      "src/app/onboarding/organization/page.tsx",
      "src/app/onboarding/connect-sources/page.tsx",
      "src/app/onboarding/locations/page.tsx",
      "src/app/onboarding/brand-voice/page.tsx",
      "src/app/onboarding/team/page.tsx",
      "src/app/onboarding/ready/page.tsx",
    ]) {
      const text = source(path);
      const explicit = (text.match(/<OnboardingDoodle/g) ?? []).length;
      // Steps 1-5 get one from `OnboardingAside`; the ready screen renders its
      // own. Neither route adds a second.
      expect(explicit, path).toBeLessThanOrEqual(1);
    }
  });
});

describe("form fields", () => {
  const field = source("src/components/onboarding/onboarding-field.tsx");

  it("gives every control a real label", () => {
    expect(field).toContain("<label htmlFor={id}");
    // A placeholder is not a label: it disappears the moment somebody types.
    expect(field).not.toMatch(/placeholder=\{label\}/);
  });

  it("associates the error with the field it belongs to", () => {
    expect(field).toContain("aria-describedby={describedBy(id, hint, error)}");
    expect(field).toContain("aria-invalid={error ? true : undefined}");
    expect(field).toContain("id={`${id}-error`}");
  });

  it("marks required fields with more than a red asterisk", () => {
    expect(field).toContain('<span className="sr-only"> (required)</span>');
  });

  it("uses the accessible field border, not the ornamental one", () => {
    // `site-border` measures 1.21:1 against white and fails WCAG 1.4.11 for a
    // control boundary; `site-field` is the darkened value.
    expect(field).toContain("border-site-field");
    expect(field).not.toContain("border-site-border");
  });

  it("meets the 44px touch target on every control", () => {
    expect(field).toContain("min-h-[46px]");
  });
});

describe("error handling", () => {
  it("announces failures", () => {
    const actions = source("src/components/onboarding/onboarding-actions.tsx");
    expect(actions).toContain('role="alert"');
  });

  it("offers an error summary that links to each field", () => {
    const actions = source("src/components/onboarding/onboarding-actions.tsx");
    expect(actions).toContain("OnboardingErrorSummary");
    expect(actions).toContain("href={`#${field}`}");
    // Focusable, so a submit handler can move focus to it.
    expect(actions).toContain("tabIndex={-1}");
  });

  it("moves focus to the summary after a validation failure", () => {
    for (const path of [
      "src/components/onboarding/organization-step-form.tsx",
      "src/components/onboarding/manual-location-step.tsx",
    ]) {
      const form = source(path);
      expect(form, path).toContain("summaryRef.current?.focus()");
    }
  });
});

describe("buttons", () => {
  const actions = source("src/components/onboarding/onboarding-actions.tsx");

  it("meets the 44px minimum on every action", () => {
    const buttons = actions.match(/inline-flex[^`"]*/g) ?? [];
    const interactive = buttons.filter((cls) => cls.includes("rounded-xl"));
    expect(interactive.length).toBeGreaterThan(0);
    for (const cls of interactive) {
      expect(cls, cls).toContain("min-h-[44px]");
    }
  });

  it("keeps a pending button focusable", () => {
    // A `disabled` button loses focus mid-submit, dropping a keyboard user to
    // the top of the document.
    expect(actions).toContain("aria-disabled={pending || props.disabled ? true : undefined}");
  });
});

describe("the brand-voice sliders", () => {
  const form = source("src/components/onboarding/brand-voice-step-form.tsx");

  it("uses real range inputs, so keyboard support comes from the platform", () => {
    expect(form).toContain('type="range"');
    expect(form).toContain("min={0}");
    expect(form).toContain("max={100}");
    expect(form).toContain("step={1}");
  });

  it("exposes the current value in words rather than as a bare number", () => {
    expect(form).toContain("aria-valuetext=");
    expect(form).toContain("of 100,");
  });

  it("names each axis by both its poles", () => {
    expect(form).toContain("aria-label={`${axis.leftLabel} to ${axis.rightLabel}`}");
  });

  it("names each phrase's remove button after the phrase", () => {
    expect(form).toContain("aria-label={`Remove ${phrase}`}");
  });

  it("reads the axes from the domain rather than restating them", () => {
    expect(form).toContain("BRAND_VOICE_AXES");
  });
});

describe("unavailable integrations", () => {
  it("announces the status as text, in reading order", () => {
    // The vocabulary lives in one closed map, so a card cannot invent a state
    // ("Active", "Live") the system behind it cannot prove.
    const badge = source("src/components/onboarding/source-status-badge.tsx");
    expect(badge).toContain('unavailable: "Available after setup"');
  });

  it("explains the disabled Reddit control to assistive technology", () => {
    // The Reddit card's button is genuinely disabled — the capability is on
    // the roadmap, not behind the button — and the reason travels with the
    // control rather than sitting loose beside it.
    const card = source("src/components/onboarding/reddit-source-card.tsx");
    expect(card).toContain("disabled");
    expect(card).toContain("aria-describedby={explanationId}");
    expect(card).toContain(
      "does not have an operational Reddit connection",
    );
  });

  it("claims no activity Reddit does not have", () => {
    const card = code("src/components/onboarding/reddit-source-card.tsx");
    expect(card).not.toMatch(/Active|Connected|Last checked|Threads/);
    // No counts: every number on step 2 must come from a persisted
    // operational record, and Reddit has none.
    expect(card).not.toMatch(/\d+ (terms|communities)/);
  });
});

describe("the news configurator", () => {
  const step = source("src/components/onboarding/connect-sources-step.tsx");
  const card = source("src/components/onboarding/news-source-card.tsx");
  const configurator = source(
    "src/components/onboarding/news-monitoring-configurator.tsx",
  );

  it("announces the expanded state on its trigger", () => {
    expect(card).toContain("aria-expanded={expanded}");
    expect(card).toContain('aria-controls="news-monitoring-configurator"');
    expect(configurator).toContain('id="news-monitoring-configurator"');
  });

  it("moves focus to the heading when it opens", () => {
    expect(configurator).toContain("headingRef.current?.focus()");
    expect(configurator).toContain("tabIndex={-1}");
  });

  it("returns focus to the trigger when it closes", () => {
    expect(step).toContain("newsButtonRef.current?.focus()");
  });

  it("announces validation failures and saves", () => {
    // Failures use the shared alert treatment; the save confirmation is a
    // status, so it is announced without stealing focus.
    expect(configurator).toContain("OnboardingError");
    expect(configurator).toContain('role="status"');
  });

  it("names every chip's remove button after its term", () => {
    expect(configurator).toContain("Remove {term}");
  });

  it("labels every field", () => {
    expect(configurator).toContain("<label htmlFor={id}");
    expect(configurator).not.toMatch(/placeholder=\{label\}/);
  });
});

describe("headings", () => {
  it("puts exactly one h1 on each screen, in the contextual panel", () => {
    const aside = source("src/components/onboarding/onboarding-aside.tsx");
    expect((aside.match(/<h1/g) ?? []).length).toBe(1);

    // The card's title is an h2 beneath it.
    const card = source("src/components/onboarding/onboarding-card.tsx");
    expect(card).toContain("<h2");
    expect(card).not.toContain("<h1");
  });

  it("gives the ready screen its own single h1", () => {
    const ready = source("src/app/onboarding/ready/page.tsx");
    expect((ready.match(/<h1/g) ?? []).length).toBe(1);

    const screen = source("src/components/onboarding/ready-screen.tsx");
    expect(screen).not.toContain("<h1");
    expect(screen).toContain("<h2");
  });
});

describe("the owner row on the team step", () => {
  const form = source("src/components/onboarding/team-step-form.tsx");

  it("is locked, with no remove control", () => {
    expect(form).toContain("<Lock");
    expect(form).toContain("Your own membership. It cannot be changed here.");
  });

  it("explains the lock in words, not only with an icon", () => {
    expect(form).toContain('<span className="sr-only">');
  });

  it("announces a copied link rather than relying on the icon swapping", () => {
    expect(form).toContain('aria-live="polite"');
  });
});

describe("the app shell is absent", () => {
  it("renders no sidebar anywhere in onboarding", () => {
    for (const path of [
      "src/app/onboarding/layout.tsx",
      "src/components/onboarding/onboarding-shell.tsx",
    ]) {
      const text = source(path);
      expect(text, path).not.toContain("AppShell");
      expect(text, path).not.toContain("Sidebar");
      expect(text, path).not.toContain("OrgSwitcher");
    }
  });

  it("uses the marketing tokens rather than the product's purple", () => {
    for (const path of [
      "src/components/onboarding/onboarding-shell.tsx",
      "src/components/onboarding/onboarding-card.tsx",
      "src/components/onboarding/onboarding-actions.tsx",
      "src/components/onboarding/onboarding-progress.tsx",
      "src/components/onboarding/onboarding-field.tsx",
    ]) {
      const text = source(path);
      expect(text, path).not.toMatch(/purple-\d/);
      expect(text, path).not.toMatch(/navy-\d/);
      expect(text, path).not.toMatch(/teal/);
    }
  });

  it("scopes the marketing focus ring", () => {
    const shell = source("src/components/onboarding/onboarding-shell.tsx");
    expect(shell).toContain('data-surface="site"');
    expect(shell).toContain("font-site");
  });
});
