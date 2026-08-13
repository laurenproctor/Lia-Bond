import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Step 4's autosave wiring.
 *
 * Source assertions, for the reason given at the top of
 * `onboarding-accessibility.test.ts`: the suite runs in a Node environment with
 * no DOM, so a client component's behaviour cannot be exercised here. What can
 * be proved is the wiring, and the wiring is where the two regressions that
 * matter would show up — autosave pointed at the action that *advances the
 * wizard*, or a phrase edit that never reaches the server because nobody
 * committed it.
 */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

/** The file with its comments removed, so prose cannot satisfy an assertion. */
function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const form = code("src/components/onboarding/brand-voice-step-form.tsx");

describe("the onboarding brand-voice form", () => {
  it("autosaves through the shared primitive rather than its own timer", () => {
    expect(form).toContain('from "@/components/autosave/use-autosave"');
    expect(form).toContain("useAutosave<UpdateBrandVoiceInput, BrandVoiceProfile>");
    // A local debounce would mean a second serialisation rule to keep honest,
    // and `useAutosave` is the one that guarantees a single request in flight.
    expect(form).not.toContain("setTimeout");
  });

  it("autosaves the voice only — never the step", () => {
    // The distinction the whole design rests on. `updateBrandVoiceAction` writes
    // the profile; `completeOnboardingBrandVoiceAction` also settles step 4 and
    // sends the person to step 5, which touching a slider must never do.
    expect(form).toMatch(/save:\s*updateBrandVoiceAction/);
    expect(form).not.toMatch(/save:\s*completeOnboardingBrandVoiceAction/);
  });

  it("still writes both on submit, so the step can be completed", () => {
    expect(form).toContain("await completeOnboardingBrandVoiceAction(value)");
  });

  it("settles anything outstanding before submitting", () => {
    // Both writes go through `saveBrandVoice`, which reads the current version
    // and writes the next one. Two of them overlapping is a lost edit.
    expect(form).toContain("await flush()");
  });

  it("commits a slider on release, not on every frame of the drag", () => {
    expect(form).toContain("onPointerUp={commit}");
    expect(form).toContain("onKeyUp={commit}");
    expect(form).toContain("onBlur={commit}");
    // The change handler moves the value and the preview; it must not save.
    expect(form).not.toMatch(/onChange=\{\(event\) => \{[^}]*commit\(\)/);
  });

  it("commits both phrase lists, so a chip is not left unsaved", () => {
    expect(form).toMatch(/edit\(\(current\) => \(\{ \.\.\.current, approvedPhrases: next \}\)\)/);
    expect(form).toMatch(/edit\(\(current\) => \(\{ \.\.\.current, prohibitedPhrases: next \}\)\)/);
    expect(form).toContain("setValue(update);\n    commit();");
  });

  it("reports whether the current state is on the server", () => {
    expect(form).toContain("<SaveStatus status={status}");
  });

  it("keeps the edits on screen when a save fails", () => {
    // Losing somebody's tuning to a failed request is not acceptable on a
    // screen whose purpose is accumulating small adjustments.
    expect(form).toContain("Your changes are still here.");
    expect(form).not.toContain("setValue(initial)");
  });
});
