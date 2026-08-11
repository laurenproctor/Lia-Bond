import { describe, expect, it } from "vitest";
import { parseRuleStatusParam } from "@/lib/rules/search-params";

describe("parseRuleStatusParam", () => {
  it("accepts each real automation rule status", () => {
    expect(parseRuleStatusParam("active")).toBe("active");
    expect(parseRuleStatusParam("inactive")).toBe("inactive");
    expect(parseRuleStatusParam("draft")).toBe("draft");
  });

  it("falls back to all for anything that isn't an exact match", () => {
    expect(parseRuleStatusParam("ACTIVE")).toBe("all");
    expect(parseRuleStatusParam("archived")).toBe("all");
    expect(parseRuleStatusParam(undefined)).toBe("all");
    expect(parseRuleStatusParam("")).toBe("all");
  });
});
