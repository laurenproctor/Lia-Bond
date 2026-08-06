import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_REDIRECT_PATHS,
  AUDIT_EVENT_TYPES,
  INVITABLE_ROLES,
  isAllowedRedirectPath,
  MEMBERSHIP_ROLES,
  ONBOARDING_STEP_DEFINITIONS,
  ONBOARDING_READY_PATH,
} from "@/domain";
import { can, permissionsFor } from "@/lib/auth/permissions";
import { AUDIT_EVENT_LABELS } from "@/lib/labels";
import { isProductPath, PRODUCT_PATHS } from "@/middleware";

/**
 * Authorization and security invariants for onboarding.
 *
 * Several of these are file-content assertions rather than behavioural ones.
 * That is deliberate: the properties they hold are absences — no token in an
 * audit event, no service-role client in a client component — and an absence
 * cannot be observed by calling something. Reading the source is the only way
 * to prove it, and it fails the moment somebody adds the thing.
 */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

/**
 * The file with its comments removed.
 *
 * The absence assertions below are about what the code *does*, and this
 * codebase's comments discuss tokens at length precisely because keeping them
 * out of the audit trail is the rule being explained. Matching on the raw text
 * would fail on the very comment that documents the guarantee.
 */
function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the onboarding permission", () => {
  it("belongs to owners and admins only", () => {
    expect(can("owner", "onboarding.manage")).toBe(true);
    expect(can("admin", "onboarding.manage")).toBe(true);

    for (const role of MEMBERSHIP_ROLES) {
      if (role === "owner" || role === "admin") continue;
      expect(can(role, "onboarding.manage"), `${role} must not manage onboarding`).toBe(
        false,
      );
    }
  });

  it("is narrower than the general write gate", () => {
    // A communications lead writes plenty across the product but must not be
    // able to mark setup complete for the whole organization.
    expect(can("communications_lead", "brand_voice.update")).toBe(true);
    expect(can("communications_lead", "onboarding.manage")).toBe(false);
  });

  it("does not appear for read-only roles", () => {
    expect(permissionsFor("analyst")).not.toContain("onboarding.manage");
    expect(permissionsFor("viewer")).not.toContain("onboarding.manage");
  });

  it("is mirrored by the row-level security policy", () => {
    const rls = source(
      "supabase/migrations/20260808000200_organization_onboarding_rls.sql",
    );

    expect(rls).toContain("enable row level security");
    // Reads: any active member, because the guard runs for every role.
    expect(rls).toContain("public.is_organization_member(organization_id)");
    // Writes: owner and admin only, matching `onboarding.manage`.
    expect(rls).toMatch(/array\['owner',\s*'admin'\]::membership_role\[\]/);
    // No delete: the row is history, and its absence reads as "completed".
    expect(rls).toContain("revoke delete on public.organization_onboarding");
    expect(rls).not.toMatch(/for delete/i);
  });
});

describe("invitation roles", () => {
  it("never offers owner", () => {
    expect(INVITABLE_ROLES).not.toContain("owner");
  });

  it("is the only source the team step reads roles from", () => {
    const form = source("src/components/onboarding/team-step-form.tsx");
    expect(form).toContain("INVITABLE_ROLES");
    // No hand-written role list that could drift and reintroduce owner.
    expect(form).not.toMatch(/"owner"/);
  });
});

describe("OAuth return paths", () => {
  it("allows the two onboarding destinations", () => {
    expect(isAllowedRedirectPath("/onboarding/locations")).toBe(true);
    expect(isAllowedRedirectPath("/onboarding/connect-sources")).toBe(true);
  });

  it("still refuses anything not on the list", () => {
    for (const candidate of [
      "/onboarding/ready",
      "/overview",
      "https://evil.example/onboarding/locations",
      "//evil.example",
      "/onboarding/locations?next=/evil",
    ]) {
      expect(isAllowedRedirectPath(candidate), candidate).toBe(false);
    }
  });

  it("keeps every entry an internal path", () => {
    for (const path of ALLOWED_REDIRECT_PATHS) {
      expect(path.startsWith("/")).toBe(true);
      expect(path.startsWith("//")).toBe(false);
      expect(path).not.toContain(":");
    }
  });

  it("sends a successful grant to step 3, not back to step 2", () => {
    const step = source("src/components/onboarding/connect-sources-step.tsx");
    expect(step).toContain('value="/onboarding/locations"');
  });

  it("starts the flow with a POST to the existing connect route", () => {
    const step = source("src/components/onboarding/connect-sources-step.tsx");
    // A GET that mints OAuth state can be fired by an `<img>` on any page.
    expect(step).toContain('method="post"');
    expect(step).toContain("/api/integrations/google-business-profile/connect");
  });
});

