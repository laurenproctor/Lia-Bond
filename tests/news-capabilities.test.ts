import { describe, expect, it } from "vitest";
import { MAX_ARTICLES_PER_POLL } from "@/domain";
import { newsCapabilities } from "@/lib/monitoring/capabilities";

describe("newsCapabilities", () => {
  it("never claims Lia can publish to a publication", () => {
    for (const available of [true, false]) {
      const publishing = newsCapabilities(available).find(
        (c) => c.id === "media_publishing",
      );
      expect(publishing?.state).toBe("unavailable");
    }
  });

  it("states the delay, the missing body text, and the result cap", () => {
    const text = newsCapabilities(true)
      .map((c) => `${c.label} ${c.detail}`)
      .join(" ")
      .toLowerCase();
    expect(text).toContain("12 hours");
    expect(text).toContain("headline");
    // Against the real constant, not a bare "10" substring — the previous
    // assertion passed against a hardcoded, wrong "100 articles" in the
    // detail text because "10" is itself a substring of "100". Asserting
    // the actual cap word ("10 articles") pins the copy to
    // MAX_ARTICLES_PER_POLL rather than to any string that happens to
    // contain the digits.
    expect(text).toContain(`${MAX_ARTICLES_PER_POLL} articles`);
  });

  it("reports nothing as enabled when the monitor is unconfigured", () => {
    expect(newsCapabilities(false).every((c) => c.state !== "enabled")).toBe(true);
  });
});
