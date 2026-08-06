import { describe, expect, it } from "vitest";
import { can } from "@/lib/auth/permissions";

describe("monitoring permissions", () => {
  it("lets owner, admin, and communications lead manage queries", () => {
    expect(can("owner", "monitoring.manage_queries")).toBe(true);
    expect(can("admin", "monitoring.manage_queries")).toBe(true);
    expect(can("communications_lead", "monitoring.manage_queries")).toBe(true);
  });

  it("refuses everyone else", () => {
    expect(can("location_manager", "monitoring.manage_queries")).toBe(false);
    expect(can("approver", "monitoring.manage_queries")).toBe(false);
    expect(can("analyst", "monitoring.manage_queries")).toBe(false);
  });

  it("grants poll_now to exactly three roles", () => {
    expect(can("owner", "monitoring.poll_now")).toBe(true);
    expect(can("admin", "monitoring.poll_now")).toBe(true);
    expect(can("communications_lead", "monitoring.poll_now")).toBe(true);
    expect(can("location_manager", "monitoring.poll_now")).toBe(false);
    expect(can("approver", "monitoring.poll_now")).toBe(false);
    expect(can("analyst", "monitoring.poll_now")).toBe(false);
  });

  // Asserted separately from the explicit list above, and deliberately not
  // instead of it: this pins the *intent* (poll_now tracks sync_reviews) while
  // the list pins the actual roles. On its own it would pass if both matrices
  // were wrong in the same direction.
  it("keeps poll_now aligned with integration.sync_reviews", () => {
    for (const role of [
      "owner",
      "admin",
      "communications_lead",
      "location_manager",
      "approver",
      "analyst",
    ] as const) {
      expect(can(role, "monitoring.poll_now")).toBe(
        can(role, "integration.sync_reviews"),
      );
    }
  });
});
