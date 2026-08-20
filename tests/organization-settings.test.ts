import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg, ORG_HARBOR, ORG_USHG } from "./helpers/scope";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource } from "@/lib/data/types";
import { organizationDetailsSchema } from "@/lib/organization/details";

/**
 * Editing the organization's own details, slug included.
 *
 * Against the demo adapter. Under Supabase the slug's global uniqueness is a
 * database constraint; the demo adapter restates it with a linear scan so both
 * adapters refuse the same collision with the same field error.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

const DETAILS = {
  name: "Union Square Hospitality Group",
  websiteUrl: "https://www.ushg.com",
  industry: "Hospitality",
  defaultTimezone: "America/New_York",
  defaultLanguage: "en-US",
};

describe("organizations.update with a slug", () => {
  it("renames the slug", async () => {
    const updated = await data.organizations.update(ushg.owner(), {
      ...DETAILS,
      slug: "ushg-hq",
    });
    expect(updated.slug).toBe("ushg-hq");
  });

  it("leaves the slug alone when omitted", async () => {
    const before = await data.organizations.getById(
      ORG_USHG,
      ushg.owner().userId,
    );
    const updated = await data.organizations.update(ushg.owner(), DETAILS);
    expect(updated.slug).toBe(before?.organization.slug);
  });

  it("keeps the caller's own slug idempotent", async () => {
    // Saving the form without touching the slug must not read as a collision
    // with yourself.
    const before = await data.organizations.getById(
      ORG_USHG,
      ushg.owner().userId,
    );
    const updated = await data.organizations.update(ushg.owner(), {
      ...DETAILS,
      slug: before!.organization.slug,
    });
    expect(updated.slug).toBe(before!.organization.slug);
  });

  it("refuses another tenant's slug with a field error", async () => {
    const other = await data.organizations.getById(
      ORG_HARBOR,
      harbor.owner().userId,
    );

    const attempt = data.organizations.update(ushg.owner(), {
      ...DETAILS,
      slug: other!.organization.slug,
    });

    await expect(attempt).rejects.toMatchObject({
      code: "conflict",
      fieldErrors: { slug: "That slug is already taken." },
    });
    await expect(attempt).rejects.toBeInstanceOf(DataError);
  });
});

describe("organizationDetailsSchema", () => {
  const valid = {
    name: "Union Square Hospitality Group",
    slug: "ushg",
    industry: "Hospitality",
    websiteUrl: "https://www.ushg.com",
    defaultTimezone: "America/New_York",
    defaultLanguage: "en-US",
  };

  it("accepts a complete form", () => {
    expect(organizationDetailsSchema.safeParse(valid).success).toBe(true);
  });

  it("turns an empty website into null", () => {
    const parsed = organizationDetailsSchema.parse({ ...valid, websiteUrl: "" });
    expect(parsed.websiteUrl).toBeNull();
  });

  it("refuses a slug with the wrong shape", () => {
    for (const slug of ["Has Spaces", "UPPER", "trailing-", "-leading", "a"]) {
      expect(
        organizationDetailsSchema.safeParse({ ...valid, slug }).success,
      ).toBe(false);
    }
  });

  it("refuses a blank name and a bad URL", () => {
    expect(
      organizationDetailsSchema.safeParse({ ...valid, name: "  " }).success,
    ).toBe(false);
    expect(
      organizationDetailsSchema.safeParse({ ...valid, websiteUrl: "not a url" })
        .success,
    ).toBe(false);
  });
});
