import { describe, expect, it } from "vitest";
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
    expect(text).toContain("10");
  });

  it("reports nothing as enabled when the monitor is unconfigured", () => {
    expect(newsCapabilities(false).every((c) => c.state !== "enabled")).toBe(true);
  });
});
