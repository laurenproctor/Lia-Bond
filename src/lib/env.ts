import { z } from "zod";

/**
 * Environment configuration.
 *
 * Parsed once, validated with Zod, and read through helpers rather than
 * scattering `process.env` lookups. Nothing here has a default that would let a
 * misconfigured deployment silently fall back to demo data in production — see
 * `assertProductionConfig`.
 *
 * Two kinds of validation happen, and the split is deliberate:
 *
 * - **Shape, at startup.** Anything present must be well-formed. A redirect URI
 *   that is not a URL, an integration mode that is not a known word, an
 *   encryption key of the wrong length: all rejected before the process serves
 *   a request.
 * - **Presence, at first use.** Requiring `GOOGLE_CLIENT_ID` at import time
 *   would break `next build`, which prerenders with `NODE_ENV=production` and
 *   no secrets, and it would stop the app running at all for anyone who has not
 *   set up a Google Cloud project. So the Google helpers below throw a clear,
 *   server-side configuration error at the moment someone tries to connect.
 */

/**
 * Which Google implementation is in play.
 *
 * `mock` returns a deterministic fixture connector for local work and tests. It
 * is refused outright when `NODE_ENV=production` — a production deployment that
 * quietly served fake Google accounts would be worse than one that failed.
 */
const googleIntegrationModeSchema = z.enum(["live", "mock"]);
export type GoogleIntegrationMode = z.infer<typeof googleIntegrationModeSchema>;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Set both public Supabase values to switch the app onto the database. */
    NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
    /** Server-only. Bypasses row-level security; never expose to the browser. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    /** Explicit override, mostly for tests: "demo" or "supabase". */
    LIA_DATA_SOURCE: z.enum(["demo", "supabase"]).optional(),

    /** Public origin, used to build absolute OAuth redirect URIs. */
    APP_URL: z.url().optional(),

    /* Google Business Profile OAuth. Server-only, every one of them. */
    GOOGLE_CLIENT_ID: z.string().min(10).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
    /**
     * Must match a redirect URI registered on the Google OAuth client exactly.
     * Comes from configuration, never from a request parameter.
     */
    GOOGLE_OAUTH_REDIRECT_URI: z.url().optional(),
    GOOGLE_INTEGRATION_MODE: googleIntegrationModeSchema.optional(),

    /** 32 bytes, base64 / base64url / hex. Encrypts stored OAuth credentials. */
    TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
    /** Names the active key so ciphertext stays readable across a rotation. */
    TOKEN_ENCRYPTION_KEY_ID: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, - and _")
      .optional(),
  })
  .refine(
    (value) =>
      !(value.GOOGLE_INTEGRATION_MODE === "mock" && value.NODE_ENV === "production"),
    {
      message: "GOOGLE_INTEGRATION_MODE=mock is refused in production",
      path: ["GOOGLE_INTEGRATION_MODE"],
    },
  );

export type Env = z.infer<typeof envSchema>;

function readEnv(): Env {
  const parsed = envSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || undefined,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || undefined,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    LIA_DATA_SOURCE: process.env.LIA_DATA_SOURCE || undefined,
    APP_URL: process.env.APP_URL || undefined,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || undefined,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || undefined,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI || undefined,
    GOOGLE_INTEGRATION_MODE: process.env.GOOGLE_INTEGRATION_MODE || undefined,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY || undefined,
    TOKEN_ENCRYPTION_KEY_ID: process.env.TOKEN_ENCRYPTION_KEY_ID || undefined,
  });

  if (!parsed.success) {
    // Names and messages only. Never echo values — several of these are secrets.
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${fields}`);
  }

  return parsed.data;
}

export const env: Env = readEnv();

export function isSupabaseConfigured(): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export type DataSourceKind = "demo" | "supabase";

/**
 * Which adapter this process should use.
 *
 * An explicit `LIA_DATA_SOURCE` wins so tests and previews can pin a mode;
 * otherwise the presence of Supabase credentials decides.
 */
export function resolveDataSourceKind(): DataSourceKind {
  if (env.LIA_DATA_SOURCE) return env.LIA_DATA_SOURCE;
  return isSupabaseConfigured() ? "supabase" : "demo";
}

/**
 * True when demo data is being served because nothing else was configured,
 * rather than because someone asked for it.
 *
 * Throwing here would break `next build`, which prerenders with
 * NODE_ENV=production and no database. So instead of failing the build, the
 * shell renders a visible "Demo data" badge whenever this is true — the risk
 * worth guarding against is mistaking demo records for real ones, and a badge
 * addresses that without pretending the app is broken.
 */
export function isUnintentionalDemoMode(): boolean {
  return (
    resolveDataSourceKind() === "demo" &&
    env.LIA_DATA_SOURCE !== "demo" &&
    !isSupabaseConfigured()
  );
}

/* -------------------------------------------------------------------------- */
/* Google Business Profile                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raised when a server-side integration is used before it is configured.
 *
 * Separate from `DataError` on purpose: this is an operator problem, not a user
 * problem, and the UI has to say so rather than showing "try again shortly".
 */
export class ConfigurationError extends Error {
  /** Environment variable names — never values. Safe to log. */
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "ConfigurationError";
    this.missing = missing;
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * The mode the Google connector should run in.
 *
 * Explicit configuration wins. Otherwise a fully configured OAuth client means
 * live, and anything else means unconfigured — the mock is never chosen for
 * you, so a developer cannot mistake fixture data for a working connection.
 */
export function resolveGoogleIntegrationMode(): GoogleIntegrationMode | "unconfigured" {
  if (env.GOOGLE_INTEGRATION_MODE === "mock") {
    // Belt and braces: the schema already refuses this combination, but this is
    // the branch that would serve fake data, so it re-checks rather than trusts.
    if (env.NODE_ENV === "production") {
      throw new ConfigurationError(
        "GOOGLE_INTEGRATION_MODE=mock cannot be used in production.",
        ["GOOGLE_INTEGRATION_MODE"],
      );
    }
    return "mock";
  }

  if (env.GOOGLE_INTEGRATION_MODE === "live") return "live";
  return isGoogleOAuthConfigured() ? "live" : "unconfigured";
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

/** The OAuth client, or a configuration error naming what is missing. */
export function requireGoogleOAuthConfig(): GoogleOAuthConfig {
  const missing = [
    !env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
    !env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
    !env.GOOGLE_OAUTH_REDIRECT_URI && "GOOGLE_OAUTH_REDIRECT_URI",
  ].filter((name): name is string => typeof name === "string");

  if (missing.length > 0 || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ConfigurationError(
      "Google Business Profile is not configured on this server.",
      missing,
    );
  }

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
  };
}

/**
 * The credential encryption key.
 *
 * Required whenever a real OAuth flow runs. Mock mode still encrypts — the mock
 * connector produces fake tokens, and running the same storage path in
 * development is what catches a broken vault before production does — so a key
 * is needed there too. Tests supply their own.
 */
export function requireTokenEncryptionKey(): { raw: string; keyId: string } {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new ConfigurationError(
      "Credential encryption is not configured on this server.",
      ["TOKEN_ENCRYPTION_KEY"],
    );
  }

  return {
    raw: env.TOKEN_ENCRYPTION_KEY,
    keyId: env.TOKEN_ENCRYPTION_KEY_ID ?? "default",
  };
}

/**
 * Absolute origin for this deployment.
 *
 * Used to build the OAuth redirect URI when one is not pinned explicitly, and
 * to send users back into the app after the callback.
 */
export function appOrigin(): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, "");
  return "http://localhost:3000";
}