describe("the audit vocabulary", () => {
  const onboardingEvents = AUDIT_EVENT_TYPES.filter((event) =>
    event.startsWith("onboarding."),
  );

  it("covers every transition the flow performs", () => {
    for (const event of [
      "onboarding.started",
      "onboarding.organization_completed",
      "onboarding.source_connected",
      "onboarding.source_skipped",
      "onboarding.locations_completed",
      "onboarding.locations_skipped",
      "onboarding.brand_voice_completed",
      "onboarding.team_completed",
      "onboarding.team_skipped",
      "onboarding.completed",
      "onboarding.ready_viewed",
    ]) {
      expect(onboardingEvents).toContain(event);
    }
  });

  it("labels every one of them", () => {
    for (const event of onboardingEvents) {
      expect(AUDIT_EVENT_LABELS[event]).toBeTruthy();
    }
  });

  it("records no credential of any kind", () => {
    // The transition service never sees a token, a code, or a scope: it takes
    // counts and step names and nothing else.
    const service = code("src/lib/onboarding/service.ts");
    expect(service).not.toMatch(/token/i);
    expect(service).not.toMatch(/credential|accessToken|refreshToken/i);

    // The action's audit write carries the address and the role only. The raw
    // token exists in the loop that generates it and in the value returned to
    // the caller, and nowhere else.
    const actions = code("src/app/actions/onboarding.ts");
    const start = actions.indexOf('eventType: "membership.invited"');
    expect(start).toBeGreaterThan(-1);
    // Bounded by the call's own closing brace rather than a character count:
    // the token legitimately appears a few lines later, where the URL returned
    // to the caller is built, and a fixed window would run into it.
    const end = actions.indexOf("});", start);
    expect(end).toBeGreaterThan(start);
    const auditBlock = actions.slice(start, end);

    expect(auditBlock).toContain("email: invitation.email");
    expect(auditBlock).not.toMatch(/\btoken\b/);
  });

  it("hashes the invitation token before it reaches a repository", () => {
    const actions = code("src/app/actions/onboarding.ts");
    // The repository receives `tokenHash`, never `token`.
    expect(actions).toContain("tokenHash: hashInvitationToken(token)");
    expect(actions).not.toMatch(/tokenHash:\s*token\b/);
  });

  it("never logs the raw token", () => {
    const actions = code("src/app/actions/onboarding.ts");
    for (const match of actions.matchAll(/console\.(log|error|warn)\(([^)]*)\)/g)) {
      expect(match[2] ?? "", match[0]).not.toMatch(/token|url/i);
    }
  });
});

describe("route protection", () => {
  it("treats onboarding as a product path", () => {
    expect(PRODUCT_PATHS).toContain("/onboarding");
    expect(isProductPath("/onboarding/organization")).toBe(true);
    expect(isProductPath("/onboarding/ready")).toBe(true);
  });

  it("does not sweep in an unrelated path that shares the prefix", () => {
    // Segment match, not `startsWith`: a hypothetical marketing page at
    // `/onboarding-guide` is not the product route.
    expect(isProductPath("/onboarding-guide")).toBe(false);
  });

  it("routes every declared step at a real path under /onboarding", () => {
    for (const definition of ONBOARDING_STEP_DEFINITIONS) {
      expect(definition.path.startsWith("/onboarding/")).toBe(true);
      expect(isProductPath(definition.path)).toBe(true);
    }
    expect(ONBOARDING_READY_PATH).toBe("/onboarding/ready");
  });
});

describe("no credentials cross to the browser", () => {
  const clientComponents = [
    "src/components/onboarding/connect-sources-step.tsx",
    "src/components/onboarding/google-locations-step.tsx",
    "src/components/onboarding/manual-location-step.tsx",
    "src/components/onboarding/brand-voice-step-form.tsx",
    "src/components/onboarding/team-step-form.tsx",
    "src/components/onboarding/organization-step-form.tsx",
    "src/components/onboarding/ready-screen.tsx",
  ];

  it("imports no service-role client and no credential module", () => {
    for (const path of clientComponents) {
      const text = source(path);
      expect(text, path).not.toContain("createSupabaseServiceClient");
      expect(text, path).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(text, path).not.toContain("@/lib/integrations/credentials");
      expect(text, path).not.toContain("@/lib/crypto/token-vault");
    }
  });

  it("imports no server-only module", () => {
    for (const path of clientComponents) {
      const text = source(path);
      expect(text, path).not.toContain('from "@/lib/onboarding/service"');
      expect(text, path).not.toContain('from "@/lib/data"');
      expect(text, path).not.toContain('from "@/lib/auth/session"');
    }
  });

  it("passes the Google account name but never its id or tokens", () => {
    const page = source("src/app/onboarding/connect-sources/page.tsx");
    expect(page).toContain("externalAccountName");
    expect(page).not.toContain("externalAccountId");
    expect(page).not.toMatch(/accessToken|refreshToken|grantedScopes/);
  });
});

describe("mock mode", () => {
  it("is refused in production by the environment schema", () => {
    const env = source("src/lib/env.ts");
    expect(env).toContain("GOOGLE_INTEGRATION_MODE=mock is refused in production");
  });

  it("is not re-enabled anywhere in the onboarding code", () => {
    for (const path of [
      "src/app/actions/onboarding.ts",
      "src/lib/onboarding/context.ts",
      "src/lib/onboarding/service.ts",
      "src/lib/onboarding/quick-win.ts",
      "src/app/onboarding/connect-sources/page.tsx",
      "src/app/onboarding/locations/page.tsx",
    ]) {
      const text = source(path);
      expect(text, path).not.toContain("GOOGLE_INTEGRATION_MODE");
      expect(text, path).not.toContain("mock-connector");
    }
  });
});
